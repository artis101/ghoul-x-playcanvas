import type { GhoulZoneId, RagdollBoneState, TargetHealthState, Vec3Like } from '../../../contracts/ballistics.ts';
import { add, cross, dot, length, normalize, scale, sub, vec3 } from '../../ballistics/vec3.ts';
import { solveTwoBoneIk } from './twoBoneIk.ts';

export type ArmSide = 'LEFT' | 'RIGHT';

export interface ProceduralTraumaTrackerState {
  lastReactionTimerS: number;
  lastTotalDamageJ: number;
  joltVelPitch: number;
  joltVelYaw: number;
  joltVelRoll: number;
  joltPitchRad: number;
  joltYawRad: number;
  joltRollRad: number;
  clutchBlend: number;
  propUpBlend: number;
  deadArmInitialized: Record<ArmSide, boolean>;
  prevShoulderPos: Record<ArmSide, Vec3Like>;
  prevShoulderVel: Record<ArmSide, Vec3Like>;
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
    lastReactionTimerS: 0,
    lastTotalDamageJ: 0,
    joltVelPitch: 0,
    joltVelYaw: 0,
    joltVelRoll: 0,
    joltPitchRad: 0,
    joltYawRad: 0,
    joltRollRad: 0,
    clutchBlend: 0,
    propUpBlend: 0,
    deadArmInitialized: { LEFT: false, RIGHT: false },
    prevShoulderPos: { LEFT: vec3(0, 0, 0), RIGHT: vec3(0, 0, 0) },
    prevShoulderVel: { LEFT: vec3(0, 0, 0), RIGHT: vec3(0, 0, 0) },
  };
}

export function isArmDeadButAttached(state: TargetHealthState, side: ArmSide): boolean {
  if (!state.alive || state.isRagdollActive) return false;
  const functional = side === 'LEFT' ? state.leftArmFunctional : state.rightArmFunctional;
  if (functional) return false;
  const upperZone: GhoulZoneId = `UPPER_ARM_${side}`;
  const shoulderZone: GhoulZoneId = `SHOULDER_${side}`;
  if (state.severedZones.has(upperZone) || state.severedZones.has(shoulderZone)) {
    return false;
  }
  return state.ragdollBones[upperZone].componentId === 'BODY';
}

function isArmAvailableForClutch(state: TargetHealthState, side: ArmSide): boolean {
  const functional = side === 'LEFT' ? state.leftArmFunctional : state.rightArmFunctional;
  if (!functional) return false;
  if (
    state.severedZones.has(`SHOULDER_${side}`) ||
    state.severedZones.has(`UPPER_ARM_${side}`) ||
    state.severedZones.has(`FOREARM_${side}`) ||
    state.severedZones.has(`HAND_${side}`)
  ) {
    return false;
  }
  const primarySide: ArmSide = state.isLeftHanded ? 'LEFT' : 'RIGHT';
  const primaryFunctional = primarySide === 'LEFT' ? state.leftArmFunctional : state.rightArmFunctional;
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
  if (state.posture === 'LEG_BUCKLED' || !state.leftLegFunctional || !state.rightLegFunctional) {
    const thighZone: GhoulZoneId = !state.leftLegFunctional ? 'THIGH_LEFT' : 'THIGH_RIGHT';
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
  const newHitImpulse =
    (rx.type !== 'NONE' && rx.timerS > tracker.lastReactionTimerS + 0.01) ||
    totalDamageJ > tracker.lastTotalDamageJ + 12;

  if (newHitImpulse) {
    const sinYaw = Math.sin(state.yawRad);
    const cosYaw = Math.cos(state.yawRad);
    const fwd = vec3(sinYaw, 0, cosYaw);
    const right = vec3(cosYaw, 0, -sinYaw);
    const hitDir = length(rx.hitDirectionWorld) > 1e-4 ? normalize(rx.hitDirectionWorld) : scale(fwd, -1);

    const frontDot = dot(hitDir, fwd);
    const sideDot = dot(hitDir, right);
    const joltMag = Math.min(1.6, Math.max(0.45, rx.intensity * 1.15));

    tracker.joltVelPitch += frontDot * 9.5 * joltMag;
    tracker.joltVelYaw += sideDot * 7.8 * joltMag;
    tracker.joltVelRoll += -sideDot * 6.2 * joltMag;
  }
  tracker.lastReactionTimerS = rx.timerS;
  tracker.lastTotalDamageJ = totalDamageJ;

  if (safeDt > 0) {
    // Underdamped spring-damper (30-180ms physical hit-jolt recovery)
    const stiffness = 175;
    const damping = 19;
    tracker.joltVelPitch += (-stiffness * tracker.joltPitchRad - damping * tracker.joltVelPitch) * safeDt;
    tracker.joltVelYaw += (-stiffness * tracker.joltYawRad - damping * tracker.joltVelYaw) * safeDt;
    tracker.joltVelRoll += (-stiffness * tracker.joltRollRad - damping * tracker.joltVelRoll) * safeDt;

    tracker.joltPitchRad = Math.max(-0.48, Math.min(0.48, tracker.joltPitchRad + tracker.joltVelPitch * safeDt));
    tracker.joltYawRad = Math.max(-0.52, Math.min(0.52, tracker.joltYawRad + tracker.joltVelYaw * safeDt));
    tracker.joltRollRad = Math.max(-0.38, Math.min(0.38, tracker.joltRollRad + tracker.joltVelRoll * safeDt));
  }

  // Downed pelvic/femur upper-body prop-up while returning fire
  const downedReturningFire =
    state.alive &&
    !state.isRagdollActive &&
    !state.weaponDropped &&
    (state.posture === 'LEG_BUCKLED' || !state.leftLegFunctional || !state.rightLegFunctional) &&
    (state.leftArmFunctional || state.rightArmFunctional);
  const targetProp = downedReturningFire ? 1.0 : 0.0;
  tracker.propUpBlend += (targetProp - tracker.propUpBlend) * (1 - Math.exp(-9 * safeDt));
  const propUpPitchRad = tracker.propUpBlend * -0.44; // Lifts chest/head upward from crawl pose

  // Wound-clutching IK evaluation
  let clutchSide: ArmSide | null = null;
  const preferredSupport: ArmSide = state.isLeftHanded ? 'RIGHT' : 'LEFT';
  if (isArmAvailableForClutch(state, preferredSupport)) {
    clutchSide = preferredSupport;
  } else {
    const otherSide: ArmSide = preferredSupport === 'LEFT' ? 'RIGHT' : 'LEFT';
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
      clutchElbowWorld = add(scale(elbowPositionsWorld[clutchSide], 1 - b), scale(solved.elbow, b));
      clutchWristWorld = add(scale(wristPositionsWorld[clutchSide], 1 - b), scale(solved.wrist, b));
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

function updateSegmentBasis(bone: RagdollBoneState, proximal: Vec3Like, distal: Vec3Like, sideSign: number): void {
  const seg = sub(distal, proximal);
  const segLen = length(seg);
  const downAxis = segLen > 1e-4 ? scale(seg, 1 / segLen) : vec3(0, -1, 0);
  const up = scale(downAxis, -1);
  const ref = Math.abs(up.z) < 0.92 ? vec3(0, 0, 1) : vec3(sideSign, 0, 0);
  const right = normalize(cross(up, ref));
  const forward = normalize(cross(right, up));
  Object.assign(bone.basisRight, right);
  Object.assign(bone.basisUp, up);
  Object.assign(bone.basisForward, forward);
}

export function stepPinnedDeadArmVerlet(
  state: TargetHealthState,
  tracker: ProceduralTraumaTrackerState,
  side: ArmSide,
  shoulderPivotWorld: Vec3Like,
  dt: number
): boolean {
  if (!isArmDeadButAttached(state, side)) {
    tracker.deadArmInitialized[side] = false;
    return false;
  }

  const upperBone = state.ragdollBones[`UPPER_ARM_${side}`];
  const forearmBone = state.ragdollBones[`FOREARM_${side}`];
  const handBone = state.ragdollBones[`HAND_${side}`];
  const tipAux = state.auxParticles[`HAND_TIP_${side}`];

  const sideSign = side === 'LEFT' ? -1 : 1;
  const upperLen = 0.27;
  const forearmLen = 0.25;
  const handLen = 0.09;
  const safeDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.033) : 1 / 60;

  if (!tracker.deadArmInitialized[side]) {
    tracker.deadArmInitialized[side] = true;
    Object.assign(tracker.prevShoulderPos[side], shoulderPivotWorld);
    Object.assign(tracker.prevShoulderVel[side], vec3(0, 0, 0));

    Object.assign(upperBone.position, shoulderPivotWorld);
    Object.assign(upperBone.prevPosition, shoulderPivotWorld);
    const elbowInit = add(
      shoulderPivotWorld,
      scale(normalize(vec3(sideSign * 0.04, -upperLen, 0.02)), upperLen)
    );
    const wristInit = add(
      elbowInit,
      scale(normalize(vec3(sideSign * 0.02, -forearmLen, 0.03)), forearmLen)
    );
    const tipInit = add(wristInit, scale(normalize(vec3(0, -handLen, 0.01)), handLen));

    Object.assign(forearmBone.position, elbowInit);
    Object.assign(forearmBone.prevPosition, elbowInit);
    Object.assign(handBone.position, wristInit);
    Object.assign(handBone.prevPosition, wristInit);
    Object.assign(tipAux.position, tipInit);
    Object.assign(tipAux.prevPosition, tipInit);

    const hitDir = state.activeReaction.hitDirectionWorld;
    if (
      state.activeReaction.type !== 'NONE' &&
      state.activeReaction.timerS > 0 &&
      length(hitDir) > 1e-4
    ) {
      const kick = scale(normalize(hitDir), 0.55 * safeDt);
      Object.assign(forearmBone.prevPosition, sub(elbowInit, kick));
      Object.assign(handBone.prevPosition, sub(wristInit, scale(kick, 1.2)));
    }
  }

  const shoulderVel = scale(sub(shoulderPivotWorld, tracker.prevShoulderPos[side]), 1 / safeDt);
  const shoulderAccel = scale(sub(shoulderVel, tracker.prevShoulderVel[side]), 1 / safeDt);
  Object.assign(tracker.prevShoulderPos[side], shoulderPivotWorld);
  Object.assign(tracker.prevShoulderVel[side], shoulderVel);

  const damping = 0.965;
  const gravY = -9.81;
  const inertiaKick = scale(shoulderAccel, -0.012 * safeDt * safeDt);

  const nodes = [forearmBone, handBone, tipAux];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const vx = (n.position.x - n.prevPosition.x) * damping + inertiaKick.x;
    const vy = (n.position.y - n.prevPosition.y) * damping + gravY * safeDt * safeDt + inertiaKick.y;
    const vz = (n.position.z - n.prevPosition.z) * damping + inertiaKick.z;
    Object.assign(n.prevPosition, n.position);
    n.position.x += vx;
    n.position.y = Math.max(0.04, n.position.y + vy);
    n.position.z += vz;
  }

  Object.assign(upperBone.position, shoulderPivotWorld);
  Object.assign(upperBone.prevPosition, shoulderPivotWorld);

  const cosYaw = Math.cos(state.yawRad);
  const sinYaw = Math.sin(state.yawRad);
  const bodyRight = vec3(cosYaw, 0, -sinYaw);
  const torsoCenter = state.ragdollBones.TORSO_LOWER_ABDOMEN.position;

  // 4 PBD constraint & torso-avoidance iterations
  for (let iter = 0; iter < 4; iter++) {
    // Pin upper arm to shoulder
    Object.assign(upperBone.position, shoulderPivotWorld);

    // Upper arm -> elbow
    const d1 = sub(forearmBone.position, upperBone.position);
    const l1 = Math.max(1e-5, length(d1));
    Object.assign(forearmBone.position, add(upperBone.position, scale(d1, upperLen / l1)));

    // Elbow -> wrist
    const d2 = sub(handBone.position, forearmBone.position);
    const l2 = Math.max(1e-5, length(d2));
    const corr2 = scale(d2, ((l2 - forearmLen) / l2) * 0.5);
    Object.assign(forearmBone.position, add(forearmBone.position, corr2));
    Object.assign(handBone.position, sub(handBone.position, corr2));

    // Wrist -> hand tip
    const d3 = sub(tipAux.position, handBone.position);
    const l3 = Math.max(1e-5, length(d3));
    Object.assign(tipAux.position, add(handBone.position, scale(d3, handLen / l3)));

    // Keep elbow & wrist outside lateral torso cylinder so dead arm hangs beside body
    for (const joint of [forearmBone, handBone]) {
      const rel = sub(joint.position, torsoCenter);
      const lat = dot(rel, bodyRight) * sideSign;
      const minOutward = 0.19;
      if (lat < minOutward) {
        joint.position.x += bodyRight.x * sideSign * (minOutward - lat);
        joint.position.z += bodyRight.z * sideSign * (minOutward - lat);
      }
    }
  }

  Object.assign(upperBone.distalPosition, forearmBone.position);
  Object.assign(forearmBone.distalPosition, handBone.position);
  Object.assign(handBone.distalPosition, tipAux.position);

  updateSegmentBasis(upperBone, upperBone.position, forearmBone.position, sideSign);
  updateSegmentBasis(forearmBone, forearmBone.position, handBone.position, sideSign);
  updateSegmentBasis(handBone, handBone.position, tipAux.position, sideSign);

  return true;
}
