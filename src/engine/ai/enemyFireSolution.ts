import * as pc from 'playcanvas';
import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { applySwayToDirection, type WeaponSwayOffset } from '../../core/ai/weaponSway.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';
import { add, dot, distance, normalize, scale, sub } from '../../core/ballistics/vec3.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import { isKneelingPhase } from './woundedSequenceDriver.ts';

/**
 * Where an enemy's bullet starts and which way it goes. A shot leaves from the muzzle of the gun
 * the player can see and travels along that gun's barrel, which the pose already bends by the
 * weapon sway and recoil; the spread cone is laid on afterwards. Only a combatant with no visible
 * weapon (headless tests) falls back to a computed muzzle and the swayed aim line.
 */

const DEG = Math.PI / 180;

/** How far past its spread cone the barrel may point and still be allowed to fire. */
export const FIRE_GATE_MARGIN_RAD = 3 * DEG;
/** A deliberate miss (suppression, warning shot) bends the shot off the barrel by at most this. */
export const MAX_DELIBERATE_MISS_RAD = 5 * DEG;

export interface EnemyBarrelPose {
  readonly muzzleWorld: Vec3Like;
  /** Unit vector along the barrel, out of the muzzle. */
  readonly barrelDirWorld: Vec3Like;
}

export type EnemyBarrelReader = (targetId: string, usingSidearm: boolean) => EnemyBarrelPose | null;

let barrelReader: EnemyBarrelReader | null = null;

/**
 * The game sets this around each AI update so the shot path can read the held guns; it is
 * cleared afterwards, so no reader outlives the frame (or the test) that installed it.
 */
export function setEnemyBarrelReader(reader: EnemyBarrelReader | null): void {
  barrelReader = reader;
}

export function readEnemyBarrelPose(targetId: string, usingSidearm: boolean): EnemyBarrelPose | null {
  return barrelReader?.(targetId, usingSidearm) ?? null;
}

const muzzleNodes = new WeakMap<pc.GraphNode, pc.GraphNode>();

/** The weapon GLB's muzzle bone (the weapon factory always adds one), found once per gun. */
export function findWeaponMuzzleNode(weaponNode: pc.GraphNode): pc.GraphNode {
  let muzzle = muzzleNodes.get(weaponNode);
  if (!muzzle) {
    muzzle = weaponNode.findByName('Bone_Muzzle') ?? weaponNode.findByName('MuzzleSocket') ?? weaponNode;
    muzzleNodes.set(weaponNode, muzzle);
  }
  return muzzle;
}

/**
 * The held gun's muzzle and barrel axis in world space. The weapon GLBs and the grip both put
 * the barrel along the root's local -Z, which is PlayCanvas's `forward`, so the root's forward is
 * the barrel even when the muzzle bone itself is rolled. The caller decides whether the gun is
 * actually out (held and shown); this only measures it.
 */
export function weaponBarrelPose(weaponNode: pc.GraphNode | null | undefined): EnemyBarrelPose | null {
  if (!weaponNode) return null;
  const f = weaponNode.forward;
  const p = findWeaponMuzzleNode(weaponNode).getPosition();
  return {
    muzzleWorld: { x: p.x, y: p.y, z: p.z },
    barrelDirWorld: normalize({ x: f.x, y: f.y, z: f.z }),
  };
}

/**
 * The muzzle height used when there is no visible gun: lying, seated, kneeling or standing.
 */
export function fallbackMuzzleOrigin(hs: TargetHealthState, agent: EnemyAiAgentRuntime): Vec3Like {
  const isGroundedOrDowned = agent.state === 'DOWNED_CRAWLING' || hs.isRagdollActive || isSeatedAnimated(hs);
  const basePos = hs.isRagdollActive
    ? hs.ragdollBones.TORSO_UPPER_THORAX?.position ?? hs.worldPosition
    : hs.worldPosition;
  const y = hs.isRagdollActive
    ? Math.max(0.42, basePos.y)
    : isGroundedOrDowned
      ? hs.worldPosition.y + 0.62
      : isKneelingPhase(hs)
        ? hs.worldPosition.y + 0.92
        : hs.worldPosition.y + 1.32;
  return { x: basePos.x, y, z: basePos.z };
}

export interface EnemyShotRay {
  readonly origin: Vec3Like;
  /** Unit direction before the spread cone. */
  readonly dir: Vec3Like;
  readonly fromVisualWeapon: boolean;
}

/**
 * The ray a shot leaves along before spread. With a visible gun that is its muzzle and barrel:
 * the pose has already swung the barrel by the sway and recoil, so they are not added twice.
 */
export function resolveEnemyShotRay(
  barrel: EnemyBarrelPose | null,
  fallbackOrigin: Vec3Like,
  aimTarget: Vec3Like,
  sway: WeaponSwayOffset,
): EnemyShotRay {
  if (barrel) return { origin: barrel.muzzleWorld, dir: normalize(barrel.barrelDirWorld), fromVisualWeapon: true };
  return {
    origin: fallbackOrigin,
    dir: applySwayToDirection(normalize(sub(aimTarget, fallbackOrigin)), sway),
    fromVisualWeapon: false,
  };
}

export function angleBetweenRad(a: Vec3Like, b: Vec3Like): number {
  const c = dot(normalize(a), normalize(b));
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/**
 * True when the barrel points close enough to one of the targets that the shot could land inside
 * the spread cone. Otherwise the shooter keeps aiming: the aim correction is still bringing the
 * gun round, or the last shot's recoil has not settled yet.
 */
export function isBarrelOnTarget(ray: EnemyShotRay, targets: readonly Vec3Like[], spreadRad: number): boolean {
  const limit = Math.max(0, spreadRad) + FIRE_GATE_MARGIN_RAD;
  for (const t of targets) {
    if (angleBetweenRad(ray.dir, sub(t, ray.origin)) <= limit) return true;
  }
  return false;
}

/**
 * Bends a shot from its barrel toward a deliberate miss point (suppression, warning shot), by the
 * angle between the real target and the miss point, but never more than a few degrees, so the
 * tracer still visibly comes out of the barrel.
 */
export function bendTowardDeliberateMiss(
  dir: Vec3Like,
  origin: Vec3Like,
  aimTarget: Vec3Like,
  missTarget: Vec3Like,
): Vec3Like {
  const a = normalize(sub(aimTarget, origin));
  const m = normalize(sub(missTarget, origin));
  let yaw = wrapRad(Math.atan2(m.x, m.z) - Math.atan2(a.x, a.z));
  let pitch = Math.asin(Math.max(-1, Math.min(1, m.y))) - Math.asin(Math.max(-1, Math.min(1, a.y)));
  const mag = Math.hypot(yaw, pitch);
  if (mag > MAX_DELIBERATE_MISS_RAD) {
    yaw *= MAX_DELIBERATE_MISS_RAD / mag;
    pitch *= MAX_DELIBERATE_MISS_RAD / mag;
  }
  return applySwayToDirection(dir, { yawRad: yaw, pitchRad: pitch });
}

/** Where the ray passes closest to a point, and how far along it that is (Infinity if behind). */
export function closestApproach(
  origin: Vec3Like,
  dir: Vec3Like,
  point: Vec3Like,
): { readonly along: number; readonly missM: number; readonly pointWorld: Vec3Like } {
  const along = dot(sub(point, origin), dir);
  if (along <= 0) return { along, missM: Infinity, pointWorld: origin };
  const pointWorld = add(origin, scale(dir, along));
  return { along, missM: distance(pointWorld, point), pointWorld };
}

function wrapRad(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
