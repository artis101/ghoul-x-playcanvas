import { Clipper, type Path64, type Paths64 } from 'clipper2-js';
import earcut from 'earcut';
import {
  INV_WOOD_CLIPPER_AREA_SCALE,
  INV_WOOD_CLIPPER_SCALE,
} from './woodClipperTypes.ts';

export const MIN_SAWN_WOOD_SLAB_AREA_M2 = 0.025;

export interface ExtrudedWoodSlabMesh {
  /** Center of mass in wall-local coordinates (meters, relative to wall center) */
  localCenter: { x: number; y: number; z: number };
  /** Vertex positions relative to `localCenter` (`vertexCount * 3`) */
  localPositions: Float32Array;
  /** Vertex normals (`vertexCount * 3`) */
  normals: Float32Array;
  /** Texture coordinates (`vertexCount * 2`) */
  uvs: Float32Array;
  /** Triangle indices (`indexCount`) */
  indices: Uint32Array;
  /** 3D vertices (`N * 3`) relative to `localCenter` for Rapier convex-hull collider */
  hullVertices: Float32Array;
  /** Surface area of the detached slab in square meters */
  areaM2: number;
  /** Physical mass of the slab in kilograms */
  massKg: number;
}

export function extrudeWoodIslandToSlab(
  islandPath: Path64,
  wallWidthM: number,
  wallHeightM: number,
  wallThicknessM: number,
  minAreaM2 = MIN_SAWN_WOOD_SLAB_AREA_M2,
): ExtrudedWoodSlabMesh | null {
  const n = islandPath.length;
  if (n < 3) return null;

  const areaM2 = Math.abs(Clipper.area(islandPath)) * INV_WOOD_CLIPPER_AREA_SCALE;
  if (areaM2 < minAreaM2) return null;

  const halfW = wallWidthM * 0.5;
  const halfH = wallHeightM * 0.5;
  const halfZ = Math.max(0.012, wallThicknessM * 0.5);
  const invW = 1 / Math.max(1e-4, wallWidthM);
  const invH = 1 / Math.max(1e-4, wallHeightM);

  const flatUV: number[] = new Array(n * 2);
  let sumX = 0;
  let sumY = 0;

  for (let i = 0; i < n; i++) {
    const u = islandPath[i].x * INV_WOOD_CLIPPER_SCALE;
    const v = islandPath[i].y * INV_WOOD_CLIPPER_SCALE;
    flatUV[i * 2] = u;
    flatUV[i * 2 + 1] = v;
    sumX += u - halfW;
    sumY += v - halfH;
  }

  const triIndices = earcut(flatUV, undefined, 2);
  const triCount = Math.floor(triIndices.length / 3);
  if (triCount <= 0) return null;

  const cx = sumX / n;
  const cy = sumY / n;
  const cz = 0;

  // Vertices: n front + n back + 4*n rim
  const totalVerts = n * 2 + n * 4;
  const totalIndices = triCount * 6 + n * 6;

  const localPositions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalIndices);
  const maxHullRingPts = Math.min(n, 64);
  const hullVertices = new Float32Array(maxHullRingPts * 2 * 3);

  // Front & back cap vertices
  for (let i = 0; i < n; i++) {
    const u = flatUV[i * 2];
    const v = flatUV[i * 2 + 1];
    const lx = u - halfW - cx;
    const ly = v - halfH - cy;

    const fPosOff = i * 3;
    localPositions[fPosOff] = lx;
    localPositions[fPosOff + 1] = ly;
    localPositions[fPosOff + 2] = halfZ;
    normals[fPosOff] = 0;
    normals[fPosOff + 1] = 0;
    normals[fPosOff + 2] = 1;
    uvs[i * 2] = u * invW;
    uvs[i * 2 + 1] = 0.02 + v * invH * 0.8;

    const bIdx = n + i;
    const bPosOff = bIdx * 3;
    localPositions[bPosOff] = lx;
    localPositions[bPosOff + 1] = ly;
    localPositions[bPosOff + 2] = -halfZ;
    normals[bPosOff] = 0;
    normals[bPosOff + 1] = 0;
    normals[bPosOff + 2] = -1;
    uvs[bIdx * 2] = (wallWidthM - u) * invW;
    uvs[bIdx * 2 + 1] = 0.02 + v * invH * 0.8;
  }

  for (let h = 0; h < maxHullRingPts; h++) {
    const srcIdx = Math.min(n - 1, Math.floor((h * n) / maxHullRingPts));
    const lx = flatUV[srcIdx * 2] - halfW - cx;
    const ly = flatUV[srcIdx * 2 + 1] - halfH - cy;
    const hFront = h * 6;
    hullVertices[hFront] = lx;
    hullVertices[hFront + 1] = ly;
    hullVertices[hFront + 2] = halfZ;
    hullVertices[hFront + 3] = lx;
    hullVertices[hFront + 4] = ly;
    hullVertices[hFront + 5] = -halfZ;
  }

  let idxCursor = 0;
  for (let t = 0; t < triIndices.length; t += 3) {
    const i0 = triIndices[t];
    const i1 = triIndices[t + 1];
    const i2 = triIndices[t + 2];

    const u0 = flatUV[i0 * 2], v0 = flatUV[i0 * 2 + 1];
    const u1 = flatUV[i1 * 2], v1 = flatUV[i1 * 2 + 1];
    const u2 = flatUV[i2 * 2], v2 = flatUV[i2 * 2 + 1];
    const crossZ = (u1 - u0) * (v2 - v0) - (v1 - v0) * (u2 - u0);

    const a = i0;
    const b = crossZ >= 0 ? i1 : i2;
    const c = crossZ >= 0 ? i2 : i1;

    indices[idxCursor++] = a;
    indices[idxCursor++] = b;
    indices[idxCursor++] = c;

    indices[idxCursor++] = n + a;
    indices[idxCursor++] = n + c;
    indices[idxCursor++] = n + b;
  }

  // Extrude perimeter rim quads
  let vertCursor = n * 2;
  let arcDist = 0;
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const u0 = flatUV[i * 2], v0 = flatUV[i * 2 + 1];
    const u1 = flatUV[next * 2], v1 = flatUV[next * 2 + 1];
    const du = u1 - u0;
    const dv = v1 - v0;
    const segLen = Math.hypot(du, dv);
    const nx = segLen > 1e-6 ? dv / segLen : 1;
    const ny = segLen > 1e-6 ? -du / segLen : 0;

    const x0 = u0 - halfW - cx;
    const y0 = v0 - halfH - cy;
    const x1 = u1 - halfW - cx;
    const y1 = y0 + dv;

    const baseV = vertCursor;
    const coords = [
      [x0, y0, halfZ, arcDist, 0.88],
      [x1, y1, halfZ, arcDist + segLen, 0.88],
      [x1, y1, -halfZ, arcDist + segLen, 0.99],
      [x0, y0, -halfZ, arcDist, 0.99],
    ];
    for (let k = 0; k < 4; k++) {
      const pOff = (baseV + k) * 3;
      const uvOff = (baseV + k) * 2;
      localPositions[pOff] = coords[k][0];
      localPositions[pOff + 1] = coords[k][1];
      localPositions[pOff + 2] = coords[k][2];
      normals[pOff] = nx;
      normals[pOff + 1] = ny;
      normals[pOff + 2] = 0;
      uvs[uvOff] = coords[k][3];
      uvs[uvOff + 1] = coords[k][4];
    }
    vertCursor += 4;
    arcDist += segLen;

    indices[idxCursor++] = baseV;
    indices[idxCursor++] = baseV + 2;
    indices[idxCursor++] = baseV + 1;

    indices[idxCursor++] = baseV;
    indices[idxCursor++] = baseV + 3;
    indices[idxCursor++] = baseV + 2;
  }

  const massKg = Math.max(0.35, areaM2 * Math.max(0.025, wallThicknessM) * 580);

  return {
    localCenter: { x: cx, y: cy, z: cz },
    localPositions,
    normals,
    uvs,
    indices,
    hullVertices,
    areaM2,
    massKg,
  };
}

export function extrudeDroppedWoodSlabs(
  droppedIslands: Paths64,
  wallWidthM: number,
  wallHeightM: number,
  wallThicknessM: number,
  minAreaM2 = MIN_SAWN_WOOD_SLAB_AREA_M2,
): ExtrudedWoodSlabMesh[] {
  const slabs: ExtrudedWoodSlabMesh[] = [];
  for (let i = 0; i < droppedIslands.length; i++) {
    const slab = extrudeWoodIslandToSlab(
      droppedIslands[i],
      wallWidthM,
      wallHeightM,
      wallThicknessM,
      minAreaM2,
    );
    if (slab) {
      slabs.push(slab);
    }
  }
  return slabs;
}
