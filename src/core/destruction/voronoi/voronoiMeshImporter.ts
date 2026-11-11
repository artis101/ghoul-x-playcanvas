import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ChunkConnectivityGraphJson } from '../../../contracts/destruction.ts';
import { parseConnectivityGraphJson } from '../connectivityGraph.ts';
import {
  type ImportedVoronoiChunkMesh,
  type VoronoiChunkData,
  type VoronoiWallData,
} from './voronoiWallTypes.ts';
import { projectBoxUv } from './voronoi3DMath.ts';
import { packCombinedVoronoiBuffer } from './voronoiBufferPacker.ts';

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

      uniqueLocalCorners.push({ x: lx, y: ly, z: lz });
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
