import * as pc from 'playcanvas';
import type { BloodPoolDecal } from './goreTypes.ts';
import { releaseFxEntity } from '../particles/fxEntityPool.ts';
import type { GoreFxPools } from './goreFxPools.ts';

export function spawnBloodPool(
  pools: GoreFxPools,
  bloodPools: BloodPoolDecal[],
  poolCounter: { val: number },
  pos: pc.Vec3,
  maxRadius = 0.34,
): void {
  // Blood landing on an existing puddle feeds it rather than stacking another decal on top.
  for (const existing of bloodPools) {
    const p = existing.entity.getPosition();
    const reach = existing.targetScale * 0.32;
    if ((p.x - pos.x) ** 2 + (p.z - pos.z) ** 2 < reach * reach) {
      existing.targetScale = Math.min(1.0, existing.targetScale + maxRadius * 0.25);
      return;
    }
  }

  const pool = pools.bloodPool.acquire();

  const depthBias = 0.0065 + ((poolCounter.val++ % 16) * 0.00018);
  const aspectRatio = 0.84 + Math.random() * 0.34;
  pool.setLocalScale(0.05, 0.003, 0.05 * aspectRatio);
  pool.setPosition(pos.x, depthBias, pos.z);
  pool.setLocalEulerAngles(0, Math.random() * 360, 0);

  bloodPools.push({
    entity: pool,
    currentScale: 0.05,
    targetScale: maxRadius * 2.1 * (0.82 + Math.random() * 0.42),
    growthRate: 0.62,
    aspectRatio,
  });

  if (bloodPools.length > 65) {
    const oldest = bloodPools.shift();
    if (oldest) releaseFxEntity(oldest.entity);
  }
}

export function updateBloodPools(bloodPools: BloodPoolDecal[], dt: number): void {
  for (const pool of bloodPools) {
    if (pool.currentScale < pool.targetScale) {
      pool.currentScale = Math.min(pool.targetScale, pool.currentScale + pool.growthRate * dt);
      const ar = pool.aspectRatio ?? 1.0;
      pool.entity.setLocalScale(pool.currentScale, 0.003, pool.currentScale * ar);
    }
  }
}
