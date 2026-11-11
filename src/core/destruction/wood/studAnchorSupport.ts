import { Clipper, Path64, Paths64 } from 'clipper2-js';
import {
  MAX_FLOATING_ISLAND_DROP_AREA_M2,
  MIN_HOLE_AREA_M2,
  MIN_SHELL_AREA_M2,
  SIMPLIFY_EPSILON_M,
  WOOD_CLIPPER_SCALE,
  type WoodPanelClipperState,
  type WoodShellContour,
} from './woodClipperTypes.ts';
import { classifyPointInPath64, isRingInsideContainer } from './pathClassification.ts';

export function countShellStructuralAnchors(
  shellPath: Path64,
  state: WoodPanelClipperState,
): { frameEdgeCount: number; studAnchorCount: number; totalAnchors: number } {
  const n = shellPath.length;
  if (n < 3) {
    return { frameEdgeCount: 0, studAnchorCount: 0, totalAnchors: 0 };
  }

  const wScaled = Math.round(state.widthM * WOOD_CLIPPER_SCALE);
  const hScaled = Math.round(state.heightM * WOOD_CLIPPER_SCALE);
  const edgeTol = Math.round(0.006 * WOOD_CLIPPER_SCALE);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const pt = shellPath[i];
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  let frameEdgeCount = 0;
  if (minX <= edgeTol) frameEdgeCount++;
  if (maxX >= wScaled - edgeTol) frameEdgeCount++;
  if (minY <= edgeTol) frameEdgeCount++;
  if (maxY >= hScaled - edgeTol) frameEdgeCount++;

  let studAnchorCount = 0;
  const studAnchors = state.studAnchors;
  if (studAnchors && studAnchors.length > 0 && frameEdgeCount < 2) {
    const anchoredStudU = new Set<number>();
    for (let s = 0; s < studAnchors.length; s++) {
      const span = studAnchors[s];
      const uKey = Math.round(span.u * 10_000);
      if (anchoredStudU.has(uKey)) continue;

      const sxMin = Math.round((span.u - span.halfWidthM) * WOOD_CLIPPER_SCALE);
      const sxMax = Math.round((span.u + span.halfWidthM) * WOOD_CLIPPER_SCALE);
      const syMin = Math.round(span.vMin * WOOD_CLIPPER_SCALE);
      const syMax = Math.round(span.vMax * WOOD_CLIPPER_SCALE);

      if (maxX < sxMin || minX > sxMax || maxY < syMin || minY > syMax) continue;

      const overlapYMin = Math.max(minY, syMin);
      const overlapYMax = Math.min(maxY, syMax);
      if (overlapYMax - overlapYMin < Math.round(0.025 * WOOD_CLIPPER_SCALE)) continue;

      const probeX = Math.round(span.u * WOOD_CLIPPER_SCALE);
      let hitsStud = false;
      for (let p = 0; p <= 4; p++) {
        const probeY = Math.round(overlapYMin + ((overlapYMax - overlapYMin) * p) / 4);
        if (classifyPointInPath64(probeX, probeY, shellPath) !== 'OUTSIDE') {
          hitsStud = true;
          break;
        }
      }

      if (hitsStud) {
        anchoredStudU.add(uKey);
        studAnchorCount++;
      }
    }
  }

  return {
    frameEdgeCount,
    studAnchorCount,
    totalAnchors: frameEdgeCount + studAnchorCount,
  };
}

export function rebuildCleanShellsAndPaths(
  paths: Paths64,
  state: WoodPanelClipperState,
): {
  cleanPaths: Paths64;
  shells: WoodShellContour[];
  droppedIslands: Paths64;
} {
  const minShellAreaScaled = MIN_SHELL_AREA_M2 * WOOD_CLIPPER_SCALE * WOOD_CLIPPER_SCALE;
  const minHoleAreaScaled = MIN_HOLE_AREA_M2 * WOOD_CLIPPER_SCALE * WOOD_CLIPPER_SCALE;
  const maxFloatingIslandScaled =
    MAX_FLOATING_ISLAND_DROP_AREA_M2 * WOOD_CLIPPER_SCALE * WOOD_CLIPPER_SCALE;
  const simplifyEpsScaled = SIMPLIFY_EPSILON_M * WOOD_CLIPPER_SCALE;

  const rawOuters: Array<{ path: Path64; area: number }> = [];
  const rawHoles: Array<{ path: Path64; absArea: number }> = [];
  const droppedIslands = new Paths64();

  for (let i = 0; i < paths.length; i++) {
    const raw = paths[i];
    if (raw.length < 3) continue;
    const rawArea = Clipper.area(raw);
    if (Math.abs(rawArea) < minHoleAreaScaled) continue;

    const simplified = Clipper.simplifyPath(raw, simplifyEpsScaled, true);
    let cleaned = Clipper.trimCollinear(simplified, false);
    if (cleaned.length < 3) {
      cleaned = Clipper.trimCollinear(raw, false);
      if (cleaned.length < 3) continue;
    }

    const signedArea = Clipper.area(cleaned);
    if (signedArea >= minShellAreaScaled) {
      rawOuters.push({ path: cleaned, area: signedArea });
    } else if (-signedArea >= minHoleAreaScaled) {
      rawHoles.push({ path: cleaned, absArea: -signedArea });
    }
  }

  if (rawOuters.length === 0) {
    return { cleanPaths: new Paths64(), shells: [], droppedIslands };
  }

  rawOuters.sort((a, b) => b.area - a.area);
  rawHoles.sort((a, b) => b.absArea - a.absArea);

  const survivingOuters: Array<{ path: Path64; area: number; holes: Path64[] }> = [];
  for (let i = 0; i < rawOuters.length; i++) {
    const candidate = rawOuters[i];
    let enclosedByHole = false;
    for (let h = 0; h < rawHoles.length; h++) {
      if (rawHoles[h].absArea <= candidate.area) break;
      if (isRingInsideContainer(candidate.path, rawHoles[h].path)) {
        enclosedByHole = true;
        break;
      }
    }

    if ((enclosedByHole && candidate.area <= maxFloatingIslandScaled) || countShellStructuralAnchors(candidate.path, state).totalAnchors < 2) {
      droppedIslands.push(candidate.path);
      continue;
    }
    survivingOuters.push({ path: candidate.path, area: candidate.area, holes: [] });
  }

  for (let h = 0; h < rawHoles.length; h++) {
    const holeObj = rawHoles[h];
    let bestOwnerIdx = -1;
    let bestOwnerArea = Infinity;

    for (let s = 0; s < survivingOuters.length; s++) {
      const shellObj = survivingOuters[s];
      if (shellObj.area <= holeObj.absArea || shellObj.area >= bestOwnerArea) continue;
      if (isRingInsideContainer(holeObj.path, shellObj.path)) {
        bestOwnerIdx = s;
        bestOwnerArea = shellObj.area;
      }
    }

    if (bestOwnerIdx >= 0) {
      survivingOuters[bestOwnerIdx].holes.push(holeObj.path);
    }
  }

  const shells: WoodShellContour[] = [];
  const cleanPaths = new Paths64();
  for (let s = 0; s < survivingOuters.length; s++) {
    const item = survivingOuters[s];
    shells.push({ outer: item.path, holes: item.holes });
    cleanPaths.push(item.path);
    for (let h = 0; h < item.holes.length; h++) {
      cleanPaths.push(item.holes[h]);
    }
  }

  return { cleanPaths, shells, droppedIslands };
}
