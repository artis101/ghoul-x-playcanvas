/**
 * Close-quarters juking for combatants fighting in the open.
 *
 * Far away, a combatant's lateral motion comes from hunting for a clear peek past its cover,
 * which can mean metres of sidestep. Up close and in the open the peek plan settles on a
 * sub-metre shuffle, so a nearby enemy barely moves sideways. This drives a deliberate juke:
 * plant and shoot at one side, then cross to the other. Timing is irregular, the occasional
 * feint holds the same side twice, and the combatant breaks early when it is hit, when the
 * player's crosshair settles on it, or when a wall stops it.
 */

// Beyond this range the cover peek plan alone drives lateral movement.
const CQ_FAR_M = 14;
// At or inside this range the juke is at full width.
const CQ_NEAR_M = 4;
const CQ_MAX_AMPLITUDE_M = 1.45;
const CQ_MIN_DWELL_S = 0.65;
const CQ_MAX_DWELL_S = 1.9;
// Chance that a juke "feints": it stays on the same side for another dwell.
const CQ_FEINT_CHANCE = 0.18;
// Being aimed at burns down the dwell this much faster.
const CQ_AIM_URGENCY = 2.2;
// A juke must have run at least this long before a hit can break it, so it cannot jitter.
const CQ_MIN_COMMIT_S = 0.3;
// How long lateral progress may stall before the combatant decides it is blocked.
const CQ_STALL_LIMIT_S = 0.3;

export interface CloseQuartersJukeState {
  side: -1 | 1;
  /** Time left planted at the current side before crossing. */
  dwellS: number;
  /** Time since the current juke began. */
  elapsedS: number;
  /** Fraction (0.75–1) of full width used for the current juke. */
  widthScale: number;
  stallS: number;
  rng: number;
}

export interface CloseQuartersJukeInput {
  readonly dt: number;
  readonly playerDistanceM: number;
  /** 0–1: how squarely the player is aiming at this combatant. */
  readonly aimThreat: number;
  readonly wasHit: boolean;
  /** True when the combatant wanted to move sideways but made no headway this frame. */
  readonly lateralStalled: boolean;
  /** Arena x of the combatant's cover anchor, and the usable half-width either side of zero. */
  readonly anchorX: number;
  readonly arenaHalfWidthM: number;
}

/** How strongly close-quarters juking applies at this range, from 0 (far) to 1 (point blank). */
export function closeQuartersStrafeWeight(playerDistanceM: number): number {
  const t = (CQ_FAR_M - playerDistanceM) / (CQ_FAR_M - CQ_NEAR_M);
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

function nextRandom(state: CloseQuartersJukeState): number {
  // xorshift32: deterministic per combatant, cheap, and fine for movement variety.
  let x = state.rng | 0 || 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rng = x;
  return (x >>> 0) / 0x100000000;
}

export function createCloseQuartersJukeState(seed: number, initialSide: -1 | 1): CloseQuartersJukeState {
  const state: CloseQuartersJukeState = {
    side: initialSide,
    dwellS: 0,
    elapsedS: 0,
    widthScale: 1,
    stallS: 0,
    rng: (Math.floor(Math.abs(seed) * 2654435761) >>> 0) || 1,
  };
  state.dwellS = CQ_MIN_DWELL_S + nextRandom(state) * (CQ_MAX_DWELL_S - CQ_MIN_DWELL_S);
  return state;
}

function beginJuke(state: CloseQuartersJukeState, forceFlip: boolean): void {
  const feint = !forceFlip && nextRandom(state) < CQ_FEINT_CHANCE;
  if (!feint) state.side = state.side === 1 ? -1 : 1;
  state.dwellS = CQ_MIN_DWELL_S + nextRandom(state) * (CQ_MAX_DWELL_S - CQ_MIN_DWELL_S);
  state.widthScale = 0.75 + nextRandom(state) * 0.25;
  state.elapsedS = 0;
  state.stallS = 0;
}

/**
 * Advances the juke and returns the lateral offset in metres to add on top of the peek plan.
 * Returns 0 (and lets the state idle) when the player is too far away for juking to matter.
 */
export function stepCloseQuartersJuke(state: CloseQuartersJukeState, input: CloseQuartersJukeInput): number {
  const weight = closeQuartersStrafeWeight(input.playerDistanceM);
  if (weight <= 0) {
    state.stallS = 0;
    return 0;
  }

  state.elapsedS += input.dt;
  state.dwellS -= input.dt * (1 + Math.max(0, Math.min(1, input.aimThreat)) * CQ_AIM_URGENCY);
  state.stallS = input.lateralStalled ? state.stallS + input.dt : 0;

  const amplitude = CQ_MAX_AMPLITUDE_M * weight * state.widthScale;
  const wouldLeaveArena = Math.abs(input.anchorX + state.side * amplitude) > input.arenaHalfWidthM;

  if (wouldLeaveArena || state.stallS >= CQ_STALL_LIMIT_S) {
    beginJuke(state, true);
  } else if (input.wasHit && state.elapsedS >= CQ_MIN_COMMIT_S) {
    beginJuke(state, true);
  } else if (state.dwellS <= 0) {
    beginJuke(state, false);
  }

  const finalAmplitude = CQ_MAX_AMPLITUDE_M * weight * state.widthScale;
  const offset = state.side * finalAmplitude;
  // Never pick a side that the arena wall cuts off; hug the wall instead.
  const maxX = input.arenaHalfWidthM - input.anchorX;
  const minX = -input.arenaHalfWidthM - input.anchorX;
  return Math.max(minX, Math.min(maxX, offset));
}
