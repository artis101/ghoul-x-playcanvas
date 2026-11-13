import * as pc from 'playcanvas';
import { clampByte, hash2d } from '../fx/gore/goreNoise.ts';

const SIZE = 128;
const cache = new WeakMap<pc.GraphicsDevice, pc.Texture>();

/** Value noise whose lattice wraps every `freq` cells, so the texture tiles without seams. */
function periodicNoise(u: number, v: number, freqU: number, freqV: number, seed: number): number {
  const x = u * freqU;
  const y = v * freqV;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const wx = (n: number): number => ((n % freqU) + freqU) % freqU;
  const wy = (n: number): number => ((n % freqV) + freqV) % freqV;
  const n00 = hash2d(wx(x0), wy(y0), seed);
  const n10 = hash2d(wx(x0 + 1), wy(y0), seed);
  const n01 = hash2d(wx(x0), wy(y0 + 1), seed);
  const n11 = hash2d(wx(x0 + 1), wy(y0 + 1), seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * A tiling stain multiplied over a body part's painted texture once it is wounded: white where the
 * cloth or skin is clean, soaked maroon blotches with downward runs where blood has spread.
 */
export function getBloodSoakDetailTexture(device: pc.GraphicsDevice): pc.Texture {
  const cached = cache.get(device);
  if (cached) return cached;

  const tex = new pc.Texture(device, {
    name: 'goreBloodSoakDetailTex',
    width: SIZE,
    height: SIZE,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  const px = tex.lock() as Uint8Array;

  for (let y = 0; y < SIZE; y++) {
    const v = y / SIZE;
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const blotch =
        periodicNoise(u, v, 4, 4, 71) * 0.55 +
        periodicNoise(u, v, 8, 8, 133) * 0.3 +
        periodicNoise(u, v, 16, 16, 257) * 0.15;
      // Runs: noise stretched along V so soaked areas trail into streaks.
      const runs = periodicNoise(u, v, 24, 3, 419);
      const soak = Math.max(blotch, blotch * 0.7 + runs * 0.42);
      const speck = periodicNoise(u, v, 64, 64, 587) > 0.86 ? 0.75 : 0;

      const mask = Math.max(smoothstep(0.5, 0.56, soak), speck);
      const depth = smoothstep(0.56, 0.78, soak);
      // Fresh soak is a dull, gritty brown-red; the heart of a blotch is near-black dried maroon.
      const grit = 0.82 + periodicNoise(u, v, 32, 32, 653) * 0.18;
      const r = 1 + (0.4 * grit - depth * 0.2 - 1) * mask;
      const g = 1 + (0.07 * grit - depth * 0.035 - 1) * mask;
      const b = 1 + (0.05 * grit - depth * 0.025 - 1) * mask;

      const i = (y * SIZE + x) * 4;
      px[i] = clampByte(r * 255);
      px[i + 1] = clampByte(g * 255);
      px[i + 2] = clampByte(b * 255);
      px[i + 3] = 255;
    }
  }
  tex.unlock();
  cache.set(device, tex);
  return tex;
}
