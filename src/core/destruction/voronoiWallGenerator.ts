import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  ChunkConnectivityEdge,
  ChunkConnectivityGraphJson,
  ChunkConnectivityNode,
} from '../../contracts/destruction.ts';
import { parseConnectivityGraphJson } from './connectivityGraph.ts';

const CONCRETE_DENSITY_KG_M3 = 2400;
const FOUNDATION_NEIGHBOR_TAG = -1;
const OUTER_BOUNDARY_NEIGHBOR_TAG = -2;
const CLIP_EPS = 1e-6;
const ON_PLANE_EPS = 2.5e-5;
const WELD_EPS_SQ = 1e-9;

export interface VoronoiChunkData {
  index: number;
  name: string;
  seedPoint: Vec3Like;
  /** Center of mass / geometric centroid in wall-local coordinates. */
  localCenter: Vec3Like;
  /** Tight chunk-local AABB half-extents. */
  halfExtents: Vec3Like;
  volumeM3: number;
  massKg: number;
  isAnchored: boolean;
  /** Flat-shaded vertex positions in chunk-local space (`v - localCenter`), `3 * vertexCount` floats. */
  localPositions: Float32Array;
  /** Flat-shaded vertex positions in wall-local space (`v`), `3 * vertexCount` floats. */
  wallSpacePositions: Float32Array;
  /** Per-vertex outward facet normals, `3 * vertexCount` floats. */
  normals: Float32Array;
  /** Box-projected concrete UVs, `2 * vertexCount` floats. */
  uvs: Float32Array;
  /** Chunk-local triangle indices (`0 .. vertexCount - 1`). */
  indices: Uint32Array;
  /** Deduplicated unique chunk-local corner coordinates (`3 * cornerCount` floats) for Rapier `convexHull`. */
  hullVertices: Float32Array;
}

export interface VoronoiSubDrawRange {
  chunkIndex: number;
  baseVertex: number;
  vertexCount: number;
  firstIndex: number;
  indexCount: number;
}

export interface CombinedVoronoiMeshBuffer {
  totalVertices: number;
  totalIndices: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  subDraws: VoronoiSubDrawRange[];
}

export interface VoronoiWallData {
  wallId: string;
  width: number;
  height: number;
  depth: number;
  chunks: VoronoiChunkData[];
  connectivity: ChunkConnectivityGraphJson;
  combinedBuffer: CombinedVoronoiMeshBuffer;
}

export interface ImportedVoronoiChunkMesh {
  name?: string;
  /** Positions in either wall-local space (when `positionsAreWallLocal === true`) or chunk-local space. */
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  indices: Uint16Array | Uint32Array;
  positionsAreWallLocal?: boolean;
}

interface PolyFace3D {
  normal: Vec3Like;
  neighborTag: number;
  vertices: Vec3Like[];
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dot3(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross3(a: Vec3Like, b: Vec3Like): Vec3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize3(v: Vec3Like): Vec3Like {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len <= 1e-12) {
    return { x: 0, y: 1, z: 0 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function computePolygonArea(vertices: readonly Vec3Like[]): number {
  if (vertices.length < 3) {
    return 0;
  }
  const v0 = vertices[0];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 1; i + 1 < vertices.length; i++) {
    const v1 = vertices[i];
    const v2 = vertices[i + 1];
    const ax = v1.x - v0.x;
    const ay = v1.y - v0.y;
    const az = v1.z - v0.z;
    const bx = v2.x - v0.x;
    const by = v2.y - v0.y;
    const bz = v2.z - v0.z;
    cx += ay * bz - az * by;
    cy += az * bx - ax * bz;
    cz += ax * by - ay * bx;
  }
  return 0.5 * Math.hypot(cx, cy, cz);
}

function createInitialBoxFaces(
  width: number,
  height: number,
  depth: number,
): PolyFace3D[] {
  const x0 = -width * 0.5;
  const x1 = width * 0.5;
  const y0 = 0;
  const y1 = height;
  const z0 = -depth * 0.5;
  const z1 = depth * 0.5;

  return [
    // Bottom foundation face (y = 0, outward -Y)
    {
      normal: { x: 0, y: -1, z: 0 },
      neighborTag: FOUNDATION_NEIGHBOR_TAG,
      vertices: [
        { x: x0, y: y0, z: z0 },
        { x: x1, y: y0, z: z0 },
        { x: x1, y: y0, z: z1 },
        { x: x0, y: y0, z: z1 },
      ],
    },
    // Top face (y = height, outward +Y)
    {
      normal: { x: 0, y: 1, z: 0 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: x0, y: y1, z: z1 },
        { x: x1, y: y1, z: z1 },
        { x: x1, y: y1, z: z0 },
        { x: x0, y: y1, z: z0 },
      ],
    },
    // Front face (z = +depth/2, outward +Z)
    {
      normal: { x: 0, y: 0, z: 1 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: x0, y: y0, z: z1 },
        { x: x1, y: y0, z: z1 },
        { x: x1, y: y1, z: z1 },
        { x: x0, y: y1, z: z1 },
      ],
    },
    // Back face (z = -depth/2, outward -Z)
    {
      normal: { x: 0, y: 0, z: -1 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: x1, y: y0, z: z0 },
        { x: x0, y: y0, z: z0 },
        { x: x0, y: y1, z: z0 },
        { x: x1, y: y1, z: z0 },
      ],
    },
    // Right face (x = +width/2, outward +X)
    {
      normal: { x: 1, y: 0, z: 0 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: x1, y: y0, z: z1 },
        { x: x1, y: y0, z: z0 },
        { x: x1, y: y1, z: z0 },
        { x: x1, y: y1, z: z1 },
      ],
    },
    // Left face (x = -width/2, outward -X)
    {
      normal: { x: -1, y: 0, z: 0 },
      neighborTag: OUTER_BOUNDARY_NEIGHBOR_TAG,
      vertices: [
        { x: x0, y: y0, z: z0 },
        { x: x0, y: y0, z: z1 },
        { x: x0, y: y1, z: z1 },
        { x: x0, y: y1, z: z0 },
      ],
    },
  ];
}

function addUniquePoint(list: Vec3Like[], pt: Vec3Like): void {
  for (let i = 0; i < list.length; i++) {
    const dx = list[i].x - pt.x;
    const dy = list[i].y - pt.y;
    const dz = list[i].z - pt.z;
    if (dx * dx + dy * dy + dz * dz <= WELD_EPS_SQ) {
      return;
    }
  }
  list.push(pt);
}

/**
 * Clips a convex 3D polyhedron (represented as CCW outward polygon faces) against the
 * half-space `dot(planeNormal, p) <= planeOffset`.
 */
function clipConvexPolyhedronByHalfSpace(
  faces: PolyFace3D[],
  planeNormal: Vec3Like,
  planeOffset: number,
  neighborTag: number,
): PolyFace3D[] {
  let anyOutside = false;
  let anyInside = false;

  for (let f = 0; f < faces.length; f++) {
    const verts = faces[f].vertices;
    for (let v = 0; v < verts.length; v++) {
      const signedDist = dot3(planeNormal, verts[v]) - planeOffset;
      if (signedDist > CLIP_EPS) {
        anyOutside = true;
      } else if (signedDist < -CLIP_EPS) {
        anyInside = true;
      }
    }
  }

  // Entire polyhedron already satisfies dot(n, p) <= d
  if (!anyOutside) {
    return faces;
  }
  // Degenerate full clip
  if (!anyInside) {
    return [];
  }

  const nextFaces: PolyFace3D[] = [];
  const capPoints: Vec3Like[] = [];

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const verts = face.vertices;
    const count = verts.length;
    if (count < 3) {
      continue;
    }

    const clipped: Vec3Like[] = [];
    let prev = verts[count - 1];
    let prevDist = dot3(planeNormal, prev) - planeOffset;
    let prevInside = prevDist <= CLIP_EPS;

    for (let i = 0; i < count; i++) {
      const curr = verts[i];
      const currDist = dot3(planeNormal, curr) - planeOffset;
      const currInside = currDist <= CLIP_EPS;

      if (currInside !== prevInside) {
        const denom = prevDist - currDist;
        const t = Math.abs(denom) > 1e-12 ? prevDist / denom : 0.5;
        const clampedT = Math.max(0, Math.min(1, t));
        const intersection: Vec3Like = {
          x: prev.x + (curr.x - prev.x) * clampedT,
          y: prev.y + (curr.y - prev.y) * clampedT,
          z: prev.z + (curr.z - prev.z) * clampedT,
        };
        clipped.push(intersection);
        addUniquePoint(capPoints, intersection);
      }

      if (currInside) {
        clipped.push(curr);
        if (Math.abs(currDist) <= ON_PLANE_EPS) {
          addUniquePoint(capPoints, curr);
        }
      }

      prev = curr;
      prevDist = currDist;
      prevInside = currInside;
    }

    // Deduplicate adjacent near-identical vertices from grazing cuts
    const cleaned: Vec3Like[] = [];
    for (let i = 0; i < clipped.length; i++) {
      const pt = clipped[i];
      const prevClean =
        cleaned.length > 0 ? cleaned[cleaned.length - 1] : clipped[clipped.length - 1];
      const dx = pt.x - prevClean.x;
      const dy = pt.y - prevClean.y;
      const dz = pt.z - prevClean.z;
      if (cleaned.length === 0 || dx * dx + dy * dy + dz * dz > WELD_EPS_SQ) {
        cleaned.push(pt);
      }
    }
    if (cleaned.length >= 2) {
      const first = cleaned[0];
      const last = cleaned[cleaned.length - 1];
      const dx = first.x - last.x;
      const dy = first.y - last.y;
      const dz = first.z - last.z;
      if (dx * dx + dy * dy + dz * dz <= WELD_EPS_SQ) {
        cleaned.pop();
      }
    }

    if (cleaned.length >= 3 && computePolygonArea(cleaned) > 1e-9) {
      nextFaces.push({
        normal: face.normal,
        neighborTag: face.neighborTag,
        vertices: cleaned,
      });
    }
  }

  // Construct CCW cap polygon on the cutting plane (uAxis x vAxis = +planeNormal)
  if (capPoints.length >= 3) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < capPoints.length; i++) {
      cx += capPoints[i].x;
      cy += capPoints[i].y;
      cz += capPoints[i].z;
    }
    const invN = 1 / capPoints.length;
    cx *= invN;
    cy *= invN;
    cz *= invN;

    const refAxis: Vec3Like =
      Math.abs(planeNormal.y) < 0.9
        ? { x: 0, y: 1, z: 0 }
        : { x: 1, y: 0, z: 0 };
    const uAxis = normalize3(cross3(refAxis, planeNormal));
    const vAxis = normalize3(cross3(planeNormal, uAxis));

    const angled = capPoints.map((pt) => {
      const rx = pt.x - cx;
      const ry = pt.y - cy;
      const rz = pt.z - cz;
      const u = rx * uAxis.x + ry * uAxis.y + rz * uAxis.z;
      const v = rx * vAxis.x + ry * vAxis.y + rz * vAxis.z;
      return { pt, angle: Math.atan2(v, u) };
    });
    angled.sort((a, b) => a.angle - b.angle);

    const capVertices = angled.map((entry) => entry.pt);
    if (computePolygonArea(capVertices) > 1e-9) {
      nextFaces.push({
        normal: { x: planeNormal.x, y: planeNormal.y, z: planeNormal.z },
        neighborTag,
        vertices: capVertices,
      });
    }
  }

  return nextFaces;
}

function generateStratifiedSeeds(
  width: number,
  height: number,
  depth: number,
  cellCount: number,
  seed: number,
): Vec3Like[] {
  const rng = createMulberry32(seed);
  const count = Math.max(2, Math.floor(cellCount));

  // Compute grid subdivisions matching wall aspect ratio (thin Z usually has nz = 1 or 2)
  const nz = depth >= 0.45 && count >= 16 ? 2 : 1;
  const layerCount = Math.ceil(count / nz);
  const aspectXY = Math.max(0.25, width / Math.max(0.1, height));
  const nx = Math.max(1, Math.round(Math.sqrt(layerCount * aspectXY)));
  const ny = Math.max(1, Math.ceil(layerCount / nx));

  const candidates: { cellRank: number; jitterRank: number; pt: Vec3Like }[] = [];
  const x0 = -width * 0.5;
  const z0 = -depth * 0.5;
  const dx = width / nx;
  const dy = height / ny;
  const dz = depth / nz;

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const jx = 0.2 + rng() * 0.6;
        // Keep bottom-row seeds closer to ground so base cells reliably anchor on y = 0
        const jy = iy === 0 ? 0.14 + rng() * 0.42 : 0.2 + rng() * 0.6;
        const jz = nz === 1 ? 0.32 + rng() * 0.36 : 0.22 + rng() * 0.56;

        candidates.push({
          // Prioritize bottom row first so even if count < nx*ny*nz, foundation course is populated
          cellRank: iy === 0 ? 0 : 1,
          jitterRank: rng(),
          pt: {
            x: x0 + (ix + jx) * dx,
            y: (iy + jy) * dy,
            z: z0 + (iz + jz) * dz,
          },
        });
      }
    }
  }

  candidates.sort((a, b) =>
    a.cellRank !== b.cellRank ? a.cellRank - b.cellRank : a.jitterRank - b.jitterRank,
  );

  const seeds: Vec3Like[] = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    seeds.push(candidates[i].pt);
  }
  while (seeds.length < count) {
    seeds.push({
      x: x0 + (0.12 + rng() * 0.76) * width,
      y: (0.12 + rng() * 0.76) * height,
      z: z0 + (0.2 + rng() * 0.6) * depth,
    });
  }

  return seeds;
}

function projectBoxUv(point: Vec3Like, normal: Vec3Like, uvScale = 0.5): [number, number] {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (az >= ax && az >= ay) {
    return [point.x * uvScale + 0.5, point.y * uvScale];
  }
  if (ax >= ay) {
    return [point.z * uvScale + 0.5, point.y * uvScale];
  }
  return [point.x * uvScale + 0.5, point.z * uvScale + 0.5];
}

function computePolyhedronVolumeAndCentroid(faces: readonly PolyFace3D[]): {
  volumeM3: number;
  centroid: Vec3Like;
} {
  // Use average of face vertices as interior reference point to avoid floating-point cancellation
  const ref: Vec3Like = { x: 0, y: 0, z: 0 };
  let totalVerts = 0;
  for (let f = 0; f < faces.length; f++) {
    const verts = faces[f].vertices;
    for (let i = 0; i < verts.length; i++) {
      ref.x += verts[i].x;
      ref.y += verts[i].y;
      ref.z += verts[i].z;
      totalVerts++;
    }
  }
  if (totalVerts === 0) {
    return { volumeM3: 0, centroid: { x: 0, y: 0, z: 0 } };
  }
  ref.x /= totalVerts;
  ref.y /= totalVerts;
  ref.z /= totalVerts;

  let sixVolSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightedZ = 0;

  for (let f = 0; f < faces.length; f++) {
    const verts = faces[f].vertices;
    if (verts.length < 3) continue;
    const p0 = verts[0];
    const ax = p0.x - ref.x;
    const ay = p0.y - ref.y;
    const az = p0.z - ref.z;

    for (let i = 1; i + 1 < verts.length; i++) {
      const p1 = verts[i];
      const p2 = verts[i + 1];
      const bx = p1.x - ref.x;
      const by = p1.y - ref.y;
      const bz = p1.z - ref.z;
      const cx = p2.x - ref.x;
      const cy = p2.y - ref.y;
      const cz = p2.z - ref.z;

      const det =
        ax * (by * cz - bz * cy) +
        ay * (bz * cx - bx * cz) +
        az * (bx * cy - by * cx);
      if (det > 0) {
        sixVolSum += det;
        weightedX += det * (ref.x + (ax + bx + cx) * 0.25);
        weightedY += det * (ref.y + (ay + by + cy) * 0.25);
        weightedZ += det * (ref.z + (az + bz + cz) * 0.25);
      }
    }
  }

  if (sixVolSum <= 1e-12) {
    return { volumeM3: 0, centroid: ref };
  }

  return {
    volumeM3: sixVolSum / 6,
    centroid: {
      x: weightedX / sixVolSum,
      y: weightedY / sixVolSum,
      z: weightedZ / sixVolSum,
    },
  };
}

/**
 * Packs all Voronoi concrete chunks into ONE single combined vertex/normal/UV/index buffer
 * recording `{ firstIndex, indexCount }` per chunk for single-draw-call `setMultiDraw`.
 */
export function packCombinedVoronoiBuffer(
  chunks: readonly VoronoiChunkData[],
): CombinedVoronoiMeshBuffer {
  let totalVertices = 0;
  let totalIndices = 0;

  for (let i = 0; i < chunks.length; i++) {
    totalVertices += chunks[i].wallSpacePositions.length / 3;
    totalIndices += chunks[i].indices.length;
  }

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const indices: Uint16Array | Uint32Array =
    totalVertices <= 65535
      ? new Uint16Array(totalIndices)
      : new Uint32Array(totalIndices);
  const subDraws: VoronoiSubDrawRange[] = new Array<VoronoiSubDrawRange>(chunks.length);

  let vertCursor = 0;
  let indexCursor = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const vCount = chunk.wallSpacePositions.length / 3;
    const iCount = chunk.indices.length;

    positions.set(chunk.wallSpacePositions, vertCursor * 3);
    normals.set(chunk.normals, vertCursor * 3);
    uvs.set(chunk.uvs, vertCursor * 2);

    for (let k = 0; k < iCount; k++) {
      indices[indexCursor + k] = vertCursor + chunk.indices[k];
    }

    subDraws[i] = {
      chunkIndex: i,
      baseVertex: vertCursor,
      vertexCount: vCount,
      firstIndex: indexCursor,
      indexCount: iCount,
    };

    vertCursor += vCount;
    indexCursor += iCount;
  }

  return {
    totalVertices,
    totalIndices,
    positions,
    normals,
    uvs,
    indices,
    subDraws,
  };
}

/**
 * Deterministically fractures a `[width x height x depth]` reinforced concrete wall into
 * watertight 3D convex Voronoi polyhedra via half-space plane clipping, producing per-chunk
 * meshes, combined `setMultiDraw` buffers, and exact shared-face `ChunkConnectivityGraphJson`.
 */
export function generateVoronoiWallData(
  wallId: string,
  width = 3.2,
  height = 2.2,
  depth = 0.28,
  cellCount = 32,
  seed = 1337,
  bondStrengthPerSqM = 18000,
): VoronoiWallData {
  const safeW = Math.max(0.2, width);
  const safeH = Math.max(0.2, height);
  const safeD = Math.max(0.06, depth);
  const seeds = generateStratifiedSeeds(safeW, safeH, safeD, cellCount, seed);
  const n = seeds.length;

  const chunks: VoronoiChunkData[] = [];
  const rawNodes: ChunkConnectivityNode[] = [];

  for (let i = 0; i < n; i++) {
    const seedA = seeds[i];
    let faces = createInitialBoxFaces(safeW, safeH, safeD);

    // Sort candidate neighbors ascending by squared distance for fast bounding-sphere early exit
    const sortedNeighbors: { idx: number; distSq: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = seeds[j].x - seedA.x;
      const dy = seeds[j].y - seedA.y;
      const dz = seeds[j].z - seedA.z;
      sortedNeighbors.push({ idx: j, distSq: dx * dx + dy * dy + dz * dz });
    }
    sortedNeighbors.sort((a, b) => a.distSq - b.distSq);

    for (let k = 0; k < sortedNeighbors.length; k++) {
      // Compute maximum current corner radius from seedA; if 0.5 * |Sj - Si| exceeds it, no further seed can clip!
      let maxCornerDistSq = 0;
      for (let f = 0; f < faces.length; f++) {
        const fVerts = faces[f].vertices;
        for (let v = 0; v < fVerts.length; v++) {
          const rx = fVerts[v].x - seedA.x;
          const ry = fVerts[v].y - seedA.y;
          const rz = fVerts[v].z - seedA.z;
          const dSq = rx * rx + ry * ry + rz * rz;
          if (dSq > maxCornerDistSq) {
            maxCornerDistSq = dSq;
          }
        }
      }

      const cand = sortedNeighbors[k];
      if (0.25 * cand.distSq > maxCornerDistSq + 1e-6) {
        break;
      }

      const seedB = seeds[cand.idx];
      const delta: Vec3Like = {
        x: seedB.x - seedA.x,
        y: seedB.y - seedA.y,
        z: seedB.z - seedA.z,
      };
      const planeNormal = normalize3(delta);
      const midPoint: Vec3Like = {
        x: 0.5 * (seedA.x + seedB.x),
        y: 0.5 * (seedA.y + seedB.y),
        z: 0.5 * (seedA.z + seedB.z),
      };
      const planeOffset = dot3(planeNormal, midPoint);

      faces = clipConvexPolyhedronByHalfSpace(faces, planeNormal, planeOffset, cand.idx);
      if (faces.length === 0) {
        break;
      }
    }

    const { volumeM3, centroid } = computePolyhedronVolumeAndCentroid(faces);
    const massKg = Math.max(0.5, volumeM3 * CONCRETE_DENSITY_KG_M3);

    let isAnchored = false;
    const neighborContactArea = new Map<number, number>();
    let totalFaceVerts = 0;
    let totalFaceIndices = 0;
    const uniqueWallCorners: Vec3Like[] = [];

    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      const vLen = face.vertices.length;
      if (vLen < 3) continue;

      const area = computePolygonArea(face.vertices);
      if (face.neighborTag === FOUNDATION_NEIGHBOR_TAG && area > 1e-5) {
        isAnchored = true;
      } else if (face.neighborTag >= 0 && area > 1e-5) {
        neighborContactArea.set(
          face.neighborTag,
          (neighborContactArea.get(face.neighborTag) ?? 0) + area,
        );
      }

      totalFaceVerts += vLen;
      totalFaceIndices += (vLen - 2) * 3;
      for (let v = 0; v < vLen; v++) {
        addUniquePoint(uniqueWallCorners, face.vertices[v]);
      }
    }

    const localPositions = new Float32Array(totalFaceVerts * 3);
    const wallSpacePositions = new Float32Array(totalFaceVerts * 3);
    const normals = new Float32Array(totalFaceVerts * 3);
    const uvs = new Float32Array(totalFaceVerts * 2);
    const indices = new Uint32Array(totalFaceIndices);

    let vOut = 0;
    let iOut = 0;
    let minLx = Infinity;
    let minLy = Infinity;
    let minLz = Infinity;
    let maxLx = -Infinity;
    let maxLy = -Infinity;
    let maxLz = -Infinity;

    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      const fVerts = face.vertices;
      const vLen = fVerts.length;
      if (vLen < 3) continue;

      const baseV = vOut;
      const nx = face.normal.x;
      const ny = face.normal.y;
      const nz = face.normal.z;

      for (let v = 0; v < vLen; v++) {
        const wp = fVerts[v];
        const lx = wp.x - centroid.x;
        const ly = wp.y - centroid.y;
        const lz = wp.z - centroid.z;

        if (lx < minLx) minLx = lx;
        if (ly < minLy) minLy = ly;
        if (lz < minLz) minLz = lz;
        if (lx > maxLx) maxLx = lx;
        if (ly > maxLy) maxLy = ly;
        if (lz > maxLz) maxLz = lz;

        const p3 = vOut * 3;
        localPositions[p3] = lx;
        localPositions[p3 + 1] = ly;
        localPositions[p3 + 2] = lz;

        wallSpacePositions[p3] = wp.x;
        wallSpacePositions[p3 + 1] = wp.y;
        wallSpacePositions[p3 + 2] = wp.z;

        normals[p3] = nx;
        normals[p3 + 1] = ny;
        normals[p3 + 2] = nz;

        const [u, uvV] = projectBoxUv(wp, face.normal);
        const p2 = vOut * 2;
        uvs[p2] = u;
        uvs[p2 + 1] = uvV;

        vOut++;
      }

      for (let t = 1; t + 1 < vLen; t++) {
        indices[iOut++] = baseV;
        indices[iOut++] = baseV + t;
        indices[iOut++] = baseV + t + 1;
      }
    }

    const hullVertices = new Float32Array(uniqueWallCorners.length * 3);
    for (let c = 0; c < uniqueWallCorners.length; c++) {
      hullVertices[c * 3] = uniqueWallCorners[c].x - centroid.x;
      hullVertices[c * 3 + 1] = uniqueWallCorners[c].y - centroid.y;
      hullVertices[c * 3 + 2] = uniqueWallCorners[c].z - centroid.z;
    }

    const halfExtents: Vec3Like = {
      x: Number.isFinite(maxLx - minLx) ? Math.max(0.01, (maxLx - minLx) * 0.5) : 0.1,
      y: Number.isFinite(maxLy - minLy) ? Math.max(0.01, (maxLy - minLy) * 0.5) : 0.1,
      z: Number.isFinite(maxLz - minLz) ? Math.max(0.01, (maxLz - minLz) * 0.5) : 0.1,
    };

    const edges: ChunkConnectivityEdge[] = [];
    for (const [neighborIndex, sharedArea] of neighborContactArea.entries()) {
      edges.push({
        neighborIndex,
        breakThresholdJ: Math.max(180, sharedArea * bondStrengthPerSqM),
        severed: false,
      });
    }

    const chunkName = `chunk_${String(i).padStart(3, '0')}`;
    chunks.push({
      index: i,
      name: chunkName,
      seedPoint: seedA,
      localCenter: centroid,
      halfExtents,
      volumeM3,
      massKg,
      isAnchored,
      localPositions,
      wallSpacePositions,
      normals,
      uvs,
      indices,
      hullVertices,
    });

    rawNodes.push({
      index: i,
      name: chunkName,
      isAnchored,
      localCenter: centroid,
      halfExtents,
      massKg,
      edges,
    });
  }

  const connectivity = parseConnectivityGraphJson({
    version: 1,
    wallId,
    nodes: rawNodes,
  });

  const combinedBuffer = packCombinedVoronoiBuffer(chunks);

  return {
    wallId,
    width: safeW,
    height: safeH,
    depth: safeD,
    chunks,
    connectivity,
    combinedBuffer,
  };
}

/**
 * Converts external pre-fractured Blender `.glb` chunk buffers + `.json` connectivity graph
 * into the unified `VoronoiWallData` + `CombinedVoronoiMeshBuffer` format consumed by `ConcreteWallSystem`.
 */
export function buildVoronoiWallDataFromImportedMeshes(
  importedChunks: readonly ImportedVoronoiChunkMesh[],
  connectivitySource: string | ChunkConnectivityGraphJson,
): VoronoiWallData {
  const connectivity = parseConnectivityGraphJson(connectivitySource);
  if (importedChunks.length !== connectivity.nodes.length) {
    throw new Error(
      `Imported Voronoi chunk count (${importedChunks.length}) does not match connectivity graph node count (${connectivity.nodes.length}).`,
    );
  }

  let wallMinX = Infinity;
  let wallMaxX = -Infinity;
  let wallMinY = Infinity;
  let wallMaxY = -Infinity;
  let wallMinZ = Infinity;
  let wallMaxZ = -Infinity;

  const chunks: VoronoiChunkData[] = new Array<VoronoiChunkData>(importedChunks.length);

  for (let i = 0; i < importedChunks.length; i++) {
    const src = importedChunks[i];
    const node = connectivity.nodes[i];
    const vCount = Math.floor(src.positions.length / 3);
    const localPositions = new Float32Array(vCount * 3);
    const wallSpacePositions = new Float32Array(vCount * 3);
    const normals = new Float32Array(vCount * 3);
    normals.set(src.normals.subarray(0, vCount * 3));

    const uvs = new Float32Array(vCount * 2);
    if (src.uvs && src.uvs.length >= vCount * 2) {
      uvs.set(src.uvs.subarray(0, vCount * 2));
    }

    let minLx = Infinity;
    let minLy = Infinity;
    let minLz = Infinity;
    let maxLx = -Infinity;
    let maxLy = -Infinity;
    let maxLz = -Infinity;
    const uniqueLocalCorners: Vec3Like[] = [];

    for (let v = 0; v < vCount; v++) {
      const p3 = v * 3;
      let lx: number;
      let ly: number;
      let lz: number;
      let wx: number;
      let wy: number;
      let wz: number;

      if (src.positionsAreWallLocal) {
        wx = src.positions[p3];
        wy = src.positions[p3 + 1];
        wz = src.positions[p3 + 2];
        lx = wx - node.localCenter.x;
        ly = wy - node.localCenter.y;
        lz = wz - node.localCenter.z;
      } else {
        lx = src.positions[p3];
        ly = src.positions[p3 + 1];
        lz = src.positions[p3 + 2];
        wx = lx + node.localCenter.x;
        wy = ly + node.localCenter.y;
        wz = lz + node.localCenter.z;
      }

      localPositions[p3] = lx;
      localPositions[p3 + 1] = ly;
      localPositions[p3 + 2] = lz;

      wallSpacePositions[p3] = wx;
      wallSpacePositions[p3 + 1] = wy;
      wallSpacePositions[p3 + 2] = wz;

      if (!src.uvs || src.uvs.length < vCount * 2) {
        const [u, uvV] = projectBoxUv(
          { x: wx, y: wy, z: wz },
          { x: normals[p3], y: normals[p3 + 1], z: normals[p3 + 2] },
        );
        uvs[v * 2] = u;
        uvs[v * 2 + 1] = uvV;
      }

      if (lx < minLx) minLx = lx;
      if (ly < minLy) minLy = ly;
      if (lz < minLz) minLz = lz;
      if (lx > maxLx) maxLx = lx;
      if (ly > maxLy) maxLy = ly;
      if (lz > maxLz) maxLz = lz;

      if (wx < wallMinX) wallMinX = wx;
      if (wx > wallMaxX) wallMaxX = wx;
      if (wy < wallMinY) wallMinY = wy;
      if (wy > wallMaxY) wallMaxY = wy;
      if (wz < wallMinZ) wallMinZ = wz;
      if (wz > wallMaxZ) wallMaxZ = wz;

      addUniquePoint(uniqueLocalCorners, { x: lx, y: ly, z: lz });
    }

    const hullVertices = new Float32Array(uniqueLocalCorners.length * 3);
    for (let c = 0; c < uniqueLocalCorners.length; c++) {
      hullVertices[c * 3] = uniqueLocalCorners[c].x;
      hullVertices[c * 3 + 1] = uniqueLocalCorners[c].y;
      hullVertices[c * 3 + 2] = uniqueLocalCorners[c].z;
    }

    const indices = new Uint32Array(src.indices.length);
    for (let k = 0; k < src.indices.length; k++) {
      indices[k] = src.indices[k];
    }

    const halfExtents: Vec3Like = node.halfExtents ?? {
      x: Math.max(0.01, (maxLx - minLx) * 0.5),
      y: Math.max(0.01, (maxLy - minLy) * 0.5),
      z: Math.max(0.01, (maxLz - minLz) * 0.5),
    };
    const approxVol = Math.max(
      1e-4,
      halfExtents.x * 2 * halfExtents.y * 2 * halfExtents.z * 2 * 0.65,
    );

    chunks[i] = {
      index: i,
      name: src.name ?? node.name ?? `chunk_${String(i).padStart(3, '0')}`,
      seedPoint: { ...node.localCenter },
      localCenter: { ...node.localCenter },
      halfExtents,
      volumeM3: approxVol,
      massKg: node.massKg,
      isAnchored: node.isAnchored,
      localPositions,
      wallSpacePositions,
      normals,
      uvs,
      indices,
      hullVertices,
    };
  }

  const combinedBuffer = packCombinedVoronoiBuffer(chunks);
  const width = Number.isFinite(wallMaxX - wallMinX) ? Math.max(0.1, wallMaxX - wallMinX) : 3.0;
  const height = Number.isFinite(wallMaxY - wallMinY) ? Math.max(0.1, wallMaxY - wallMinY) : 2.0;
  const depth = Number.isFinite(wallMaxZ - wallMinZ) ? Math.max(0.05, wallMaxZ - wallMinZ) : 0.25;

  return {
    wallId: connectivity.wallId,
    width,
    height,
    depth,
    chunks,
    connectivity,
    combinedBuffer,
  };
}
