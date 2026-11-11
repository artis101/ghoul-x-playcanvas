import { Path64 } from 'clipper2-js';
import {
  INV_WOOD_CLIPPER_SCALE,
  type WoodMeshScratchBuffers,
} from './woodClipperTypes.ts';

export function appendExtrudedRimLoop(
  loop: Path64,
  halfW: number,
  halfH: number,
  halfZ: number,
  uvVMin: number,
  uvVMax: number,
  buffers: WoodMeshScratchBuffers,
  maxVerts: number,
  maxIndices: number,
  vertCursorIn: number,
  idxCursorIn: number,
): { vertCursor: number; idxCursor: number; emittedTriangles: number } {
  let vertCursor = vertCursorIn;
  let idxCursor = idxCursorIn;
  let emittedTriangles = 0;

  const nPts = loop.length;
  if (nPts < 3) {
    return { vertCursor, idxCursor, emittedTriangles };
  }

  const posOut = buffers.positions;
  const normOut = buffers.normals;
  const uvOut = buffers.uvs;
  const idxOut = buffers.indices;

  let arcU = 0;

  for (let i = 0; i < nPts; i++) {
    if (vertCursor + 4 > maxVerts || idxCursor + 6 > maxIndices) {
      break;
    }

    const p0 = loop[i];
    const p1 = loop[(i + 1) % nPts];

    const u0 = p0.x * INV_WOOD_CLIPPER_SCALE;
    const v0 = p0.y * INV_WOOD_CLIPPER_SCALE;
    const u1 = p1.x * INV_WOOD_CLIPPER_SCALE;
    const v1 = p1.y * INV_WOOD_CLIPPER_SCALE;

    const du = u1 - u0;
    const dv = v1 - v0;
    const edgeLen = Math.hypot(du, dv);
    if (edgeLen < 1e-6) {
      continue;
    }

    const nx = dv / edgeLen;
    const ny = -du / edgeLen;

    const x0 = u0 - halfW;
    const y0 = v0 - halfH;
    const x1 = u1 - halfW;
    const y1 = v1 - halfH;

    const nextArcU = arcU + edgeLen * 2.0;
    const base = vertCursor;

    // v0: Af (x0, y0, +halfZ)
    let pOff = base * 3;
    let uvOff = base * 2;
    posOut[pOff] = x0;
    posOut[pOff + 1] = y0;
    posOut[pOff + 2] = halfZ;
    normOut[pOff] = nx;
    normOut[pOff + 1] = ny;
    normOut[pOff + 2] = 0;
    uvOut[uvOff] = arcU;
    uvOut[uvOff + 1] = uvVMin;

    // v1: Ab (x0, y0, -halfZ)
    pOff += 3;
    uvOff += 2;
    posOut[pOff] = x0;
    posOut[pOff + 1] = y0;
    posOut[pOff + 2] = -halfZ;
    normOut[pOff] = nx;
    normOut[pOff + 1] = ny;
    normOut[pOff + 2] = 0;
    uvOut[uvOff] = arcU;
    uvOut[uvOff + 1] = uvVMax;

    // v2: Bb (x1, y1, -halfZ)
    pOff += 3;
    uvOff += 2;
    posOut[pOff] = x1;
    posOut[pOff + 1] = y1;
    posOut[pOff + 2] = -halfZ;
    normOut[pOff] = nx;
    normOut[pOff + 1] = ny;
    normOut[pOff + 2] = 0;
    uvOut[uvOff] = nextArcU;
    uvOut[uvOff + 1] = uvVMax;

    // v3: Bf (x1, y1, +halfZ)
    pOff += 3;
    uvOff += 2;
    posOut[pOff] = x1;
    posOut[pOff + 1] = y1;
    posOut[pOff + 2] = halfZ;
    normOut[pOff] = nx;
    normOut[pOff + 1] = ny;
    normOut[pOff + 2] = 0;
    uvOut[uvOff] = nextArcU;
    uvOut[uvOff + 1] = uvVMin;

    idxOut[idxCursor] = base;
    idxOut[idxCursor + 1] = base + 1;
    idxOut[idxCursor + 2] = base + 2;
    idxOut[idxCursor + 3] = base;
    idxOut[idxCursor + 4] = base + 2;
    idxOut[idxCursor + 5] = base + 3;

    vertCursor += 4;
    idxCursor += 6;
    emittedTriangles += 2;
    arcU = nextArcU;
  }

  return { vertCursor, idxCursor, emittedTriangles };
}
