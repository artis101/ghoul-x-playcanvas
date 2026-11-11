import earcut from 'earcut';
import {
  INV_WOOD_CLIPPER_SCALE,
  type WoodMeshBuildStats,
  type WoodMeshScratchBuffers,
  type WoodPanelClipperState,
} from './woodClipperTypes.ts';
import { computePanelRemainingAreaM2 } from './panelState.ts';
import { appendExtrudedRimLoop } from './panelRimLoop.ts';

export function triangulateWoodPanelToBuffers(
  state: WoodPanelClipperState,
  buffers: WoodMeshScratchBuffers,
): WoodMeshBuildStats {
  const maxVerts = Math.min(
    Math.floor(buffers.positions.length / 3),
    Math.floor(buffers.normals.length / 3),
    Math.floor(buffers.uvs.length / 2),
    buffers.indices instanceof Uint16Array ? 65535 : 0x7fffffff,
  );
  const maxIndices = buffers.indices.length;

  const posOut = buffers.positions;
  const normOut = buffers.normals;
  const uvOut = buffers.uvs;
  const idxOut = buffers.indices;

  const widthM = state.widthM;
  const heightM = state.heightM;
  const invW = 1 / widthM;
  const invH = 1 / heightM;
  const halfW = widthM * 0.5;
  const halfH = heightM * 0.5;
  const halfZ = state.thicknessM * 0.5;

  let vertCursor = 0;
  let idxCursor = 0;
  let frontFaceTriangleCount = 0;
  let backFaceTriangleCount = 0;
  let holeRimTriangleCount = 0;
  let outerRimTriangleCount = 0;
  let holeCount = 0;

  for (let s = 0; s < state.shells.length; s++) {
    const shell = state.shells[s];
    holeCount += shell.holes.length;

    const flatCoords: number[] = [];
    const holeIndices: number[] = [];

    for (let i = 0; i < shell.outer.length; i++) {
      const pt = shell.outer[i];
      flatCoords.push(pt.x * INV_WOOD_CLIPPER_SCALE, pt.y * INV_WOOD_CLIPPER_SCALE);
    }

    for (let h = 0; h < shell.holes.length; h++) {
      const hole = shell.holes[h];
      holeIndices.push(flatCoords.length >> 1);
      for (let i = 0; i < hole.length; i++) {
        const pt = hole[i];
        flatCoords.push(pt.x * INV_WOOD_CLIPPER_SCALE, pt.y * INV_WOOD_CLIPPER_SCALE);
      }
    }

    const ringVertCount = flatCoords.length >> 1;
    if (ringVertCount < 3) {
      continue;
    }

    const triIndices = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : undefined, 2);
    const triSlotCount = Math.floor(triIndices.length / 3);

    if (triSlotCount > 0 && vertCursor + ringVertCount * 2 <= maxVerts && idxCursor + triSlotCount * 6 <= maxIndices) {
      const frontBase = vertCursor;
      for (let i = 0; i < ringVertCount; i++) {
        const u = flatCoords[i * 2], v = flatCoords[i * 2 + 1];
        const pOff = (frontBase + i) * 3, uvOff = (frontBase + i) * 2;
        posOut[pOff] = u - halfW; posOut[pOff + 1] = v - halfH; posOut[pOff + 2] = halfZ;
        normOut[pOff] = 0; normOut[pOff + 1] = 0; normOut[pOff + 2] = 1;
        uvOut[uvOff] = u * invW; uvOut[uvOff + 1] = 0.02 + v * invH * 0.80;
      }
      vertCursor += ringVertCount;

      const backBase = vertCursor;
      for (let i = 0; i < ringVertCount; i++) {
        const u = flatCoords[i * 2], v = flatCoords[i * 2 + 1];
        const pOff = (backBase + i) * 3, uvOff = (backBase + i) * 2;
        posOut[pOff] = u - halfW; posOut[pOff + 1] = v - halfH; posOut[pOff + 2] = -halfZ;
        normOut[pOff] = 0; normOut[pOff + 1] = 0; normOut[pOff + 2] = -1;
        uvOut[uvOff] = (widthM - u) * invW; uvOut[uvOff + 1] = 0.02 + v * invH * 0.80;
      }
      vertCursor += ringVertCount;

      for (let t = 0; t < triIndices.length; t += 3) {
        const i0 = triIndices[t];
        const i1 = triIndices[t + 1];
        const i2 = triIndices[t + 2];

        const u0 = flatCoords[i0 * 2];
        const v0 = flatCoords[i0 * 2 + 1];
        const u1 = flatCoords[i1 * 2];
        const v1 = flatCoords[i1 * 2 + 1];
        const u2 = flatCoords[i2 * 2];
        const v2 = flatCoords[i2 * 2 + 1];

        const crossZ = (u1 - u0) * (v2 - v0) - (v1 - v0) * (u2 - u0);
        if (Math.abs(crossZ) < 1e-12) {
          continue;
        }

        const a = i0;
        const b = crossZ > 0 ? i1 : i2;
        const c = crossZ > 0 ? i2 : i1;

        idxOut[idxCursor] = frontBase + a;
        idxOut[idxCursor + 1] = frontBase + b;
        idxOut[idxCursor + 2] = frontBase + c;
        idxCursor += 3;
        frontFaceTriangleCount++;

        idxOut[idxCursor] = backBase + a;
        idxOut[idxCursor + 1] = backBase + c;
        idxOut[idxCursor + 2] = backBase + b;
        idxCursor += 3;
        backFaceTriangleCount++;
      }
    }

    for (let h = 0; h < shell.holes.length; h++) {
      const rimRes = appendExtrudedRimLoop(
        shell.holes[h],
        halfW,
        halfH,
        halfZ,
        0.88,
        0.99,
        buffers,
        maxVerts,
        maxIndices,
        vertCursor,
        idxCursor,
      );
      vertCursor = rimRes.vertCursor;
      idxCursor = rimRes.idxCursor;
      holeRimTriangleCount += rimRes.emittedTriangles;
    }

    const outerRes = appendExtrudedRimLoop(
      shell.outer,
      halfW,
      halfH,
      halfZ,
      0.88,
      0.99,
      buffers,
      maxVerts,
      maxIndices,
      vertCursor,
      idxCursor,
    );
    vertCursor = outerRes.vertCursor;
    idxCursor = outerRes.idxCursor;
    outerRimTriangleCount += outerRes.emittedTriangles;
  }

  return {
    vertexCount: vertCursor,
    indexCount: idxCursor,
    frontFaceTriangleCount,
    backFaceTriangleCount,
    holeRimTriangleCount,
    outerRimTriangleCount,
    remainingAreaM2: computePanelRemainingAreaM2(state),
    holeCount,
    shellCount: state.shells.length,
  };
}
