import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ChunkConnectivityGraphJson } from '../../../contracts/destruction.ts';

export const CONCRETE_DENSITY_KG_M3 = 2400;
export const FOUNDATION_NEIGHBOR_TAG = -1;
export const OUTER_BOUNDARY_NEIGHBOR_TAG = -2;
export const CLIP_EPS = 1e-6;
export const ON_PLANE_EPS = 2.5e-5;
export const WELD_EPS_SQ = 1e-9;

export interface VoronoiChunkData {
  index: number;
  name: string;
  seedPoint: Vec3Like;
  /** Center of mass / geometric centroid in wall-local coordinates. */
  localCenter: Vec3Like;
  /** Tight chunk-local AABB half-extents. */
  halfExtents: Vec3Like;
  volumeM3: number;
  massKg: number;
  isAnchored: boolean;
  /** Flat-shaded vertex positions in chunk-local space (`v - localCenter`), `3 * vertexCount` floats. */
  localPositions: Float32Array;
  /** Flat-shaded vertex positions in wall-local space (`v`), `3 * vertexCount` floats. */
  wallSpacePositions: Float32Array;
  /** Per-vertex outward facet normals, `3 * vertexCount` floats. */
  normals: Float32Array;
  /** Box-projected concrete UVs, `2 * vertexCount` floats. */
  uvs: Float32Array;
  /** Chunk-local triangle indices (`0 .. vertexCount - 1`). */
  indices: Uint32Array;
  /** Deduplicated unique chunk-local corner coordinates (`3 * cornerCount` floats) for Rapier `convexHull`. */
  hullVertices: Float32Array;
}

export interface VoronoiSubDrawRange {
  chunkIndex: number;
  baseVertex: number;
  vertexCount: number;
  firstIndex: number;
  indexCount: number;
}

export interface CombinedVoronoiMeshBuffer {
  totalVertices: number;
  totalIndices: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  subDraws: VoronoiSubDrawRange[];
}

export interface VoronoiWallData {
  wallId: string;
  width: number;
  height: number;
  depth: number;
  chunks: VoronoiChunkData[];
  connectivity: ChunkConnectivityGraphJson;
  combinedBuffer: CombinedVoronoiMeshBuffer;
}

export interface ImportedVoronoiChunkMesh {
  name?: string;
  /** Positions in either wall-local space (when `positionsAreWallLocal === true`) or chunk-local space. */
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  indices: Uint16Array | Uint32Array;
  positionsAreWallLocal?: boolean;
}

export interface PolyFace3D {
  normal: Vec3Like;
  neighborTag: number;
  vertices: Vec3Like[];
}
