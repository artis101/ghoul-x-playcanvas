import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { DestructibleMaterialKind } from '../../contracts/destruction.ts';
import type {
  CombatAudioDiagnostics,
  CombatAudioEngineOptions,
  EnemyBallisticShotAudioParams,
  GoreImpactAudioKind,
  NearMissGrazeAudioKind,
  RadioBarkCueAudioParams,
  ShellCasingCaliber,
  VocalTraumaCueKind,
} from '../../core/audio/types.ts';
import { TINNITUS_PROXIMITY_RADIUS_M } from '../../core/audio/types.ts';
import { clampNumber, distanceToSegmentM } from '../../core/audio/audioMath.ts';
import type { InternalAudioGraph } from '../../core/audio/audioGraph.ts';
import type { AudioNodeLike } from '../../core/audio/contracts.ts';
import type { SynthContext } from '../../core/audio/synth/synthPrimitives.ts';
import { playWeaponFire, type GunshotSynthState } from '../../core/audio/synth/gunshotSynth.ts';
import { playShellCasingBounce } from '../../core/audio/synth/casingAudioSynth.ts';
import { playMaterialImpact } from '../../core/audio/synth/materialImpactSynth.ts';
import { playGoreImpact } from '../../core/audio/synth/fleshGoreAudioSynth.ts';
import { playVocalTraumaCue } from '../../core/audio/synth/vocalTraumaSynth.ts';
import { playExplosion } from '../../core/audio/synth/explosionAudioSynth.ts';
import {
  playEnemyBallisticShot,
  playNearMissGrazeTinnitus,
  playRicochetSnap,
  type SupersonicShotAudioResult,
} from '../../core/audio/synth/supersonicBallisticSynth.ts';
import { playRadioBarkCue } from '../../core/audio/synth/radioBarkSynth.ts';
import { AudioSourceTracker, type TinnitusState } from './tinnitusSystem.ts';
import { VoiceAllocator, ENEMY_FIRE_NEAR_DISTANCE_M, type VoiceCategory } from './voiceBudget.ts';
import { bindGestureUnlock, createGraphFactory, resolveBrowserAudioContextCtor } from './audioContextResolver.ts';
import { AudioCounters } from './audioDiagnostics.ts';
import {
  createInitialAudioRuntimeState,
  getAudioRuntimeGraph,
  materializeAudioGraph,
  syncAudioRuntimeWithContextState,
  transitionAudioRuntimeState,
  unlockAudioRuntime,
  type AudioRuntimeState,
} from './audioLifecycleState.ts';

export * from '../../core/audio/contracts.ts';
export * from '../../core/audio/types.ts';
export * from '../../core/audio/audioMath.ts';
export * from '../../core/audio/spatialAudio.ts';
export * from '../../core/audio/dspCurves.ts';
export * from '../../core/audio/reverbSynth.ts';
export type { AudioRuntimeState, TinnitusState };

function dist3(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class CombatAudioEngine {
  private runtimeState: AudioRuntimeState;
  private readonly contextFactory: () => InternalAudioGraph | null;
  private readonly hasCustomContextFactory: boolean;
  private readonly rng: () => number;
  private pannerModel: PanningModelType;
  private masterVolume: number;
  private readonly reverbWetMix: number;
  private readonly listenerPos: Vec3Like = { x: 0, y: 1.62, z: 0 };
  private listenerYawDeg = 0;
  private listenerPitchDeg = 0;
  private readonly gunshotState: GunshotSynthState = { m4ShotCounter: 0, lastWeaponPitchJitter: 1.0 };
  private lastVocalCueTime = -10;
  private lastPruneTime = -10;
  private impactWindowStart = -10;
  private impactWindowTotal = 0;
  private readonly impactWindowByMat = new Map<DestructibleMaterialKind, number>();
  private casingWindowStart = -10;
  private casingWindowCount = 0;
  private goreWindowStart = -10;
  private goreWindowCount = 0;
  private readonly tracker = new AudioSourceTracker();
  private readonly voices = new VoiceAllocator((nodes, endTime) => this.tracker.registerTransientNodes(nodes, endTime));
  private pendingVocalCue: VocalTraumaCueKind | null = null;
  private pendingVocalPos: Vec3Like | undefined = undefined;
  private pendingVocalListener: Vec3Like | undefined = undefined;
  private readonly counters = new AudioCounters();
  private readonly autoUnlockOnGesture: boolean;
  private synthCtx: SynthContext | null = null;
  private readonly onUserGesture = (): void => {
    if (this.runtimeState.kind !== 'DESTROYED') void this.unlock();
  };
  private readonly rebindGestureUnlock = (): (() => void) | null =>
    this.autoUnlockOnGesture ? bindGestureUnlock(this.onUserGesture) : null;
  private readonly registerTransientNodes = (nodes: readonly AudioNodeLike[], endTime: number): void => {
    this.tracker.registerTransientNodes(nodes, endTime);
    this.voices.noteSourceEnd(endTime);
  };

  constructor(options: CombatAudioEngineOptions = {}) {
    this.autoUnlockOnGesture = options.autoUnlockOnGesture !== false;
    this.pannerModel = options.pannerModel ?? 'HRTF';
    this.masterVolume = clampNumber(options.masterVolume ?? 0.9, 0, 2.0);
    this.reverbWetMix = clampNumber(options.reverbWetMix ?? 0.34, 0, 1.0);
    this.rng = options.random ?? Math.random;
    this.hasCustomContextFactory = Boolean(options.contextFactory);
    this.contextFactory = createGraphFactory(
      options,
      this.masterVolume,
      this.reverbWetMix,
      this.rng,
      (chain, createdAt) => this.voices.captureChain(chain, createdAt),
    );
    const initialGraph = options.context ? this.contextFactory() : null;
    const gestureCleanup = this.autoUnlockOnGesture ? bindGestureUnlock(this.onUserGesture) : null;
    this.runtimeState = createInitialAudioRuntimeState(initialGraph, options.context === null, gestureCleanup);
  }

  public get lifecycleState(): AudioRuntimeState { return this.runtimeState; }

  public get activeVoiceCount(): number {
    const g = getAudioRuntimeGraph(this.runtimeState);
    return g ? this.voices.activeCount(g.ctx.currentTime) : 0;
  }

  private flushPendingVocalCue(): void {
    const cue = this.pendingVocalCue;
    const pos = this.pendingVocalPos;
    const lp = this.pendingVocalListener;
    this.pendingVocalCue = null;
    this.pendingVocalPos = undefined;
    this.pendingVocalListener = undefined;
    if (cue !== null) this.playVocalTraumaCue(cue, pos, lp);
  }

  private syncContextState(): void {
    const wasRunning = this.runtimeState.kind === 'RUNNING';
    this.runtimeState = syncAudioRuntimeWithContextState(this.runtimeState, this.rebindGestureUnlock);
    if (wasRunning && this.runtimeState.kind === 'SUSPENDED') void this.unlock();
  }

  private materializeGraph(): InternalAudioGraph | null {
    this.syncContextState();
    return materializeAudioGraph(
      () => this.runtimeState,
      (next) => { this.runtimeState = next; },
      this.contextFactory,
      this.listenerPos,
      this.listenerYawDeg,
      this.listenerPitchDeg,
    );
  }

  private ensureGraph(): InternalAudioGraph | null {
    const graph = this.materializeGraph();
    if (!graph) return null;
    const kind = this.runtimeState.kind as AudioRuntimeState['kind'];
    if (kind !== 'RUNNING') {
      if (kind === 'SUSPENDED') void this.unlock();
      return null;
    }
    return graph;
  }

  private getSynthContext(graph: InternalAudioGraph): SynthContext {
    if (this.synthCtx === null || this.synthCtx.graph !== graph) {
      this.synthCtx = { graph, rng: this.rng, registerTransientNodes: this.registerTransientNodes };
    }
    return this.synthCtx;
  }

  public prewarmDspGraph(): boolean { return this.materializeGraph() !== null; }

  public async unlock(): Promise<boolean> {
    const graph = this.materializeGraph();
    return unlockAudioRuntime(() => this.runtimeState, (next) => { this.runtimeState = next; }, graph);
  }

  public isAvailable(): boolean {
    if (this.runtimeState.kind === 'DESTROYED' || this.runtimeState.kind === 'UNAVAILABLE') return false;
    if (getAudioRuntimeGraph(this.runtimeState) !== null) return true;
    return this.hasCustomContextFactory || resolveBrowserAudioContextCtor() !== null;
  }

  public isUnlocked(): boolean {
    this.syncContextState();
    return (this.runtimeState.kind as AudioRuntimeState['kind']) === 'RUNNING';
  }

  public getDiagnostics(): CombatAudioDiagnostics {
    return this.counters.buildDiagnostics(
      this.isAvailable(), this.isUnlocked(), this.pannerModel, this.masterVolume,
      this.gunshotState.lastWeaponPitchJitter,
    );
  }

  public setMasterVolume(v: number): void {
    this.masterVolume = clampNumber(v, 0, 2.0);
    const graph = getAudioRuntimeGraph(this.runtimeState);
    if (graph) {
      const now = graph.ctx.currentTime;
      graph.masterGain.gain.cancelScheduledValues(now);
      graph.masterGain.gain.setTargetAtTime(this.masterVolume, now, 0.015);
    }
  }
  public getMasterVolume(): number { return this.masterVolume; }
  public setPannerModel(m: PanningModelType): void { this.pannerModel = m; }
  public getPannerModel(): PanningModelType { return this.pannerModel; }

  public updateListener(pos: Vec3Like, yawDeg = 0, pitchDeg = 0): void {
    const lp = this.listenerPos;
    lp.x = pos.x;
    lp.y = pos.y;
    lp.z = pos.z;
    this.listenerYawDeg = yawDeg;
    this.listenerPitchDeg = pitchDeg;
    const graph = getAudioRuntimeGraph(this.runtimeState);
    if (graph) graph.updateListener(this.listenerPos, yawDeg, pitchDeg);
  }

  public update(_rawDt: number): void {
    if (this.runtimeState.kind !== 'RUNNING' && this.runtimeState.kind !== 'SUSPENDED') return;
    this.syncContextState();
    const graph = getAudioRuntimeGraph(this.runtimeState);
    if (!graph || (this.runtimeState.kind as AudioRuntimeState['kind']) !== 'RUNNING') return;
    const now = graph.ctx.currentTime;
    if (now - this.lastPruneTime >= 0.12) {
      this.tracker.pruneFinished(now);
      this.lastPruneTime = now;
    }
  }

  public playWeaponFire(id: string, ammo: string, ads: boolean): void {
    this.counters.weaponFireCount += 1;
    const g = this.ensureGraph();
    if (g) playWeaponFire(this.getSynthContext(g), this.gunshotState, id, ammo, ads);
  }

  public playShellCasingBounce(c: ShellCasingCaliber, pos: Vec3Like, lPos = this.listenerPos): void {
    this.counters.casingBounceCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    const now = g.ctx.currentTime;
    if (now - this.casingWindowStart > 0.05) {
      this.casingWindowStart = now;
      this.casingWindowCount = 0;
    }
    if (this.casingWindowCount >= 4) return;
    this.casingWindowCount += 1;
    if (!this.voices.begin('CASING', dist3(pos, lPos), now)) return;
    try {
      playShellCasingBounce(this.getSynthContext(g), c, pos, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
    } finally {
      this.voices.end();
    }
  }

  public playMaterialImpact(m: DestructibleMaterialKind, pos: Vec3Like, energy: number, lPos = this.listenerPos): void {
    this.counters.materialImpactCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    const now = g.ctx.currentTime;
    if (now - this.impactWindowStart > 0.022) {
      this.impactWindowStart = now;
      this.impactWindowTotal = 0;
      this.impactWindowByMat.clear();
    }
    const matCount = this.impactWindowByMat.get(m) ?? 0;
    if (matCount >= 3 || this.impactWindowTotal >= 5) return;
    this.impactWindowByMat.set(m, matCount + 1);
    this.impactWindowTotal += 1;

    const startOffsetS = matCount === 0 ? 0 : matCount * 0.0045 + this.rng() * 0.0025;
    const gainMul = matCount === 0 ? 1.0 : 1.0 / Math.sqrt(matCount + 1);
    if (!this.voices.begin('IMPACT', dist3(pos, lPos), now)) return;
    try {
      playMaterialImpact(
        this.getSynthContext(g), m, pos, energy, lPos,
        this.listenerYawDeg, this.pannerModel, this.reverbWetMix, startOffsetS, gainMul,
      );
    } finally {
      this.voices.end();
    }
  }

  public playGoreImpact(k: GoreImpactAudioKind, pos: Vec3Like, lPos = this.listenerPos): void {
    this.counters.goreImpactCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    const now = g.ctx.currentTime;
    if (now - this.goreWindowStart > 0.025) {
      this.goreWindowStart = now;
      this.goreWindowCount = 0;
    }
    if (this.goreWindowCount >= 3) return;
    this.goreWindowCount += 1;
    if (!this.voices.begin('GORE', dist3(pos, lPos), now)) {
      this.flushPendingVocalCue();
      return;
    }
    try {
      playGoreImpact(this.getSynthContext(g), k, pos, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix, {
        maybeTriggerAutoVocalCue: (cue, wPos, lp, cueNow) => {
          if (cueNow - this.lastVocalCueTime >= 0.28) {
            this.pendingVocalCue = cue;
            this.pendingVocalPos = wPos;
            this.pendingVocalListener = lp;
          }
        },
      });
    } finally {
      this.voices.end();
    }
    this.flushPendingVocalCue();
  }

  public playVocalTraumaCue(cue: VocalTraumaCueKind, pos?: Vec3Like, lPos = this.listenerPos): void {
    this.counters.vocalCueCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    this.lastVocalCueTime = g.ctx.currentTime;
    if (!this.voices.begin('VOCAL', pos ? dist3(pos, lPos) : 0, g.ctx.currentTime)) return;
    try {
      playVocalTraumaCue(this.getSynthContext(g), cue, pos, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
    } finally {
      this.voices.end();
    }
  }

  public playExplosion(worldPos: Vec3Like, listenerPos = this.listenerPos, intensity = 1.0): void {
    this.counters.explosionCount += 1;
    if (!Number.isFinite(intensity) || intensity <= 0) return;
    const distM = Math.hypot(worldPos.x - listenerPos.x, worldPos.y - listenerPos.y, worldPos.z - listenerPos.z);
    const g = this.ensureGraph();
    if (distM <= TINNITUS_PROXIMITY_RADIUS_M) {
      this.counters.tinnitusTriggerCount += 1;
      if (g) this.tracker.triggerTinnitusSpike(g.ctx.currentTime, Math.min(1.5, intensity));
    }
    if (!g) return;
    if (!this.voices.begin('EXPLOSION', distM, g.ctx.currentTime)) return;
    try {
      playExplosion(this.getSynthContext(g), worldPos, listenerPos, intensity, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
    } finally {
      this.voices.end();
    }
  }

  public playEnemyBallisticShot(params: EnemyBallisticShotAudioParams): SupersonicShotAudioResult | null {
    this.counters.weaponFireCount += 1;
    const g = this.ensureGraph();
    if (!g) return null;
    const lPos = params.listenerPos ?? this.listenerPos;
    const passDistM = distanceToSegmentM(lPos, params.muzzleOrigin, params.impactPoint);
    const isNear = passDistM <= ENEMY_FIRE_NEAR_DISTANCE_M;
    // A near pass is heard through its crack; a far shot only through its muzzle report.
    const category: VoiceCategory = isNear ? 'ENEMY_FIRE_NEAR' : 'ENEMY_FIRE_FAR';
    const audibleDistM = isNear ? passDistM : dist3(params.muzzleOrigin, lPos);
    if (!this.voices.begin(category, audibleDistM, g.ctx.currentTime)) return null;
    try {
      return playEnemyBallisticShot(this.getSynthContext(g), params, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
    } finally {
      this.voices.end();
    }
  }

  public playNearMissGrazeTinnitus(kind: NearMissGrazeAudioKind, hitOrigin: Vec3Like, listenerPos = this.listenerPos): void {
    this.counters.tinnitusTriggerCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    this.tracker.triggerTinnitusSpike(g.ctx.currentTime, kind === 'HELMET_POP' ? 1.15 : 0.95);
    if (!this.voices.begin('NEAR_MISS', 0, g.ctx.currentTime)) return;
    try {
      playNearMissGrazeTinnitus(this.getSynthContext(g), kind, hitOrigin, listenerPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
    } finally {
      this.voices.end();
    }
  }

  public playRadioBarkCue(params: RadioBarkCueAudioParams): void {
    this.counters.vocalCueCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    const lPos = params.listenerPos ?? this.listenerPos;
    const barkDistM = params.isRadio || !params.worldPos ? 0 : dist3(params.worldPos, lPos);
    if (!this.voices.begin('BARK', barkDistM, g.ctx.currentTime)) return;
    try {
      playRadioBarkCue(this.getSynthContext(g), params, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
    } finally {
      this.voices.end();
    }
  }

  public playRicochetSnap(origin: Vec3Like, listenerPos = this.listenerPos): void {
    this.counters.materialImpactCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    if (!this.voices.begin('RICOCHET', dist3(origin, listenerPos), g.ctx.currentTime)) return;
    try {
      playRicochetSnap(this.getSynthContext(g), origin, listenerPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
    } finally {
      this.voices.end();
    }
  }

  public destroy(): void {
    if (this.runtimeState.kind === 'DESTROYED') return;
    this.runtimeState = transitionAudioRuntimeState(this.runtimeState, { kind: 'DESTROYED' });
    this.voices.clear();
    this.tracker.clear();
    this.synthCtx = null;
  }
}
