import {
  DEFAULT_VORONOI_SHARD_THICKNESS_M,
  type ExtrudedGlassShardGeometry,
  type Point2D,
} from './glassShardTypes.ts';
import { computeSignedPolygonArea2D } from './polygonMath2D.ts';

export function extrudeConvexShard2D(
  polygon: readonly Point2D[],
  centroid: Point2D,
  widthM: number,
  heightM: number,
  thicknessM = DEFAULT_VORONOI_SHARD_THICKNESS_M,
): ExtrudedGlassShardGeometry {
  const n = polygon.length;
  if (n < 3) {
    return {
      polygonVertexCount: 0,
      localPositions: new Float32Array(0),
      localNormals: new Float32Array(0),
      localUvs: new Float32Array(0),
      localIndices: new Uint16Array(0),
      vertexCount: 0,
      indexCount: 0,
    };
  }

  const isCcw = computeSignedPolygonArea2D(polygon) >= 0;
  const ordered: Point2D[] = isCcw ? polygon.slice() : polygon.slice().reverse();

  const halfZ = Math.max(0.0005, thicknessM * 0.5);
  const invW = widthM > 1e-6 ? 1 / widthM : 1;
  const invH = heightM > 1e-6 ? 1 / heightM : 1;

  const vertexCount = 6 * n;
  const indexCount = 12 * n - 12;

  const localPositions = new Float32Array(vertexCount * 3);
  const localNormals = new Float32Array(vertexCount * 3);
  const localUvs = new Float32Array(vertexCount * 2);
  const localIndices = new Uint16Array(indexCount);

  let vIdx = 0;
  let iIdx = 0;

  // 1. Front face: vertices [0 .. n - 1] at z = +halfZ, normal (0, 0, +1)
  const frontBase = vIdx;
  for (let i = 0; i < n; i++) {
    const p = ordered[i];
    const p3 = vIdx * 3;
    const p2 = vIdx * 2;
    localPositions[p3] = p.x - centroid.x;
    localPositions[p3 + 1] = p.y - centroid.y;
    localPositions[p3 + 2] = halfZ;
    localNormals[p3] = 0;
    localNormals[p3 + 1] = 0;
    localNormals[p3 + 2] = 1;
    localUvs[p2] = p.x * invW;
    localUvs[p2 + 1] = p.y * invH;
    vIdx++;
  }
  for (let i = 1; i < n - 1; i++) {
    localIndices[iIdx++] = frontBase;
    localIndices[iIdx++] = frontBase + i;
    localIndices[iIdx++] = frontBase + i + 1;
  }

  // 2. Back face: vertices [n .. 2*n - 1] at z = -halfZ, normal (0, 0, -1), reversed winding
  const backBase = vIdx;
  for (let i = 0; i < n; i++) {
    const p = ordered[i];
    const p3 = vIdx * 3;
    const p2 = vIdx * 2;
    localPositions[p3] = p.x - centroid.x;
    localPositions[p3 + 1] = p.y - centroid.y;
    localPositions[p3 + 2] = -halfZ;
    localNormals[p3] = 0;
    localNormals[p3 + 1] = 0;
    localNormals[p3 + 2] = -1;
    localUvs[p2] = p.x * invW;
    localUvs[p2 + 1] = p.y * invH;
    vIdx++;
  }
  for (let i = 1; i < n - 1; i++) {
    localIndices[iIdx++] = backBase;
    localIndices[iIdx++] = backBase + i + 1;
    localIndices[iIdx++] = backBase + i;
  }

  // 3. Bevel / Rim perimeter quads: 4 vertices & 2 triangles per edge
  for (let i = 0; i < n; i++) {
    const p0 = ordered[i];
    const p1 = ordered[(i + 1) % n];

    const lx0 = p0.x - centroid.x;
    const ly0 = p0.y - centroid.y;
    const lx1 = p1.x - centroid.x;
    const ly1 = p1.y - centroid.y;

    const edx = lx1 - lx0;
    const edy = ly1 - ly0;
    const eLen = Math.hypot(edx, edy);
    const nx = eLen > 1e-8 ? edy / eLen : 1;
    const ny = eLen > 1e-8 ? -edx / eLen : 0;

    const rimBase = vIdx;

    const writeRimVert = (vx: number, vy: number, vz: number, uCoord: number, vCoord: number): void => {
      const p3 = vIdx * 3;
      const p2 = vIdx * 2;
      localPositions[p3] = vx;
      localPositions[p3 + 1] = vy;
      localPositions[p3 + 2] = vz;
      localNormals[p3] = nx;
      localNormals[p3 + 1] = ny;
      localNormals[p3 + 2] = 0;
      localUvs[p2] = uCoord;
      localUvs[p2 + 1] = vCoord;
      vIdx++;
    };

    writeRimVert(lx0, ly0, halfZ, p0.x * invW, p0.y * invH);
    writeRimVert(lx1, ly1, halfZ, p1.x * invW, p1.y * invH);
    writeRimVert(lx1, ly1, -halfZ, p1.x * invW, p1.y * invH);
    writeRimVert(lx0, ly0, -halfZ, p0.x * invW, p0.y * invH);

    localIndices[iIdx++] = rimBase;
    localIndices[iIdx++] = rimBase + 3;
    localIndices[iIdx++] = rimBase + 2;

    localIndices[iIdx++] = rimBase;
    localIndices[iIdx++] = rimBase + 2;
    localIndices[iIdx++] = rimBase + 1;
  }

  return {
    polygonVertexCount: n,
    localPositions,
    localNormals,
    localUvs,
    localIndices,
    vertexCount,
    indexCount,
  };
}
