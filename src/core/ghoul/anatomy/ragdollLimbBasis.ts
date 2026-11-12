import { GhoulZoneId } from '../../../contracts/ballistics/ghoulZoneContracts';
import {
  AuxParticleId,
  TargetHealthState,
} from '../../../contracts/ballistics/targetHealthContracts';
import {
  Vec3Like,
  add,
  vec3,
  sub,
  scale,
  normalize,
  cross,
  dot,
  length,
  copyVec3,
  distance,
} from '../../ballistics/vec3';
import { getRestLocalPosition } from './ragdollConstraints';
import {
  safeOrthonormalBasis,
  getParticlePos,
  getParticleComp,
} from './ragdollBasisMath';

/**
 * Recomputes orthonormal bases for upper/lower limbs and combat boots,
 * using joint hinge-plane hints so horizontal ragdoll limbs never candy-wrapper twist.
 */
export function recomputeLimbAndFootBases(target: TargetHealthState): void {
  const limbPairs: Array<{
    zone: GhoulZoneId;
    distal: GhoulZoneId | AuxParticleId;
    nextDistal?: GhoulZoneId | AuxParticleId;
    refZone: GhoulZoneId;
    isArm: boolean;
  }> = [
    { zone: 'UPPER_ARM_RIGHT', distal: 'FOREARM_RIGHT', nextDistal: 'HAND_RIGHT', refZone: 'TORSO_UPPER_THORAX', isArm: true },
    { zone: 'FOREARM_RIGHT', distal: 'HAND_RIGHT', nextDistal: 'HAND_TIP_RIGHT', refZone: 'UPPER_ARM_RIGHT', isArm: true },
    { zone: 'HAND_RIGHT', distal: 'HAND_TIP_RIGHT', refZone: 'FOREARM_RIGHT', isArm: true },
    { zone: 'UPPER_ARM_LEFT', distal: 'FOREARM_LEFT', nextDistal: 'HAND_LEFT', refZone: 'TORSO_UPPER_THORAX', isArm: true },
    { zone: 'FOREARM_LEFT', distal: 'HAND_LEFT', nextDistal: 'HAND_TIP_LEFT', refZone: 'UPPER_ARM_LEFT', isArm: true },
    { zone: 'HAND_LEFT', distal: 'HAND_TIP_LEFT', refZone: 'FOREARM_LEFT', isArm: true },
    { zone: 'THIGH_RIGHT', distal: 'KNEE_RIGHT', nextDistal: 'SHIN_RIGHT', refZone: 'PELVIS_GROIN', isArm: false },
    { zone: 'KNEE_RIGHT', distal: 'SHIN_RIGHT', nextDistal: 'FOOT_RIGHT', refZone: 'THIGH_RIGHT', isArm: false },
    { zone: 'SHIN_RIGHT', distal: 'FOOT_RIGHT', refZone: 'KNEE_RIGHT', isArm: false },
    { zone: 'THIGH_LEFT', distal: 'KNEE_LEFT', nextDistal: 'SHIN_LEFT', refZone: 'PELVIS_GROIN', isArm: false },
    { zone: 'KNEE_LEFT', distal: 'SHIN_LEFT', nextDistal: 'FOOT_LEFT', refZone: 'THIGH_LEFT', isArm: false },
    { zone: 'SHIN_LEFT', distal: 'FOOT_LEFT', refZone: 'KNEE_LEFT', isArm: false },
  ];

  for (const item of limbPairs) {
    const bone = target.ragdollBones[item.zone];
    const refBone = target.ragdollBones[item.refZone];
    const distalComp = getParticleComp(target, item.distal);
    const distalPos = getParticlePos(target, item.distal);

    let segUp: Vec3Like;
    if (distalComp === bone.componentId) {
      segUp = sub(bone.position, distalPos);
      bone.distalPosition = copyVec3(distalPos);
    } else {
      segUp = refBone.basisUp;
      const defaultLen = distance(
        getRestLocalPosition(item.zone),
        getRestLocalPosition(item.distal)
      );
      bone.distalPosition = sub(bone.position, scale(normalize(segUp), defaultLen));
    }

    // Stabilize twist when a limb lies nearly parallel to parent basisForward by blending
    // the parent forward/right with the anatomical hinge plane at the elbow/knee.
    let fwdHint = refBone.basisForward;
    let rightHint = refBone.basisRight;
    const normUp = normalize(segUp);
    if (Math.abs(dot(normUp, fwdHint)) > 0.82) {
      fwdHint = normalize(add(scale(fwdHint, 0.45), scale(refBone.basisUp, item.isArm ? 0.55 : -0.55)));
    }
    if (item.nextDistal && getParticleComp(target, item.nextDistal) === bone.componentId) {
      const nextPos = getParticlePos(target, item.nextDistal);
      const childVec = normalize(sub(distalPos, nextPos));
      const bendAxis = cross(normUp, childVec);
      const bendLen = length(bendAxis);
      if (bendLen > 0.18) {
        const alignedRight = dot(bendAxis, rightHint) >= 0 ? scale(bendAxis, 1 / bendLen) : scale(bendAxis, -1 / bendLen);
        rightHint = normalize(add(scale(rightHint, 0.65), scale(alignedRight, 0.35)));
      }
    }

    const lBasis = safeOrthonormalBasis(segUp, fwdHint, rightHint);
    bone.basisRight = lBasis.right;
    bone.basisUp = lBasis.up;
    bone.basisForward = lBasis.forward;
  }

  for (const side of ['RIGHT', 'LEFT'] as const) {
    const footZone: GhoulZoneId = side === 'RIGHT' ? 'FOOT_RIGHT' : 'FOOT_LEFT';
    const shinZone: GhoulZoneId = side === 'RIGHT' ? 'SHIN_RIGHT' : 'SHIN_LEFT';
    const toeId: AuxParticleId = side === 'RIGHT' ? 'FOOT_TOE_RIGHT' : 'FOOT_TOE_LEFT';

    const foot = target.ragdollBones[footZone];
    const shin = target.ragdollBones[shinZone];
    const toe = target.auxParticles[toeId];

    let fwd = sub(toe.position, foot.position);
    if (length(fwd) < 1e-4) fwd = shin.basisForward;
    fwd = normalize(fwd);

    // Blend shin up and shin right to prevent 180-degree boot ankle flips when horizontal
    const upHint =
      shin.componentId === foot.componentId
        ? normalize(add(scale(shin.basisUp, 0.75), scale(shin.basisForward, 0.25)))
        : vec3(0, 1, 0);
    let right = cross(upHint, fwd);
    if (length(right) < 0.15 || dot(right, shin.basisRight) < 0) {
      right = shin.basisRight;
    }
    right = normalize(right);
    const up = normalize(cross(fwd, right));

    foot.basisRight = right;
    foot.basisUp = up;
    foot.basisForward = fwd;
    foot.distalPosition = copyVec3(toe.position);
  }
}
