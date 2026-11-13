import * as pc from 'playcanvas';
import { fillBloodPoolPixels } from '../../fx/gore/textures/bloodPoolTexture.ts';

function hash2d(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise2d(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const n00 = hash2d(ix, iy, seed);
  const n10 = hash2d(ix + 1, iy, seed);
  const n01 = hash2d(ix, iy + 1, seed);
  const n11 = hash2d(ix + 1, iy + 1, seed);
  const nx0 = n00 + (n10 - n00) * ux;
  const nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uy;
}

export interface WetBloodProceduralMaps {
  readonly dropletNormalMap: pc.Texture;
  readonly poolAlbedoAlphaArterial: pc.Texture;
  readonly poolAlbedoAlphaVenous: pc.Texture;
  readonly mistAlphaMap: pc.Texture;
}

const deviceMapCache = new WeakMap<pc.GraphicsDevice, WetBloodProceduralMaps>();

export function getOrCreateWetBloodMaps(device: pc.GraphicsDevice): WetBloodProceduralMaps {
  const existing = deviceMapCache.get(device);
  if (existing) return existing;

  const aniso = Math.max(1, Math.min(device.maxAnisotropy || 4, 8));
  const dropSize = 64;
  const dropNormPixels = new Uint8Array(dropSize * dropSize * 4);
  for (let y = 0; y < dropSize; y++) {
    for (let x = 0; x < dropSize; x++) {
      const u = x / dropSize;
      const v = y / dropSize;
      const hC = valueNoise2d(u * 12, v * 12, 101) * 0.65 + valueNoise2d(u * 26, v * 26, 211) * 0.35;
      const hR = valueNoise2d((u + 1 / dropSize) * 12, v * 12, 101) * 0.65 + valueNoise2d((u + 1 / dropSize) * 26, v * 26, 211) * 0.35;
      const hU = valueNoise2d(u * 12, (v + 1 / dropSize) * 12, 101) * 0.65 + valueNoise2d(u * 26, (v + 1 / dropSize) * 26, 211) * 0.35;

      let nx = -(hR - hC) * 2.2, ny = -(hU - hC) * 2.2, nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;

      const idx = (y * dropSize + x) * 4;
      dropNormPixels[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      dropNormPixels[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      dropNormPixels[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      dropNormPixels[idx + 3] = 255;
    }
  }
  const dropletNormalMap = new pc.Texture(device, {
    name: 'vascularWetDropletNormal',
    width: dropSize,
    height: dropSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    anisotropy: aniso,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  (dropletNormalMap.lock() as Uint8Array).set(dropNormPixels);
  dropletNormalMap.unlock();

  const poolSize = 128;
  const artPixels = new Uint8Array(poolSize * poolSize * 4);
  const venPixels = new Uint8Array(poolSize * poolSize * 4);
  fillBloodPoolPixels(artPixels, poolSize, [255, 255, 255]);
  fillBloodPoolPixels(venPixels, poolSize, [255, 255, 255]);

  const makePoolTex = (name: string, data: Uint8Array): pc.Texture => {
    const tex = new pc.Texture(device, {
      name, width: poolSize, height: poolSize, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
      minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR, anisotropy: aniso,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    (tex.lock() as Uint8Array).set(data);
    tex.unlock();
    return tex;
  };

  const mistSize = 64;
  const mistPixels = new Uint8Array(mistSize * mistSize * 4);
  for (let y = 0; y < mistSize; y++) {
    const v = (y + 0.5) / mistSize;
    for (let x = 0; x < mistSize; x++) {
      const u = (x + 0.5) / mistSize;
      const r = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2);
      const wisp = valueNoise2d(u * 7.5, v * 7.5, 613) * 0.42 + valueNoise2d(u * 16, v * 16, 677) * 0.22;
      const falloff = Math.max(0, 1 - r * r);
      const alpha = Math.max(0, Math.min(1, falloff * falloff * (0.62 + wisp)));
      const p4 = (y * mistSize + x) * 4;
      mistPixels[p4] = 165; mistPixels[p4 + 1] = 12; mistPixels[p4 + 2] = 18; mistPixels[p4 + 3] = Math.round(alpha * 220);
    }
  }
  const mistAlphaMap = new pc.Texture(device, {
    name: 'vascularArterialMistTex', width: mistSize, height: mistSize, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
    minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  (mistAlphaMap.lock() as Uint8Array).set(mistPixels);
  mistAlphaMap.unlock();

  const bundle: WetBloodProceduralMaps = {
    dropletNormalMap,
    poolAlbedoAlphaArterial: makePoolTex('vascularArterialPoolAlbedo', artPixels),
    poolAlbedoAlphaVenous: makePoolTex('vascularVenousPoolAlbedo', venPixels),
    mistAlphaMap,
  };
  deviceMapCache.set(device, bundle);
  return bundle;
}
