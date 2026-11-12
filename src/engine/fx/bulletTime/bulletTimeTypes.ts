export type KillPunchReason = 'CRANIAL_POP' | 'MULTI_KILL_BLAST' | 'DISMEMBERMENT';

export type BulletTimeVignetteTint = 'NONE' | 'CYAN_REFLEX' | 'AMBER_KILL_PUNCH';

export type ReflexMeterState =
  | { readonly kind: 'READY' }
  | { readonly kind: 'DRAINING'; readonly energyPct: number }
  | {
      readonly kind: 'COOLDOWN';
      readonly energyPct: number;
      readonly cooldownRemainingS: number;
    }
  | { readonly kind: 'RECHARGING'; readonly energyPct: number };

export type KillPunchState =
  | { readonly kind: 'INACTIVE' }
  | {
      readonly kind: 'ACTIVE';
      readonly reason: KillPunchReason;
      readonly remainingS: number;
      readonly targetScale: number;
    };

export interface BulletTimeVignetteState {
  readonly active: boolean;
  readonly killPunchActive: boolean;
  readonly timeScale: number;
  readonly reflexEnergyPct: number;
  readonly intensity: number;
  readonly tint: BulletTimeVignetteTint;
  readonly cssBoxShadow: string;
}

export interface BulletTimeOptions {
  /** Target timeScale when [Z] Reflex Slow-Motion is active (default 0.22) */
  reflexTargetScale?: number;
  /** Minimum allowed timeScale during heavy kill-punch dilation (default 0.08) */
  minTimeScale?: number;
  /** Reflex meter drain rate in percentage points per real second (default 20) */
  drainPctPerRealSec?: number;
  /** Reflex meter recharge rate in percentage points per real second (default 15) */
  rechargePctPerRealSec?: number;
  /** Recharge delay after Reflex disengages in real seconds (default 0.4) */
  rechargeCooldownS?: number;
  /** Minimum Reflex meter required to activate slow-motion (default 10%) */
  minActivationPct?: number;
  /** Exponential smoothing speed for timeScale transitions (default 14) */
  lerpRatePerRealSec?: number;
  /** Optional hook receiving CSS/canvas edge vignette updates every frame */
  onVignetteUpdate?: (state: BulletTimeVignetteState) => void;
}

export const MIN_TIME_SCALE_LIMIT = 0.08;
export const MAX_TIME_SCALE_LIMIT = 1.0;
