import type { Point2D } from './glassShardTypes.ts';

/**
 * Numerically stable circumcenter of 2D triangle `(ax, ay), (bx, by), (cx, cy)`.
 */
export function computeTriangleCircumcenter2D(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): Point2D {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;

  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const denom = 2 * (dx * ey - dy * ex);

  if (Math.abs(denom) < 1e-14) {
    return {
      x: (ax + bx + cx) / 3,
      y: (ay + by + cy) / 3,
    };
  }

  const invDenom = 1 / denom;
  return {
    x: ax + (ey * bl - dy * cl) * invDenom,
    y: ay + (dx * cl - ex * bl) * invDenom,
  };
}

/**
 * Signed 2D shoelace area (`> 0` for counterclockwise polygons).
 */
export function computeSignedPolygonArea2D(polygon: readonly Point2D[]): number {
  const n = polygon.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum * 0.5;
}

/**
 * Computes exact positive area and area-weighted 2D centroid of a simple polygon.
 */
export function computePolygonAreaAndCentroid2D(
  polygon: readonly Point2D[],
): { areaM2: number; centroid: Point2D } {
  const n = polygon.length;
  if (n === 0) {
    return { areaM2: 0, centroid: { x: 0, y: 0 } };
  }
  if (n < 3) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += polygon[i].x;
      sy += polygon[i].y;
    }
    return { areaM2: 0, centroid: { x: sx / n, y: sy / n } };
  }

  let crossSum = 0;
  let cxSum = 0;
  let cySum = 0;

  for (let i = 0; i < n; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % n];
    const cross = p0.x * p1.y - p1.x * p0.y;
    crossSum += cross;
    cxSum += (p0.x + p1.x) * cross;
    cySum += (p0.y + p1.y) * cross;
  }

  const signedArea = crossSum * 0.5;
  const areaM2 = Math.abs(signedArea);
  if (areaM2 < 1e-12) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += polygon[i].x;
      sy += polygon[i].y;
    }
    return { areaM2: 0, centroid: { x: sx / n, y: sy / n } };
  }

  const invSixArea = 1 / (6 * signedArea);
  return {
    areaM2,
    centroid: {
      x: cxSum * invSixArea,
      y: cySum * invSixArea,
    },
  };
}

/**
 * Exact point-in-CCW-convex-polygon test (`true` inside or within `eps` of boundary).
 */
export function isPointInConvexPolygon2D(
  polygon: readonly Point2D[],
  x: number,
  y: number,
  eps = 1e-6,
): boolean {
  const n = polygon.length;
  if (n < 3) return false;

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const cross = ex * (y - a.y) - ey * (x - a.x);
    if (cross < -eps) {
      return false;
    }
  }
  return true;
}

/**
 * Euclidean distance from `(x, y)` to a CCW convex polygon (`0` if inside).
 */
export function pointToConvexPolygonDistance2D(
  polygon: readonly Point2D[],
  x: number,
  y: number,
): number {
  if (isPointInConvexPolygon2D(polygon, x, y, 1e-7)) {
    return 0;
  }
  const n = polygon.length;
  let minDistSq = Infinity;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abLenSq = abx * abx + aby * aby;
    const t =
      abLenSq > 1e-14
        ? Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / abLenSq))
        : 0;
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const dx = x - px;
    const dy = y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < minDistSq) {
      minDistSq = dSq;
    }
  }
  return Math.sqrt(minDistSq);
}
