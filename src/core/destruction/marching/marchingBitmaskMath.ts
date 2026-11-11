import {
  GLASS_CELL_VOID,
  GLASS_DIR_E,
  GLASS_DIR_N,
  GLASS_DIR_NE,
  GLASS_DIR_NW,
  GLASS_DIR_S,
  GLASS_DIR_SE,
  GLASS_DIR_SW,
  GLASS_DIR_W,
  MARCHING_ATLAS_GRID_DIM,
  MARCHING_ATLAS_TILE_SPAN,
  type AtlasTileUvRect,
} from './marchingTileTypes.ts';

/**
 * Deterministic 32-bit PRNG (Mulberry32) returning floats in `[0, 1)`.
 */
export function createDeterministicPrng(seed: number): () => number {
  let state = (seed | 0) >>> 0;
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) * 2.3283064365386963e-10;
  };
}

/**
 * Maps an 8-neighbor bitmask (`0..255`) directly to 16x16 atlas UV coordinates.
 */
export function bitmaskToAtlasUv(
  mask: number,
  uvInset = 0,
): AtlasTileUvRect {
  const clampedMask = Math.max(0, Math.min(255, mask | 0));
  const col = clampedMask % MARCHING_ATLAS_GRID_DIM;
  const row = Math.floor(clampedMask / MARCHING_ATLAS_GRID_DIM);

  const baseU0 = col * MARCHING_ATLAS_TILE_SPAN;
  const baseV0 = row * MARCHING_ATLAS_TILE_SPAN;
  const inset = Math.max(0, Math.min(MARCHING_ATLAS_TILE_SPAN * 0.25, uvInset));

  return {
    u0: baseU0 + inset,
    v0: baseV0 + inset,
    u1: baseU0 + MARCHING_ATLAS_TILE_SPAN - inset,
    v1: baseV0 + MARCHING_ATLAS_TILE_SPAN - inset,
    tileSpan: MARCHING_ATLAS_TILE_SPAN,
  };
}

/**
 * Computes the 8-neighbor intactness bitmask (`0..255`) for cell `(col, row)`.
 */
export function computeNeighborBitmask8(
  cells: Uint8Array,
  gridW: number,
  gridH: number,
  col: number,
  row: number,
  outOfBoundsIntact = false,
): number {
  let mask = 0;

  const isIntact = (c: number, r: number): boolean => {
    if (c < 0 || c >= gridW || r < 0 || r >= gridH) {
      return outOfBoundsIntact;
    }
    return cells[r * gridW + c] !== GLASS_CELL_VOID;
  };

  if (isIntact(col, row + 1)) mask |= GLASS_DIR_N;
  if (isIntact(col + 1, row + 1)) mask |= GLASS_DIR_NE;
  if (isIntact(col + 1, row)) mask |= GLASS_DIR_E;
  if (isIntact(col + 1, row - 1)) mask |= GLASS_DIR_SE;
  if (isIntact(col, row - 1)) mask |= GLASS_DIR_S;
  if (isIntact(col - 1, row - 1)) mask |= GLASS_DIR_SW;
  if (isIntact(col - 1, row)) mask |= GLASS_DIR_W;
  if (isIntact(col - 1, row + 1)) mask |= GLASS_DIR_NW;

  return mask;
}
