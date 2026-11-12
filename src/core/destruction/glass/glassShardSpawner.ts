import { createDeterministicPrng } from '../glassMarchingTiles.ts';
import type { BlastEvent } from '../../../contracts/destruction.ts';
import {
  GLASS_SHARD_STYLE_ARMORED,
  GLASS_SHARD_STYLE_CLEAR,
  IDENTITY_QUAT,
  SHARD_DYNAMIC,
  SHARD_FADING,
  type ExtrudedGlassShardGeometry,
  type QuatLike,
  type SpawnVoronoiShardsTransform,
  type Vec3Like,
  type VoronoiWindowShatterResult,
} from './glassShardTypes.ts';
import { rotateVec3ByQuatOut } from './glassShardPoolTypes.ts';
import { findOldestSlotIndex, transitionShardStage } from './glassShardIntegrator.ts';
import type { GlassShardPool } from './glassShardPool.ts';

export function spawnSingleShard(
  pool: GlassShardPool,
  pos: Vec3Like,
  vel: Vec3Like,
  angVel: Vec3Like,
  quat: QuatLike = IDENTITY_QUAT,
  extruded?: ExtrudedGlassShardGeometry,
  ttlSeconds = 3.8,
  style = GLASS_SHARD_STYLE_CLEAR,
): number {
  const slot = pool.activeCount < pool.maxShards ? pool.allocateSlot() : findOldestSlotIndex(pool);
  const startY = Math.max(pool.floorY, pos.y);

  pool.posX[slot] = pos.x;
  pool.posY[slot] = startY;
  pool.posZ[slot] = pos.z;
  pool.prevPosX[slot] = pos.x - vel.x * (1 / 60);
  pool.prevPosY[slot] = startY - vel.y * (1 / 60);
  pool.prevPosZ[slot] = pos.z - vel.z * (1 / 60);
  pool.velX[slot] = vel.x;
  pool.velY[slot] = vel.y;
  pool.velZ[slot] = vel.z;

  const qLen = Math.hypot(quat.x, quat.y, quat.z, quat.w);
  const invQ = qLen > 1e-6 ? 1 / qLen : 0;
  pool.quatX[slot] = quat.x * invQ;
  pool.quatY[slot] = quat.y * invQ;
  pool.quatZ[slot] = quat.z * invQ;
  pool.quatW[slot] = qLen > 1e-6 ? quat.w * invQ : 1;

  pool.angVelX[slot] = angVel.x;
  pool.angVelY[slot] = angVel.y;
  pool.angVelZ[slot] = angVel.z;
  pool.ageS[slot] = 0;
  pool.ttlS[slot] = Math.max(0.1, ttlSeconds);
  pool.fadeScale[slot] = 1;
  transitionShardStage(pool, slot, SHARD_DYNAMIC);
  pool.shardStyle[slot] = style;

  if (extruded && extruded.vertexCount > 0 && extruded.vertexCount <= pool.maxVertsPerShard && extruded.indexCount <= pool.maxIndicesPerShard) {
    const vCount = extruded.vertexCount;
    const iCount = extruded.indexCount;
    pool.shardVertCount[slot] = vCount;
    pool.shardIndexCount[slot] = iCount;
    pool.localPosArena.set(extruded.localPositions.subarray(0, vCount * 3), slot * pool.maxVertsPerShard * 3);
    pool.localNormArena.set(extruded.localNormals.subarray(0, vCount * 3), slot * pool.maxVertsPerShard * 3);
    pool.localUvArena.set(extruded.localUvs.subarray(0, vCount * 2), slot * pool.maxVertsPerShard * 2);
    pool.localIdxArena.set(extruded.localIndices.subarray(0, iCount), slot * pool.maxIndicesPerShard);
  } else {
    pool.shardVertCount[slot] = 0;
    pool.shardIndexCount[slot] = 0;
  }

  pool.setMeshDirty();
  return slot;
}

export function spawnShardsSubset(
  pool: GlassShardPool,
  shatter: VoronoiWindowShatterResult,
  shardIndices: readonly number[],
  transform: SpawnVoronoiShardsTransform,
): number {
  if (shardIndices.length === 0) return 0;
  const rot = transform.windowRotationQuat ?? IDENTITY_QUAT;
  const baseTtl = transform.ttlSeconds ?? 3.8;
  const style = transform.shardStyle ?? GLASS_SHARD_STYLE_CLEAR;
  const originX = transform.impactOrigin2D ? transform.impactOrigin2D.x : shatter.hitX;
  const originY = transform.impactOrigin2D ? transform.impactOrigin2D.y : shatter.hitY;

  const rand = createDeterministicPrng(
    transform.seed ?? ((Math.round(originX * 997) ^ Math.round(originY * 991)) + pool.activeCount * 31),
  );

  const dirLen = Math.hypot(transform.impactDirectionWorld.x, transform.impactDirectionWorld.y, transform.impactDirectionWorld.z);
  const fwdX = dirLen > 1e-6 ? transform.impactDirectionWorld.x / dirLen : 0;
  const fwdY = dirLen > 1e-6 ? transform.impactDirectionWorld.y / dirLen : 0;
  const fwdZ = dirLen > 1e-6 ? transform.impactDirectionWorld.z / dirLen : -1;

  const massDamp = style === GLASS_SHARD_STYLE_ARMORED ? 0.78 : 1.0;
  const energyScale = Math.min(2.2, 0.55 + Math.sqrt(Math.max(10, transform.impactEnergyJ)) * 0.032) * massDamp;
  const halfW = shatter.widthM * 0.5;
  const halfH = shatter.heightM * 0.5;
  const diag = Math.hypot(shatter.widthM, shatter.heightM);

  let spawned = 0;
  for (let k = 0; k < shardIndices.length; k++) {
    const idx = shardIndices[k];
    if (idx < 0 || idx >= shatter.shards.length) continue;
    const shard = shatter.shards[idx];

    rotateVec3ByQuatOut(shard.centroid.x - halfW, shard.centroid.y - halfH, 0, rot.x, rot.y, rot.z, rot.w, pool.scratchVec);
    const worldPos: Vec3Like = {
      x: transform.windowCenterWorld.x + pool.scratchVec.x,
      y: transform.windowCenterWorld.y + pool.scratchVec.y,
      z: transform.windowCenterWorld.z + pool.scratchVec.z,
    };

    const rdx = shard.centroid.x - originX;
    const rdy = shard.centroid.y - originY;
    const rLen = Math.hypot(rdx, rdy);
    const rnx = rLen > 1e-5 ? rdx / rLen : rand() - 0.5;
    const rny = rLen > 1e-5 ? rdy / rLen : rand() - 0.5;

    rotateVec3ByQuatOut(rnx, rny, 0, rot.x, rot.y, rot.z, rot.w, pool.scratchVec);
    const proximity = 1 / (1 + (rLen / Math.max(0.2, diag)) * 4.2);
    const forwardSpeed = (1.1 + proximity * 4.4) * energyScale * (0.8 + rand() * 0.45);
    const radialSpeed = (0.55 + proximity * 2.3) * energyScale * (0.75 + rand() * 0.5);

    const vel: Vec3Like = {
      x: fwdX * forwardSpeed + pool.scratchVec.x * radialSpeed + (rand() - 0.5) * 0.45,
      y: fwdY * forwardSpeed + pool.scratchVec.y * radialSpeed + (0.25 + rand() * 0.65),
      z: fwdZ * forwardSpeed + pool.scratchVec.z * radialSpeed + (rand() - 0.5) * 0.45,
    };

    const spinRate = (5.2 + proximity * 14.0) * massDamp * (0.7 + rand() * 0.65);
    const angVel: Vec3Like = {
      x: (-rny + (rand() - 0.5) * 0.8) * spinRate,
      y: (rnx + (rand() - 0.5) * 0.8) * spinRate,
      z: (rand() - 0.5) * spinRate * 0.85,
    };

    pool.spawnShard(worldPos, vel, angVel, rot, shard.extruded, baseTtl * (0.85 + rand() * 0.35), style);
    spawned++;
  }

  return spawned;
}

export function applyShardBlast(pool: GlassShardPool, blast: BlastEvent): number {
  if (blast.radiusM <= 0 || blast.peakImpulseNs <= 0) return 0;
  const rSq = blast.radiusM * blast.radiusM;
  let affected = 0;

  for (let i = 0; i < pool.activeCount; i++) {
    const dx = pool.posX[i] - blast.centerWorld.x;
    const dy = pool.posY[i] - blast.centerWorld.y;
    const dz = pool.posZ[i] - blast.centerWorld.z;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq > rSq) continue;

    const dist = Math.sqrt(dSq);
    const falloff = Math.max(0, 1 - dist / blast.radiusM);
    const dv = Math.min(14, blast.peakImpulseNs * falloff * 0.35);
    const invD = dist > 1e-4 ? 1 / dist : 0;

    pool.velX[i] += dx * invD * dv;
    pool.velY[i] += (dy * invD + 0.45) * dv;
    pool.velZ[i] += dz * invD * dv;
    pool.angVelX[i] += -dz * invD * dv * 2.2;
    pool.angVelZ[i] += dx * invD * dv * 2.2;
    transitionShardStage(pool, i, SHARD_DYNAMIC);
    if (pool.fadeScale[i] < 1) {
      transitionShardStage(pool, i, SHARD_FADING);
    }
    affected++;
  }

  if (affected > 0) pool.setMeshDirty();
  return affected;
}
