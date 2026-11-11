import {
  GLASS_CELL_CRACKED,
  GLASS_CELL_VOID,
  type MarchingQuadMeshBuildResult,
} from './marchingTileTypes.ts';
import { bitmaskToAtlasUv, computeNeighborBitmask8 } from './marchingBitmaskMath.ts';

export interface MarchingQuadBufferContext {
  widthM: number;
  heightM: number;
  gridW: number;
  gridH: number;
  cells: Uint8Array;
  frameBorderIntact: boolean;
}

export function writeMarchingQuadGridBuffers(
  pane: MarchingQuadBufferContext,
  outPositions: Float32Array,
  outNormals: Float32Array,
  outUvs: Float32Array,
  outIndices: Uint16Array,
  uvInset = 0,
  outColors?: Float32Array,
): MarchingQuadMeshBuildResult {
  const halfW = pane.widthM * 0.5;
  const halfH = pane.heightM * 0.5;
  const cellW = pane.widthM / pane.gridW;
  const cellH = pane.heightM / pane.gridH;

  let quadCount = 0;
  let vCursor = 0;
  let posCursor = 0;
  let uvCursor = 0;
  let colCursor = 0;
  let idxCursor = 0;

  for (let row = 0; row < pane.gridH; row++) {
    const y0 = -halfH + row * cellH;
    const y1 = y0 + cellH;
    const rowOffset = row * pane.gridW;

    for (let col = 0; col < pane.gridW; col++) {
      const state = pane.cells[rowOffset + col];
      if (state === GLASS_CELL_VOID) {
        continue;
      }

      const x0 = -halfW + col * cellW;
      const x1 = x0 + cellW;

      const mask = computeNeighborBitmask8(
        pane.cells,
        pane.gridW,
        pane.gridH,
        col,
        row,
        pane.frameBorderIntact,
      );
      const uv = bitmaskToAtlasUv(mask, uvInset);

      // Vertex 0: Bottom-Left (x0, y0)
      outPositions[posCursor] = x0;
      outPositions[posCursor + 1] = y0;
      outPositions[posCursor + 2] = 0;
      outNormals[posCursor] = 0;
      outNormals[posCursor + 1] = 0;
      outNormals[posCursor + 2] = 1;
      posCursor += 3;
      outUvs[uvCursor++] = uv.u0;
      outUvs[uvCursor++] = uv.v0;

      // Vertex 1: Bottom-Right (x1, y0)
      outPositions[posCursor] = x1;
      outPositions[posCursor + 1] = y0;
      outPositions[posCursor + 2] = 0;
      outNormals[posCursor] = 0;
      outNormals[posCursor + 1] = 0;
      outNormals[posCursor + 2] = 1;
      posCursor += 3;
      outUvs[uvCursor++] = uv.u1;
      outUvs[uvCursor++] = uv.v0;

      // Vertex 2: Top-Right (x1, y1)
      outPositions[posCursor] = x1;
      outPositions[posCursor + 1] = y1;
      outPositions[posCursor + 2] = 0;
      outNormals[posCursor] = 0;
      outNormals[posCursor + 1] = 0;
      outNormals[posCursor + 2] = 1;
      posCursor += 3;
      outUvs[uvCursor++] = uv.u1;
      outUvs[uvCursor++] = uv.v1;

      // Vertex 3: Top-Left (x0, y1)
      outPositions[posCursor] = x0;
      outPositions[posCursor + 1] = y1;
      outPositions[posCursor + 2] = 0;
      outNormals[posCursor] = 0;
      outNormals[posCursor + 1] = 0;
      outNormals[posCursor + 2] = 1;
      posCursor += 3;
      outUvs[uvCursor++] = uv.u0;
      outUvs[uvCursor++] = uv.v1;

      if (outColors && colCursor + 16 <= outColors.length) {
        const isCracked = state === GLASS_CELL_CRACKED || mask !== 255;
        const rC = isCracked ? 0.92 : 0.84;
        const gC = isCracked ? 0.97 : 0.93;
        const bC = 1.0;
        const aC = isCracked ? 0.94 : 0.9;
        for (let k = 0; k < 4; k++) {
          outColors[colCursor++] = rC;
          outColors[colCursor++] = gC;
          outColors[colCursor++] = bC;
          outColors[colCursor++] = aC;
        }
      }

      outIndices[idxCursor++] = vCursor;
      outIndices[idxCursor++] = vCursor + 1;
      outIndices[idxCursor++] = vCursor + 2;
      outIndices[idxCursor++] = vCursor;
      outIndices[idxCursor++] = vCursor + 2;
      outIndices[idxCursor++] = vCursor + 3;

      vCursor += 4;
      quadCount++;
    }
  }

  return {
    quadCount,
    vertexCount: vCursor,
    indexCount: idxCursor,
  };
}
