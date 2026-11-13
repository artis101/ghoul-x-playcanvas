export {
  computeSeverCut,
  findBoneCrossing,
  severCutFractionRange,
  severCutWorldPoint,
  type BoneCrossing,
} from './severCutPlacement.ts';
export {
  buildJaggedRim,
  createCutSurface,
  cutHeightAt,
  sampleRim,
  type CutRimSample,
  type CutSurface,
} from './severCutSurface.ts';
export {
  CUT_SIDE_DISTAL,
  CUT_SIDE_PROXIMAL,
  partitionMeshByCut,
  type CutMeshPartition,
} from './severCutMeshPartition.ts';
export {
  buildCutCapGeometry,
  type CapMeshData,
  type CutCapGeometry,
  type CutCapOptions,
} from './severCutCapGeometry.ts';
