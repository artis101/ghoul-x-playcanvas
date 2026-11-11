import {
  GLASS_CELL_INTACT,
  GLASS_CELL_VOID,
  type GlassCellState,
  type MarchingGlassImpactOptions,
  type MarchingGlassImpactReport,
  type MarchingGlassPaneOptions,
  type MarchingQuadMeshBuildResult,
} from './marchingTileTypes.ts';
import { computeNeighborBitmask8 } from './marchingBitmaskMath.ts';
import { applyMarchingImpact } from './marchingImpactSolver.ts';
import { writeMarchingQuadGridBuffers } from './marchingQuadBuilder.ts';

export class MarchingGlassPane {
  public readonly widthM: number;
  public readonly heightM: number;
  public readonly gridW: number;
  public readonly gridH: number;
  public readonly frameBorderIntact: boolean;
  public readonly cells: Uint8Array;

  public readonly positions: Float32Array;
  public readonly normals: Float32Array;
  public readonly uvs: Float32Array;
  public readonly colors: Float32Array;
  public readonly indices: Uint16Array;

  public impactCounter = 0;
  public survivingCount: number;

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

  public reset(): void {
    this.cells.fill(GLASS_CELL_INTACT);
    this.survivingCount = this.cells.length;
    this.impactCounter = 0;
  }

  public syncFromUvSampler(
    sampleStateAtUv: (u: number, v: number) => GlassCellState,
  ): void {
    let surviving = 0;
    const invW = 1 / this.gridW;
    const invH = 1 / this.gridH;
    for (let r = 0; r < this.gridH; r++) {
      const v = (r + 0.5) * invH;
      const rowOffset = r * this.gridW;
      for (let c = 0; c < this.gridW; c++) {
        const u = (c + 0.5) * invW;
        const st = sampleStateAtUv(u, v);
        this.cells[rowOffset + c] = st;
        if (st !== GLASS_CELL_VOID) {
          surviving++;
        }
      }
    }
    this.survivingCount = surviving;
  }

  public applyImpact(options: MarchingGlassImpactOptions): MarchingGlassImpactReport {
    return applyMarchingImpact(this, options);
  }

  public writeQuadGridBuffers(
    outPositions: Float32Array = this.positions,
    outNormals: Float32Array = this.normals,
    outUvs: Float32Array = this.uvs,
    outIndices: Uint16Array = this.indices,
    uvInset = 0,
    outColors: Float32Array = this.colors,
  ): MarchingQuadMeshBuildResult {
    return writeMarchingQuadGridBuffers(
      this,
      outPositions,
      outNormals,
      outUvs,
      outIndices,
      uvInset,
      outColors,
    );
  }
}
