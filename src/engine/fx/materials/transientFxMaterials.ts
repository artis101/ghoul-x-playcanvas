import * as pc from 'playcanvas';
import { clampByte, valueNoise2d } from '../math/noiseHelpers.ts';

export function createSoftCloudTexture(
  device: pc.GraphicsDevice,
  name: string,
  seed: number,
): pc.Texture {
  const size = 64;
  const tex = new pc.Texture(device, {
    name,
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const px = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const d = Math.hypot(u - 0.5, v - 0.5) * 2.0;
      const n = valueNoise2d(u, v, 5, seed) * 0.62 + valueNoise2d(u, v, 11, seed + 97) * 0.38;
      const radial = Math.max(0, 1 - d * d);
      const alpha = radial * radial * (0.42 + n * 0.58);
      const lum = clampByte(205 + n * 50);
      const idx = (y * size + x) * 4;
      px[idx] = lum;
      px[idx + 1] = lum;
      px[idx + 2] = lum;
      px[idx + 3] = clampByte(alpha * 255);
    }
  }
  tex.unlock();
  return tex;
}

export function createShockwaveRingTexture(device: pc.GraphicsDevice): pc.Texture {
  const size = 64;
  const tex = new pc.Texture(device, {
    name: 'mayhemBlastShockwaveRingTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const px = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2.0;
      const ringBand = Math.exp(-Math.pow((r - 0.78) / 0.11, 2));
      const wisp = 0.72 + valueNoise2d(u, v, 9, 2207) * 0.28;
      const alpha = r <= 1.0 ? ringBand * wisp : 0;
      const idx = (y * size + x) * 4;
      px[idx] = 255;
      px[idx + 1] = 216;
      px[idx + 2] = 158;
      px[idx + 3] = clampByte(alpha * 255);
    }
  }
  tex.unlock();
  return tex;
}

export function createStreakGlowTexture(device: pc.GraphicsDevice): pc.Texture {
  const w = 16;
  const h = 64;
  const tex = new pc.Texture(device, {
    name: 'mayhemTracerStreakTex',
    width: w,
    height: h,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const px = tex.lock() as Uint8Array;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const longFade = v < 0.78 ? Math.pow(v / 0.78, 1.5) : Math.sin(((1 - v) / 0.22) * (Math.PI * 0.5));
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const crossFade = Math.max(0, 1 - Math.abs(u - 0.5) * 2.0);
      const alpha = longFade * crossFade * crossFade;
      const idx = (y * w + x) * 4;
      px[idx] = 255;
      px[idx + 1] = clampByte(215 + v * 40);
      px[idx + 2] = clampByte(145 + v * 95);
      px[idx + 3] = clampByte(alpha * 255);
    }
  }
  tex.unlock();
  return tex;
}
