import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  add,
  copyVec3,
  dot,
  length,
  lengthSq,
  scale,
  sub,
  vec3,
} from '../../ballistics/vec3.ts';

export function evaluateCatmullRomSpline(
  controlPoints: readonly Vec3Like[],
  tNorm: number
): Vec3Like {
  const n = controlPoints.length;
  if (n === 0) return vec3(0, 0, 0);
  if (n === 1) return copyVec3(controlPoints[0]);

  const clamped = Math.max(0, Math.min(1, tNorm));
  const scaled = clamped * (n - 1);
  const segIdx = Math.min(n - 2, Math.floor(scaled));
  const u = scaled - segIdx;

  const p0 = controlPoints[Math.max(0, segIdx - 1)];
  const p1 = controlPoints[segIdx];
  const p2 = controlPoints[segIdx + 1];
  const p3 = controlPoints[Math.min(n - 1, segIdx + 2)];

  const u2 = u * u;
  const u3 = u2 * u;

  // Standard Catmull-Rom tension = 0.5
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * u +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * u +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3),
    z:
      0.5 *
      (2 * p1.z +
        (-p0.z + p2.z) * u +
        (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * u2 +
        (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * u3),
  };
}

/**
 * Exact closest-point distance between two 3D line segments [a0, a1] and [b0, b1].
 */
export function closestDistanceBetweenSegments3D(
  a0: Vec3Like,
  a1: Vec3Like,
  b0: Vec3Like,
  b1: Vec3Like
): { distanceM: number; pointOnA: Vec3Like; pointOnB: Vec3Like; s: number; t: number } {
  const d1 = sub(a1, a0);
  const d2 = sub(b1, b0);
  const r = sub(a0, b0);
  const a = lengthSq(d1);
  const e = lengthSq(d2);
  const f = dot(d2, r);
  const eps = 1e-10;

  let s = 0;
  let t = 0;

  if (a <= eps && e <= eps) {
    return {
      distanceM: length(r),
      pointOnA: copyVec3(a0),
      pointOnB: copyVec3(b0),
      s: 0,
      t: 0,
    };
  }

  if (a <= eps) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= eps) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      if (denom !== 0) {
        s = Math.max(0, Math.min(1, (b * f - c * e) / denom));
      } else {
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }

  const pointOnA = add(a0, scale(d1, s));
  const pointOnB = add(b0, scale(d2, t));
  return {
    distanceM: length(sub(pointOnA, pointOnB)),
    pointOnA,
    pointOnB,
    s,
    t,
  };
}

export function pointToSegmentDistance3D(
  p: Vec3Like,
  a: Vec3Like,
  b: Vec3Like
): { distanceM: number; closestPoint: Vec3Like; t: number } {
  const ab = sub(b, a);
  const lenSq = lengthSq(ab);
  if (lenSq <= 1e-10) {
    return { distanceM: length(sub(p, a)), closestPoint: copyVec3(a), t: 0 };
  }
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / lenSq));
  const closestPoint = add(a, scale(ab, t));
  return { distanceM: length(sub(p, closestPoint)), closestPoint, t };
}
