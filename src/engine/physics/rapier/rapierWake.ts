import type * as RAPIER from '@dimforge/rapier3d-compat';

export interface SphereRegion {
  x: number;
  y: number;
  z: number;
  radiusM: number;
}

/** Wakes only the dynamic bodies whose origin lies inside at least one region. Returns how many were asleep. */
export function wakeDynamicBodiesInRegions(
  world: RAPIER.World,
  dynamicBodyHandles: Set<number>,
  bodySettleTimers: Map<number, number>,
  regions: readonly SphereRegion[]
): number {
  if (regions.length === 0) return 0;
  let woken = 0;
  for (const handle of dynamicBodyHandles) {
    const body = world.getRigidBody(handle) as RAPIER.RigidBody | undefined;
    if (!body) continue;
    const p = body.translation();
    let inside = false;
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      const dx = p.x - r.x;
      const dy = p.y - r.y;
      const dz = p.z - r.z;
      if (dx * dx + dy * dy + dz * dz <= r.radiusM * r.radiusM) {
        inside = true;
        break;
      }
    }
    if (!inside) continue;
    if (body.isSleeping()) woken++;
    body.wakeUp();
    bodySettleTimers.set(handle, 0);
  }
  return woken;
}
