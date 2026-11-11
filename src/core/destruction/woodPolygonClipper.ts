export {
  WOOD_CLIPPER_SCALE,
  MAX_FLOATING_ISLAND_DROP_AREA_M2,
  type Point2D,
  type WoodStampProfile,
  type JaggedHoleStampOptions,
  type SplinterSpawnDescriptor,
  type WoodShellContour,
  type WoodStudAnchorSpan,
  type WoodPanelClipperState,
  type WoodMeshScratchBuffers,
  type WoodMeshBuildStats,
  type WoodStampSubtractionResult,
} from './wood/woodClipperTypes.ts';

export {
  inferWoodStampProfile,
  createJaggedHoleStamp,
} from './wood/jaggedHoleStamp.ts';

export {
  createWoodPanelState,
  resetWoodPanelState,
  computePanelRemainingAreaM2,
  isPointInOpenHole,
} from './wood/panelState.ts';

export {
  triangulateWoodPanelToBuffers,
} from './wood/panelTriangulator.ts';

export {
  points2DToPath64,
} from './wood/pathClassification.ts';

export {
  recheckUnanchoredWoodShells,
  stampHoleInWoodPanel,
} from './wood/clipperBooleanSolver.ts';

export {
  MIN_SAWN_WOOD_SLAB_AREA_M2,
  type ExtrudedWoodSlabMesh,
  extrudeWoodIslandToSlab,
  extrudeDroppedWoodSlabs,
} from './wood/woodSlabExtruder.ts';
