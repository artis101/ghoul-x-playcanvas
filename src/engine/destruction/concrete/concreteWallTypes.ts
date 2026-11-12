import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  ChunkConnectivityGraphJson,
  QuatLike,
} from '../../../contracts/destruction.ts';
import type {
  RuntimeConnectivityGraph,
  WallTransformLike,
} from '../../../core/destruction/connectivityGraph.ts';
import type {
  ImportedVoronoiChunkMesh,
  VoronoiChunkData,
  VoronoiWallData,
} from '../../../core/destruction/voronoiWallGenerator.ts';
import type { PomCraterDecalSystem } from '../pomCraterDecals.ts';

export const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };

export enum ConcreteChunkPhase {
  INTACT_STATIC = 0,
  DYNAMIC_ACTIVE = 1,
  DYNAMIC_SLEEPING_SYNCED = 2,
  DYNAMIC_SHRINKING = 3,
  EVICTED_DESTROYED = 4,
}

export interface ConcreteWallConfig {
  wallId: string;
  position: Vec3Like;
  rotation?: QuatLike;
  width?: number;
  height?: number;
  depth?: number;
  cellCount?: number;
  seed?: number;
  bondStrengthPerSqM?: number;
  voronoiData?: VoronoiWallData;
  importedChunks?: {
    meshes: readonly ImportedVoronoiChunkMesh[];
    connectivity: string | ChunkConnectivityGraphJson;
  };
  dynamicChunkTtlS?: number;
}

export interface ConcreteWallInstanceState {
  readonly wallId: string;
  readonly transform: WallTransformLike;
  readonly voronoiData: VoronoiWallData;
  graph: RuntimeConnectivityGraph;
  readonly intactEntity: pc.Entity;
  readonly intactMesh: pc.Mesh;
  readonly intactMeshInstance: pc.MeshInstance;
  readonly drawCommands: pc.DrawCommands | undefined;
  readonly staticColliderHandles: Float64Array;
  readonly dynamicBodyHandles: Float64Array;
  readonly chunkPhase: Uint8Array;
  readonly dynamicDebrisTtlS: number;
  activeIntactChunkCount: number;
  detachedChunkCount: number;
}

export interface ActiveDynamicConcreteChunk {
  wallId: string;
  chunkIndex: number;
  chunk: VoronoiChunkData;
  bodyHandle: number;
  baseVertex: number;
  vertexCount: number;
  baseIndex: number;
  indexCount: number;
  ageS: number;
  ttlS: number;
  sleepingSynced: boolean;
  phase: ConcreteChunkPhase;
}

export interface ConcreteWallSystemOptions {
  id?: string;
  material?: pc.StandardMaterial;
  pomDecalSystem?: PomCraterDecalSystem;
  maxDynamicVertices?: number;
  maxDynamicIndices?: number;
}
