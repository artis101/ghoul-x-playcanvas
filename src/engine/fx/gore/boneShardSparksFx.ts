import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { recycleOldestWhenFull, releaseFxEntity } from '../particles/fxEntityPool.ts';
import type { BoneShardSpark } from './goreTypes.ts';
import { MAX_LIVE_SHARDS_AND_SPARKS, type GoreFxPools } from './goreFxPools.ts';

export const HOT_SPARK_MAX_LIFE_S = 0.55;
export const BONE_SHARD_MAX_LIFE_S = 3.2;

export function spawnArmorImpactSparks(
  pools: GoreFxPools,
  boneShards: BoneShardSpark[],
  worldPos: Vec3Like,
  normalDir: Vec3Like,
): void {
  for (let i = 0; i < 14; i++) {
    const isHotSpark = i < 8;
    recycleOldestWhenFull(boneShards, MAX_LIVE_SHARDS_AND_SPARKS);
    const spark = (isHotSpark ? pools.hotSpark : pools.armorChip).acquire();
    const s = isHotSpark ? 0.008 + Math.random() * 0.008 : 0.011 + Math.random() * 0.012;
    spark.setLocalScale(s, s, isHotSpark ? s * 3.8 : s);
    spark.setPosition(worldPos.x, worldPos.y, worldPos.z);

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
  pools: GoreFxPools,
  boneShards: BoneShardSpark[],
  worldPos: Vec3Like,
  dir: Vec3Like,
): void {
  const shardCount = 12;
  for (let i = 0; i < shardCount; i++) {
    recycleOldestWhenFull(boneShards, MAX_LIVE_SHARDS_AND_SPARKS);
    const shard = (i % 3 === 0 ? pools.boneShardCone : pools.boneShardBox).acquire();
    const s = 0.011 + Math.random() * 0.015;
    shard.setLocalScale(s * 0.75, s * 2.3, s * 0.55);
    shard.setPosition(worldPos.x, worldPos.y, worldPos.z);
    shard.setLocalEulerAngles(Math.random() * 360, Math.random() * 360, Math.random() * 360);

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
      releaseFxEntity(shard.entity);
      boneShards.splice(i, 1);
    }
  }
}
