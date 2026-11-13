import type { BodySide } from './handedness.ts';
import type {
  GhoulZoneId,
  RagdollBoneState,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import {
  add,
  copyVec3,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from '../../ballistics/vec3.ts';

export type ArmSide = BodySide;

/**
 * Explicit discriminated union for per-arm pinned dead-limb Verlet simulation state.
 */
export type DeadArmSimState =
  | { readonly kind: 'INACTIVE' }
  | {
      readonly kind: 'PINNED_VERLET';
      prevShoulderPos: Vec3Like;
      prevShoulderVel: Vec3Like;
    };

export interface DeadArmTrackerSlice {
  deadArmState: Record<ArmSide, DeadArmSimState>;
}

/**
 * True when an arm still hangs from the shoulder but no longer works, so it swings as a pendulum.
 * A hand or forearm cut off below an intact upper arm is a stump, not a dead arm: the stump is
 * still moved by its muscles, so it follows the body clip (recoil, clutch to the chest). Pass
 * `distalStumpAnimated = false` while the GLB has no stump clips, and the stump hangs as before.
 */
export function isArmDeadButAttached(state: TargetHealthState, side: ArmSide, distalStumpAnimated = true): boolean {
  if (!state.alive || state.isRagdollActive) return false;
  const functional = side === 'RIGHT' ? state.rightArmFunctional : state.leftArmFunctional;
  if (functional) return false;
  const upperZone: GhoulZoneId = `UPPER_ARM_${side}`;
  const shoulderZone: GhoulZoneId = `SHOULDER_${side}`;
  if (state.severedZones.has(upperZone) || state.severedZones.has(shoulderZone)) {
    return false;
  }
  if (distalStumpAnimated && isDistalArmStump(state, side)) return false;
  const upperBone = state.ragdollBones[upperZone];
  return (
    upperBone.attachmentState === 'ATTACHED' && upperBone.componentId === 'BODY'
  );
}

/** Hand or forearm gone with the upper arm still attached. */
export function isDistalArmStump(state: Pick<TargetHealthState, 'severedZones'>, side: ArmSide): boolean {
  return (
    !state.severedZones.has(`UPPER_ARM_${side}`) &&
    !state.severedZones.has(`SHOULDER_${side}`) &&
    (state.severedZones.has(`HAND_${side}`) || state.severedZones.has(`FOREARM_${side}`))
  );
}

function updateSegmentBasis(
  bone: RagdollBoneState,
  proximal: Vec3Like,
  distal: Vec3Like,
  sideSign: number
): void {
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
  tracker: DeadArmTrackerSlice,
  side: ArmSide,
  shoulderPivotWorld: Vec3Like,
  dt: number,
  distalStumpAnimated = true
): boolean {
  if (!isArmDeadButAttached(state, side, distalStumpAnimated)) {
    if (tracker.deadArmState[side].kind !== 'INACTIVE') {
      tracker.deadArmState[side] = { kind: 'INACTIVE' };
    }
    return false;
  }

  const upperBone = state.ragdollBones[`UPPER_ARM_${side}`];
  const forearmBone = state.ragdollBones[`FOREARM_${side}`];
  const handBone = state.ragdollBones[`HAND_${side}`];
  const tipAux = state.auxParticles[`HAND_TIP_${side}`];

  const sideSign = side === 'RIGHT' ? -1 : 1;
  const upperLen = 0.27;
  const forearmLen = 0.25;
  const handLen = 0.09;
  const safeDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.033) : 1 / 60;

  let simState = tracker.deadArmState[side];
  if (simState.kind === 'INACTIVE') {
    simState = {
      kind: 'PINNED_VERLET',
      prevShoulderPos: copyVec3(shoulderPivotWorld),
      prevShoulderVel: vec3(0, 0, 0),
    };
    tracker.deadArmState[side] = simState;

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
      state.activeReaction.timerS >= 0 &&
      length(hitDir) > 1e-4
    ) {
      const kick = scale(normalize(hitDir), 0.55 * safeDt);
      Object.assign(forearmBone.prevPosition, sub(elbowInit, kick));
      Object.assign(handBone.prevPosition, sub(wristInit, scale(kick, 1.2)));
    }
  }

  const shoulderVel = scale(sub(shoulderPivotWorld, simState.prevShoulderPos), 1 / safeDt);
  const shoulderAccel = scale(sub(shoulderVel, simState.prevShoulderVel), 1 / safeDt);
  Object.assign(simState.prevShoulderPos, shoulderPivotWorld);
  Object.assign(simState.prevShoulderVel, shoulderVel);

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
  const bodyLeft = vec3(cosYaw, 0, -sinYaw);
  const torsoCenter = state.ragdollBones.TORSO_LOWER_ABDOMEN.position;

  // 4 PBD constraint & torso-avoidance iterations
  for (let iter = 0; iter < 4; iter++) {
    Object.assign(upperBone.position, shoulderPivotWorld);

    const d1 = sub(forearmBone.position, upperBone.position);
    const l1 = Math.max(1e-5, length(d1));
    Object.assign(forearmBone.position, add(upperBone.position, scale(d1, upperLen / l1)));

    const d2 = sub(handBone.position, forearmBone.position);
    const l2 = Math.max(1e-5, length(d2));
    const corr2 = scale(d2, ((l2 - forearmLen) / l2) * 0.5);
    Object.assign(forearmBone.position, add(forearmBone.position, corr2));
    Object.assign(handBone.position, sub(handBone.position, corr2));

    const d3 = sub(tipAux.position, handBone.position);
    const l3 = Math.max(1e-5, length(d3));
    Object.assign(tipAux.position, add(handBone.position, scale(d3, handLen / l3)));

    for (const joint of [forearmBone, handBone]) {
      const rel = sub(joint.position, torsoCenter);
      const lat = dot(rel, bodyLeft) * sideSign;
      const minOutward = 0.19;
      if (lat < minOutward) {
        joint.position.x += bodyLeft.x * sideSign * (minOutward - lat);
        joint.position.z += bodyLeft.z * sideSign * (minOutward - lat);
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
