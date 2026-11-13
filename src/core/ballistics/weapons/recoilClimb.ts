/**
 * Muzzle climb: the part of recoil that stays in the aim. The quick kick that springs back
 * (playerCameraRig.applyRecoilKick) is only the visible jolt. Climb moves the view itself, so on
 * full auto the shooter has to pull down against it. After the trigger is let go, the shooter's
 * hold brings back only part of the rise.
 *
 * Pure: the engine owns the camera angles and passes in the random numbers.
 */

export interface RecoilClimbPattern {
  /** Muzzle rise per shot that stays in the aim once the burst has ramped up, degrees. */
  readonly climbDeg: number;
  /** Share of climbDeg on the first shot of a burst; the next shots ramp linearly up to 1. */
  readonly firstShotScale: number;
  /** Shot of the burst at which the full climbDeg is reached. */
  readonly rampShots: number;
  /** Steady sideways drift per shot, degrees, positive to the right. */
  readonly yawBiasDeg: number;
  /** Random sideways throw per shot, +/- degrees. */
  readonly yawJitterDeg: number;
  /** Share of the climb kept when fully aimed (shoulder and cheek weld, two-handed grip). */
  readonly adsScale: number;
  /** Share of the accumulated climb the shooter brings back down after the burst. */
  readonly recoveryShare: number;
  /** Seconds after the last shot before the shooter starts pulling down. */
  readonly recoveryDelayS: number;
  /** Exponential rate of that pull-down, per second. */
  readonly recoveryPerS: number;
  /** A shot longer than this after the previous one starts a new burst, seconds. */
  readonly burstGapS: number;
}

/**
 * 5.56 is a mild round, but at 750 rpm the rise stacks up. The first rounds of a burst stay
 * close; from the fourth on, each lifts the muzzle about 0.65 degree from the hip (about 0.45
 * aimed), and the muzzle wanders a little sideways. A whole magazine held down climbs out of
 * the target unless the shooter pulls down.
 */
const M4A1: RecoilClimbPattern = {
  climbDeg: 0.66,
  firstShotScale: 0.35,
  rampShots: 4,
  yawBiasDeg: 0.05,
  yawJitterDeg: 0.3,
  adsScale: 0.68,
  recoveryShare: 0.35,
  recoveryDelayS: 0.14,
  recoveryPerS: 6,
  burstGapS: 0.22,
};

/**
 * .50 AE throws the muzzle up hard on every shot. The shooter brings most of it back between
 * shots, but quick follow-ups land high, and each shot throws the muzzle unpredictably to the side.
 */
const SILVER_TALON: RecoilClimbPattern = {
  climbDeg: 3.8,
  firstShotScale: 1,
  rampShots: 1,
  yawBiasDeg: 0,
  yawJitterDeg: 1.25,
  adsScale: 0.8,
  recoveryShare: 0.62,
  recoveryDelayS: 0.1,
  recoveryPerS: 5.5,
  burstGapS: 0.5,
};

const M590: RecoilClimbPattern = {
  climbDeg: 2.6,
  firstShotScale: 1,
  rampShots: 1,
  yawBiasDeg: 0.15,
  yawJitterDeg: 0.7,
  adsScale: 0.75,
  recoveryShare: 0.6,
  recoveryDelayS: 0.12,
  recoveryPerS: 5,
  burstGapS: 0.9,
};

const MSG90: RecoilClimbPattern = {
  climbDeg: 3.2,
  firstShotScale: 1,
  rampShots: 1,
  yawBiasDeg: 0.2,
  yawJitterDeg: 0.6,
  adsScale: 0.6,
  recoveryShare: 0.75,
  recoveryDelayS: 0.18,
  recoveryPerS: 4,
  burstGapS: 2.5,
};

const DEFAULT_PATTERN: RecoilClimbPattern = { ...M4A1, climbDeg: 0.5 };

export const RECOIL_CLIMB_PATTERNS: Readonly<Record<string, RecoilClimbPattern>> = {
  m4a1_carbine: M4A1,
  silver_talon_50ae: SILVER_TALON,
  m590_shotgun: M590,
  msg90_sniper: MSG90,
};

export function recoilClimbPattern(weaponId: string): RecoilClimbPattern {
  return RECOIL_CLIMB_PATTERNS[weaponId] ?? DEFAULT_PATTERN;
}

export interface RecoilClimbState {
  shotsInBurst: number;
  sinceShotS: number;
  /** Climb still to be brought back down by the shooter's hold, degrees. */
  recoverablePitchDeg: number;
  pattern: RecoilClimbPattern;
}

export function createRecoilClimbState(): RecoilClimbState {
  return { shotsInBurst: 0, sinceShotS: Infinity, recoverablePitchDeg: 0, pattern: DEFAULT_PATTERN };
}

export interface RecoilClimbKick {
  /** Upward, degrees. */
  readonly pitchDeg: number;
  /** Positive to the right, degrees. */
  readonly yawDeg: number;
}

/**
 * One shot's climb. adsBlend is 0 at the hip and 1 fully aimed; u is uniform in [0, 1) and
 * picks the sideways throw. Call creditClimb with the pitch the camera actually took.
 */
export function kickRecoilClimb(
  state: RecoilClimbState,
  weaponId: string,
  adsBlend: number,
  u: number
): RecoilClimbKick {
  const pattern = recoilClimbPattern(weaponId);
  if (pattern !== state.pattern || state.sinceShotS > pattern.burstGapS) state.shotsInBurst = 0;
  state.pattern = pattern;
  state.shotsInBurst += 1;
  state.sinceShotS = 0;

  const ramp = pattern.rampShots <= 1
    ? 1
    : Math.min(1, pattern.firstShotScale + (1 - pattern.firstShotScale) * (state.shotsInBurst - 1) / (pattern.rampShots - 1));
  const blend = Math.max(0, Math.min(1, adsBlend));
  const brace = 1 - blend * (1 - pattern.adsScale);
  const jitter = (Math.max(0, Math.min(1, u)) * 2 - 1) * pattern.yawJitterDeg;
  return {
    pitchDeg: pattern.climbDeg * ramp * brace,
    yawDeg: (pattern.yawBiasDeg + jitter) * brace,
  };
}

/** Records how much of a kick's pitch the camera took (it may have hit the pitch limit). */
export function creditClimb(state: RecoilClimbState, appliedPitchDeg: number): void {
  state.recoverablePitchDeg += Math.max(0, appliedPitchDeg) * state.pattern.recoveryShare;
}

/** The player pulled the view down by this much; that already pays back the climb. */
export function absorbPlayerPullDown(state: RecoilClimbState, downDeg: number): void {
  if (downDeg <= 0) return;
  state.recoverablePitchDeg = Math.max(0, state.recoverablePitchDeg - downDeg);
}

/** Advances the clock; returns how far the shooter's hold pulls the view down this frame. */
export function stepRecoilClimb(state: RecoilClimbState, dt: number): number {
  state.sinceShotS += dt;
  const { pattern } = state;
  if (state.recoverablePitchDeg <= 0 || state.sinceShotS < pattern.recoveryDelayS) return 0;
  const pull = state.recoverablePitchDeg * (1 - Math.exp(-pattern.recoveryPerS * dt));
  state.recoverablePitchDeg -= pull;
  if (state.recoverablePitchDeg < 0.01) {
    const rest = state.recoverablePitchDeg;
    state.recoverablePitchDeg = 0;
    return pull + rest;
  }
  return pull;
}
