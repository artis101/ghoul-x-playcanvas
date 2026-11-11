import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { hash2D, sampleCraterMorphology } from './craterNoise.ts';

export const MAX_SHADER_WORLD_CRATERS = 16;

export interface ProceduralCraterTextures {
  readonly resolution: number;
  readonly heightMap: pc.Texture;
  readonly normalMap: pc.Texture;
  readonly scorchDiffuseMap: pc.Texture;
}

export interface CraterImpactRecord {
  pointWorld: Vec3Like;
  normalWorld: Vec3Like;
  radiusM: number;
  depthM: number;
}

export function createRgbaTexture(
  device: pc.GraphicsDevice,
  name: string,
  resolution: number,
  pixels: Uint8Array,
): pc.Texture {
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name,
    width: resolution,
    height: resolution,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    anisotropy: Math.max(1, maxAniso),
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const locked = tex.lock();
  locked.set(pixels);
  tex.unlock();
  return tex;
}

export function createProceduralCraterTextures(
  device: pc.GraphicsDevice,
  resolution = 256,
): ProceduralCraterTextures {
  const size = Math.max(16, Math.floor(resolution));
  const totalTexels = size * size;
  const heightField = new Float32Array(totalTexels);
  const crackField = new Float32Array(totalTexels);
  const spallField = new Float32Array(totalTexels);
  const smearField = new Float32Array(totalTexels);
  const aggField = new Float32Array(totalTexels);
  const edgeNoiseField = new Float32Array(totalTexels);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const idx = y * size + x;
      const sample = sampleCraterMorphology(u, v);
      heightField[idx] = sample.height;
      crackField[idx] = sample.crackIntensity;
      spallField[idx] = sample.spallRimMask;
      smearField[idx] = sample.bulletSmearMask;
      aggField[idx] = sample.aggregateContrast;
      edgeNoiseField[idx] = sample.outerEdgeNoise;
    }
  }

  const heightPixels = new Uint8Array(totalTexels * 4);
  const normalPixels = new Uint8Array(totalTexels * 4);
  const scorchPixels = new Uint8Array(totalTexels * 4);
  const normalStrength = 4.25;

  for (let y = 0; y < size; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(size - 1, y + 1);
    const v = (y + 0.5) / size;

    for (let x = 0; x < size; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(size - 1, x + 1);
      const u = (x + 0.5) / size;
      const idx = y * size + x;
      const p4 = idx * 4;

      const h = heightField[idx];
      const hByte = Math.max(0, Math.min(255, Math.round(h * 255)));
      heightPixels[p4] = hByte;
      heightPixels[p4 + 1] = hByte;
      heightPixels[p4 + 2] = hByte;
      heightPixels[p4 + 3] = 255;

      const hTL = heightField[ym * size + xm];
      const hT = heightField[ym * size + x];
      const hTR = heightField[ym * size + xp];
      const hL = heightField[y * size + xm];
      const hR = heightField[y * size + xp];
      const hBL = heightField[yp * size + xm];
      const hB = heightField[yp * size + x];
      const hBR = heightField[yp * size + xp];

      const dhdx = ((hTR + 2 * hR + hBR) - (hTL + 2 * hL + hBL)) * 0.125 * size * 0.042;
      const dhdy = ((hBL + 2 * hB + hBR) - (hTL + 2 * hT + hTR)) * 0.125 * size * 0.042;

      let nx = -dhdx * normalStrength;
      let ny = -dhdy * normalStrength;
      let nz = 1.0;
      const nLen = Math.hypot(nx, ny, nz);
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      normalPixels[p4] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
      normalPixels[p4 + 1] = Math.max(0, Math.min(255, Math.round((ny * 0.5 + 0.5) * 255)));
      normalPixels[p4 + 2] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
      normalPixels[p4 + 3] = 255;

      const r = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2);
      const depthFactor = Math.max(0, Math.min(1, (0.82 - h) / 0.78));
      const crackAo = crackField[idx];
      const spallRim = spallField[idx];
      const smear = smearField[idx];
      const aggSpeckle = (aggField[idx] - 0.45) * 34;
      const fineGrain = (hash2D(x * 5 + 11, y * 7 + 19) - 0.5) * 18;

      let lum = 134 - depthFactor * 104 + spallRim * 76 - crackAo * 78 + aggSpeckle * (0.35 + 0.65 * depthFactor) + fineGrain;
      let red = lum;
      let green = lum - 2;
      let blue = lum - 5;

      if (smear > 0.02) {
        const glint = hash2D(x * 3 + 29, y * 3 + 41) > 0.68 ? 1.0 : 0.0;
        const b = smear * 0.78;
        red = red * (1 - b) + (64 + glint * 38) * b;
        green = green * (1 - b) + (66 + glint * 24) * b;
        blue = blue * (1 - b) + (74 + glint * 10) * b;
      }

      const irregularR = r + edgeNoiseField[idx] * 0.16 - crackAo * 0.08;
      let alpha = 1;
      if (irregularR >= 0.94) {
        alpha = 0;
      } else if (irregularR > 0.58) {
        const fadeT = (irregularR - 0.58) / (0.94 - 0.58);
        alpha = 1 - fadeT * fadeT * (3 - 2 * fadeT);
      }

      scorchPixels[p4] = Math.max(14, Math.min(238, Math.round(red)));
      scorchPixels[p4 + 1] = Math.max(14, Math.min(236, Math.round(green)));
      scorchPixels[p4 + 2] = Math.max(14, Math.min(234, Math.round(blue)));
      scorchPixels[p4 + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
    }
  }

  return {
    resolution: size,
    heightMap: createRgbaTexture(device, 'ConcreteCraterHeightPOM', size, heightPixels),
    normalMap: createRgbaTexture(device, 'ConcreteCraterNormalPOM', size, normalPixels),
    scorchDiffuseMap: createRgbaTexture(device, 'ConcreteCraterScorchPOM', size, scorchPixels),
  };
}
