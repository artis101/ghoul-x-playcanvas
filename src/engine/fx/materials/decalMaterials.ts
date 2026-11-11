import * as pc from 'playcanvas';
import { clampByte, hash2d, valueNoise2d } from '../math/noiseHelpers.ts';

export function createScorchDecalMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const size = 128;
  const tex = new pc.Texture(device, {
    name: 'barrelScorchTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const angle = Math.atan2(dy, dx);
      const sootRay = Math.sin(angle * 11.0) * 0.04 + Math.cos(angle * 19.0) * 0.03;
      const rayNoise = valueNoise2d(u, v, 9, 409) * 0.12;
      const fineNoise = hash2d(x, y, 419) * 0.05;
      const dist = Math.hypot(dx, dy) - sootRay - rayNoise - fineNoise;

      const alpha = Math.max(0, Math.min(1, (0.42 - dist) / 0.24));
      const ashTint = dist > 0.22 ? 26 : 12;
      const idx = (y * size + x) * 4;
      pixels[idx] = ashTint;
      pixels[idx + 1] = ashTint - 2;
      pixels[idx + 2] = ashTint - 2;
      pixels[idx + 3] = clampByte(alpha * 238);
    }
  }
  tex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'barrelFloorScorchMat';
  mat.diffuse = new pc.Color(0.05, 0.045, 0.045);
  mat.opacityMap = tex;
  mat.opacityMapChannel = 'a';
  mat.blendType = pc.BLEND_NORMAL;
  mat.depthWrite = false;
  mat.update();
  return mat;
}

export function createBloodSplatterMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const size = 128;
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name: 'goreWallSplatterTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  tex.anisotropy = maxAniso;

  const normalTex = new pc.Texture(device, {
    name: 'goreWallSplatterNormalTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  normalTex.anisotropy = maxAniso;

  const pixels = tex.lock() as Uint8Array;
  const nPixels = normalTex.lock() as Uint8Array;
  const heightField = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dx = u - 0.5;
      const dy = v - 0.54;
      const angle = Math.atan2(dy, dx);

      const radialFinger =
        Math.pow(Math.max(0, Math.sin(angle * 7.0 + 0.4)), 2.0) * 0.085 +
        Math.pow(Math.max(0, Math.cos(angle * 13.0 - 1.1)), 3.0) * 0.065;
      const organicWarp = (valueNoise2d(u, v, 8, 911) - 0.5) * 0.11;
      const drip =
        u > 0.32 && u < 0.68 && v < 0.46
          ? Math.pow(valueNoise2d(u * 2.2, v * 0.45, 7, 977), 2.2) * 0.19
          : 0;
      const speckle = valueNoise2d(u, v, 24, 953);

      const dist = Math.hypot(dx, dy * 0.92) - radialFinger - organicWarp - drip;
      let alpha = 0;
      if (dist < 0.22) {
        alpha = 0.97;
      } else if (dist < 0.31) {
        const t = (0.31 - dist) / 0.09;
        alpha = t * t * (3 - 2 * t) * 0.94;
      } else if (dist < 0.45 && speckle > 0.79) {
        alpha = ((speckle - 0.79) / 0.21) * 0.9;
      }

      heightField[y * size + x] = alpha > 0.05 ? Math.min(1.0, alpha * 0.8 + (dist < 0.24 ? 0.2 : 0)) : 0;

      const coreDark = dist < 0.13 ? 0.56 : dist < 0.22 ? 0.78 : 1.0;
      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(112 * coreDark);
      pixels[idx + 1] = clampByte(6 * coreDark);
      pixels[idx + 2] = clampByte(10 * coreDark);
      pixels[idx + 3] = clampByte(alpha * 255);
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(size - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(size - 1, y + 1);
      const nx = (heightField[y * size + xm] - heightField[y * size + xp]) * 2.6;
      const ny = (heightField[ym * size + x] - heightField[yp * size + x]) * 2.6;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * size + x) * 4;
      nPixels[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 3] = 255;
    }
  }

  tex.unlock();
  normalTex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'wetWallBloodSplatterMat';
  mat.diffuseMap = tex;
  mat.opacityMap = tex;
  mat.opacityMapChannel = 'a';
  mat.normalMap = normalTex;
  mat.bumpiness = 0.78;
  mat.useMetalness = true;
  mat.metalness = 0.1;
  mat.gloss = 0.9;
  mat.clearCoat = 0.88;
  mat.clearCoatGloss = 0.95;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.blendType = pc.BLEND_NORMAL;
  mat.depthWrite = false;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();
  return mat;
}
