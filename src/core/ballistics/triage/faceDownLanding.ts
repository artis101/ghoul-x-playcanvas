import type { TargetHealthState, Vec3Like } from '../../../contracts/ballistics.ts';
import { computeChestFrame } from '../../ghoul/anatomy/ragdollBodyFrames.ts';
import { normalize, vec3 } from '../vec3.ts';
import { FACE_DOWN_BELOW, MIN_LYING_SPAN_M } from './downedAimReach.ts';

/** Above this the pelvis is not resting on the floor, so the body has not landed yet. */
export const PELVIS_ON_FLOOR_M = 0.44;
/** A flattened facing shorter than this points mostly up or down and says nothing about heading. */
const MIN_FLAT_FACING = 0.3;

/**
 * True when the body lies stretched out with its chest turned to the floor: the PRONE shape of
 * the downed pose. A body that sits up, or lies on its back, is not face down. Floor height is not
 * checked here; see `isFaceDownLanding`.
 */
export function isFaceDownShape(hs: TargetHealthState): boolean {
  const bones = hs.ragdollBones;
  const pelvis = bones.PELVIS_GROIN.position;
  const thorax = bones.TORSO_UPPER_THORAX.position;
  if (Math.hypot(thorax.x - pelvis.x, thorax.z - pelvis.z) <= MIN_LYING_SPAN_M) return false;
  const chest = computeChestFrame(hs);
  return chest !== null && chest.forward.y < FACE_DOWN_BELOW;
}

/**
 * True when a living ragdoll has come down on its face: its pelvis rests on the floor and its
 * chest points into it. Such a body gets the face-down pose and, in the wounded sequence, never
 * draws or fires again (docs/wound-movement.md, FACE_DOWN).
 */
export function isFaceDownLanding(hs: TargetHealthState, floorY: number): boolean {
  if (!hs.alive || !hs.isRagdollActive) return false;
  const pelvis = hs.ragdollBones.PELVIS_GROIN;
  if (pelvis.componentId !== 'BODY' || pelvis.position.y > floorY + PELVIS_ON_FLOOR_M) return false;
  return isFaceDownShape(hs);
}

/** How long the face-down shape must hold, at rest, before the body is face down for good. */
export const FACE_DOWN_SETTLE_S = 0.5;
/** Pelvis and chest slower than this: the ragdoll has stopped tumbling and the shape is real. */
const SETTLED_SPEED_MS = 0.5;

function boneSpeed(hs: TargetHealthState, zone: 'PELVIS_GROIN' | 'TORSO_UPPER_THORAX'): number {
  const v = hs.ragdollBones[zone].velocity;
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * Times a face-down landing and commits FACE_DOWN once it has held still for the settle window.
 * A body that only tips forward for a moment while it settles is not locked face down; but while
 * the shape is showing (`faceDownSettleS` set) it may not draw or fire. Returns true when the body
 * is FACE_DOWN. Only the lifecycle calls this, once per frame, so the clock runs at game speed.
 */
export function stepFaceDownSettle(hs: TargetHealthState, dt: number, floorY: number): boolean {
  if (hs.woundedPhase === 'FACE_DOWN') return true;
  if (hs.posture !== 'RAGDOLL_GROUNDED' || !isFaceDownLanding(hs, floorY)) {
    hs.faceDownSettleS = undefined;
    return false;
  }
  const still =
    boneSpeed(hs, 'PELVIS_GROIN') < SETTLED_SPEED_MS && boneSpeed(hs, 'TORSO_UPPER_THORAX') < SETTLED_SPEED_MS;
  hs.faceDownSettleS = (hs.faceDownSettleS ?? 0) + (still ? dt : 0);
  if (hs.faceDownSettleS < FACE_DOWN_SETTLE_S) return false;
  hs.woundedPhase = 'FACE_DOWN';
  hs.woundedPhaseTimerS = 0;
  return true;
}

/** True while the face-down shape is showing but not yet settled. */
export function isFaceDownPending(hs: TargetHealthState): boolean {
  return hs.faceDownSettleS !== undefined && hs.woundedPhase !== 'FACE_DOWN';
}

/**
 * Which way a body on the floor faces, flat on the ground: where its chest points when it sits
 * up, toward its feet when it lies on its back, and the way it stood when neither can be read.
 * The downed fire cone is measured from this.
 */
export function resolveDownedFacing(hs: TargetHealthState): Vec3Like {
  const chest = computeChestFrame(hs);
  if (chest) {
    const flat = Math.hypot(chest.forward.x, chest.forward.z);
    if (flat > MIN_FLAT_FACING) return vec3(chest.forward.x / flat, 0, chest.forward.z / flat);
  }
  const pelvis = hs.ragdollBones.PELVIS_GROIN.position;
  const thorax = hs.ragdollBones.TORSO_UPPER_THORAX.position;
  const toFeet = vec3(pelvis.x - thorax.x, 0, pelvis.z - thorax.z);
  if (Math.hypot(toFeet.x, toFeet.z) > MIN_LYING_SPAN_M) return normalize(toFeet);
  return yawForward(hs);
}

/** The flat direction the body faced while standing. */
export function yawForward(hs: TargetHealthState): Vec3Like {
  return vec3(Math.sin(hs.yawRad), 0, Math.cos(hs.yawRad));
}
