import type * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  ChunkConnectivityGraphJson,
  QuatLike,
} from '../../../contracts/destruction.ts';
import type {
  RuntimeConnectivityGraph,
  WallTransformLike,
} from '../../../core/destruction/connectivityGraph.ts';

export const BRICK_HEAVY_PENETRATOR_THRESHOLD_J = 1400;

export const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };

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
  /** Optional pre-authored connectivity graph (e.g. exported from Blender). */
  connectivityGraph?: ChunkConnectivityGraphJson;
  /** Optional TTL in seconds for dislodged dynamic bricks (0 = persist indefinitely). */
  dynamicDebrisTtlS?: number;
}

export interface BrickWallInstanceState {
  readonly wallId: string;
  readonly transform: WallTransformLike;
  readonly initialGraphSnapshot: ChunkConnectivityGraphJson;
  graph: RuntimeConnectivityGraph;
  readonly brickW: number;
  readonly brickH: number;
  readonly brickD: number;
  readonly dynamicDebrisTtlS: number;
  readonly variantByBrick: Uint8Array;
  readonly poolSlotByBrick: Int32Array;
  readonly staticColliderHandles: Float64Array;
  readonly dynamicBodyHandles: Float64Array;
  intactBrickCount: number;
  detachedBrickCount: number;
}

export interface BrickWallSystemOptions {
  id?: string;
  maxBricksPerVariantPool?: number;
  maxMortarChips?: number;
  material?: pc.StandardMaterial;
  /** Optional external Blender `Brick_0..2` meshes. */
  variantMeshes?: readonly [pc.Mesh, pc.Mesh, pc.Mesh];
}
