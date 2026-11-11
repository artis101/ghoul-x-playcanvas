import Delaunator from 'delaunator';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { BlastEvent, QuatLike } from '../../contracts/destruction.ts';
import {
  GLASS_CELL_CRACKED,
  GLASS_CELL_INTACT,
  GLASS_CELL_VOID,
  type GlassCellState,
  createDeterministicPrng,
} from './glassMarchingTiles.ts';

/**
 * Unified 2D Voronoi Shatter, Ballistic Laminated Voronoi Glass & Custom JS Floor-Bounce Simulator (Pure TS).
 *
 * Architecture Rule: Zero runtime `pc.Entity` allocations per glass shard and zero WASM rigid-body solver cost.
 * Unifies both:
 * 1. Armored / Ballistic Laminated Glass (`ArmoredVoronoiGlassPane`) — organic 2D Voronoi polygonal chunks
 *    with polycarbonate-interlayer multi-shot durability, 3D internal fracture bevels, tilted stress facets,
 *    and frame-connectivity island detachment.
 * 2. Regular Plate Glass (`ProgressiveVoronoiPane` + `shatterWindowVoronoi2D`) — bold, dramatic large angular
 *    plate wedges & frame-clinging perimeter/corner glass fangs, simulated in flat Struct-of-Arrays buffers.
 */

export const DEFAULT_VORONOI_SHARD_THICKNESS_M = 0.01;
export const DEFAULT_SHARD_FLOOR_Y = 0.008;
export const DEFAULT_SHARD_RESTITUTION = 0.28;
export const DEFAULT_SHARD_GRAVITY_Y = -9.81;

export const GLASS_SHARD_STYLE_CLEAR = 0;
export const GLASS_SHARD_STYLE_ARMORED = 1;

export const ARMORED_CHUNK_PRISTINE = 0;
export const ARMORED_CHUNK_CRAZED = 1;
export const ARMORED_CHUNK_FRACTURED = 2;
export const ARMORED_CHUNK_DETACHED = 3;

export type ArmoredChunkStage =
  | typeof ARMORED_CHUNK_PRISTINE
  | typeof ARMORED_CHUNK_CRAZED
  | typeof ARMORED_CHUNK_FRACTURED
  | typeof ARMORED_CHUNK_DETACHED;

export interface Point2D {
  x: number;
  y: number;
}

export interface ExtrudedGlassShardGeometry {
  /** Number of 2D polygon vertices `N` (`>= 3`). */
  polygonVertexCount: number;
  /** `6 * N` 3D vertices (`x, y, z` in shard-local space centered at `(centroidX, centroidY, 0)`). */
  localPositions: Float32Array;
  /** `6 * N` 3D unit normals (`nx, ny, nz`). */
  localNormals: Float32Array;
  /** `6 * N` 2D window UVs (`u, v` in `[0, 1]`). */
  localUvs: Float32Array;
  /** `12 * N - 12` triangle indices (`4 * N - 4` triangles). */
  localIndices: Uint16Array;
  vertexCount: number;
  indexCount: number;
}

export interface VoronoiGlassShardCell {
  index: number;
  seed: Point2D;
  /** Clipped CCW convex 2D polygon in `[0, widthM] x [0, heightM]`. */
  polygon: Point2D[];
  /** Exact area-weighted 2D polygon centroid in `[0, widthM] x [0, heightM]`. */
  centroid: Point2D;
  /** Exact 2D polygon area in square meters. */
  areaM2: number;
  /** Distance from `(hitX, hitY)` to `centroid` in meters. */
  radialDistanceM: number;
  /** Extruded 3D prism geometry centered at `(centroid.x, centroid.y, 0)`. */
  extruded: ExtrudedGlassShardGeometry;
  /** Adjacent shard indices in `shards` sharing a non-degenerate Voronoi edge (`> 0.1 mm`). */
  neighbors: number[];
  /** Whether any edge of `polygon` lies flush against the outer `[0, widthM] x [0, heightM]` sash frame. */
  touchesFrame: boolean;
  /** Total contact length in meters along the outer `[0, widthM] x [0, heightM]` sash frame. */
  frameContactLengthM: number;
}

export interface VoronoiWindowShatterOptions {
  widthM: number;
  heightM: number;
  hitX: number;
  hitY: number;
  /** Target interior shard count in `[8, 96]` (defaults to `42`). */
  shardCount?: number;
  /** Extruded shard thickness in meters (defaults to `0.01` = 1 cm). */
  thicknessM?: number;
  /** Deterministic PRNG seed. */
  seed?: number;
}

export interface VoronoiWindowShatterResult {
  widthM: number;
  heightM: number;
  hitX: number;
  hitY: number;
  thicknessM: number;
  /** All interior + outer-ring Delaunay seed points passed to `Delaunator.from`. */
  allSeeds: Point2D[];
  interiorSeedCount: number;
  shards: VoronoiGlassShardCell[];
  totalAreaM2: number;
}

export interface OrganicVoronoiLayoutOptions {
  widthM: number;
  heightM: number;
  /** Target organic Voronoi cell count in `[16, 128]` (defaults to `68`). */
  cellCount?: number;
  /** Extruded prism thickness in meters (defaults to `0.024`). */
  thicknessM?: number;
  /** Deterministic PRNG seed. */
  seed?: number;
}

export interface SpawnVoronoiShardsTransform {
  /** World-space center of the `[0, widthM] x [0, heightM]` window pane. */
  windowCenterWorld: Vec3Like;
  /** World-space orientation of the window pane (local +X right, +Y up, +Z normal). */
  windowRotationQuat?: QuatLike;
  /** Normalized world-space projectile or shockwave travel direction. */
  impactDirectionWorld: Vec3Like;
  /** Kinetic or blast energy in Joules driving launch speed & spin. */
  impactEnergyJ: number;
  /** Base lifetime of spawned shards in seconds (defaults to `3.6`). */
  ttlSeconds?: number;
  /** Deterministic seed for per-shard velocity/spin jitter. */
  seed?: number;
  /** Optional override focal point `(hitX, hitY)` in `[0, widthM] x [0, heightM]` for radial ejection. */
  impactOrigin2D?: Point2D;
  /** Visual tint style (`0` = clear architectural plate, `1` = crazed ballistic laminate). */
  shardStyle?: number;
}

export interface GlassShardBatchedMeshStats {
  activeShards: number;
  vertexCount: number;
  indexCount: number;
}

export interface ArmoredVoronoiImpactOptions {
  /** Horizontal impact coordinate in `[0, widthM]`. */
  hitX: number;
  /** Vertical impact coordinate in `[0, heightM]`. */
  hitY: number;
  /** Projectile or blast energy in Joules. */
  energyJ: number;
  /** Physical impact or blast knockout radius in meters. */
  radiusM?: number;
  /** Whether the projectile has an armor-piercing core. */
  isArmorPiercing?: boolean;
  /** Deterministic PRNG seed. */
  seed?: number;
}

export interface ArmoredVoronoiImpactReport {
  alreadyBrokenHole: boolean;
  newlyDetachedIndices: number[];
  chunksCrazed: number;
  survivingChunkCount: number;
  detachedChunkCount: number;
}

export interface ArmoredMeshBuildStats {
  survivingChunks: number;
  vertexCount: number;
  indexCount: number;
}

export interface ProgressiveVoronoiHitReport {
  hitOpenBreach: boolean;
  newlyDetachedIndices: number[];
  survivingFangCount: number;
}

const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };

function prevHalfedge(e: number): number {
  return e % 3 === 0 ? e + 2 : e - 1;
}

/**
 * Numerically stable circumcenter of 2D triangle `(ax, ay), (bx, by), (cx, cy)`.
 */
export function computeTriangleCircumcenter2D(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): Point2D {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;

  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const denom = 2 * (dx * ey - dy * ex);

  if (Math.abs(denom) < 1e-14) {
    return {
      x: (ax + bx + cx) / 3,
      y: (ay + by + cy) / 3,
    };
  }

  const invDenom = 1 / denom;
  return {
    x: ax + (ey * bl - dy * cl) * invDenom,
    y: ay + (dx * cl - ex * bl) * invDenom,
  };
}

/**
 * Signed 2D shoelace area (`> 0` for counterclockwise polygons).
 */
export function computeSignedPolygonArea2D(polygon: readonly Point2D[]): number {
  const n = polygon.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum * 0.5;
}

/**
 * Computes exact positive area and area-weighted 2D centroid of a simple polygon.
 */
export function computePolygonAreaAndCentroid2D(
  polygon: readonly Point2D[],
): { areaM2: number; centroid: Point2D } {
  const n = polygon.length;
  if (n === 0) {
    return { areaM2: 0, centroid: { x: 0, y: 0 } };
  }
  if (n < 3) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += polygon[i].x;
      sy += polygon[i].y;
    }
    return { areaM2: 0, centroid: { x: sx / n, y: sy / n } };
  }

  let crossSum = 0;
  let cxSum = 0;
  let cySum = 0;

  for (let i = 0; i < n; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % n];
    const cross = p0.x * p1.y - p1.x * p0.y;
    crossSum += cross;
    cxSum += (p0.x + p1.x) * cross;
    cySum += (p0.y + p1.y) * cross;
  }

  const signedArea = crossSum * 0.5;
  const areaM2 = Math.abs(signedArea);
  if (areaM2 < 1e-12) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += polygon[i].x;
      sy += polygon[i].y;
    }
    return { areaM2: 0, centroid: { x: sx / n, y: sy / n } };
  }

  const invSixArea = 1 / (6 * signedArea);
  return {
    areaM2,
    centroid: {
      x: cxSum * invSixArea,
      y: cySum * invSixArea,
    },
  };
}

/**
 * Exact point-in-CCW-convex-polygon test (`true` inside or within `eps` of boundary).
 */
export function isPointInConvexPolygon2D(
  polygon: readonly Point2D[],
  x: number,
  y: number,
  eps = 1e-6,
): boolean {
  const n = polygon.length;
  if (n < 3) return false;

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const cross = ex * (y - a.y) - ey * (x - a.x);
    if (cross < -eps) {
      return false;
    }
  }
  return true;
}

/**
 * Euclidean distance from `(x, y)` to a CCW convex polygon (`0` if inside).
 */
export function pointToConvexPolygonDistance2D(
  polygon: readonly Point2D[],
  x: number,
  y: number,
): number {
  if (isPointInConvexPolygon2D(polygon, x, y, 1e-7)) {
    return 0;
  }
  const n = polygon.length;
  let minDistSq = Infinity;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abLenSq = abx * abx + aby * aby;
    const t =
      abLenSq > 1e-14
        ? Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / abLenSq))
        : 0;
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const dx = x - px;
    const dy = y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < minDistSq) {
      minDistSq = dSq;
    }
  }
  return Math.sqrt(minDistSq);
}

function clipAgainstHalfPlane(
  poly: readonly Point2D[],
  isInside: (p: Point2D) => boolean,
  intersect: (a: Point2D, b: Point2D) => Point2D,
): Point2D[] {
  const len = poly.length;
  if (len === 0) return [];

  const out: Point2D[] = [];
  let prev = poly[len - 1];
  let prevInside = isInside(prev);

  for (let i = 0; i < len; i++) {
    const curr = poly[i];
    const currInside = isInside(curr);

    if (currInside) {
      if (!prevInside) {
        out.push(intersect(prev, curr));
      }
      out.push(curr);
    } else if (prevInside) {
      out.push(intersect(prev, curr));
    }

    prev = curr;
    prevInside = currInside;
  }

  return out;
}

/**
 * Clips an arbitrary 2D convex/simple polygon against axis-aligned rectangle
 * `[minX, maxX] x [minY, maxY]` using Sutherland-Hodgman 4-plane polygon clipping,
 * removing degenerate near-duplicate vertices.
 */
export function clipPolygonToRectSutherlandHodgman(
  polygon: readonly Point2D[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Point2D[] {
  if (polygon.length < 3) {
    return [];
  }

  // Plane 1: x >= minX
  let stage = clipAgainstHalfPlane(
    polygon,
    (p) => p.x >= minX,
    (a, b) => {
      const dx = b.x - a.x;
      const t = Math.abs(dx) > 1e-14 ? (minX - a.x) / dx : 0;
      return { x: minX, y: a.y + (b.y - a.y) * t };
    },
  );
  if (stage.length < 3) return [];

  // Plane 2: x <= maxX
  stage = clipAgainstHalfPlane(
    stage,
    (p) => p.x <= maxX,
    (a, b) => {
      const dx = b.x - a.x;
      const t = Math.abs(dx) > 1e-14 ? (maxX - a.x) / dx : 0;
      return { x: maxX, y: a.y + (b.y - a.y) * t };
    },
  );
  if (stage.length < 3) return [];

  // Plane 3: y >= minY
  stage = clipAgainstHalfPlane(
    stage,
    (p) => p.y >= minY,
    (a, b) => {
      const dy = b.y - a.y;
      const t = Math.abs(dy) > 1e-14 ? (minY - a.y) / dy : 0;
      return { x: a.x + (b.x - a.x) * t, y: minY };
    },
  );
  if (stage.length < 3) return [];

  // Plane 4: y <= maxY
  stage = clipAgainstHalfPlane(
    stage,
    (p) => p.y <= maxY,
    (a, b) => {
      const dy = b.y - a.y;
      const t = Math.abs(dy) > 1e-14 ? (maxY - a.y) / dy : 0;
      return { x: a.x + (b.x - a.x) * t, y: maxY };
    },
  );
  if (stage.length < 3) return [];

  // Deduplicate consecutive near-coincident vertices
  const cleaned: Point2D[] = [];
  const epsSq = 1e-12;
  for (let i = 0; i < stage.length; i++) {
    const pt = stage[i];
    const prev = cleaned.length > 0 ? cleaned[cleaned.length - 1] : stage[stage.length - 1];
    const dx = pt.x - prev.x;
    const dy = pt.y - prev.y;
    if (dx * dx + dy * dy > epsSq) {
      cleaned.push(pt);
    }
  }

  return cleaned.length >= 3 ? cleaned : [];
}

/**
 * Extrudes a 2D CCW convex polygon shard into a 3D prism of thickness `thicknessM`
 * (`default 0.01 m` = 1 cm) centered at `(centroid.x, centroid.y, 0)`:
 * - Front face (`z = +thicknessM * 0.5`, normal `+Z`, `N` vertices, `N - 2` triangles)
 * - Back face (`z = -thicknessM * 0.5`, normal `-Z`, `N` vertices, `N - 2` triangles)
 * - Bevel / Rim perimeter quads (`N` edges, outward edge normals, `4 * N` vertices, `2 * N` triangles)
 *
 * Total exact counts for an `N`-gon: `6 * N` vertices and `12 * N - 12` indices.
 */
export function extrudeConvexShard2D(
  polygon: readonly Point2D[],
  centroid: Point2D,
  widthM: number,
  heightM: number,
  thicknessM = DEFAULT_VORONOI_SHARD_THICKNESS_M,
): ExtrudedGlassShardGeometry {
  const n = polygon.length;
  if (n < 3) {
    return {
      polygonVertexCount: 0,
      localPositions: new Float32Array(0),
      localNormals: new Float32Array(0),
      localUvs: new Float32Array(0),
      localIndices: new Uint16Array(0),
      vertexCount: 0,
      indexCount: 0,
    };
  }

  // Ensure CCW winding in 2D XY
  const isCcw = computeSignedPolygonArea2D(polygon) >= 0;
  const ordered: Point2D[] = isCcw
    ? polygon.slice()
    : polygon.slice().reverse();

  const halfZ = Math.max(0.0005, thicknessM * 0.5);
  const invW = widthM > 1e-6 ? 1 / widthM : 1;
  const invH = heightM > 1e-6 ? 1 / heightM : 1;

  const vertexCount = 6 * n;
  const indexCount = 12 * n - 12;

  const localPositions = new Float32Array(vertexCount * 3);
  const localNormals = new Float32Array(vertexCount * 3);
  const localUvs = new Float32Array(vertexCount * 2);
  const localIndices = new Uint16Array(indexCount);

  let vIdx = 0;
  let iIdx = 0;

  // 1. Front face: vertices [0 .. n - 1] at z = +halfZ, normal (0, 0, +1)
  const frontBase = vIdx;
  for (let i = 0; i < n; i++) {
    const p = ordered[i];
    const p3 = vIdx * 3;
    const p2 = vIdx * 2;
    localPositions[p3] = p.x - centroid.x;
    localPositions[p3 + 1] = p.y - centroid.y;
    localPositions[p3 + 2] = halfZ;

    localNormals[p3] = 0;
    localNormals[p3 + 1] = 0;
    localNormals[p3 + 2] = 1;

    localUvs[p2] = p.x * invW;
    localUvs[p2 + 1] = p.y * invH;
    vIdx++;
  }
  for (let i = 1; i < n - 1; i++) {
    localIndices[iIdx++] = frontBase;
    localIndices[iIdx++] = frontBase + i;
    localIndices[iIdx++] = frontBase + i + 1;
  }

  // 2. Back face: vertices [n .. 2*n - 1] at z = -halfZ, normal (0, 0, -1), reversed winding
  const backBase = vIdx;
  for (let i = 0; i < n; i++) {
    const p = ordered[i];
    const p3 = vIdx * 3;
    const p2 = vIdx * 2;
    localPositions[p3] = p.x - centroid.x;
    localPositions[p3 + 1] = p.y - centroid.y;
    localPositions[p3 + 2] = -halfZ;

    localNormals[p3] = 0;
    localNormals[p3 + 1] = 0;
    localNormals[p3 + 2] = -1;

    localUvs[p2] = p.x * invW;
    localUvs[p2 + 1] = p.y * invH;
    vIdx++;
  }
  for (let i = 1; i < n - 1; i++) {
    localIndices[iIdx++] = backBase;
    localIndices[iIdx++] = backBase + i + 1;
    localIndices[iIdx++] = backBase + i;
  }

  // 3. Bevel / Rim perimeter quads: 4 vertices & 2 triangles per edge
  for (let i = 0; i < n; i++) {
    const p0 = ordered[i];
    const p1 = ordered[(i + 1) % n];

    const lx0 = p0.x - centroid.x;
    const ly0 = p0.y - centroid.y;
    const lx1 = p1.x - centroid.x;
    const ly1 = p1.y - centroid.y;

    const edx = lx1 - lx0;
    const edy = ly1 - ly0;
    const eLen = Math.hypot(edx, edy);
    const nx = eLen > 1e-8 ? edy / eLen : 1;
    const ny = eLen > 1e-8 ? -edx / eLen : 0;

    const rimBase = vIdx;

    const writeRimVert = (
      vx: number,
      vy: number,
      vz: number,
      uCoord: number,
      vCoord: number,
    ): void => {
      const p3 = vIdx * 3;
      const p2 = vIdx * 2;
      localPositions[p3] = vx;
      localPositions[p3 + 1] = vy;
      localPositions[p3 + 2] = vz;
      localNormals[p3] = nx;
      localNormals[p3 + 1] = ny;
      localNormals[p3 + 2] = 0;
      localUvs[p2] = uCoord;
      localUvs[p2 + 1] = vCoord;
      vIdx++;
    };

    writeRimVert(lx0, ly0, halfZ, p0.x * invW, p0.y * invH);
    writeRimVert(lx1, ly1, halfZ, p1.x * invW, p1.y * invH);
    writeRimVert(lx1, ly1, -halfZ, p1.x * invW, p1.y * invH);
    writeRimVert(lx0, ly0, -halfZ, p0.x * invW, p0.y * invH);

    // Outward CCW winding when viewed against outward normal (nx, ny, 0)
    localIndices[iIdx++] = rimBase;
    localIndices[iIdx++] = rimBase + 3;
    localIndices[iIdx++] = rimBase + 2;

    localIndices[iIdx++] = rimBase;
    localIndices[iIdx++] = rimBase + 2;
    localIndices[iIdx++] = rimBase + 1;
  }

  return {
    polygonVertexCount: n,
    localPositions,
    localNormals,
    localUvs,
    localIndices,
    vertexCount,
    indexCount,
  };
}

function buildVoronoiCellsFromInteriorSeeds(
  interiorSeeds: Point2D[],
  widthM: number,
  heightM: number,
  hitX: number,
  hitY: number,
  thicknessM: number,
): VoronoiWindowShatterResult {
  const seeds = interiorSeeds.slice();
  const interiorSeedCount = seeds.length;
  const diagM = Math.hypot(widthM, heightM);

  // Add 8 distant outer super-ring boundary seeds at radius `8 * diagM` so every
  // interior cell is strictly bounded inside the Delaunay hull and partitions `[0, widthM] x [0, heightM]` gap-free.
  const outerRadius = diagM * 8.0;
  const centerWindowX = widthM * 0.5;
  const centerWindowY = heightM * 0.5;
  for (let k = 0; k < 8; k++) {
    const angle = (k * Math.PI) / 4;
    seeds.push({
      x: centerWindowX + Math.cos(angle) * outerRadius,
      y: centerWindowY + Math.sin(angle) * outerRadius,
    });
  }

  const delaunay = Delaunator.from(
    seeds,
    (p: Point2D) => p.x,
    (p: Point2D) => p.y,
  );

  const { triangles, halfedges } = delaunay;
  const numTriangles = triangles.length / 3;

  const circumcenters: Point2D[] = new Array<Point2D>(numTriangles);
  for (let t = 0; t < numTriangles; t++) {
    const aIdx = triangles[t * 3];
    const bIdx = triangles[t * 3 + 1];
    const cIdx = triangles[t * 3 + 2];
    const a = seeds[aIdx];
    const b = seeds[bIdx];
    const c = seeds[cIdx];
    circumcenters[t] = computeTriangleCircumcenter2D(
      a.x,
      a.y,
      b.x,
      b.y,
      c.x,
      c.y,
    );
  }

  const seedToHalfedge = new Int32Array(seeds.length).fill(-1);
  for (let e = 0; e < triangles.length; e++) {
    const endpoint = triangles[e];
    if (seedToHalfedge[endpoint] === -1) {
      seedToHalfedge[endpoint] = e;
    }
  }

  const shards: VoronoiGlassShardCell[] = [];
  let totalAreaM2 = 0;
  const frameEps = 1e-4;

  for (let s = 0; s < interiorSeedCount; s++) {
    const startEdge = seedToHalfedge[s];
    if (startEdge < 0) continue;

    const rawCellLoop: Point2D[] = [];
    let e = startEdge;
    let closedCleanly = false;

    for (let step = 0; step <= numTriangles; step++) {
      const triIdx = Math.floor(e / 3);
      rawCellLoop.push(circumcenters[triIdx]);

      const incoming = prevHalfedge(e);
      const nextOut = halfedges[incoming];
      if (nextOut === -1) {
        closedCleanly = false;
        break;
      }
      if (nextOut === startEdge) {
        closedCleanly = true;
        break;
      }
      e = nextOut;
    }

    if (!closedCleanly || rawCellLoop.length < 3) {
      continue;
    }

    if (computeSignedPolygonArea2D(rawCellLoop) < 0) {
      rawCellLoop.reverse();
    }

    const clipped = clipPolygonToRectSutherlandHodgman(
      rawCellLoop,
      0,
      0,
      widthM,
      heightM,
    );
    if (clipped.length < 3) {
      continue;
    }

    const { areaM2, centroid } = computePolygonAreaAndCentroid2D(clipped);
    if (areaM2 <= 1e-8) {
      continue;
    }

    let frameContactLengthM = 0;
    for (let i = 0; i < clipped.length; i++) {
      const p0 = clipped[i];
      const p1 = clipped[(i + 1) % clipped.length];
      const onLeft = p0.x <= frameEps && p1.x <= frameEps;
      const onRight = p0.x >= widthM - frameEps && p1.x >= widthM - frameEps;
      const onBottom = p0.y <= frameEps && p1.y <= frameEps;
      const onTop = p0.y >= heightM - frameEps && p1.y >= heightM - frameEps;
      if (onLeft || onRight || onBottom || onTop) {
        frameContactLengthM += Math.hypot(p1.x - p0.x, p1.y - p0.y);
      }
    }

    const extruded = extrudeConvexShard2D(
      clipped,
      centroid,
      widthM,
      heightM,
      thicknessM,
    );

    const radialDistanceM = Math.hypot(centroid.x - hitX, centroid.y - hitY);
    totalAreaM2 += areaM2;

    shards.push({
      index: shards.length,
      seed: seeds[s],
      polygon: clipped,
      centroid,
      areaM2,
      radialDistanceM,
      extruded,
      neighbors: [],
      touchesFrame: frameContactLengthM > 1e-4,
      frameContactLengthM,
    });
  }

  // Populate exact edge-sharing adjacency graph across clipped Voronoi cells via quantized edge midpoints
  const midpointBuckets = new Map<string, Array<{ shardIdx: number; p0: Point2D; p1: Point2D }>>();
  for (let sIdx = 0; sIdx < shards.length; sIdx++) {
    const poly = shards[sIdx].polygon;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % n];
      const eLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (eLen <= 1e-4) continue;
      const mx = Math.round((p0.x + p1.x) * 2500);
      const my = Math.round((p0.y + p1.y) * 2500);
      const key = `${mx}:${my}`;
      const existing = midpointBuckets.get(key);
      if (existing) {
        for (let k = 0; k < existing.length; k++) {
          const other = existing[k];
          if (other.shardIdx === sIdx) continue;
          const matchOpp =
            Math.hypot(p0.x - other.p1.x, p0.y - other.p1.y) < 1.5e-3 &&
            Math.hypot(p1.x - other.p0.x, p1.y - other.p0.y) < 1.5e-3;
          const matchSame =
            Math.hypot(p0.x - other.p0.x, p0.y - other.p0.y) < 1.5e-3 &&
            Math.hypot(p1.x - other.p1.x, p1.y - other.p1.y) < 1.5e-3;
          if (matchOpp || matchSame) {
            if (!shards[sIdx].neighbors.includes(other.shardIdx)) {
              shards[sIdx].neighbors.push(other.shardIdx);
            }
            if (!shards[other.shardIdx].neighbors.includes(sIdx)) {
              shards[other.shardIdx].neighbors.push(sIdx);
            }
          }
        }
        existing.push({ shardIdx: sIdx, p0, p1 });
      } else {
        midpointBuckets.set(key, [{ shardIdx: sIdx, p0, p1 }]);
      }
    }
  }

  return {
    widthM,
    heightM,
    hitX,
    hitY,
    thicknessM,
    allSeeds: seeds,
    interiorSeedCount,
    shards,
    totalAreaM2,
  };
}

/**
 * Generates radially concentrated jittered 2D seed points around `(hitX, hitY)`
 * (supporting both `18–26` bold angular plate shards for regular glass and `36–48+` fine
 * radial shatter shards), runs `Delaunator.from(...)`, clips every cell to `[0, widthM] x [0, heightM]`
 * via Sutherland-Hodgman clipping, builds exact neighbor/frame topology, and extrudes 3D shard prisms.
 */
export function shatterWindowVoronoi2D(
  options: VoronoiWindowShatterOptions,
): VoronoiWindowShatterResult {
  const widthM = Math.max(0.1, options.widthM);
  const heightM = Math.max(0.1, options.heightM);
  const thicknessM = options.thicknessM ?? DEFAULT_VORONOI_SHARD_THICKNESS_M;
  const targetShardCount = Math.max(
    8,
    Math.min(96, Math.round(options.shardCount ?? 42)),
  );

  const marginX = widthM * 0.025;
  const marginY = heightM * 0.025;
  const hitX = Math.max(marginX, Math.min(widthM - marginX, options.hitX));
  const hitY = Math.max(marginY, Math.min(heightM - marginY, options.hitY));

  const seedInt =
    options.seed ??
    ((Math.round(hitX * 1000) * 73856093) ^
      (Math.round(hitY * 1000) * 19349663) ^
      (Math.round(widthM * 500) * 83492791) ^
      targetShardCount);
  const rand = createDeterministicPrng(seedInt);

  const minDimM = Math.min(widthM, heightM);
  const minSepSq = Math.pow(minDimM * 0.018, 2);
  const seeds: Point2D[] = [];

  const tryPushInteriorSeed = (x: number, y: number): boolean => {
    const cx = Math.max(marginX * 0.5, Math.min(widthM - marginX * 0.5, x));
    const cy = Math.max(marginY * 0.5, Math.min(heightM - marginY * 0.5, y));
    for (let i = 0; i < seeds.length; i++) {
      const dx = seeds[i].x - cx;
      const dy = seeds[i].y - cy;
      if (dx * dx + dy * dy < minSepSq) {
        return false;
      }
    }
    seeds.push({ x: cx, y: cy });
    return true;
  };

  // 1. Impact core seed slightly jittered around exact bullet center
  tryPushInteriorSeed(
    hitX + (rand() - 0.5) * minDimM * 0.015,
    hitY + (rand() - 0.5) * minDimM * 0.015,
  );

  if (targetShardCount <= 30) {
    // Large-Plate Angular Mode: cluster seeds along radial fracture spokes so Voronoi bisectors
    // slice bold, dramatic angular glass wedges/daggers & sharp perimeter/corner fangs!
    const spokeCount = Math.max(5, Math.min(7, Math.round(targetShardCount * 0.28)));
    const spokeBaseAngle = rand() * Math.PI * 2;
    const spokeAngles: number[] = [];
    for (let s = 0; s < spokeCount; s++) {
      spokeAngles.push(
        spokeBaseAngle +
          (s / spokeCount) * Math.PI * 2 +
          (rand() - 0.5) * ((Math.PI * 0.65) / spokeCount),
      );
    }

    const innerCount = Math.max(3, Math.round((targetShardCount - 1) * 0.28));
    const midCount = Math.max(4, Math.round((targetShardCount - 1) * 0.36));
    const outerCount = Math.max(0, targetShardCount - 1 - innerCount - midCount);

    for (let i = 0; i < innerCount; i++) {
      const spoke = spokeAngles[i % spokeCount];
      const angle = spoke + (rand() - 0.5) * 0.34;
      const radius = (0.055 + rand() * 0.115) * minDimM;
      if (
        !tryPushInteriorSeed(
          hitX + Math.cos(angle) * radius,
          hitY + Math.sin(angle) * radius,
        )
      ) {
        tryPushInteriorSeed(
          marginX + rand() * (widthM - 2 * marginX),
          marginY + rand() * (heightM - 2 * marginY),
        );
      }
    }

    for (let i = 0; i < midCount; i++) {
      const spoke = spokeAngles[(i + 2) % spokeCount];
      const angle = spoke + (rand() - 0.5) * 0.42;
      const radius = (0.19 + Math.pow(rand(), 0.85) * 0.26) * minDimM;
      if (
        !tryPushInteriorSeed(
          hitX + Math.cos(angle) * radius,
          hitY + Math.sin(angle) * radius,
        )
      ) {
        tryPushInteriorSeed(
          marginX + rand() * (widthM - 2 * marginX),
          marginY + rand() * (heightM - 2 * marginY),
        );
      }
    }

    const perimeterBase = rand() * Math.PI * 2;
    for (let i = 0; i < outerCount; i++) {
      const theta =
        perimeterBase +
        (i / Math.max(1, outerCount)) * Math.PI * 2 +
        (rand() - 0.5) * 0.38;
      const rx = widthM * (0.35 + rand() * 0.12);
      const ry = heightM * (0.35 + rand() * 0.12);
      const px = widthM * 0.5 + Math.cos(theta) * rx;
      const py = heightM * 0.5 + Math.sin(theta) * ry;
      if (!tryPushInteriorSeed(px, py)) {
        tryPushInteriorSeed(
          marginX + rand() * (widthM - 2 * marginX),
          marginY + rand() * (heightM - 2 * marginY),
        );
      }
    }
  } else {
    // Radially concentrated rings around (hitX, hitY): dense inner rings, wider outer rings
    const innerRingCount = Math.round((targetShardCount - 1) * 0.34);
    const midRingCount = Math.round((targetShardCount - 1) * 0.36);
    const outerFrameCount = targetShardCount - 1 - innerRingCount - midRingCount;

    const populateRing = (
      count: number,
      minRadiusFrac: number,
      maxRadiusFrac: number,
    ): void => {
      const baseAngle = rand() * Math.PI * 2;
      for (let i = 0; i < count; i++) {
        const frac = count > 1 ? i / count : 0;
        const angle =
          baseAngle + frac * Math.PI * 2 + (rand() - 0.5) * ((Math.PI * 1.3) / count);
        const rFrac =
          minRadiusFrac +
          Math.pow(rand(), 0.85) * (maxRadiusFrac - minRadiusFrac);
        const radius = rFrac * minDimM;
        const sx = hitX + Math.cos(angle) * radius;
        const sy = hitY + Math.sin(angle) * radius;
        if (!tryPushInteriorSeed(sx, sy)) {
          for (let attempt = 0; attempt < 12; attempt++) {
            const fallbackX = marginX + rand() * (widthM - 2 * marginX);
            const fallbackY = marginY + rand() * (heightM - 2 * marginY);
            if (tryPushInteriorSeed(fallbackX, fallbackY)) {
              break;
            }
          }
        }
      }
    };

    populateRing(innerRingCount, 0.04, 0.16);
    populateRing(midRingCount, 0.17, 0.42);

    const perimeterBaseAngle = rand() * Math.PI * 2;
    for (let i = 0; i < outerFrameCount; i++) {
      const theta =
        perimeterBaseAngle +
        (i / Math.max(1, outerFrameCount)) * Math.PI * 2 +
        (rand() - 0.5) * 0.35;
      const rx = widthM * (0.36 + rand() * 0.12);
      const ry = heightM * (0.36 + rand() * 0.12);
      const px = widthM * 0.5 + Math.cos(theta) * rx;
      const py = heightM * 0.5 + Math.sin(theta) * ry;
      if (!tryPushInteriorSeed(px, py)) {
        for (let attempt = 0; attempt < 16; attempt++) {
          const fx = marginX + rand() * (widthM - 2 * marginX);
          const fy = marginY + rand() * (heightM - 2 * marginY);
          if (tryPushInteriorSeed(fx, fy)) {
            break;
          }
        }
      }
    }
  }

  let safetyGuard = 0;
  while (seeds.length < targetShardCount && safetyGuard < 256) {
    safetyGuard++;
    const fx = marginX + rand() * (widthM - 2 * marginX);
    const fy = marginY + rand() * (heightM - 2 * marginY);
    tryPushInteriorSeed(fx, fy);
  }

  return buildVoronoiCellsFromInteriorSeeds(
    seeds,
    widthM,
    heightM,
    hitX,
    hitY,
    thicknessM,
  );
}

/**
 * Generates an organic, non-grid 2D Voronoi partition across `[0, widthM] x [0, heightM]`
 * using golden-angle / Poisson-spaced irregular seeds (zero square/column alignment) for
 * ballistic laminated glass windows (`ArmoredVoronoiGlassPane`).
 */
export function generateOrganicVoronoiCells2D(
  options: OrganicVoronoiLayoutOptions,
): VoronoiWindowShatterResult {
  const widthM = Math.max(0.1, options.widthM);
  const heightM = Math.max(0.1, options.heightM);
  const targetCells = Math.max(16, Math.min(128, Math.round(options.cellCount ?? 68)));
  const thicknessM = options.thicknessM ?? 0.024;
  const rand = createDeterministicPrng(options.seed ?? 0x474c4153);

  const avgCellArea = (widthM * heightM) / targetCells;
  const approxPitch = Math.sqrt(avgCellArea);
  const minSep = approxPitch * 0.56;
  const minSepSq = minSep * minSep;
  const marginX = Math.min(widthM * 0.05, approxPitch * 0.32);
  const marginY = Math.min(heightM * 0.05, approxPitch * 0.32);

  const seeds: Point2D[] = [];
  const tryAdd = (x: number, y: number, sepSq: number): boolean => {
    const cx = Math.max(marginX, Math.min(widthM - marginX, x));
    const cy = Math.max(marginY, Math.min(heightM - marginY, y));
    for (let i = 0; i < seeds.length; i++) {
      const dx = seeds[i].x - cx;
      const dy = seeds[i].y - cy;
      if (dx * dx + dy * dy < sepSq) {
        return false;
      }
    }
    seeds.push({ x: cx, y: cy });
    return true;
  };

  // Halton / golden-ratio quasi-random base with strong organic jitter -> completely non-grid!
  const phi1 = 0.7548776662466927;
  const phi2 = 0.5698402909980532;
  const phaseX = rand();
  const phaseY = rand();

  for (let i = 0; i < targetCells * 4 && seeds.length < targetCells; i++) {
    const qx = (phaseX + (i + 1) * phi1) % 1;
    const qy = (phaseY + (i + 1) * phi2) % 1;
    const jx = (rand() - 0.5) * approxPitch * 0.65;
    const jy = (rand() - 0.5) * approxPitch * 0.65;
    const x = marginX + qx * (widthM - 2 * marginX) + jx;
    const y = marginY + qy * (heightM - 2 * marginY) + jy;
    tryAdd(x, y, minSepSq);
  }

  let fallback = 0;
  while (seeds.length < targetCells && fallback < 320) {
    fallback++;
    tryAdd(
      marginX + rand() * (widthM - 2 * marginX),
      marginY + rand() * (heightM - 2 * marginY),
      minSepSq * 0.45,
    );
  }

  return buildVoronoiCellsFromInteriorSeeds(
    seeds,
    widthM,
    heightM,
    widthM * 0.5,
    heightM * 0.5,
    thicknessM,
  );
}

/**
 * Ballistic Laminated Voronoi Glass Pane (`ArmoredVoronoiGlassPane`):
 * - Partitions the pane into organic 2D Voronoi polygonal chunks (zero square grid!).
 * - Tracks polycarbonate-interlayer structural integrity per chunk (`PRISTINE` -> `CRAZED` -> `FRACTURED` -> `DETACHED`).
 * - Moderate shots (`< 1350 J`) craze & spiderweb-fracture chunks on Shot 1 without dropping chunks, requiring
 *   repeated hits before thick 3D Voronoi chunks tear out of the interlayer!
 * - High-velocity rifle rounds (`>= 1350 J`) punch a tight bullseye core perforation on Shot 1 while crazing a
 *   wide surrounding Voronoi halo that stays stubbornly held in the frame until follow-up shots!
 * - Emits seamless window-space `[0, 1]` UV 3D geometry when pristine, plus 3D internal laminate fracture bevels,
 *   tilted specular stress sub-facets, and crisp organic spiderweb crack lines when crazed/fractured!
 */
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

  private readonly bfsVisited: Uint8Array;
  private readonly bfsQueue: Int32Array;
  private survivingCount: number;
  private impactCounter = 0;

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
      if (
        this.stage[i] === ARMORED_CHUNK_CRAZED ||
        this.stage[i] === ARMORED_CHUNK_FRACTURED
      ) {
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
    if (idx < 0) return true;
    return this.stage[idx] === ARMORED_CHUNK_DETACHED;
  }

  public sampleCellStateAtUv(u: number, v: number): GlassCellState {
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      return GLASS_CELL_VOID;
    }
    const idx = this.findChunkAt(u * this.widthM, v * this.heightM);
    if (idx < 0) return GLASS_CELL_VOID;
    const st = this.stage[idx];
    if (st === ARMORED_CHUNK_DETACHED) return GLASS_CELL_VOID;
    if (st === ARMORED_CHUNK_PRISTINE) return GLASS_CELL_INTACT;
    return GLASS_CELL_CRACKED;
  }

  public applyImpact(options: ArmoredVoronoiImpactOptions): ArmoredVoronoiImpactReport {
    const hitX = Math.max(0, Math.min(this.widthM, options.hitX));
    const hitY = Math.max(0, Math.min(this.heightM, options.hitY));
    const energyJ = Math.max(0, options.energyJ);
    const requestedRadiusM = options.radiusM ?? 0.04;
    const isBlastOrHeavyBreach = energyJ >= 4500 || requestedRadiusM >= 0.20;

    const hitIdx = this.findChunkAt(hitX, hitY);
    if (hitIdx < 0) {
      return {
        alreadyBrokenHole: true,
        newlyDetachedIndices: [],
        chunksCrazed: 0,
        survivingChunkCount: this.survivingCount,
        detachedChunkCount: this.detachedChunkCount,
      };
    }

    // Check if shot passes straight through an already open Voronoi hole
    if (this.stage[hitIdx] === ARMORED_CHUNK_DETACHED && !isBlastOrHeavyBreach) {
      return {
        alreadyBrokenHole: true,
        newlyDetachedIndices: [],
        chunksCrazed: 0,
        survivingChunkCount: this.survivingCount,
        detachedChunkCount: this.detachedChunkCount,
      };
    }

    if (this.stage[hitIdx] === ARMORED_CHUNK_DETACHED && isBlastOrHeavyBreach) {
      let touchesAnySurviving = false;
      for (let i = 0; i < this.chunks.length; i++) {
        if (this.stage[i] === ARMORED_CHUNK_DETACHED) continue;
        if (pointToConvexPolygonDistance2D(this.chunks[i].polygon, hitX, hitY) <= requestedRadiusM) {
          touchesAnySurviving = true;
          break;
        }
      }
      if (!touchesAnySurviving) {
        return {
          alreadyBrokenHole: true,
          newlyDetachedIndices: [],
          chunksCrazed: 0,
          survivingChunkCount: this.survivingCount,
          detachedChunkCount: this.detachedChunkCount,
        };
      }
    }

    this.impactCounter++;
    const rand = createDeterministicPrng(
      options.seed ??
        ((Math.round(hitX * 1000) * 73856093) ^
          (Math.round(hitY * 1000) * 19349663) ^
          (this.impactCounter * 83492791) ^
          Math.round(energyJ * 11)),
    );

    const newlyDetached: number[] = [];
    let chunksCrazed = 0;

    const detachChunk = (idx: number): void => {
      if (idx < 0 || idx >= this.chunks.length) return;
      if (this.stage[idx] === ARMORED_CHUNK_DETACHED) return;
      this.stage[idx] = ARMORED_CHUNK_DETACHED;
      this.integrity[idx] = 0;
      this.crazedIntensity[idx] = 1;
      this.survivingCount--;
      newlyDetached.push(idx);
    };

    const damageChunkLaminate = (
      idx: number,
      damage: number,
      allowDetach: boolean,
      fx: number,
      fy: number,
    ): void => {
      if (idx < 0 || idx >= this.chunks.length || damage <= 0) return;
      const prevStage = this.stage[idx];
      if (prevStage === ARMORED_CHUNK_DETACHED) return;

      const minAllowed = allowDetach ? 0 : 0.14;
      const nextIntegrity = Math.max(minAllowed, this.integrity[idx] - damage);
      this.integrity[idx] = nextIntegrity;
      this.crazedIntensity[idx] = Math.min(1, Math.max(this.crazedIntensity[idx], 1 - nextIntegrity));
      this.focusX[idx] = this.focusX[idx] * 0.45 + fx * 0.55;
      this.focusY[idx] = this.focusY[idx] * 0.45 + fy * 0.55;

      if (nextIntegrity <= 0.001 && allowDetach) {
        detachChunk(idx);
        return;
      }

      const nextStage =
        nextIntegrity <= 0.56
          ? ARMORED_CHUNK_FRACTURED
          : nextIntegrity < 0.96
            ? ARMORED_CHUNK_CRAZED
            : ARMORED_CHUNK_PRISTINE;
      this.stage[idx] = nextStage;
      if (prevStage === ARMORED_CHUNK_PRISTINE && nextStage !== ARMORED_CHUNK_PRISTINE) {
        chunksCrazed++;
      }
    };

    const diagM = Math.hypot(this.widthM, this.heightM);
    const isHighVelocityRifle =
      energyJ >= 1350 || (options.isArmorPiercing === true && energyJ >= 950);

    if (isBlastOrHeavyBreach) {
      // Explosion blast or breaching charge blows out an organic multi-chunk Voronoi breach
      const blastR = Math.max(0.22, requestedRadiusM);
      for (let i = 0; i < this.chunks.length; i++) {
        if (this.stage[i] === ARMORED_CHUNK_DETACHED) continue;
        const dist = pointToConvexPolygonDistance2D(this.chunks[i].polygon, hitX, hitY);
        const jitterR = blastR * (0.86 + rand() * 0.26);
        if (dist <= jitterR) {
          detachChunk(i);
        } else if (dist <= blastR * 1.85) {
          const t = 1 - dist / (blastR * 1.85);
          damageChunkLaminate(i, 0.35 + t * 0.52, false, hitX, hitY);
        }
      }
    } else if (isHighVelocityRifle) {
      const hitInitialStage = this.stage[hitIdx];

      if (hitInitialStage === ARMORED_CHUNK_PRISTINE) {
        // Shot 1 of rifle against pristine ballistic glass:
        // Punch ONLY a tight bullet-core Voronoi perforation right at the bullseye (1..2 core cells)
        // while crazing/fracturing a wide surrounding armored Voronoi halo that stays held in the frame!
        const corePlugRadiusM = 0.022;
        detachChunk(hitIdx);
        for (let k = 0; k < this.chunks[hitIdx].neighbors.length; k++) {
          const nIdx = this.chunks[hitIdx].neighbors[k];
          if (
            this.stage[nIdx] !== ARMORED_CHUNK_DETACHED &&
            pointToConvexPolygonDistance2D(this.chunks[nIdx].polygon, hitX, hitY) <= corePlugRadiusM
          ) {
            detachChunk(nIdx);
          }
        }

        const haloRadiusM = Math.min(
          diagM * 0.38,
          0.34 + Math.min(1, (energyJ - 1350) / 2400) * 0.16,
        );
        for (let i = 0; i < this.chunks.length; i++) {
          if (this.stage[i] === ARMORED_CHUNK_DETACHED) continue;
          const dist = Math.hypot(
            this.chunks[i].centroid.x - hitX,
            this.chunks[i].centroid.y - hitY,
          );
          if (dist <= haloRadiusM) {
            const falloff = 1 - dist / haloRadiusM;
            const dmg = (0.24 + falloff * 0.56) * (0.88 + rand() * 0.24);
            damageChunkLaminate(i, dmg, false, hitX, hitY);
          }
        }
      } else {
        // Follow-up rifle shot into already crazed/fractured ballistic laminate:
        // Weakened polycarbonate interlayer shears loose, knocking out 2..5 thick Voronoi chunks!
        detachChunk(hitIdx);
        const shearRadiusM = Math.min(diagM * 0.24, 0.24 + (energyJ / 3600) * 0.08);
        const outerHaloM = shearRadiusM * 1.9;
        for (let i = 0; i < this.chunks.length; i++) {
          if (this.stage[i] === ARMORED_CHUNK_DETACHED) continue;
          const dist = pointToConvexPolygonDistance2D(this.chunks[i].polygon, hitX, hitY);
          if (dist <= shearRadiusM) {
            const falloff = 1 - dist / shearRadiusM;
            const dmg = 0.52 + falloff * 0.48;
            damageChunkLaminate(i, dmg, true, hitX, hitY);
          } else if (dist <= outerHaloM) {
            const falloff = 1 - dist / outerHaloM;
            damageChunkLaminate(i, 0.22 + falloff * 0.35, false, hitX, hitY);
          }
        }
      }
    } else {
      // Pistol / SMG / Shotgun Pellet (< 1350 J):
      // Shot 1 crazes & spiderweb-cracks the armored Voronoi chunks WITHOUT dropping chunks!
      // Shot 2–3+ shears weakened chunks out of the laminate so real 3D chunks tumble out!
      const energyNorm = Math.min(1, energyJ / 1350);
      const directDamage = 0.40 + energyNorm * 0.32;
      damageChunkLaminate(hitIdx, directDamage, true, hitX, hitY);

      const haloRadiusM = Math.min(diagM * 0.28, 0.22 + energyNorm * 0.14);
      for (let i = 0; i < this.chunks.length; i++) {
        if (i === hitIdx || this.stage[i] === ARMORED_CHUNK_DETACHED) continue;
        const dist = pointToConvexPolygonDistance2D(this.chunks[i].polygon, hitX, hitY);
        if (dist <= haloRadiusM) {
          const falloff = 1 - dist / haloRadiusM;
          const neighborDmg = (0.18 + falloff * (0.22 + energyNorm * 0.18)) * (0.88 + rand() * 0.24);
          // Neighboring already-fractured chunks can detach on repeated concentrated hits
          const canNeighborShear =
            this.stage[i] === ARMORED_CHUNK_FRACTURED && dist <= haloRadiusM * 0.38;
          damageChunkLaminate(i, neighborDmg, canNeighborShear, hitX, hitY);
        }
      }
    }

    // Organic spiderweb stress tendrils propagating 1..2 Voronoi neighbor hops
    const tendrilCount = 3 + Math.floor(rand() * 3);
    for (let t = 0; t < tendrilCount; t++) {
      let cur = hitIdx;
      for (let hop = 0; hop < 2; hop++) {
        const nbrs = this.chunks[cur].neighbors;
        if (nbrs.length === 0) break;
        const next = nbrs[Math.floor(rand() * nbrs.length)];
        damageChunkLaminate(next, 0.18 + rand() * 0.16, false, hitX, hitY);
        cur = next;
      }
    }

    // Frame-anchor connectivity BFS: detach any floating unanchored Voronoi island!
    if (newlyDetached.length > 0 && this.survivingCount > 0) {
      this.bfsVisited.fill(0);
      let head = 0;
      let tail = 0;
      for (let i = 0; i < this.chunks.length; i++) {
        if (this.stage[i] !== ARMORED_CHUNK_DETACHED && this.chunks[i].touchesFrame) {
          this.bfsVisited[i] = 1;
          this.bfsQueue[tail++] = i;
        }
      }
      while (head < tail) {
        const cur = this.bfsQueue[head++];
        const nbrs = this.chunks[cur].neighbors;
        for (let k = 0; k < nbrs.length; k++) {
          const nb = nbrs[k];
          if (this.bfsVisited[nb] === 0 && this.stage[nb] !== ARMORED_CHUNK_DETACHED) {
            this.bfsVisited[nb] = 1;
            this.bfsQueue[tail++] = nb;
          }
        }
      }
      for (let i = 0; i < this.chunks.length; i++) {
        if (this.stage[i] !== ARMORED_CHUNK_DETACHED && this.bfsVisited[i] === 0) {
          detachChunk(i);
        }
      }
    }

    return {
      alreadyBrokenHole: false,
      newlyDetachedIndices: newlyDetached,
      chunksCrazed,
      survivingChunkCount: this.survivingCount,
      detachedChunkCount: this.detachedChunkCount,
    };
  }

  /**
   * Builds the window-centered 3D armored glass mesh into pre-allocated typed arrays:
   * - Window-space `[0, 1]` UVs across the entire pane (zero repeating cell tiles!).
   * - Seamless clear ballistic glass on `PRISTINE` chunks.
   * - Tilted 3D stress sub-facets, internal 3D laminate fracture bevel planes, gleaming hole rims,
   *   and crisp organic Voronoi + radial spiderweb crack strips on `CRAZED` / `FRACTURED` chunks!
   */
  public writeArmoredMeshBuffers(
    outPositions: Float32Array,
    outNormals: Float32Array,
    outUvs: Float32Array,
    outColors: Float32Array,
    outIndices: Uint16Array,
  ): ArmoredMeshBuildStats {
    const maxVerts = Math.min(
      65500,
      Math.floor(outPositions.length / 3),
      Math.floor(outColors.length / 4),
    );
    const maxIndices = outIndices.length;

    const halfW = this.widthM * 0.5;
    const halfH = this.heightM * 0.5;
    const halfZ = this.thicknessM * 0.5;
    const invW = 1 / this.widthM;
    const invH = 1 / this.heightM;
    const frameEps = 1.5e-4;

    let vCursor = 0;
    let iCursor = 0;
    let emittedChunks = 0;

    const pushVert = (
      x2d: number,
      y2d: number,
      vz: number,
      nx: number,
      ny: number,
      nz: number,
      r: number,
      g: number,
      b: number,
      a: number,
    ): number => {
      const idx = vCursor++;
      const p3 = idx * 3;
      const p2 = idx * 2;
      const p4 = idx * 4;
      outPositions[p3] = x2d - halfW;
      outPositions[p3 + 1] = y2d - halfH;
      outPositions[p3 + 2] = vz;
      outNormals[p3] = nx;
      outNormals[p3 + 1] = ny;
      outNormals[p3 + 2] = nz;
      outUvs[p2] = x2d * invW;
      outUvs[p2 + 1] = y2d * invH;
      outColors[p4] = r;
      outColors[p4 + 1] = g;
      outColors[p4 + 2] = b;
      outColors[p4 + 3] = a;
      return idx;
    };

    const emitCrackStrip2D = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      halfWidthM: number,
      alpha: number,
    ): void => {
      if (vCursor + 8 > maxVerts || iCursor + 12 > maxIndices) return;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) return;
      const px = (-dy / len) * halfWidthM;
      const py = (dx / len) * halfWidthM;

      // Front crack strip (+halfZ + 0.00028)
      const zFront = halfZ + 0.00028;
      const f0 = pushVert(ax - px, ay - py, zFront, 0, 0, 1, 0.96, 1.0, 1.0, alpha);
      const f1 = pushVert(bx - px, by - py, zFront, 0, 0, 1, 0.96, 1.0, 1.0, alpha);
      const f2 = pushVert(bx + px, by + py, zFront, 0, 0, 1, 0.96, 1.0, 1.0, alpha);
      const f3 = pushVert(ax + px, ay + py, zFront, 0, 0, 1, 0.96, 1.0, 1.0, alpha);
      outIndices[iCursor++] = f0;
      outIndices[iCursor++] = f1;
      outIndices[iCursor++] = f2;
      outIndices[iCursor++] = f0;
      outIndices[iCursor++] = f2;
      outIndices[iCursor++] = f3;

      // Back crack strip (-halfZ - 0.00028)
      const zBack = -halfZ - 0.00028;
      const b0 = pushVert(ax - px, ay - py, zBack, 0, 0, -1, 0.96, 1.0, 1.0, alpha);
      const b1 = pushVert(bx - px, by - py, zBack, 0, 0, -1, 0.96, 1.0, 1.0, alpha);
      const b2 = pushVert(bx + px, by + py, zBack, 0, 0, -1, 0.96, 1.0, 1.0, alpha);
      const b3 = pushVert(ax + px, ay + py, zBack, 0, 0, -1, 0.96, 1.0, 1.0, alpha);
      outIndices[iCursor++] = b0;
      outIndices[iCursor++] = b2;
      outIndices[iCursor++] = b1;
      outIndices[iCursor++] = b0;
      outIndices[iCursor++] = b3;
      outIndices[iCursor++] = b2;
    };

    const emitEdgeBevelQuad = (
      p0: Point2D,
      p1: Point2D,
      r: number,
      g: number,
      b: number,
      a: number,
    ): void => {
      if (vCursor + 4 > maxVerts || iCursor + 6 > maxIndices) return;
      const edx = p1.x - p0.x;
      const edy = p1.y - p0.y;
      const eLen = Math.hypot(edx, edy);
      if (eLen < 1e-5) return;
      const nx = edy / eLen;
      const ny = -edx / eLen;

      const v0 = pushVert(p0.x, p0.y, halfZ, nx, ny, 0, r, g, b, a);
      const v1 = pushVert(p1.x, p1.y, halfZ, nx, ny, 0, r, g, b, a);
      const v2 = pushVert(p1.x, p1.y, -halfZ, nx, ny, 0, r, g, b, a);
      const v3 = pushVert(p0.x, p0.y, -halfZ, nx, ny, 0, r, g, b, a);

      outIndices[iCursor++] = v0;
      outIndices[iCursor++] = v3;
      outIndices[iCursor++] = v2;
      outIndices[iCursor++] = v0;
      outIndices[iCursor++] = v2;
      outIndices[iCursor++] = v1;
    };

    const findNeighborAcrossEdge = (chunkIdx: number, p0: Point2D, p1: Point2D): number => {
      const nbrs = this.chunks[chunkIdx].neighbors;
      const mx = (p0.x + p1.x) * 0.5;
      const my = (p0.y + p1.y) * 0.5;
      for (let k = 0; k < nbrs.length; k++) {
        const nIdx = nbrs[k];
        const nPoly = this.chunks[nIdx].polygon;
        for (let j = 0; j < nPoly.length; j++) {
          const q0 = nPoly[j];
          const q1 = nPoly[(j + 1) % nPoly.length];
          const qmx = (q0.x + q1.x) * 0.5;
          const qmy = (q0.y + q1.y) * 0.5;
          if (Math.abs(mx - qmx) < 1.5e-3 && Math.abs(my - qmy) < 1.5e-3) {
            return nIdx;
          }
        }
      }
      return -1;
    };

    for (let c = 0; c < this.chunks.length; c++) {
      const st = this.stage[c];
      if (st === ARMORED_CHUNK_DETACHED) continue;

      const chunk = this.chunks[c];
      const poly = chunk.polygon;
      const n = poly.length;
      if (n < 3) continue;
      if (vCursor + n * 16 > maxVerts || iCursor + n * 30 > maxIndices) {
        break;
      }

      emittedChunks++;

      if (st === ARMORED_CHUNK_PRISTINE) {
        // Seamless clear ballistic laminate faces (zero internal seam lines!)
        const fBase = vCursor;
        for (let i = 0; i < n; i++) {
          pushVert(poly[i].x, poly[i].y, halfZ, 0, 0, 1, 0.72, 0.92, 0.91, 0.46);
        }
        for (let i = 1; i < n - 1; i++) {
          outIndices[iCursor++] = fBase;
          outIndices[iCursor++] = fBase + i;
          outIndices[iCursor++] = fBase + i + 1;
        }

        const bBase = vCursor;
        for (let i = 0; i < n; i++) {
          pushVert(poly[i].x, poly[i].y, -halfZ, 0, 0, -1, 0.72, 0.92, 0.91, 0.46);
        }
        for (let i = 1; i < n - 1; i++) {
          outIndices[iCursor++] = bBase;
          outIndices[iCursor++] = bBase + i + 1;
          outIndices[iCursor++] = bBase + i;
        }

        // Only emit outer frame gasket bevels or exposed hole-border rims
        for (let i = 0; i < n; i++) {
          const p0 = poly[i];
          const p1 = poly[(i + 1) % n];
          const onFrame =
            (p0.x <= frameEps && p1.x <= frameEps) ||
            (p0.x >= this.widthM - frameEps && p1.x >= this.widthM - frameEps) ||
            (p0.y <= frameEps && p1.y <= frameEps) ||
            (p0.y >= this.heightM - frameEps && p1.y >= this.heightM - frameEps);
          if (onFrame) {
            emitEdgeBevelQuad(p0, p1, 0.42, 0.62, 0.64, 0.65);
          } else {
            const nbr = findNeighborAcrossEdge(c, p0, p1);
            if (nbr >= 0 && this.stage[nbr] === ARMORED_CHUNK_DETACHED) {
              emitEdgeBevelQuad(p0, p1, 0.96, 1.0, 1.0, 0.94);
            }
          }
        }
      } else {
        // CRAZED or FRACTURED ballistic chunk: tilted 3D stress sub-facets + internal fracture planes + crisp cracks!
        const craze = Math.max(0.25, this.crazedIntensity[c]);
        const isHeavy = st === ARMORED_CHUNK_FRACTURED;

        // Compute safe interior fracture hub biased toward impact focus
        let minInradius = Infinity;
        for (let i = 0; i < n; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % n];
          const edx = b.x - a.x;
          const edy = b.y - a.y;
          const eLen = Math.hypot(edx, edy);
          if (eLen > 1e-6) {
            const distEdge = Math.abs(
              edx * (chunk.centroid.y - a.y) - edy * (chunk.centroid.x - a.x),
            ) / eLen;
            if (distEdge < minInradius) minInradius = distEdge;
          }
        }
        const fdx = this.focusX[c] - chunk.centroid.x;
        const fdy = this.focusY[c] - chunk.centroid.y;
        const fLen = Math.hypot(fdx, fdy);
        const maxShift = Number.isFinite(minInradius) ? minInradius * 0.36 : 0;
        const shiftScale = fLen > 1e-5 ? Math.min(0.32, maxShift / fLen) : 0;
        const hubX = chunk.centroid.x + fdx * shiftScale;
        const hubY = chunk.centroid.y + fdy * shiftScale;

        const hubR = 0.91 + 0.08 * craze;
        const hubG = 0.98 + 0.02 * craze;
        const hubB = 1.0;
        const hubA = (isHeavy ? 0.68 : 0.54) + 0.22 * craze;

        const rimR = 0.80 + 0.14 * craze;
        const rimG = 0.94 + 0.05 * craze;
        const rimB = 0.97 + 0.03 * craze;
        const rimA = (isHeavy ? 0.58 : 0.48) + 0.18 * craze;

        const tiltStrength = (isHeavy ? 0.085 : 0.045) * craze;

        for (let i = 0; i < n; i++) {
          const p0 = poly[i];
          const p1 = poly[(i + 1) % n];

          // Subtle per-subfacet normal perturbation so fractured glass facets catch distinct specular glints
          const phase = (c * 1.73 + i * 2.39);
          const fnx = (this.chunkFacetTiltX[c] * 0.5 + Math.cos(phase) * 0.5) * tiltStrength;
          const fny = (this.chunkFacetTiltY[c] * 0.5 + Math.sin(phase) * 0.5) * tiltStrength;
          const fnz = Math.sqrt(Math.max(0.5, 1 - fnx * fnx - fny * fny));

          // Front sub-facet
          const vf0 = pushVert(hubX, hubY, halfZ, fnx, fny, fnz, hubR, hubG, hubB, hubA);
          const vf1 = pushVert(p0.x, p0.y, halfZ, fnx, fny, fnz, rimR, rimG, rimB, rimA);
          const vf2 = pushVert(p1.x, p1.y, halfZ, fnx, fny, fnz, rimR, rimG, rimB, rimA);
          outIndices[iCursor++] = vf0;
          outIndices[iCursor++] = vf1;
          outIndices[iCursor++] = vf2;

          // Back sub-facet
          const vb0 = pushVert(hubX, hubY, -halfZ, -fnx, -fny, -fnz, hubR, hubG, hubB, hubA);
          const vb1 = pushVert(p1.x, p1.y, -halfZ, -fnx, -fny, -fnz, rimR, rimG, rimB, rimA);
          const vb2 = pushVert(p0.x, p0.y, -halfZ, -fnx, -fny, -fnz, rimR, rimG, rimB, rimA);
          outIndices[iCursor++] = vb0;
          outIndices[iCursor++] = vb1;
          outIndices[iCursor++] = vb2;
        }

        // Perimeter / internal laminate fracture bevels & crisp Voronoi boundary crack lines
        const crackHalfW = isHeavy ? 0.0015 : 0.0010;
        const crackAlpha = (isHeavy ? 0.76 : 0.54) + 0.20 * craze;

        for (let i = 0; i < n; i++) {
          const p0 = poly[i];
          const p1 = poly[(i + 1) % n];
          const onFrame =
            (p0.x <= frameEps && p1.x <= frameEps) ||
            (p0.x >= this.widthM - frameEps && p1.x >= this.widthM - frameEps) ||
            (p0.y <= frameEps && p1.y <= frameEps) ||
            (p0.y >= this.heightM - frameEps && p1.y >= this.heightM - frameEps);

          if (onFrame) {
            emitEdgeBevelQuad(p0, p1, 0.52, 0.72, 0.75, 0.72);
            continue;
          }

          const nbr = findNeighborAcrossEdge(c, p0, p1);
          if (nbr < 0 || this.stage[nbr] === ARMORED_CHUNK_DETACHED) {
            // Exposed jagged Voronoi hole border -> bright crystalline prism rim!
            emitEdgeBevelQuad(p0, p1, 0.97, 1.0, 1.0, 0.96);
            emitCrackStrip2D(p0.x, p0.y, p1.x, p1.y, crackHalfW * 1.15, 0.94);
          } else if (this.stage[nbr] === ARMORED_CHUNK_PRISTINE || c < nbr) {
            // Internal 3D fracture plane inside the ballistic laminate + crisp surface crack seam
            emitEdgeBevelQuad(p0, p1, 0.92, 0.99, 1.0, 0.30 + 0.36 * craze);
            emitCrackStrip2D(p0.x, p0.y, p1.x, p1.y, crackHalfW, crackAlpha);
          }
        }

        // Interior radial starburst spokes & cross-link crack strips on heavily fractured chunks
        if (isHeavy) {
          const spokeStep = n > 6 ? 2 : 1;
          for (let i = 0; i < n; i += spokeStep) {
            const p = poly[i];
            emitCrackStrip2D(hubX, hubY, p.x, p.y, 0.0011, crackAlpha * 0.88);
            const pNext = poly[(i + 1) % n];
            const tA = 0.48 + ((c + i) % 3) * 0.09;
            const tB = 0.54 + ((c + i + 1) % 3) * 0.08;
            emitCrackStrip2D(
              hubX + (p.x - hubX) * tA,
              hubY + (p.y - hubY) * tA,
              hubX + (pNext.x - hubX) * tB,
              hubY + (pNext.y - hubY) * tB,
              0.00085,
              crackAlpha * 0.72,
            );
          }
        } else if (craze > 0.38) {
          // Light crazing emits 2 subtle internal fracture spokes
          const i0 = c % n;
          const i1 = (c + Math.max(1, Math.floor(n / 2))) % n;
          emitCrackStrip2D(hubX, hubY, poly[i0].x, poly[i0].y, 0.0008, crackAlpha * 0.65);
          emitCrackStrip2D(hubX, hubY, poly[i1].x, poly[i1].y, 0.0008, crackAlpha * 0.65);
        }
      }
    }

    return {
      survivingChunks: emittedChunks,
      vertexCount: vCursor,
      indexCount: iCursor,
    };
  }
}

/**
 * Progressive Large-Chunk Plate Glass Model (`ProgressiveVoronoiPane`) for `VoronoiGlassWindow`:
 * - Partitions regular window glass into `~20–24` large, dramatic angular plate wedges & corner fangs.
 * - On initial impact, blasts out a wide central/impact breach of big tumbling slabs while leaving
 *   jagged perimeter/corner glass fangs clinging to the window sash frame!
 * - Follow-up shots through the open breach pass cleanly (`hitOpenBreach: true`), while shots hitting
 *   surviving perimeter fangs knock those large chunks loose into `GlassShardPool`!
 */
export class ProgressiveVoronoiPane {
  public readonly shatter: VoronoiWindowShatterResult;
  public readonly attached: Uint8Array;
  private survivingFangs: number;
  private readonly bfsVisited: Uint8Array;
  private readonly bfsQueue: Int32Array;

  public constructor(shatter: VoronoiWindowShatterResult) {
    this.shatter = shatter;
    const n = shatter.shards.length;
    this.attached = new Uint8Array(n).fill(1);
    this.survivingFangs = n;
    this.bfsVisited = new Uint8Array(n);
    this.bfsQueue = new Int32Array(n);
  }

  public get survivingFangCount(): number {
    return this.survivingFangs;
  }

  /**
   * Computes the initial dramatic breach around `(hitX, hitY)` and detaches unsupported slabs,
   * returning all shard indices that launch immediately into `GlassShardPool`.
   */
  public triggerInitialBreach(energyJ: number): number[] {
    const shards = this.shatter.shards;
    const n = shards.length;
    const detached: number[] = [];

    const detach = (idx: number): void => {
      if (this.attached[idx] === 0) return;
      this.attached[idx] = 0;
      this.survivingFangs--;
      detached.push(idx);
    };

    // Massive blast (>= 3800 J) blows 100% of fangs out of the frame at once
    if (energyJ >= 3800) {
      for (let i = 0; i < n; i++) {
        detach(i);
      }
      return detached;
    }

    const diagM = Math.hypot(this.shatter.widthM, this.shatter.heightM);
    const minDimM = Math.min(this.shatter.widthM, this.shatter.heightM);
    const minGripLengthM = minDimM * 0.11;
    const breachRadiusM = diagM * (0.25 + Math.min(0.07, (energyJ / 3800) * 0.07));

    // Rank frame-anchored shards outside the direct impact core so 4..7 dramatic perimeter/corner fangs cling!
    const fangCandidates: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = shards[i];
      const hitDirectly = isPointInConvexPolygon2D(
        s.polygon,
        this.shatter.hitX,
        this.shatter.hitY,
        1e-4,
      );
      if (
        !hitDirectly &&
        s.touchesFrame &&
        s.frameContactLengthM >= minGripLengthM &&
        s.radialDistanceM > diagM * 0.20
      ) {
        fangCandidates.push(i);
      }
    }

    fangCandidates.sort((a, b) => {
      const scoreA = shards[a].radialDistanceM + shards[a].frameContactLengthM * 0.45;
      const scoreB = shards[b].radialDistanceM + shards[b].frameContactLengthM * 0.45;
      return scoreB - scoreA;
    });

    const targetClingingFangs = Math.min(
      fangCandidates.length,
      Math.max(4, Math.min(7, Math.round(n * 0.28))),
    );
    const protectedFangs = new Set<number>();
    for (let k = 0; k < fangCandidates.length; k++) {
      const idx = fangCandidates[k];
      if (shards[idx].radialDistanceM > breachRadiusM || protectedFangs.size < targetClingingFangs) {
        if (protectedFangs.size < 7) {
          protectedFangs.add(idx);
        }
      }
    }

    for (let i = 0; i < n; i++) {
      if (!protectedFangs.has(i)) {
        detach(i);
      }
    }

    // Ensure at least ~55% of shards (>= 9) burst out on Shot 1 for a wide dramatic breach
    const minDetachedTarget = Math.min(n, Math.max(9, Math.ceil(n * 0.58)));
    if (detached.length < minDetachedTarget) {
      const remainingByDist: number[] = [];
      for (let i = 0; i < n; i++) {
        if (this.attached[i] === 1) remainingByDist.push(i);
      }
      remainingByDist.sort(
        (a, b) => shards[a].radialDistanceM - shards[b].radialDistanceM,
      );
      for (let k = 0; k < remainingByDist.length && detached.length < minDetachedTarget; k++) {
        detach(remainingByDist[k]);
      }
    }

    this.pruneUnanchoredFangs(detached);
    return detached;
  }

  /**
   * Tests a follow-up impact at `(hitX, hitY)` against surviving frame-clinging fangs.
   */
  public strikeClingingFangs(
    hitX: number,
    hitY: number,
    energyJ: number,
    radiusM = 0.03,
  ): ProgressiveVoronoiHitReport {
    if (this.survivingFangs === 0) {
      return {
        hitOpenBreach: true,
        newlyDetachedIndices: [],
        survivingFangCount: 0,
      };
    }

    const shards = this.shatter.shards;
    const isBlast = energyJ >= 3800 || radiusM >= 0.25;
    let directFang = -1;

    for (let i = 0; i < shards.length; i++) {
      if (this.attached[i] === 0) continue;
      if (isPointInConvexPolygon2D(shards[i].polygon, hitX, hitY, 1e-4)) {
        directFang = i;
        break;
      }
    }

    if (directFang < 0 && !isBlast) {
      return {
        hitOpenBreach: true,
        newlyDetachedIndices: [],
        survivingFangCount: this.survivingFangs,
      };
    }

    const detached: number[] = [];
    const detach = (idx: number): void => {
      if (this.attached[idx] === 0) return;
      this.attached[idx] = 0;
      this.survivingFangs--;
      detached.push(idx);
    };

    if (isBlast) {
      const blastR = Math.max(radiusM, 0.35);
      for (let i = 0; i < shards.length; i++) {
        if (this.attached[i] === 0) continue;
        if (
          energyJ >= 3800 ||
          pointToConvexPolygonDistance2D(shards[i].polygon, hitX, hitY) <= blastR
        ) {
          detach(i);
        }
      }
    } else if (directFang >= 0) {
      detach(directFang);
      const knockNeighborR = Math.hypot(this.shatter.widthM, this.shatter.heightM) * 0.20;
      const nbrs = shards[directFang].neighbors;
      for (let k = 0; k < nbrs.length; k++) {
        const nb = nbrs[k];
        if (
          this.attached[nb] === 1 &&
          pointToConvexPolygonDistance2D(shards[nb].polygon, hitX, hitY) <= knockNeighborR
        ) {
          detach(nb);
        }
      }
    }

    if (detached.length === 0) {
      return {
        hitOpenBreach: true,
        newlyDetachedIndices: [],
        survivingFangCount: this.survivingFangs,
      };
    }

    this.pruneUnanchoredFangs(detached);
    return {
      hitOpenBreach: false,
      newlyDetachedIndices: detached,
      survivingFangCount: this.survivingFangs,
    };
  }

  /**
   * Emits surviving frame-clinging fangs in window-local coordinates (`[-widthM/2..+widthM/2]`)
   * with `[0, 1]` window-space UVs and gleaming frosted inner fracture rims.
   */
  public writeClingingFangsMeshBuffers(
    outPositions: Float32Array,
    outNormals: Float32Array,
    outUvs: Float32Array,
    outColors: Float32Array,
    outIndices: Uint16Array,
  ): { fangCount: number; vertexCount: number; indexCount: number } {
    const maxVerts = Math.min(65500, Math.floor(outPositions.length / 3));
    const maxIndices = outIndices.length;
    const halfW = this.shatter.widthM * 0.5;
    const halfH = this.shatter.heightM * 0.5;

    let vCursor = 0;
    let iCursor = 0;
    let fangCount = 0;

    for (let s = 0; s < this.shatter.shards.length; s++) {
      if (this.attached[s] === 0) continue;
      const shard = this.shatter.shards[s];
      const ext = shard.extruded;
      if (
        ext.vertexCount === 0 ||
        vCursor + ext.vertexCount > maxVerts ||
        iCursor + ext.indexCount > maxIndices
      ) {
        continue;
      }

      const offX = shard.centroid.x - halfW;
      const offY = shard.centroid.y - halfH;

      for (let v = 0; v < ext.vertexCount; v++) {
        const sp3 = v * 3;
        const sp2 = v * 2;
        const dp3 = (vCursor + v) * 3;
        const dp2 = (vCursor + v) * 2;
        const dp4 = (vCursor + v) * 4;

        outPositions[dp3] = ext.localPositions[sp3] + offX;
        outPositions[dp3 + 1] = ext.localPositions[sp3 + 1] + offY;
        outPositions[dp3 + 2] = ext.localPositions[sp3 + 2];

        const lnx = ext.localNormals[sp3];
        const lny = ext.localNormals[sp3 + 1];
        const lnz = ext.localNormals[sp3 + 2];
        outNormals[dp3] = lnx;
        outNormals[dp3 + 1] = lny;
        outNormals[dp3 + 2] = lnz;

        outUvs[dp2] = ext.localUvs[sp2];
        outUvs[dp2 + 1] = ext.localUvs[sp2 + 1];

        const isRim = Math.abs(lnz) < 0.5;
        outColors[dp4] = isRim ? 0.96 : 0.74;
        outColors[dp4 + 1] = isRim ? 1.0 : 0.92;
        outColors[dp4 + 2] = 1.0;
        outColors[dp4 + 3] = isRim ? 0.94 : 0.44;
      }

      for (let k = 0; k < ext.indexCount; k++) {
        outIndices[iCursor + k] = vCursor + ext.localIndices[k];
      }

      vCursor += ext.vertexCount;
      iCursor += ext.indexCount;
      fangCount++;
    }

    return {
      fangCount,
      vertexCount: vCursor,
      indexCount: iCursor,
    };
  }

  private pruneUnanchoredFangs(detachedOut: number[]): void {
    const shards = this.shatter.shards;
    const n = shards.length;
    this.bfsVisited.fill(0);
    let head = 0;
    let tail = 0;

    for (let i = 0; i < n; i++) {
      if (this.attached[i] === 1 && shards[i].touchesFrame) {
        this.bfsVisited[i] = 1;
        this.bfsQueue[tail++] = i;
      }
    }
    while (head < tail) {
      const cur = this.bfsQueue[head++];
      const nbrs = shards[cur].neighbors;
      for (let k = 0; k < nbrs.length; k++) {
        const nb = nbrs[k];
        if (this.attached[nb] === 1 && this.bfsVisited[nb] === 0) {
          this.bfsVisited[nb] = 1;
          this.bfsQueue[tail++] = nb;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (this.attached[i] === 1 && this.bfsVisited[i] === 0) {
        this.attached[i] = 0;
        this.survivingFangs--;
        detachedOut.push(i);
      }
    }
  }
}

function rotateVec3ByQuatOut(
  vx: number,
  vy: number,
  vz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: Vec3Like,
): void {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
}

/**
 * Flat TypedArray / Struct-of-Arrays Custom JS Ballistic/Verlet Glass Shard Simulator.
 *
 * Supports **500+ concurrent extruded Voronoi shards** (both clear architectural plates and thick
 * frosted ballistic laminate chunks) at zero WASM solver cost:
 * - Radial outward + bullet-forward ballistic launch velocity
 * - Rapid 3D angular spin (`angVelX/Y/Z`)
 * - Gravity `-9.81 m/s^2`
 * - `y = 0.008` floor-plane bounce with restitution `0.28` + planar friction + settle-flat damping
 * - Smooth fade/shrink cleanup & O(1) swap-with-last recycling
 * - Direct zero-allocation transformation into dynamic batched `pc.Mesh` buffers!
 */
export class GlassShardPool {
  public readonly maxShards: number;
  public readonly maxVertsPerShard: number;
  public readonly maxIndicesPerShard: number;
  public readonly floorY: number;
  public readonly restitution: number;
  public readonly gravityY: number;

  // Exposed SoA state arrays for fast inspection & zero-alloc simulation
  public readonly posX: Float32Array;
  public readonly posY: Float32Array;
  public readonly posZ: Float32Array;

  public readonly prevPosX: Float32Array;
  public readonly prevPosY: Float32Array;
  public readonly prevPosZ: Float32Array;

  public readonly velX: Float32Array;
  public readonly velY: Float32Array;
  public readonly velZ: Float32Array;

  public readonly quatX: Float32Array;
  public readonly quatY: Float32Array;
  public readonly quatZ: Float32Array;
  public readonly quatW: Float32Array;

  public readonly angVelX: Float32Array;
  public readonly angVelY: Float32Array;
  public readonly angVelZ: Float32Array;

  public readonly ageS: Float32Array;
  public readonly ttlS: Float32Array;
  public readonly fadeScale: Float32Array;
  public readonly settled: Uint8Array;
  public readonly shardStyle: Uint8Array;

  // Flat local-mesh template storage per dense shard slot
  private readonly shardVertCount: Uint16Array;
  private readonly shardIndexCount: Uint16Array;
  private readonly localPosArena: Float32Array;
  private readonly localNormArena: Float32Array;
  private readonly localUvArena: Float32Array;
  private readonly localIdxArena: Uint16Array;

  private count = 0;
  private meshDirty = false;
  private readonly scratchVec: Vec3Like = { x: 0, y: 0, z: 0 };

  public constructor(
    maxShards = 640,
    floorY = DEFAULT_SHARD_FLOOR_Y,
    restitution = DEFAULT_SHARD_RESTITUTION,
    gravityY = DEFAULT_SHARD_GRAVITY_Y,
    maxPolygonSides = 16,
  ) {
    const cap = Math.max(16, Math.floor(maxShards));
    const maxSides = Math.max(4, Math.floor(maxPolygonSides));
    this.maxShards = cap;
    this.maxVertsPerShard = 6 * maxSides;
    this.maxIndicesPerShard = 12 * maxSides - 12;
    this.floorY = floorY;
    this.restitution = Math.max(0, Math.min(0.95, restitution));
    this.gravityY = gravityY;

    this.posX = new Float32Array(cap);
    this.posY = new Float32Array(cap);
    this.posZ = new Float32Array(cap);

    this.prevPosX = new Float32Array(cap);
    this.prevPosY = new Float32Array(cap);
    this.prevPosZ = new Float32Array(cap);

    this.velX = new Float32Array(cap);
    this.velY = new Float32Array(cap);
    this.velZ = new Float32Array(cap);

    this.quatX = new Float32Array(cap);
    this.quatY = new Float32Array(cap);
    this.quatZ = new Float32Array(cap);
    this.quatW = new Float32Array(cap);

    this.angVelX = new Float32Array(cap);
    this.angVelY = new Float32Array(cap);
    this.angVelZ = new Float32Array(cap);

    this.ageS = new Float32Array(cap);
    this.ttlS = new Float32Array(cap);
    this.fadeScale = new Float32Array(cap);
    this.settled = new Uint8Array(cap);
    this.shardStyle = new Uint8Array(cap);

    this.shardVertCount = new Uint16Array(cap);
    this.shardIndexCount = new Uint16Array(cap);
    this.localPosArena = new Float32Array(cap * this.maxVertsPerShard * 3);
    this.localNormArena = new Float32Array(cap * this.maxVertsPerShard * 3);
    this.localUvArena = new Float32Array(cap * this.maxVertsPerShard * 2);
    this.localIdxArena = new Uint16Array(cap * this.maxIndicesPerShard);
  }

  public get activeCount(): number {
    return this.count;
  }

  public get dirty(): boolean {
    return this.meshDirty;
  }

  public clearDirty(): void {
    this.meshDirty = false;
  }

  public clear(): void {
    this.count = 0;
    this.meshDirty = true;
  }

  /**
   * Spawns a single shard into the pool (recycling the oldest active shard if at capacity).
   */
  public spawnShard(
    pos: Vec3Like,
    vel: Vec3Like,
    angVel: Vec3Like,
    quat: QuatLike = IDENTITY_QUAT,
    extruded?: ExtrudedGlassShardGeometry,
    ttlSeconds = 3.8,
    style = GLASS_SHARD_STYLE_CLEAR,
  ): number {
    let slot: number;
    if (this.count < this.maxShards) {
      slot = this.count++;
    } else {
      slot = this.findOldestSlotIndex();
    }

    const startY = Math.max(this.floorY, pos.y);
    this.posX[slot] = pos.x;
    this.posY[slot] = startY;
    this.posZ[slot] = pos.z;

    this.prevPosX[slot] = pos.x - vel.x * (1 / 60);
    this.prevPosY[slot] = startY - vel.y * (1 / 60);
    this.prevPosZ[slot] = pos.z - vel.z * (1 / 60);

    this.velX[slot] = vel.x;
    this.velY[slot] = vel.y;
    this.velZ[slot] = vel.z;

    const qLen = Math.hypot(quat.x, quat.y, quat.z, quat.w);
    if (qLen > 1e-6) {
      const invQ = 1 / qLen;
      this.quatX[slot] = quat.x * invQ;
      this.quatY[slot] = quat.y * invQ;
      this.quatZ[slot] = quat.z * invQ;
      this.quatW[slot] = quat.w * invQ;
    } else {
      this.quatX[slot] = 0;
      this.quatY[slot] = 0;
      this.quatZ[slot] = 0;
      this.quatW[slot] = 1;
    }

    this.angVelX[slot] = angVel.x;
    this.angVelY[slot] = angVel.y;
    this.angVelZ[slot] = angVel.z;

    this.ageS[slot] = 0;
    this.ttlS[slot] = Math.max(0.1, ttlSeconds);
    this.fadeScale[slot] = 1;
    this.settled[slot] = 0;
    this.shardStyle[slot] = style;

    if (
      extruded &&
      extruded.vertexCount > 0 &&
      extruded.vertexCount <= this.maxVertsPerShard &&
      extruded.indexCount <= this.maxIndicesPerShard
    ) {
      const vCount = extruded.vertexCount;
      const iCount = extruded.indexCount;
      this.shardVertCount[slot] = vCount;
      this.shardIndexCount[slot] = iCount;

      const vBase3 = slot * this.maxVertsPerShard * 3;
      const vBase2 = slot * this.maxVertsPerShard * 2;
      const iBase = slot * this.maxIndicesPerShard;

      this.localPosArena.set(extruded.localPositions.subarray(0, vCount * 3), vBase3);
      this.localNormArena.set(extruded.localNormals.subarray(0, vCount * 3), vBase3);
      this.localUvArena.set(extruded.localUvs.subarray(0, vCount * 2), vBase2);
      this.localIdxArena.set(extruded.localIndices.subarray(0, iCount), iBase);
    } else {
      this.shardVertCount[slot] = 0;
      this.shardIndexCount[slot] = 0;
    }

    this.meshDirty = true;
    return slot;
  }

  /**
   * Spawns a specific subset of Voronoi shard indices (or all shards) with radial outward +
   * bullet-forward ballistic velocities and rapid 3D crystalline spin.
   */
  public spawnShardsSubset(
    shatter: VoronoiWindowShatterResult,
    shardIndices: readonly number[],
    transform: SpawnVoronoiShardsTransform,
  ): number {
    if (shardIndices.length === 0) return 0;

    const rot = transform.windowRotationQuat ?? IDENTITY_QUAT;
    const baseTtl = transform.ttlSeconds ?? 3.8;
    const style = transform.shardStyle ?? GLASS_SHARD_STYLE_CLEAR;
    const originX = transform.impactOrigin2D ? transform.impactOrigin2D.x : shatter.hitX;
    const originY = transform.impactOrigin2D ? transform.impactOrigin2D.y : shatter.hitY;

    const rand = createDeterministicPrng(
      transform.seed ??
        ((Math.round(originX * 997) ^ Math.round(originY * 991)) +
          this.count * 31),
    );

    const dirLen = Math.hypot(
      transform.impactDirectionWorld.x,
      transform.impactDirectionWorld.y,
      transform.impactDirectionWorld.z,
    );
    const fwdX = dirLen > 1e-6 ? transform.impactDirectionWorld.x / dirLen : 0;
    const fwdY = dirLen > 1e-6 ? transform.impactDirectionWorld.y / dirLen : 0;
    const fwdZ = dirLen > 1e-6 ? transform.impactDirectionWorld.z / dirLen : -1;

    const massDamp = style === GLASS_SHARD_STYLE_ARMORED ? 0.78 : 1.0;
    const energyScale =
      Math.min(2.2, 0.55 + Math.sqrt(Math.max(10, transform.impactEnergyJ)) * 0.032) *
      massDamp;
    const halfW = shatter.widthM * 0.5;
    const halfH = shatter.heightM * 0.5;
    const diag = Math.hypot(shatter.widthM, shatter.heightM);

    let spawned = 0;
    for (let k = 0; k < shardIndices.length; k++) {
      const idx = shardIndices[k];
      if (idx < 0 || idx >= shatter.shards.length) continue;
      const shard = shatter.shards[idx];

      const localOffsetX = shard.centroid.x - halfW;
      const localOffsetY = shard.centroid.y - halfH;
      rotateVec3ByQuatOut(
        localOffsetX,
        localOffsetY,
        0,
        rot.x,
        rot.y,
        rot.z,
        rot.w,
        this.scratchVec,
      );

      const worldPos: Vec3Like = {
        x: transform.windowCenterWorld.x + this.scratchVec.x,
        y: transform.windowCenterWorld.y + this.scratchVec.y,
        z: transform.windowCenterWorld.z + this.scratchVec.z,
      };

      const rdx = shard.centroid.x - originX;
      const rdy = shard.centroid.y - originY;
      const rLen = Math.hypot(rdx, rdy);
      const rnx = rLen > 1e-5 ? rdx / rLen : rand() - 0.5;
      const rny = rLen > 1e-5 ? rdy / rLen : rand() - 0.5;

      rotateVec3ByQuatOut(
        rnx,
        rny,
        0,
        rot.x,
        rot.y,
        rot.z,
        rot.w,
        this.scratchVec,
      );

      const proximity = 1 / (1 + (rLen / Math.max(0.2, diag)) * 4.2);
      const forwardSpeed = (1.1 + proximity * 4.4) * energyScale * (0.8 + rand() * 0.45);
      const radialSpeed = (0.55 + proximity * 2.3) * energyScale * (0.75 + rand() * 0.5);

      const vel: Vec3Like = {
        x: fwdX * forwardSpeed + this.scratchVec.x * radialSpeed + (rand() - 0.5) * 0.45,
        y: fwdY * forwardSpeed + this.scratchVec.y * radialSpeed + (0.25 + rand() * 0.65),
        z: fwdZ * forwardSpeed + this.scratchVec.z * radialSpeed + (rand() - 0.5) * 0.45,
      };

      const spinRate = (5.2 + proximity * 14.0) * massDamp * (0.7 + rand() * 0.65);
      const angVel: Vec3Like = {
        x: (-rny + (rand() - 0.5) * 0.8) * spinRate,
        y: (rnx + (rand() - 0.5) * 0.8) * spinRate,
        z: (rand() - 0.5) * spinRate * 0.85,
      };

      const ttlJitter = baseTtl * (0.85 + rand() * 0.35);
      this.spawnShard(worldPos, vel, angVel, rot, shard.extruded, ttlJitter, style);
      spawned++;
    }

    return spawned;
  }

  /**
   * Spawns all Voronoi cells of a shattered window into the pool with radial outward +
   * bullet-forward ballistic velocities and rapid 3D crystalline spin.
   */
  public spawnWindowShatter(
    shatter: VoronoiWindowShatterResult,
    transform: SpawnVoronoiShardsTransform,
  ): number {
    const allIndices: number[] = new Array<number>(shatter.shards.length);
    for (let i = 0; i < shatter.shards.length; i++) {
      allIndices[i] = i;
    }
    return this.spawnShardsSubset(shatter, allIndices, transform);
  }

  /**
   * Kicks nearby active/settled shards when a blast shockwave detonates nearby.
   */
  public applyBlast(blast: BlastEvent): number {
    if (blast.radiusM <= 0 || blast.peakImpulseNs <= 0) {
      return 0;
    }
    const rSq = blast.radiusM * blast.radiusM;
    let affected = 0;

    for (let i = 0; i < this.count; i++) {
      const dx = this.posX[i] - blast.centerWorld.x;
      const dy = this.posY[i] - blast.centerWorld.y;
      const dz = this.posZ[i] - blast.centerWorld.z;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > rSq) continue;

      const dist = Math.sqrt(dSq);
      const falloff = Math.max(0, 1 - dist / blast.radiusM);
      const dv = Math.min(14, blast.peakImpulseNs * falloff * 0.35);
      const invD = dist > 1e-4 ? 1 / dist : 0;

      this.velX[i] += dx * invD * dv;
      this.velY[i] += (dy * invD + 0.45) * dv;
      this.velZ[i] += dz * invD * dv;
      this.angVelX[i] += -dz * invD * dv * 2.2;
      this.angVelZ[i] += dx * invD * dv * 2.2;
      this.settled[i] = 0;
      affected++;
    }

    if (affected > 0) {
      this.meshDirty = true;
    }
    return affected;
  }

  /**
   * Advances all active shards by `dt` seconds using zero-allocation Struct-of-Arrays
   * Verlet/ballistic integration, `y = 0.008` floor bounce (`restitution = 0.28`),
   * planar friction, settle-flat damping, and smooth fade/shrink expiry.
   */
  public step(dt: number): void {
    if (dt <= 0 || !Number.isFinite(dt) || this.count === 0) {
      return;
    }

    const stepDt = Math.min(dt, 1 / 10);
    const halfDt = 0.5 * stepDt;
    const airDrag = Math.max(0, 1 - 0.35 * stepDt);
    const floorY = this.floorY;
    const restitution = this.restitution;
    const gravityDv = this.gravityY * stepDt;

    for (let i = this.count - 1; i >= 0; i--) {
      const nextAge = this.ageS[i] + stepDt;
      const ttl = this.ttlS[i];
      if (nextAge >= ttl) {
        this.removeAtSwapLast(i);
        continue;
      }
      this.ageS[i] = nextAge;

      const fadeWindow = Math.min(0.55, ttl * 0.22);
      const remaining = ttl - nextAge;
      const nextFade =
        fadeWindow > 1e-4 && remaining < fadeWindow
          ? Math.max(0, remaining / fadeWindow)
          : 1;
      if (nextFade !== this.fadeScale[i]) {
        this.fadeScale[i] = nextFade;
        this.meshDirty = true;
      }

      if (this.settled[i] === 1) {
        continue;
      }

      let vx = this.velX[i] * airDrag;
      let vy = this.velY[i] + gravityDv;
      let vz = this.velZ[i] * airDrag;

      const oldX = this.posX[i];
      const oldY = this.posY[i];
      const oldZ = this.posZ[i];
      this.prevPosX[i] = oldX;
      this.prevPosY[i] = oldY;
      this.prevPosZ[i] = oldZ;

      const px = oldX + vx * stepDt;
      let py = oldY + vy * stepDt;
      const pz = oldZ + vz * stepDt;

      let wx = this.angVelX[i];
      let wy = this.angVelY[i];
      let wz = this.angVelZ[i];

      let qx = this.quatX[i];
      let qy = this.quatY[i];
      let qz = this.quatZ[i];
      let qw = this.quatW[i];

      if (py <= floorY) {
        py = floorY;
        if (vy < 0) {
          const bouncedVy = -vy * restitution;
          vy = bouncedVy < 0.14 ? 0 : bouncedVy;
          vx *= 0.68;
          vz *= 0.68;
          wx *= 0.56;
          wy *= 0.56;
          wz *= 0.56;
        } else {
          vy = 0;
          const slideDrag = Math.max(0, 1 - 8.0 * stepDt);
          vx *= slideDrag;
          vz *= slideDrag;
          const spinDrag = Math.max(0, 1 - 10.0 * stepDt);
          wx *= spinDrag;
          wy *= spinDrag;
          wz *= spinDrag;
        }

        const zx = 2 * (qx * qz + qw * qy);
        const zy = 1 - 2 * (qx * qx + qy * qy);
        const zz = 2 * (qy * qz - qw * qx);
        const signY = zy >= 0 ? 1 : -1;
        const flatStiffness = 18.0 * stepDt;
        wx += -zz * signY * flatStiffness;
        wz += zx * signY * flatStiffness;

        const linSq = vx * vx + vy * vy + vz * vz;
        const angSq = wx * wx + wy * wy + wz * wz;
        if (linSq < 1e-4 && angSq < 2e-3 && Math.abs(zy) > 0.985) {
          vx = 0;
          vy = 0;
          vz = 0;
          wx = 0;
          wy = 0;
          wz = 0;
          this.settled[i] = 1;
        }
      }

      this.posX[i] = px;
      this.posY[i] = py;
      this.posZ[i] = pz;

      this.velX[i] = vx;
      this.velY[i] = vy;
      this.velZ[i] = vz;

      this.angVelX[i] = wx;
      this.angVelY[i] = wy;
      this.angVelZ[i] = wz;

      const spinSq = wx * wx + wy * wy + wz * wz;
      if (spinSq > 1e-9) {
        const dqx = (wx * qw + wy * qz - wz * qy) * halfDt;
        const dqy = (wy * qw + wz * qx - wx * qz) * halfDt;
        const dqz = (wz * qw + wx * qy - wy * qx) * halfDt;
        const dqw = (-wx * qx - wy * qy - wz * qz) * halfDt;

        qx += dqx;
        qy += dqy;
        qz += dqz;
        qw += dqw;

        const invQ = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
        this.quatX[i] = qx * invQ;
        this.quatY[i] = qy * invQ;
        this.quatZ[i] = qz * invQ;
        this.quatW[i] = qw * invQ;
      }

      this.meshDirty = true;
    }
  }

  /**
   * Transforms all active shards' extruded prisms into caller-supplied world-space
   * dynamic `pc.Mesh` vertex/index buffers in a single tight zero-allocation pass.
   */
  public writeBatchedMeshBuffers(
    outPositions: Float32Array,
    outNormals: Float32Array,
    outUvs: Float32Array,
    outIndices: Uint32Array,
    outColors?: Float32Array,
  ): GlassShardBatchedMeshStats {
    const maxVerticesFit = Math.floor(outPositions.length / 3);
    const maxIndicesFit = outIndices.length;

    let vCursor = 0;
    let iCursor = 0;
    let emittedShards = 0;

    for (let s = 0; s < this.count; s++) {
      const vCount = this.shardVertCount[s];
      const idxCount = this.shardIndexCount[s];
      if (vCount === 0 || idxCount === 0) continue;
      if (vCursor + vCount > maxVerticesFit || iCursor + idxCount > maxIndicesFit) {
        break;
      }

      const tx = this.posX[s];
      const ty = this.posY[s];
      const tz = this.posZ[s];

      const qx = this.quatX[s];
      const qy = this.quatY[s];
      const qz = this.quatZ[s];
      const qw = this.quatW[s];
      const scale = this.fadeScale[s];
      const isArmoredChunk = this.shardStyle[s] === GLASS_SHARD_STYLE_ARMORED;

      const x2 = qx + qx;
      const y2 = qy + qy;
      const z2 = qz + qz;
      const xx = qx * x2;
      const xy = qx * y2;
      const xz = qx * z2;
      const yy = qy * y2;
      const yz = qy * z2;
      const zz = qz * z2;
      const wx = qw * x2;
      const wy = qw * y2;
      const wz = qw * z2;

      const r00 = 1 - (yy + zz);
      const r10 = xy + wz;
      const r20 = xz - wy;

      const r01 = xy - wz;
      const r11 = 1 - (xx + zz);
      const r21 = yz + wx;

      const r02 = xz + wy;
      const r12 = yz - wx;
      const r22 = 1 - (xx + yy);

      const m00 = r00 * scale;
      const m10 = r10 * scale;
      const m20 = r20 * scale;
      const m01 = r01 * scale;
      const m11 = r11 * scale;
      const m21 = r21 * scale;
      const m02 = r02 * scale;
      const m12 = r12 * scale;
      const m22 = r22 * scale;

      const srcPosBase = s * this.maxVertsPerShard * 3;
      const srcUvBase = s * this.maxVertsPerShard * 2;
      const srcIdxBase = s * this.maxIndicesPerShard;

      for (let v = 0; v < vCount; v++) {
        const sp3 = srcPosBase + v * 3;
        const lx = this.localPosArena[sp3];
        const ly = this.localPosArena[sp3 + 1];
        const lz = this.localPosArena[sp3 + 2];

        const lnx = this.localNormArena[sp3];
        const lny = this.localNormArena[sp3 + 1];
        const lnz = this.localNormArena[sp3 + 2];

        const dp3 = (vCursor + v) * 3;
        outPositions[dp3] = m00 * lx + m01 * ly + m02 * lz + tx;
        outPositions[dp3 + 1] = m10 * lx + m11 * ly + m12 * lz + ty;
        outPositions[dp3 + 2] = m20 * lx + m21 * ly + m22 * lz + tz;

        outNormals[dp3] = r00 * lnx + r01 * lny + r02 * lnz;
        outNormals[dp3 + 1] = r10 * lnx + r11 * lny + r12 * lnz;
        outNormals[dp3 + 2] = r20 * lnx + r21 * lny + r22 * lnz;

        const sp2 = srcUvBase + v * 2;
        const dp2 = (vCursor + v) * 2;
        outUvs[dp2] = this.localUvArena[sp2];
        outUvs[dp2 + 1] = this.localUvArena[sp2 + 1];

        if (outColors) {
          const dc4 = (vCursor + v) * 4;
          const isRim = Math.abs(lnz) < 0.5;
          if (isArmoredChunk) {
            outColors[dc4] = isRim ? 0.96 : 0.86;
            outColors[dc4 + 1] = isRim ? 1.0 : 0.97;
            outColors[dc4 + 2] = 1.0;
            outColors[dc4 + 3] = (isRim ? 0.96 : 0.74) * scale;
          } else {
            outColors[dc4] = isRim ? 0.95 : 0.74;
            outColors[dc4 + 1] = isRim ? 0.99 : 0.91;
            outColors[dc4 + 2] = 1.0;
            outColors[dc4 + 3] = (isRim ? 0.93 : 0.52) * scale;
          }
        }
      }

      for (let k = 0; k < idxCount; k++) {
        outIndices[iCursor + k] = vCursor + this.localIdxArena[srcIdxBase + k];
      }

      vCursor += vCount;
      iCursor += idxCount;
      emittedShards++;
    }

    return {
      activeShards: emittedShards,
      vertexCount: vCursor,
      indexCount: iCursor,
    };
  }

  private removeAtSwapLast(index: number): void {
    const last = this.count - 1;
    if (index !== last) {
      this.posX[index] = this.posX[last];
      this.posY[index] = this.posY[last];
      this.posZ[index] = this.posZ[last];

      this.prevPosX[index] = this.prevPosX[last];
      this.prevPosY[index] = this.prevPosY[last];
      this.prevPosZ[index] = this.prevPosZ[last];

      this.velX[index] = this.velX[last];
      this.velY[index] = this.velY[last];
      this.velZ[index] = this.velZ[last];

      this.quatX[index] = this.quatX[last];
      this.quatY[index] = this.quatY[last];
      this.quatZ[index] = this.quatZ[last];
      this.quatW[index] = this.quatW[last];

      this.angVelX[index] = this.angVelX[last];
      this.angVelY[index] = this.angVelY[last];
      this.angVelZ[index] = this.angVelZ[last];

      this.ageS[index] = this.ageS[last];
      this.ttlS[index] = this.ttlS[last];
      this.fadeScale[index] = this.fadeScale[last];
      this.settled[index] = this.settled[last];
      this.shardStyle[index] = this.shardStyle[last];

      const vCount = this.shardVertCount[last];
      const iCount = this.shardIndexCount[last];
      this.shardVertCount[index] = vCount;
      this.shardIndexCount[index] = iCount;

      if (vCount > 0) {
        const dstV3 = index * this.maxVertsPerShard * 3;
        const srcV3 = last * this.maxVertsPerShard * 3;
        this.localPosArena.copyWithin(dstV3, srcV3, srcV3 + vCount * 3);
        this.localNormArena.copyWithin(dstV3, srcV3, srcV3 + vCount * 3);

        const dstV2 = index * this.maxVertsPerShard * 2;
        const srcV2 = last * this.maxVertsPerShard * 2;
        this.localUvArena.copyWithin(dstV2, srcV2, srcV2 + vCount * 2);
      }
      if (iCount > 0) {
        const dstI = index * this.maxIndicesPerShard;
        const srcI = last * this.maxIndicesPerShard;
        this.localIdxArena.copyWithin(dstI, srcI, srcI + iCount);
      }
    }

    this.count = last;
    this.meshDirty = true;
  }

  private findOldestSlotIndex(): number {
    let oldestIdx = 0;
    let smallestRem = Infinity;
    for (let i = 0; i < this.count; i++) {
      const rem = this.ttlS[i] - this.ageS[i];
      if (rem < smallestRem) {
        smallestRem = rem;
        oldestIdx = i;
      }
    }
    return oldestIdx;
  }
}
