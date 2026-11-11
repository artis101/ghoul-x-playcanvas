import * as pc from 'playcanvas';
import type { BloodPoolDecal, WetGoreMaterialSuite } from './goreTypes.ts';

export function spawnBloodPool(
  fxRoot: pc.Entity,
  goreSuite: WetGoreMaterialSuite,
  bloodPools: BloodPoolDecal[],
  poolCounter: { val: number },
  pos: pc.Vec3,
  maxRadius = 0.34,
): void {
  const pool = new pc.Entity('BloodPoolDecal');
  if (goreSuite.floorQuadMesh) {
    const mi = new pc.MeshInstance(goreSuite.floorQuadMesh, goreSuite.wetBloodPoolMat);
    pool.addComponent('render', {
      meshInstances: [mi],
      castShadows: false,
      receiveShadows: true,
    });
  } else {
    pool.addComponent('render', {
      type: 'cylinder',
      material: goreSuite.wetBloodPoolMat,
      castShadows: false,
      receiveShadows: true,
    });
  }

  const depthBias = 0.0065 + ((poolCounter.val++ % 16) * 0.00018);
  const aspectRatio = 0.84 + Math.random() * 0.34;
  pool.setLocalScale(0.05, 0.003, 0.05 * aspectRatio);
  pool.setPosition(pos.x, depthBias, pos.z);
  pool.setLocalEulerAngles(0, Math.random() * 360, 0);
  fxRoot.addChild(pool);

  bloodPools.push({
    entity: pool,
    currentScale: 0.05,
    targetScale: maxRadius * 2.1 * (0.82 + Math.random() * 0.42),
    growthRate: 0.62,
    aspectRatio,
  });

  if (bloodPools.length > 65) {
    const oldest = bloodPools.shift();
    if (oldest) oldest.entity.destroy();
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
