import {
  type BulletTimeOptions,
  type BulletTimeVignetteState,
  type KillPunchReason,
  type KillPunchState,
  MAX_TIME_SCALE_LIMIT,
  MIN_TIME_SCALE_LIMIT,
  type ReflexMeterState,
} from './bulletTimeTypes.ts';
import { BulletTimeOverlayManager, computeBulletTimeVignette } from './bulletTimeOverlay.ts';

export class BulletTimeController {
  private readonly reflexTargetScale: number;
  private readonly minTimeScale: number;
  private readonly drainPctPerSec: number;
  private readonly rechargePctPerSec: number;
  private readonly rechargeCooldownS: number;
  private readonly minActivationPct: number;
  private readonly lerpRatePerSec: number;

  public onVignetteUpdate?: (state: BulletTimeVignetteState) => void;

  private currentScale = 1.0;
  private reflexState: ReflexMeterState = { kind: 'READY' };
  private killPunchState: KillPunchState = { kind: 'INACTIVE' };

  private boundKeyTarget: EventTarget | null = null;
  private boundKeyHandler: ((ev: Event) => void) | null = null;
  private readonly overlay = new BulletTimeOverlayManager();

  public constructor(options: BulletTimeOptions = {}) {
    this.minTimeScale = Math.max(
      MIN_TIME_SCALE_LIMIT,
      Math.min(0.5, options.minTimeScale ?? MIN_TIME_SCALE_LIMIT),
    );
    this.reflexTargetScale = Math.max(
      this.minTimeScale,
      Math.min(0.85, options.reflexTargetScale ?? 0.22),
    );
    this.drainPctPerSec = Math.max(1, options.drainPctPerRealSec ?? 20.0);
    this.rechargePctPerSec = Math.max(1, options.rechargePctPerRealSec ?? 15.0);
    this.rechargeCooldownS = Math.max(0, options.rechargeCooldownS ?? 0.4);
    this.minActivationPct = Math.max(1, Math.min(50, options.minActivationPct ?? 10.0));
    this.lerpRatePerSec = Math.max(2, options.lerpRatePerRealSec ?? 14.0);
    this.onVignetteUpdate = options.onVignetteUpdate;
  }

  public get reflexMeterState(): ReflexMeterState {
    return this.reflexState;
  }

  public get killPunchPhase(): KillPunchState {
    return this.killPunchState;
  }

  public get timeScale(): number {
    return this.currentScale;
  }

  public get isReflexActive(): boolean {
    return this.reflexState.kind === 'DRAINING';
  }

  public get isKillPunchActive(): boolean {
    return this.killPunchState.kind === 'ACTIVE';
  }

  public get reflexEnergyPct(): number {
    return this.reflexState.kind === 'READY' ? 100.0 : this.reflexState.energyPct;
  }

  public effectiveDt(rawDt: number): number {
    return !Number.isFinite(rawDt) || rawDt <= 0 ? 0 : rawDt * this.currentScale;
  }

  public toggleReflex(): boolean {
    if (this.isReflexActive) {
      this.setReflexActive(false);
      return false;
    }
    if (this.reflexEnergyPct >= this.minActivationPct) {
      this.setReflexActive(true);
      return true;
    }
    return false;
  }

  public setReflexActive(active: boolean): void {
    if (active) {
      const currentEnergy = this.reflexEnergyPct;
      if (currentEnergy >= this.minActivationPct && this.reflexState.kind !== 'DRAINING') {
        this.reflexState = { kind: 'DRAINING', energyPct: currentEnergy };
      }
      return;
    }

    if (this.reflexState.kind === 'DRAINING') {
      const energyPct = this.reflexState.energyPct;
      if (this.rechargeCooldownS > 0) {
        this.reflexState = {
          kind: 'COOLDOWN',
          energyPct,
          cooldownRemainingS: this.rechargeCooldownS,
        };
      } else if (energyPct < 100.0) {
        this.reflexState = { kind: 'RECHARGING', energyPct };
      } else {
        this.reflexState = { kind: 'READY' };
      }
    }
  }

  public grantReflexEnergy(amountPct: number): void {
    if (!Number.isFinite(amountPct) || amountPct <= 0) return;
    const nextPct = Math.min(100.0, this.reflexEnergyPct + amountPct);
    switch (this.reflexState.kind) {
      case 'READY':
        break;
      case 'DRAINING':
        this.reflexState = { kind: 'DRAINING', energyPct: nextPct };
        break;
      case 'COOLDOWN':
        this.reflexState =
          nextPct >= 100.0 && this.reflexState.cooldownRemainingS <= 0
            ? { kind: 'READY' }
            : {
                kind: 'COOLDOWN',
                energyPct: nextPct,
                cooldownRemainingS: this.reflexState.cooldownRemainingS,
              };
        break;
      case 'RECHARGING':
        this.reflexState =
          nextPct >= 100.0 ? { kind: 'READY' } : { kind: 'RECHARGING', energyPct: nextPct };
        break;
    }
  }

  public triggerKillPunch(
    durationOrReason: number | KillPunchReason = 'CRANIAL_POP',
    targetScaleOrDuration: number = 0.35,
    maybeReason?: KillPunchReason,
  ): void {
    const reason: KillPunchReason =
      maybeReason ?? (typeof durationOrReason === 'string' ? durationOrReason : 'CRANIAL_POP');
    let durationS = 0.35;
    if (typeof durationOrReason === 'string') {
      if (typeof targetScaleOrDuration === 'number') {
        durationS = targetScaleOrDuration;
      }
    } else {
      durationS = durationOrReason;
    }
    const clampedDuration = Math.max(0.08, Math.min(1.25, durationS));
    const prevRemaining =
      this.killPunchState.kind === 'ACTIVE' ? this.killPunchState.remainingS : 0;

    const punchScale =
      reason === 'MULTI_KILL_BLAST'
        ? 0.14
        : reason === 'CRANIAL_POP'
          ? 0.16
          : 0.2;
    const targetScale = Math.max(this.minTimeScale, punchScale);

    this.killPunchState = {
      kind: 'ACTIVE',
      reason,
      remainingS: Math.max(prevRemaining, clampedDuration),
      targetScale,
    };

    const bonusPct = reason === 'MULTI_KILL_BLAST' ? 18 : reason === 'CRANIAL_POP' ? 12 : 8;
    this.grantReflexEnergy(bonusPct);
  }

  public getVignetteState(): BulletTimeVignetteState {
    return computeBulletTimeVignette(
      this.isReflexActive,
      this.isKillPunchActive,
      this.currentScale,
      this.reflexEnergyPct,
      this.reflexTargetScale,
    );
  }

  public update(realDeltaTimeS: number): number {
    if (!Number.isFinite(realDeltaTimeS) || realDeltaTimeS <= 0) return 0;
    const dt = Math.min(0.1, realDeltaTimeS);

    switch (this.reflexState.kind) {
      case 'DRAINING': {
        const nextEnergy = Math.max(0, this.reflexState.energyPct - this.drainPctPerSec * dt);
        if (nextEnergy <= 0.001) {
          this.reflexState =
            this.rechargeCooldownS > 0
              ? { kind: 'COOLDOWN', energyPct: 0, cooldownRemainingS: this.rechargeCooldownS }
              : { kind: 'RECHARGING', energyPct: 0 };
        } else {
          this.reflexState = { kind: 'DRAINING', energyPct: nextEnergy };
        }
        break;
      }
      case 'COOLDOWN': {
        const nextCooldown = Math.max(0, this.reflexState.cooldownRemainingS - dt);
        if (nextCooldown <= 0) {
          this.reflexState =
            this.reflexState.energyPct >= 100.0
              ? { kind: 'READY' }
              : { kind: 'RECHARGING', energyPct: this.reflexState.energyPct };
        } else {
          this.reflexState = {
            kind: 'COOLDOWN',
            energyPct: this.reflexState.energyPct,
            cooldownRemainingS: nextCooldown,
          };
        }
        break;
      }
      case 'RECHARGING': {
        const nextEnergy = Math.min(100.0, this.reflexState.energyPct + this.rechargePctPerSec * dt);
        this.reflexState =
          nextEnergy >= 100.0 ? { kind: 'READY' } : { kind: 'RECHARGING', energyPct: nextEnergy };
        break;
      }
      case 'READY':
        break;
    }

    if (this.killPunchState.kind === 'ACTIVE') {
      const nextRem = Math.max(0, this.killPunchState.remainingS - dt);
      this.killPunchState =
        nextRem > 0
          ? {
              ...this.killPunchState,
              remainingS: nextRem,
            }
          : { kind: 'INACTIVE' };
    }

    let desiredScale = MAX_TIME_SCALE_LIMIT;
    if (this.killPunchState.kind === 'ACTIVE' && this.isReflexActive) {
      desiredScale = Math.min(this.killPunchState.targetScale, this.reflexTargetScale);
    } else if (this.killPunchState.kind === 'ACTIVE') {
      desiredScale = this.killPunchState.targetScale;
    } else if (this.isReflexActive) {
      desiredScale = this.reflexTargetScale;
    }

    const blendFactor = 1.0 - Math.exp(-this.lerpRatePerSec * dt);
    this.currentScale += (desiredScale - this.currentScale) * blendFactor;
    this.currentScale = Math.max(
      this.minTimeScale,
      Math.min(MAX_TIME_SCALE_LIMIT, this.currentScale),
    );

    const state = this.getVignetteState();
    this.overlay.sync(state);
    this.onVignetteUpdate?.(state);

    return this.effectiveDt(realDeltaTimeS);
  }

  public bindKeyboardShortcut(target?: EventTarget): void {
    this.unbindKeyboardShortcut();
    const resolvedTarget = target ?? (typeof window !== 'undefined' ? window : null);
    if (!resolvedTarget) return;

    const handler = (ev: Event): void => {
      const ke = ev as KeyboardEvent;
      if (ke.repeat) return;
      if (ke.code === 'KeyZ') this.toggleReflex();
    };

    resolvedTarget.addEventListener('keydown', handler);
    this.boundKeyTarget = resolvedTarget;
    this.boundKeyHandler = handler;
  }

  public unbindKeyboardShortcut(): void {
    if (this.boundKeyTarget && this.boundKeyHandler) {
      this.boundKeyTarget.removeEventListener('keydown', this.boundKeyHandler);
    }
    this.boundKeyTarget = null;
    this.boundKeyHandler = null;
  }

  public mountVignetteOverlay(parent?: HTMLElement): void {
    this.overlay.mount(parent);
  }

  public reset(): void {
    this.reflexState = { kind: 'READY' };
    this.killPunchState = { kind: 'INACTIVE' };
    this.currentScale = 1.0;
    const state = this.getVignetteState();
    this.overlay.sync(state);
    this.onVignetteUpdate?.(state);
  }

  public destroy(): void {
    this.unbindKeyboardShortcut();
    this.overlay.destroy();
  }
}
