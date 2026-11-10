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
/** Maximum unanchored floating wood island area (`0.0225 m^2` ~ `15cm x 15cm`) auto-dropped inside holes. */
const MAX_FLOATING_ISLAND_DROP_AREA_M2 = 0.15 * 0.15;
/** Ramer-Douglas-Peucker simplification epsilon (`1.2 mm`) to clean grazing multi-shot slivers. */
const SIMPLIFY_EPSILON_M = 0.0012;

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
  /** Optional explicit base hole radius override in meters (e.g. explosive blast breach) */
  overrideRadiusM?: number;
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

export interface WoodPanelClipperState {
  readonly widthM: number;
  readonly heightM: number;
  readonly thicknessM: number;
  paths: Paths64;
  shells: WoodShellContour[];
  shotCount: number;
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
  // .50 AE (~6.35mm radius) or 12G Sabot Slug (~8.25mm radius) -> fist-sized ragged blowout
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
 * Models fibrous wood-grain splinter teeth and ammo-specific exit cone blowouts.
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
  let baseRadiusM = 0.042;
  let grainStretchU = 1.14;
  let toothJaggedness = 0.28;

  const clampedCaliberR = Math.max(0.002, Math.min(0.12, options.caliberRadiusM));
  const energyFactor = Math.min(1.65, Math.max(0.65, Math.sqrt(Math.max(50, options.kineticEnergyJ) / 1600)));

  switch (profile) {
    case 'BUCKSHOT_PELLET': {
      vertexCount = 10;
      baseRadiusM = Math.max(0.026, clampedCaliberR * 6.4) * Math.min(1.15, energyFactor + 0.35);
      grainStretchU = 1.12;
      toothJaggedness = 0.24;
      break;
    }
    case 'RIFLE_FMJ_AP': {
      vertexCount = 11;
      baseRadiusM = Math.max(0.033, clampedCaliberR * 9.5) * (0.82 + 0.22 * energyFactor);
      grainStretchU = 1.18;
      toothJaggedness = 0.26;
      break;
    }
    case 'RIFLE_JHP': {
      vertexCount = 12;
      baseRadiusM = Math.max(0.046, clampedCaliberR * 13.5) * (0.88 + 0.25 * energyFactor);
      grainStretchU = 1.16;
      toothJaggedness = 0.32;
      break;
    }
    case 'HEAVY_50AE_SLUG': {
      // Fist-sized ragged blowout (~14-18cm across)
      vertexCount = 13;
      baseRadiusM = Math.max(0.072, clampedCaliberR * 10.5) * (0.85 + 0.24 * energyFactor);
      grainStretchU = 1.15;
      toothJaggedness = 0.34;
      break;
    }
    case 'BUCKSHOT_CLUSTER': {
      vertexCount = 14;
      baseRadiusM = Math.max(0.115, clampedCaliberR * 18.0) * (0.85 + 0.22 * energyFactor);
      grainStretchU = 1.14;
      toothJaggedness = 0.35;
      break;
    }
    case 'BLAST_BREACH': {
      vertexCount = 14;
      baseRadiusM = Math.max(0.28, 0.22 * energyFactor);
      grainStretchU = 1.10;
      toothJaggedness = 0.30;
      break;
    }
  }

  if (options.overrideRadiusM !== undefined && options.overrideRadiusM > 0.005) {
    baseRadiusM = options.overrideRadiusM;
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
    const radialJitter = 1 + alternatingSign * toothJaggedness * (0.55 + 0.45 * rng());
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

function rebuildCleanShellsAndPaths(paths: Paths64): {
  cleanPaths: Paths64;
  shells: WoodShellContour[];
} {
  const minShellAreaScaled = MIN_SHELL_AREA_M2 * WOOD_CLIPPER_SCALE * WOOD_CLIPPER_SCALE;
  const minHoleAreaScaled = MIN_HOLE_AREA_M2 * WOOD_CLIPPER_SCALE * WOOD_CLIPPER_SCALE;
  const maxFloatingIslandScaled =
    MAX_FLOATING_ISLAND_DROP_AREA_M2 * WOOD_CLIPPER_SCALE * WOOD_CLIPPER_SCALE;
  const simplifyEpsScaled = SIMPLIFY_EPSILON_M * WOOD_CLIPPER_SCALE;

  const rawOuters: Array<{ path: Path64; area: number }> = [];
  const rawHoles: Array<{ path: Path64; absArea: number }> = [];

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
    return { cleanPaths: new Paths64(), shells: [] };
  }

  // Sort largest outer shells first so containment hierarchy is deterministic
  rawOuters.sort((a, b) => b.area - a.area);
  rawHoles.sort((a, b) => b.absArea - a.absArea);

  // Prune small detached floating wood islands nested inside open holes
  const survivingOuters: Array<{ path: Path64; area: number; holes: Path64[] }> = [];
  for (let i = 0; i < rawOuters.length; i++) {
    const candidate = rawOuters[i];
    if (candidate.area <= maxFloatingIslandScaled) {
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
      if (enclosedByHole) {
        continue;
      }
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

  return { cleanPaths, shells };
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

  const clampedCount = Math.max(4, Math.min(6, Math.round(desiredCount)));
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
      Math.min(0.18, (totalLen / clampedCount) * (0.65 + 0.5 * rng())),
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
 * Subtracts a 2D jagged polygon stamp from `state` via `Clipper2`, prunes micro-slivers,
 * triangulates surviving outer shells + interior holes via `earcut`, writes 3D sandwich geometry
 * (Front `+Z`, Back `-Z`, Extruded Inner Hole Rims) into `buffers`, and returns `4–6` perimeter
 * splinter spawn descriptors along the newly cut edge.
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
      splinters: [],
      meshStats: triangulateWoodPanelToBuffers(state, buffers),
    };
  }

  const stampPath = points2DToPath64(stamp);
  if (stampPath.length < 3) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
      splinters: [],
      meshStats: triangulateWoodPanelToBuffers(state, buffers),
    };
  }

  const clipPaths = new Paths64();
  clipPaths.push(stampPath);

  // Intersect stamp with remaining solid wood to measure exact excised wood & sample cut rim
  const cutWoodPaths = Clipper.Intersect(state.paths, clipPaths, FillRule.NonZero);
  const excisedAreaM2 = Math.max(
    0,
    Clipper.areaPaths(cutWoodPaths) * INV_WOOD_CLIPPER_AREA_SCALE,
  );

  if (excisedAreaM2 < 1e-6) {
    return {
      cutAnyWood: false,
      removedAreaM2: 0,
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

  state.shotCount++;

  const areaBefore = computePanelRemainingAreaM2(state);
  const rawDiff = Clipper.Difference(state.paths, clipPaths, FillRule.NonZero);
  const { cleanPaths, shells } = rebuildCleanShellsAndPaths(rawDiff);

  state.paths = cleanPaths;
  state.shells = shells;

  const areaAfter = computePanelRemainingAreaM2(state);
  const removedAreaM2 = Math.max(excisedAreaM2, Math.max(0, areaBefore - areaAfter));

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
    splinters,
    meshStats,
  };
}
