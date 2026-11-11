import {
  Clipper,
  FillRule,
  Path64,
  Paths64,
  Point64,
} from 'clipper2-js';
import earcut from 'earcut';

/**
 * Fixed-point integer scale for Clipper2 (`100,000` units = `1.0` meter -> `0.01 mm` precision).
 * Keeps coordinates for walls up to hundreds of meters well inside JS 53-bit safe integers.
 */
export const WOOD_CLIPPER_SCALE = 100_000;
const INV_WOOD_CLIPPER_SCALE = 1 / WOOD_CLIPPER_SCALE;
const INV_WOOD_CLIPPER_AREA_SCALE = INV_WOOD_CLIPPER_SCALE * INV_WOOD_CLIPPER_SCALE;

/** Minimum polygon shell area (`25 mm^2`) retained after boolean subtraction to prune micro-slivers. */
const MIN_SHELL_AREA_M2 = 0.005 * 0.005;
/** Minimum interior hole area (`9 mm^2`) retained for triangulation. */
const MIN_HOLE_AREA_M2 = 0.003 * 0.003;
/** Maximum unanchored floating wood island area (`0.14 m^2` ~ `37cm x 37cm`) auto-dropped inside holes. */
export const MAX_FLOATING_ISLAND_DROP_AREA_M2 = 0.14;
/** Ramer-Douglas-Peucker simplification epsilon (`1.2 mm`) to clean grazing multi-shot slivers. */
const SIMPLIFY_EPSILON_M = 0.0012;

/** Cross-grain vertical bridge-snap gap (`2.4 cm`) between nearby bullet holes. */
const BRIDGE_SNAP_VERTICAL_GAP_M = 0.024;
/** Extra along-grain horizontal bridge-snap reach (`+1.6 cm` -> `4.0 cm` total along plank grain). */
const BRIDGE_SNAP_HORIZONTAL_EXTRA_M = 0.016;
/** Thin outer-edge board sliver threshold (`2.2 cm`) that snaps cleanly to the panel edge. */
const EDGE_SLIVER_SNAP_GAP_M = 0.022;

export interface Point2D {
  u: number;
  v: number;
}

export type WoodStampProfile =
  | 'RIFLE_FMJ_AP'
  | 'RIFLE_JHP'
  | 'HEAVY_50AE_SLUG'
  | 'BUCKSHOT_PELLET'
  | 'BUCKSHOT_CLUSTER'
  | 'BLAST_BREACH';

export interface JaggedHoleStampOptions {
  /** Local horizontal coordinate in `[0, widthM]` (meters) */
  u: number;
  /** Local vertical coordinate in `[0, heightM]` (meters) */
  v: number;
  /** Projectile radius in meters (e.g. `0.0039` for 7.62mm, `0.00825` for 12G slug) */
  caliberRadiusM: number;
  /** Projectile impact kinetic energy in Joules */
  kineticEnergyJ: number;
  /** Ballistic fracture silhouette profile */
  profile?: WoodStampProfile;
  /** Whether projectile is hardened armor-piercing (tighter exit cone vs wide JHP/slug blowout) */
  isArmorPiercing?: boolean;
  /** Optional deterministic variation seed (e.g. shot index) */
  seed?: number;
  /** Optional explicit base hole radius override in meters (e.g. explosive blast / shotgun cluster breach) */
  overrideRadiusM?: number;
  /** Optional explicit horizontal wood-grain stretch factor (`>= 1.0`) */
  grainStretchOverride?: number;
}

export interface SplinterSpawnDescriptor {
  /** 2D local coordinates (meters) on the freshly cut hole rim */
  u: number;
  v: number;
  /** Unit 2D tangent vector along the cut perimeter */
  tangentU: number;
  tangentV: number;
  /** Unit 2D outward radial direction from stamp center toward rim */
  radialU: number;
  radialV: number;
  /** Suggested splinter length in meters */
  lengthM: number;
}

export interface WoodShellContour {
  outer: Path64;
  holes: Path64[];
}

export interface WoodStudAnchorSpan {
  /** Horizontal center `u` of the interior vertical stud in `[0, widthM]` */
  u: number;
  /** Half-width of the stud in meters (e.g. `0.0225`) */
  halfWidthM: number;
  /** Bottom `v` of intact vertical stud span in `[0, heightM]` */
  vMin: number;
  /** Top `v` of intact vertical stud span in `[0, heightM]` */
  vMax: number;
}

export interface WoodPanelClipperState {
  readonly widthM: number;
  readonly heightM: number;
  readonly thicknessM: number;
  paths: Paths64;
  shells: WoodShellContour[];
  shotCount: number;
  /** Optional live intact interior stud spans used to determine whether split wood islands remain anchored */
  studAnchors?: WoodStudAnchorSpan[];
}

export interface WoodMeshScratchBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array | Uint16Array;
}

export interface WoodMeshBuildStats {
  vertexCount: number;
  indexCount: number;
  frontFaceTriangleCount: number;
  backFaceTriangleCount: number;
  holeRimTriangleCount: number;
  outerRimTriangleCount: number;
  remainingAreaM2: number;
  holeCount: number;
  shellCount: number;
}

export interface WoodStampSubtractionResult {
  cutAnyWood: boolean;
  removedAreaM2: number;
  droppedIslandAreaM2: number;
  snappedBridgeCount: number;
  splinters: SplinterSpawnDescriptor[];
  meshStats: WoodMeshBuildStats;
}

/**
 * Deterministic 32-bit PRNG (Mulberry32) for reproducible jagged wood fracture stamps.
 */
function createSeededRng(seedInt: number): () => number {
  let state = seedInt >>> 0;
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStampInputs(
  u: number,
  v: number,
  caliberRadiusM: number,
  kineticEnergyJ: number,
  profile: WoodStampProfile,
  seed: number,
): number {
  const qu = Math.round(u * 10_000);
  const qv = Math.round(v * 10_000);
  const qc = Math.round(caliberRadiusM * 100_000);
  const qe = Math.round(kineticEnergyJ * 10);
  let h = 2166136261;
  h = Math.imul(h ^ qu, 16777619);
  h = Math.imul(h ^ qv, 16777619);
  h = Math.imul(h ^ qc, 16777619);
  h = Math.imul(h ^ qe, 16777619);
  h = Math.imul(h ^ Math.round(seed * 9973), 16777619);
  for (let i = 0; i < profile.length; i++) {
    h = Math.imul(h ^ profile.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/**
 * Infers an appropriate wood fracture stamp profile from projectile caliber, energy, and AP flag.
 */
export function inferWoodStampProfile(
  caliberRadiusM: number,
  kineticEnergyJ: number,
  isArmorPiercing: boolean,
): WoodStampProfile {
  if (kineticEnergyJ >= 4800 || caliberRadiusM >= 0.025) {
    return 'BLAST_BREACH';
  }
  // .50 AE (~6.35mm radius) or 12G Sabot Slug (~8.25mm radius) -> fist+ ragged plank blowout
  if (caliberRadiusM >= 0.0058) {
    return 'HEAVY_50AE_SLUG';
  }
  // Low-energy spherical 00 buckshot pellet (~4.2mm radius, < 420 J)
  if (kineticEnergyJ < 420 && caliberRadiusM >= 0.0036) {
    return 'BUCKSHOT_PELLET';
  }
  if (isArmorPiercing) {
    return 'RIFLE_FMJ_AP';
  }
  return 'RIFLE_JHP';
}

/**
 * Generates a deterministic 10–14 vertex jagged CCW ballistic polygon stamp in 2D wall coordinates `(u, v)`.
 * Models fibrous horizontal wood-plank splinter teeth (`grainStretchU`) and ammo-specific exit blowouts.
 */
export function createJaggedHoleStamp(options: JaggedHoleStampOptions): Point2D[] {
  const profile =
    options.profile ??
    inferWoodStampProfile(
      options.caliberRadiusM,
      options.kineticEnergyJ,
      options.isArmorPiercing ?? false,
    );

  let vertexCount = 12;
  let baseRadiusM = 0.05;
  let grainStretchU = 1.32;
  let toothJaggedness = 0.30;

  const clampedCaliberR = Math.max(0.002, Math.min(0.12, options.caliberRadiusM));
  const energyFactor = Math.min(
    1.65,
    Math.max(0.65, Math.sqrt(Math.max(50, options.kineticEnergyJ) / 1600)),
  );

  switch (profile) {
    case 'BUCKSHOT_PELLET': {
      vertexCount = 10;
      baseRadiusM =
        Math.max(0.036, clampedCaliberR * 8.6) *
        Math.min(1.22, energyFactor + 0.38);
      grainStretchU = 1.28;
      toothJaggedness = 0.28;
      break;
    }
    case 'RIFLE_FMJ_AP': {
      vertexCount = 12;
      baseRadiusM =
        Math.max(0.046, clampedCaliberR * 12.0) * (0.86 + 0.24 * energyFactor);
      grainStretchU = 1.34;
      toothJaggedness = 0.30;
      break;
    }
    case 'RIFLE_JHP': {
      vertexCount = 12;
      baseRadiusM =
        Math.max(0.058, clampedCaliberR * 15.0) * (0.88 + 0.26 * energyFactor);
      grainStretchU = 1.36;
      toothJaggedness = 0.34;
      break;
    }
    case 'HEAVY_50AE_SLUG': {
      // Big ragged fist+ plank blowout (~20-28cm across horizontal grain)
      vertexCount = 13;
      baseRadiusM =
        Math.max(0.092, clampedCaliberR * 12.8) * (0.88 + 0.25 * energyFactor);
      grainStretchU = 1.38;
      toothJaggedness = 0.36;
      break;
    }
    case 'BUCKSHOT_CLUSTER': {
      // Point-blank / close-range horizontal board-plank chunk tear-out
      vertexCount = 14;
      baseRadiusM =
        Math.max(0.185, clampedCaliberR * 28.0) * (0.90 + 0.22 * energyFactor);
      grainStretchU = 1.42;
      toothJaggedness = 0.36;
      break;
    }
    case 'BLAST_BREACH': {
      vertexCount = 14;
      baseRadiusM = Math.max(0.30, 0.24 * energyFactor);
      grainStretchU = 1.18;
      toothJaggedness = 0.32;
      break;
    }
  }

  if (options.overrideRadiusM !== undefined && options.overrideRadiusM > 0.005) {
    baseRadiusM = options.overrideRadiusM;
  }
  if (
    options.grainStretchOverride !== undefined &&
    options.grainStretchOverride >= 1.0
  ) {
    grainStretchU = options.grainStretchOverride;
  }

  const rng = createSeededRng(
    hashStampInputs(
      options.u,
      options.v,
      clampedCaliberR,
      options.kineticEnergyJ,
      profile,
      options.seed ?? 0,
    ),
  );

  const phaseOffset = rng() * Math.PI * 2;
  const stepAngle = (Math.PI * 2) / vertexCount;
  const stamp: Point2D[] = new Array<Point2D>(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    // Strictly monotonic CCW angles prevent any self-intersection
    const angleJitter = (rng() - 0.5) * stepAngle * 0.34;
    const theta = phaseOffset + i * stepAngle + angleJitter;

    // Alternating outward splinter spike vs inward fracture notch
    const alternatingSign = (i & 1) === 0 ? 1 : -1;
    const radialJitter =
      1 + alternatingSign * toothJaggedness * (0.55 + 0.45 * rng());
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // Extra fibrous tear along horizontal wood-plank grain near cos(theta) = ±1
    const grainSpike = 1 + (grainStretchU - 1) * cosT * cosT;
    const r = baseRadiusM * radialJitter * grainSpike;

    stamp[i] = {
      u: options.u + cosT * r,
      v: options.v + sinT * r,
    };
  }

  return stamp;
}

function makeIntactRectPath64(widthM: number, heightM: number): Path64 {
  const wScaled = Math.max(10, Math.round(widthM * WOOD_CLIPPER_SCALE));
  const hScaled = Math.max(10, Math.round(heightM * WOOD_CLIPPER_SCALE));
  const rect = new Path64();
  // CCW in (+u right, +v up) => positive Clipper2 area
  rect.push(
    new Point64(0, 0),
    new Point64(wScaled, 0),
    new Point64(wScaled, hScaled),
    new Point64(0, hScaled),
  );
  return rect;
}

function points2DToPath64(points: readonly Point2D[]): Path64 {
  const path = new Path64();
  for (let i = 0; i < points.length; i++) {
    path.push(
      new Point64(
        Math.round(points[i].u * WOOD_CLIPPER_SCALE),
        Math.round(points[i].v * WOOD_CLIPPER_SCALE),
      ),
    );
  }
  if (path.length >= 3 && Clipper.area(path) < 0) {
    path.reverse();
  }
  return path;
}

type PointContainment = 'INSIDE' | 'OUTSIDE' | 'ON_EDGE';

/**
 * Exact, zero-allocation ray-crossing & segment-collinearity point-in-polygon classifier
 * on integer `Path64` rings (avoids upstream `clipper2-js@1.2.4` `pointInPolygon` bug).
 */
function classifyPointInPath64(
  px: number,
  py: number,
  path: Path64,
): PointContainment {
  const n = path.length;
  if (n < 3) {
    return 'OUTSIDE';
  }

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = path[j].x;
    const ay = path[j].y;
    const bx = path[i].x;
    const by = path[i].y;

    // Exact on-segment check
    if (
      px >= (ax < bx ? ax : bx) &&
      px <= (ax > bx ? ax : bx) &&
      py >= (ay < by ? ay : by) &&
      py <= (ay > by ? ay : by)
    ) {
      const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (Math.abs(cross) <= 1e-3) {
        return 'ON_EDGE';
      }
    }

    if ((ay > py) !== (by > py)) {
      const xIntersect = ax + ((py - ay) * (bx - ax)) / (by - ay);
      if (px < xIntersect) {
        inside = !inside;
      }
    }
  }

  return inside ? 'INSIDE' : 'OUTSIDE';
}

function isRingInsideContainer(ring: Path64, container: Path64): boolean {
  for (let i = 0; i < ring.length; i++) {
    const res = classifyPointInPath64(ring[i].x, ring[i].y, container);
    if (res === 'INSIDE') {
      return true;
    }
    if (res === 'OUTSIDE') {
      return false;
    }
  }
  return false;
}

/**
 * Counts how many distinct structural anchors hold `shellPath` onto the wall frame:
 * - Each touched outer frame edge (left, right, bottom sole plate, top header plate) counts as 1 anchor.
 * - Each intact interior vertical stud span that physically overlaps `shellPath` counts as 1 anchor.
 */
function countShellStructuralAnchors(
  shellPath: Path64,
  state: WoodPanelClipperState,
): { frameEdgeCount: number; studAnchorCount: number; totalAnchors: number } {
  const n = shellPath.length;
  if (n < 3) {
    return { frameEdgeCount: 0, studAnchorCount: 0, totalAnchors: 0 };
  }

  const wScaled = Math.round(state.widthM * WOOD_CLIPPER_SCALE);
  const hScaled = Math.round(state.heightM * WOOD_CLIPPER_SCALE);
  const edgeTol = Math.round(0.006 * WOOD_CLIPPER_SCALE); // 6mm tolerance

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const pt = shellPath[i];
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  let frameEdgeCount = 0;
  if (minX <= edgeTol) frameEdgeCount++;
  if (maxX >= wScaled - edgeTol) frameEdgeCount++;
  if (minY <= edgeTol) frameEdgeCount++;
  if (maxY >= hScaled - edgeTol) frameEdgeCount++;

  let studAnchorCount = 0;
  const studAnchors = state.studAnchors;
  if (studAnchors && studAnchors.length > 0 && frameEdgeCount < 2) {
    // Group stud spans by stud horizontal position so 1 continuous stud counts as 1 structural member
    const anchoredStudU = new Set<number>();
    for (let s = 0; s < studAnchors.length; s++) {
      const span = studAnchors[s];
      const uKey = Math.round(span.u * 10_000);
      if (anchoredStudU.has(uKey)) {
        continue;
      }

      const sxMin = Math.round((span.u - span.halfWidthM) * WOOD_CLIPPER_SCALE);
      const sxMax = Math.round((span.u + span.halfWidthM) * WOOD_CLIPPER_SCALE);
      const syMin = Math.round(span.vMin * WOOD_CLIPPER_SCALE);
      const syMax = Math.round(span.vMax * WOOD_CLIPPER_SCALE);

      if (maxX < sxMin || minX > sxMax || maxY < syMin || minY > syMax) {
        continue;
      }

      // Probe sample points along the overlapping vertical span of this stud
      const overlapYMin = Math.max(minY, syMin);
      const overlapYMax = Math.min(maxY, syMax);
      if (overlapYMax - overlapYMin < Math.round(0.025 * WOOD_CLIPPER_SCALE)) {
        continue;
      }

      const probeX = Math.round(span.u * WOOD_CLIPPER_SCALE);
      let hitsStud = false;
      for (let p = 0; p <= 4; p++) {
        const probeY = Math.round(
          overlapYMin + ((overlapYMax - overlapYMin) * p) / 4,
        );
        if (classifyPointInPath64(probeX, probeY, shellPath) !== 'OUTSIDE') {
          hitsStud = true;
          break;
        }
      }

      if (hitsStud) {
        anchoredStudU.add(uKey);
        studAnchorCount++;
      }
    }
  }

  return {
    frameEdgeCount,
    studAnchorCount,
    totalAnchors: frameEdgeCount + studAnchorCount,
  };
}

function closestPointOnSegment2D(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number; distSq: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = 0;
  if (lenSq > 1e-12) {
    t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq));
  }
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx, y: cy, distSq: dx * dx + dy * dy };
}

function makeJaggedBridgeTearPath64(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  halfWidthM: number,
  seed: number,
): Path64 {
  const du = u1 - u0;
  const dv = v1 - v0;
  const len = Math.hypot(du, dv);
  if (len < 1e-5) {
    return new Path64();
  }

  const bu = du / len;
  const bv = dv / len;
  const pu = -bv;
  const pv = bu;

  // Overlap ~14mm into both source and target holes so Clipper2 cleanly merges them
  const ext = 0.014;
  const su = u0 - bu * ext;
  const sv = v0 - bv * ext;
  const eu = u1 + bu * ext;
  const ev = v1 + bv * ext;
  const midU = (su + eu) * 0.5;
  const midV = (sv + ev) * 0.5;

  const rng = createSeededRng((seed * 1597334677 + 3812015801) >>> 0);
  const hw0 = halfWidthM * (0.85 + 0.3 * rng());
  const hwMidPos = halfWidthM * (1.12 + 0.38 * rng());
  const hwMidNeg = halfWidthM * (1.12 + 0.38 * rng());
  const hw1 = halfWidthM * (0.85 + 0.3 * rng());

  const pts: Point2D[] = [
    { u: su + pu * hw0, v: sv + pv * hw0 },
    { u: su - pu * hw0, v: sv - pv * hw0 },
    {
      u: midU - pu * hwMidNeg + bu * (rng() - 0.5) * 0.008,
      v: midV - pv * hwMidNeg + bv * (rng() - 0.5) * 0.008,
    },
    { u: eu - pu * hw1, v: ev - pv * hw1 },
    { u: eu + pu * hw1, v: ev + pv * hw1 },
    {
      u: midU + pu * hwMidPos + bu * (rng() - 0.5) * 0.008,
      v: midV + pv * hwMidPos + bv * (rng() - 0.5) * 0.008,
    },
  ];

  return points2DToPath64(pts);
}

/**
 * Finds thin weakened wood bridges between the incoming `stamp` and nearby existing holes
 * (or outer panel edges) and appends jagged splinter-tear polygons into `clipPaths` so tight
 * multi-shot groups snap slivers along the horizontal plank grain and knock out real chunks.
 */
function appendWeakenedBridgeTears(
  state: WoodPanelClipperState,
  stamp: readonly Point2D[],
  clipPaths: Paths64,
  shotSeed: number,
): number {
  if (stamp.length < 3 || state.shells.length === 0) {
    return 0;
  }

  let sMinU = Infinity;
  let sMaxU = -Infinity;
  let sMinV = Infinity;
  let sMaxV = -Infinity;
  for (let i = 0; i < stamp.length; i++) {
    const p = stamp[i];
    if (p.u < sMinU) sMinU = p.u;
    if (p.u > sMaxU) sMaxU = p.u;
    if (p.v < sMinV) sMinV = p.v;
    if (p.v > sMaxV) sMaxV = p.v;
  }

  const maxSnapReachM = BRIDGE_SNAP_VERTICAL_GAP_M + BRIDGE_SNAP_HORIZONTAL_EXTRA_M;
  let snappedCount = 0;

  for (let sIdx = 0; sIdx < state.shells.length; sIdx++) {
    const shell = state.shells[sIdx];
    for (let hIdx = 0; hIdx < shell.holes.length; hIdx++) {
      const hole = shell.holes[hIdx];
      const hn = hole.length;
      if (hn < 3) continue;

      let hMinU = Infinity;
      let hMaxU = -Infinity;
      let hMinV = Infinity;
      let hMaxV = -Infinity;
      for (let i = 0; i < hn; i++) {
        const hu = hole[i].x * INV_WOOD_CLIPPER_SCALE;
        const hv = hole[i].y * INV_WOOD_CLIPPER_SCALE;
        if (hu < hMinU) hMinU = hu;
        if (hu > hMaxU) hMaxU = hu;
        if (hv < hMinV) hMinV = hv;
        if (hv > hMaxV) hMaxV = hv;
      }

      if (
        hMinU > sMaxU + maxSnapReachM ||
        hMaxU < sMinU - maxSnapReachM ||
        hMinV > sMaxV + maxSnapReachM ||
        hMaxV < sMinV - maxSnapReachM
      ) {
        continue;
      }

      // Find minimum distance between stamp boundary and existing hole boundary
      let bestDistSq = Infinity;
      let bestSU = 0;
      let bestSV = 0;
      let bestHU = 0;
      let bestHV = 0;

      for (let i = 0; i < stamp.length; i++) {
        const ps = stamp[i];
        for (let j = 0; j < hn; j++) {
          const ha = hole[j];
          const hb = hole[(j + 1) % hn];
          const cand = closestPointOnSegment2D(
            ps.u,
            ps.v,
            ha.x * INV_WOOD_CLIPPER_SCALE,
            ha.y * INV_WOOD_CLIPPER_SCALE,
            hb.x * INV_WOOD_CLIPPER_SCALE,
            hb.y * INV_WOOD_CLIPPER_SCALE,
          );
          if (cand.distSq < bestDistSq) {
            bestDistSq = cand.distSq;
            bestSU = ps.u;
            bestSV = ps.v;
            bestHU = cand.x;
            bestHV = cand.y;
          }
        }
      }

      for (let j = 0; j < hn; j++) {
        const hu = hole[j].x * INV_WOOD_CLIPPER_SCALE;
        const hv = hole[j].y * INV_WOOD_CLIPPER_SCALE;
        for (let i = 0; i < stamp.length; i++) {
          const sa = stamp[i];
          const sb = stamp[(i + 1) % stamp.length];
          const cand = closestPointOnSegment2D(hu, hv, sa.u, sa.v, sb.u, sb.v);
          if (cand.distSq < bestDistSq) {
            bestDistSq = cand.distSq;
            bestSU = cand.x;
            bestSV = cand.y;
            bestHU = hu;
            bestHV = hv;
          }
        }
      }

      const gapM = Math.sqrt(bestDistSq);
      if (gapM <= 0.001) {
        // Already directly overlapping -> Clipper2 Difference naturally merges them
        continue;
      }

      const du = bestHU - bestSU;
      const dv = bestHV - bestSV;
      const grainAlignedFrac = Math.abs(du) / gapM;
      const snapThresholdM =
        BRIDGE_SNAP_VERTICAL_GAP_M +
        BRIDGE_SNAP_HORIZONTAL_EXTRA_M * grainAlignedFrac;

      if (gapM <= snapThresholdM) {
        const bridgeHalfW = 0.020 + 0.012 * grainAlignedFrac;
        const bridgePath = makeJaggedBridgeTearPath64(
          bestSU,
          bestSV,
          bestHU,
          bestHV,
          bridgeHalfW,
          shotSeed * 31 + hIdx * 17 + sIdx,
        );
        if (bridgePath.length >= 3) {
          clipPaths.push(bridgePath);
          snappedCount++;
        }
      }
    }
  }

  // Also snap razor-thin (< 2.2cm) outer edge strips if the hole almost breaks through a border
  const midSU = (sMinU + sMaxU) * 0.5;
  const midSV = (sMinV + sMaxV) * 0.5;
  if (sMinU > 0.001 && sMinU <= EDGE_SLIVER_SNAP_GAP_M) {
    const p = makeJaggedBridgeTearPath64(
      sMinU,
      midSV,
      -0.01,
      midSV,
      0.026,
      shotSeed * 43 + 1,
    );
    if (p.length >= 3) {
      clipPaths.push(p);
      snappedCount++;
    }
  }
  if (
    sMaxU < state.widthM - 0.001 &&
    state.widthM - sMaxU <= EDGE_SLIVER_SNAP_GAP_M
  ) {
    const p = makeJaggedBridgeTearPath64(
      sMaxU,
      midSV,
      state.widthM + 0.01,
      midSV,
      0.026,
      shotSeed * 43 + 2,
    );
    if (p.length >= 3) {
      clipPaths.push(p);
      snappedCount++;
    }
  }
  if (sMinV > 0.001 && sMinV <= EDGE_SLIVER_SNAP_GAP_M) {
    const p = makeJaggedBridgeTearPath64(
      midSU,
      sMinV,
      midSU,
      -0.01,
      0.024,
      shotSeed * 43 + 3,
    );
    if (p.length >= 3) {
      clipPaths.push(p);
      snappedCount++;
    }
  }
  if (
    sMaxV < state.heightM - 0.001 &&
    state.heightM - sMaxV <= EDGE_SLIVER_SNAP_GAP_M
  ) {
    const p = makeJaggedBridgeTearPath64(
      midSU,
      sMaxV,
      midSU,
      state.heightM + 0.01,
      0.024,
      shotSeed * 43 + 4,
    );
    if (p.length >= 3) {
      clipPaths.push(p);
      snappedCount++;
    }
  }

  return snappedCount;
}

function rebuildCleanShellsAndPaths(
  paths: Paths64,
  state: WoodPanelClipperState,
): {
  cleanPaths: Paths64;
  shells: WoodShellContour[];
  droppedIslands: Paths64;
} {
  const minShellAreaScaled = MIN_SHELL_AREA_M2 * WOOD_CLIPPER_SCALE * WOOD_CLIPPER_SCALE;
  const minHoleAreaScaled = MIN_HOLE_AREA_M2 * WOOD_CLIPPER_SCALE * WOOD_CLIPPER_SCALE;
  const maxFloatingIslandScaled =
    MAX_FLOATING_ISLAND_DROP_AREA_M2 * WOOD_CLIPPER_SCALE * WOOD_CLIPPER_SCALE;
  const simplifyEpsScaled = SIMPLIFY_EPSILON_M * WOOD_CLIPPER_SCALE;

  const rawOuters: Array<{ path: Path64; area: number }> = [];
  const rawHoles: Array<{ path: Path64; absArea: number }> = [];
  const droppedIslands = new Paths64();

  for (let i = 0; i < paths.length; i++) {
    const raw = paths[i];
    if (raw.length < 3) {
      continue;
    }
    const rawArea = Clipper.area(raw);
    if (Math.abs(rawArea) < minHoleAreaScaled) {
      continue;
    }

    const simplified = Clipper.simplifyPath(raw, simplifyEpsScaled, true);
    let cleaned = Clipper.trimCollinear(simplified, false);
    if (cleaned.length < 3) {
      cleaned = Clipper.trimCollinear(raw, false);
      if (cleaned.length < 3) {
        continue;
      }
    }

    const signedArea = Clipper.area(cleaned);
    if (signedArea >= minShellAreaScaled) {
      rawOuters.push({ path: cleaned, area: signedArea });
    } else if (-signedArea >= minHoleAreaScaled) {
      rawHoles.push({ path: cleaned, absArea: -signedArea });
    }
  }

  if (rawOuters.length === 0) {
    return { cleanPaths: new Paths64(), shells: [], droppedIslands };
  }

  // Sort largest outer shells first so containment hierarchy is deterministic
  rawOuters.sort((a, b) => b.area - a.area);
  rawHoles.sort((a, b) => b.absArea - a.absArea);

  // Prune detached floating wood islands inside holes AND any unanchored shell island
  // that fails to touch at least 2 outer frame edges / intact vertical studs!
  const survivingOuters: Array<{ path: Path64; area: number; holes: Path64[] }> = [];
  for (let i = 0; i < rawOuters.length; i++) {
    const candidate = rawOuters[i];

    let enclosedByHole = false;
    for (let h = 0; h < rawHoles.length; h++) {
      if (rawHoles[h].absArea <= candidate.area) {
        break;
      }
      if (isRingInsideContainer(candidate.path, rawHoles[h].path)) {
        enclosedByHole = true;
        break;
      }
    }

    if (enclosedByHole && candidate.area <= maxFloatingIslandScaled) {
      droppedIslands.push(candidate.path);
      continue;
    }

    const anchors = countShellStructuralAnchors(candidate.path, state);
    if (anchors.totalAnchors < 2) {
      droppedIslands.push(candidate.path);
      continue;
    }

    survivingOuters.push({ path: candidate.path, area: candidate.area, holes: [] });
  }

  // Pair each CW hole with its smallest enclosing CCW outer shell
  for (let h = 0; h < rawHoles.length; h++) {
    const holeObj = rawHoles[h];
    let bestOwnerIdx = -1;
    let bestOwnerArea = Infinity;

    for (let s = 0; s < survivingOuters.length; s++) {
      const shellObj = survivingOuters[s];
      if (shellObj.area <= holeObj.absArea || shellObj.area >= bestOwnerArea) {
        continue;
      }
      if (isRingInsideContainer(holeObj.path, shellObj.path)) {
        bestOwnerIdx = s;
        bestOwnerArea = shellObj.area;
      }
    }

    if (bestOwnerIdx >= 0) {
      survivingOuters[bestOwnerIdx].holes.push(holeObj.path);
    }
  }

  const shells: WoodShellContour[] = [];
  const cleanPaths = new Paths64();
  for (let s = 0; s < survivingOuters.length; s++) {
    const item = survivingOuters[s];
    shells.push({ outer: item.path, holes: item.holes });
    cleanPaths.push(item.path);
    for (let h = 0; h < item.holes.length; h++) {
      cleanPaths.push(item.holes[h]);
    }
  }

  return { cleanPaths, shells, droppedIslands };
}

/**
 * Creates a fresh intact 2D wood panel polygon state `[0, widthM] x [0, heightM]` with sandwich depth `thicknessM`.
 */
export function createWoodPanelState(
  widthM: number,
  heightM: number,
  thicknessM = 0.08,
): WoodPanelClipperState {
  const safeW = Math.max(0.05, widthM);
  const safeH = Math.max(0.05, heightM);
  const safeT = Math.max(0.005, thicknessM);

  const outer = makeIntactRectPath64(safeW, safeH);
  const paths = new Paths64();
  paths.push(outer);

  return {
    widthM: safeW,
    heightM: safeH,
    thicknessM: safeT,
    paths,
    shells: [{ outer, holes: [] }],
    shotCount: 0,
  };
}

/**
 * Resets an existing wood panel state back to its intact rectangle without reallocating the state object.
 */
export function resetWoodPanelState(state: WoodPanelClipperState): void {
  const outer = makeIntactRectPath64(state.widthM, state.heightM);
  const paths = new Paths64();
  paths.push(outer);
  state.paths = paths;
  state.shells = [{ outer, holes: [] }];
  state.shotCount = 0;
}

/**
 * Computes the exact remaining solid 2D surface area (m^2) of the wood panel.
 */
export function computePanelRemainingAreaM2(state: WoodPanelClipperState): number {
  if (state.paths.length === 0) {
    return 0;
  }
  return Math.max(0, Clipper.areaPaths(state.paths) * INV_WOOD_CLIPPER_AREA_SCALE);
}

/**
 * Returns `true` if local `(u, v)` lies within the panel's `[0, widthM] x [0, heightM]` bounds
 * AND passes cleanly through an ALREADY blown-open hole or edge breach (0 ballistic energy loss!).
 * Returns `false` on intact wood or outside the panel bounds.
 */
export function isPointInOpenHole(
  state: WoodPanelClipperState,
  u: number,
  v: number,
): boolean {
  if (u < 0 || u > state.widthM || v < 0 || v > state.heightM) {
    return false;
  }

  if (state.shells.length === 0) {
    return true;
  }

  const px = Math.round(u * WOOD_CLIPPER_SCALE);
  const py = Math.round(v * WOOD_CLIPPER_SCALE);

  // Shells are sorted largest-area first (outer shells before any nested solid islands).
  // Iterate from smallest to largest so a nested solid island overrides its enclosing hole!
  for (let i = state.shells.length - 1; i >= 0; i--) {
    const shell = state.shells[i];
    const outerPip = classifyPointInPath64(px, py, shell.outer);
    if (outerPip === 'OUTSIDE') {
      continue;
    }
    if (outerPip === 'ON_EDGE') {
      return false;
    }

    // Point is strictly inside this outer shell; check if it lies inside one of its cut holes
    for (let j = 0; j < shell.holes.length; j++) {
      const holePip = classifyPointInPath64(px, py, shell.holes[j]);
      if (holePip === 'INSIDE') {
        return true;
      }
      if (holePip === 'ON_EDGE') {
        return false;
      }
    }

    // Strictly inside solid wood of this shell and outside all of its holes
    return false;
  }

  return true;
}

function appendExtrudedRimLoop(
  loop: Path64,
  halfW: number,
  halfH: number,
  halfZ: number,
  uvVMin: number,
  uvVMax: number,
  buffers: WoodMeshScratchBuffers,
  maxVerts: number,
  maxIndices: number,
  vertCursorIn: number,
  idxCursorIn: number,
): { vertCursor: number; idxCursor: number; emittedTriangles: number } {
  let vertCursor = vertCursorIn;
  let idxCursor = idxCursorIn;
  let emittedTriangles = 0;

  const nPts = loop.length;
  if (nPts < 3) {
    return { vertCursor, idxCursor, emittedTriangles };
  }

  const posOut = buffers.positions;
  const normOut = buffers.normals;
  const uvOut = buffers.uvs;
  const idxOut = buffers.indices;

  let arcU = 0;

  for (let i = 0; i < nPts; i++) {
    if (vertCursor + 4 > maxVerts || idxCursor + 6 > maxIndices) {
      break;
    }

    const p0 = loop[i];
    const p1 = loop[(i + 1) % nPts];

    const u0 = p0.x * INV_WOOD_CLIPPER_SCALE;
    const v0 = p0.y * INV_WOOD_CLIPPER_SCALE;
    const u1 = p1.x * INV_WOOD_CLIPPER_SCALE;
    const v1 = p1.y * INV_WOOD_CLIPPER_SCALE;

    const du = u1 - u0;
    const dv = v1 - v0;
    const edgeLen = Math.hypot(du, dv);
    if (edgeLen < 1e-6) {
      continue;
    }

    // Solid wood always lies to the LEFT of a Clipper2 loop (CCW outer shell, CW hole),
    // so the outward rim normal pointing into empty space / hole interior is (+dv, -du) / edgeLen.
    const nx = dv / edgeLen;
    const ny = -du / edgeLen;

    const x0 = u0 - halfW;
    const y0 = v0 - halfH;
    const x1 = u1 - halfW;
    const y1 = v1 - halfH;

    const nextArcU = arcU + edgeLen * 2.0;
    const base = vertCursor;

    // v0: Af (x0, y0, +halfZ)
    let pOff = base * 3;
    let uvOff = base * 2;
    posOut[pOff] = x0;
    posOut[pOff + 1] = y0;
    posOut[pOff + 2] = halfZ;
    normOut[pOff] = nx;
    normOut[pOff + 1] = ny;
    normOut[pOff + 2] = 0;
    uvOut[uvOff] = arcU;
    uvOut[uvOff + 1] = uvVMin;

    // v1: Ab (x0, y0, -halfZ)
    pOff += 3;
    uvOff += 2;
    posOut[pOff] = x0;
    posOut[pOff + 1] = y0;
    posOut[pOff + 2] = -halfZ;
    normOut[pOff] = nx;
    normOut[pOff + 1] = ny;
    normOut[pOff + 2] = 0;
    uvOut[uvOff] = arcU;
    uvOut[uvOff + 1] = uvVMax;

    // v2: Bb (x1, y1, -halfZ)
    pOff += 3;
    uvOff += 2;
    posOut[pOff] = x1;
    posOut[pOff + 1] = y1;
    posOut[pOff + 2] = -halfZ;
    normOut[pOff] = nx;
    normOut[pOff + 1] = ny;
    normOut[pOff + 2] = 0;
    uvOut[uvOff] = nextArcU;
    uvOut[uvOff + 1] = uvVMax;

    // v3: Bf (x1, y1, +halfZ)
    pOff += 3;
    uvOff += 2;
    posOut[pOff] = x1;
    posOut[pOff + 1] = y1;
    posOut[pOff + 2] = halfZ;
    normOut[pOff] = nx;
    normOut[pOff + 1] = ny;
    normOut[pOff + 2] = 0;
    uvOut[uvOff] = nextArcU;
    uvOut[uvOff + 1] = uvVMin;

    // Winding (Af, Ab, Bb) and (Af, Bb, Bf) has right-handed cross product (+dv, -du, 0) * thickness
    idxOut[idxCursor] = base;
    idxOut[idxCursor + 1] = base + 1;
    idxOut[idxCursor + 2] = base + 2;
    idxOut[idxCursor + 3] = base;
    idxOut[idxCursor + 4] = base + 2;
    idxOut[idxCursor + 5] = base + 3;

    vertCursor += 4;
    idxCursor += 6;
    emittedTriangles += 2;
    arcU = nextArcU;
  }

  return { vertCursor, idxCursor, emittedTriangles };
}

/**
 * Triangulates all surviving outer shells + interior holes of `state` via `earcut` and writes
 * the complete 3D sandwich board geometry (Front `+Z` face, Back `-Z` face, Extruded Inner Hole Rims,
 * and Outer Board Edge Rims) directly into caller-supplied pre-allocated `Float32Array` / index buffers.
 */
export function triangulateWoodPanelToBuffers(
  state: WoodPanelClipperState,
  buffers: WoodMeshScratchBuffers,
): WoodMeshBuildStats {
  const maxVerts = Math.min(
    Math.floor(buffers.positions.length / 3),
    Math.floor(buffers.normals.length / 3),
    Math.floor(buffers.uvs.length / 2),
    buffers.indices instanceof Uint16Array ? 65535 : 0x7fffffff,
  );
  const maxIndices = buffers.indices.length;

  const posOut = buffers.positions;
  const normOut = buffers.normals;
  const uvOut = buffers.uvs;
  const idxOut = buffers.indices;

  const widthM = state.widthM;
  const heightM = state.heightM;
  const invW = 1 / widthM;
  const invH = 1 / heightM;
  const halfW = widthM * 0.5;
  const halfH = heightM * 0.5;
  const halfZ = state.thicknessM * 0.5;

  let vertCursor = 0;
  let idxCursor = 0;
  let frontFaceTriangleCount = 0;
  let backFaceTriangleCount = 0;
  let holeRimTriangleCount = 0;
  let outerRimTriangleCount = 0;
  let holeCount = 0;

  for (let s = 0; s < state.shells.length; s++) {
    const shell = state.shells[s];
    holeCount += shell.holes.length;

    const flatCoords: number[] = [];
    const holeIndices: number[] = [];

    for (let i = 0; i < shell.outer.length; i++) {
      const pt = shell.outer[i];
      flatCoords.push(pt.x * INV_WOOD_CLIPPER_SCALE, pt.y * INV_WOOD_CLIPPER_SCALE);
    }

    for (let h = 0; h < shell.holes.length; h++) {
      const hole = shell.holes[h];
      holeIndices.push(flatCoords.length >> 1);
      for (let i = 0; i < hole.length; i++) {
        const pt = hole[i];
        flatCoords.push(pt.x * INV_WOOD_CLIPPER_SCALE, pt.y * INV_WOOD_CLIPPER_SCALE);
      }
    }

    const ringVertCount = flatCoords.length >> 1;
    if (ringVertCount < 3) {
      continue;
    }

    const triIndices = earcut(
      flatCoords,
      holeIndices.length > 0 ? holeIndices : undefined,
      2,
    );
    const triSlotCount = Math.floor(triIndices.length / 3);

    // Ensure enough capacity for both Front and Back face vertices & indices of this shell
    if (
      triSlotCount > 0 &&
      vertCursor + ringVertCount * 2 <= maxVerts &&
      idxCursor + triSlotCount * 6 <= maxIndices
    ) {
      const frontBase = vertCursor;
      for (let i = 0; i < ringVertCount; i++) {
        const u = flatCoords[i * 2];
        const v = flatCoords[i * 2 + 1];
        const pOff = (frontBase + i) * 3;
        const uvOff = (frontBase + i) * 2;

        posOut[pOff] = u - halfW;
        posOut[pOff + 1] = v - halfH;
        posOut[pOff + 2] = halfZ;

        normOut[pOff] = 0;
        normOut[pOff + 1] = 0;
        normOut[pOff + 2] = 1;

        // Outer painted/varnished wood face occupies v_uv in [0.02, 0.82]
        uvOut[uvOff] = u * invW;
        uvOut[uvOff + 1] = 0.02 + v * invH * 0.80;
      }
      vertCursor += ringVertCount;

      const backBase = vertCursor;
      for (let i = 0; i < ringVertCount; i++) {
        const u = flatCoords[i * 2];
        const v = flatCoords[i * 2 + 1];
        const pOff = (backBase + i) * 3;
        const uvOff = (backBase + i) * 2;

        posOut[pOff] = u - halfW;
        posOut[pOff + 1] = v - halfH;
        posOut[pOff + 2] = -halfZ;

        normOut[pOff] = 0;
        normOut[pOff + 1] = 0;
        normOut[pOff + 2] = -1;

        uvOut[uvOff] = (widthM - u) * invW;
        uvOut[uvOff + 1] = 0.02 + v * invH * 0.80;
      }
      vertCursor += ringVertCount;

      for (let t = 0; t < triIndices.length; t += 3) {
        const i0 = triIndices[t];
        const i1 = triIndices[t + 1];
        const i2 = triIndices[t + 2];

        const u0 = flatCoords[i0 * 2];
        const v0 = flatCoords[i0 * 2 + 1];
        const u1 = flatCoords[i1 * 2];
        const v1 = flatCoords[i1 * 2 + 1];
        const u2 = flatCoords[i2 * 2];
        const v2 = flatCoords[i2 * 2 + 1];

        const crossZ = (u1 - u0) * (v2 - v0) - (v1 - v0) * (u2 - u0);
        if (Math.abs(crossZ) < 1e-12) {
          continue;
        }

        const a = i0;
        const b = crossZ > 0 ? i1 : i2;
        const c = crossZ > 0 ? i2 : i1;

        // Front face (+Z normal -> CCW (a, b, c))
        idxOut[idxCursor] = frontBase + a;
        idxOut[idxCursor + 1] = frontBase + b;
        idxOut[idxCursor + 2] = frontBase + c;
        idxCursor += 3;
        frontFaceTriangleCount++;

        // Back face (-Z normal -> reversed winding (a, c, b))
        idxOut[idxCursor] = backBase + a;
        idxOut[idxCursor + 1] = backBase + c;
        idxOut[idxCursor + 2] = backBase + b;
        idxCursor += 3;
        backFaceTriangleCount++;
      }
    }

    // Extruded Inner Hole Rims (raw splintered core UV band [0.88, 0.99])
    for (let h = 0; h < shell.holes.length; h++) {
      const rimRes = appendExtrudedRimLoop(
        shell.holes[h],
        halfW,
        halfH,
        halfZ,
        0.88,
        0.99,
        buffers,
        maxVerts,
        maxIndices,
        vertCursor,
        idxCursor,
      );
      vertCursor = rimRes.vertCursor;
      idxCursor = rimRes.idxCursor;
      holeRimTriangleCount += rimRes.emittedTriangles;
    }

    // Outer shell boundary rim (closes panel edges + any edge-breaching bullet/blast notches)
    const outerRes = appendExtrudedRimLoop(
      shell.outer,
      halfW,
      halfH,
      halfZ,
      0.88,
      0.99,
      buffers,
      maxVerts,
      maxIndices,
      vertCursor,
      idxCursor,
    );
    vertCursor = outerRes.vertCursor;
    idxCursor = outerRes.idxCursor;
    outerRimTriangleCount += outerRes.emittedTriangles;
  }

  return {
    vertexCount: vertCursor,
    indexCount: idxCursor,
    frontFaceTriangleCount,
    backFaceTriangleCount,
    holeRimTriangleCount,
    outerRimTriangleCount,
    remainingAreaM2: computePanelRemainingAreaM2(state),
    holeCount,
    shellCount: state.shells.length,
  };
}

function buildPerimeterSplinterDescriptors(
  cutWoodPaths: Paths64,
  stampCenterU: number,
  stampCenterV: number,
  desiredCount: number,
  shotSeed: number,
): SplinterSpawnDescriptor[] {
  // Collect all perimeter segments of the freshly excised wood piece(s)
  const segments: Array<{
    u0: number;
    v0: number;
    tu: number;
    tv: number;
    len: number;
  }> = [];

  let totalLen = 0;
  for (let p = 0; p < cutWoodPaths.length; p++) {
    const ring = cutWoodPaths[p];
    if (ring.length < 3 || Clipper.area(ring) <= 0) {
      continue;
    }
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const u0 = a.x * INV_WOOD_CLIPPER_SCALE;
      const v0 = a.y * INV_WOOD_CLIPPER_SCALE;
      const u1 = b.x * INV_WOOD_CLIPPER_SCALE;
      const v1 = b.y * INV_WOOD_CLIPPER_SCALE;
      const du = u1 - u0;
      const dv = v1 - v0;
      const len = Math.hypot(du, dv);
      if (len > 1e-4) {
        segments.push({
          u0,
          v0,
          tu: du / len,
          tv: dv / len,
          len,
        });
        totalLen += len;
      }
    }
  }

  if (segments.length === 0 || totalLen <= 1e-4) {
    return [];
  }

  const clampedCount = Math.max(2, Math.min(28, Math.round(desiredCount)));
  const rng = createSeededRng((shotSeed * 747796405 + 2891336453) >>> 0);
  const startArc = rng() * (totalLen / clampedCount);
  const stepArc = totalLen / clampedCount;

  const descriptors: SplinterSpawnDescriptor[] = [];

  let segIdx = 0;
  let segAccumStart = 0;

  for (let k = 0; k < clampedCount; k++) {
    const targetS = (startArc + k * stepArc) % totalLen;
    while (
      segIdx < segments.length - 1 &&
      segAccumStart + segments[segIdx].len < targetS
    ) {
      segAccumStart += segments[segIdx].len;
      segIdx++;
    }
    if (segAccumStart > targetS) {
      segIdx = 0;
      segAccumStart = 0;
      while (
        segIdx < segments.length - 1 &&
        segAccumStart + segments[segIdx].len < targetS
      ) {
        segAccumStart += segments[segIdx].len;
        segIdx++;
      }
    }

    const seg = segments[segIdx];
    const localDist = Math.max(0, Math.min(seg.len, targetS - segAccumStart));
    const su = seg.u0 + seg.tu * localDist;
    const sv = seg.v0 + seg.tv * localDist;

    let ru = su - stampCenterU;
    let rv = sv - stampCenterV;
    const rLen = Math.hypot(ru, rv);
    if (rLen > 1e-5) {
      ru /= rLen;
      rv /= rLen;
    } else {
      // Outward normal of CCW cut piece
      ru = seg.tv;
      rv = -seg.tu;
    }

    const signFlip = (k & 1) === 0 ? 1 : -1;
    const splinterLenM = Math.max(
      0.045,
      Math.min(0.22, (totalLen / clampedCount) * (0.65 + 0.55 * rng())),
    );

    descriptors.push({
      u: su,
      v: sv,
      tangentU: seg.tu * signFlip,
      tangentV: seg.tv * signFlip,
      radialU: ru,
      radialV: rv,
      lengthM: splinterLenM,
    });
  }

  return descriptors;
}

/**
 * Subtracts a 2D jagged polygon stamp from `state` via `Clipper2`, snaps thin weakened wood bridges
 * to nearby holes, drops unanchored floating islands, triangulates surviving outer shells + interior
 * holes via `earcut`, writes 3D sandwich geometry (Front `+Z`, Back `-Z`, Extruded Inner Hole Rims)
 * into `buffers`, and returns perimeter splinter spawn descriptors along the newly cut edge.
 */
export function stampHoleInWoodPanel(
  state: WoodPanelClipperState,
  stamp: readonly Point2D[],
  buffers: WoodMeshScratchBuffers,
  splinterCountHint = 5,
): WoodStampSubtractionResult {
  if (stamp.length < 3 || state.paths.length === 0) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
      droppedIslandAreaM2: 0,
      snappedBridgeCount: 0,
      splinters: [],
      meshStats: triangulateWoodPanelToBuffers(state, buffers),
    };
  }

  const stampPath = points2DToPath64(stamp);
  if (stampPath.length < 3) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
      droppedIslandAreaM2: 0,
      snappedBridgeCount: 0,
      splinters: [],
      meshStats: triangulateWoodPanelToBuffers(state, buffers),
    };
  }

  let clipPaths = new Paths64();
  clipPaths.push(stampPath);

  const nextSeed = state.shotCount + 1;
  const snappedBridgeCount = appendWeakenedBridgeTears(
    state,
    stamp,
    clipPaths,
    nextSeed,
  );
  if (clipPaths.length > 1) {
    clipPaths = Clipper.Union(clipPaths, new Paths64(), FillRule.NonZero);
  }

  // Intersect stamp (+ any snapped bridges) with remaining solid wood to measure exact excised wood
  const cutWoodPaths = Clipper.Intersect(state.paths, clipPaths, FillRule.NonZero);
  const excisedAreaM2 = Math.max(
    0,
    Clipper.areaPaths(cutWoodPaths) * INV_WOOD_CLIPPER_AREA_SCALE,
  );

  if (excisedAreaM2 < 1e-6) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
      droppedIslandAreaM2: 0,
      snappedBridgeCount: 0,
      splinters: [],
      meshStats: triangulateWoodPanelToBuffers(state, buffers),
    };
  }

  let centerU = 0;
  let centerV = 0;
  for (let i = 0; i < stamp.length; i++) {
    centerU += stamp[i].u;
    centerV += stamp[i].v;
  }
  centerU /= stamp.length;
  centerV /= stamp.length;

  state.shotCount = nextSeed;

  const areaBefore = computePanelRemainingAreaM2(state);
  const rawDiff = Clipper.Difference(state.paths, clipPaths, FillRule.NonZero);
  const { cleanPaths, shells, droppedIslands } = rebuildCleanShellsAndPaths(
    rawDiff,
    state,
  );

  state.paths = cleanPaths;
  state.shells = shells;

  const droppedIslandAreaM2 =
    droppedIslands.length > 0
      ? Math.max(
          0,
          Clipper.areaPaths(droppedIslands) * INV_WOOD_CLIPPER_AREA_SCALE,
        )
      : 0;
  for (let d = 0; d < droppedIslands.length; d++) {
    cutWoodPaths.push(droppedIslands[d]);
  }

  const areaAfter = computePanelRemainingAreaM2(state);
  const removedAreaM2 = Math.max(
    excisedAreaM2,
    Math.max(0, areaBefore - areaAfter),
  );

  const splinters = buildPerimeterSplinterDescriptors(
    cutWoodPaths,
    centerU,
    centerV,
    splinterCountHint,
    state.shotCount,
  );

  const meshStats = triangulateWoodPanelToBuffers(state, buffers);

  return {
    cutAnyWood: true,
    removedAreaM2,
    droppedIslandAreaM2,
    snappedBridgeCount,
    splinters,
    meshStats,
  };
}
