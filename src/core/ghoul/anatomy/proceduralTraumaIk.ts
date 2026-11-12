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

export interface ProceduralTraumaTrackerState {
  lastHandledReactionEpoch: number;
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
  wristPositionsWorld: Record<ArmSide, Vec3Like>
): ProceduralTraumaPoseOutput {
  const safeDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.05) : 0;

  let totalDamageJ = 0;
  for (const k of Object.keys(state.zoneCumulativeDamageJ) as GhoulZoneId[]) {
    totalDamageJ += state.zoneCumulativeDamageJ[k] || 0;
  }

  const rx = state.activeReaction;
  const rxEpoch = rx.epoch ?? 0;
  const newHitImpulse =
    (rx.type !== 'NONE' && rxEpoch !== tracker.lastHandledReactionEpoch) ||
    totalDamageJ > tracker.lastTotalDamageJ + 12;

  if (newHitImpulse) {
    const sinYaw = Math.sin(state.yawRad);
    const cosYaw = Math.cos(state.yawRad);
    const fwd = vec3(sinYaw, 0, cosYaw);
    const left = vec3(cosYaw, 0, -sinYaw);
    const hitDir =
      length(rx.hitDirectionWorld) > 1e-4 ? normalize(rx.hitDirectionWorld) : scale(fwd, -1);

    const frontDot = dot(hitDir, fwd);
    const sideDot = dot(hitDir, left);
    const joltMag = Math.min(1.6, Math.max(0.45, rx.intensity * 1.15));

    tracker.joltVelPitch += frontDot * 9.5 * joltMag;
    tracker.joltVelYaw += sideDot * 7.8 * joltMag;
    tracker.joltVelRoll += -sideDot * 6.2 * joltMag;
  }
  tracker.lastHandledReactionEpoch = rxEpoch;
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
  const downedReturningFire =
    state.alive &&
    !state.isRagdollActive &&
    !state.weaponDropped &&
    (state.posture === 'LEG_BUCKLED' || !state.rightLegFunctional || !state.leftLegFunctional) &&
    (state.rightArmFunctional || state.leftArmFunctional);
  const targetProp = downedReturningFire ? 1.0 : 0.0;
  tracker.propUpBlend += (targetProp - tracker.propUpBlend) * (1 - Math.exp(-9 * safeDt));
  const propUpPitchRad = tracker.propUpBlend * -0.44; // Lifts chest/head upward from crawl pose

  // Wound-clutching IK evaluation
  let clutchSide: ArmSide | null = null;
  const preferredSupport: ArmSide = supportSide(state.isLeftHanded);
  if (isArmAvailableForClutch(state, preferredSupport)) {
    clutchSide = preferredSupport;
  } else {
    const otherSide: ArmSide = oppositeSide(preferredSupport);
    if (isArmAvailableForClutch(state, otherSide)) {
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
