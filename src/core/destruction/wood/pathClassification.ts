import { Clipper, Path64, Point64 } from 'clipper2-js';
import { WOOD_CLIPPER_SCALE, type Point2D } from './woodClipperTypes.ts';

export function makeIntactRectPath64(widthM: number, heightM: number): Path64 {
  const wScaled = Math.max(10, Math.round(widthM * WOOD_CLIPPER_SCALE));
  const hScaled = Math.max(10, Math.round(heightM * WOOD_CLIPPER_SCALE));
  const rect = new Path64();
  rect.push(
    new Point64(0, 0),
    new Point64(wScaled, 0),
    new Point64(wScaled, hScaled),
    new Point64(0, hScaled),
  );
  return rect;
}

export function points2DToPath64(points: readonly Point2D[]): Path64 {
  const path = new Path64();
  for (let i = 0; i < points.length; i++) {
    path.push(
      new Point64(
        Math.round(points[i].u * WOOD_CLIPPER_SCALE),
        Math.round(points[i].v * WOOD_CLIPPER_SCALE),
      ),
    );
  }
  if (path.length >= 3 && Clipper.area(path) < 0) {
    path.reverse();
  }
  return path;
}

export type PointContainment = 'INSIDE' | 'OUTSIDE' | 'ON_EDGE';

/**
 * Exact, zero-allocation ray-crossing & segment-collinearity point-in-polygon classifier.
 */
export function classifyPointInPath64(
  px: number,
  py: number,
  path: Path64,
): PointContainment {
  const n = path.length;
  if (n < 3) {
    return 'OUTSIDE';
  }

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = path[j].x;
    const ay = path[j].y;
    const bx = path[i].x;
    const by = path[i].y;

    if (
      px >= (ax < bx ? ax : bx) &&
      px <= (ax > bx ? ax : bx) &&
      py >= (ay < by ? ay : by) &&
      py <= (ay > by ? ay : by)
    ) {
      const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (Math.abs(cross) <= 1e-3) {
        return 'ON_EDGE';
      }
    }

    if ((ay > py) !== (by > py)) {
      const xIntersect = ax + ((py - ay) * (bx - ax)) / (by - ay);
      if (px < xIntersect) {
        inside = !inside;
      }
    }
  }

  return inside ? 'INSIDE' : 'OUTSIDE';
}

export function isRingInsideContainer(ring: Path64, container: Path64): boolean {
  for (let i = 0; i < ring.length; i++) {
    const res = classifyPointInPath64(ring[i].x, ring[i].y, container);
    if (res === 'INSIDE') {
      return true;
    }
    if (res === 'OUTSIDE') {
      return false;
    }
  }
  return false;
}
