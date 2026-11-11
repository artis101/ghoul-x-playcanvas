import type {
  CombinedVoronoiMeshBuffer,
  VoronoiChunkData,
  VoronoiSubDrawRange,
} from './voronoiWallTypes.ts';

export function packCombinedVoronoiBuffer(
  chunks: readonly VoronoiChunkData[],
): CombinedVoronoiMeshBuffer {
  let totalVertices = 0;
  let totalIndices = 0;

  for (let c = 0; c < chunks.length; c++) {
    totalVertices += chunks[c].localPositions.length / 3;
    totalIndices += chunks[c].indices.length;
  }

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const use32Bit = totalVertices > 65535;
  const indices = use32Bit ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);
  const subDraws: VoronoiSubDrawRange[] = new Array(chunks.length);

  let vOffset = 0;
  let iOffset = 0;

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const chunkVertCount = chunk.localPositions.length / 3;
    const chunkIdxCount = chunk.indices.length;

    positions.set(chunk.wallSpacePositions, vOffset * 3);
    normals.set(chunk.normals, vOffset * 3);
    uvs.set(chunk.uvs, vOffset * 2);

    for (let k = 0; k < chunkIdxCount; k++) {
      indices[iOffset + k] = vOffset + chunk.indices[k];
    }

    subDraws[c] = {
      chunkIndex: chunk.index,
      baseVertex: vOffset,
      vertexCount: chunkVertCount,
      firstIndex: iOffset,
      indexCount: chunkIdxCount,
    };

    vOffset += chunkVertCount;
    iOffset += chunkIdxCount;
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
