import type { BlastEvent } from '../../../contracts/destruction.ts';
import {
  DEFAULT_SHARD_FLOOR_Y,
  DEFAULT_SHARD_GRAVITY_Y,
  DEFAULT_SHARD_RESTITUTION,
  type GlassShardBatchedMeshStats,
} from './glassShardTypes.ts';
import {
  GLASS_SHARD_STYLE_CLEAR,
  IDENTITY_QUAT,
  type ExtrudedGlassShardGeometry,
  type QuatLike,
  type SpawnVoronoiShardsTransform,
  type Vec3Like,
  type VoronoiWindowShatterResult,
} from './glassShardTypes.ts';
import {
  applyShardBlast,
  spawnShardsSubset,
  spawnSingleShard,
} from './glassShardSpawner.ts';
import { stepShardSimulation } from './glassShardIntegrator.ts';
import { writeBatchedMeshBuffers } from './glassShardBatchWriter.ts';

export class GlassShardPool {
  public readonly maxShards: number;
  public readonly maxVertsPerShard: number;
  public readonly maxIndicesPerShard: number;
  public readonly floorY: number;
  public readonly restitution: number;
  public readonly gravityY: number;

  public readonly posX: Float32Array;
  public readonly posY: Float32Array;
  public readonly posZ: Float32Array;

  public readonly prevPosX: Float32Array;
  public readonly prevPosY: Float32Array;
  public readonly prevPosZ: Float32Array;

  public readonly velX: Float32Array;
  public readonly velY: Float32Array;
  public readonly velZ: Float32Array;

  public readonly quatX: Float32Array;
  public readonly quatY: Float32Array;
  public readonly quatZ: Float32Array;
  public readonly quatW: Float32Array;

  public readonly angVelX: Float32Array;
  public readonly angVelY: Float32Array;
  public readonly angVelZ: Float32Array;

  public readonly ageS: Float32Array;
  public readonly ttlS: Float32Array;
  public readonly fadeScale: Float32Array;
  public readonly settled: Uint8Array;
  public readonly shardStyle: Uint8Array;

  public readonly shardVertCount: Uint16Array;
  public readonly shardIndexCount: Uint16Array;
  public readonly localPosArena: Float32Array;
  public readonly localNormArena: Float32Array;
  public readonly localUvArena: Float32Array;
  public readonly localIdxArena: Uint16Array;

  private count = 0;
  private meshDirty = false;
  public readonly scratchVec: Vec3Like = { x: 0, y: 0, z: 0 };

  public constructor(
    maxShards = 640,
    floorY = DEFAULT_SHARD_FLOOR_Y,
    restitution = DEFAULT_SHARD_RESTITUTION,
    gravityY = DEFAULT_SHARD_GRAVITY_Y,
    maxPolygonSides = 16,
  ) {
    const cap = Math.max(16, Math.floor(maxShards));
    const maxSides = Math.max(4, Math.floor(maxPolygonSides));
    this.maxShards = cap;
    this.maxVertsPerShard = 6 * maxSides;
    this.maxIndicesPerShard = 12 * maxSides - 12;
    this.floorY = floorY;
    this.restitution = Math.max(0, Math.min(0.95, restitution));
    this.gravityY = gravityY;

    this.posX = new Float32Array(cap);
    this.posY = new Float32Array(cap);
    this.posZ = new Float32Array(cap);
    this.prevPosX = new Float32Array(cap);
    this.prevPosY = new Float32Array(cap);
    this.prevPosZ = new Float32Array(cap);
    this.velX = new Float32Array(cap);
    this.velY = new Float32Array(cap);
    this.velZ = new Float32Array(cap);
    this.quatX = new Float32Array(cap);
    this.quatY = new Float32Array(cap);
    this.quatZ = new Float32Array(cap);
    this.quatW = new Float32Array(cap);
    this.angVelX = new Float32Array(cap);
    this.angVelY = new Float32Array(cap);
    this.angVelZ = new Float32Array(cap);
    this.ageS = new Float32Array(cap);
    this.ttlS = new Float32Array(cap);
    this.fadeScale = new Float32Array(cap);
    this.settled = new Uint8Array(cap);
    this.shardStyle = new Uint8Array(cap);

    this.shardVertCount = new Uint16Array(cap);
    this.shardIndexCount = new Uint16Array(cap);
    this.localPosArena = new Float32Array(cap * this.maxVertsPerShard * 3);
    this.localNormArena = new Float32Array(cap * this.maxVertsPerShard * 3);
    this.localUvArena = new Float32Array(cap * this.maxVertsPerShard * 2);
    this.localIdxArena = new Uint16Array(cap * this.maxIndicesPerShard);
  }

  public get activeCount(): number {
    return this.count;
  }

  public get dirty(): boolean {
    return this.meshDirty;
  }

  public clearDirty(): void {
    this.meshDirty = false;
  }

  public setMeshDirty(): void {
    this.meshDirty = true;
  }

  public allocateSlot(): number {
    return this.count++;
  }

  public decrementCount(): void {
    this.count--;
  }

  public clear(): void {
    this.count = 0;
    this.meshDirty = true;
  }

  public spawnShard(
    pos: Vec3Like,
    vel: Vec3Like,
    angVel: Vec3Like,
    quat: QuatLike = IDENTITY_QUAT,
    extruded?: ExtrudedGlassShardGeometry,
    ttlSeconds = 3.8,
    style = GLASS_SHARD_STYLE_CLEAR,
  ): number {
    return spawnSingleShard(this, pos, vel, angVel, quat, extruded, ttlSeconds, style);
  }

  public spawnShardsSubset(
    shatter: VoronoiWindowShatterResult,
    shardIndices: readonly number[],
    transform: SpawnVoronoiShardsTransform,
  ): number {
    return spawnShardsSubset(this, shatter, shardIndices, transform);
  }

  public spawnWindowShatter(
    shatter: VoronoiWindowShatterResult,
    transform: SpawnVoronoiShardsTransform,
  ): number {
    const allIndices = new Array<number>(shatter.shards.length);
    for (let i = 0; i < shatter.shards.length; i++) allIndices[i] = i;
    return this.spawnShardsSubset(shatter, allIndices, transform);
  }

  public applyBlast(blast: BlastEvent): number {
    return applyShardBlast(this, blast);
  }

  public step(dt: number): void {
    stepShardSimulation(this, dt);
  }

  public writeBatchedMeshBuffers(
    outPositions: Float32Array,
    outNormals: Float32Array,
    outUvs: Float32Array,
    outIndices: Uint32Array,
    outColors?: Float32Array,
  ): GlassShardBatchedMeshStats {
    return writeBatchedMeshBuffers(this, outPositions, outNormals, outUvs, outIndices, outColors);
  }
}
