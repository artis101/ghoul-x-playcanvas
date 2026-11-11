import * as pc from 'playcanvas';
import { clampByte } from '../math/noiseHelpers.ts';

export function createGleamingBrassCasingMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const size = 64;
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name: 'brassCasingLatheTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  tex.anisotropy = maxAniso;

  const px = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const annealTint = v > 0.76 ? (v - 0.76) / 0.24 : 0;
    const grooveShade = v > 0.05 && v < 0.11 ? 0.72 : 1.0;
    const latheRing = 0.96 + Math.sin(v * Math.PI * 28) * 0.04;
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const r = (242 - annealTint * 34) * grooveShade * latheRing;
      const g = (196 - annealTint * 48) * grooveShade * latheRing;
      const b = (86 + annealTint * 22) * grooveShade * latheRing;
      px[idx] = clampByte(r);
      px[idx + 1] = clampByte(g);
      px[idx + 2] = clampByte(b);
      px[idx + 3] = 255;
    }
  }
  tex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'mayhemGlintingBrassMat';
  mat.diffuseMap = tex;
  mat.emissive = new pc.Color(0.11, 0.075, 0.018);
  mat.useMetalness = true;
  mat.metalness = 0.9;
  mat.gloss = 0.88;
  mat.clearCoat = 0.35;
  mat.clearCoatGloss = 0.92;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.update();
  return mat;
}

export function createShotgunHullMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const width = 64;
  const height = 128;
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name: 'shotgun12gHullTex',
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
    name: 'shotgun12gHullNormalTex',
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
      const isBrassBase = v < 0.3;
      const ribWave = Math.sin(u * Math.PI * 36) * 0.5 + 0.5;
      const crimpLip = v > 0.93 ? 0.78 : 1.0;

      const idx = (y * width + x) * 4;
      if (isBrassBase) {
        const rimRing = v < 0.06 ? 1.06 : 0.98;
        pixels[idx] = clampByte(236 * rimRing);
        pixels[idx + 1] = clampByte(192 * rimRing);
        pixels[idx + 2] = clampByte(82 * rimRing);
        hField[y * width + x] = v < 0.06 ? 0.95 : 0.65;
      } else {
        const ribShade = (0.88 + ribWave * 0.16) * crimpLip;
        pixels[idx] = clampByte(196 * ribShade);
        pixels[idx + 1] = clampByte(18 * ribShade);
        pixels[idx + 2] = clampByte(24 * ribShade);
        hField[y * width + x] = 0.35 + ribWave * 0.35;
      }
      pixels[idx + 3] = 255;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = (x - 1 + width) % width;
      const xp = (x + 1) % width;
      const ym = Math.max(0, y - 1);
      const yp = Math.min(height - 1, y + 1);
      const nx = (hField[y * width + xm] - hField[y * width + xp]) * 2.0;
      const ny = (hField[ym * width + x] - hField[yp * width + x]) * 2.0;
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
  mat.name = 'shotgun12gHullMat';
  mat.diffuseMap = tex;
  mat.normalMap = normalTex;
  mat.bumpiness = 0.62;
  mat.useMetalness = true;
  mat.metalness = 0.28;
  mat.gloss = 0.82;
  mat.clearCoat = 0.42;
  mat.clearCoatGloss = 0.86;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.update();
  return mat;
}
