import * as pc from 'playcanvas';
import { clampByte } from './proceduralNoise.ts';

export function getDeviceAnisotropy(device: pc.GraphicsDevice): number {
  if (device instanceof pc.NullGraphicsDevice) {
    return 1;
  }
  return Math.max(1, Math.min(16, device.maxAnisotropy || 1));
}

/**
 * Generates paired tangent-space normal map + monochrome gloss map from a tileable height/gloss field.
 */
export function createProceduralNormalAndGlossMaps(
  device: pc.GraphicsDevice,
  baseName: string,
  size: number,
  heightAndGloss: (x: number, y: number, u: number, v: number) => { height: number; gloss: number },
  normalStrength = 2.4
): { normalMap: pc.Texture; glossMap: pc.Texture } {
  const heights = new Float32Array(size * size);
  const glosses = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sample = heightAndGloss(x, y, x / size, y / size);
      const i = y * size + x;
      heights[i] = sample.height;
      glosses[i] = sample.gloss;
    }
  }

  const aniso = getDeviceAnisotropy(device);
  const normalMap = new pc.Texture(device, {
    name: `${baseName}_normal`,
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
    anisotropy: aniso,
  });

  const glossMap = new pc.Texture(device, {
    name: `${baseName}_gloss`,
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
    anisotropy: aniso,
  });

  const nPixels = normalMap.lock() as Uint8Array;
  const gPixels = glossMap.lock() as Uint8Array;

  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;

      const hL = heights[y * size + xm];
      const hR = heights[y * size + xp];
      const hD = heights[ym * size + x];
      const hU = heights[yp * size + x];

      const dx = (hL - hR) * normalStrength;
      const dy = (hD - hU) * normalStrength;
      const dz = 1.0;
      const invLen = 1.0 / Math.hypot(dx, dy, dz);

      const idx = (y * size + x) * 4;
      nPixels[idx] = clampByte((dx * invLen * 0.5 + 0.5) * 255);
      nPixels[idx + 1] = clampByte((dy * invLen * 0.5 + 0.5) * 255);
      nPixels[idx + 2] = clampByte((dz * invLen * 0.5 + 0.5) * 255);
      nPixels[idx + 3] = 255;

      const gByte = clampByte(glosses[y * size + x] * 255);
      gPixels[idx] = gByte;
      gPixels[idx + 1] = gByte;
      gPixels[idx + 2] = gByte;
      gPixels[idx + 3] = 255;
    }
  }

  normalMap.unlock();
  glossMap.unlock();
  return { normalMap, glossMap };
}
