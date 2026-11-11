import type { Point2D } from './glassShardTypes.ts';

function clipAgainstHalfPlane(
  poly: readonly Point2D[],
  isInside: (p: Point2D) => boolean,
  intersect: (a: Point2D, b: Point2D) => Point2D,
): Point2D[] {
  const len = poly.length;
  if (len === 0) return [];

  const out: Point2D[] = [];
  let prev = poly[len - 1];
  let prevInside = isInside(prev);

  for (let i = 0; i < len; i++) {
    const curr = poly[i];
    const currInside = isInside(curr);

    if (currInside) {
      if (!prevInside) {
        out.push(intersect(prev, curr));
      }
      out.push(curr);
    } else if (prevInside) {
      out.push(intersect(prev, curr));
    }

    prev = curr;
    prevInside = currInside;
  }

  return out;
}

/**
 * Clips an arbitrary 2D convex/simple polygon against axis-aligned rectangle
 * `[minX, maxX] x [minY, maxY]` using Sutherland-Hodgman 4-plane polygon clipping.
 */
export function clipPolygonToRectSutherlandHodgman(
  polygon: readonly Point2D[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Point2D[] {
  if (polygon.length < 3) {
    return [];
  }

  // Plane 1: x >= minX
  let stage = clipAgainstHalfPlane(
    polygon,
    (p) => p.x >= minX,
    (a, b) => {
      const dx = b.x - a.x;
      const t = Math.abs(dx) > 1e-14 ? (minX - a.x) / dx : 0;
      return { x: minX, y: a.y + (b.y - a.y) * t };
    },
  );
  if (stage.length < 3) return [];

  // Plane 2: x <= maxX
  stage = clipAgainstHalfPlane(
    stage,
    (p) => p.x <= maxX,
    (a, b) => {
      const dx = b.x - a.x;
      const t = Math.abs(dx) > 1e-14 ? (maxX - a.x) / dx : 0;
      return { x: maxX, y: a.y + (b.y - a.y) * t };
    },
  );
  if (stage.length < 3) return [];

  // Plane 3: y >= minY
  stage = clipAgainstHalfPlane(
    stage,
    (p) => p.y >= minY,
    (a, b) => {
      const dy = b.y - a.y;
      const t = Math.abs(dy) > 1e-14 ? (minY - a.y) / dy : 0;
      return { x: a.x + (b.x - a.x) * t, y: minY };
    },
  );
  if (stage.length < 3) return [];

  // Plane 4: y <= maxY
  stage = clipAgainstHalfPlane(
    stage,
    (p) => p.y <= maxY,
    (a, b) => {
      const dy = b.y - a.y;
      const t = Math.abs(dy) > 1e-14 ? (maxY - a.y) / dy : 0;
      return { x: a.x + (b.x - a.x) * t, y: maxY };
    },
  );
  if (stage.length < 3) return [];

  // Deduplicate consecutive near-coincident vertices
  const cleaned: Point2D[] = [];
  const epsSq = 1e-12;
  for (let i = 0; i < stage.length; i++) {
    const pt = stage[i];
    const prev = cleaned.length > 0 ? cleaned[cleaned.length - 1] : stage[stage.length - 1];
    const dx = pt.x - prev.x;
    const dy = pt.y - prev.y;
    if (dx * dx + dy * dy > epsSq) {
      cleaned.push(pt);
    }
  }

  return cleaned.length >= 3 ? cleaned : [];
}
