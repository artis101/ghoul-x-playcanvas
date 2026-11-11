import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  ChunkConnectivityGraphJson,
  ChunkConnectivityNode,
  QuatLike,
} from '../../../contracts/destruction.ts';

export interface WallTransformLike {
  position: Vec3Like;
  rotation?: QuatLike;
}

export interface RuntimeConnectivityGraph extends ChunkConnectivityGraphJson {
  /** Per-node detachment state (`0` = still structural/intact, `1` = detached dynamic body). */
  detached: Uint8Array;
  /** Optional alias for nodes */
  chunks?: ChunkConnectivityNode[];
}
