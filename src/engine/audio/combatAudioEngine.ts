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
import { clampNumber } from '../../core/audio/audioMath.ts';
import type { InternalAudioGraph } from '../../core/audio/audioGraph.ts';
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
export { CombatAudioScript } from './combatAudioScript.ts';

export class CombatAudioEngine {
  private runtimeState: AudioRuntimeState;
  private readonly contextFactory: () => InternalAudioGraph | null;
  private readonly hasCustomContextFactory: boolean;
  private readonly rng: () => number;
  private pannerModel: PanningModelType;
  private masterVolume: number;
  private readonly reverbWetMix: number;
  private listenerPos: Vec3Like = { x: 0, y: 1.62, z: 0 };
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
  private readonly counters = new AudioCounters();

  constructor(options: CombatAudioEngineOptions = {}) {
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
      (nodes, endTime) => this.tracker.registerTransientNodes(nodes, endTime),
    );
    const initialGraph = options.context ? this.contextFactory() : null;
    const gestureCleanup =
      options.autoUnlockOnGesture !== false
        ? bindGestureUnlock(() => { if (this.runtimeState.kind !== 'DESTROYED') void this.unlock(); })
        : null;
    this.runtimeState = createInitialAudioRuntimeState(initialGraph, options.context === null, gestureCleanup);
  }

  public get lifecycleState(): AudioRuntimeState { return this.runtimeState; }

  private materializeGraph(): InternalAudioGraph | null {
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
    if (this.runtimeState.kind === 'SUSPENDED') void this.unlock();
    const now = graph.ctx.currentTime;
    this.tracker.pruneFinished(now);
    this.lastPruneTime = now;
    return graph;
  }

  private getSynthContext(graph: InternalAudioGraph): SynthContext {
    return {
      graph, rng: this.rng,
      registerTransientNodes: (nodes, end) => this.tracker.registerTransientNodes(nodes, end),
    };
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
    this.runtimeState = syncAudioRuntimeWithContextState(this.runtimeState);
    return this.runtimeState.kind === 'RUNNING';
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
    this.listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    this.listenerYawDeg = yawDeg;
    this.listenerPitchDeg = pitchDeg;
    const graph = getAudioRuntimeGraph(this.runtimeState);
    if (graph) graph.updateListener(this.listenerPos, yawDeg, pitchDeg);
  }

  public update(_rawDt: number): void {
    const graph = getAudioRuntimeGraph(this.runtimeState);
    if (!graph) return;
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
    playShellCasingBounce(this.getSynthContext(g), c, pos, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
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
    playMaterialImpact(
      this.getSynthContext(g), m, pos, energy, lPos,
      this.listenerYawDeg, this.pannerModel, this.reverbWetMix, startOffsetS, gainMul,
    );
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
    playGoreImpact(this.getSynthContext(g), k, pos, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix, {
      maybeTriggerAutoVocalCue: (cue, wPos, lp, cueNow) => {
        if (cueNow - this.lastVocalCueTime >= 0.28) this.playVocalTraumaCue(cue, wPos, lp);
      },
    });
  }

  public playVocalTraumaCue(cue: VocalTraumaCueKind, pos?: Vec3Like, lPos = this.listenerPos): void {
    this.counters.vocalCueCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    this.lastVocalCueTime = g.ctx.currentTime;
    playVocalTraumaCue(this.getSynthContext(g), cue, pos, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
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
    if (g) playExplosion(this.getSynthContext(g), worldPos, listenerPos, intensity, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
  }

  public playEnemyBallisticShot(params: EnemyBallisticShotAudioParams): SupersonicShotAudioResult | null {
    this.counters.weaponFireCount += 1;
    const g = this.ensureGraph();
    if (!g) return null;
    const lPos = params.listenerPos ?? this.listenerPos;
    return playEnemyBallisticShot(this.getSynthContext(g), params, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
  }

  public playNearMissGrazeTinnitus(kind: NearMissGrazeAudioKind, hitOrigin: Vec3Like, listenerPos = this.listenerPos): void {
    this.counters.tinnitusTriggerCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    this.tracker.triggerTinnitusSpike(g.ctx.currentTime, kind === 'HELMET_POP' ? 1.15 : 0.95);
    playNearMissGrazeTinnitus(this.getSynthContext(g), kind, hitOrigin, listenerPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
  }

  public playRadioBarkCue(params: RadioBarkCueAudioParams): void {
    this.counters.vocalCueCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    const lPos = params.listenerPos ?? this.listenerPos;
    playRadioBarkCue(this.getSynthContext(g), params, lPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
  }

  public playRicochetSnap(origin: Vec3Like, listenerPos = this.listenerPos): void {
    this.counters.materialImpactCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    playRicochetSnap(this.getSynthContext(g), origin, listenerPos, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
  }

  public destroy(): void {
    if (this.runtimeState.kind === 'DESTROYED') return;
    this.runtimeState = transitionAudioRuntimeState(this.runtimeState, { kind: 'DESTROYED' });
    this.tracker.clear();
  }
}
