import { Clipper, FillRule, Paths64 } from 'clipper2-js';
import {
  INV_WOOD_CLIPPER_AREA_SCALE,
  type Point2D,
  type WoodMeshScratchBuffers,
  type WoodPanelClipperState,
  type WoodStampCutResult,
  type WoodStampSubtractionResult,
} from './woodClipperTypes.ts';
import { points2DToPath64 } from './pathClassification.ts';
import { appendWeakenedBridgeTears } from './bridgeTearGenerator.ts';
import { rebuildCleanShellsAndPaths } from './studAnchorSupport.ts';
import { computePanelRemainingAreaM2 } from './panelState.ts';
import { buildPerimeterSplinterDescriptors } from './splinterDescriptors.ts';
import { extrudeDroppedWoodSlabs } from './woodSlabExtruder.ts';
import { triangulateWoodPanelToBuffers } from './panelTriangulator.ts';

// Also triangulates the panel into `buffers`.
export function stampHoleInWoodPanel(
  state: WoodPanelClipperState,
  stamp: readonly Point2D[],
  buffers: WoodMeshScratchBuffers,
  splinterCountHint = 5,
): WoodStampSubtractionResult {
  const cut = cutStampFromWoodPanel(state, stamp, splinterCountHint);
  return { ...cut, meshStats: triangulateWoodPanelToBuffers(state, buffers) };
}

/** Applies the stamp to the panel state without triangulating it. */
export function cutStampFromWoodPanel(
  state: WoodPanelClipperState,
  stamp: readonly Point2D[],
  splinterCountHint = 5,
): WoodStampCutResult {
  if (stamp.length < 3 || state.paths.length === 0) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
      droppedIslandAreaM2: 0,
      snappedBridgeCount: 0,
      splinters: [],
    };
  }

  const stampPath = points2DToPath64(stamp);
  if (stampPath.length < 3) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
      droppedIslandAreaM2: 0,
      snappedBridgeCount: 0,
      splinters: [],
    };
  }

  let clipPaths = new Paths64();
  clipPaths.push(stampPath);

  const nextSeed = state.shotCount + 1;
  const snappedBridgeCount = appendWeakenedBridgeTears(
    state,
    stamp,
    clipPaths,
    nextSeed,
  );
  if (clipPaths.length > 1) {
    clipPaths = Clipper.Union(clipPaths, new Paths64(), FillRule.NonZero);
  }

  const cutWoodPaths = Clipper.Intersect(state.paths, clipPaths, FillRule.NonZero);
  const excisedAreaM2 = Math.max(
    0,
    Clipper.areaPaths(cutWoodPaths) * INV_WOOD_CLIPPER_AREA_SCALE,
  );

  if (excisedAreaM2 < 1e-6) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
      droppedIslandAreaM2: 0,
      snappedBridgeCount: 0,
      splinters: [],
    };
  }

  let centerU = 0;
  let centerV = 0;
  for (let i = 0; i < stamp.length; i++) {
    centerU += stamp[i].u;
    centerV += stamp[i].v;
  }
  centerU /= stamp.length;
  centerV /= stamp.length;

  state.shotCount = nextSeed;

  const areaBefore = computePanelRemainingAreaM2(state);
  const rawDiff = Clipper.Difference(state.paths, clipPaths, FillRule.NonZero);
  const { cleanPaths, shells, droppedIslands } = rebuildCleanShellsAndPaths(
    rawDiff,
    state,
  );

  state.paths = cleanPaths;
  state.shells = shells;

  const droppedIslandAreaM2 =
    droppedIslands.length > 0
      ? Math.max(0, Clipper.areaPaths(droppedIslands) * INV_WOOD_CLIPPER_AREA_SCALE)
      : 0;
  const droppedSlabs =
    droppedIslands.length > 0
      ? extrudeDroppedWoodSlabs(droppedIslands, state.widthM, state.heightM, state.thicknessM)
      : [];
  for (let d = 0; d < droppedIslands.length; d++) {
    cutWoodPaths.push(droppedIslands[d]);
  }

  const areaAfter = computePanelRemainingAreaM2(state);
  const removedAreaM2 = Math.max(
    excisedAreaM2,
    Math.max(0, areaBefore - areaAfter),
  );

  const splinters = buildPerimeterSplinterDescriptors(
    cutWoodPaths,
    centerU,
    centerV,
    splinterCountHint,
    state.shotCount,
  );

  return {
    cutAnyWood: true,
    removedAreaM2,
    droppedIslandAreaM2,
    snappedBridgeCount,
    splinters,
    droppedSlabs,
  };
}

// Also triangulates the panel into `buffers`.
export function recheckUnanchoredWoodShells(
  state: WoodPanelClipperState,
  buffers: WoodMeshScratchBuffers,
  splinterCountHint = 5,
): WoodStampSubtractionResult {
  const cut = detachUnanchoredWoodShells(state, splinterCountHint);
  return { ...cut, meshStats: triangulateWoodPanelToBuffers(state, buffers) };
}

/**
 * Re-evaluates existing surviving wood panel shells against updated `state.studAnchors`
 * (e.g. after an interior 2x4 stud section breaks) and detaches any now-unanchored wood
 * shells into intact 3D `droppedSlabs`.
 */
export function detachUnanchoredWoodShells(
  state: WoodPanelClipperState,
  splinterCountHint = 5,
): WoodStampCutResult {
  if (state.paths.length === 0) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
      droppedIslandAreaM2: 0,
      snappedBridgeCount: 0,
      splinters: [],
      droppedSlabs: [],
    };
  }

  const areaBefore = computePanelRemainingAreaM2(state);
  const { cleanPaths, shells, droppedIslands } = rebuildCleanShellsAndPaths(
    state.paths,
    state,
  );

  if (droppedIslands.length === 0) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
      droppedIslandAreaM2: 0,
      snappedBridgeCount: 0,
      splinters: [],
      droppedSlabs: [],
    };
  }

  state.paths = cleanPaths;
  state.shells = shells;
  state.shotCount += 1;

  const droppedIslandAreaM2 = Math.max(
    0,
    Clipper.areaPaths(droppedIslands) * INV_WOOD_CLIPPER_AREA_SCALE,
  );
  const droppedSlabs = extrudeDroppedWoodSlabs(
    droppedIslands,
    state.widthM,
    state.heightM,
    state.thicknessM,
  );
  const areaAfter = computePanelRemainingAreaM2(state);
  const removedAreaM2 = Math.max(droppedIslandAreaM2, Math.max(0, areaBefore - areaAfter));

  const splinters = buildPerimeterSplinterDescriptors(
    droppedIslands,
    state.widthM * 0.5,
    state.heightM * 0.5,
    splinterCountHint,
    state.shotCount,
  );

  return {
    cutAnyWood: true,
    removedAreaM2,
    droppedIslandAreaM2,
    snappedBridgeCount: 0,
    splinters,
    droppedSlabs,
  };
}
