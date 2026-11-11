import type { WoodMeshScratchBuffers } from '../../../core/destruction/woodPolygonClipper.ts';
import {
  DEFAULT_WOOD_STUD_SPACING_M,
  DEFAULT_WOOD_STUD_WIDTH_M,
  STUD_VERTICAL_SECTION_COUNT,
  STUD_SECTION_MAX_HP,
  type StudColumnState,
  type StudSectionState,
} from './woodWallTypes.ts';

export function computeWallStudPositionsU(
  widthM: number,
  studSpacingM = DEFAULT_WOOD_STUD_SPACING_M,
  studWidthM = DEFAULT_WOOD_STUD_WIDTH_M,
): number[] {
  const halfStudW = studWidthM * 0.5;
  if (widthM <= studWidthM * 2.2) return [widthM * 0.5];

  const positions: number[] = [halfStudW];
  const rightEdgeU = widthM - halfStudW;
  const safeSpacing = Math.max(0.18, studSpacingM);

  for (let stepIdx = 1; ; stepIdx++) {
    const u = Math.round(stepIdx * safeSpacing * 1_000_000) / 1_000_000;
    if (u >= rightEdgeU - studWidthM * 1.15) break;
    positions.push(u);
  }
  positions.push(rightEdgeU);
  return positions;
}

export function createInitialStudColumns(
  heightM: number,
  plateHeightM: number,
  studPositionsU: readonly number[],
): StudColumnState[] {
  const vBottom = plateHeightM;
  const vTop = Math.max(vBottom + 0.02, heightM - plateHeightM);
  const spanH = vTop - vBottom;
  const secCount = STUD_VERTICAL_SECTION_COUNT;
  const columns: StudColumnState[] = [];

  for (let i = 0; i < studPositionsU.length; i++) {
    const isBorderPost = studPositionsU.length >= 3 && (i === 0 || i === studPositionsU.length - 1);
    const sections: StudSectionState[] = [];
    if (isBorderPost) {
      sections.push({ vMin: vBottom, vMax: vTop, hp: Infinity, broken: false });
    } else {
      for (let s = 0; s < secCount; s++) {
        sections.push({
          vMin: vBottom + (spanH * s) / secCount,
          vMax: vBottom + (spanH * (s + 1)) / secCount,
          hp: STUD_SECTION_MAX_HP,
          broken: false,
        });
      }
    }
    columns.push({ u: studPositionsU[i], isBorderPost, sections });
  }
  return columns;
}

export interface IntactStudSpan {
  vMin: number;
  vMax: number;
  brokenBottom: boolean;
  brokenTop: boolean;
}

export function collectIntactStudSpans(col: StudColumnState): IntactStudSpan[] {
  const spans: IntactStudSpan[] = [];
  let s = 0;
  const n = col.sections.length;
  while (s < n) {
    if (col.sections[s].broken) {
      s++;
      continue;
    }
    const startIdx = s;
    while (s + 1 < n && !col.sections[s + 1].broken) s++;
    const endIdx = s;
    spans.push({
      vMin: col.sections[startIdx].vMin,
      vMax: col.sections[endIdx].vMax,
      brokenBottom: startIdx > 0,
      brokenTop: endIdx < n - 1,
    });
    s++;
  }
  return spans;
}

export function writeWallStudFrameBuffers(
  widthM: number,
  heightM: number,
  visualDepthM: number,
  plateHeightM: number,
  studColumns: readonly StudColumnState[],
  buffers: WoodMeshScratchBuffers,
  studWidthM = DEFAULT_WOOD_STUD_WIDTH_M,
): { vertexCount: number; indexCount: number } {
  const maxVerts = Math.floor(buffers.positions.length / 3);
  const maxIndices = buffers.indices.length;
  const posOut = buffers.positions;
  const normOut = buffers.normals;
  const uvOut = buffers.uvs;
  const idxOut = buffers.indices;

  let vertCursor = 0;
  let idxCursor = 0;

  const appendTri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ): void => {
    if (vertCursor + 3 > maxVerts || idxCursor + 3 > maxIndices) return;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-8) return;
    nx /= len; ny /= len; nz /= len;

    const base = vertCursor;
    const pts = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const pOff = (base + k) * 3;
      const uvOff = (base + k) * 2;
      posOut[pOff] = pts[k][0];
      posOut[pOff + 1] = pts[k][1];
      posOut[pOff + 2] = pts[k][2];
      normOut[pOff] = nx;
      normOut[pOff + 1] = ny;
      normOut[pOff + 2] = nz;
      uvOut[uvOff] = (k & 1) * 0.5;
      uvOut[uvOff + 1] = k === 2 ? 1 : 0;
    }
    idxOut[idxCursor] = base;
    idxOut[idxCursor + 1] = base + 1;
    idxOut[idxCursor + 2] = base + 2;
    vertCursor += 3;
    idxCursor += 3;
  };

  const appendBox = (cx: number, cy: number, cz: number, wx: number, wy: number, wz: number): void => {
    if (vertCursor + 24 > maxVerts || idxCursor + 36 > maxIndices) return;
    const hx = wx * 0.5, hy = wy * 0.5, hz = wz * 0.5;
    const faces = [
      { n: [0, 0, 1], verts: [[cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]], uSpan: wx * 4, vSpan: wy * 2 },
      { n: [0, 0, -1], verts: [[cx + hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz - hz], [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz]], uSpan: wx * 4, vSpan: wy * 2 },
      { n: [1, 0, 0], verts: [[cx + hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz]], uSpan: wz * 4, vSpan: wy * 2 },
      { n: [-1, 0, 0], verts: [[cx - hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz - hz]], uSpan: wz * 4, vSpan: wy * 2 },
      { n: [0, 1, 0], verts: [[cx - hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz]], uSpan: wx * 2, vSpan: wz * 4 },
      { n: [0, -1, 0], verts: [[cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz + hz], [cx - hx, cy - hy, cz + hz]], uSpan: wx * 2, vSpan: wz * 4 },
    ];
    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      const base = vertCursor;
      for (let k = 0; k < 4; k++) {
        const pOff = (base + k) * 3;
        posOut[pOff] = face.verts[k][0];
        posOut[pOff + 1] = face.verts[k][1];
        posOut[pOff + 2] = face.verts[k][2];
        normOut[pOff] = face.n[0];
        normOut[pOff + 1] = face.n[1];
        normOut[pOff + 2] = face.n[2];
      }
      let uvOff = base * 2;
      uvOut[uvOff] = 0; uvOut[uvOff + 1] = 0; uvOff += 2;
      uvOut[uvOff] = face.uSpan; uvOut[uvOff + 1] = 0; uvOff += 2;
      uvOut[uvOff] = face.uSpan; uvOut[uvOff + 1] = face.vSpan; uvOff += 2;
      uvOut[uvOff] = 0; uvOut[uvOff + 1] = face.vSpan;
      idxOut[idxCursor] = base; idxOut[idxCursor + 1] = base + 1; idxOut[idxCursor + 2] = base + 2;
      idxOut[idxCursor + 3] = base; idxOut[idxCursor + 4] = base + 2; idxOut[idxCursor + 5] = base + 3;
      vertCursor += 4; idxCursor += 6;
    }
  };

  const appendJaggedBrokenCap = (cx: number, baseY: number, dirSignY: 1 | -1, wx: number, wz: number): void => {
    const hx = wx * 0.5, hz = wz * 0.5;
    const tipA: [number, number, number] = [cx - hx * 0.42, baseY + 0.045 * dirSignY, hz * 0.25];
    const tipB: [number, number, number] = [cx + hx * 0.48, baseY + 0.038 * dirSignY, -hz * 0.28];
    const c00: [number, number, number] = [cx - hx, baseY, hz];
    const c10: [number, number, number] = [cx, baseY, hz];
    const c11: [number, number, number] = [cx, baseY, -hz];
    const c01: [number, number, number] = [cx - hx, baseY, -hz];
    const d00: [number, number, number] = [cx, baseY, hz];
    const d10: [number, number, number] = [cx + hx, baseY, hz];
    const d11: [number, number, number] = [cx + hx, baseY, -hz];
    const d01: [number, number, number] = [cx, baseY, -hz];

    if (dirSignY > 0) {
      appendTri(c00, c10, tipA); appendTri(c10, c11, tipA); appendTri(c11, c01, tipA); appendTri(c01, c00, tipA);
      appendTri(d00, d10, tipB); appendTri(d10, d11, tipB); appendTri(d11, d01, tipB); appendTri(d01, d00, tipB);
    } else {
      appendTri(c10, c00, tipA); appendTri(c11, c10, tipA); appendTri(c01, c11, tipA); appendTri(c00, c01, tipA);
      appendTri(d10, d00, tipB); appendTri(d11, d10, tipB); appendTri(d01, d11, tipB); appendTri(d00, d01, tipB);
    }
  };

  const halfW = widthM * 0.5, halfH = heightM * 0.5;
  appendBox(0, -halfH + plateHeightM * 0.5, 0, widthM, plateHeightM, visualDepthM);
  appendBox(0, halfH - plateHeightM * 0.5, 0, widthM, plateHeightM, visualDepthM);

  for (let i = 0; i < studColumns.length; i++) {
    const col = studColumns[i];
    const cx = col.u - halfW;
    const spans = collectIntactStudSpans(col);
    for (let s = 0; s < spans.length; s++) {
      const span = spans[s];
      const spanH = span.vMax - span.vMin;
      if (spanH < 0.01) continue;
      const cy = (span.vMin + span.vMax) * 0.5 - halfH;
      appendBox(cx, cy, 0, studWidthM, spanH, visualDepthM);
      if (span.brokenTop) appendJaggedBrokenCap(cx, span.vMax - halfH, 1, studWidthM, visualDepthM);
      if (span.brokenBottom) appendJaggedBrokenCap(cx, span.vMin - halfH, -1, studWidthM, visualDepthM);
    }
  }

  return { vertexCount: vertCursor, indexCount: idxCursor };
}
