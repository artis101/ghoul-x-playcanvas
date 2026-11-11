import * as pc from 'playcanvas';
import { clampByte, valueNoise2d } from '../goreNoise.ts';

export function createFleshMuscleTextures(
  device: pc.GraphicsDevice,
  maxAniso: number,
): { fleshTex: pc.Texture; fleshNormalTex: pc.Texture } {
  const fSize = 64;
  const fleshTex = new pc.Texture(device, {
    name: 'goreMuscleFasciaTex',
    width: fSize,
    height: fSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  fleshTex.anisotropy = maxAniso;

  const fleshNormalTex = new pc.Texture(device, {
    name: 'goreMuscleNormalTex',
    width: fSize,
    height: fSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  fleshNormalTex.anisotropy = maxAniso;

  const fPx = fleshTex.lock() as Uint8Array;
  const fnPx = fleshNormalTex.lock() as Uint8Array;
  const fleshH = new Float32Array(fSize * fSize);

  for (let y = 0; y < fSize; y++) {
    for (let x = 0; x < fSize; x++) {
      const u = x / fSize;
      const v = y / fSize;
      const warp = valueNoise2d(u, v, 5, 1607) * 0.25;
      const fiber = Math.sin((u + warp) * Math.PI * 14) * 0.5 + 0.5;
      const marbling = valueNoise2d(u, v, 9, 1721);
      const fasciaBand = marbling > 0.76 ? (marbling - 0.76) / 0.24 : 0;

      fleshH[y * fSize + x] = fiber * 0.55 + marbling * 0.45;

      const r = 98 + fiber * 34 + fasciaBand * 88;
      const g = 10 + fiber * 8 + fasciaBand * 62;
      const b = 15 + fiber * 9 + fasciaBand * 58;
      const idx = (y * fSize + x) * 4;
      fPx[idx] = clampByte(r);
      fPx[idx + 1] = clampByte(g);
      fPx[idx + 2] = clampByte(b);
      fPx[idx + 3] = 255;
    }
  }

  for (let y = 0; y < fSize; y++) {
    for (let x = 0; x < fSize; x++) {
      const hL = fleshH[y * fSize + ((x - 1 + fSize) % fSize)];
      const hR = fleshH[y * fSize + ((x + 1) % fSize)];
      const hD = fleshH[((y - 1 + fSize) % fSize) * fSize + x];
      const hU = fleshH[((y + 1) % fSize) * fSize + x];
      const nx = (hL - hR) * 2.2;
      const ny = (hD - hU) * 2.2;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * fSize + x) * 4;
      fnPx[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
      fnPx[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
      fnPx[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      fnPx[idx + 3] = 255;
    }
  }
  fleshTex.unlock();
  fleshNormalTex.unlock();

  return { fleshTex, fleshNormalTex };
}
