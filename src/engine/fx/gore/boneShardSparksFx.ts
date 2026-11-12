import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { EngineMaterialPalette } from '../../materials.ts';
import type { BoneShardSpark, WetGoreMaterialSuite } from './goreTypes.ts';

export const HOT_SPARK_MAX_LIFE_S = 0.55;
export const BONE_SHARD_MAX_LIFE_S = 3.2;

export function spawnArmorImpactSparks(
  fxRoot: pc.Entity,
  materials: EngineMaterialPalette,
  goreSuite: WetGoreMaterialSuite,
  boneShards: BoneShardSpark[],
  worldPos: Vec3Like,
  normalDir: Vec3Like,
): void {
  for (let i = 0; i < 14; i++) {
    const isHotSpark = i < 8;
    const spark = new pc.Entity('ArmorSpark');
    spark.addComponent('render', {
      type: isHotSpark ? 'sphere' : 'box',
      material: isHotSpark ? goreSuite.incandescentSparkMat : materials.sandbagMat,
      castShadows: false,
    });
    const s = isHotSpark ? 0.008 + Math.random() * 0.008 : 0.011 + Math.random() * 0.012;
    spark.setLocalScale(s, s, isHotSpark ? s * 3.8 : s);
    spark.setPosition(worldPos.x, worldPos.y, worldPos.z);
    fxRoot.addChild(spark);

    const spd = (isHotSpark ? 4.2 : 2.2) + Math.random() * 4.5;
    const vx = normalDir.x * spd + (Math.random() - 0.5) * 3.8;
    const vy = normalDir.y * spd + Math.random() * 2.8;
    const vz = normalDir.z * spd + (Math.random() - 0.5) * 3.8;
    if (isHotSpark) {
      spark.lookAt(worldPos.x + vx, worldPos.y + vy, worldPos.z + vz);
    }

    boneShards.push({
      entity: spark,
      position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
      velocity: new pc.Vec3(vx, vy, vz),
      life: 0,
      maxLife: isHotSpark ? HOT_SPARK_MAX_LIFE_S : BONE_SHARD_MAX_LIFE_S,
    });
  }
}

export function spawnBoneShatterSparks(
  fxRoot: pc.Entity,
  goreSuite: WetGoreMaterialSuite,
  boneShards: BoneShardSpark[],
  worldPos: Vec3Like,
  dir: Vec3Like,
): void {
  const shardCount = 12;
  for (let i = 0; i < shardCount; i++) {
    const shard = new pc.Entity('BoneShard');
    shard.addComponent('render', {
      type: i % 3 === 0 ? 'cone' : 'box',
      material: goreSuite.wetCorticalBoneMat,
    });
    const s = 0.011 + Math.random() * 0.015;
    shard.setLocalScale(s * 0.75, s * 2.3, s * 0.55);
    shard.setPosition(worldPos.x, worldPos.y, worldPos.z);
    shard.setLocalEulerAngles(Math.random() * 360, Math.random() * 360, Math.random() * 360);
    fxRoot.addChild(shard);

    const spd = 2.4 + Math.random() * 4.0;
    boneShards.push({
      entity: shard,
      position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
      velocity: new pc.Vec3(
        dir.x * spd + (Math.random() - 0.5) * 2.8,
        dir.y * spd + Math.random() * 2.4,
        dir.z * spd + (Math.random() - 0.5) * 2.8,
      ),
      life: 0,
      maxLife: BONE_SHARD_MAX_LIFE_S,
    });
  }
}

export function updateBoneShards(
  boneShards: BoneShardSpark[],
  dt: number,
  gravity: number,
): void {
  for (let i = boneShards.length - 1; i >= 0; i--) {
    const shard = boneShards[i];
    shard.life += dt;
    shard.velocity.y += gravity * dt;

    shard.position.x += shard.velocity.x * dt;
    shard.position.y += shard.velocity.y * dt;
    shard.position.z += shard.velocity.z * dt;

    shard.entity.setPosition(shard.position.x, shard.position.y, shard.position.z);

    if (shard.position.y <= 0.015) {
      shard.position.y = 0.015;
      shard.velocity.set(0, 0, 0);
    }

    const maxLife = shard.maxLife ?? BONE_SHARD_MAX_LIFE_S;
    if (shard.life >= maxLife) {
      shard.entity.destroy();
      boneShards.splice(i, 1);
    }
  }
}
