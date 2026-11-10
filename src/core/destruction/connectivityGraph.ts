import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BlastEvent,
  ChunkConnectivityEdge,
  ChunkConnectivityGraphJson,
  ChunkConnectivityNode,
  QuatLike,
} from '../../contracts/destruction.ts';

export interface WallTransformLike {
  position: Vec3Like;
  rotation?: QuatLike;
}

export interface RuntimeConnectivityGraph extends ChunkConnectivityGraphJson {
  /** Per-node detachment state (`0` = still structural/intact, `1` = detached dynamic body). */
  detached: Uint8Array;
}

const IDENTITY_ROTATION: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };

export function rotateVec3ByQuat(v: Vec3Like, q: QuatLike = IDENTITY_ROTATION): Vec3Like {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);

  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export function inverseRotateVec3ByQuat(
  v: Vec3Like,
  q: QuatLike = IDENTITY_ROTATION,
): Vec3Like {
  const tx = 2 * (-q.y * v.z + q.z * v.y);
  const ty = 2 * (-q.z * v.x + q.x * v.z);
  const tz = 2 * (-q.x * v.y + q.y * v.x);

  return {
    x: v.x + q.w * tx + (-q.y * tz + q.z * ty),
    y: v.y + q.w * ty + (-q.z * tx + q.x * tz),
    z: v.z + q.w * tz + (-q.x * ty + q.y * tx),
  };
}

export function localToWorldPoint(
  localPoint: Vec3Like,
  transform: WallTransformLike,
): Vec3Like {
  const rotated = rotateVec3ByQuat(localPoint, transform.rotation ?? IDENTITY_ROTATION);
  return {
    x: transform.position.x + rotated.x,
    y: transform.position.y + rotated.y,
    z: transform.position.z + rotated.z,
  };
}

export function worldToLocalPoint(
  worldPoint: Vec3Like,
  transform: WallTransformLike,
): Vec3Like {
  const translated: Vec3Like = {
    x: worldPoint.x - transform.position.x,
    y: worldPoint.y - transform.position.y,
    z: worldPoint.z - transform.position.z,
  };
  return inverseRotateVec3ByQuat(translated, transform.rotation ?? IDENTITY_ROTATION);
}

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

  // Ensure undirected symmetry: if A -> B exists, B -> A also exists with synchronized state
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

function addSymmetricEdge(
  nodes: ChunkConnectivityNode[],
  a: number,
  b: number,
  breakThresholdJ: number,
): void {
  if (a === b || a < 0 || b < 0 || a >= nodes.length || b >= nodes.length) {
    return;
  }
  const threshold = Math.max(1, breakThresholdJ);
  const edgesA = nodes[a].edges;
  for (let i = 0; i < edgesA.length; i++) {
    if (edgesA[i].neighborIndex === b) {
      return;
    }
  }
  edgesA.push({ neighborIndex: b, breakThresholdJ: threshold, severed: false });
  nodes[b].edges.push({ neighborIndex: a, breakThresholdJ: threshold, severed: false });
}

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
    // Foundation footing bond requires 2.25x normal mortar bond to rip directly off ground
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
      // Process each undirected pair once (i < j)
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

/**
 * Builds a staggered running-bond masonry brick wall connectivity graph where `row === 0`
 * bricks are anchored to the foundation (`isAnchored: true`), horizontal head joints connect
 * `(col - 1, row)` / `(col + 1, row)`, and staggered bed joints connect each brick to the
 * two overlapping bricks in `row - 1` and `row + 1`.
 */
export function generateRunningBondBrickGraph(
  wallId: string,
  cols: number,
  rows: number,
  brickW = 0.215,
  brickH = 0.065,
  brickD = 0.1025,
  mortarBreakJ = 650,
  mortarGapM = 0.008,
): ChunkConnectivityGraphJson {
  const safeCols = Math.max(1, Math.floor(cols));
  const safeRows = Math.max(1, Math.floor(rows));
  const w = Math.max(0.04, brickW);
  const h = Math.max(0.02, brickH);
  const d = Math.max(0.02, brickD);
  const gap = Math.max(0, mortarGapM);

  const stepX = w + gap;
  const stepY = h + gap;
  const brickMassKg = Math.max(0.15, w * h * d * 1920);
  const halfExtents: Vec3Like = { x: w * 0.5, y: h * 0.5, z: d * 0.5 };
  const totalBricks = safeCols * safeRows;
  const nodes: ChunkConnectivityNode[] = new Array<ChunkConnectivityNode>(totalBricks);

  for (let row = 0; row < safeRows; row++) {
    const isOddRow = (row & 1) === 1;
    const staggerShift = (isOddRow ? 0.25 : -0.25) * stepX;
    const centerY = row * stepY + h * 0.5;

    for (let col = 0; col < safeCols; col++) {
      const idx = row * safeCols + col;
      const centerX = (col - (safeCols - 1) * 0.5) * stepX + staggerShift;
      const variant = ((row * 7 + col * 13 + row * col * 3) >>> 0) % 3;

      nodes[idx] = {
        index: idx,
        name: `brick_r${row}_c${col}`,
        isAnchored: row === 0,
        localCenter: { x: centerX, y: centerY, z: 0 },
        halfExtents: { x: halfExtents.x, y: halfExtents.y, z: halfExtents.z },
        massKg: brickMassKg,
        meshVariant: variant,
        edges: [],
      };
    }
  }

  for (let row = 0; row < safeRows; row++) {
    const isOddRow = (row & 1) === 1;
    for (let col = 0; col < safeCols; col++) {
      const idx = row * safeCols + col;

      // Same-course horizontal head joint to right neighbor
      if (col + 1 < safeCols) {
        addSymmetricEdge(nodes, idx, row * safeCols + (col + 1), mortarBreakJ);
      }

      // Staggered bed joints to overlapping bricks in course above
      if (row + 1 < safeRows) {
        const upperRowBase = (row + 1) * safeCols;
        if (isOddRow) {
          // Odd row shifted +0.25*stepX overlaps col and col + 1 in even row above (-0.25*stepX)
          addSymmetricEdge(nodes, idx, upperRowBase + col, mortarBreakJ);
          if (col + 1 < safeCols) {
            addSymmetricEdge(nodes, idx, upperRowBase + col + 1, mortarBreakJ);
          }
        } else {
          // Even row shifted -0.25*stepX overlaps col - 1 and col in odd row above (+0.25*stepX)
          if (col - 1 >= 0) {
            addSymmetricEdge(nodes, idx, upperRowBase + col - 1, mortarBreakJ);
          }
          addSymmetricEdge(nodes, idx, upperRowBase + col, mortarBreakJ);
        }
      }
    }
  }

  return {
    version: 1,
    wallId,
    nodes,
  };
}
