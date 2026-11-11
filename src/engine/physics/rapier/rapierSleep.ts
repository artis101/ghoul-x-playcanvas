import type * as RAPIER from '@dimforge/rapier3d-compat';
import {
  SLEEP_ANGULAR_SPEED_SQ,
  SLEEP_LINEAR_SPEED_SQ,
  SLEEP_SETTLE_DURATION_S,
} from './rapierMath.ts';

export function updateDebrisSleepStates(
  world: RAPIER.World,
  dynamicBodyHandles: Set<number>,
  bodySettleTimers: Map<number, number>,
  scratchLinvel: RAPIER.Vector,
  scratchAngvel: RAPIER.Vector,
  dt: number
): void {
  for (const handle of dynamicBodyHandles) {
    const b = world.getRigidBody(handle) as RAPIER.RigidBody | undefined;
    if (!b) {
      dynamicBodyHandles.delete(handle);
      bodySettleTimers.delete(handle);
      continue;
    }
    if (b.isSleeping()) continue;
    const lv = b.linvel(scratchLinvel);
    const av = b.angvel(scratchAngvel);
    const linSpeedSq = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
    const angSpeedSq = av.x * av.x + av.y * av.y + av.z * av.z;
    if (linSpeedSq <= SLEEP_LINEAR_SPEED_SQ && angSpeedSq <= SLEEP_ANGULAR_SPEED_SQ) {
      const acc = (bodySettleTimers.get(handle) ?? 0) + dt;
      if (acc >= SLEEP_SETTLE_DURATION_S) {
        b.sleep();
        bodySettleTimers.set(handle, 0);
      } else {
        bodySettleTimers.set(handle, acc);
      }
    } else {
      bodySettleTimers.set(handle, 0);
    }
  }
}
