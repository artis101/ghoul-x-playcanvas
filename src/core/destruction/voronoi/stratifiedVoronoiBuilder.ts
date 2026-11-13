import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  ChunkConnectivityEdge,
  ChunkConnectivityNode,
} from '../../../contracts/destruction.ts';
import { parseConnectivityGraphJson } from '../connectivityGraph.ts';
import {
  CONCRETE_DENSITY_KG_M3,
  FOUNDATION_NEIGHBOR_TAG,
  type VoronoiChunkData,
  type VoronoiWallData,
} from './voronoiWallTypes.ts';
import {
  computePolygonArea,
  computePolyhedronVolumeAndCentroid,
  createInitialBoxFaces,
  dot3,
  normalize3,
} from './voronoi3DMath.ts';
import { clipConvexPolyhedronByHalfSpace } from './voronoi3DHalfSpaceClipper.ts';
import { packCombinedVoronoiBuffer } from './voronoiBufferPacker.ts';
import { generateStratifiedSeeds } from './stratifiedVoronoiSeeds.ts';
import { buildChunkMeshGeometry } from './voronoiChunkMeshBuilder.ts';

export function generateVoronoiWallData(
  wallId: string,
  width = 3.2,
  height = 2.2,
  depth = 0.28,
  cellCount = 32,
  seed = 1337,
  bondStrengthPerSqM = 34000,
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
    let faces = createInitialBoxFaces(
      -safeW * 0.5, safeW * 0.5,
      0, safeH,
      -safeD * 0.5, safeD * 0.5,
    );

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
      let maxCornerDistSq = 0;
      for (let f = 0; f < faces.length; f++) {
        const fVerts = faces[f].vertices;
        for (let v = 0; v < fVerts.length; v++) {
          const rx = fVerts[v].x - seedA.x;
          const ry = fVerts[v].y - seedA.y;
          const rz = fVerts[v].z - seedA.z;
          const dSq = rx * rx + ry * ry + rz * rz;
          if (dSq > maxCornerDistSq) maxCornerDistSq = dSq;
        }
      }

      const cand = sortedNeighbors[k];
      if (0.25 * cand.distSq > maxCornerDistSq + 1e-6) break;

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

      faces = clipConvexPolyhedronByHalfSpace(faces, midPoint, planeNormal, cand.idx);
      if (faces.length === 0) break;
    }

    const { volume, centroid } = computePolyhedronVolumeAndCentroid(faces);
    const massKg = Math.max(0.5, volume * CONCRETE_DENSITY_KG_M3);

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
        uniqueWallCorners.push(face.vertices[v]);
      }
    }

    const geo = buildChunkMeshGeometry(
      faces,
      centroid,
      uniqueWallCorners,
      totalFaceVerts,
      totalFaceIndices,
    );

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
      halfExtents: geo.halfExtents,
      volumeM3: volume,
      massKg,
      isAnchored,
      localPositions: geo.localPositions,
      wallSpacePositions: geo.wallSpacePositions,
      normals: geo.normals,
      uvs: geo.uvs,
      indices: geo.indices,
      hullVertices: geo.hullVertices,
    });

    rawNodes.push({
      index: i,
      name: chunkName,
      isAnchored,
      localCenter: centroid,
      halfExtents: geo.halfExtents,
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
