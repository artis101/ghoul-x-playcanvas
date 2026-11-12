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
import { clampNumber, clampTimeScale } from '../../core/audio/audioMath.ts';
import type { InternalAudioGraph } from '../../core/audio/audioGraph.ts';
import type { SynthContext } from '../../core/audio/synth/synthPrimitives.ts';
import { playWeaponFire, type GunshotSynthState } from '../../core/audio/synth/gunshotSynth.ts';
import { playShellCasingBounce } from '../../core/audio/synth/casingAudioSynth.ts';
import { playMaterialImpact } from '../../core/audio/synth/materialImpactSynth.ts';
import { playGoreImpact } from '../../core/audio/synth/fleshGoreAudioSynth.ts';
import { playVocalTraumaCue } from '../../core/audio/synth/vocalTraumaSynth.ts';
import { playExplosion } from '../../core/audio/synth/explosionAudioSynth.ts';
import { playSlowMoTransition, scheduleHeartbeatPair, type SlowMoSynthState } from '../../core/audio/synth/slowMoAudioSynth.ts';
import {
  playEnemyBallisticShot,
  playNearMissGrazeTinnitus,
  playRicochetSnap,
  type SupersonicShotAudioResult,
} from '../../core/audio/synth/supersonicBallisticSynth.ts';
import { playRadioBarkCue } from '../../core/audio/synth/radioBarkSynth.ts';
import { AudioSourceTracker } from './tinnitusSystem.ts';
import { bindGestureUnlock, createGraphFactory, resolveBrowserAudioContextCtor } from './audioContextResolver.ts';
import { AudioCounters } from './audioDiagnostics.ts';

export * from '../../core/audio/contracts.ts';
export * from '../../core/audio/types.ts';
export * from '../../core/audio/audioMath.ts';
export * from '../../core/audio/spatialAudio.ts';
export * from '../../core/audio/dspCurves.ts';
export * from '../../core/audio/reverbSynth.ts';
export { CombatAudioScript } from './combatAudioScript.ts';

export class CombatAudioEngine {
  private graph: InternalAudioGraph | null = null;
  private readonly contextFactory: () => InternalAudioGraph | null;
  private readonly rng: () => number;
  private pannerModel: PanningModelType;
  private masterVolume: number;
  private readonly reverbWetMix: number;
  private timeScale = 1.0;
  private listenerPos: Vec3Like = { x: 0, y: 1.62, z: 0 };
  private listenerYawDeg = 0;
  private listenerPitchDeg = 0;
  private readonly gunshotState: GunshotSynthState = { m4ShotCounter: 0, lastWeaponPitchJitter: 1.0 };
  private readonly slowMoState: SlowMoSynthState = { slowMoActive: false, heartbeatBus: null, heartbeatNextScheduleTime: 0 };
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
  private gestureCleanup: (() => void) | null = null;
  private destroyed = false;

  constructor(options: CombatAudioEngineOptions = {}) {
    this.pannerModel = options.pannerModel ?? 'HRTF';
    this.masterVolume = clampNumber(options.masterVolume ?? 0.9, 0, 2.0);
    this.reverbWetMix = clampNumber(options.reverbWetMix ?? 0.34, 0, 1.0);
    this.rng = options.random ?? Math.random;
    this.contextFactory = createGraphFactory(
      options,
      this.masterVolume,
      this.reverbWetMix,
      this.rng,
      (nodes, endTime) => this.tracker.registerTransientNodes(nodes, endTime),
    );
    if (options.context) this.graph = this.contextFactory();
    if (options.autoUnlockOnGesture !== false) {
      this.gestureCleanup = bindGestureUnlock(() => { if (!this.destroyed) void this.unlock(); });
    }
  }

  private ensureGraph(): InternalAudioGraph | null {
    if (this.destroyed) return null;
    if (!this.graph) this.graph = this.contextFactory();
    if (this.graph && this.graph.ctx.state === 'suspended') void this.graph.ctx.resume().catch(() => {});
    if (this.graph) {
      const now = this.graph.ctx.currentTime;
      this.tracker.pruneFinished(now);
      this.lastPruneTime = now;
    }
    return this.graph;
  }

  private getSynthContext(graph: InternalAudioGraph): SynthContext {
    return {
      graph, timeScale: this.timeScale, rng: this.rng,
      registerScaledSource: (src, rate, end) => this.tracker.registerSource(src, rate, end),
      registerScaledOscillator: (osc, scale, end) => this.tracker.registerOscillator(osc, scale, end),
      registerTransientNodes: (nodes, end) => this.tracker.registerTransientNodes(nodes, end),
    };
  }

  public prewarmDspGraph(): boolean {
    if (this.destroyed) return false;
    if (!this.graph) {
      try {
        this.graph = this.contextFactory();
      } catch {
        this.graph = null;
      }
    }
    return this.graph !== null;
  }

  public async unlock(): Promise<boolean> {
    if (this.destroyed) return false;
    if (!this.graph) this.graph = this.contextFactory();
    if (!this.graph) return false;
    if (this.graph.ctx.state === 'suspended') {
      try { await this.graph.ctx.resume(); } catch { return false; }
    }
    return this.graph.ctx.state === 'running';
  }

  public isAvailable(): boolean {
    if (this.destroyed) return false;
    return this.graph !== null || resolveBrowserAudioContextCtor() !== null;
  }

  public isUnlocked(): boolean {
    return Boolean(this.graph && this.graph.ctx.state === 'running');
  }

  public getDiagnostics(): CombatAudioDiagnostics {
    return this.counters.buildDiagnostics(
      this.isAvailable(), this.isUnlocked(), this.timeScale,
      this.slowMoState.slowMoActive, this.pannerModel, this.masterVolume,
      this.gunshotState.lastWeaponPitchJitter,
    );
  }

  public setMasterVolume(v: number): void {
    this.masterVolume = clampNumber(v, 0, 2.0);
    if (this.graph) {
      const now = this.graph.ctx.currentTime;
      this.graph.masterGain.gain.cancelScheduledValues(now);
      this.graph.masterGain.gain.setTargetAtTime(this.masterVolume, now, 0.015);
    }
  }
  public getMasterVolume(): number { return this.masterVolume; }
  public setPannerModel(m: PanningModelType): void { this.pannerModel = m; }
  public getPannerModel(): PanningModelType { return this.pannerModel; }

  public updateListener(pos: Vec3Like, yawDeg = 0, pitchDeg = 0): void {
    this.listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    this.listenerYawDeg = yawDeg;
    this.listenerPitchDeg = pitchDeg;
    if (this.graph) this.graph.updateListener(this.listenerPos, yawDeg, pitchDeg);
  }

  public setTimeScale(scale: number): void {
    const clamped = clampTimeScale(scale);
    if (Math.abs(clamped - this.timeScale) < 1e-4) return;
    this.timeScale = clamped;
    if (!this.graph) return;
    const now = this.graph.ctx.currentTime;
    this.tracker.pruneFinished(now);
    this.tracker.applyTimeScale(this.timeScale, now);
  }
  public getTimeScale(): number { return this.timeScale; }

  public update(_rawDt: number): void {
    if (!this.graph) return;
    const now = this.graph.ctx.currentTime;
    if (now - this.lastPruneTime >= 0.12) {
      this.tracker.pruneFinished(now);
      this.lastPruneTime = now;
    }
    if (!this.slowMoState.slowMoActive || !this.slowMoState.heartbeatBus) return;
    if (now + 0.35 >= this.slowMoState.heartbeatNextScheduleTime) {
      scheduleHeartbeatPair(this.getSynthContext(this.graph), this.slowMoState.heartbeatBus, Math.max(now + 0.05, this.slowMoState.heartbeatNextScheduleTime));
      this.slowMoState.heartbeatNextScheduleTime = Math.max(now + 0.05, this.slowMoState.heartbeatNextScheduleTime) + 0.92;
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
      this.getSynthContext(g),
      m,
      pos,
      energy,
      lPos,
      this.listenerYawDeg,
      this.pannerModel,
      this.reverbWetMix,
      startOffsetS,
      gainMul,
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
    if (distM <= TINNITUS_PROXIMITY_RADIUS_M) this.counters.tinnitusTriggerCount += 1;
    const g = this.ensureGraph();
    if (g) playExplosion(this.getSynthContext(g), worldPos, listenerPos, intensity, this.listenerYawDeg, this.pannerModel, this.reverbWetMix);
  }

  public playSlowMoTransition(entering: boolean): void {
    this.counters.slowMoTransitionCount += 1;
    const g = this.ensureGraph();
    if (g) playSlowMoTransition(this.getSynthContext(g), this.slowMoState, entering);
  }

  public playEnemyBallisticShot(params: EnemyBallisticShotAudioParams): SupersonicShotAudioResult | null {
    this.counters.weaponFireCount += 1;
    const g = this.ensureGraph();
    if (!g) return null;
    const lPos = params.listenerPos ?? this.listenerPos;
    return playEnemyBallisticShot(
      this.getSynthContext(g),
      params,
      lPos,
      this.listenerYawDeg,
      this.pannerModel,
      this.reverbWetMix,
    );
  }

  public playNearMissGrazeTinnitus(
    kind: NearMissGrazeAudioKind,
    hitOrigin: Vec3Like,
    listenerPos = this.listenerPos,
  ): void {
    this.counters.tinnitusTriggerCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    this.tracker.triggerTinnitusSpike(g.ctx.currentTime, kind === 'HELMET_POP' ? 1.15 : 0.95);
    playNearMissGrazeTinnitus(
      this.getSynthContext(g),
      kind,
      hitOrigin,
      listenerPos,
      this.listenerYawDeg,
      this.pannerModel,
      this.reverbWetMix,
    );
  }

  public playRadioBarkCue(params: RadioBarkCueAudioParams): void {
    this.counters.vocalCueCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    const lPos = params.listenerPos ?? this.listenerPos;
    playRadioBarkCue(
      this.getSynthContext(g),
      params,
      lPos,
      this.listenerYawDeg,
      this.pannerModel,
      this.reverbWetMix,
    );
  }

  public playRicochetSnap(origin: Vec3Like, listenerPos = this.listenerPos): void {
    this.counters.materialImpactCount += 1;
    const g = this.ensureGraph();
    if (!g) return;
    playRicochetSnap(
      this.getSynthContext(g),
      origin,
      listenerPos,
      this.listenerYawDeg,
      this.pannerModel,
      this.reverbWetMix,
    );
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.gestureCleanup) { this.gestureCleanup(); this.gestureCleanup = null; }
    if (this.graph) {
      try { void this.graph.ctx.close(); } catch {}
      this.graph = null;
    }
    this.tracker.clear();
    this.slowMoState.heartbeatBus = null;
  }
}
