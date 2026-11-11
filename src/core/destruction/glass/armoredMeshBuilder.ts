import {
  ARMORED_CHUNK_DETACHED,
  ARMORED_CHUNK_FRACTURED,
  ARMORED_CHUNK_PRISTINE,
  type ArmoredMeshBuildStats,
  type Point2D,
} from './glassShardTypes.ts';
import type { ArmoredVoronoiGlassPane } from './armoredGlassState.ts';

export function writeArmoredMeshBuffers(
  pane: ArmoredVoronoiGlassPane,
  outPositions: Float32Array,
  outNormals: Float32Array,
  outUvs: Float32Array,
  outColors: Float32Array,
  outIndices: Uint16Array,
): ArmoredMeshBuildStats {
  const maxVerts = Math.min(65500, Math.floor(outPositions.length / 3), Math.floor(outColors.length / 4));
  const maxIndices = outIndices.length;

  const halfW = pane.widthM * 0.5;
  const halfH = pane.heightM * 0.5;
  const halfZ = pane.thicknessM * 0.5;
  const invW = 1 / pane.widthM;
  const invH = 1 / pane.heightM;
  const frameEps = 1.5e-4;

  let vCursor = 0;
  let iCursor = 0;
  let emittedChunks = 0;

  const pushVert = (
    x2d: number, y2d: number, vz: number,
    nx: number, ny: number, nz: number,
    r: number, g: number, b: number, a: number,
  ): number => {
    const idx = vCursor++;
    const p3 = idx * 3, p2 = idx * 2, p4 = idx * 4;
    outPositions[p3] = x2d - halfW; outPositions[p3 + 1] = y2d - halfH; outPositions[p3 + 2] = vz;
    outNormals[p3] = nx; outNormals[p3 + 1] = ny; outNormals[p3 + 2] = nz;
    outUvs[p2] = x2d * invW; outUvs[p2 + 1] = y2d * invH;
    outColors[p4] = r; outColors[p4 + 1] = g; outColors[p4 + 2] = b; outColors[p4 + 3] = a;
    return idx;
  };

  const emitCrackStrip2D = (ax: number, ay: number, bx: number, by: number, halfWidthM: number, alpha: number): void => {
    if (vCursor + 8 > maxVerts || iCursor + 12 > maxIndices) return;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len < 1e-4) return;
    const px = (-dy / len) * halfWidthM, py = (dx / len) * halfWidthM;
    const zFront = halfZ + 0.00028;
    const f0 = pushVert(ax - px, ay - py, zFront, 0, 0, 1, 0.96, 1.0, 1.0, alpha);
    const f1 = pushVert(bx - px, by - py, zFront, 0, 0, 1, 0.96, 1.0, 1.0, alpha);
    const f2 = pushVert(bx + px, by + py, zFront, 0, 0, 1, 0.96, 1.0, 1.0, alpha);
    const f3 = pushVert(ax + px, ay + py, zFront, 0, 0, 1, 0.96, 1.0, 1.0, alpha);
    outIndices[iCursor++] = f0; outIndices[iCursor++] = f1; outIndices[iCursor++] = f2;
    outIndices[iCursor++] = f0; outIndices[iCursor++] = f2; outIndices[iCursor++] = f3;

    const zBack = -halfZ - 0.00028;
    const b0 = pushVert(ax - px, ay - py, zBack, 0, 0, -1, 0.96, 1.0, 1.0, alpha);
    const b1 = pushVert(bx - px, by - py, zBack, 0, 0, -1, 0.96, 1.0, 1.0, alpha);
    const b2 = pushVert(bx + px, by + py, zBack, 0, 0, -1, 0.96, 1.0, 1.0, alpha);
    const b3 = pushVert(ax + px, ay + py, zBack, 0, 0, -1, 0.96, 1.0, 1.0, alpha);
    outIndices[iCursor++] = b0; outIndices[iCursor++] = b2; outIndices[iCursor++] = b1;
    outIndices[iCursor++] = b0; outIndices[iCursor++] = b3; outIndices[iCursor++] = b2;
  };

  const emitEdgeBevelQuad = (p0: Point2D, p1: Point2D, r: number, g: number, b: number, a: number): void => {
    if (vCursor + 4 > maxVerts || iCursor + 6 > maxIndices) return;
    const edx = p1.x - p0.x, edy = p1.y - p0.y, eLen = Math.hypot(edx, edy);
    if (eLen < 1e-5) return;
    const nx = edy / eLen, ny = -edx / eLen;
    const v0 = pushVert(p0.x, p0.y, halfZ, nx, ny, 0, r, g, b, a);
    const v1 = pushVert(p1.x, p1.y, halfZ, nx, ny, 0, r, g, b, a);
    const v2 = pushVert(p1.x, p1.y, -halfZ, nx, ny, 0, r, g, b, a);
    const v3 = pushVert(p0.x, p0.y, -halfZ, nx, ny, 0, r, g, b, a);
    outIndices[iCursor++] = v0; outIndices[iCursor++] = v3; outIndices[iCursor++] = v2;
    outIndices[iCursor++] = v0; outIndices[iCursor++] = v2; outIndices[iCursor++] = v1;
  };

  const findNeighborAcrossEdge = (chunkIdx: number, p0: Point2D, p1: Point2D): number => {
    const nbrs = pane.chunks[chunkIdx].neighbors;
    const mx = (p0.x + p1.x) * 0.5, my = (p0.y + p1.y) * 0.5;
    for (let k = 0; k < nbrs.length; k++) {
      const nIdx = nbrs[k], nPoly = pane.chunks[nIdx].polygon;
      for (let j = 0; j < nPoly.length; j++) {
        const q0 = nPoly[j], q1 = nPoly[(j + 1) % nPoly.length];
        if (Math.abs(mx - (q0.x + q1.x) * 0.5) < 1.5e-3 && Math.abs(my - (q0.y + q1.y) * 0.5) < 1.5e-3) return nIdx;
      }
    }
    return -1;
  };

  for (let c = 0; c < pane.chunks.length; c++) {
    const st = pane.stage[c];
    if (st === ARMORED_CHUNK_DETACHED) continue;
    const chunk = pane.chunks[c], poly = chunk.polygon, n = poly.length;
    if (n < 3 || vCursor + n * 16 > maxVerts || iCursor + n * 30 > maxIndices) continue;
    emittedChunks++;

    if (st === ARMORED_CHUNK_PRISTINE) {
      const fBase = vCursor;
      for (let i = 0; i < n; i++) pushVert(poly[i].x, poly[i].y, halfZ, 0, 0, 1, 0.72, 0.92, 0.91, 0.46);
      for (let i = 1; i < n - 1; i++) {
        outIndices[iCursor++] = fBase; outIndices[iCursor++] = fBase + i; outIndices[iCursor++] = fBase + i + 1;
      }
      const bBase = vCursor;
      for (let i = 0; i < n; i++) pushVert(poly[i].x, poly[i].y, -halfZ, 0, 0, -1, 0.72, 0.92, 0.91, 0.46);
      for (let i = 1; i < n - 1; i++) {
        outIndices[iCursor++] = bBase; outIndices[iCursor++] = bBase + i + 1; outIndices[iCursor++] = bBase + i;
      }
      for (let i = 0; i < n; i++) {
        const p0 = poly[i], p1 = poly[(i + 1) % n];
        const onFrame = (p0.x <= frameEps && p1.x <= frameEps) || (p0.x >= pane.widthM - frameEps && p1.x >= pane.widthM - frameEps) ||
                        (p0.y <= frameEps && p1.y <= frameEps) || (p0.y >= pane.heightM - frameEps && p1.y >= pane.heightM - frameEps);
        if (onFrame) {
          emitEdgeBevelQuad(p0, p1, 0.42, 0.62, 0.64, 0.65);
        } else {
          const nbr = findNeighborAcrossEdge(c, p0, p1);
          if (nbr >= 0 && pane.stage[nbr] === ARMORED_CHUNK_DETACHED) emitEdgeBevelQuad(p0, p1, 0.96, 1.0, 1.0, 0.94);
        }
      }
    } else {
      const craze = Math.max(0.25, pane.crazedIntensity[c]), isHeavy = st === ARMORED_CHUNK_FRACTURED;
      let minInradius = Infinity;
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n], edx = b.x - a.x, edy = b.y - a.y, eLen = Math.hypot(edx, edy);
        if (eLen > 1e-6) {
          const distEdge = Math.abs(edx * (chunk.centroid.y - a.y) - edy * (chunk.centroid.x - a.x)) / eLen;
          if (distEdge < minInradius) minInradius = distEdge;
        }
      }
      const fdx = pane.focusX[c] - chunk.centroid.x, fdy = pane.focusY[c] - chunk.centroid.y, fLen = Math.hypot(fdx, fdy);
      const maxShift = Number.isFinite(minInradius) ? minInradius * 0.36 : 0;
      const shiftScale = fLen > 1e-5 ? Math.min(0.32, maxShift / fLen) : 0;
      const hubX = chunk.centroid.x + fdx * shiftScale, hubY = chunk.centroid.y + fdy * shiftScale;

      const hubR = 0.91 + 0.08 * craze, hubG = 0.98 + 0.02 * craze, hubB = 1.0, hubA = (isHeavy ? 0.68 : 0.54) + 0.22 * craze;
      const rimR = 0.80 + 0.14 * craze, rimG = 0.94 + 0.05 * craze, rimB = 0.97 + 0.03 * craze, rimA = (isHeavy ? 0.58 : 0.48) + 0.18 * craze;
      const tiltStrength = (isHeavy ? 0.085 : 0.045) * craze;

      for (let i = 0; i < n; i++) {
        const p0 = poly[i], p1 = poly[(i + 1) % n], phase = (c * 1.73 + i * 2.39);
        const fnx = (pane.chunkFacetTiltX[c] * 0.5 + Math.cos(phase) * 0.5) * tiltStrength;
        const fny = (pane.chunkFacetTiltY[c] * 0.5 + Math.sin(phase) * 0.5) * tiltStrength;
        const fnz = Math.sqrt(Math.max(0.5, 1 - fnx * fnx - fny * fny));

        const vf0 = pushVert(hubX, hubY, halfZ, fnx, fny, fnz, hubR, hubG, hubB, hubA);
        const vf1 = pushVert(p0.x, p0.y, halfZ, fnx, fny, fnz, rimR, rimG, rimB, rimA);
        const vf2 = pushVert(p1.x, p1.y, halfZ, fnx, fny, fnz, rimR, rimG, rimB, rimA);
        outIndices[iCursor++] = vf0; outIndices[iCursor++] = vf1; outIndices[iCursor++] = vf2;

        const vb0 = pushVert(hubX, hubY, -halfZ, -fnx, -fny, -fnz, hubR, hubG, hubB, hubA);
        const vb1 = pushVert(p1.x, p1.y, -halfZ, -fnx, -fny, -fnz, rimR, rimG, rimB, rimA);
        const vb2 = pushVert(p0.x, p0.y, -halfZ, -fnx, -fny, -fnz, rimR, rimG, rimB, rimA);
        outIndices[iCursor++] = vb0; outIndices[iCursor++] = vb1; outIndices[iCursor++] = vb2;
      }

      const crackHalfW = isHeavy ? 0.0015 : 0.0010, crackAlpha = (isHeavy ? 0.76 : 0.54) + 0.20 * craze;
      for (let i = 0; i < n; i++) {
        const p0 = poly[i], p1 = poly[(i + 1) % n];
        const onFrame = (p0.x <= frameEps && p1.x <= frameEps) || (p0.x >= pane.widthM - frameEps && p1.x >= pane.widthM - frameEps) ||
                        (p0.y <= frameEps && p1.y <= frameEps) || (p0.y >= pane.heightM - frameEps && p1.y >= pane.heightM - frameEps);
        if (onFrame) {
          emitEdgeBevelQuad(p0, p1, 0.52, 0.72, 0.75, 0.72);
          continue;
        }
        const nbr = findNeighborAcrossEdge(c, p0, p1);
        if (nbr < 0 || pane.stage[nbr] === ARMORED_CHUNK_DETACHED) {
          emitEdgeBevelQuad(p0, p1, 0.97, 1.0, 1.0, 0.96);
          emitCrackStrip2D(p0.x, p0.y, p1.x, p1.y, crackHalfW * 1.15, 0.94);
        } else if (pane.stage[nbr] === ARMORED_CHUNK_PRISTINE || c < nbr) {
          emitEdgeBevelQuad(p0, p1, 0.92, 0.99, 1.0, 0.30 + 0.36 * craze);
          emitCrackStrip2D(p0.x, p0.y, p1.x, p1.y, crackHalfW, crackAlpha);
        }
      }

      if (isHeavy) {
        const spokeStep = n > 6 ? 2 : 1;
        for (let i = 0; i < n; i += spokeStep) {
          const p = poly[i];
          emitCrackStrip2D(hubX, hubY, p.x, p.y, 0.0011, crackAlpha * 0.88);
          const pNext = poly[(i + 1) % n], tA = 0.48 + ((c + i) % 3) * 0.09, tB = 0.54 + ((c + i + 1) % 3) * 0.08;
          emitCrackStrip2D(hubX + (p.x - hubX) * tA, hubY + (p.y - hubY) * tA, hubX + (pNext.x - hubX) * tB, hubY + (pNext.y - hubY) * tB, 0.00085, crackAlpha * 0.72);
        }
      } else if (craze > 0.38) {
        emitCrackStrip2D(hubX, hubY, poly[c % n].x, poly[c % n].y, 0.0008, crackAlpha * 0.65);
        emitCrackStrip2D(hubX, hubY, poly[(c + Math.max(1, Math.floor(n / 2))) % n].x, poly[(c + Math.max(1, Math.floor(n / 2))) % n].y, 0.0008, crackAlpha * 0.65);
      }
    }
  }

  return { survivingChunks: emittedChunks, vertexCount: vCursor, indexCount: iCursor };
}
