import { Paths64 } from 'clipper2-js';
import {
  BRIDGE_SNAP_HORIZONTAL_EXTRA_M,
  BRIDGE_SNAP_VERTICAL_GAP_M,
  EDGE_SLIVER_SNAP_GAP_M,
  INV_WOOD_CLIPPER_SCALE,
  type Point2D,
  type WoodPanelClipperState,
} from './woodClipperTypes.ts';
import { closestPointOnSegment2D, makeJaggedBridgeTearPath64 } from './bridgeTearMesh.ts';

export function appendWeakenedBridgeTears(
  state: WoodPanelClipperState,
  stamp: readonly Point2D[],
  clipPaths: Paths64,
  shotSeed: number,
): number {
  if (stamp.length < 3 || state.shells.length === 0) return 0;

  let sMinU = Infinity, sMaxU = -Infinity, sMinV = Infinity, sMaxV = -Infinity;
  for (let i = 0; i < stamp.length; i++) {
    const p = stamp[i];
    if (p.u < sMinU) sMinU = p.u;
    if (p.u > sMaxU) sMaxU = p.u;
    if (p.v < sMinV) sMinV = p.v;
    if (p.v > sMaxV) sMaxV = p.v;
  }

  const maxSnapReachM = BRIDGE_SNAP_VERTICAL_GAP_M + BRIDGE_SNAP_HORIZONTAL_EXTRA_M;
  let snappedCount = 0;

  for (let sIdx = 0; sIdx < state.shells.length; sIdx++) {
    const shell = state.shells[sIdx];
    for (let hIdx = 0; hIdx < shell.holes.length; hIdx++) {
      const hole = shell.holes[hIdx];
      const hn = hole.length;
      if (hn < 3) continue;

      let hMinU = Infinity, hMaxU = -Infinity, hMinV = Infinity, hMaxV = -Infinity;
      for (let i = 0; i < hn; i++) {
        const hu = hole[i].x * INV_WOOD_CLIPPER_SCALE;
        const hv = hole[i].y * INV_WOOD_CLIPPER_SCALE;
        if (hu < hMinU) hMinU = hu;
        if (hu > hMaxU) hMaxU = hu;
        if (hv < hMinV) hMinV = hv;
        if (hv > hMaxV) hMaxV = hv;
      }

      if (
        hMinU > sMaxU + maxSnapReachM || hMaxU < sMinU - maxSnapReachM ||
        hMinV > sMaxV + maxSnapReachM || hMaxV < sMinV - maxSnapReachM
      ) continue;

      let bestDistSq = Infinity, bestSU = 0, bestSV = 0, bestHU = 0, bestHV = 0;

      for (let i = 0; i < stamp.length; i++) {
        const ps = stamp[i];
        for (let j = 0; j < hn; j++) {
          const ha = hole[j], hb = hole[(j + 1) % hn];
          const cand = closestPointOnSegment2D(
            ps.u, ps.v,
            ha.x * INV_WOOD_CLIPPER_SCALE, ha.y * INV_WOOD_CLIPPER_SCALE,
            hb.x * INV_WOOD_CLIPPER_SCALE, hb.y * INV_WOOD_CLIPPER_SCALE,
          );
          if (cand.distSq < bestDistSq) {
            bestDistSq = cand.distSq;
            bestSU = ps.u; bestSV = ps.v; bestHU = cand.x; bestHV = cand.y;
          }
        }
      }

      for (let j = 0; j < hn; j++) {
        const hu = hole[j].x * INV_WOOD_CLIPPER_SCALE, hv = hole[j].y * INV_WOOD_CLIPPER_SCALE;
        for (let i = 0; i < stamp.length; i++) {
          const sa = stamp[i], sb = stamp[(i + 1) % stamp.length];
          const cand = closestPointOnSegment2D(hu, hv, sa.u, sa.v, sb.u, sb.v);
          if (cand.distSq < bestDistSq) {
            bestDistSq = cand.distSq;
            bestSU = cand.x; bestSV = cand.y; bestHU = hu; bestHV = hv;
          }
        }
      }

      const gapM = Math.sqrt(bestDistSq);
      if (gapM <= 0.001) continue;

      const du = bestHU - bestSU;
      const grainAlignedFrac = Math.abs(du) / gapM;
      const snapThresholdM = BRIDGE_SNAP_VERTICAL_GAP_M + BRIDGE_SNAP_HORIZONTAL_EXTRA_M * grainAlignedFrac;

      if (gapM <= snapThresholdM) {
        const bridgeHalfW = 0.020 + 0.012 * grainAlignedFrac;
        const bridgePath = makeJaggedBridgeTearPath64(bestSU, bestSV, bestHU, bestHV, bridgeHalfW, shotSeed * 31 + hIdx * 17 + sIdx);
        if (bridgePath.length >= 3) {
          clipPaths.push(bridgePath);
          snappedCount++;
        }
      }
    }
  }

  const midSU = (sMinU + sMaxU) * 0.5;
  const midSV = (sMinV + sMaxV) * 0.5;
  if (sMinU > 0.001 && sMinU <= EDGE_SLIVER_SNAP_GAP_M) {
    const p = makeJaggedBridgeTearPath64(sMinU, midSV, -0.01, midSV, 0.026, shotSeed * 43 + 1);
    if (p.length >= 3) { clipPaths.push(p); snappedCount++; }
  }
  if (sMaxU < state.widthM - 0.001 && state.widthM - sMaxU <= EDGE_SLIVER_SNAP_GAP_M) {
    const p = makeJaggedBridgeTearPath64(sMaxU, midSV, state.widthM + 0.01, midSV, 0.026, shotSeed * 43 + 2);
    if (p.length >= 3) { clipPaths.push(p); snappedCount++; }
  }
  if (sMinV > 0.001 && sMinV <= EDGE_SLIVER_SNAP_GAP_M) {
    const p = makeJaggedBridgeTearPath64(midSU, sMinV, midSU, -0.01, 0.024, shotSeed * 43 + 3);
    if (p.length >= 3) { clipPaths.push(p); snappedCount++; }
  }
  if (sMaxV < state.heightM - 0.001 && state.heightM - sMaxV <= EDGE_SLIVER_SNAP_GAP_M) {
    const p = makeJaggedBridgeTearPath64(midSU, sMaxV, midSU, state.heightM + 0.01, 0.024, shotSeed * 43 + 4);
    if (p.length >= 3) { clipPaths.push(p); snappedCount++; }
  }

  return snappedCount;
}
