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


  const pixels = tex.lock() as Uint8Array;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // Gritty back-spatter: a ragged, grainy core that breaks up into a spray of specks and a few
      // runs dripping down, instead of a smooth star with glossy fingers.
      const dx = u - 0.5;
      const dy = v - 0.5;
      const warp = (valueNoise2d(u, v, 6, 911) - 0.5) * 0.16 + (valueNoise2d(u, v, 14, 913) - 0.5) * 0.07;
      const dist = Math.hypot(dx, dy) + warp;
      const grain = valueNoise2d(u, v, 40, 953);
      const speck = valueNoise2d(u, v, 30, 967);
      const run = u > 0.36 && u < 0.64 && v > 0.5
        ? Math.max(0, valueNoise2d(u, 0.5, 26, 977) - 0.72) * (1 - (v - 0.5) / 0.5) * 3.4
        : 0;

      let alpha = 0;
      if (dist < 0.16) {
        alpha = 0.92 * (0.75 + grain * 0.25);
      } else if (dist < 0.26) {
        const t = (0.26 - dist) / 0.1;
        alpha = Math.max(0, t * 1.2 - (1 - grain) * 0.5) * 0.9;
      } else if (dist < 0.48 && speck > 0.8 - (0.48 - dist) * 0.25) {
        alpha = 0.85;
      }
      alpha = Math.max(alpha, Math.min(0.85, run));

      const coreDark = (0.55 + grain * 0.3) * (dist < 0.1 ? 0.75 : 1.0);
      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(92 * coreDark);
      pixels[idx + 1] = clampByte(12 * coreDark);
      pixels[idx + 2] = clampByte(9 * coreDark);
      pixels[idx + 3] = clampByte(alpha * 255);
    }
  }

  tex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'wetWallBloodSplatterMat';
  mat.diffuseMap = tex;
  mat.opacityMap = tex;
  mat.opacityMapChannel = 'a';
  mat.useMetalness = true;
  mat.metalness = 0;
  mat.gloss = 0.45;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.blendType = pc.BLEND_NORMAL;
  mat.depthWrite = false;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();
  return mat;
}
