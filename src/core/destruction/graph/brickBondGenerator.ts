import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  ChunkConnectivityGraphJson,
  ChunkConnectivityNode,
} from '../../../contracts/destruction.ts';

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
          addSymmetricEdge(nodes, idx, upperRowBase + col, mortarBreakJ);
          if (col + 1 < safeCols) {
            addSymmetricEdge(nodes, idx, upperRowBase + col + 1, mortarBreakJ);
          }
        } else {
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
