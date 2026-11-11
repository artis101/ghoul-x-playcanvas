import type { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  FOUNDATION_NEIGHBOR_TAG,
  OUTER_BOUNDARY_NEIGHBOR_TAG,
  type PolyFace3D,
} from './voronoiWallTypes.ts';

export function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dot3(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a: Vec3Like, b: Vec3Like): Vec3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function normalize3(v: Vec3Like): Vec3Like {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-9) {
    return { x: 0, y: 1, z: 0 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function computePolygonArea(vertices: readonly Vec3Like[]): number {
  if (vertices.length < 3) {
    return 0;
  }
  let ax = 0;
  let ay = 0;
  let az = 0;
  const p0 = vertices[0];
  for (let i = 1; i < vertices.length - 1; i++) {
    const p1 = vertices[i];
    const p2 = vertices[i + 1];
    const v1x = p1.x - p0.x;
    const v1y = p1.y - p0.y;
    const v1z = p1.z - p0.z;
    const v2x = p2.x - p0.x;
    const v2y = p2.y - p0.y;
    const v2z = p2.z - p0.z;
    ax += v1y * v2z - v1z * v2y;
    ay += v1z * v2x - v1x * v2z;
    az += v1x * v2y - v1y * v2x;
  }
  return 0.5 * Math.hypot(ax, ay, az);
}

export function createInitialBoxFaces(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): PolyFace3D[] {
  return [
    {
      normal: { x: -1, y: 0, z: 0 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: minX, y: minY, z: minZ },
        { x: minX, y: minY, z: maxZ },
        { x: minX, y: maxY, z: maxZ },
        { x: minX, y: maxY, z: minZ },
      ],
    },
    {
      normal: { x: 1, y: 0, z: 0 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: maxX, y: minY, z: minZ },
        { x: maxX, y: maxY, z: minZ },
        { x: maxX, y: maxY, z: maxZ },
        { x: maxX, y: minY, z: maxZ },
      ],
    },
    {
      normal: { x: 0, y: -1, z: 0 },
      neighborTag: FOUNDATION_NEIGHBOR_TAG,
      vertices: [
        { x: minX, y: minY, z: minZ },
        { x: maxX, y: minY, z: minZ },
        { x: maxX, y: minY, z: maxZ },
        { x: minX, y: minY, z: maxZ },
      ],
    },
    {
      normal: { x: 0, y: 1, z: 0 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: minX, y: maxY, z: minZ },
        { x: minX, y: maxY, z: maxZ },
        { x: maxX, y: maxY, z: maxZ },
        { x: maxX, y: maxY, z: minZ },
      ],
    },
    {
      normal: { x: 0, y: 0, z: -1 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: minX, y: minY, z: minZ },
        { x: minX, y: maxY, z: minZ },
        { x: maxX, y: maxY, z: minZ },
        { x: maxX, y: minY, z: minZ },
      ],
    },
    {
      normal: { x: 0, y: 0, z: 1 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: minX, y: minY, z: maxZ },
        { x: maxX, y: minY, z: maxZ },
        { x: maxX, y: maxY, z: maxZ },
        { x: minX, y: maxY, z: maxZ },
      ],
    },
  ];
}

export function projectBoxUv(point: Vec3Like, normal: Vec3Like, uvScale = 0.5): [number, number] {
  const nx = Math.abs(normal.x);
  const ny = Math.abs(normal.y);
  const nz = Math.abs(normal.z);
  if (nx >= ny && nx >= nz) {
    return [point.z * uvScale, point.y * uvScale];
  }
  if (ny >= nx && ny >= nz) {
    return [point.x * uvScale, point.z * uvScale];
  }
  return [point.x * uvScale, point.y * uvScale];
}

export function computePolyhedronVolumeAndCentroid(faces: readonly PolyFace3D[]): {
  volume: number;
  centroid: Vec3Like;
} {
  let totalVol = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const v = face.vertices;
    if (v.length < 3) continue;

    for (let i = 1; i < v.length - 1; i++) {
      const p1 = v[0];
      const p2 = v[i];
      const p3 = v[i + 1];

      const tetVol6 =
        p1.x * (p2.y * p3.z - p2.z * p3.y) +
        p1.y * (p2.z * p3.x - p2.x * p3.z) +
        p1.z * (p2.x * p3.y - p2.y * p3.x);

      const tetVol = tetVol6 / 6.0;
      totalVol += tetVol;
      cx += (tetVol / 4.0) * (p1.x + p2.x + p3.x);
      cy += (tetVol / 4.0) * (p1.y + p2.y + p3.y);
      cz += (tetVol / 4.0) * (p1.z + p2.z + p3.z);
    }
  }

  if (Math.abs(totalVol) < 1e-9) {
    return { volume: 0, centroid: { x: 0, y: 0, z: 0 } };
  }

  return {
    volume: Math.abs(totalVol),
    centroid: { x: cx / totalVol, y: cy / totalVol, z: cz / totalVol },
  };
}
