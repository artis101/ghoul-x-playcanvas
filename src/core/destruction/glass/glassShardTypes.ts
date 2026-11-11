import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';

export type { QuatLike, Vec3Like };

export const DEFAULT_VORONOI_SHARD_THICKNESS_M = 0.01;
export const DEFAULT_SHARD_FLOOR_Y = 0.008;
export const DEFAULT_SHARD_RESTITUTION = 0.28;
export const DEFAULT_SHARD_GRAVITY_Y = -9.81;

export const GLASS_SHARD_STYLE_CLEAR = 0;
export const GLASS_SHARD_STYLE_ARMORED = 1;

export const ARMORED_CHUNK_PRISTINE = 0;
export const ARMORED_CHUNK_CRAZED = 1;
export const ARMORED_CHUNK_FRACTURED = 2;
export const ARMORED_CHUNK_DETACHED = 3;

export type ArmoredChunkStage =
  | typeof ARMORED_CHUNK_PRISTINE
  | typeof ARMORED_CHUNK_CRAZED
  | typeof ARMORED_CHUNK_FRACTURED
  | typeof ARMORED_CHUNK_DETACHED;

export interface Point2D {
  x: number;
  y: number;
}

export interface ExtrudedGlassShardGeometry {
  /** Number of 2D polygon vertices `N` (`>= 3`). */
  polygonVertexCount: number;
  /** `6 * N` 3D vertices (`x, y, z` in shard-local space centered at `(centroidX, centroidY, 0)`). */
  localPositions: Float32Array;
  /** `6 * N` 3D unit normals (`nx, ny, nz`). */
  localNormals: Float32Array;
  /** `6 * N` 2D window UVs (`u, v` in `[0, 1]`). */
  localUvs: Float32Array;
  /** `12 * N - 12` triangle indices (`4 * N - 4` triangles). */
  localIndices: Uint16Array;
  vertexCount: number;
  indexCount: number;
}

export interface VoronoiGlassShardCell {
  index: number;
  seed: Point2D;
  polygon: Point2D[];
  centroid: Point2D;
  areaM2: number;
  radialDistanceM: number;
  extruded: ExtrudedGlassShardGeometry;
  neighbors: number[];
  touchesFrame: boolean;
  frameContactLengthM: number;
}

export interface VoronoiWindowShatterOptions {
  widthM: number;
  heightM: number;
  hitX: number;
  hitY: number;
  shardCount?: number;
  thicknessM?: number;
  seed?: number;
}

export interface VoronoiWindowShatterResult {
  widthM: number;
  heightM: number;
  hitX: number;
  hitY: number;
  thicknessM: number;
  allSeeds: Point2D[];
  interiorSeedCount: number;
  shards: VoronoiGlassShardCell[];
  totalAreaM2: number;
}

export interface OrganicVoronoiLayoutOptions {
  widthM: number;
  heightM: number;
  cellCount?: number;
  thicknessM?: number;
  seed?: number;
}

export interface SpawnVoronoiShardsTransform {
  windowCenterWorld: Vec3Like;
  windowRotationQuat?: QuatLike;
  impactDirectionWorld: Vec3Like;
  impactEnergyJ: number;
  ttlSeconds?: number;
  seed?: number;
  impactOrigin2D?: Point2D;
  shardStyle?: number;
}

export interface GlassShardBatchedMeshStats {
  activeShards: number;
  vertexCount: number;
  indexCount: number;
}

export interface ArmoredVoronoiImpactOptions {
  hitX: number;
  hitY: number;
  energyJ: number;
  radiusM?: number;
  isArmorPiercing?: boolean;
  seed?: number;
}

export interface ArmoredVoronoiImpactReport {
  alreadyBrokenHole: boolean;
  newlyDetachedIndices: number[];
  chunksCrazed: number;
  survivingChunkCount: number;
  detachedChunkCount: number;
}

export interface ArmoredMeshBuildStats {
  survivingChunks: number;
  vertexCount: number;
  indexCount: number;
}

export interface ProgressiveVoronoiHitReport {
  hitOpenBreach: boolean;
  newlyDetachedIndices: number[];
  survivingFangCount: number;
}

export const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };
