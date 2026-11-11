import * as pc from 'playcanvas';

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
  readonly poolMeniscusNormalMap: pc.Texture;
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
  const poolHeight = new Float32Array(poolSize * poolSize);
  const artPixels = new Uint8Array(poolSize * poolSize * 4);
  const venPixels = new Uint8Array(poolSize * poolSize * 4);
  const poolNormPixels = new Uint8Array(poolSize * poolSize * 4);

  for (let y = 0; y < poolSize; y++) {
    const v = (y + 0.5) / poolSize;
    for (let x = 0; x < poolSize; x++) {
      const u = (x + 0.5) / poolSize;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      const r = Math.hypot(dx, dy), theta = Math.atan2(dy, dx);
      const lobes = 0.12 * Math.sin(theta * 3 + 0.4) + 0.075 * Math.cos(theta * 5 - 1.1) + 0.045 * Math.sin(theta * 8 + 2.1) + (valueNoise2d(u * 9.5, v * 9.5, 307) - 0.5) * 0.12;
      const edgeR = 0.82 + lobes;

      let thickness = 0;
      if (r < edgeR) {
        const edgeDist = (edgeR - r) / Math.max(0.15, edgeR);
        const meniscus = Math.min(1, Math.pow(edgeDist * 4.2, 0.58));
        const rimBead = edgeDist > 0.02 && edgeDist < 0.24 ? Math.sin(((edgeDist - 0.02) / 0.22) * Math.PI) * 0.22 : 0;
        const ripple = (valueNoise2d(u * 18, v * 18, 409) - 0.5) * 0.04;
        thickness = Math.max(0, Math.min(1, meniscus + rimBead + ripple));
      }
      poolHeight[y * poolSize + x] = thickness;

      const alpha = thickness > 0.01 ? Math.min(1, thickness * 2.8) : 0;
      const centerCoag = Math.max(0, 1 - r / Math.max(0.2, edgeR));
      const p4 = (y * poolSize + x) * 4;

      const artRimBoost = 1.0 - centerCoag * 0.44;
      artPixels[p4] = Math.round(152 * artRimBoost + 22);
      artPixels[p4 + 1] = Math.round(10 * artRimBoost + 2);
      artPixels[p4 + 2] = Math.round(16 * artRimBoost + 4);
      artPixels[p4 + 3] = Math.round(alpha * 250);

      const venRimBoost = 1.0 - centerCoag * 0.38;
      venPixels[p4] = Math.round(88 * venRimBoost + 12);
      venPixels[p4 + 1] = Math.round(5 * venRimBoost + 1);
      venPixels[p4 + 2] = Math.round(12 * venRimBoost + 3);
      venPixels[p4 + 3] = Math.round(alpha * 252);
    }
  }

  for (let y = 0; y < poolSize; y++) {
    const ym = Math.max(0, y - 1), yp = Math.min(poolSize - 1, y + 1);
    for (let x = 0; x < poolSize; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(poolSize - 1, x + 1);
      const dhdx = (poolHeight[y * poolSize + xp] - poolHeight[y * poolSize + xm]) * 3.6;
      const dhdy = (poolHeight[yp * poolSize + x] - poolHeight[ym * poolSize + x]) * 3.6;
      let nx = -dhdx, ny = -dhdy, nz = 1.0;
      const nLen = Math.hypot(nx, ny, nz);
      nx /= nLen; ny /= nLen; nz /= nLen;

      const p4 = (y * poolSize + x) * 4;
      poolNormPixels[p4] = Math.round((nx * 0.5 + 0.5) * 255);
      poolNormPixels[p4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      poolNormPixels[p4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      poolNormPixels[p4 + 3] = 255;
    }
  }

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
    poolMeniscusNormalMap: makePoolTex('vascularPoolMeniscusNormal', poolNormPixels),
    mistAlphaMap,
  };
  deviceMapCache.set(device, bundle);
  return bundle;
}
