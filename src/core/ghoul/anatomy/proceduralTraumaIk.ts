import { oppositeSide, supportSide, triggerSide } from './handedness.ts';
import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../../contracts/ballistics.ts';
import { add, dot, length, normalize, scale, vec3 } from '../../ballistics/vec3.ts';
import {
  type ArmSide,
  type DeadArmSimState,
  isArmDeadButAttached,
  stepPinnedDeadArmVerlet,
} from './deadArmVerlet.ts';
import { solveTwoBoneIk } from './twoBoneIk.ts';

export type { ArmSide, DeadArmSimState };
export { isArmDeadButAttached, stepPinnedDeadArmVerlet };

/** Which kind of authored wound clip owns the body: a short flinch, a long fall or loss, or none. */
export type WoundClipOwner = 'FLINCH' | 'COMMITTED' | null;

/** What the body clip is doing, so the procedural passes can step back from it. */
export interface ProceduralTraumaGating {
  readonly woundClip?: WoundClipOwner;
  /** Keep the free hand off the wound, e.g. while the stump-clutch loop holds it. */
  readonly suppressClutch?: boolean;
}

// The clips already carry the hit, so the spring only adds the punch of each new bullet on top.
const JOLT_SCALE_DURING_FLINCH = 0.35;
const JOLT_SCALE_DURING_COMMITTED = 0.25;

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
  clutchBlend: number;
  propUpBlend: number;
  deadArmState: Record<ArmSide, DeadArmSimState>;
}

export interface ProceduralTraumaPoseOutput {
  hasJoltOrPropUp: boolean;
  torsoPitchAddRad: number;
  torsoYawAddRad: number;
  torsoRollAddRad: number;
  headPitchAddRad: number;
  headYawAddRad: number;
  clutchSide: ArmSide | null;
  clutchBlend: number;
  clutchElbowWorld: Vec3Like | null;
  clutchWristWorld: Vec3Like | null;
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
    clutchBlend: 0,
    propUpBlend: 0,
    deadArmState: {
      RIGHT: { kind: 'INACTIVE' },
      LEFT: { kind: 'INACTIVE' },
    },
  };
}

function isArmAvailableForClutch(state: TargetHealthState, side: ArmSide): boolean {
  const functional = side === 'RIGHT' ? state.rightArmFunctional : state.leftArmFunctional;
  if (!functional) return false;
  if (
    state.severedZones.has(`SHOULDER_${side}`) ||
    state.severedZones.has(`UPPER_ARM_${side}`) ||
    state.severedZones.has(`FOREARM_${side}`) ||
    state.severedZones.has(`HAND_${side}`)
  ) {
    return false;
  }
  const primarySide: ArmSide = triggerSide(state.isLeftHanded);
  const primaryFunctional =
    primarySide === 'RIGHT' ? state.rightArmFunctional : state.leftArmFunctional;
  const holdingWeaponSide: ArmSide | null =
    state.weaponDropped ? null : primaryFunctional ? primarySide : side;

  if (holdingWeaponSide === side) {
    return false;
  }
  // Support hand can clutch when staggered, gut-hurt, throat-clutching, leg-buckled, or weapon dropped
  return (
    state.weaponDropped ||
    state.posture !== 'COMBAT_READY' ||
    state.activeReaction.type !== 'NONE' ||
    state.painShock >= 0.22
  );
}

function resolveWoundClutchTargetWorld(state: TargetHealthState): Vec3Like | null {
  for (let i = state.surfaceWounds.length - 1; i >= 0; i--) {
    const w = state.surfaceWounds[i];
    if (
      w.zone.startsWith('UPPER_ARM_') ||
      w.zone.startsWith('FOREARM_') ||
      w.zone.startsWith('HAND_') ||
      w.zone.startsWith('SHIN_') ||
      w.zone.startsWith('FOOT_')
    ) {
      continue;
    }
    const bone = state.ragdollBones[w.zone];
    if (!bone || bone.componentId !== 'BODY') continue;
    const worldPt = add(
      bone.position,
      add(
        add(scale(bone.basisRight, w.localOffset.x), scale(bone.basisUp, w.localOffset.y)),
        scale(bone.basisForward, w.localOffset.z + 0.04)
      )
    );
    return worldPt;
  }

  if (state.posture === 'THROAT_CLUTCH' || state.activeReaction.type === 'THROAT_CLUTCH') {
    const neck = state.ragdollBones.NECK_CERVICAL;
    return add(neck.position, scale(neck.basisForward, 0.06));
  }
  if (state.posture === 'GUT_HURT' || state.activeReaction.type === 'GUT_FOLD') {
    const gut = state.ragdollBones.TORSO_LOWER_ABDOMEN;
    return add(gut.position, scale(gut.basisForward, 0.11));
  }
  if (state.posture === 'LEG_BUCKLED' || !state.rightLegFunctional || !state.leftLegFunctional) {
    const thighZone: GhoulZoneId = !state.rightLegFunctional ? 'THIGH_RIGHT' : 'THIGH_LEFT';
    const thigh = state.ragdollBones[thighZone];
    return add(thigh.position, scale(thigh.basisForward, 0.08));
  }
  return null;
}

export function stepProceduralTraumaIk(
  state: TargetHealthState,
  tracker: ProceduralTraumaTrackerState,
  dt: number,
  shoulderPositionsWorld: Record<ArmSide, Vec3Like>,
  elbowPositionsWorld: Record<ArmSide, Vec3Like>,
  wristPositionsWorld: Record<ArmSide, Vec3Like>,
  gating: ProceduralTraumaGating = {}
): ProceduralTraumaPoseOutput {
  const woundClip = gating.woundClip ?? null;
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

  if (newHitImpulse) {
    const sinYaw = Math.sin(state.yawRad);
    const cosYaw = Math.cos(state.yawRad);
    const fwd = vec3(sinYaw, 0, cosYaw);
    const left = vec3(cosYaw, 0, -sinYaw);
    const rawDir = state.lastJoltDirectionWorld ?? rx.hitDirectionWorld;
    const hitDir = length(rawDir) > 1e-4 ? normalize(rawDir) : scale(fwd, -1);

    const frontDot = dot(hitDir, fwd);
    const sideDot = dot(hitDir, left);
    const clipScale =
      woundClip === 'COMMITTED' ? JOLT_SCALE_DURING_COMMITTED : woundClip === 'FLINCH' ? JOLT_SCALE_DURING_FLINCH : 1;
    const joltMag = Math.min(1.6, Math.max(0.45, (state.lastJoltIntensity ?? rx.intensity) * 1.15)) * clipScale;

    tracker.joltVelPitch += frontDot * 9.5 * joltMag;
    tracker.joltVelYaw += sideDot * 7.8 * joltMag;
    tracker.joltVelRoll += -sideDot * 6.2 * joltMag;
  }
  tracker.lastHandledReactionEpoch = rxEpoch;
  // The counter is absent until the first hit, which then counts up from zero.
  tracker.lastHandledJoltEpoch = joltEpoch ?? 0;
  tracker.lastTotalDamageJ = totalDamageJ;

  if (safeDt > 0) {
    // Underdamped spring-damper (30-180ms physical hit-jolt recovery)
    const stiffness = 175;
    const damping = 19;
    tracker.joltVelPitch +=
      (-stiffness * tracker.joltPitchRad - damping * tracker.joltVelPitch) * safeDt;
    tracker.joltVelYaw +=
      (-stiffness * tracker.joltYawRad - damping * tracker.joltVelYaw) * safeDt;
    tracker.joltVelRoll +=
      (-stiffness * tracker.joltRollRad - damping * tracker.joltVelRoll) * safeDt;

    tracker.joltPitchRad = Math.max(
      -0.48,
      Math.min(0.48, tracker.joltPitchRad + tracker.joltVelPitch * safeDt)
    );
    tracker.joltYawRad = Math.max(
      -0.52,
      Math.min(0.52, tracker.joltYawRad + tracker.joltVelYaw * safeDt)
    );
    tracker.joltRollRad = Math.max(
      -0.38,
      Math.min(0.38, tracker.joltRollRad + tracker.joltVelRoll * safeDt)
    );
  }

  // Downed pelvic/femur upper-body prop-up while returning fire
  // A wound clip poses the chest itself; lifting it on top would bend a fall backwards.
  const downedReturningFire =
    woundClip === null &&
    state.alive &&
    !state.isRagdollActive &&
    !state.weaponDropped &&
    (state.posture === 'LEG_BUCKLED' || !state.rightLegFunctional || !state.leftLegFunctional) &&
    (state.rightArmFunctional || state.leftArmFunctional);
  const targetProp = downedReturningFire ? 1.0 : 0.0;
  tracker.propUpBlend += (targetProp - tracker.propUpBlend) * (1 - Math.exp(-9 * safeDt));
  const propUpPitchRad = tracker.propUpBlend * -0.44; // Lifts chest/head upward from crawl pose

  // Wound-clutching IK evaluation
  // The wound clips and the stump clutch hold the wound with their own hands.
  const clutchAllowed = woundClip === null && !gating.suppressClutch;
  let clutchSide: ArmSide | null = null;
  const preferredSupport: ArmSide = supportSide(state.isLeftHanded);
  if (clutchAllowed && isArmAvailableForClutch(state, preferredSupport)) {
    clutchSide = preferredSupport;
  } else {
    const otherSide: ArmSide = oppositeSide(preferredSupport);
    if (clutchAllowed && isArmAvailableForClutch(state, otherSide)) {
      clutchSide = otherSide;
    }
  }

  const woundGoal = clutchSide ? resolveWoundClutchTargetWorld(state) : null;
  const targetClutch = clutchSide && woundGoal ? 1.0 : 0.0;
  tracker.clutchBlend += (targetClutch - tracker.clutchBlend) * (1 - Math.exp(-11 * safeDt));

  let clutchElbowWorld: Vec3Like | null = null;
  let clutchWristWorld: Vec3Like | null = null;
  if (clutchSide && woundGoal && tracker.clutchBlend > 0.02) {
    const solved = solveTwoBoneIk(
      shoulderPositionsWorld[clutchSide],
      elbowPositionsWorld[clutchSide],
      wristPositionsWorld[clutchSide],
      woundGoal
    );
    if (solved) {
      const b = tracker.clutchBlend;
      clutchElbowWorld = add(
        scale(elbowPositionsWorld[clutchSide], 1 - b),
        scale(solved.elbow, b)
      );
      clutchWristWorld = add(
        scale(wristPositionsWorld[clutchSide], 1 - b),
        scale(solved.wrist, b)
      );
    }
  }

  const torsoPitchAddRad = tracker.joltPitchRad + propUpPitchRad;
  const torsoYawAddRad = tracker.joltYawRad;
  const torsoRollAddRad = tracker.joltRollRad;
  const hasJoltOrPropUp =
    Math.abs(torsoPitchAddRad) > 1e-3 ||
    Math.abs(torsoYawAddRad) > 1e-3 ||
    Math.abs(torsoRollAddRad) > 1e-3;

  return {
    hasJoltOrPropUp,
    torsoPitchAddRad,
    torsoYawAddRad,
    torsoRollAddRad,
    headPitchAddRad: tracker.joltPitchRad * 0.65 + propUpPitchRad * 0.45,
    headYawAddRad: tracker.joltYawRad * 0.55,
    clutchSide: clutchElbowWorld && clutchWristWorld ? clutchSide : null,
    clutchBlend: tracker.clutchBlend,
    clutchElbowWorld,
    clutchWristWorld,
  };
}
