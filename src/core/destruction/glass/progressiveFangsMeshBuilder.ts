import type { VoronoiGlassShardCell, VoronoiWindowShatterResult } from './glassShardTypes.ts';

export function writeClingingFangsMeshBuffers(
  shatter: VoronoiWindowShatterResult,
  attached: Uint8Array,
  outPositions: Float32Array,
  outNormals: Float32Array,
  outUvs: Float32Array,
  outColors: Float32Array,
  outIndices: Uint16Array,
): { fangCount: number; vertexCount: number; indexCount: number } {
  const maxVerts = Math.min(65500, Math.floor(outPositions.length / 3));
  const maxIndices = outIndices.length;
  const halfW = shatter.widthM * 0.5;
  const halfH = shatter.heightM * 0.5;

  let vCursor = 0;
  let iCursor = 0;
  let fangCount = 0;

  for (let s = 0; s < shatter.shards.length; s++) {
    if (attached[s] === 0) continue;
    const shard = shatter.shards[s];
    const ext = shard.extruded;
    if (ext.vertexCount === 0 || vCursor + ext.vertexCount > maxVerts || iCursor + ext.indexCount > maxIndices) {
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

      const lnz = ext.localNormals[sp3 + 2];
      outNormals[dp3] = ext.localNormals[sp3];
      outNormals[dp3 + 1] = ext.localNormals[sp3 + 1];
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

  return { fangCount, vertexCount: vCursor, indexCount: iCursor };
}

export function pruneUnanchoredFangs(
  shards: ReadonlyArray<VoronoiGlassShardCell>,
  attached: Uint8Array,
  visited: Uint8Array,
  queue: Int32Array,
  detachedOut: number[],
): number {
  const n = shards.length;
  visited.fill(0);
  let head = 0;
  let tail = 0;
  let prunedCount = 0;

  for (let i = 0; i < n; i++) {
    if (attached[i] === 1 && shards[i].touchesFrame) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const cur = queue[head++];
    for (const nb of shards[cur].neighbors) {
      if (attached[nb] === 1 && visited[nb] === 0) {
        visited[nb] = 1;
        queue[tail++] = nb;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (attached[i] === 1 && visited[i] === 0) {
      attached[i] = 0;
      prunedCount++;
      detachedOut.push(i);
    }
  }
  return prunedCount;
}
