import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { projectBoxUv } from './voronoi3DMath.ts';
import type { PolyFace3D } from './voronoiWallTypes.ts';

export interface ChunkGeometryResult {
  localPositions: Float32Array;
  wallSpacePositions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  hullVertices: Float32Array;
  halfExtents: Vec3Like;
}

export function buildChunkMeshGeometry(
  faces: readonly PolyFace3D[],
  centroid: Vec3Like,
  uniqueWallCorners: readonly Vec3Like[],
  totalFaceVerts: number,
  totalFaceIndices: number,
): ChunkGeometryResult {
  const localPositions = new Float32Array(totalFaceVerts * 3);
  const wallSpacePositions = new Float32Array(totalFaceVerts * 3);
  const normals = new Float32Array(totalFaceVerts * 3);
  const uvs = new Float32Array(totalFaceVerts * 2);
  const indices = new Uint32Array(totalFaceIndices);

  let vOut = 0;
  let iOut = 0;
  let minLx = Infinity;
  let minLy = Infinity;
  let minLz = Infinity;
  let maxLx = -Infinity;
  let maxLy = -Infinity;
  let maxLz = -Infinity;

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const fVerts = face.vertices;
    const vLen = fVerts.length;
    if (vLen < 3) continue;

    const baseV = vOut;
    const nx = face.normal.x;
    const ny = face.normal.y;
    const nz = face.normal.z;

    for (let v = 0; v < vLen; v++) {
      const wp = fVerts[v];
      const lx = wp.x - centroid.x;
      const ly = wp.y - centroid.y;
      const lz = wp.z - centroid.z;

      if (lx < minLx) minLx = lx;
      if (ly < minLy) minLy = ly;
      if (lz < minLz) minLz = lz;
      if (lx > maxLx) maxLx = lx;
      if (ly > maxLy) maxLy = ly;
      if (lz > maxLz) maxLz = lz;

      const p3 = vOut * 3;
      localPositions[p3] = lx;
      localPositions[p3 + 1] = ly;
      localPositions[p3 + 2] = lz;

      wallSpacePositions[p3] = wp.x;
      wallSpacePositions[p3 + 1] = wp.y;
      wallSpacePositions[p3 + 2] = wp.z;

      normals[p3] = nx;
      normals[p3 + 1] = ny;
      normals[p3 + 2] = nz;

      const [u, uvV] = projectBoxUv(wp, face.normal);
      const p2 = vOut * 2;
      uvs[p2] = u;
      uvs[p2 + 1] = uvV;

      vOut++;
    }

    for (let t = 1; t + 1 < vLen; t++) {
      indices[iOut++] = baseV;
      indices[iOut++] = baseV + t;
      indices[iOut++] = baseV + t + 1;
    }
  }

  const hullVertices = new Float32Array(uniqueWallCorners.length * 3);
  for (let c = 0; c < uniqueWallCorners.length; c++) {
    hullVertices[c * 3] = uniqueWallCorners[c].x - centroid.x;
    hullVertices[c * 3 + 1] = uniqueWallCorners[c].y - centroid.y;
    hullVertices[c * 3 + 2] = uniqueWallCorners[c].z - centroid.z;
  }

  const halfExtents: Vec3Like = {
    x: Number.isFinite(maxLx - minLx) ? Math.max(0.01, (maxLx - minLx) * 0.5) : 0.1,
    y: Number.isFinite(maxLy - minLy) ? Math.max(0.01, (maxLy - minLy) * 0.5) : 0.1,
    z: Number.isFinite(maxLz - minLz) ? Math.max(0.01, (maxLz - minLz) * 0.5) : 0.1,
  };

  return {
    localPositions,
    wallSpacePositions,
    normals,
    uvs,
    indices,
    hullVertices,
    halfExtents,
  };
}
