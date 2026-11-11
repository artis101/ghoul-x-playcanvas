export const GLASS_CELL_VOID = 0;
export const GLASS_CELL_INTACT = 1;
export const GLASS_CELL_CRACKED = 2;

export type GlassCellState =
  | typeof GLASS_CELL_VOID
  | typeof GLASS_CELL_INTACT
  | typeof GLASS_CELL_CRACKED;

/** 8-neighbor intactness bitmask flags (clockwise from North: N, NE, E, SE, S, SW, W, NW). */
export const GLASS_DIR_N = 1 << 0; // 1   (dc =  0, dr = +1)
export const GLASS_DIR_NE = 1 << 1; // 2   (dc = +1, dr = +1)
export const GLASS_DIR_E = 1 << 2; // 4   (dc = +1, dr =  0)
export const GLASS_DIR_SE = 1 << 3; // 8   (dc = +1, dr = -1)
export const GLASS_DIR_S = 1 << 4; // 16  (dc =  0, dr = -1)
export const GLASS_DIR_SW = 1 << 5; // 32  (dc = -1, dr = -1)
export const GLASS_DIR_W = 1 << 6; // 64  (dc = -1, dr =  0)
export const GLASS_DIR_NW = 1 << 7; // 128 (dc = -1, dr = +1)

export const MARCHING_ATLAS_GRID_DIM = 16;
export const MARCHING_ATLAS_TILE_SPAN = 1 / MARCHING_ATLAS_GRID_DIM; // 1 / 16 = 0.0625

export interface AtlasTileUvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  tileSpan: number;
}

export interface MarchingGlassImpactOptions {
  /** Normalized horizontal impact coordinate in [0, 1] (West -> East). */
  u: number;
  /** Normalized vertical impact coordinate in [0, 1] (South -> North). */
  v: number;
  /** Projectile or shockwave energy in Joules. */
  energyJ: number;
  /** Physical hole/impact radius in meters (defaults from caliber/energy). */
  radiusM?: number;
  /** Optional deterministic integer seed override. */
  seed?: number;
}

export interface MarchingGlassImpactReport {
  alreadyBrokenHole: boolean;
  cellsBroken: number;
  cellsCracked: number;
  tendrilsSpawned: number;
  survivingCells: number;
}

export interface MarchingQuadMeshBuildResult {
  quadCount: number;
  vertexCount: number;
  indexCount: number;
}

export interface MarchingGlassPaneOptions {
  widthM: number;
  heightM: number;
  gridW?: number;
  gridH?: number;
  /**
   * Whether the outer window sash frame counts as intact support when computing
   * border-cell bitmasks. Defaults to `true` so an unshot window pane has bitmask
   * `255` (clean unfractured glass) flush up to the window frame.
   */
  frameBorderIntact?: boolean;
}
