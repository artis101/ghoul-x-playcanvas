import { GLASS_SHARD_STYLE_ARMORED } from './glassShardTypes.ts';
import type { GlassShardBatchedMeshStats } from './glassShardTypes.ts';
import type { GlassShardPool } from './glassShardPool.ts';

export function writeBatchedMeshBuffers(
  pool: GlassShardPool,
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

  for (let s = 0; s < pool.activeCount; s++) {
    const vCount = pool.shardVertCount[s];
    const idxCount = pool.shardIndexCount[s];
    if (vCount === 0 || idxCount === 0) continue;
    if (vCursor + vCount > maxVerticesFit || iCursor + idxCount > maxIndicesFit) {
      break;
    }

    const tx = pool.posX[s];
    const ty = pool.posY[s];
    const tz = pool.posZ[s];

    const qx = pool.quatX[s];
    const qy = pool.quatY[s];
    const qz = pool.quatZ[s];
    const qw = pool.quatW[s];
    const scale = pool.fadeScale[s];
    const isArmoredChunk = pool.shardStyle[s] === GLASS_SHARD_STYLE_ARMORED;

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

    const srcPosBase = s * pool.maxVertsPerShard * 3;
    const srcUvBase = s * pool.maxVertsPerShard * 2;
    const srcIdxBase = s * pool.maxIndicesPerShard;

    for (let v = 0; v < vCount; v++) {
      const sp3 = srcPosBase + v * 3;
      const lx = pool.localPosArena[sp3];
      const ly = pool.localPosArena[sp3 + 1];
      const lz = pool.localPosArena[sp3 + 2];

      const lnx = pool.localNormArena[sp3];
      const lny = pool.localNormArena[sp3 + 1];
      const lnz = pool.localNormArena[sp3 + 2];

      const dp3 = (vCursor + v) * 3;
      outPositions[dp3] = m00 * lx + m01 * ly + m02 * lz + tx;
      outPositions[dp3 + 1] = m10 * lx + m11 * ly + m12 * lz + ty;
      outPositions[dp3 + 2] = m20 * lx + m21 * ly + m22 * lz + tz;

      outNormals[dp3] = r00 * lnx + r01 * lny + r02 * lnz;
      outNormals[dp3 + 1] = r10 * lnx + r11 * lny + r12 * lnz;
      outNormals[dp3 + 2] = r20 * lnx + r21 * lny + r22 * lnz;

      const sp2 = srcUvBase + v * 2;
      const dp2 = (vCursor + v) * 2;
      outUvs[dp2] = pool.localUvArena[sp2];
      outUvs[dp2 + 1] = pool.localUvArena[sp2 + 1];

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
      outIndices[iCursor + k] = vCursor + pool.localIdxArena[srcIdxBase + k];
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
