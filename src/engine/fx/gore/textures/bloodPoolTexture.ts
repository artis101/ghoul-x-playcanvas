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

export function createBloodPoolTextures(
  device: pc.GraphicsDevice,
  maxAniso: number,
): { poolTex: pc.Texture; poolNormalTex: pc.Texture } {
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

  const poolNormalTex = new pc.Texture(device, {
    name: 'gorePoolMeniscusNormalTex',
    width: pSize,
    height: pSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  poolNormalTex.anisotropy = maxAniso;

  const pPx = poolTex.lock() as Uint8Array;
  const pnPx = poolNormalTex.lock() as Uint8Array;
  const poolHeight = new Float32Array(pSize * pSize);

  for (let y = 0; y < pSize; y++) {
    for (let x = 0; x < pSize; x++) {
      const u = (x + 0.5) / pSize;
      const v = (y + 0.5) / pSize;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const angle = Math.atan2(dy, dx);
      const rad = Math.hypot(dx, dy);

      const lobeWarp =
        Math.sin(angle * 3.0 + 0.7) * 0.055 +
        Math.cos(angle * 5.0 - 1.2) * 0.035 +
        (valueNoise2d(u, v, 7, 811) - 0.5) * 0.095 +
        (valueNoise2d(u, v, 15, 929) - 0.5) * 0.045;

      const edgeDist = 0.41 + lobeWarp - rad;
      let alpha = 0;
      if (edgeDist > 0.032) {
        alpha = 0.97;
      } else if (edgeDist > 0) {
        const t = edgeDist / 0.032;
        alpha = t * t * (3 - 2 * t) * 0.97;
      } else if (edgeDist > -0.055) {
        const sat = valueNoise2d(u, v, 26, 1103);
        if (sat > 0.83) {
          alpha = ((sat - 0.83) / 0.17) * 0.88;
        }
      }

      const meniscus =
        alpha > 0.05
          ? Math.min(1.0, edgeDist * 12.0) * (1.0 + Math.exp(-Math.pow((edgeDist - 0.025) / 0.022, 2)) * 0.42)
          : 0;
      poolHeight[y * pSize + x] = meniscus;

      const depthFactor = Math.max(0, Math.min(1, edgeDist / 0.24));
      const rCol = 96 * (1 - depthFactor * 0.58) + 22;
      const gCol = 5 * (1 - depthFactor * 0.5) + 1;
      const bCol = 8 * (1 - depthFactor * 0.45) + 2;

      const idx = (y * pSize + x) * 4;
      pPx[idx] = clampByte(rCol);
      pPx[idx + 1] = clampByte(gCol);
      pPx[idx + 2] = clampByte(bCol);
      pPx[idx + 3] = clampByte(alpha * 255);
    }
  }

  for (let y = 0; y < pSize; y++) {
    for (let x = 0; x < pSize; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(pSize - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(pSize - 1, y + 1);
      const nx = (poolHeight[y * pSize + xm] - poolHeight[y * pSize + xp]) * 2.8;
      const ny = (poolHeight[ym * pSize + x] - poolHeight[yp * pSize + x]) * 2.8;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * pSize + x) * 4;
      pnPx[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
      pnPx[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
      pnPx[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      pnPx[idx + 3] = 255;
    }
  }
  poolTex.unlock();
  poolNormalTex.unlock();
  return { poolTex, poolNormalTex };
}
