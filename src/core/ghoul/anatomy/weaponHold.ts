import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';
import { add, distance, lerp, scale, vec3 } from '../../ballistics/vec3.ts';

/**
 * Weapon-first holds. The weapon is posed against the shooter's shoulders, then the hands are
 * solved onto its grips. All vectors here are in the character frame: +Y up, +Z forward.
 * Weapon-space points use the weapon model's axes: barrel along -Z, sights along +Y.
 */
export type WeaponHoldStance =
  | 'SHOULDERED' | 'LOW_READY' | 'PATROL'
  | 'PISTOL_AIM' | 'PISTOL_READY' | 'PISTOL_CARRY';

export interface WeaponHoldProfile {
  /** Trigger-hand palm center. */
  readonly trigger: Vec3Like;
  /** The support palm may sit anywhere between these two points. */
  readonly supportNear: Vec3Like;
  readonly supportFar: Vec3Like;
  /** Center of the butt plate. Handguns have none. */
  readonly butt?: Vec3Like;
}

export interface WeaponHoldPose {
  readonly position: Vec3Like;
  readonly rotation: QuatLike;
}

interface StanceSpec {
  /** Offset of the anchored weapon point: toward the support side, up, forward. */
  readonly inward: number;
  readonly up: number;
  readonly forward: number;
  /** Barrel yaw toward the support side, pitch above the horizon, and cant, in degrees. */
  readonly yawIn: number;
  readonly pitch: number;
  readonly cant: number;
}

// Long guns anchor the butt plate to the trigger-side shoulder joint.
// An aimed handgun anchors its grip to the base of the skull, so the sights sit on the eye line
// wherever the torso is turned. A handgun at the ready anchors to the point between the shoulders,
// and a carried one to the trigger-side shoulder.
const STANCES: Readonly<Record<WeaponHoldStance, StanceSpec>> = {
  SHOULDERED: { inward: 0.085, up: -0.045, forward: 0.105, yawIn: 3, pitch: 0, cant: 0 },
  LOW_READY: { inward: 0.05, up: -0.1, forward: 0.125, yawIn: 14, pitch: -34, cant: 6 },
  PATROL: { inward: 0.03, up: -0.17, forward: 0.15, yawIn: 38, pitch: -52, cant: 14 },
  PISTOL_AIM: { inward: 0, up: -0.01, forward: 0.4, yawIn: 0, pitch: 0, cant: 0 },
  // Carried in the trigger hand alone, hanging beside the thigh.
  PISTOL_CARRY: { inward: -0.05, up: -0.55, forward: 0.04, yawIn: 0, pitch: -80, cant: 0 },
  PISTOL_READY: { inward: -0.02, up: -0.11, forward: 0.35, yawIn: 0, pitch: -14, cant: 0 },
};

const DEG = Math.PI / 180;
const REACH_STEPS = 12;
const REACH_YAW_STEP = 3;
const HANDGUN_PULL_STEP = 0.015;

function multiply(a: QuatLike, b: QuatLike): QuatLike {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function axisAngle(x: number, y: number, z: number, radians: number): QuatLike {
  const s = Math.sin(radians / 2);
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(radians / 2) };
}

export function rotateByQuat(q: QuatLike, v: Vec3Like): Vec3Like {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return vec3(
    v.x + q.w * tx + q.y * tz - q.z * ty,
    v.y + q.w * ty + q.z * tx - q.x * tz,
    v.z + q.w * tz + q.x * ty - q.y * tx,
  );
}

export function weaponPointInCharacter(pose: WeaponHoldPose, point: Vec3Like): Vec3Like {
  return add(pose.position, rotateByQuat(pose.rotation, point));
}

export function isHandgunStance(stance: WeaponHoldStance): boolean {
  return stance === 'PISTOL_AIM' || stance === 'PISTOL_READY' || stance === 'PISTOL_CARRY';
}

/** True when only the trigger hand holds the weapon. */
export function isOneHandedStance(stance: WeaponHoldStance): boolean {
  return stance === 'PISTOL_CARRY';
}

function poseForYaw(
  spec: StanceSpec,
  yawIn: number,
  profile: WeaponHoldProfile,
  reference: Vec3Like,
  handgun: boolean,
  triggerSide: -1 | 1,
  pullBack = 0,
): WeaponHoldPose {
  const supportSide = -triggerSide;
  // A barrel along character +Z needs a half turn, because the weapon's barrel is its -Z.
  const yaw = Math.PI + supportSide * yawIn * DEG;
  const rotation = multiply(
    multiply(axisAngle(0, 1, 0, yaw), axisAngle(1, 0, 0, spec.pitch * DEG)),
    axisAngle(0, 0, 1, triggerSide * spec.cant * DEG),
  );
  const anchor = add(reference, vec3(supportSide * spec.inward, spec.up, spec.forward - pullBack));
  const anchored = handgun ? profile.trigger : profile.butt!;
  return { position: add(anchor, scale(rotateByQuat(rotation, anchored), -1)), rotation };
}

/**
 * Poses the weapon for a stance. When the support arm cannot reach the near end of the grip
 * rail, a long gun's barrel swings toward the support side until it can, and a handgun is
 * drawn back toward the body.
 *
 * @param triggerSide -1 when the trigger arm is on the character's -X side, +1 otherwise.
 * @param supportReach Longest shoulder-to-palm distance of the support arm.
 * @param headBase Where the head joins the neck.
 */
export function solveWeaponHold(
  stance: WeaponHoldStance,
  profile: WeaponHoldProfile,
  triggerShoulder: Vec3Like,
  supportShoulder: Vec3Like,
  triggerSide: -1 | 1,
  supportReach = Infinity,
  headBase?: Vec3Like,
): WeaponHoldPose {
  const spec = STANCES[stance];
  const handgun = isHandgunStance(stance) || !profile.butt;
  const between = lerp(triggerShoulder, supportShoulder, 0.5);
  const eyeLine = stance === 'PISTOL_AIM' ? headBase ?? add(between, vec3(0, 0.17, 0)) : between;
  const reference = handgun && stance !== 'PISTOL_CARRY' ? eyeLine : triggerShoulder;
  let pose = poseForYaw(spec, spec.yawIn, profile, reference, handgun, triggerSide);
  for (let step = 1; step <= REACH_STEPS && !isOneHandedStance(stance); step++) {
    if (distance(weaponPointInCharacter(pose, profile.supportNear), supportShoulder) <= supportReach) break;
    // A long gun pivots about its butt. A handgun stays on its line and comes in closer.
    pose = handgun
      ? poseForYaw(spec, spec.yawIn, profile, reference, handgun, triggerSide, step * HANDGUN_PULL_STEP)
      : poseForYaw(spec, spec.yawIn + step * REACH_YAW_STEP, profile, reference, handgun, triggerSide);
  }
  return pose;
}

/**
 * How far along the support rail (0 = near, 1 = far) the arm reaches comfortably.
 * The rail runs away from the shoulder, so the reach distance grows with the parameter.
 */
export function solveSupportRail(
  profile: WeaponHoldProfile,
  pose: WeaponHoldPose,
  supportShoulder: Vec3Like,
  comfortableReach: number,
): number {
  const reachAt = (t: number): number =>
    distance(weaponPointInCharacter(pose, lerp(profile.supportNear, profile.supportFar, t)), supportShoulder);
  if (reachAt(1) <= comfortableReach) return 1;
  if (reachAt(0) >= comfortableReach) return 0;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i++) {
    const middle = (low + high) / 2;
    if (reachAt(middle) <= comfortableReach) low = middle;
    else high = middle;
  }
  return low;
}
