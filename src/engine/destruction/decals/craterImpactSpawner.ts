import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import { MAX_SHADER_WORLD_CRATERS, type CraterImpactRecord } from './craterTextures.ts';
import { quatFromPlusZToNormalWithRoll } from './craterMeshes.ts';

export interface CraterSpawnerContext {
  maxDecals: number;
  ringSlots: Int32Array;
  ringCursor: number;
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
): CraterImpactRecord {
  const energyClamped = Math.max(80, Math.min(18000, kineticEnergyJ));
  const energyFactor = Math.cbrt(energyClamped / 1800);
  const craterDiameterM = Math.max(0.095, Math.min(0.38, (caliberRadiusM * 19 + 0.072) * energyFactor));
  const craterRadiusM = craterDiameterM * 0.5;
  const craterDepthM = craterRadiusM * 0.36;

  let slotId = ctx.ringSlots[ctx.ringCursor];
  if (slotId < 0 || !ctx.decalPool.isSlotActive(slotId)) {
    slotId = ctx.decalPool.allocSlot();
    ctx.ringSlots[ctx.ringCursor] = slotId;
  }
  ctx.ringCursor = (ctx.ringCursor + 1) % ctx.maxDecals;

  const quat = quatFromPlusZToNormalWithRoll(normalWorld, ctx.nextRandom() * Math.PI * 2);
  const surfaceLiftM = 0.0028 + (slotId % 8) * 0.0001;

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

  const uIdx = ctx.shaderCraterWriteCursor * 4;
  ctx.shaderCraterUniformData[uIdx] = pointWorld.x;
  ctx.shaderCraterUniformData[uIdx + 1] = pointWorld.y;
  ctx.shaderCraterUniformData[uIdx + 2] = pointWorld.z;
  ctx.shaderCraterUniformData[uIdx + 3] = craterRadiusM;

  ctx.shaderCraterWriteCursor = (ctx.shaderCraterWriteCursor + 1) % MAX_SHADER_WORLD_CRATERS;
  ctx.shaderCraterActiveCount = Math.min(MAX_SHADER_WORLD_CRATERS, ctx.shaderCraterActiveCount + 1);

  for (const mat of ctx.trackedConcreteMaterials) {
    mat.setParameter('uCraterSpheres[0]', ctx.shaderCraterUniformData);
    mat.setParameter('uCraterCount', ctx.shaderCraterActiveCount);
  }

  ctx.spawnSpallChips(pointWorld, normalWorld, bulletDirWorld, energyFactor);

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
