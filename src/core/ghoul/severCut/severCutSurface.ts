import type { SeverCut } from '../../../contracts/ballistics.ts';
import { createSeededRng } from '../../destruction/wood/jaggedHoleStamp.ts';

const TWO_PI = Math.PI * 2;

/** One sample of the torn rim, going round the limb. */
export interface CutRimSample {
  /** Angle round the bone axis, in the bone's local XZ plane. */
  angle: number;
  /** Rim radius as a fraction of the limb radius. */
  radiusScale: number;
  /** How far the rim sits off the cut plane along the bone, as a fraction of the limb radius. */
  depthScale: number;
}

/**
 * The surface a limb tore along, in the cut bone's local frame (bone axis = +Y). Its height
 * is a tilted plane through the impact plus a stepped Voronoi-cell rim, so the stump and the
 * flying piece share one ragged edge.
 */
export interface CutSurface {
  cutY: number;
  centerX: number;
  centerZ: number;
  radiusM: number;
  tiltX: number;
  tiltZ: number;
  rim: CutRimSample[];
}

interface FractureCell {
  x: number;
  z: number;
  depth: number;
  radius: number;
}

export const DEFAULT_RIM_SAMPLES = 28;

/**
 * Tears the rim along Voronoi cells: seeds are scattered round an annulus about the cut and
 * every rim point takes the depth of the cell it falls in, so the edge steps in chunks. Points
 * close to a cell border get a fang, and the side the bullet left through is torn further out.
 */
export function buildJaggedRim(seed: number, exitAngle: number, samples = DEFAULT_RIM_SAMPLES): CutRimSample[] {
  const rng = createSeededRng(seed);
  const cellCount = 6 + Math.floor(rng() * 4);
  const cells: FractureCell[] = [];
  for (let k = 0; k < cellCount; k++) {
    const angle = ((k + rng() * 0.85) / cellCount) * TWO_PI;
    const rho = 0.6 + rng() * 0.65;
    const blowout = Math.max(0, Math.cos(angle - exitAngle));
    cells.push({
      x: Math.cos(angle) * rho,
      z: Math.sin(angle) * rho,
      depth: (rng() - 0.5) * 1.1 + blowout * 0.45,
      radius: 0.95 + rng() * 0.13,
    });
  }

  const rim: CutRimSample[] = [];
  for (let i = 0; i < samples; i++) {
    const angle = ((i + (rng() - 0.5) * 0.5) / samples) * TWO_PI;
    const px = Math.cos(angle);
    const pz = Math.sin(angle);
    let nearest = 0;
    let nearestD = Infinity;
    let secondD = Infinity;
    for (let k = 0; k < cells.length; k++) {
      const d = Math.hypot(px - cells[k].x, pz - cells[k].z);
      if (d < nearestD) {
        secondD = nearestD;
        nearestD = d;
        nearest = k;
      } else if (d < secondD) {
        secondD = d;
      }
    }
    const cell = cells[nearest];
    const onBorder = secondD - nearestD < 0.14;
    const fang = onBorder ? (rng() < 0.5 ? -1 : 1) * (0.2 + rng() * 0.2) : 0;
    rim.push({
      angle: ((angle % TWO_PI) + TWO_PI) % TWO_PI,
      radiusScale: cell.radius + (rng() - 0.5) * 0.05,
      depthScale: cell.depth + fang + (rng() - 0.5) * 0.12,
    });
  }
  rim.sort((a, b) => a.angle - b.angle);
  return rim;
}

/** Builds the cut surface for a limb section measured in the engine (centre and radius at `cutY`). */
export function createCutSurface(
  cut: SeverCut,
  cutY: number,
  centerX: number,
  centerZ: number,
  radiusM: number
): CutSurface {
  // The bullet left on the far side from where it entered; that side tears out furthest.
  const exitAngle = Math.atan2(-cut.entryLocal.z, -cut.entryLocal.x);
  const rng = createSeededRng(cut.seed ^ 0x5bd1e995);
  // The cut leans with the shot; a sideways shot through a limb tears it on a slant.
  const lean = 0.12 + rng() * 0.22;
  const sx = cut.shotDirLocal.x;
  const sz = cut.shotDirLocal.z;
  const sideways = Math.hypot(sx, sz);
  const leanAngle = sideways > 1e-3 ? Math.atan2(sz, sx) : rng() * TWO_PI;
  return {
    cutY,
    centerX,
    centerZ,
    radiusM,
    tiltX: Math.cos(leanAngle) * lean * Math.sign(cut.shotDirLocal.y || 1),
    tiltZ: Math.sin(leanAngle) * lean * Math.sign(cut.shotDirLocal.y || 1),
    rim: buildJaggedRim(cut.seed, exitAngle),
  };
}

/** Linearly interpolates the rim round the limb at `angle`. */
export function sampleRim(rim: readonly CutRimSample[], angle: number): { radiusScale: number; depthScale: number } {
  const a = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
  const n = rim.length;
  let hi = 0;
  while (hi < n && rim[hi].angle < a) hi++;
  const next = rim[hi % n];
  const prev = rim[(hi - 1 + n) % n];
  let span = next.angle - prev.angle;
  if (span <= 0) span += TWO_PI;
  let into = a - prev.angle;
  if (into < 0) into += TWO_PI;
  const t = span > 1e-6 ? into / span : 0;
  return {
    radiusScale: prev.radiusScale + (next.radiusScale - prev.radiusScale) * t,
    depthScale: prev.depthScale + (next.depthScale - prev.depthScale) * t,
  };
}

/**
 * Height (bone-local Y) of the tear at bone-local (x, z). Out at the skin the full rim depth
 * applies; toward the middle it flattens onto the tilted plane, as muscle tears flatter than skin.
 */
export function cutHeightAt(surface: CutSurface, x: number, z: number): number {
  const dx = x - surface.centerX;
  const dz = z - surface.centerZ;
  const rho = Math.hypot(dx, dz);
  const rimWeight = Math.min(1, rho / surface.radiusM) ** 1.5;
  const { depthScale } = sampleRim(surface.rim, Math.atan2(dz, dx));
  return surface.cutY + surface.tiltX * dx + surface.tiltZ * dz + depthScale * surface.radiusM * rimWeight;
}
