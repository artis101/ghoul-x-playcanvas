import type { GlassShardPool } from './glassShardPool.ts';
import {
  SHARD_DYNAMIC,
  SHARD_FADING,
  SHARD_SETTLED,
  type ShardStage,
} from './glassShardTypes.ts';

export function transitionShardStage(
  pool: GlassShardPool,
  index: number,
  nextStage: ShardStage,
): void {
  if (index < 0 || index >= pool.maxShards) return;
  pool.stage[index] = nextStage;
  if (nextStage === SHARD_DYNAMIC) {
    pool.settled[index] = 0;
  } else if (nextStage === SHARD_SETTLED) {
    pool.settled[index] = 1;
  }
}

export function findOldestSlotIndex(pool: GlassShardPool): number {
  let oldestIdx = 0;
  let smallestRem = Infinity;
  for (let i = 0; i < pool.activeCount; i++) {
    const rem = pool.ttlS[i] - pool.ageS[i];
    if (rem < smallestRem) {
      smallestRem = rem;
      oldestIdx = i;
    }
  }
  return oldestIdx;
}

export function removeAtSwapLast(pool: GlassShardPool, index: number): void {
  const last = pool.activeCount - 1;
  if (index !== last) {
    pool.posX[index] = pool.posX[last];
    pool.posY[index] = pool.posY[last];
    pool.posZ[index] = pool.posZ[last];

    pool.prevPosX[index] = pool.prevPosX[last];
    pool.prevPosY[index] = pool.prevPosY[last];
    pool.prevPosZ[index] = pool.prevPosZ[last];

    pool.velX[index] = pool.velX[last];
    pool.velY[index] = pool.velY[last];
    pool.velZ[index] = pool.velZ[last];

    pool.quatX[index] = pool.quatX[last];
    pool.quatY[index] = pool.quatY[last];
    pool.quatZ[index] = pool.quatZ[last];
    pool.quatW[index] = pool.quatW[last];

    pool.angVelX[index] = pool.angVelX[last];
    pool.angVelY[index] = pool.angVelY[last];
    pool.angVelZ[index] = pool.angVelZ[last];

    pool.ageS[index] = pool.ageS[last];
    pool.ttlS[index] = pool.ttlS[last];
    pool.fadeScale[index] = pool.fadeScale[last];
    pool.stage[index] = pool.stage[last];
    pool.settled[index] = pool.settled[last];
    pool.shardStyle[index] = pool.shardStyle[last];

    const vCount = pool.shardVertCount[last];
    const iCount = pool.shardIndexCount[last];
    pool.shardVertCount[index] = vCount;
    pool.shardIndexCount[index] = iCount;

    if (vCount > 0) {
      const dstV3 = index * pool.maxVertsPerShard * 3;
      const srcV3 = last * pool.maxVertsPerShard * 3;
      pool.localPosArena.copyWithin(dstV3, srcV3, srcV3 + vCount * 3);
      pool.localNormArena.copyWithin(dstV3, srcV3, srcV3 + vCount * 3);

      const dstV2 = index * pool.maxVertsPerShard * 2;
      const srcV2 = last * pool.maxVertsPerShard * 2;
      pool.localUvArena.copyWithin(dstV2, srcV2, srcV2 + vCount * 2);
    }
    if (iCount > 0) {
      const dstI = index * pool.maxIndicesPerShard;
      const srcI = last * pool.maxIndicesPerShard;
      pool.localIdxArena.copyWithin(dstI, srcI, srcI + iCount);
    }
  }

  pool.decrementCount();
  pool.setMeshDirty();
}

export function stepShardSimulation(pool: GlassShardPool, dt: number): void {
  if (dt <= 0 || !Number.isFinite(dt) || pool.activeCount === 0) return;

  const stepDt = Math.min(dt, 1 / 10);
  const halfDt = 0.5 * stepDt;
  const airDrag = Math.max(0, 1 - 0.35 * stepDt);
  const floorY = pool.floorY;
  const restitution = pool.restitution;
  const gravityDv = pool.gravityY * stepDt;

  for (let i = pool.activeCount - 1; i >= 0; i--) {
    const nextAge = pool.ageS[i] + stepDt;
    const ttl = pool.ttlS[i];
    if (nextAge >= ttl) {
      removeAtSwapLast(pool, i);
      continue;
    }
    pool.ageS[i] = nextAge;

    const fadeWindow = Math.min(0.55, ttl * 0.22);
    const remaining = ttl - nextAge;
    const isFading = fadeWindow > 1e-4 && remaining < fadeWindow;
    const nextFade = isFading ? Math.max(0, remaining / fadeWindow) : 1;
    if (isFading && pool.stage[i] !== SHARD_FADING) {
      transitionShardStage(pool, i, SHARD_FADING);
    }
    if (nextFade !== pool.fadeScale[i]) {
      pool.fadeScale[i] = nextFade;
      pool.setMeshDirty();
    }

    if (pool.settled[i] === 1) continue;

    let vx = pool.velX[i] * airDrag;
    let vy = pool.velY[i] + gravityDv;
    let vz = pool.velZ[i] * airDrag;

    pool.prevPosX[i] = pool.posX[i];
    pool.prevPosY[i] = pool.posY[i];
    pool.prevPosZ[i] = pool.posZ[i];

    const px = pool.posX[i] + vx * stepDt;
    let py = pool.posY[i] + vy * stepDt;
    const pz = pool.posZ[i] + vz * stepDt;

    let wx = pool.angVelX[i];
    let wy = pool.angVelY[i];
    let wz = pool.angVelZ[i];
    let qx = pool.quatX[i];
    let qy = pool.quatY[i];
    let qz = pool.quatZ[i];
    let qw = pool.quatW[i];

    if (py <= floorY) {
      py = floorY;
      if (vy < 0) {
        const bouncedVy = -vy * restitution;
        vy = bouncedVy < 0.14 ? 0 : bouncedVy;
        vx *= 0.68;
        vz *= 0.68;
        wx *= 0.56;
        wy *= 0.56;
        wz *= 0.56;
      } else {
        vy = 0;
        const slideDrag = Math.max(0, 1 - 8.0 * stepDt);
        vx *= slideDrag;
        vz *= slideDrag;
        const spinDrag = Math.max(0, 1 - 10.0 * stepDt);
        wx *= spinDrag;
        wy *= spinDrag;
        wz *= spinDrag;
      }

      const zx = 2 * (qx * qz + qw * qy);
      const zy = 1 - 2 * (qx * qx + qy * qy);
      const zz = 2 * (qy * qz - qw * qx);
      const signY = zy >= 0 ? 1 : -1;
      const flatStiffness = 18.0 * stepDt;
      wx += -zz * signY * flatStiffness;
      wz += zx * signY * flatStiffness;

      const linSq = vx * vx + vy * vy + vz * vz;
      const angSq = wx * wx + wy * wy + wz * wz;
      if (linSq < 1e-4 && angSq < 2e-3 && Math.abs(zy) > 0.985) {
        vx = 0;
        vy = 0;
        vz = 0;
        wx = 0;
        wy = 0;
        wz = 0;
        transitionShardStage(pool, i, SHARD_SETTLED);
        if (isFading) {
          transitionShardStage(pool, i, SHARD_FADING);
        }
      }
    }

    pool.posX[i] = px;
    pool.posY[i] = py;
    pool.posZ[i] = pz;
    pool.velX[i] = vx;
    pool.velY[i] = vy;
    pool.velZ[i] = vz;
    pool.angVelX[i] = wx;
    pool.angVelY[i] = wy;
    pool.angVelZ[i] = wz;

    const spinSq = wx * wx + wy * wy + wz * wz;
    if (spinSq > 1e-9) {
      const dqx = (wx * qw + wy * qz - wz * qy) * halfDt;
      const dqy = (wy * qw + wz * qx - wx * qz) * halfDt;
      const dqz = (wz * qw + wx * qy - wy * qx) * halfDt;
      const dqw = (-wx * qx - wy * qy - wz * qz) * halfDt;

      qx += dqx;
      qy += dqy;
      qz += dqz;
      qw += dqw;
      const invQ = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
      pool.quatX[i] = qx * invQ;
      pool.quatY[i] = qy * invQ;
      pool.quatZ[i] = qz * invQ;
      pool.quatW[i] = qw * invQ;
    }

    pool.setMeshDirty();
  }
}
