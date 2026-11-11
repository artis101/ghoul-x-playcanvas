import { GhoulZoneId } from '../../../contracts/ballistics/ghoulZoneContracts';
import {
  AuxParticleId,
  TargetHealthState,
} from '../../../contracts/ballistics/targetHealthContracts';
import {
  Vec3Like,
  vec3,
  sub,
  scale,
  normalize,
  cross,
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
 * Recomputes orthonormal bases for upper/lower limbs and combat boots.
 */
export function recomputeLimbAndFootBases(target: TargetHealthState): void {
  const limbPairs: Array<{
    zone: GhoulZoneId;
    distal: GhoulZoneId | AuxParticleId;
    refZone: GhoulZoneId;
  }> = [
    { zone: 'UPPER_ARM_LEFT', distal: 'FOREARM_LEFT', refZone: 'TORSO_UPPER_THORAX' },
    { zone: 'FOREARM_LEFT', distal: 'HAND_LEFT', refZone: 'UPPER_ARM_LEFT' },
    { zone: 'HAND_LEFT', distal: 'HAND_TIP_LEFT', refZone: 'FOREARM_LEFT' },
    { zone: 'UPPER_ARM_RIGHT', distal: 'FOREARM_RIGHT', refZone: 'TORSO_UPPER_THORAX' },
    { zone: 'FOREARM_RIGHT', distal: 'HAND_RIGHT', refZone: 'UPPER_ARM_RIGHT' },
    { zone: 'HAND_RIGHT', distal: 'HAND_TIP_RIGHT', refZone: 'FOREARM_RIGHT' },
    { zone: 'THIGH_LEFT', distal: 'KNEE_LEFT', refZone: 'PELVIS_GROIN' },
    { zone: 'KNEE_LEFT', distal: 'SHIN_LEFT', refZone: 'THIGH_LEFT' },
    { zone: 'SHIN_LEFT', distal: 'FOOT_LEFT', refZone: 'KNEE_LEFT' },
    { zone: 'THIGH_RIGHT', distal: 'KNEE_RIGHT', refZone: 'PELVIS_GROIN' },
    { zone: 'KNEE_RIGHT', distal: 'SHIN_RIGHT', refZone: 'THIGH_RIGHT' },
    { zone: 'SHIN_RIGHT', distal: 'FOOT_RIGHT', refZone: 'KNEE_RIGHT' },
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

    const lBasis = safeOrthonormalBasis(segUp, refBone.basisForward, refBone.basisRight);
    bone.basisRight = lBasis.right;
    bone.basisUp = lBasis.up;
    bone.basisForward = lBasis.forward;
  }

  for (const side of ['LEFT', 'RIGHT'] as const) {
    const footZone: GhoulZoneId = side === 'LEFT' ? 'FOOT_LEFT' : 'FOOT_RIGHT';
    const shinZone: GhoulZoneId = side === 'LEFT' ? 'SHIN_LEFT' : 'SHIN_RIGHT';
    const toeId: AuxParticleId = side === 'LEFT' ? 'FOOT_TOE_LEFT' : 'FOOT_TOE_RIGHT';

    const foot = target.ragdollBones[footZone];
    const shin = target.ragdollBones[shinZone];
    const toe = target.auxParticles[toeId];

    let fwd = sub(toe.position, foot.position);
    if (length(fwd) < 1e-4) fwd = shin.basisForward;
    fwd = normalize(fwd);

    const upHint = shin.componentId === foot.componentId ? shin.basisUp : vec3(0, 1, 0);
    let right = cross(upHint, fwd);
    if (length(right) < 1e-4) right = shin.basisRight;
    right = normalize(right);
    const up = normalize(cross(fwd, right));

    foot.basisRight = right;
    foot.basisUp = up;
    foot.basisForward = fwd;
    foot.distalPosition = copyVec3(toe.position);
  }
}
