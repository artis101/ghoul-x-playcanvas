import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  ChunkConnectivityEdge,
  ChunkConnectivityGraphJson,
  ChunkConnectivityNode,
} from '../../../contracts/destruction.ts';
import type { RuntimeConnectivityGraph } from './connectivityTypes.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseVec3(value: unknown, label: string): Vec3Like {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}: expected { x, y, z } object.`);
  }
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(`Invalid ${label}: coordinates must be finite numbers.`);
  }
  return { x, y, z };
}

/**
 * Parses, validates, deep-clones, and symmetrizes a `ChunkConnectivityGraphJson` payload
 * (from either a JSON string or an object literal).
 */
export function parseConnectivityGraphJson(
  source: string | ChunkConnectivityGraphJson,
): ChunkConnectivityGraphJson {
  const parsed: unknown = typeof source === 'string' ? JSON.parse(source) : source;
  if (!isRecord(parsed)) {
    throw new Error('Invalid connectivity graph JSON: root must be an object.');
  }
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported connectivity graph version: ${String(parsed.version)} (expected 1).`,
    );
  }
  if (typeof parsed.wallId !== 'string' || parsed.wallId.trim().length === 0) {
    throw new Error('Invalid connectivity graph JSON: wallId must be a non-empty string.');
  }
  if (!Array.isArray(parsed.nodes)) {
    throw new Error('Invalid connectivity graph JSON: nodes must be an array.');
  }

  const nodeCount = parsed.nodes.length;
  const nodes: ChunkConnectivityNode[] = new Array<ChunkConnectivityNode>(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    const rawNode: unknown = parsed.nodes[i];
    if (!isRecord(rawNode)) {
      throw new Error(`Invalid node at index ${i}: expected object.`);
    }

    const localCenter = parseVec3(rawNode.localCenter, `nodes[${i}].localCenter`);
    const halfExtents =
      rawNode.halfExtents !== undefined
        ? parseVec3(rawNode.halfExtents, `nodes[${i}].halfExtents`)
        : undefined;
    const massKg = Math.max(0.01, Number(rawNode.massKg) || 1.0);
    const isAnchored = Boolean(rawNode.isAnchored);
    const name = typeof rawNode.name === 'string' ? rawNode.name : undefined;
    const meshVariant =
      typeof rawNode.meshVariant === 'number' && Number.isFinite(rawNode.meshVariant)
        ? Math.max(0, Math.floor(rawNode.meshVariant))
        : undefined;

    const rawEdges = Array.isArray(rawNode.edges) ? rawNode.edges : [];
    const edges: ChunkConnectivityEdge[] = [];
    for (let e = 0; e < rawEdges.length; e++) {
      const rawEdge: unknown = rawEdges[e];
      if (!isRecord(rawEdge)) {
        continue;
      }
      const neighborIndex = Math.floor(Number(rawEdge.neighborIndex));
      if (
        !Number.isFinite(neighborIndex) ||
        neighborIndex < 0 ||
        neighborIndex >= nodeCount ||
        neighborIndex === i
      ) {
        continue;
      }
      const breakThresholdJ = Math.max(1, Number(rawEdge.breakThresholdJ) || 500);
      const severed = Boolean(rawEdge.severed);
      edges.push({
        neighborIndex,
        breakThresholdJ,
        severed,
      });
    }

    nodes[i] = {
      index: i,
      ...(name !== undefined ? { name } : {}),
      isAnchored,
      localCenter,
      ...(halfExtents !== undefined ? { halfExtents } : {}),
      massKg,
      ...(meshVariant !== undefined ? { meshVariant } : {}),
      edges,
    };
  }

// Ensure undirected symmetry
  for (let i = 0; i < nodeCount; i++) {
    const edgesA = nodes[i].edges;
    for (let e = 0; e < edgesA.length; e++) {
      const edgeAB = edgesA[e];
      const j = edgeAB.neighborIndex;
      const edgesB = nodes[j].edges;
      let edgeBA: ChunkConnectivityEdge | undefined;
      for (let k = 0; k < edgesB.length; k++) {
        if (edgesB[k].neighborIndex === i) {
          edgeBA = edgesB[k];
          break;
        }
      }
      if (!edgeBA) {
        edgesB.push({
          neighborIndex: i,
          breakThresholdJ: edgeAB.breakThresholdJ,
          severed: edgeAB.severed,
        });
      } else {
        const syncedThreshold = Math.min(edgeAB.breakThresholdJ, edgeBA.breakThresholdJ);
        const syncedSevered = edgeAB.severed || edgeBA.severed;
        edgeAB.breakThresholdJ = syncedThreshold;
        edgeBA.breakThresholdJ = syncedThreshold;
        edgeAB.severed = syncedSevered;
        edgeBA.severed = syncedSevered;
      }
    }
  }

  return {
    version: 1,
    wallId: parsed.wallId,
    nodes,
  };
}

/**
 * Serializes a `ChunkConnectivityGraphJson` (or `RuntimeConnectivityGraph`) cleanly to JSON.
 */
export function serializeConnectivityGraphJson(
  graph: ChunkConnectivityGraphJson,
): string {
  const clean: ChunkConnectivityGraphJson = {
    version: 1,
    wallId: graph.wallId,
    nodes: graph.nodes.map((node, idx) => ({
      index: idx,
      ...(node.name !== undefined ? { name: node.name } : {}),
      isAnchored: node.isAnchored,
      localCenter: {
        x: node.localCenter.x,
        y: node.localCenter.y,
        z: node.localCenter.z,
      },
      ...(node.halfExtents !== undefined
        ? {
            halfExtents: {
              x: node.halfExtents.x,
              y: node.halfExtents.y,
              z: node.halfExtents.z,
            },
          }
        : {}),
      massKg: node.massKg,
      ...(node.meshVariant !== undefined ? { meshVariant: node.meshVariant } : {}),
      edges: node.edges.map((edge) => ({
        neighborIndex: edge.neighborIndex,
        breakThresholdJ: edge.breakThresholdJ,
        severed: edge.severed,
      })),
    })),
  };
  return JSON.stringify(clean);
}

/**
 * Wraps a `ChunkConnectivityGraphJson` in a mutable `RuntimeConnectivityGraph` with a
 * zero-allocated `detached: Uint8Array` tracking mask.
 */
export function createRuntimeConnectivityGraph(
  source: string | ChunkConnectivityGraphJson,
): RuntimeConnectivityGraph {
  const parsed = parseConnectivityGraphJson(source);
  return {
    version: 1,
    wallId: parsed.wallId,
    nodes: parsed.nodes,
    detached: new Uint8Array(parsed.nodes.length),
  };
}
