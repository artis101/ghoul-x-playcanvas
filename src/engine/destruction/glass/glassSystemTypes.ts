import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';

export const INSTANCED_SHARDS_PER_MARCHING_HIT = 10;
export const INSTANCED_SHARD_TTL_S = 1.5;
export const MIN_GLASS_ENERGY_LOSS_J = 25;
export const MAX_GLASS_ENERGY_LOSS_J = 45;
export const DEFAULT_REGULAR_VORONOI_PLATE_COUNT = 22;
export const DEFAULT_ARMORED_VORONOI_CELL_COUNT = 68;

export interface GlassWindowCreateOptions {
  id?: string;
  centerWorld: Vec3Like;
  widthM: number;
  heightM: number;
  thicknessM?: number;
  rotationQuat?: QuatLike;
  penetrationResistanceJ?: number;
  gridW?: number;
  gridH?: number;
  armoredChunkCount?: number;
  voronoiShardCount?: number;
}

export interface GlassSystemOptions {
  id?: string;
  atlasSizePx?: number;
  windowTextureSizePx?: number;
  maxInstancedTriangles?: number;
  maxVoronoiShards?: number;
}

export function normalizeQuat(q?: QuatLike): QuatLike {
  if (!q) return { x: 0, y: 0, z: 0, w: 1 };
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-7) return { x: 0, y: 0, z: 0, w: 1 };
  const inv = 1 / len;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
}

export function rotateVec3ByQuat(v: Vec3Like, q: QuatLike): Vec3Like {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export function inverseRotateVec3ByQuat(v: Vec3Like, q: QuatLike): Vec3Like {
  const tx = 2 * (-q.y * v.z + q.z * v.y);
  const ty = 2 * (-q.z * v.x + q.x * v.z);
  const tz = 2 * (-q.x * v.y + q.y * v.x);
  return {
    x: v.x + q.w * tx + (-q.y * tz + q.z * ty),
    y: v.y + q.w * ty + (-q.z * tx + q.x * tz),
    z: v.z + q.w * tz + (-q.x * ty - q.y * tx),
  };
}

export function fract(x: number): number {
  return x - Math.floor(x);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function hashStringSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function triangleWave(t: number): number {
  return Math.abs(fract(t) - 0.5) * 2;
}

export function jaggedCrystallineTeethProfile(coord01: number, phase: number): number {
  const c1 = triangleWave(coord01 * 3.0 + phase);
  const c2 = triangleWave(coord01 * 7.0 + phase * 1.73);
  const c3 = triangleWave(coord01 * 13.0 + phase * 2.41);
  return c1 * 0.54 + c2 * 0.31 + c3 * 0.15;
}
