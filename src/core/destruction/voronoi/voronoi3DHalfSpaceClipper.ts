import type { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  CLIP_EPS,
  ON_PLANE_EPS,
  WELD_EPS_SQ,
  type PolyFace3D,
} from './voronoiWallTypes.ts';
import { cross3, dot3, normalize3 } from './voronoi3DMath.ts';

function addUniquePoint(list: Vec3Like[], pt: Vec3Like): void {
  for (let i = 0; i < list.length; i++) {
    const existing = list[i];
    const dx = existing.x - pt.x;
    const dy = existing.y - pt.y;
    const dz = existing.z - pt.z;
    if (dx * dx + dy * dy + dz * dz <= WELD_EPS_SQ) {
      return;
    }
  }
  list.push(pt);
}

export function clipConvexPolyhedronByHalfSpace(
  faces: PolyFace3D[],
  planePoint: Vec3Like,
  planeNormal: Vec3Like,
  neighborTag: number,
): PolyFace3D[] {
  const norm = normalize3(planeNormal);
  const newFaces: PolyFace3D[] = [];
  const cutPoints: Vec3Like[] = [];

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const v = face.vertices;
    if (v.length < 3) continue;

    const keptVertices: Vec3Like[] = [];
    const distances: number[] = new Array(v.length);

    for (let i = 0; i < v.length; i++) {
      const d = dot3({ x: v[i].x - planePoint.x, y: v[i].y - planePoint.y, z: v[i].z - planePoint.z }, norm);
      distances[i] = Math.abs(d) < ON_PLANE_EPS ? 0 : d;
    }

    for (let i = 0; i < v.length; i++) {
      const cur = v[i];
      const next = v[(i + 1) % v.length];
      const dCur = distances[i];
      const dNext = distances[(i + 1) % v.length];

      if (dCur <= 0) {
        keptVertices.push(cur);
      }

      if ((dCur < -CLIP_EPS && dNext > CLIP_EPS) || (dCur > CLIP_EPS && dNext < -CLIP_EPS)) {
        const denom = dCur - dNext;
        const t = Math.abs(denom) > 1e-9 ? dCur / denom : 0.5;
        const clampedT = Math.max(0, Math.min(1, t));
        const intersection: Vec3Like = {
          x: cur.x + (next.x - cur.x) * clampedT,
          y: cur.y + (next.y - cur.y) * clampedT,
          z: cur.z + (next.z - cur.z) * clampedT,
        };
        keptVertices.push(intersection);
        addUniquePoint(cutPoints, intersection);
      } else if (dCur === 0) {
        addUniquePoint(cutPoints, cur);
      }
    }

    if (keptVertices.length >= 3) {
      newFaces.push({
        normal: face.normal,
        neighborTag: face.neighborTag,
        vertices: keptVertices,
      });
    }
  }

  if (cutPoints.length < 3) {
    return newFaces;
  }

  let centerCutX = 0;
  let centerCutY = 0;
  let centerCutZ = 0;
  for (let i = 0; i < cutPoints.length; i++) {
    centerCutX += cutPoints[i].x;
    centerCutY += cutPoints[i].y;
    centerCutZ += cutPoints[i].z;
  }
  const invLen = 1 / cutPoints.length;
  const cutCenter: Vec3Like = {
    x: centerCutX * invLen,
    y: centerCutY * invLen,
    z: centerCutZ * invLen,
  };

  const basisU = normalize3({
    x: cutPoints[0].x - cutCenter.x,
    y: cutPoints[0].y - cutCenter.y,
    z: cutPoints[0].z - cutCenter.z,
  });
  const basisV = normalize3(cross3(norm, basisU));

  const sortedPoints = cutPoints.slice().sort((a, b) => {
    const daX = a.x - cutCenter.x;
    const daY = a.y - cutCenter.y;
    const daZ = a.z - cutCenter.z;
    const dbX = b.x - cutCenter.x;
    const dbY = b.y - cutCenter.y;
    const dbZ = b.z - cutCenter.z;

    const angleA = Math.atan2(daX * basisV.x + daY * basisV.y + daZ * basisV.z, daX * basisU.x + daY * basisU.y + daZ * basisU.z);
    const angleB = Math.atan2(dbX * basisV.x + dbY * basisV.y + dbZ * basisV.z, dbX * basisU.x + dbY * basisU.y + dbZ * basisU.z);
    return angleA - angleB;
  });

  newFaces.push({
    normal: { x: norm.x, y: norm.y, z: norm.z },
    neighborTag,
    vertices: sortedPoints,
  });

  return newFaces;
}
