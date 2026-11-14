import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';
import { isFlinchHoldingBody, isWoundClipHoldingBody } from './woundClipHold.ts';
import { HALL_ARENA_NAV_SPEC, type ArenaNavSpec } from './arenaNavSpec.ts';

const STEP_ORIGIN: Vec3Like = { x: 0, y: 0, z: 0 };
const STEP_DIR: Vec3Like = { x: 0, y: 0, z: 1 };
const anySurfaceBlocks = (): boolean => true;

export function isWaistStepBlocked(
  originX: number,
  originY: number,
  originZ: number,
  stepX: number,
  stepZ: number,
  rapierWorld: RapierPhysicsWorld | null
): boolean {
  if (!rapierWorld) return false;
  const stepDist = Math.hypot(stepX, stepZ);
  if (stepDist < 1e-5) return false;

  STEP_ORIGIN.x = originX;
  STEP_ORIGIN.y = originY + 0.75;
  STEP_ORIGIN.z = originZ;
  STEP_DIR.x = stepX / stepDist;
  STEP_DIR.y = 0;
  STEP_DIR.z = stepZ / stepDist;
  return rapierWorld.hasAnyBlockingHit(STEP_ORIGIN, STEP_DIR, stepDist + 0.42, anySurfaceBlocks);
}

/** Movement goals are clamped to the arena's walkable floor. */
export function clampArenaGoalX(x: number, nav: ArenaNavSpec = HALL_ARENA_NAV_SPEC): number {
  return Math.max(nav.walkMinX, Math.min(nav.walkMaxX, x));
}

export function clampArenaGoalZ(z: number, nav: ArenaNavSpec = HALL_ARENA_NAV_SPEC): number {
  return Math.max(nav.walkMinZ, Math.min(nav.walkMaxZ, z));
}

export function moveHorizontalClamped(
  hs: TargetHealthState,
  goalX: number,
  goalZ: number,
  maxStepM: number,
  rapierWorld: RapierPhysicsWorld | null,
  nav: ArenaNavSpec = HALL_ARENA_NAV_SPEC
): void {
  if (!hs.alive || hs.currentHp <= 0 || hs.isRagdollActive || maxStepM <= 0) return;
  // A wound clip playing owns the root; stepping it would make the fall skate across the floor.
  if (isWoundClipHoldingBody(hs)) return;
  // A body being shot stands and takes it, then moves on once its flinch has played out.
  if (isFlinchHoldingBody(hs)) return;
  // A seated last stand stays where it sat down; only a crawler drags itself along the floor.
  if (isSeatedAnimated(hs)) return;

  const clampedGoalX = clampArenaGoalX(goalX, nav);
  const clampedGoalZ = clampArenaGoalZ(goalZ, nav);

  const dx = clampedGoalX - hs.worldPosition.x;
  const dz = clampedGoalZ - hs.worldPosition.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-5) return;

  const step = Math.min(dist, maxStepM);
  const stepX = (dx / dist) * step;
  const stepZ = (dz / dist) * step;

  if (!isWaistStepBlocked(hs.worldPosition.x, hs.worldPosition.y, hs.worldPosition.z, stepX, stepZ, rapierWorld)) {
    hs.worldPosition.x += stepX;
    hs.worldPosition.z += stepZ;
    return;
  }

  if (Math.abs(dx) > 1e-5) {
    const slideX = Math.sign(dx) * Math.min(Math.abs(dx), maxStepM);
    if (!isWaistStepBlocked(hs.worldPosition.x, hs.worldPosition.y, hs.worldPosition.z, slideX, 0, rapierWorld)) {
      hs.worldPosition.x += slideX;
    }
  }

  if (Math.abs(dz) > 1e-5) {
    const slideZ = Math.sign(dz) * Math.min(Math.abs(dz), maxStepM);
    if (!isWaistStepBlocked(hs.worldPosition.x, hs.worldPosition.y, hs.worldPosition.z, 0, slideZ, rapierWorld)) {
      hs.worldPosition.z += slideZ;
    }
  }
}
