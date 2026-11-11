import { Clipper, Paths64 } from 'clipper2-js';
import {
  INV_WOOD_CLIPPER_AREA_SCALE,
  WOOD_CLIPPER_SCALE,
  type WoodPanelClipperState,
} from './woodClipperTypes.ts';
import { classifyPointInPath64, makeIntactRectPath64 } from './pathClassification.ts';

export function createWoodPanelState(
  widthM: number,
  heightM: number,
  thicknessM = 0.08,
): WoodPanelClipperState {
  const safeW = Math.max(0.05, widthM);
  const safeH = Math.max(0.05, heightM);
  const safeT = Math.max(0.005, thicknessM);

  const outer = makeIntactRectPath64(safeW, safeH);
  const paths = new Paths64();
  paths.push(outer);

  return {
    widthM: safeW,
    heightM: safeH,
    thicknessM: safeT,
    paths,
    shells: [{ outer, holes: [] }],
    shotCount: 0,
  };
}

export function resetWoodPanelState(state: WoodPanelClipperState): void {
  const outer = makeIntactRectPath64(state.widthM, state.heightM);
  const paths = new Paths64();
  paths.push(outer);
  state.paths = paths;
  state.shells = [{ outer, holes: [] }];
  state.shotCount = 0;
}

export function computePanelRemainingAreaM2(state: WoodPanelClipperState): number {
  if (state.paths.length === 0) {
    return 0;
  }
  return Math.max(0, Clipper.areaPaths(state.paths) * INV_WOOD_CLIPPER_AREA_SCALE);
}

export function isPointInOpenHole(
  state: WoodPanelClipperState,
  u: number,
  v: number,
): boolean {
  if (u < 0 || u > state.widthM || v < 0 || v > state.heightM) {
    return false;
  }

  if (state.shells.length === 0) {
    return true;
  }

  const px = Math.round(u * WOOD_CLIPPER_SCALE);
  const py = Math.round(v * WOOD_CLIPPER_SCALE);

  for (let i = state.shells.length - 1; i >= 0; i--) {
    const shell = state.shells[i];
    const outerPip = classifyPointInPath64(px, py, shell.outer);
    if (outerPip === 'OUTSIDE') {
      continue;
    }
    if (outerPip === 'ON_EDGE') {
      return false;
    }

    for (let j = 0; j < shell.holes.length; j++) {
      const holePip = classifyPointInPath64(px, py, shell.holes[j]);
      if (holePip === 'INSIDE') {
        return true;
      }
      if (holePip === 'ON_EDGE') {
        return false;
      }
    }

    return false;
  }

  return true;
}
