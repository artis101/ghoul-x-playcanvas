import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import { MAX_SHADER_WORLD_CRATERS, type CraterImpactRecord } from './craterTextures.ts';
import { quatFromPlusZToNormalWithRoll } from './craterMeshes.ts';

export enum CraterDecalSlotState {
  INACTIVE = 0,
  ACTIVE_DECAL_ONLY = 1,
  ACTIVE_WITH_SHADER_UNIFORM = 2,
}

export interface CraterSpawnerContext {
  maxDecals: number;
  ringSlots: Int32Array;
  ringCursor: number;
  slotState: Uint8Array;
  slotPointX: Float32Array;
  slotPointY: Float32Array;
  slotPointZ: Float32Array;
  slotNormalX: Float32Array;
  slotNormalY: Float32Array;
  slotNormalZ: Float32Array;
  slotUniformIdx: Int32Array;
  uniformOwnerDecalSlot: Int16Array;
  decalPool: HardwareInstancedPool;
  shaderCraterUniformData: Float32Array;
  shaderCraterWriteCursor: number;
  shaderCraterActiveCount: number;
  trackedConcreteMaterials: Set<pc.StandardMaterial>;
  recentImpacts: CraterImpactRecord[];
  nextRandom: () => number;
  spawnSpallChips: (pointWorld: Vec3Like, normalWorld: Vec3Like, bulletDirWorld: Vec3Like, energyFactor: number) => void;
}

export function executeCraterImpact(
  ctx: CraterSpawnerContext,
  pointWorld: Vec3Like,
  normalWorld: Vec3Like,
  bulletDirWorld: Vec3Like,
  kineticEnergyJ: number,
  caliberRadiusM = 0.004,
  destroyed = false,
): CraterImpactRecord {
  const energyClamped = Math.max(80, Math.min(18000, kineticEnergyJ));
  const energyFactor = Math.cbrt(energyClamped / 1800);
  const craterDiameterM = Math.max(0.095, Math.min(0.38, (caliberRadiusM * 19 + 0.072) * energyFactor));
  const craterRadiusM = craterDiameterM * 0.5;
  const craterDepthM = craterRadiusM * 0.36;

  if (!destroyed) {
    let slotId = ctx.ringSlots[ctx.ringCursor];
    if (slotId >= 0 && ctx.decalPool.isSlotActive(slotId)) {
      if (ctx.slotState[slotId] === CraterDecalSlotState.ACTIVE_WITH_SHADER_UNIFORM) {
        const prevUSlot = Math.floor(ctx.slotUniformIdx[slotId] / 4);
        if (
          prevUSlot >= 0 &&
          prevUSlot < MAX_SHADER_WORLD_CRATERS &&
          ctx.uniformOwnerDecalSlot[prevUSlot] === slotId
        ) {
          ctx.uniformOwnerDecalSlot[prevUSlot] = -1;
        }
      }
      ctx.slotUniformIdx[slotId] = -1;
    } else {
      slotId = ctx.decalPool.allocSlot();
      ctx.ringSlots[ctx.ringCursor] = slotId;
    }
    ctx.ringCursor = (ctx.ringCursor + 1) % ctx.maxDecals;

    const quat = quatFromPlusZToNormalWithRoll(normalWorld, ctx.nextRandom() * Math.PI * 2);
    const surfaceLiftM = 0.0028 + (Math.max(0, slotId) % 8) * 0.0001;

    if (slotId >= 0) {
      ctx.decalPool.setSlotTRS(
        slotId,
        {
          x: pointWorld.x + normalWorld.x * surfaceLiftM,
          y: pointWorld.y + normalWorld.y * surfaceLiftM,
          z: pointWorld.z + normalWorld.z * surfaceLiftM,
        },
        quat,
        { x: craterDiameterM, y: craterDiameterM, z: 1 },
      );
      ctx.decalPool.upload();
    }

    const uSlot = ctx.shaderCraterWriteCursor;
    const uIdx = uSlot * 4;
    const evictedOwner = ctx.uniformOwnerDecalSlot[uSlot];
    if (evictedOwner >= 0 && evictedOwner < ctx.maxDecals && evictedOwner !== slotId) {
      if (ctx.slotState[evictedOwner] === CraterDecalSlotState.ACTIVE_WITH_SHADER_UNIFORM) {
        ctx.slotState[evictedOwner] = CraterDecalSlotState.ACTIVE_DECAL_ONLY;
      }
      ctx.slotUniformIdx[evictedOwner] = -1;
    }

    ctx.shaderCraterUniformData[uIdx] = pointWorld.x;
    ctx.shaderCraterUniformData[uIdx + 1] = pointWorld.y;
    ctx.shaderCraterUniformData[uIdx + 2] = pointWorld.z;
    ctx.shaderCraterUniformData[uIdx + 3] = craterRadiusM;

    if (slotId >= 0 && slotId < ctx.maxDecals) {
      ctx.slotState[slotId] = CraterDecalSlotState.ACTIVE_WITH_SHADER_UNIFORM;
      ctx.slotPointX[slotId] = pointWorld.x;
      ctx.slotPointY[slotId] = pointWorld.y;
      ctx.slotPointZ[slotId] = pointWorld.z;
      ctx.slotNormalX[slotId] = normalWorld.x;
      ctx.slotNormalY[slotId] = normalWorld.y;
      ctx.slotNormalZ[slotId] = normalWorld.z;
      ctx.slotUniformIdx[slotId] = uIdx;
      ctx.uniformOwnerDecalSlot[uSlot] = slotId;
    } else {
      ctx.uniformOwnerDecalSlot[uSlot] = -1;
    }

    ctx.shaderCraterWriteCursor = (ctx.shaderCraterWriteCursor + 1) % MAX_SHADER_WORLD_CRATERS;
    ctx.shaderCraterActiveCount = Math.min(MAX_SHADER_WORLD_CRATERS, ctx.shaderCraterActiveCount + 1);

    for (const mat of ctx.trackedConcreteMaterials) {
      mat.setParameter('uCraterSpheres[0]', ctx.shaderCraterUniformData);
      mat.setParameter('uCraterCount', ctx.shaderCraterActiveCount);
    }

    ctx.spawnSpallChips(pointWorld, normalWorld, bulletDirWorld, energyFactor);
  }

  const record: CraterImpactRecord = {
    pointWorld: { x: pointWorld.x, y: pointWorld.y, z: pointWorld.z },
    normalWorld: { x: normalWorld.x, y: normalWorld.y, z: normalWorld.z },
    radiusM: craterRadiusM,
    depthM: craterDepthM,
  };
  ctx.recentImpacts.push(record);
  if (ctx.recentImpacts.length > ctx.maxDecals) ctx.recentImpacts.shift();
  return record;
}
