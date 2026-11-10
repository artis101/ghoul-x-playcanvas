/**
 * Method A — Classic Ultra-Cheap 256 Marching-Tile Glass Destruction (Pure TS).
 *
 * Stores a `Uint8Array(gridW * gridH)` cell grid per window pane (`0` = broken/open void,
 * `1` = intact glass, `2` = spiderweb-cracked intact glass), runs deterministic seeded radial
 * fracture walks on ballistic/blast impact, maps each surviving cell's 8-neighbor bitmask
 * (`0..255`) directly into a 16x16 crack/jagged-edge UV tile atlas, and emits surviving quads
 * into pre-allocated `Float32Array` / `Uint16Array` buffers with zero heap allocations.
 */

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
 * Maps an 8-neighbor bitmask (`0..255`) directly to 16x16 atlas UV coordinates:
 * `u0 = (mask % 16) / 16`, `v0 = Math.floor(mask / 16) / 16`, `tileSpan = 1 / 16`.
 *
 * Optional `uvInset` insets `u0..u1` and `v0..v1` inward by half a texel when sampling
 * with bilinear filtering on GPU to prevent cross-tile bleed.
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
 * Computes the 8-neighbor intactness bitmask (`0..255`) for cell `(col, row)`:
 * `bit 0..7` = N, NE, E, SE, S, SW, W, NW (`1` if neighbor cell `> 0`, `0` if broken `0`).
 *
 * Row `0` is South (`v = 0`) and row `gridH - 1` is North (`v = 1`);
 * Column `0` is West (`u = 0`) and column `gridW - 1` is East (`u = 1`).
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

/**
 * Stateful 2D Marching-Tile glass pane with pre-allocated quad-grid geometry buffers.
 */
export class MarchingGlassPane {
  public readonly widthM: number;
  public readonly heightM: number;
  public readonly gridW: number;
  public readonly gridH: number;
  public readonly frameBorderIntact: boolean;
  public readonly cells: Uint8Array;

  /** Pre-allocated vertex/index buffers (`4` verts & `6` indices per cell max). */
  public readonly positions: Float32Array;
  public readonly normals: Float32Array;
  public readonly uvs: Float32Array;
  public readonly colors: Float32Array;
  public readonly indices: Uint16Array;

  private impactCounter = 0;
  private survivingCount: number;

  public constructor(options: MarchingGlassPaneOptions) {
    this.widthM = Math.max(0.05, options.widthM);
    this.heightM = Math.max(0.05, options.heightM);
    this.gridW = Math.max(2, Math.min(128, Math.floor(options.gridW ?? 16)));
    this.gridH = Math.max(2, Math.min(128, Math.floor(options.gridH ?? 16)));
    this.frameBorderIntact = options.frameBorderIntact ?? true;

    const totalCells = this.gridW * this.gridH;
    this.cells = new Uint8Array(totalCells);
    this.cells.fill(GLASS_CELL_INTACT);
    this.survivingCount = totalCells;

    const maxVerts = totalCells * 4;
    const maxIndices = totalCells * 6;
    this.positions = new Float32Array(maxVerts * 3);
    this.normals = new Float32Array(maxVerts * 3);
    this.uvs = new Float32Array(maxVerts * 2);
    this.colors = new Float32Array(maxVerts * 4);
    this.indices = new Uint16Array(maxIndices);
  }

  public get totalCells(): number {
    return this.cells.length;
  }

  public get survivingCellCount(): number {
    return this.survivingCount;
  }

  public uvToGridCoords(u: number, v: number): { col: number; row: number } {
    const clampedU = Math.max(0, Math.min(1 - 1e-7, u));
    const clampedV = Math.max(0, Math.min(1 - 1e-7, v));
    const col = Math.max(0, Math.min(this.gridW - 1, Math.floor(clampedU * this.gridW)));
    const row = Math.max(0, Math.min(this.gridH - 1, Math.floor(clampedV * this.gridH)));
    return { col, row };
  }

  public getCell(col: number, row: number): GlassCellState {
    if (col < 0 || col >= this.gridW || row < 0 || row >= this.gridH) {
      return GLASS_CELL_VOID;
    }
    return this.cells[row * this.gridW + col] as GlassCellState;
  }

  public setCell(col: number, row: number, state: GlassCellState): void {
    if (col < 0 || col >= this.gridW || row < 0 || row >= this.gridH) {
      return;
    }
    const idx = row * this.gridW + col;
    const prev = this.cells[idx];
    if (prev === state) {
      return;
    }
    this.cells[idx] = state;
    if (prev !== GLASS_CELL_VOID && state === GLASS_CELL_VOID) {
      this.survivingCount--;
    } else if (prev === GLASS_CELL_VOID && state !== GLASS_CELL_VOID) {
      this.survivingCount++;
    }
  }

  public isBrokenAtUv(u: number, v: number): boolean {
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      return true;
    }
    const { col, row } = this.uvToGridCoords(u, v);
    return this.cells[row * this.gridW + col] === GLASS_CELL_VOID;
  }

  public getCellStateAtUv(u: number, v: number): GlassCellState {
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      return GLASS_CELL_VOID;
    }
    const { col, row } = this.uvToGridCoords(u, v);
    return this.cells[row * this.gridW + col] as GlassCellState;
  }

  public getCellBitmask(
    col: number,
    row: number,
    outOfBoundsIntact = this.frameBorderIntact,
  ): number {
    return computeNeighborBitmask8(
      this.cells,
      this.gridW,
      this.gridH,
      col,
      row,
      outOfBoundsIntact,
    );
  }

  /**
   * Resets all cells back to pristine intact glass (`GLASS_CELL_INTACT = 1`).
   */
  public reset(): void {
    this.cells.fill(GLASS_CELL_INTACT);
    this.survivingCount = this.cells.length;
    this.impactCounter = 0;
  }

  /**
   * Applies a ballistic or blast impact at normalized `(u, v)`:
   * - If the impacted cell is already broken (`0`), returns immediately with `alreadyBrokenHole: true`
   *   unless `radiusM` spans wider intact cells (e.g. blast shockwave).
   * - Zeroes out impacted cell(s) and runs a deterministic seeded radial random walk (`4–8` tendrils)
   *   marking neighboring cells spiderweb-cracked (`2`) or knocked out (`0`).
   */
  public applyImpact(options: MarchingGlassImpactOptions): MarchingGlassImpactReport {
    const u = Math.max(0, Math.min(1, options.u));
    const v = Math.max(0, Math.min(1, options.v));
    const energyJ = Math.max(0, options.energyJ);

    const { col: centerCol, row: centerRow } = this.uvToGridCoords(u, v);
    const centerIdx = centerRow * this.gridW + centerCol;
    const centerInitialState = this.cells[centerIdx];

    const cellWidthM = this.widthM / this.gridW;
    const cellHeightM = this.heightM / this.gridH;
    const minCellDimM = Math.min(cellWidthM, cellHeightM);

    // Physical knockout radius scales gently with projectile/blast radius & energy
    const requestedRadiusM =
      options.radiusM ??
      Math.min(
        Math.max(this.widthM, this.heightM) * 0.22,
        0.035 + Math.sqrt(Math.min(energyJ, 4000)) * 0.0014,
      );

    // If bullet hits an already open void cell with sub-cell caliber radius, pass cleanly through!
    if (
      centerInitialState === GLASS_CELL_VOID &&
      requestedRadiusM <= minCellDimM * 0.65
    ) {
      return {
        alreadyBrokenHole: true,
        cellsBroken: 0,
        cellsCracked: 0,
        tendrilsSpawned: 0,
        survivingCells: this.survivingCount,
      };
    }

    this.impactCounter++;
    const derivedSeed =
      options.seed ??
      (((centerCol + 1) * 73856093) ^
        ((centerRow + 1) * 19349663) ^
        (this.impactCounter * 83492791) ^
        Math.round(energyJ * 13));
    const rand = createDeterministicPrng(derivedSeed);

    let cellsBroken = 0;
    let cellsCracked = 0;

    const knockOutCell = (c: number, r: number): void => {
      if (c < 0 || c >= this.gridW || r < 0 || r >= this.gridH) return;
      const idx = r * this.gridW + c;
      if (this.cells[idx] !== GLASS_CELL_VOID) {
        this.cells[idx] = GLASS_CELL_VOID;
        this.survivingCount--;
        cellsBroken++;
      }
    };

    const crackCell = (c: number, r: number): void => {
      if (c < 0 || c >= this.gridW || r < 0 || r >= this.gridH) return;
      const idx = r * this.gridW + c;
      if (this.cells[idx] === GLASS_CELL_INTACT) {
        this.cells[idx] = GLASS_CELL_CRACKED;
        cellsCracked++;
      }
    };

    // Always knock out the impacted center cell
    knockOutCell(centerCol, centerRow);

    // If center cell was already spiderweb-cracked, expand knockout radius slightly (weakened pane)
    const effectiveRadiusM =
      centerInitialState === GLASS_CELL_CRACKED
        ? requestedRadiusM * 1.35
        : requestedRadiusM;

    const hitLocalX = u * this.widthM;
    const hitLocalY = v * this.heightM;
    const colRadius = Math.ceil(effectiveRadiusM / cellWidthM);
    const rowRadius = Math.ceil(effectiveRadiusM / cellHeightM);
    const radiusSq = effectiveRadiusM * effectiveRadiusM;

    for (let r = centerRow - rowRadius; r <= centerRow + rowRadius; r++) {
      if (r < 0 || r >= this.gridH) continue;
      const cellCenterY = (r + 0.5) * cellHeightM;
      const dy = cellCenterY - hitLocalY;
      for (let c = centerCol - colRadius; c <= centerCol + colRadius; c++) {
        if (c < 0 || c >= this.gridW) continue;
        const cellCenterX = (c + 0.5) * cellWidthM;
        const dx = cellCenterX - hitLocalX;
        const distSq = dx * dx + dy * dy;
        const jitterFactor = 0.82 + rand() * 0.34;
        if (distSq <= radiusSq * jitterFactor) {
          knockOutCell(c, r);
        } else if (distSq <= radiusSq * 2.1) {
          crackCell(c, r);
        }
      }
    }

    // Spawn 4..8 deterministic radial random-walk tendrils
    const energyNorm = Math.min(1, energyJ / 1800);
    const tendrilCount = Math.max(
      4,
      Math.min(8, 4 + Math.floor(energyNorm * 3.2 + rand() * 1.8)),
    );
    const maxWalkSteps = Math.max(
      2,
      Math.min(
        Math.max(this.gridW, this.gridH),
        Math.round(2.5 + energyNorm * 3.5 + (effectiveRadiusM / minCellDimM) * 0.75),
      ),
    );

    const baseAngle = rand() * Math.PI * 2;
    const angleStep = (Math.PI * 2) / tendrilCount;

    for (let t = 0; t < tendrilCount; t++) {
      let theta = baseAngle + t * angleStep + (rand() - 0.5) * angleStep * 0.45;
      let walkX = centerCol + 0.5;
      let walkY = centerRow + 0.5;
      const stepsForTendril = Math.max(
        2,
        Math.round(maxWalkSteps * (0.7 + rand() * 0.5)),
      );

      for (let s = 1; s <= stepsForTendril; s++) {
        // Subtle crystalline angular meander per step
        theta += (rand() - 0.5) * 0.52;
        walkX += Math.cos(theta) * 0.95;
        walkY += Math.sin(theta) * 0.95;

        const c = Math.floor(walkX);
        const r = Math.floor(walkY);
        if (c < 0 || c >= this.gridW || r < 0 || r >= this.gridH) {
          break;
        }

        const existing = this.cells[r * this.gridW + c];
        if (s === 1 && energyJ >= 350 && rand() < 0.45) {
          // High-velocity inner chip right next to bullet hole knocks out an extra tooth cell
          knockOutCell(c, r);
        } else if (existing === GLASS_CELL_CRACKED && s <= 2 && rand() < 0.55) {
          // Intersecting pre-existing spiderweb cracks knocks loose the weakened glass!
          knockOutCell(c, r);
        } else {
          crackCell(c, r);
        }
      }
    }

    // Prune any completely unsupported 1-cell floating islands (all 4 cardinal neighbors void)
    for (let r = 0; r < this.gridH; r++) {
      for (let c = 0; c < this.gridW; c++) {
        const idx = r * this.gridW + c;
        if (this.cells[idx] === GLASS_CELL_VOID) continue;
        const mask = computeNeighborBitmask8(
          this.cells,
          this.gridW,
          this.gridH,
          c,
          r,
          this.frameBorderIntact,
        );
        const cardinalMask =
          mask & (GLASS_DIR_N | GLASS_DIR_E | GLASS_DIR_S | GLASS_DIR_W);
        if (cardinalMask === 0) {
          knockOutCell(c, r);
        }
      }
    }

    return {
      alreadyBrokenHole: false,
      cellsBroken,
      cellsCracked,
      tendrilsSpawned: tendrilCount,
      survivingCells: this.survivingCount,
    };
  }

  /**
   * Writes surviving cells (`state !== 0`) into pre-allocated quad-grid `Float32Array` /
   * `Uint16Array` buffers (`0` quads emitted for zeroed-out cells so bullets fly cleanly
   * through broken holes and open voids render zero geometry).
   */
  public writeQuadGridBuffers(
    outPositions: Float32Array = this.positions,
    outNormals: Float32Array = this.normals,
    outUvs: Float32Array = this.uvs,
    outIndices: Uint16Array = this.indices,
    uvInset = 0,
    outColors: Float32Array = this.colors,
  ): MarchingQuadMeshBuildResult {
    const halfW = this.widthM * 0.5;
    const halfH = this.heightM * 0.5;
    const cellW = this.widthM / this.gridW;
    const cellH = this.heightM / this.gridH;

    let quadCount = 0;
    let vCursor = 0;
    let posCursor = 0;
    let uvCursor = 0;
    let colCursor = 0;
    let idxCursor = 0;

    for (let row = 0; row < this.gridH; row++) {
      const y0 = -halfH + row * cellH;
      const y1 = y0 + cellH;
      const rowOffset = row * this.gridW;

      for (let col = 0; col < this.gridW; col++) {
        const state = this.cells[rowOffset + col];
        if (state === GLASS_CELL_VOID) {
          continue;
        }

        const x0 = -halfW + col * cellW;
        const x1 = x0 + cellW;

        const mask = computeNeighborBitmask8(
          this.cells,
          this.gridW,
          this.gridH,
          col,
          row,
          this.frameBorderIntact,
        );
        const uv = bitmaskToAtlasUv(mask, uvInset);

        // Vertex 0: Bottom-Left (x0, y0)
        outPositions[posCursor] = x0;
        outPositions[posCursor + 1] = y0;
        outPositions[posCursor + 2] = 0;
        outNormals[posCursor] = 0;
        outNormals[posCursor + 1] = 0;
        outNormals[posCursor + 2] = 1;
        posCursor += 3;
        outUvs[uvCursor++] = uv.u0;
        outUvs[uvCursor++] = uv.v0;

        // Vertex 1: Bottom-Right (x1, y0)
        outPositions[posCursor] = x1;
        outPositions[posCursor + 1] = y0;
        outPositions[posCursor + 2] = 0;
        outNormals[posCursor] = 0;
        outNormals[posCursor + 1] = 0;
        outNormals[posCursor + 2] = 1;
        posCursor += 3;
        outUvs[uvCursor++] = uv.u1;
        outUvs[uvCursor++] = uv.v0;

        // Vertex 2: Top-Right (x1, y1)
        outPositions[posCursor] = x1;
        outPositions[posCursor + 1] = y1;
        outPositions[posCursor + 2] = 0;
        outNormals[posCursor] = 0;
        outNormals[posCursor + 1] = 0;
        outNormals[posCursor + 2] = 1;
        posCursor += 3;
        outUvs[uvCursor++] = uv.u1;
        outUvs[uvCursor++] = uv.v1;

        // Vertex 3: Top-Left (x0, y1)
        outPositions[posCursor] = x0;
        outPositions[posCursor + 1] = y1;
        outPositions[posCursor + 2] = 0;
        outNormals[posCursor] = 0;
        outNormals[posCursor + 1] = 0;
        outNormals[posCursor + 2] = 1;
        posCursor += 3;
        outUvs[uvCursor++] = uv.u0;
        outUvs[uvCursor++] = uv.v1;

        // Subtle frosted highlight tint for spiderweb-cracked cells (`state === 2`)
        const isCracked = state === GLASS_CELL_CRACKED || mask !== 255;
        const rC = isCracked ? 0.94 : 0.78;
        const gC = isCracked ? 0.98 : 0.91;
        const bC = 1.0;
        const aC = isCracked ? 1.0 : 0.85;
        if (colCursor + 16 <= outColors.length) {
          for (let k = 0; k < 4; k++) {
            outColors[colCursor++] = rC;
            outColors[colCursor++] = gC;
            outColors[colCursor++] = bC;
            outColors[colCursor++] = aC;
          }
        }

        // Two CCW triangles: (0, 1, 2) and (0, 2, 3)
        outIndices[idxCursor++] = vCursor;
        outIndices[idxCursor++] = vCursor + 1;
        outIndices[idxCursor++] = vCursor + 2;
        outIndices[idxCursor++] = vCursor;
        outIndices[idxCursor++] = vCursor + 2;
        outIndices[idxCursor++] = vCursor + 3;

        vCursor += 4;
        quadCount++;
      }
    }

    return {
      quadCount,
      vertexCount: vCursor,
      indexCount: idxCursor,
    };
  }
}
