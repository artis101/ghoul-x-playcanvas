import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { isWoundClipHoldingBody } from './woundClipHold.ts';

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

  const waistOrigin = { x: originX, y: originY + 0.75, z: originZ };
  const clearanceHits = rapierWorld.castPenetrationRay(
    waistOrigin,
    { x: stepX / stepDist, y: 0, z: stepZ / stepDist },
    stepDist + 0.42
  );
  return clearanceHits.length > 0 && clearanceHits[0].distanceM <= stepDist + 0.42;
}

/** The walkable arena floor; movement goals are clamped to it. */
export function clampArenaGoalX(x: number): number {
  return Math.max(-8.1, Math.min(8.1, x));
}

export function clampArenaGoalZ(z: number): number {
  return Math.max(-46.0, Math.min(-3.2, z));
}

export function moveHorizontalClamped(
  hs: TargetHealthState,
  goalX: number,
  goalZ: number,
  maxStepM: number,
  rapierWorld: RapierPhysicsWorld | null
): void {
  if (!hs.alive || hs.currentHp <= 0 || hs.isRagdollActive || maxStepM <= 0) return;
  // A wound clip playing owns the root; stepping it would make the fall skate across the floor.
  if (isWoundClipHoldingBody(hs)) return;

  const clampedGoalX = clampArenaGoalX(goalX);
  const clampedGoalZ = clampArenaGoalZ(goalZ);

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
