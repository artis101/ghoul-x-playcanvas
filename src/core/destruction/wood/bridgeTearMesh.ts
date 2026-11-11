import { Path64 } from 'clipper2-js';
import { type Point2D } from './woodClipperTypes.ts';
import { createSeededRng } from './jaggedHoleStamp.ts';
import { points2DToPath64 } from './pathClassification.ts';

export function closestPointOnSegment2D(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number; distSq: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = 0;
  if (lenSq > 1e-12) {
    t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq));
  }
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx, y: cy, distSq: dx * dx + dy * dy };
}

export function makeJaggedBridgeTearPath64(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  halfWidthM: number,
  seed: number,
): Path64 {
  const du = u1 - u0;
  const dv = v1 - v0;
  const len = Math.hypot(du, dv);
  if (len < 1e-5) {
    return new Path64();
  }

  const bu = du / len;
  const bv = dv / len;
  const pu = -bv;
  const pv = bu;

  const ext = 0.014;
  const su = u0 - bu * ext;
  const sv = v0 - bv * ext;
  const eu = u1 + bu * ext;
  const ev = v1 + bv * ext;
  const midU = (su + eu) * 0.5;
  const midV = (sv + ev) * 0.5;

  const rng = createSeededRng((seed * 1597334677 + 3812015801) >>> 0);
  const hw0 = halfWidthM * (0.85 + 0.3 * rng());
  const hwMidPos = halfWidthM * (1.12 + 0.38 * rng());
  const hwMidNeg = halfWidthM * (1.12 + 0.38 * rng());
  const hw1 = halfWidthM * (0.85 + 0.3 * rng());

  const pts: Point2D[] = [
    { u: su + pu * hw0, v: sv + pv * hw0 },
    { u: su - pu * hw0, v: sv - pv * hw0 },
    {
      u: midU - pu * hwMidNeg + bu * (rng() - 0.5) * 0.008,
      v: midV - pv * hwMidNeg + bv * (rng() - 0.5) * 0.008,
    },
    { u: eu - pu * hw1, v: ev - pv * hw1 },
    { u: eu + pu * hw1, v: ev + pv * hw1 },
    {
      u: midU + pu * hwMidPos + bu * (rng() - 0.5) * 0.008,
      v: midV + pv * hwMidPos + bv * (rng() - 0.5) * 0.008,
    },
  ];

  return points2DToPath64(pts);
}
