import * as pc from 'playcanvas';
import { clampByte, hash2d, valueNoise2d } from './proceduralNoise.ts';
import { getDeviceAnisotropy } from './proceduralNormalGloss.ts';

export type RGB = [number, number, number];

export function createTacticalAlbedoTexture(
  device: pc.GraphicsDevice,
  name: string,
  size: number,
  painter: (x: number, y: number, u: number, v: number) => RGB,
  bloodSplatterSeed = 0
): pc.Texture {
  const tex = new pc.Texture(device, {
    name,
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
    anisotropy: getDeviceAnisotropy(device),
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let [r, g, b] = painter(x, y, u, v);

      const grain = (hash2d(x, y, 17) - 0.5) * 4.0;
      r += grain;
      g += grain;
      b += grain;

      if (bloodSplatterSeed > 0) {
        const cx = u - 0.5;
        const cy = v - 0.5;
        const n1 = valueNoise2d(u * 12, v * 12, 12, bloodSplatterSeed);
        const n2 = hash2d(x, y, bloodSplatterSeed + 99);
        const dist = Math.sqrt(cx * cx * 0.8 + cy * cy * 1.1) - n1 * 0.28;
        if (dist < 0.14) {
          r = n2 > 0.35 ? 108 : 68;
          g = n2 > 0.35 ? 9 : 5;
          b = n2 > 0.35 ? 12 : 7;
        } else if (dist < 0.28 || n1 > 0.82) {
          r = r * 0.28 + 112 * 0.72;
          g = g * 0.12 + 8 * 0.88;
          b = b * 0.12 + 11 * 0.88;
        }
      }

      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(r);
      pixels[idx + 1] = clampByte(g);
      pixels[idx + 2] = clampByte(b);
      pixels[idx + 3] = 255;
    }
  }
  tex.unlock();
  return tex;
}
