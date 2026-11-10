import Delaunator from 'delaunator';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { BlastEvent, QuatLike } from '../../contracts/destruction.ts';
import { createDeterministicPrng } from './glassMarchingTiles.ts';

/**
 * Method B — Runtime `delaunator` 2D Voronoi Shatter + Custom JS Floor-Bounce Loop (Pure TS).
 *
 * Architecture Rule: Zero `pc.Entity` per glass shard and zero WASM rigid-body solver cost.
 * Generates radially concentrated 2D Voronoi cells around ballistic/blast impact, clips every
 * convex cell to `[0, widthM] x [0, heightM]` via Sutherland-Hodgman polygon clipping, extrudes
 * 1 cm (`0.01 m`) 3D glass prisms centered at each shard's 2D centroid, and steps 500+ shards
 * concurrently in flat Struct-of-Arrays typed buffers.
 */

export const DEFAULT_VORONOI_SHARD_THICKNESS_M = 0.01;
export const DEFAULT_SHARD_FLOOR_Y = 0.008;
export const DEFAULT_SHARD_RESTITUTION = 0.28;
export const DEFAULT_SHARD_GRAVITY_Y = -9.81;

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
  /** 1 cm extruded 3D prism geometry centered at `(centroid.x, centroid.y, 0)`. */
  extruded: ExtrudedGlassShardGeometry;
}

export interface VoronoiWindowShatterOptions {
  widthM: number;
  heightM: number;
  hitX: number;
  hitY: number;
  /** Target interior shard count in `[36, 48]` (defaults to `42`). */
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
}

export interface GlassShardBatchedMeshStats {
  activeShards: number;
  vertexCount: number;
  indexCount: number;
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
  const epsSq = 1e-14;
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

    // v0: (p0, +halfZ), v1: (p1, +halfZ), v2: (p1, -halfZ), v3: (p0, -halfZ)
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

/**
 * Generates `36–48` radially concentrated jittered 2D seed points around `(hitX, hitY)`
 * (dense near bullet impact, larger shards near frame edges) plus outer super-ring boundary
 * seeds, runs `Delaunator.from(...)`, constructs exact dual 2D convex Voronoi cells from
 * triangle circumcenters, clips every cell to `[0, widthM] x [0, heightM]` via
 * Sutherland-Hodgman clipping, and extrudes `1 cm` 3D shard prisms.
 */
export function shatterWindowVoronoi2D(
  options: VoronoiWindowShatterOptions,
): VoronoiWindowShatterResult {
  const widthM = Math.max(0.1, options.widthM);
  const heightM = Math.max(0.1, options.heightM);
  const thicknessM = options.thicknessM ?? DEFAULT_VORONOI_SHARD_THICKNESS_M;
  const targetShardCount = Math.max(
    36,
    Math.min(48, Math.round(options.shardCount ?? 42)),
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

  const diagM = Math.hypot(widthM, heightM);
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

  // 2. Radially concentrated rings around (hitX, hitY): dense inner rings, wider outer rings
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
        // Fallback jitter if clamped against frame near edge impact
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

  // 3. Frame/outer region seeds so window edges break into larger realistic plate shards
  const perimeterBaseAngle = rand() * Math.PI * 2;
  for (let i = 0; i < outerFrameCount; i++) {
    const theta =
      perimeterBaseAngle + (i / Math.max(1, outerFrameCount)) * Math.PI * 2 + (rand() - 0.5) * 0.35;
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

  // Top up deterministically if any seed collided with separation threshold
  let safetyGuard = 0;
  while (seeds.length < targetShardCount && safetyGuard < 256) {
    safetyGuard++;
    const fx = marginX + rand() * (widthM - 2 * marginX);
    const fy = marginY + rand() * (heightM - 2 * marginY);
    tryPushInteriorSeed(fx, fy);
  }

  const interiorSeedCount = seeds.length;

  // 4. Add 8 distant outer super-ring boundary seeds at radius `8 * diagM`.
  //    Every point inside `[0, widthM] x [0, heightM]` is >= 7.5x closer to an interior seed
  //    than to any outer boundary seed, guaranteeing:
  //    (a) every interior seed is strictly inside the Delaunay hull (closed CCW Voronoi cell), and
  //    (b) the clipped interior Voronoi cells partition `[0, widthM] x [0, heightM]` with 0 gap!
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

  // 5. Run Delaunator in sub-millisecond JS
  const delaunay = Delaunator.from(
    seeds,
    (p: Point2D) => p.x,
    (p: Point2D) => p.y,
  );

  const { triangles, halfedges } = delaunay;
  const numTriangles = triangles.length / 3;

  // Precompute circumcenter for every Delaunay triangle
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

  // Build O(1) seed-to-outgoing-halfedge index lookup
  const seedToHalfedge = new Int32Array(seeds.length).fill(-1);
  for (let e = 0; e < triangles.length; e++) {
    const endpoint = triangles[e];
    if (seedToHalfedge[endpoint] === -1) {
      seedToHalfedge[endpoint] = e;
    }
  }

  const shards: VoronoiGlassShardCell[] = [];
  let totalAreaM2 = 0;

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
    });
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
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + qw * t + cross(q.xyz, t)
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
}

/**
 * Flat TypedArray / Struct-of-Arrays Custom JS Ballistic/Verlet Glass Shard Simulator.
 *
 * Supports **500+ concurrent 1 cm extruded Voronoi shards** at zero WASM solver cost:
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
    maxPolygonSides = 12,
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
   * Spawns all Voronoi cells of a shattered window into the pool with radial outward +
   * bullet-forward ballistic velocities and rapid 3D crystalline spin.
   */
  public spawnWindowShatter(
    shatter: VoronoiWindowShatterResult,
    transform: SpawnVoronoiShardsTransform,
  ): number {
    const rot = transform.windowRotationQuat ?? IDENTITY_QUAT;
    const baseTtl = transform.ttlSeconds ?? 3.8;
    const rand = createDeterministicPrng(
      transform.seed ??
        ((Math.round(shatter.hitX * 997) ^ Math.round(shatter.hitY * 991)) +
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

    const energyScale = Math.min(2.2, 0.55 + Math.sqrt(Math.max(10, transform.impactEnergyJ)) * 0.032);
    const halfW = shatter.widthM * 0.5;
    const halfH = shatter.heightM * 0.5;
    const diag = Math.hypot(shatter.widthM, shatter.heightM);

    let spawned = 0;
    for (let i = 0; i < shatter.shards.length; i++) {
      const shard = shatter.shards[i];

      // Local offset of shard centroid relative to window center
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

      // Radial vector in window-local plane from bullet impact to shard centroid
      const rdx = shard.centroid.x - shatter.hitX;
      const rdy = shard.centroid.y - shatter.hitY;
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

      const spinRate = (6.0 + proximity * 15.0) * (0.7 + rand() * 0.65);
      const angVel: Vec3Like = {
        x: (-rny + (rand() - 0.5) * 0.8) * spinRate,
        y: (rnx + (rand() - 0.5) * 0.8) * spinRate,
        z: (rand() - 0.5) * spinRate * 0.85,
      };

      const ttlJitter = baseTtl * (0.85 + rand() * 0.35);
      this.spawnShard(worldPos, vel, angVel, rot, shard.extruded, ttlJitter);
      spawned++;
    }

    return spawned;
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

    const stepDt = Math.min(dt, 1 / 20);
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

      // Smooth shrink/fade over final 20% (up to 0.55s) of shard lifetime
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

      let px = oldX + vx * stepDt;
      let py = oldY + vy * stepDt;
      let pz = oldZ + vz * stepDt;

      let wx = this.angVelX[i];
      let wy = this.angVelY[i];
      let wz = this.angVelZ[i];

      let qx = this.quatX[i];
      let qy = this.quatY[i];
      let qz = this.quatZ[i];
      let qw = this.quatW[i];

      // Floor-plane collision, restitution 0.28, planar friction & settle-flat alignment
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

        // Settle-flat torque: tip local shard face normal (+Z/-Z) toward world +Y so shards rest flat!
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

      // Integrate 3D angular velocity into unit quaternion
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
   * Transforms all active shards' 1 cm extruded prisms into caller-supplied world-space
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

      // Precompute 3x3 rotation matrix entries once per shard
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
          // Rim bevel normals have |lnz| < 0.5 -> brighter icy specular rim color!
          const isRim = Math.abs(lnz) < 0.5;
          outColors[dc4] = isRim ? 0.94 : 0.72;
          outColors[dc4 + 1] = isRim ? 0.99 : 0.89;
          outColors[dc4 + 2] = 1.0;
          outColors[dc4 + 3] = (isRim ? 0.92 : 0.58) * scale;
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
