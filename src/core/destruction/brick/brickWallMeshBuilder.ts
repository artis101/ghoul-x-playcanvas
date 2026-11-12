import type {
  BrickCellSpec,
  BrickWallMeshBuffers,
  BrickWallMeshStats,
  SolidBrickWallGrid,
} from './brickWallGridTypes.ts';

// 3-Band UV Atlas V coordinates (avoids mip/linear bleed between bands):
// Band 1 [0.03 .. 0.47]: Intact flush brick + recessed lime-mortar joint border
// Band 2 [0.53 .. 0.75]: Spalled / gouged / cracked damaged clay brick core
// Band 3 [0.81 .. 0.97]: Rough mortar bed & broken brick cavity rim (holes & outer edges)
const BAND1_V0 = 0.03;
const BAND1_V1 = 0.47;
const BAND2_V0 = 0.53;
const BAND2_V1 = 0.75;
const BAND3_V0 = 0.81;
const BAND3_V1 = 0.97;

interface MeshWriterCursor {
  v: number;
  i: number;
  readonly maxV: number;
  readonly maxI: number;
  readonly pos: Float32Array;
  readonly nrm: Float32Array;
  readonly uvs: Float32Array;
  readonly col: Float32Array;
  readonly idx: Uint16Array | Uint32Array;
}

function emitQuad(
  w: MeshWriterCursor,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  x3: number, y3: number, z3: number,
  u0: number, v0: number,
  u1: number, v1: number,
  r: number, g: number, b: number
): void {
  if (w.v + 4 > w.maxV || w.i + 6 > w.maxI) return;

  const abx = x1 - x0;
  const aby = y1 - y0;
  const abz = z1 - z0;
  const acx = x2 - x0;
  const acy = y2 - y0;
  const acz = z2 - z0;
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;

  const base = w.v;
  const pOff = base * 3;
  w.pos[pOff] = x0;     w.pos[pOff + 1] = y0;     w.pos[pOff + 2] = z0;
  w.pos[pOff + 3] = x1; w.pos[pOff + 4] = y1;     w.pos[pOff + 5] = z1;
  w.pos[pOff + 6] = x2; w.pos[pOff + 7] = y2;     w.pos[pOff + 8] = z2;
  w.pos[pOff + 9] = x3; w.pos[pOff + 10] = y3;    w.pos[pOff + 11] = z3;

  for (let k = 0; k < 12; k += 3) {
    w.nrm[pOff + k] = nx;
    w.nrm[pOff + k + 1] = ny;
    w.nrm[pOff + k + 2] = nz;
  }

  const uOff = base * 2;
  w.uvs[uOff] = u0;     w.uvs[uOff + 1] = v0;
  w.uvs[uOff + 2] = u1; w.uvs[uOff + 3] = v0;
  w.uvs[uOff + 4] = u1; w.uvs[uOff + 5] = v1;
  w.uvs[uOff + 6] = u0; w.uvs[uOff + 7] = v1;

  const cOff = base * 4;
  for (let k = 0; k < 16; k += 4) {
    w.col[cOff + k] = r;
    w.col[cOff + k + 1] = g;
    w.col[cOff + k + 2] = b;
    w.col[cOff + k + 3] = 1.0;
  }

  const iOff = w.i;
  w.idx[iOff] = base;
  w.idx[iOff + 1] = base + 1;
  w.idx[iOff + 2] = base + 2;
  w.idx[iOff + 3] = base;
  w.idx[iOff + 4] = base + 2;
  w.idx[iOff + 5] = base + 3;

  w.v += 4;
  w.i += 6;
}

function emitBrickFace(
  w: MeshWriterCursor,
  cell: BrickCellSpec,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  zFace: number,
  isFront: boolean,
  gougeFrac: number,
  thicknessM: number,
  baseR: number,
  baseG: number,
  baseB: number
): void {
  // Half-brick closers map U across [0..0.52] or [0.48..1.0] so mortar border width matches full stretchers
  const uStart = cell.isHalfCloser ? (cell.col === 0 ? 0.0 : 0.48) : 0.0;
  const uEnd = cell.isHalfCloser ? (cell.col === 0 ? 0.52 : 1.0) : 1.0;

  if (gougeFrac < 0.02) {
    if (isFront) {
      emitQuad(w, x0, y0, zFace, x1, y0, zFace, x1, y1, zFace, x0, y1, zFace, uStart, BAND1_V0, uEnd, BAND1_V1, baseR, baseG, baseB);
    } else {
      emitQuad(w, x1, y0, zFace, x0, y0, zFace, x0, y1, zFace, x1, y1, zFace, uStart, BAND1_V0, uEnd, BAND1_V1, baseR, baseG, baseB);
    }
    return;
  }

  // Progressive 3D spall/gouge pocket carved into the brick face before full punch-out:
  // Outer mortar/brick lip stays watertight at zFace while inner core recesses inward!
  const spanX = x1 - x0;
  const spanY = y1 - y0;
  const seed = cell.variantSeed;
  const jx = (((seed & 0xff) / 255) - 0.5) * 0.08;
  const jy = ((((seed >>> 8) & 0xff) / 255) - 0.5) * 0.08;

  // Rim shrinks as damage grows: light chip = wider intact border, heavy crack = wide ragged crater
  const rimFracX = Math.max(0.10, 0.28 - gougeFrac * 0.16);
  const rimFracY = Math.max(0.13, 0.30 - gougeFrac * 0.15);

  const ix0 = x0 + spanX * Math.max(0.06, rimFracX + jx);
  const ix1 = x1 - spanX * Math.max(0.06, rimFracX - jx);
  const iy0 = y0 + spanY * Math.max(0.08, rimFracY + jy);
  const iy1 = y1 - spanY * Math.max(0.08, rimFracY - jy);

  const depth = gougeFrac * thicknessM * 0.44;
  const zInner = isFront ? zFace - depth : zFace + depth;

  const rimDark = 1 - gougeFrac * 0.18;
  const rRim = baseR * rimDark;
  const gRim = baseG * rimDark;
  const bRim = baseB * rimDark;

  const pitAo = Math.max(0.46, 0.86 - gougeFrac * 0.36);
  const rPit = baseR * pitAo;
  const gPit = baseG * pitAo;
  const bPit = baseB * pitAo;

  const bu0 = 0.08 + ((seed >>> 16) & 0x1f) / 255;
  const bu1 = bu0 + 0.72;

  if (isFront) {
    // 4 beveled rim quads sloping from flush mortar perimeter at +halfD into recessed spall floor
    emitQuad(w, x0, y0, zFace, x1, y0, zFace, ix1, iy0, zInner, ix0, iy0, zInner, uStart, BAND1_V0, uEnd, BAND1_V0 + 0.12, rRim, gRim, bRim);
    emitQuad(w, ix0, iy1, zInner, ix1, iy1, zInner, x1, y1, zFace, x0, y1, zFace, uStart, BAND1_V1 - 0.12, uEnd, BAND1_V1, rRim, gRim, bRim);
    emitQuad(w, x0, y0, zFace, ix0, iy0, zInner, ix0, iy1, zInner, x0, y1, zFace, bu0, BAND2_V0, bu0 + 0.22, BAND2_V1, rPit, gPit, bPit);
    emitQuad(w, ix1, iy0, zInner, x1, y0, zFace, x1, y1, zFace, ix1, iy1, zInner, bu1 - 0.22, BAND2_V0, bu1, BAND2_V1, rPit, gPit, bPit);
    // Recessed fractured clay crater floor
    emitQuad(w, ix0, iy0, zInner, ix1, iy0, zInner, ix1, iy1, zInner, ix0, iy1, zInner, bu0, BAND2_V0, bu1, BAND2_V1, rPit, gPit, bPit);
  } else {
    emitQuad(w, x1, y0, zFace, x0, y0, zFace, ix0, iy0, zInner, ix1, iy0, zInner, uStart, BAND1_V0, uEnd, BAND1_V0 + 0.12, rRim, gRim, bRim);
    emitQuad(w, ix1, iy1, zInner, ix0, iy1, zInner, x0, y1, zFace, x1, y1, zFace, uStart, BAND1_V1 - 0.12, uEnd, BAND1_V1, rRim, gRim, bRim);
    emitQuad(w, x1, y0, zFace, ix1, iy0, zInner, ix1, iy1, zInner, x1, y1, zFace, bu0, BAND2_V0, bu0 + 0.22, BAND2_V1, rPit, gPit, bPit);
    emitQuad(w, ix0, iy0, zInner, x0, y0, zFace, x0, y1, zFace, ix0, iy1, zInner, bu1 - 0.22, BAND2_V0, bu1, BAND2_V1, rPit, gPit, bPit);
    emitQuad(w, ix1, iy0, zInner, ix0, iy0, zInner, ix0, iy1, zInner, ix1, iy1, zInner, bu0, BAND2_V0, bu1, BAND2_V1, rPit, gPit, bPit);
  }
}

export function buildSolidBrickWallMesh(
  grid: SolidBrickWallGrid,
  buffers: BrickWallMeshBuffers
): BrickWallMeshStats {
  const writer: MeshWriterCursor = {
    v: 0,
    i: 0,
    maxV: Math.floor(buffers.positions.length / 3),
    maxI: buffers.indices.length,
    pos: buffers.positions,
    nrm: buffers.normals,
    uvs: buffers.uvs,
    col: buffers.colors,
    idx: buffers.indices,
  };

  const halfW = grid.widthM * 0.5;
  const halfD = grid.thicknessM * 0.5;
  let intactBrickCount = 0;
  let damagedBrickCount = 0;
  let destroyedBrickCount = 0;

  for (let idx = 0; idx < grid.cells.length; idx++) {
    const curHp = grid.hp[idx];
    if (curHp <= 0) {
      destroyedBrickCount++;
      continue;
    }

    intactBrickCount++;
    const cell = grid.cells[idx];
    const dmgFrac = 1 - curHp / cell.maxHp;
    if (dmgFrac >= 0.02) {
      damagedBrickCount++;
    }

    const x0 = cell.u0 - halfW;
    const x1 = cell.u1 - halfW;
    const y0 = cell.v0;
    const y1 = cell.v1;

    // Subtle natural kiln-fired terracotta shade variation + lower-course ground AO (never harsh black bricks!)
    const kilnNoise = (((cell.variantSeed & 0x3ff) / 1023) - 0.5) * 0.14;
    const groundAo = 0.86 + 0.14 * Math.min(1, cell.v0 / 0.42);
    const baseR = Math.min(1.05, Math.max(0.76, (0.95 + kilnNoise) * groundAo));
    const baseG = Math.min(1.02, Math.max(0.74, (0.93 + kilnNoise * 0.75) * groundAo));
    const baseB = Math.min(1.0, Math.max(0.72, (0.91 + kilnNoise * 0.55) * groundAo));

    // 1. Front (+Z) and Back (-Z) masonry faces (with progressive 3D spall/gouge deformation)
    emitBrickFace(
      writer, cell, x0, x1, y0, y1, halfD, true,
      grid.frontGouge[idx], grid.thicknessM, baseR, baseG, baseB
    );
    emitBrickFace(
      writer, cell, x0, x1, y0, y1, -halfD, false,
      grid.backGouge[idx], grid.thicknessM, baseR, baseG, baseB
    );

    // 2. Exposed Left (-X) & Right (+X) faces (outer wall end-caps OR interior punched-hole vertical rims!)
    const leftExposed = cell.neighborLeft < 0 || grid.hp[cell.neighborLeft] <= 0;
    if (leftExposed) {
      const isHoleRim = cell.neighborLeft >= 0;
      const ao = isHoleRim ? 0.68 : 0.90;
      emitQuad(
        writer,
        x0, y0, -halfD,
        x0, y0, halfD,
        x0, y1, halfD,
        x0, y1, -halfD,
        0.05, BAND3_V0, 0.95, BAND3_V1,
        baseR * ao, baseG * ao, baseB * ao
      );
    }

    const rightExposed = cell.neighborRight < 0 || grid.hp[cell.neighborRight] <= 0;
    if (rightExposed) {
      const isHoleRim = cell.neighborRight >= 0;
      const ao = isHoleRim ? 0.68 : 0.90;
      emitQuad(
        writer,
        x1, y0, halfD,
        x1, y0, -halfD,
        x1, y1, -halfD,
        x1, y1, halfD,
        0.05, BAND3_V0, 0.95, BAND3_V1,
        baseR * ao, baseG * ao, baseB * ao
      );
    }

    // 3. Exposed Bottom (-Y) & Top (+Y) bed faces (outer top/bottom caps + exact stepped hole overhangs!)
    if (cell.overlapsBelow.length === 0) {
      emitQuad(
        writer,
        x0, y0, -halfD,
        x1, y0, -halfD,
        x1, y0, halfD,
        x0, y0, halfD,
        0.05, BAND3_V0, 0.95, BAND3_V1,
        baseR * 0.72, baseG * 0.72, baseB * 0.72
      );
    } else {
      for (let b = 0; b < cell.overlapsBelow.length; b++) {
        const ov = cell.overlapsBelow[b];
        if (grid.hp[ov.neighborIndex] <= 0) {
          const ox0 = ov.u0 - halfW;
          const ox1 = ov.u1 - halfW;
          emitQuad(
            writer,
            ox0, y0, -halfD,
            ox1, y0, -halfD,
            ox1, y0, halfD,
            ox0, y0, halfD,
            0.05, BAND3_V0, 0.95, BAND3_V1,
            baseR * 0.64, baseG * 0.64, baseB * 0.64
          );
        }
      }
    }

    if (cell.overlapsAbove.length === 0) {
      emitQuad(
        writer,
        x0, y1, halfD,
        x1, y1, halfD,
        x1, y1, -halfD,
        x0, y1, -halfD,
        0.05, BAND3_V0, 0.95, BAND3_V1,
        baseR * 0.94, baseG * 0.94, baseB * 0.94
      );
    } else {
      for (let a = 0; a < cell.overlapsAbove.length; a++) {
        const ov = cell.overlapsAbove[a];
        if (grid.hp[ov.neighborIndex] <= 0) {
          const ox0 = ov.u0 - halfW;
          const ox1 = ov.u1 - halfW;
          emitQuad(
            writer,
            ox0, y1, halfD,
            ox1, y1, halfD,
            ox1, y1, -halfD,
            ox0, y1, -halfD,
            0.05, BAND3_V0, 0.95, BAND3_V1,
            baseR * 0.70, baseG * 0.70, baseB * 0.70
          );
        }
      }
    }
  }

  return {
    vertexCount: writer.v,
    indexCount: writer.i,
    intactBrickCount,
    damagedBrickCount,
    destroyedBrickCount,
  };
}
