import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { BlastEvent, ChunkConnectivityGraphJson } from '../../../contracts/destruction.ts';
import type { RuntimeConnectivityGraph, WallTransformLike } from './connectivityTypes.ts';
import { worldToLocalPoint } from './graphSpatialMath.ts';

function computeBlastAttenuation(dist: number, radiusM: number): number {
  if (dist >= radiusM || radiusM <= 0) {
    return 0;
  }
  const coreRadius = radiusM * 0.35;
  if (dist <= coreRadius) {
    return 1;
  }
  return Math.max(0, (radiusM - dist) / (radiusM - coreRadius));
}

/**
 * Severs undirected connectivity bonds within `radiusM` of `localPoint` whose attenuated
 * impact/blast energy exceeds `edge.breakThresholdJ`.
 *
 * Returns the count of newly severed undirected edges.
 */
export function severEdgesAtPoint(
  graph: ChunkConnectivityGraphJson | RuntimeConnectivityGraph,
  localPoint: Vec3Like,
  energyJ: number,
  radiusM: number,
): number {
  if (energyJ <= 0 || radiusM <= 0 || graph.nodes.length === 0) {
    return 0;
  }

  const nodes = graph.nodes;
  const nodeCount = nodes.length;
  const radiusSq = radiusM * radiusM;
  let newlySeveredPairs = 0;

  // Check extreme foundation blow-out on anchored base chunks directly inside epicenters
  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i];
    if (!node.isAnchored) {
      continue;
    }
    const baseY =
      node.halfExtents !== undefined
        ? node.localCenter.y - node.halfExtents.y
        : node.localCenter.y;
    const dx = node.localCenter.x - localPoint.x;
    const dy = baseY - localPoint.y;
    const dz = node.localCenter.z - localPoint.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > radiusSq) {
      continue;
    }
    const attenuatedJ = energyJ * computeBlastAttenuation(Math.sqrt(distSq), radiusM);

    let maxEdgeBreakJ = 650;
    for (let e = 0; e < node.edges.length; e++) {
      if (node.edges[e].breakThresholdJ > maxEdgeBreakJ) {
        maxEdgeBreakJ = node.edges[e].breakThresholdJ;
      }
    }
    if (attenuatedJ >= maxEdgeBreakJ * 2.25) {
      node.isAnchored = false;
    }
  }

  for (let i = 0; i < nodeCount; i++) {
    const nodeA = nodes[i];
    const edgesA = nodeA.edges;
    for (let e = 0; e < edgesA.length; e++) {
      const edgeAB = edgesA[e];
      const j = edgeAB.neighborIndex;
      if (j <= i || edgeAB.severed || j >= nodeCount) {
        continue;
      }

      const nodeB = nodes[j];
      const midX = 0.5 * (nodeA.localCenter.x + nodeB.localCenter.x);
      const midY = 0.5 * (nodeA.localCenter.y + nodeB.localCenter.y);
      const midZ = 0.5 * (nodeA.localCenter.z + nodeB.localCenter.z);

      const dx = midX - localPoint.x;
      const dy = midY - localPoint.y;
      const dz = midZ - localPoint.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > radiusSq) {
        continue;
      }

      const attenuatedJ = energyJ * computeBlastAttenuation(Math.sqrt(distSq), radiusM);
      if (attenuatedJ >= edgeAB.breakThresholdJ) {
        edgeAB.severed = true;
        const edgesB = nodeB.edges;
        for (let k = 0; k < edgesB.length; k++) {
          if (edgesB[k].neighborIndex === i) {
            edgesB[k].severed = true;
            break;
          }
        }
        newlySeveredPairs++;
      }
    }
  }

  return newlySeveredPairs;
}

/**
 * Transforms a world-space `BlastEvent` into wall-local coordinates and severs mortar/voronoi
 * connectivity bonds within `blast.radiusM`.
 */
export function severEdgesFromBlast(
  graph: ChunkConnectivityGraphJson | RuntimeConnectivityGraph,
  wallTransform: WallTransformLike,
  blast: BlastEvent,
): number {
  const localCenter = worldToLocalPoint(blast.centerWorld, wallTransform);
  return severEdgesAtPoint(graph, localCenter, blast.peakEnergyJ, blast.radiusM);
}

/**
 * 20-line BFS Island Solver: traverses unbroken (`!edge.severed`) edges starting from all
 * remaining non-detached `isAnchored === true` foundation nodes; every non-detached chunk NOT
 * visited by the anchored BFS is returned as newly detached so it becomes a dynamic physics body.
 */
export function findDetachedChunkIndices(
  graph: ChunkConnectivityGraphJson | RuntimeConnectivityGraph,
  detachedMask?: Uint8Array,
): number[] {
  const nodes = graph.nodes;
  const n = nodes.length;
  const mask = detachedMask ?? ('detached' in graph ? graph.detached : undefined);
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < n; i++) {
    if (nodes[i].isAnchored && (!mask || mask[i] === 0)) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  }

  while (head < tail) {
    const edges = nodes[queue[head++]].edges;
    for (let e = 0; e < edges.length; e++) {
      const v = edges[e].neighborIndex;
      if (!edges[e].severed && v >= 0 && v < n && visited[v] === 0 && (!mask || mask[v] === 0)) {
        visited[v] = 1;
        queue[tail++] = v;
      }
    }
  }

  const detached: number[] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i] === 0 && (!mask || mask[i] === 0)) {
      if (mask) mask[i] = 1;
      detached.push(i);
    }
  }
  return detached;
}
