import type { TargetHealthState, Vec3Like } from '../../../contracts/ballistics.ts';
import { computeChestFrame } from '../../ghoul/anatomy/ragdollBodyFrames.ts';
import { add, cross, dot, length, normalize, scale, sub, vec3 } from '../vec3.ts';

const DEG = Math.PI / 180;
/** A chest turned this far toward the floor counts as lying face down. */
export const FACE_DOWN_BELOW = -0.25;
// On its back a body can point a handgun anywhere from down past its feet to about straight up, but
// never back over its own head. On its front it can only point ahead of its head.
const FACE_UP_HALF_ANGLE_RAD = 68 * DEG;
const FACE_DOWN_HALF_ANGLE_RAD = 65 * DEG;
// How steeply the face-up cone's centre line rises from the floor, pointing past the feet.
const FACE_UP_AXIS_RISE_RAD = 35 * DEG;
/** Below this pelvis-to-chest ground distance the body is sitting up rather than lying. */
export const MIN_LYING_SPAN_M = 0.12;

/** The cone of directions a body on the ground can point a weapon into. */
export interface DownedAimReach {
  readonly axis: Vec3Like;
  readonly halfAngleRad: number;
}

/**
 * Where a living body lying on the ground can aim, or null when its chest cannot be read.
 * The cone is laid along the spine's line on the floor, not the shoulders: the gun arm tugs the
 * shoulders about as it aims, and the limit must not follow it round.
 */
export function computeDownedAimReach(target: TargetHealthState): DownedAimReach | null {
  const chest = computeChestFrame(target);
  if (!chest) return null;
  const bones = target.ragdollBones;
  const lie = sub(bones.TORSO_UPPER_THORAX.position, bones.PELVIS_GROIN.position);
  const lieSpan = Math.hypot(lie.x, lie.z);
  if (lieSpan < MIN_LYING_SPAN_M) {
    // Sitting up: it can cover what its chest faces.
    return { axis: chest.forward, halfAngleRad: FACE_UP_HALF_ANGLE_RAD };
  }
  const headward = vec3(lie.x / lieSpan, 0, lie.z / lieSpan);
  if (chest.forward.y < FACE_DOWN_BELOW) {
    return { axis: normalize(add(headward, vec3(0, 0.4, 0))), halfAngleRad: FACE_DOWN_HALF_ANGLE_RAD };
  }
  // Up and toward the feet: the arm swings down along the body far more easily than up.
  return {
    axis: normalize(add(scale(headward, -Math.cos(FACE_UP_AXIS_RISE_RAD)), vec3(0, Math.sin(FACE_UP_AXIS_RISE_RAD), 0))),
    halfAngleRad: FACE_UP_HALF_ANGLE_RAD,
  };
}

/** True when a body on the ground can bring its weapon to bear on the point. */
export function canDownedBodyAimAt(target: TargetHealthState, point: Vec3Like): boolean {
  const reach = computeDownedAimReach(target);
  if (!reach) return true;
  const toPoint = normalize(sub(point, target.ragdollBones.TORSO_UPPER_THORAX.position));
  return dot(toPoint, reach.axis) >= Math.cos(reach.halfAngleRad);
}

/** Turns an aim direction to the nearest one the body can actually reach. */
export function clampDownedAimDirection(target: TargetHealthState, direction: Vec3Like): Vec3Like {
  const reach = computeDownedAimReach(target);
  const wanted = normalize(direction);
  if (!reach || dot(wanted, reach.axis) >= Math.cos(reach.halfAngleRad)) return wanted;
  // Swing from the cone's axis toward the wanted direction, stopping at the cone's edge.
  let side = sub(wanted, scale(reach.axis, dot(wanted, reach.axis)));
  if (length(side) < 1e-4) side = cross(reach.axis, Math.abs(reach.axis.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0));
  return normalize(
    add(scale(reach.axis, Math.cos(reach.halfAngleRad)), scale(normalize(side), Math.sin(reach.halfAngleRad)))
  );
}
