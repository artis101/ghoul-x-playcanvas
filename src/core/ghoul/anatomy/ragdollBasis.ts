import { GhoulZoneId } from '../../../contracts/ballistics/ghoulZoneContracts';
import { TargetHealthState } from '../../../contracts/ballistics/targetHealthContracts';
import {
  vec3,
  sub,
  add,
  scale,
  normalize,
  copyVec3,
} from '../../ballistics/vec3';
import {
  safeOrthonormalBasis,
  basisFromRightAndUp,
} from './ragdollBasisMath';
import { computePelvisFrame } from './ragdollBodyFrames';
import { recomputeLimbAndFootBases } from './ragdollLimbBasis';

/**
 * Recomputes exact 3D orthonormal bases (Right, Up, Forward) and distal endpoints for all 22 bones
 * directly from current particle positions so meshes align with zero joint gaps or gimbal lock.
 */
export function recomputeRagdollBasisVectors(target: TargetHealthState): void {
  const cosY = Math.cos(target.yawRad);
  const sinY = Math.sin(target.yawRad);
  const defaultForward = vec3(sinY, 0, cosY);

  // 1. Pelvis Basis
  const pelvis = target.ragdollBones.PELVIS_GROIN;
  const abdomen = target.ragdollBones.TORSO_LOWER_ABDOMEN;

  const pelvisUp =
    abdomen.componentId === pelvis.componentId
      ? sub(abdomen.position, pelvis.position)
      : pelvis.basisUp;
  // A lost leg takes its hip particle with it, so the hip line comes from whatever is left.
  const hipRight = computePelvisFrame(target)?.right ?? pelvis.basisRight;
  const pBasis = basisFromRightAndUp(hipRight, pelvisUp, pelvis.basisForward || defaultForward);
  pelvis.basisRight = pBasis.right;
  pelvis.basisUp = pBasis.up;
  pelvis.basisForward = pBasis.forward;
  pelvis.distalPosition = copyVec3(abdomen.position);

  // 2. Thorax Basis
  const thorax = target.ragdollBones.TORSO_UPPER_THORAX;
  const neck = target.ragdollBones.NECK_CERVICAL;
  const shL = target.ragdollBones.SHOULDER_LEFT;
  const shR = target.ragdollBones.SHOULDER_RIGHT;

  const thoraxUp =
    neck.componentId === thorax.componentId
      ? sub(neck.position, thorax.position)
      : sub(thorax.position, abdomen.position);
  const shRight =
    shL.componentId === thorax.componentId && shR.componentId === thorax.componentId
      ? sub(shL.position, shR.position)
      : pelvis.basisRight;
  const tBasis = basisFromRightAndUp(shRight, thoraxUp, pelvis.basisForward);
  thorax.basisRight = tBasis.right;
  thorax.basisUp = tBasis.up;
  thorax.basisForward = tBasis.forward;
  thorax.distalPosition = copyVec3(neck.position);

  // 3. Abdomen Basis
  const abdUp =
    thorax.componentId === abdomen.componentId
      ? sub(thorax.position, abdomen.position)
      : pelvis.basisUp;
  const abdRightHint = add(pelvis.basisRight, thorax.basisRight);
  const aBasis = basisFromRightAndUp(abdRightHint, abdUp, thorax.basisForward);
  abdomen.basisRight = aBasis.right;
  abdomen.basisUp = aBasis.up;
  abdomen.basisForward = aBasis.forward;
  abdomen.distalPosition = copyVec3(thorax.position);

  // 4. Neck, Cranium & Jaw
  const head = target.ragdollBones.HEAD_CRANIUM;
  const jaw = target.ragdollBones.HEAD_FACE_JAW;
  const headTop = target.auxParticles.HEAD_TOP;

  const neckUp =
    head.componentId === neck.componentId ? sub(head.position, neck.position) : thorax.basisUp;
  const nBasis = safeOrthonormalBasis(neckUp, thorax.basisForward, thorax.basisRight);
  neck.basisRight = nBasis.right;
  neck.basisUp = nBasis.up;
  neck.basisForward = nBasis.forward;
  neck.distalPosition = copyVec3(head.position);

  const headUp =
    headTop.componentId === head.componentId
      ? sub(headTop.position, head.position)
      : neck.basisUp;
  const jawFwdHint =
    jaw.componentId === head.componentId
      ? add(scale(normalize(sub(jaw.position, head.position)), 0.65), scale(thorax.basisForward, 0.35))
      : thorax.basisForward;
  const hBasis = safeOrthonormalBasis(headUp, jawFwdHint, thorax.basisRight);
  head.basisRight = hBasis.right;
  head.basisUp = hBasis.up;
  head.basisForward = hBasis.forward;
  head.distalPosition = copyVec3(headTop.position);

  jaw.basisRight = copyVec3(head.basisRight);
  jaw.basisUp = copyVec3(head.basisUp);
  jaw.basisForward = copyVec3(head.basisForward);
  jaw.distalPosition = copyVec3(head.position);

  // 5. Shoulders
  for (const side of ['RIGHT', 'LEFT'] as const) {
    const shZone: GhoulZoneId = side === 'RIGHT' ? 'SHOULDER_RIGHT' : 'SHOULDER_LEFT';
    const uaZone: GhoulZoneId = side === 'RIGHT' ? 'UPPER_ARM_RIGHT' : 'UPPER_ARM_LEFT';
    const sh = target.ragdollBones[shZone];
    const ua = target.ragdollBones[uaZone];
    sh.basisRight = copyVec3(thorax.basisRight);
    sh.basisUp = copyVec3(thorax.basisUp);
    sh.basisForward = copyVec3(thorax.basisForward);
    sh.distalPosition = copyVec3(ua.position);
  }

  // 6 & 7. Limbs and boots
  recomputeLimbAndFootBases(target);
}
