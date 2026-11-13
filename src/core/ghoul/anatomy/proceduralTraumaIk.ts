import type { GhoulZoneId, TargetHealthState } from '../../../contracts/ballistics.ts';
import { dot, length, normalize, scale, vec3 } from '../../ballistics/vec3.ts';
import {
  type ArmSide,
  type DeadArmSimState,
  isArmDeadButAttached,
  stepPinnedDeadArmVerlet,
} from './deadArmVerlet.ts';

export type { ArmSide, DeadArmSimState };
export { isArmDeadButAttached, stepPinnedDeadArmVerlet };

/** Which kind of authored wound clip owns the body: a short flinch, a long fall or loss, or none. */
export type WoundClipOwner = 'FLINCH' | 'COMMITTED' | null;

/**
 * What the body clip is doing. The authored clips own every living pose, so the only procedural
 * motion left on a standing body is the hit jolt, and that only for a graze, which has no clip.
 */
export interface ProceduralTraumaGating {
  readonly woundClip?: WoundClipOwner;
  /** A seated last-stand, stump-clutch or crawl clip holds the body. */
  readonly bodyClip?: boolean;
}

/**
 * How much of the spring jolt a new hit gets. A wound, fall or seated clip already shows the
 * hit, so a jolt on top would only bend the authored pose; with no such clip (a graze, or a hit
 * the reaction ignored) the jolt is the only read of the impact, so it plays in full.
 */
export function hitJoltScale(gating: ProceduralTraumaGating): number {
  return (gating.woundClip ?? null) !== null || gating.bodyClip ? 0 : 1;
}

export interface ProceduralTraumaTrackerState {
  lastHandledReactionEpoch: number;
  /** Last per-hit jolt counter seen; null until the first frame has read it. */
  lastHandledJoltEpoch: number | null;
  lastTotalDamageJ: number;
  joltVelPitch: number;
  joltVelYaw: number;
  joltVelRoll: number;
  joltPitchRad: number;
  joltYawRad: number;
  joltRollRad: number;
  deadArmState: Record<ArmSide, DeadArmSimState>;
}

/** Additive rotations for the upper thorax and the head, in radians. */
export interface HitJoltPose {
  hasJolt: boolean;
  torsoPitchAddRad: number;
  torsoYawAddRad: number;
  torsoRollAddRad: number;
  headPitchAddRad: number;
  headYawAddRad: number;
}

export function createProceduralTraumaTracker(): ProceduralTraumaTrackerState {
  return {
    lastHandledReactionEpoch: 0,
    lastHandledJoltEpoch: null,
    lastTotalDamageJ: 0,
    joltVelPitch: 0,
    joltVelYaw: 0,
    joltVelRoll: 0,
    joltPitchRad: 0,
    joltYawRad: 0,
    joltRollRad: 0,
    deadArmState: {
      RIGHT: { kind: 'INACTIVE' },
      LEFT: { kind: 'INACTIVE' },
    },
  };
}

/** Steps the spring-damped hit jolt: each surviving bullet kicks the chest and head, which spring back. */
export function stepHitJolt(
  state: TargetHealthState,
  tracker: ProceduralTraumaTrackerState,
  dt: number,
  gating: ProceduralTraumaGating = {}
): HitJoltPose {
  const safeDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.05) : 0;

  let totalDamageJ = 0;
  for (const k of Object.keys(state.zoneCumulativeDamageJ) as GhoulZoneId[]) {
    totalDamageJ += state.zoneCumulativeDamageJ[k] || 0;
  }

  const rx = state.activeReaction;
  const rxEpoch = rx.epoch ?? 0;
  // Every surviving hit bumps the jolt counter, even one that leaves the running reaction alone.
  // Without it, a new reaction or a jump in damage stands in for a hit.
  const joltEpoch = state.joltEpoch;
  const newHitImpulse =
    joltEpoch !== undefined
      ? tracker.lastHandledJoltEpoch !== null && joltEpoch !== tracker.lastHandledJoltEpoch
      : (rx.type !== 'NONE' && rxEpoch !== tracker.lastHandledReactionEpoch) ||
        totalDamageJ > tracker.lastTotalDamageJ + 12;

  const clipScale = hitJoltScale(gating);
  if (newHitImpulse && clipScale > 0) {
    const sinYaw = Math.sin(state.yawRad);
    const cosYaw = Math.cos(state.yawRad);
    const fwd = vec3(sinYaw, 0, cosYaw);
    const left = vec3(cosYaw, 0, -sinYaw);
    const rawDir = state.lastJoltDirectionWorld ?? rx.hitDirectionWorld;
    const hitDir = length(rawDir) > 1e-4 ? normalize(rawDir) : scale(fwd, -1);
    const joltMag = Math.min(1.6, Math.max(0.45, (state.lastJoltIntensity ?? rx.intensity) * 1.15)) * clipScale;
    tracker.joltVelPitch += dot(hitDir, fwd) * 9.5 * joltMag;
    tracker.joltVelYaw += dot(hitDir, left) * 7.8 * joltMag;
    tracker.joltVelRoll += -dot(hitDir, left) * 6.2 * joltMag;
  }
  tracker.lastHandledReactionEpoch = rxEpoch;
  // The counter is absent until the first hit, which then counts up from zero.
  tracker.lastHandledJoltEpoch = joltEpoch ?? 0;
  tracker.lastTotalDamageJ = totalDamageJ;

  if (safeDt > 0) {
    // Underdamped spring-damper: the body snaps back from a hit within 30-180 ms.
    const stiffness = 175;
    const damping = 19;
    tracker.joltVelPitch += (-stiffness * tracker.joltPitchRad - damping * tracker.joltVelPitch) * safeDt;
    tracker.joltVelYaw += (-stiffness * tracker.joltYawRad - damping * tracker.joltVelYaw) * safeDt;
    tracker.joltVelRoll += (-stiffness * tracker.joltRollRad - damping * tracker.joltVelRoll) * safeDt;
    tracker.joltPitchRad = clamp(tracker.joltPitchRad + tracker.joltVelPitch * safeDt, 0.48);
    tracker.joltYawRad = clamp(tracker.joltYawRad + tracker.joltVelYaw * safeDt, 0.52);
    tracker.joltRollRad = clamp(tracker.joltRollRad + tracker.joltVelRoll * safeDt, 0.38);
  }

  const hasJolt =
    Math.abs(tracker.joltPitchRad) > 1e-3 || Math.abs(tracker.joltYawRad) > 1e-3 || Math.abs(tracker.joltRollRad) > 1e-3;
  return {
    hasJolt,
    torsoPitchAddRad: tracker.joltPitchRad,
    torsoYawAddRad: tracker.joltYawRad,
    torsoRollAddRad: tracker.joltRollRad,
    headPitchAddRad: tracker.joltPitchRad * 0.65,
    headYawAddRad: tracker.joltYawRad * 0.55,
  };
}

function clamp(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}
