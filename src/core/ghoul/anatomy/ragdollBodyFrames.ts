import type { TargetHealthState } from '../../../contracts/ballistics/targetHealthContracts';
import { Vec3Like, cross, dot, length, normalize, scale, sub } from '../../ballistics/vec3';

/**
 * Orthonormal body-segment frame in world space, with forward = right × up.
 * `right` is the frame's +X axis: on an upright body it points to the character's own left.
 */
export interface BodyFrame {
  right: Vec3Like;
  up: Vec3Like;
  forward: Vec3Like;
}

function frameFrom(rightHint: Vec3Like, upDir: Vec3Like): BodyFrame | null {
  const up = normalize(upDir);
  const forwardRaw = cross(rightHint, up);
  if (length(up) < 0.5 || length(forwardRaw) < 1e-4) return null;
  const forward = normalize(forwardRaw);
  return { right: normalize(cross(up, forward)), up, forward };
}

/** Removes the part of `v` that lies along the unit vector `axis`. */
export function rejectFromAxis(v: Vec3Like, axis: Vec3Like): Vec3Like {
  return sub(v, scale(axis, dot(v, axis)));
}

/** Ribcage frame from the shoulder line and the thorax-to-neck spine segment. */
export function computeChestFrame(target: TargetHealthState): BodyFrame | null {
  const bones = target.ragdollBones;
  const thorax = bones.TORSO_UPPER_THORAX;
  const neck = bones.NECK_CERVICAL;
  const up =
    neck.componentId === thorax.componentId
      ? sub(neck.position, thorax.position)
      : sub(thorax.position, bones.TORSO_LOWER_ABDOMEN.position);
  return frameFrom(sub(bones.SHOULDER_LEFT.position, bones.SHOULDER_RIGHT.position), up);
}

/**
 * Pelvic frame from the hip line and the pelvis-to-abdomen spine segment. A pelvis that has lost
 * one leg keeps its orientation from the remaining hip; with both gone it follows the ribcage.
 */
export function computePelvisFrame(target: TargetHealthState): BodyFrame | null {
  const bones = target.ragdollBones;
  const pelvis = bones.PELVIS_GROIN;
  const abdomen = bones.TORSO_LOWER_ABDOMEN;
  const up =
    abdomen.componentId === pelvis.componentId
      ? normalize(sub(abdomen.position, pelvis.position))
      : normalize(pelvis.basisUp);
  const hasRight = bones.THIGH_RIGHT.componentId === pelvis.componentId;
  const hasLeft = bones.THIGH_LEFT.componentId === pelvis.componentId;

  let rightHint: Vec3Like;
  if (hasRight && hasLeft) {
    rightHint = sub(bones.THIGH_LEFT.position, bones.THIGH_RIGHT.position);
  } else if (hasLeft) {
    rightHint = rejectFromAxis(sub(bones.THIGH_LEFT.position, pelvis.position), up);
  } else if (hasRight) {
    rightHint = rejectFromAxis(sub(pelvis.position, bones.THIGH_RIGHT.position), up);
  } else {
    rightHint = computeChestFrame(target)?.right ?? pelvis.basisRight;
  }
  return frameFrom(rightHint, up);
}
