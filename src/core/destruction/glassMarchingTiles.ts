export {
  GLASS_CELL_VOID,
  GLASS_CELL_INTACT,
  GLASS_CELL_CRACKED,
  type GlassCellState,
  GLASS_DIR_N,
  GLASS_DIR_NE,
  GLASS_DIR_E,
  GLASS_DIR_SE,
  GLASS_DIR_S,
  GLASS_DIR_SW,
  GLASS_DIR_W,
  GLASS_DIR_NW,
  MARCHING_ATLAS_GRID_DIM,
  MARCHING_ATLAS_TILE_SPAN,
  type AtlasTileUvRect,
  type MarchingGlassImpactOptions,
  type MarchingGlassImpactReport,
  type MarchingQuadMeshBuildResult,
  type MarchingGlassPaneOptions,
} from './marching/marchingTileTypes.ts';

export {
  createDeterministicPrng,
  bitmaskToAtlasUv,
  computeNeighborBitmask8,
} from './marching/marchingBitmaskMath.ts';

export {
  MarchingGlassPane,
} from './marching/marchingGlassPane.ts';
