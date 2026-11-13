import { createSeededRng } from '../../destruction/wood/jaggedHoleStamp.ts';
import { cutHeightAt, type CutSurface } from './severCutSurface.ts';

/** A flat-shaded triangle soup in the cut bone's local frame. */
export interface CapMeshData {
  positions: number[];
  normals: number[];
  indices: number[];
}

export interface CutCapGeometry {
  /** Torn muscle over the cut, with a skirt reaching back under the ragged skin edge. */
  meat: CapMeshData;
  /** Splintered bone cross-sections standing out of the meat. */
  bone: CapMeshData;
}

export interface CutCapOptions {
  /** +1: the stump, facing down the limb (+Y). -1: the flying piece, facing back up it. */
  facing: 1 | -1;
  /** How far the meat skirt reaches back under the skin edge. */
  skirtM: number;
  /** Two for forearm and shin (radius/ulna, tibia/fibula), else one. */
  boneCount: 1 | 2;
  seed: number;
}

type P3 = [number, number, number];

function pushTriangle(mesh: CapMeshData, a: P3, b: P3, c: P3, want: P3): void {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return;
  nx /= len;
  ny /= len;
  nz /= len;
  let order: P3[] = [a, b, c];
  if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
    order = [a, c, b];
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  for (const p of order) {
    mesh.indices.push(mesh.positions.length / 3);
    mesh.positions.push(p[0], p[1], p[2]);
    mesh.normals.push(nx, ny, nz);
  }
}

function pushQuad(mesh: CapMeshData, a: P3, b: P3, c: P3, d: P3, want: P3): void {
  pushTriangle(mesh, a, b, c, want);
  pushTriangle(mesh, a, c, d, want);
}

function buildMeat(surface: CutSurface, opts: CutCapOptions, rng: () => number): CapMeshData {
  const mesh: CapMeshData = { positions: [], normals: [], indices: [] };
  const { centerX: cx, centerZ: cz, radiusM: r } = surface;
  const f = opts.facing;
  const up: P3 = [0, f, 0];
  const center: P3 = [cx, cutHeightAt(surface, cx, cz) + f * r * 0.08, cz];
  const rim: P3[] = [];
  const mid: P3[] = [];
  const skirt: P3[] = [];
  for (const sample of surface.rim) {
    const c = Math.cos(sample.angle);
    const s = Math.sin(sample.angle);
    const rho = sample.radiusScale * r * 0.99;
    const rx = cx + c * rho;
    const rz = cz + s * rho;
    const rimY = cutHeightAt(surface, rx, rz);
    rim.push([rx, rimY, rz]);
    const mx = cx + c * rho * (0.45 + rng() * 0.2);
    const mz = cz + s * rho * (0.45 + rng() * 0.2);
    mid.push([mx, cutHeightAt(surface, mx, mz) + f * r * (rng() - 0.3) * 0.14, mz]);
    skirt.push([cx + c * rho * 0.96, rimY - f * opts.skirtM, cz + s * rho * 0.96]);
  }
  const n = rim.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    pushTriangle(mesh, center, mid[i], mid[j], up);
    pushQuad(mesh, mid[i], rim[i], rim[j], mid[j], up);
    const outward: P3 = [rim[i][0] + rim[j][0] - 2 * cx, 0, rim[i][2] + rim[j][2] - 2 * cz];
    pushQuad(mesh, rim[i], skirt[i], skirt[j], rim[j], outward);
  }
  return mesh;
}

function buildBones(surface: CutSurface, opts: CutCapOptions, rng: () => number): CapMeshData {
  const mesh: CapMeshData = { positions: [], normals: [], indices: [] };
  const { centerX, centerZ, radiusM: r } = surface;
  const f = opts.facing;
  const up: P3 = [0, f, 0];
  const offsets = opts.boneCount === 2 ? [-0.3, 0.3] : [(rng() - 0.5) * 0.12];
  const boneRadius = r * (opts.boneCount === 2 ? 0.16 : 0.25);
  for (const offset of offsets) {
    const bx = centerX + offset * r;
    const bz = centerZ + (rng() - 0.5) * 0.1 * r;
    const baseY = cutHeightAt(surface, bx, bz) - f * r * 0.06;
    const protrude = r * (0.25 + rng() * 0.3);
    const sides = 7;
    const base: P3[] = [];
    const top: P3[] = [];
    let topSum = 0;
    for (let k = 0; k < sides; k++) {
      const a = ((k + (rng() - 0.5) * 0.4) / sides) * Math.PI * 2;
      const rr = boneRadius * (0.75 + rng() * 0.4);
      const x = bx + Math.cos(a) * rr;
      const z = bz + Math.sin(a) * rr;
      // Splintered: every other point of the break stands proud of its neighbours.
      const h = protrude * (k % 2 === 0 ? 0.9 + rng() * 0.6 : 0.35 + rng() * 0.3);
      base.push([x, baseY, z]);
      top.push([x, baseY + f * h, z]);
      topSum += h;
    }
    const peak: P3 = [bx, baseY + f * (topSum / sides) * 0.7, bz];
    for (let k = 0; k < sides; k++) {
      const m = (k + 1) % sides;
      pushTriangle(mesh, peak, top[k], top[m], up);
      const outward: P3 = [top[k][0] + top[m][0] - 2 * bx, 0, top[k][2] + top[m][2] - 2 * bz];
      pushQuad(mesh, base[k], base[m], top[m], top[k], outward);
    }
  }
  return mesh;
}

/**
 * Builds the wound over one side of a cut: the stump (`facing` +1) or the flying piece (-1).
 * Both come from the same surface, so their ragged rims match where the limb tore.
 */
export function buildCutCapGeometry(surface: CutSurface, opts: CutCapOptions): CutCapGeometry {
  const rng = createSeededRng((opts.seed ^ (opts.facing > 0 ? 0x27d4eb2f : 0x165667b1)) >>> 0);
  return { meat: buildMeat(surface, opts, rng), bone: buildBones(surface, opts, rng) };
}
