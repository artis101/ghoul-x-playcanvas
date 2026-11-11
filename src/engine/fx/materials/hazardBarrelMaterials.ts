import * as pc from 'playcanvas';
import { clampByte, hash2d, valueNoise2d } from '../math/noiseHelpers.ts';

export function createHazardBarrelMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const width = 128;
  const height = 256;
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name: 'hazardDrumTex',
    width,
    height,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  tex.anisotropy = maxAniso;

  const normalTex = new pc.Texture(device, {
    name: 'hazardDrumNormalTex',
    width,
    height,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  normalTex.anisotropy = maxAniso;

  const pixels = tex.lock() as Uint8Array;
  const nPixels = normalTex.lock() as Uint8Array;
  const hField = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const grit = (hash2d(x, y, 71) - 0.5) * 16;
      const scratch = valueNoise2d(u, v, 24, 173);

      let r = 192 + grit;
      let g = 22 + grit * 0.3;
      let b = 20 + grit * 0.3;

      const isRimRing =
        v < 0.045 ||
        v > 0.955 ||
        Math.abs(v - 0.33) < 0.024 ||
        Math.abs(v - 0.67) < 0.024;

      let heightVal = scratch * 0.25;
      if (isRimRing) {
        r = 88 + grit + (scratch > 0.72 ? 36 : 0);
        g = 90 + grit + (scratch > 0.72 ? 36 : 0);
        b = 96 + grit + (scratch > 0.72 ? 38 : 0);
        heightVal = 0.85 + scratch * 0.15;
      } else if (v > 0.37 && v < 0.63) {
        const inChevronBand = v < 0.425 || v > 0.575;
        const stripe = ((Math.floor(u * 18 + v * 30) % 2) + 2) % 2 === 0;
        if (inChevronBand && stripe) {
          r = 24 + grit * 0.35;
          g = 23 + grit * 0.35;
          b = 22 + grit * 0.35;
        } else {
          r = 238 + grit * 0.5;
          g = 194 + grit * 0.5;
          b = 22 + grit * 0.3;
        }
        heightVal = 0.35 + scratch * 0.15;
      }

      hField[y * width + x] = heightVal;
      const idx = (y * width + x) * 4;
      pixels[idx] = clampByte(r);
      pixels[idx + 1] = clampByte(g);
      pixels[idx + 2] = clampByte(b);
      pixels[idx + 3] = 255;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = (x - 1 + width) % width;
      const xp = (x + 1) % width;
      const ym = Math.max(0, y - 1);
      const yp = Math.min(height - 1, y + 1);
      const nx = (hField[y * width + xm] - hField[y * width + xp]) * 2.2;
      const ny = (hField[ym * width + x] - hField[yp * width + x]) * 2.2;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * width + x) * 4;
      nPixels[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 3] = 255;
    }
  }

  tex.unlock();
  normalTex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'hazardBarrelRedMat';
  mat.diffuseMap = tex;
  mat.normalMap = normalTex;
  mat.bumpiness = 0.72;
  mat.useMetalness = true;
  mat.metalness = 0.42;
  mat.gloss = 0.68;
  mat.clearCoat = 0.25;
  mat.clearCoatGloss = 0.78;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.update();
  return mat;
}

export function createCharredBarrelMaterial(): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.name = 'charredBarrelRemnantMat';
  mat.diffuse = new pc.Color(0.08, 0.075, 0.075);
  mat.emissive = new pc.Color(0.09, 0.022, 0.005);
  mat.useMetalness = true;
  mat.metalness = 0.35;
  mat.gloss = 0.26;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.update();
  return mat;
}
