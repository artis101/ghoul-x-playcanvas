import { cutHeightAt, type CutSurface } from './severCutSurface.ts';

export const CUT_SIDE_PROXIMAL = 0;
export const CUT_SIDE_DISTAL = 1;

/**
 * A zone mesh torn in two. Vertices shared by triangles on both sides are duplicated, so each
 * half can follow its own bone without stretching back across the tear.
 */
export interface CutMeshPartition {
  /** Source vertex for each output vertex. */
  sourceVertex: Uint32Array;
  /** CUT_SIDE_PROXIMAL or CUT_SIDE_DISTAL for each output vertex. */
  vertexSide: Uint8Array;
  /** Output triangle list, indexing the output vertices. */
  indices: Uint32Array;
  proximalTriangles: number;
  distalTriangles: number;
  /**
   * Longest stretch along the bone of any triangle that straddles the tear. The skin edge can
   * sit this far from the cap rim, so the cap's inner skirt must reach at least this far.
   */
  maxStraddleSpanM: number;
}

/**
 * Splits a triangle list along a cut surface. `localPositions` holds xyz triples already in the
 * cut bone's local frame. Each triangle goes to the side its centroid lies on, so the skin
 * edge follows the mesh's own triangles in a ragged line round the tear.
 */
export function partitionMeshByCut(
  localPositions: ArrayLike<number>,
  indices: ArrayLike<number>,
  surface: CutSurface
): CutMeshPartition {
  const vertexCount = Math.floor(localPositions.length / 3);
  const remap = [new Int32Array(vertexCount).fill(-1), new Int32Array(vertexCount).fill(-1)];
  const sourceVertex: number[] = [];
  const vertexSide: number[] = [];
  const out = new Uint32Array(indices.length - (indices.length % 3));
  let proximalTriangles = 0;
  let distalTriangles = 0;
  let maxStraddleSpanM = 0;

  for (let tri = 0; tri + 2 < indices.length; tri += 3) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    let below = 0;
    for (let k = 0; k < 3; k++) {
      const v = indices[tri + k] * 3;
      const x = localPositions[v];
      const y = localPositions[v + 1];
      const z = localPositions[v + 2];
      cx += x;
      cy += y;
      cz += z;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (y < cutHeightAt(surface, x, z)) below++;
    }
    cx /= 3;
    cy /= 3;
    cz /= 3;
    const side = cy < cutHeightAt(surface, cx, cz) ? CUT_SIDE_PROXIMAL : CUT_SIDE_DISTAL;
    if (side === CUT_SIDE_PROXIMAL) proximalTriangles++;
    else distalTriangles++;
    if (below > 0 && below < 3) maxStraddleSpanM = Math.max(maxStraddleSpanM, maxY - minY);

    const sideMap = remap[side];
    for (let k = 0; k < 3; k++) {
      const src = indices[tri + k];
      let mapped = sideMap[src];
      if (mapped < 0) {
        mapped = sourceVertex.length;
        sideMap[src] = mapped;
        sourceVertex.push(src);
        vertexSide.push(side);
      }
      out[tri + k] = mapped;
    }
  }

  return {
    sourceVertex: Uint32Array.from(sourceVertex),
    vertexSide: Uint8Array.from(vertexSide),
    indices: out,
    proximalTriangles,
    distalTriangles,
    maxStraddleSpanM,
  };
}
