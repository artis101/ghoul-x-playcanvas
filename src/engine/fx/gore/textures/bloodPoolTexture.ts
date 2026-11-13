import * as pc from 'playcanvas';
import { clampByte, valueNoise2d } from '../goreNoise.ts';

export function createDropletNormalTexture(device: pc.GraphicsDevice, maxAniso: number): pc.Texture {
  const dropNSize = 64;
  const dropNormalTex = new pc.Texture(device, {
    name: 'goreDropletNormalTex',
    width: dropNSize,
    height: dropNSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  dropNormalTex.anisotropy = maxAniso;
  const dnPx = dropNormalTex.lock() as Uint8Array;
  const dropH = new Float32Array(dropNSize * dropNSize);
  for (let y = 0; y < dropNSize; y++) {
    for (let x = 0; x < dropNSize; x++) {
      const u = x / dropNSize;
      const v = y / dropNSize;
      dropH[y * dropNSize + x] =
        valueNoise2d(u, v, 6, 307) * 0.65 + valueNoise2d(u, v, 14, 613) * 0.35;
    }
  }
  for (let y = 0; y < dropNSize; y++) {
    for (let x = 0; x < dropNSize; x++) {
      const hL = dropH[y * dropNSize + ((x - 1 + dropNSize) % dropNSize)];
      const hR = dropH[y * dropNSize + ((x + 1) % dropNSize)];
      const hD = dropH[((y - 1 + dropNSize) % dropNSize) * dropNSize + x];
      const hU = dropH[((y + 1) % dropNSize) * dropNSize + x];
      const nx = (hL - hR) * 1.4;
      const ny = (hD - hU) * 1.4;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * dropNSize + x) * 4;
      dnPx[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
      dnPx[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
      dnPx[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      dnPx[idx + 3] = 255;
    }
  }
  dropNormalTex.unlock();
  return dropNormalTex;
}

/**
 * Albedo + alpha for a floor pool: one dark, grimy maroon with a soft edge and a few satellite
 * drops. The tone carries no light rim on purpose — overlapping pools then merge into a single puddle
 * instead of showing every blob's rim.
 */
export function createBloodPoolTextures(
  device: pc.GraphicsDevice,
  maxAniso: number,
): { poolTex: pc.Texture } {
  const pSize = 128;
  const poolTex = new pc.Texture(device, {
    name: 'gorePoolAlbedoAlphaTex',
    width: pSize,
    height: pSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  poolTex.anisotropy = maxAniso;
  fillBloodPoolPixels(poolTex.lock() as Uint8Array, pSize, [66, 9, 7]);
  poolTex.unlock();
  return { poolTex };
}

/** Writes an irregular puddle silhouette in a single colour into an RGBA8 buffer. */
export function fillBloodPoolPixels(px: Uint8Array, size: number, rgb: readonly [number, number, number]): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // Domain-warp the radius so the outline wanders like liquid instead of forming clean lobes.
      const wu = u + (valueNoise2d(u, v, 3, 211) - 0.5) * 0.16;
      const wv = v + (valueNoise2d(u, v, 3, 307) - 0.5) * 0.16;
      const rad = Math.hypot(wu - 0.5, wv - 0.5);
      const edgeNoise =
        (valueNoise2d(u, v, 5, 811) - 0.5) * 0.12 +
        (valueNoise2d(u, v, 11, 929) - 0.5) * 0.05;
      const edgeDist = 0.37 + edgeNoise - rad;

      let alpha = 0;
      if (edgeDist > 0.012) {
        alpha = 0.95;
      } else if (edgeDist > -0.006) {
        const t = (edgeDist + 0.006) / 0.018;
        alpha = t * t * (3 - 2 * t) * 0.95;
      } else if (edgeDist > -0.07 && valueNoise2d(u, v, 30, 1103) > 0.84) {
        alpha = 0.9;
      }

      // Grimy, painted mottling like the room's tiles: blotchy dried patches and fine grit.
      const blotch = valueNoise2d(u, v, 7, 1301);
      const grit = valueNoise2d(u, v, 48, 1409);
      const dried = edgeDist < 0.05 ? 0.82 + (edgeDist / 0.05) * 0.18 : 1;
      const shade = (0.62 + blotch * 0.38) * (0.86 + grit * 0.14) * dried;
      const idx = (y * size + x) * 4;
      px[idx] = clampByte(rgb[0] * shade);
      px[idx + 1] = clampByte(rgb[1] * shade);
      px[idx + 2] = clampByte(rgb[2] * shade);
      px[idx + 3] = clampByte(alpha * 255);
    }
  }
}
