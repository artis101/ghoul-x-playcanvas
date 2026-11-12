import type { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  BRICK_CLOSER_MAX_HP,
  BRICK_FULL_MAX_HP,
  type BrickBedOverlap,
  type BrickCellSpec,
  type BrickDamageStage,
  type SolidBrickWallGrid,
} from './brickWallGridTypes.ts';

export interface SolidBrickGridOptions {
  readonly wallId: string;
  readonly cols: number;
  readonly rows: number;
  readonly brickW?: number;
  readonly brickH?: number;
  readonly brickD?: number;
  readonly mortarGapM?: number;
}

function getOddCourseParams(cols: number, widthM: number, stepX: number): {
  closerW: number;
  innerW: number;
} {
  if (cols <= 2) {
    const half = widthM * 0.5;
    return { closerW: half, innerW: half };
  }
  // Symmetric three-quarter queen-closers at both plumb ends + uniform staggered stretchers inside
  const closerW = 0.75 * stepX;
  const innerW = (widthM - 2 * closerW) / (cols - 2);
  return { closerW, innerW };
}

export function createSolidBrickWallGrid(opts: SolidBrickGridOptions): SolidBrickWallGrid {
  const cols = Math.max(2, Math.floor(opts.cols));
  const rows = Math.max(1, Math.floor(opts.rows));
  const brickW = Math.max(0.06, opts.brickW ?? 0.215);
  const brickH = Math.max(0.03, opts.brickH ?? 0.072);
  const thicknessM = Math.max(0.06, opts.brickD ?? 0.18);
  const mortarGapM = Math.max(0.002, opts.mortarGapM ?? 0.008);

  const stepX = brickW + mortarGapM;
  const stepY = brickH + mortarGapM;
  const widthM = cols * stepX;
  const heightM = rows * stepY;
  const halfW = widthM * 0.5;
  const halfD = thicknessM * 0.5;
  const { closerW, innerW } = getOddCourseParams(cols, widthM, stepX);

  const rowOffsets = new Int32Array(rows);
  const rowCounts = new Int32Array(rows);
  const totalCells = cols * rows;
  for (let r = 0; r < rows; r++) {
    rowOffsets[r] = r * cols;
    rowCounts[r] = cols;
  }

  const rawBounds: Array<{
    u0: number;
    u1: number;
    v0: number;
    v1: number;
    row: number;
    col: number;
    isCloser: boolean;
  }> = new Array(totalCells);

  for (let r = 0; r < rows; r++) {
    const isOdd = (r & 1) === 1;
    const base = r * cols;
    const v0 = r * stepY;
    const v1 = v0 + stepY;

    for (let c = 0; c < cols; c++) {
      let u0: number;
      let u1: number;
      let isCloser = false;
      if (!isOdd) {
        u0 = c * stepX;
        u1 = (c + 1) * stepX;
      } else if (cols === 2) {
        u0 = c * closerW;
        u1 = (c + 1) * closerW;
      } else if (c === 0) {
        u0 = 0;
        u1 = closerW;
        isCloser = true;
      } else if (c === cols - 1) {
        u0 = widthM - closerW;
        u1 = widthM;
        isCloser = true;
      } else {
        u0 = closerW + (c - 1) * innerW;
        u1 = closerW + c * innerW;
      }
      rawBounds[base + c] = { u0, u1, v0, v1, row: r, col: c, isCloser };
    }
  }

  const computeOverlaps = (cellIdx: number, targetRow: number): BrickBedOverlap[] => {
    if (targetRow < 0 || targetRow >= rows) return [];
    const src = rawBounds[cellIdx];
    const tBase = rowOffsets[targetRow];
    const tCount = rowCounts[targetRow];
    const out: BrickBedOverlap[] = [];
    for (let tc = 0; tc < tCount; tc++) {
      const nIdx = tBase + tc;
      const nb = rawBounds[nIdx];
      const o0 = Math.max(src.u0, nb.u0);
      const o1 = Math.min(src.u1, nb.u1);
      if (o1 - o0 > 1e-5) {
        out.push({ neighborIndex: nIdx, u0: o0, u1: o1 });
      }
    }
    return out;
  };

  const cells: BrickCellSpec[] = new Array(totalCells);
  const hp = new Float32Array(totalCells);

  for (let idx = 0; idx < totalCells; idx++) {
    const b = rawBounds[idx];
    const rowCount = rowCounts[b.row];
    const rowBase = rowOffsets[b.row];
    const maxHp = b.isCloser ? BRICK_CLOSER_MAX_HP : BRICK_FULL_MAX_HP;
    hp[idx] = maxHp;

    let h = (Math.imul(b.row + 17, 374761393) + Math.imul(b.col + 31, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;

    cells[idx] = {
      index: idx,
      row: b.row,
      col: b.col,
      u0: b.u0,
      u1: b.u1,
      v0: b.v0,
      v1: b.v1,
      localCenter: {
        x: (b.u0 + b.u1) * 0.5 - halfW,
        y: (b.v0 + b.v1) * 0.5,
        z: 0,
      },
      halfExtents: {
        x: (b.u1 - b.u0) * 0.5,
        y: (b.v1 - b.v0) * 0.5,
        z: halfD,
      },
      isHalfCloser: b.isCloser,
      maxHp,
      variantSeed: (h ^ (h >>> 16)) >>> 0,
      neighborLeft: b.col > 0 ? rowBase + b.col - 1 : -1,
      neighborRight: b.col + 1 < rowCount ? rowBase + b.col + 1 : -1,
      overlapsBelow: computeOverlaps(idx, b.row - 1),
      overlapsAbove: computeOverlaps(idx, b.row + 1),
    };
  }

  return {
    wallId: opts.wallId,
    cols,
    rows,
    brickW,
    brickH,
    thicknessM,
    mortarGapM,
    stepX,
    stepY,
    widthM,
    heightM,
    cells,
    rowOffsets,
    rowCounts,
    hp,
    frontGouge: new Float32Array(totalCells),
    backGouge: new Float32Array(totalCells),
    hitCount: new Uint16Array(totalCells),
    bfsVisitedScratch: new Uint8Array(totalCells),
    bfsQueueScratch: new Int32Array(totalCells),
  };
}

export function resetSolidBrickWallGrid(grid: SolidBrickWallGrid): void {
  for (let i = 0; i < grid.cells.length; i++) {
    grid.hp[i] = grid.cells[i].maxHp;
  }
  grid.frontGouge.fill(0);
  grid.backGouge.fill(0);
  grid.hitCount.fill(0);
}

export function getBrickDamageStage(grid: SolidBrickWallGrid, index: number): BrickDamageStage {
  if (index < 0 || index >= grid.cells.length) return 'DESTROYED';
  const curHp = grid.hp[index];
  if (curHp <= 0) return 'DESTROYED';
  const dmgFrac = 1 - curHp / grid.cells[index].maxHp;
  if (dmgFrac < 0.02) return 'INTACT';
  if (dmgFrac < 0.45) return 'CHIPPED';
  return 'CRACKED';
}

export function findBrickAtLocalUV(grid: SolidBrickWallGrid, u: number, v: number): number {
  if (u < 0 || u > grid.widthM || v < 0 || v > grid.heightM) {
    return -1;
  }
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(v / grid.stepY)));
  const rowBase = grid.rowOffsets[row];
  const cols = grid.cols;

  if ((row & 1) === 0) {
    const col = Math.min(cols - 1, Math.max(0, Math.floor(u / grid.stepX)));
    return rowBase + col;
  }

  const { closerW, innerW } = getOddCourseParams(cols, grid.widthM, grid.stepX);
  if (cols <= 2) {
    return rowBase + (u < closerW ? 0 : 1);
  }
  if (u < closerW) return rowBase;
  if (u >= grid.widthM - closerW) return rowBase + cols - 1;
  const col = Math.min(cols - 2, 1 + Math.floor((u - closerW) / innerW));
  return rowBase + col;
}

export function findFirstSolidBrickAlongLocalRay(
  grid: SolidBrickWallGrid,
  localOrigin: Vec3Like,
  localDir: Vec3Like,
  maxDistM: number
): { brickIndex: number; hitLocal: Vec3Like; hitFromFront: boolean } | null {
  const halfW = grid.widthM * 0.5;
  const halfD = grid.thicknessM * 0.5;

  let tMin = 0;
  let tMax = maxDistM;

  const clipAxis = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-8) {
      return o >= lo - 1e-4 && o <= hi + 1e-4;
    }
    const invD = 1 / d;
    let t0 = (lo - o) * invD;
    let t1 = (hi - o) * invD;
    if (t0 > t1) {
      const tmp = t0;
      t0 = t1;
      t1 = tmp;
    }
    if (t0 > tMin) tMin = t0;
    if (t1 < tMax) tMax = t1;
    return tMin <= tMax + 1e-5;
  };

  if (
    !clipAxis(localOrigin.x, localDir.x, -halfW, halfW) ||
    !clipAxis(localOrigin.y, localDir.y, 0, grid.heightM) ||
    !clipAxis(localOrigin.z, localDir.z, -halfD, halfD)
  ) {
    return null;
  }

  const hitFromFront = Math.abs(localDir.z) > 1e-5 ? localDir.z < 0 : localOrigin.z >= 0;
  const samples = 5;
  const span = Math.max(0, tMax - tMin);
  for (let s = 0; s <= samples; s++) {
    const t = tMin + (span * s) / samples;
    const lx = localOrigin.x + localDir.x * t;
    const ly = localOrigin.y + localDir.y * t;
    const lz = localOrigin.z + localDir.z * t;
    const u = Math.min(grid.widthM - 1e-5, Math.max(1e-5, lx + halfW));
    const v = Math.min(grid.heightM - 1e-5, Math.max(1e-5, ly));
    const idx = findBrickAtLocalUV(grid, u, v);
    if (idx >= 0 && grid.hp[idx] > 0) {
      return {
        brickIndex: idx,
        hitLocal: { x: lx, y: ly, z: lz },
        hitFromFront,
      };
    }
  }

  return null;
}

export function isPlayerPassableInBrickGrid(
  grid: SolidBrickWallGrid,
  localX: number,
  radiusM = 0.34
): boolean {
  let destroyed = 0;
  for (let i = 0; i < grid.cells.length; i++) {
    if (grid.hp[i] <= 0) destroyed++;
  }
  if (destroyed >= grid.cells.length * 0.65) {
    return true;
  }

  const halfW = grid.widthM * 0.5;
  const uMin = Math.max(0, localX - radiusM * 0.7 + halfW);
  const uMax = Math.min(grid.widthM, localX + radiusM * 0.7 + halfW);
  const vMin = 0.16;
  const vMax = Math.min(grid.heightM - 0.04, 1.52);
  if (uMax <= uMin || vMax <= vMin) return false;

  const rStart = Math.max(0, Math.floor(vMin / grid.stepY));
  const rEnd = Math.min(grid.rows - 1, Math.floor(vMax / grid.stepY));
  for (let r = rStart; r <= rEnd; r++) {
    const base = grid.rowOffsets[r];
    const count = grid.rowCounts[r];
    for (let c = 0; c < count; c++) {
      const idx = base + c;
      const cell = grid.cells[idx];
      if (cell.u1 > uMin + 0.01 && cell.u0 < uMax - 0.01 && grid.hp[idx] > 0) {
        return false;
      }
    }
  }
  return true;
}
