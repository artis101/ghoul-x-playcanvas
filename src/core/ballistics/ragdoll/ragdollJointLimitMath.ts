import { Vec3Like, type MutableVec3, add, cross, dot, length, normalize, scale, scaleInto, sub, subInto } from '../vec3.ts';

export const DEG = Math.PI / 180;

/** The slice of a ragdoll particle that joint limits read and move. */
export interface LimitParticle {
  position: Vec3Like;
  velocity: Vec3Like;
  massKg: number;
}

/**
 * How far a segment may swing away from its rest axis, in radians, toward each side of the
 * joint. Between the four directions the limit follows an ellipse, as a ball joint's does.
 */
export interface SwingLimits {
  forward: number;
  back: number;
  outward: number;
  inward: number;
}

// How fast a joint found outside its range is brought back: the error closes at this rate,
// up to a top speed, so even a badly folded limb eases back instead of snapping.
const RECOVERY_RATE_PER_S = 14;
const MAX_RECOVERY_SPEED_MS = 2.2;

const PUSH_DIR: MutableVec3 = { x: 0, y: 0, z: 0 };
const SEGMENT: MutableVec3 = { x: 0, y: 0, z: 0 };
const SEGMENT_ERROR: MutableVec3 = { x: 0, y: 0, z: 0 };
const RELATIVE_VELOCITY: MutableVec3 = { x: 0, y: 0, z: 0 };

/** How strongly limits act this pass. */
export interface LimitEffort {
  /** 0 to 1 share of the recovery speed to aim for; at 0 a limit only stops further travel. */
  recovery: number;
  /**
   * Most speed one pass may add toward recovery. It makes the limit a muscle-strength force
   * rather than a motor: enough to swing a limb back against gravity, never enough to lift
   * the body off a joint the floor is holding out of range.
   */
  maxKickMs: number;
}

/**
 * The push that keeps a joint in range, given `error`: the displacement that would bring the
 * particle back inside. Motion further out of range is stopped dead, as by an inelastic stop.
 * Motion back toward range is then topped up toward the recovery speed, a little each pass.
 * The push direction is written to PUSH_DIR; returns the push speed, or 0 when no push is needed.
 */
function requiredPush(relativeVelocity: Vec3Like, error: Vec3Like, effort: LimitEffort): number {
  const size = length(error);
  if (size < 1e-5) return 0;
  scaleInto(PUSH_DIR, error, 1 / size);
  const returning = dot(relativeVelocity, PUSH_DIR);
  const stop = Math.max(0, -returning);
  const wanted = Math.min(size * RECOVERY_RATE_PER_S, MAX_RECOVERY_SPEED_MS) * effort.recovery;
  const kick = Math.min(Math.max(0, wanted - Math.max(0, returning)), effort.maxKickMs);
  const speed = stop + kick;
  return speed > 0 ? speed : 0;
}

export function driveParticleBy(p: LimitParticle, error: Vec3Like, effort: LimitEffort): void {
  const speed = requiredPush(p.velocity, error, effort);
  if (speed === 0) return;
  p.velocity.x += PUSH_DIR.x * speed;
  p.velocity.y += PUSH_DIR.y * speed;
  p.velocity.z += PUSH_DIR.z * speed;
}

/**
 * Clamps the unit direction `dir` into the swing cone around `axis`. `side` and `forward` must
 * be unit vectors perpendicular to `axis`. Returns null when `dir` is already inside the cone.
 */
export function clampSwingDirection(
  dir: Vec3Like,
  axis: Vec3Like,
  side: Vec3Like,
  forward: Vec3Like,
  limits: SwingLimits
): Vec3Like | null {
  const along = Math.max(-1, Math.min(1, dot(dir, axis)));
  const x = dot(dir, side);
  const z = dot(dir, forward);
  const planar = Math.hypot(x, z);
  const cx = planar > 1e-6 ? x / planar : 0;
  const cz = planar > 1e-6 ? z / planar : 1;
  const limitX = cx >= 0 ? limits.outward : limits.inward;
  const limitZ = cz >= 0 ? limits.forward : limits.back;
  const maxSwing = 1 / Math.sqrt((cx / limitX) ** 2 + (cz / limitZ) ** 2);
  if (Math.acos(along) <= maxSwing) return null;
  const planarDir = add(scale(side, cx), scale(forward, cz));
  return add(scale(axis, Math.cos(maxSwing)), scale(planarDir, Math.sin(maxSwing)));
}

/** Clamps `dir` to within `maxAngleRad` of `axis`, or returns null when it already is. */
export function clampConeDirection(dir: Vec3Like, axis: Vec3Like, maxAngleRad: number): Vec3Like | null {
  const along = Math.max(-1, Math.min(1, dot(dir, axis)));
  if (Math.acos(along) <= maxAngleRad) return null;
  const planar = sub(dir, scale(axis, along));
  if (length(planar) < 1e-6) return null;
  return add(scale(axis, Math.cos(maxAngleRad)), scale(normalize(planar), Math.sin(maxAngleRad)));
}

/**
 * Drives the segment from `pivot` to `child` toward the direction `desiredDir`. The two particles
 * are pushed in opposite directions in proportion to their inverse masses, so the limit adds no
 * net momentum to the body.
 */
export function driveSegmentToward(
  pivot: LimitParticle,
  child: LimitParticle,
  desiredDir: Vec3Like,
  effort: LimitEffort
): void {
  subInto(SEGMENT, child.position, pivot.position);
  const segmentLength = length(SEGMENT);
  SEGMENT_ERROR.x = desiredDir.x * segmentLength - SEGMENT.x;
  SEGMENT_ERROR.y = desiredDir.y * segmentLength - SEGMENT.y;
  SEGMENT_ERROR.z = desiredDir.z * segmentLength - SEGMENT.z;
  subInto(RELATIVE_VELOCITY, child.velocity, pivot.velocity);
  const speed = requiredPush(RELATIVE_VELOCITY, SEGMENT_ERROR, effort);
  if (speed === 0) return;
  const wChild = 1 / child.massKg;
  const wPivot = 1 / pivot.massKg;
  const toChild = (speed * wChild) / (wChild + wPivot);
  const toPivot = (speed * wPivot) / (wChild + wPivot);
  child.velocity.x += PUSH_DIR.x * toChild;
  child.velocity.y += PUSH_DIR.y * toChild;
  child.velocity.z += PUSH_DIR.z * toChild;
  pivot.velocity.x -= PUSH_DIR.x * toPivot;
  pivot.velocity.y -= PUSH_DIR.y * toPivot;
  pivot.velocity.z -= PUSH_DIR.z * toPivot;
}

/** The displacement that turns `position` about the line through `origin` along unit `axis`. */
export function turnAbout(position: Vec3Like, origin: Vec3Like, axis: Vec3Like, angleRad: number): Vec3Like {
  const arm = sub(position, origin);
  const radial = sub(arm, scale(axis, dot(arm, axis)));
  const tangent = cross(axis, radial);
  return add(scale(radial, Math.cos(angleRad) - 1), scale(tangent, Math.sin(angleRad)));
}
