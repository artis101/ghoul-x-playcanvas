import {
  type BulletTimeOptions,
  type BulletTimeVignetteState,
  type BulletTimeVignetteTint,
  type KillPunchReason,
  MAX_TIME_SCALE_LIMIT,
  MIN_TIME_SCALE_LIMIT,
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
  private reflexActive = false;
  private energyPct = 100.0;
  private rechargeDelayTimerS = 0;
  private killPunchRemainingS = 0;
  private killPunchTargetScale = 0.16;

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

  public get timeScale(): number { return this.currentScale; }
  public get isReflexActive(): boolean { return this.reflexActive; }
  public get isKillPunchActive(): boolean { return this.killPunchRemainingS > 0; }
  public get reflexEnergyPct(): number { return this.energyPct; }

  public effectiveDt(rawDt: number): number {
    return (!Number.isFinite(rawDt) || rawDt <= 0) ? 0 : rawDt * this.currentScale;
  }

  public toggleReflex(): boolean {
    if (this.reflexActive) {
      this.setReflexActive(false);
      return false;
    }
    if (this.energyPct >= this.minActivationPct) {
      this.setReflexActive(true);
      return true;
    }
    return false;
  }

  public setReflexActive(active: boolean): void {
    if (active) {
      if (this.energyPct >= this.minActivationPct) {
        this.reflexActive = true;
      }
    } else {
      if (this.reflexActive) {
        this.reflexActive = false;
        this.rechargeDelayTimerS = this.rechargeCooldownS;
      }
    }
  }

  public grantReflexEnergy(amountPct: number): void {
    if (!Number.isFinite(amountPct) || amountPct <= 0) return;
    this.energyPct = Math.min(100.0, this.energyPct + amountPct);
  }

  public triggerKillPunch(
    durationOrReason: number | KillPunchReason = 'CRANIAL_POP',
    targetScaleOrDuration: number = 0.35,
    maybeReason?: KillPunchReason,
  ): void {
    let reason: KillPunchReason =
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
    this.killPunchRemainingS = Math.max(this.killPunchRemainingS, clampedDuration);

    const punchScale =
      reason === 'MULTI_KILL_BLAST'
        ? 0.14
        : reason === 'CRANIAL_POP'
          ? 0.16
          : 0.2;
    this.killPunchTargetScale = Math.max(this.minTimeScale, punchScale);

    const bonusPct = reason === 'MULTI_KILL_BLAST' ? 18 : reason === 'CRANIAL_POP' ? 12 : 8;
    this.grantReflexEnergy(bonusPct);
  }

  public getVignetteState(): BulletTimeVignetteState {
    const dilationDepth = Math.max(
      0,
      Math.min(1, (1.0 - this.currentScale) / Math.max(0.001, 1.0 - this.reflexTargetScale)),
    );
    const killPunchActive = this.killPunchRemainingS > 0;

    let tint: BulletTimeVignetteTint = 'NONE';
    let cssBoxShadow = 'none';

    if (killPunchActive && !this.reflexActive) {
      tint = 'AMBER_KILL_PUNCH';
      const alpha = (0.38 * dilationDepth).toFixed(3);
      const spreadPx = Math.round(68 * dilationDepth + 14);
      cssBoxShadow = `inset 0 0 ${spreadPx}px rgba(255, 146, 36, ${alpha})`;
    } else if (dilationDepth > 0.02) {
      tint = killPunchActive ? 'AMBER_KILL_PUNCH' : 'CYAN_REFLEX';
      const r = killPunchActive ? 255 : 34;
      const g = killPunchActive ? 168 : 226;
      const b = killPunchActive ? 58 : 255;
      const alpha = (0.34 * dilationDepth).toFixed(3);
      const spreadPx = Math.round(76 * dilationDepth + 16);
      cssBoxShadow = `inset 0 0 ${spreadPx}px rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    return {
      active: this.reflexActive,
      killPunchActive,
      timeScale: this.currentScale,
      reflexEnergyPct: this.energyPct,
      intensity: dilationDepth,
      tint,
      cssBoxShadow,
    };
  }

  public update(realDeltaTimeS: number): number {
    if (!Number.isFinite(realDeltaTimeS) || realDeltaTimeS <= 0) return 0;
    const dt = Math.min(0.1, realDeltaTimeS);

    if (this.reflexActive) {
      this.energyPct = Math.max(0, this.energyPct - this.drainPctPerSec * dt);
      if (this.energyPct <= 0.001) {
        this.reflexActive = false;
        this.rechargeDelayTimerS = this.rechargeCooldownS;
      }
    } else if (this.rechargeDelayTimerS > 0) {
      this.rechargeDelayTimerS = Math.max(0, this.rechargeDelayTimerS - dt);
    } else if (this.energyPct < 100.0) {
      this.energyPct = Math.min(100.0, this.energyPct + this.rechargePctPerSec * dt);
    }

    if (this.killPunchRemainingS > 0) {
      this.killPunchRemainingS = Math.max(0, this.killPunchRemainingS - dt);
      if (this.killPunchRemainingS <= 0) this.killPunchTargetScale = 0.16;
    }

    let desiredScale = MAX_TIME_SCALE_LIMIT;
    if (this.killPunchRemainingS > 0 && this.reflexActive) {
      desiredScale = Math.min(this.killPunchTargetScale, this.reflexTargetScale);
    } else if (this.killPunchRemainingS > 0) {
      desiredScale = this.killPunchTargetScale;
    } else if (this.reflexActive) {
      desiredScale = this.reflexTargetScale;
    }

    const blendFactor = 1.0 - Math.exp(-this.lerpRatePerSec * dt);
    this.currentScale += (desiredScale - this.currentScale) * blendFactor;
    this.currentScale = Math.max(this.minTimeScale, Math.min(MAX_TIME_SCALE_LIMIT, this.currentScale));

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
    this.reflexActive = false;
    this.currentScale = 1.0;
    this.energyPct = 100.0;
    this.rechargeDelayTimerS = 0;
    this.killPunchRemainingS = 0;
  }

  public destroy(): void {
    this.unbindKeyboardShortcut();
    this.overlay.destroy();
  }
}
