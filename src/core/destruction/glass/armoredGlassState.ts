import { createDeterministicPrng, type GlassCellState, GLASS_CELL_VOID, GLASS_CELL_INTACT, GLASS_CELL_CRACKED } from '../glassMarchingTiles.ts';
import {
  ARMORED_CHUNK_CRAZED,
  ARMORED_CHUNK_DETACHED,
  ARMORED_CHUNK_FRACTURED,
  ARMORED_CHUNK_PRISTINE,
  type ArmoredMeshBuildStats,
  type ArmoredVoronoiImpactOptions,
  type ArmoredVoronoiImpactReport,
  type OrganicVoronoiLayoutOptions,
  type VoronoiGlassShardCell,
  type VoronoiWindowShatterResult,
} from './glassShardTypes.ts';
import { isPointInConvexPolygon2D } from './polygonMath2D.ts';
import { generateOrganicVoronoiCells2D } from './organicVoronoiLayout.ts';
import { applyArmoredImpact } from './armoredImpactSolver.ts';
import { writeArmoredMeshBuffers } from './armoredMeshBuilder.ts';

export class ArmoredVoronoiGlassPane {
  public readonly widthM: number;
  public readonly heightM: number;
  public readonly thicknessM: number;
  public readonly voronoi: VoronoiWindowShatterResult;
  public readonly chunks: ReadonlyArray<VoronoiGlassShardCell>;

  public readonly integrity: Float32Array;
  public readonly stage: Uint8Array;
  public readonly crazedIntensity: Float32Array;
  public readonly focusX: Float32Array;
  public readonly focusY: Float32Array;
  public readonly chunkFacetTiltX: Float32Array;
  public readonly chunkFacetTiltY: Float32Array;

  public readonly bfsVisited: Uint8Array;
  public readonly bfsQueue: Int32Array;
  public survivingCount: number;
  public impactCounter = 0;

  public constructor(options: OrganicVoronoiLayoutOptions) {
    this.widthM = Math.max(0.1, options.widthM);
    this.heightM = Math.max(0.1, options.heightM);
    this.thicknessM = Math.max(0.012, options.thicknessM ?? 0.024);

    this.voronoi = generateOrganicVoronoiCells2D({
      widthM: this.widthM,
      heightM: this.heightM,
      cellCount: options.cellCount ?? 68,
      thicknessM: this.thicknessM,
      seed: options.seed ?? 0x51a77e12,
    });
    this.chunks = this.voronoi.shards;

    const n = this.chunks.length;
    this.integrity = new Float32Array(n).fill(1.0);
    this.stage = new Uint8Array(n).fill(ARMORED_CHUNK_PRISTINE);
    this.crazedIntensity = new Float32Array(n).fill(0.0);
    this.focusX = new Float32Array(n);
    this.focusY = new Float32Array(n);
    this.chunkFacetTiltX = new Float32Array(n);
    this.chunkFacetTiltY = new Float32Array(n);
    this.bfsVisited = new Uint8Array(n);
    this.bfsQueue = new Int32Array(n);
    this.survivingCount = n;

    const tiltRand = createDeterministicPrng((options.seed ?? 0x51a77e12) ^ 0x9e3779b9);
    for (let i = 0; i < n; i++) {
      this.focusX[i] = this.chunks[i].centroid.x;
      this.focusY[i] = this.chunks[i].centroid.y;
      this.chunkFacetTiltX[i] = (tiltRand() - 0.5) * 2.0;
      this.chunkFacetTiltY[i] = (tiltRand() - 0.5) * 2.0;
    }
  }

  public get totalChunks(): number {
    return this.chunks.length;
  }

  public get survivingChunkCount(): number {
    return this.survivingCount;
  }

  public get detachedChunkCount(): number {
    return this.chunks.length - this.survivingCount;
  }

  public get crazedChunkCount(): number {
    let count = 0;
    for (let i = 0; i < this.stage.length; i++) {
      if (this.stage[i] === ARMORED_CHUNK_CRAZED || this.stage[i] === ARMORED_CHUNK_FRACTURED) {
        count++;
      }
    }
    return count;
  }

  public reset(): void {
    this.integrity.fill(1.0);
    this.stage.fill(ARMORED_CHUNK_PRISTINE);
    this.crazedIntensity.fill(0.0);
    for (let i = 0; i < this.chunks.length; i++) {
      this.focusX[i] = this.chunks[i].centroid.x;
      this.focusY[i] = this.chunks[i].centroid.y;
    }
    this.survivingCount = this.chunks.length;
    this.impactCounter = 0;
  }

  public findChunkAt(x: number, y: number): number {
    if (x < -1e-4 || x > this.widthM + 1e-4 || y < -1e-4 || y > this.heightM + 1e-4) {
      return -1;
    }
    const cx = Math.max(0, Math.min(this.widthM, x));
    const cy = Math.max(0, Math.min(this.heightM, y));
    for (let i = 0; i < this.chunks.length; i++) {
      if (isPointInConvexPolygon2D(this.chunks[i].polygon, cx, cy, 1e-5)) {
        return i;
      }
    }
    let bestIdx = 0;
    let bestDistSq = Infinity;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i].centroid;
      const dSq = (c.x - cx) * (c.x - cx) + (c.y - cy) * (c.y - cy);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  public isDetachedAt(x: number, y: number): boolean {
    const idx = this.findChunkAt(x, y);
    return idx < 0 || this.stage[idx] === ARMORED_CHUNK_DETACHED;
  }

  public sampleCellStateAtUv(u: number, v: number): GlassCellState {
    if (u < 0 || u > 1 || v < 0 || v > 1) return GLASS_CELL_VOID;
    const idx = this.findChunkAt(u * this.widthM, v * this.heightM);
    if (idx < 0) return GLASS_CELL_VOID;
    const st = this.stage[idx];
    if (st === ARMORED_CHUNK_DETACHED) return GLASS_CELL_VOID;
    return st === ARMORED_CHUNK_PRISTINE ? GLASS_CELL_INTACT : GLASS_CELL_CRACKED;
  }

  public applyImpact(options: ArmoredVoronoiImpactOptions): ArmoredVoronoiImpactReport {
    return applyArmoredImpact(this, options);
  }

  public writeArmoredMeshBuffers(
    outPositions: Float32Array,
    outNormals: Float32Array,
    outUvs: Float32Array,
    outColors: Float32Array,
    outIndices: Uint16Array,
  ): ArmoredMeshBuildStats {
    return writeArmoredMeshBuffers(this, outPositions, outNormals, outUvs, outColors, outIndices);
  }
}
