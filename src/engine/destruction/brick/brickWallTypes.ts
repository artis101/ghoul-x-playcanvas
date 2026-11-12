import type * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  ChunkConnectivityGraphJson,
  QuatLike,
} from '../../../contracts/destruction.ts';
import type {
  BrickWallMeshBuffers,
  BrickWallMeshStats,
  SolidBrickWallGrid,
} from '../../../core/destruction/brickWallMesh.ts';
import type { WallTransformLike } from '../../../core/destruction/connectivityGraph.ts';

export const DEFAULT_BRICK_WALL_MAX_VERTICES = 24576;
export const DEFAULT_BRICK_WALL_MAX_INDICES = 36864;
export const BRICK_WALL_STOPPING_RESISTANCE_J = 2400;

export const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };

export enum BrickPhase {
  INTACT = 0,
  CHIPPED = 1,
  CRACKED = 2,
  DESTROYED = 3,
}

export interface BrickWallConfig {
  wallId: string;
  position: Vec3Like;
  rotation?: QuatLike;
  cols?: number;
  rows?: number;
  brickW?: number;
  brickH?: number;
  brickD?: number;
  mortarBreakJ?: number;
  mortarGapM?: number;
  connectivityGraph?: ChunkConnectivityGraphJson;
  dynamicDebrisTtlS?: number;
}

export interface BrickWallInstanceState {
  readonly wallId: string;
  readonly transform: WallTransformLike;
  readonly invRotation: QuatLike;
  readonly grid: SolidBrickWallGrid;
  readonly brickW: number;
  readonly brickH: number;
  readonly brickD: number;
  readonly dynamicDebrisTtlS: number;
  readonly brickPhase: Uint8Array;
  wallColliderHandle: number;
  readonly wallEntity: pc.Entity;
  readonly wallMesh: pc.Mesh;
  readonly wallMeshInstance: pc.MeshInstance;
  readonly meshBuffers: BrickWallMeshBuffers;
  lastMeshStats: BrickWallMeshStats;
  intactBrickCount: number;
  damagedBrickCount: number;
  destroyedBrickCount: number;
  /** Alias kept in sync with `destroyedBrickCount` for arena breach diagnostics. */
  detachedBrickCount: number;
}

export interface BrickWallSystemOptions {
  id?: string;
  maxBricksPerVariantPool?: number;
  maxMortarChips?: number;
  maxWallVertices?: number;
  maxWallIndices?: number;
  /** Optional custom material for the solid brick wall surface. */
  material?: pc.StandardMaterial;
  /** Optional PBR material from `debris_pack.glb` for flying broken-brick rubble chunks. */
  rubbleMaterial?: pc.Material | null;
  /** Optional external Blender `Brick_0..2` debris meshes from `debris_pack.glb`. */
  variantMeshes?: readonly [pc.Mesh, pc.Mesh, pc.Mesh];
}
