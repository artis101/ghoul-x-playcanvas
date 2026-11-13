import type { TargetHealthState, Vec3Like } from '../../../contracts/ballistics.ts';
import { sideSignX } from '../../ghoul/anatomy/handedness.ts';
import { computeChestFrame } from '../../ghoul/anatomy/ragdollBodyFrames.ts';
import { add, cross, dot, normalize, scale, sub, vec3 } from '../vec3.ts';
import { isAimClearOfChest } from './downedChestClearance.ts';
import { resolveDownedGunSide } from './downedGunSide.ts';

const DEG = Math.PI / 180;
/** A chest turned this far toward the floor counts as lying face down. */
export const FACE_DOWN_BELOW = -0.25;
// The pistol is held out at the end of a straight arm, which swings from the shoulder only so
// far. On its back a body covers what lies past its feet, from the floor up to about straight up,
// but never back over its own head. On its front it can only point ahead of its head.
const FACE_UP_HALF_ANGLE_RAD = 60 * DEG;
const FACE_DOWN_HALF_ANGLE_RAD = 58 * DEG;
// How steeply the face-up cone's centre line rises from the floor, pointing past the feet.
const FACE_UP_AXIS_RISE_RAD = 28 * DEG;
// A straight arm reaches out past its own side more easily than across the chest.
const GUN_SIDE_BIAS_RAD = 14 * DEG;
/** Below this pelvis-to-chest ground distance the body is sitting up rather than lying. */
export const MIN_LYING_SPAN_M = 0.12;

/** The cone of directions a body on the ground can point a weapon into. */
export interface DownedAimReach {
  /** Where the cone starts: the gun arm's shoulder, or the chest with no arm to hold a gun. */
  readonly origin: Vec3Like;
  readonly axis: Vec3Like;
  readonly halfAngleRad: number;
}

/**
 * Where a living body lying on the ground can aim, or null when its chest cannot be read.
 * The cone is laid along the spine's line on the floor, not the shoulders: the gun arm tugs the
 * shoulders about as it aims, and the limit must not follow it round. It starts at the extended
 * arm's shoulder and leans a little out toward that arm's side.
 */
export function computeDownedAimReach(target: TargetHealthState): DownedAimReach | null {
  const chest = computeChestFrame(target);
  if (!chest) return null;
  const bones = target.ragdollBones;
  const gunSide = resolveDownedGunSide(target);
  const origin = gunSide ? bones[`SHOULDER_${gunSide}`].position : bones.TORSO_UPPER_THORAX.position;
  const lie = sub(bones.TORSO_UPPER_THORAX.position, bones.PELVIS_GROIN.position);
  const lieSpan = Math.hypot(lie.x, lie.z);
  if (lieSpan < MIN_LYING_SPAN_M) {
    // Sitting up: it can cover what its chest faces.
    return { origin, axis: chest.forward, halfAngleRad: FACE_UP_HALF_ANGLE_RAD };
  }
  const up = vec3(0, 1, 0);
  const headward = vec3(lie.x / lieSpan, 0, lie.z / lieSpan);
  const faceDown = chest.forward.y < FACE_DOWN_BELOW;
  // The body's own left on the floor, read from the spine and which way it faces.
  const leftward = scale(cross(headward, up), faceDown ? -1 : 1);
  const lean = (ahead: Vec3Like): Vec3Like =>
    gunSide
      ? normalize(add(scale(ahead, Math.cos(GUN_SIDE_BIAS_RAD)), scale(leftward, sideSignX(gunSide) * Math.sin(GUN_SIDE_BIAS_RAD))))
      : ahead;
  if (faceDown) {
    return { origin, axis: normalize(add(lean(headward), vec3(0, 0.4, 0))), halfAngleRad: FACE_DOWN_HALF_ANGLE_RAD };
  }
  // Up and toward the feet: the arm swings down along the body far more easily than up.
  const feetward = lean(scale(headward, -1));
  return {
    origin,
    axis: normalize(add(scale(feetward, Math.cos(FACE_UP_AXIS_RISE_RAD)), scale(up, Math.sin(FACE_UP_AXIS_RISE_RAD)))),
    halfAngleRad: FACE_UP_HALF_ANGLE_RAD,
  };
}

/** True when a body on the ground can bring its weapon to bear on the point. */
export function canDownedBodyAimAt(target: TargetHealthState, point: Vec3Like): boolean {
  const reach = computeDownedAimReach(target);
  if (!reach) return true;
  const toPoint = normalize(sub(point, reach.origin));
  return dot(toPoint, reach.axis) >= Math.cos(reach.halfAngleRad) && isAimClearOfChest(target, toPoint);
}
