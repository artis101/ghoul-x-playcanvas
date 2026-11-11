import * as pc from 'playcanvas';

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hash2d(x: number, y: number, seed: number): number {
  let n = Math.imul(x * 374761393 + y * 668265263 + seed * 1442695041, 1274126177);
  n = (n ^ (n >>> 13)) >>> 0;
  return (n & 0xffff) / 0xffff;
}

export function valueNoise2d(u: number, v: number, freq: number, seed: number): number {
  const x = u * freq;
  const y = v * freq;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = hash2d(x0, y0, seed);
  const n10 = hash2d(x0 + 1, y0, seed);
  const n01 = hash2d(x0, y0 + 1, seed);
  const n11 = hash2d(x0 + 1, y0 + 1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

export function createMuzzleStarTexture(device: pc.GraphicsDevice): pc.Texture {
  const sSize = 64;
  const starTex = new pc.Texture(device, {
    name: 'vmMuzzleStarPetalTex',
    width: sSize,
    height: sSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const sPx = starTex.lock() as Uint8Array;
  for (let y = 0; y < sSize; y++) {
    for (let x = 0; x < sSize; x++) {
      const u = (x + 0.5) / sSize - 0.5;
      const v = (y + 0.5) / sSize - 0.5;
      const ax = Math.abs(u) * 2.0;
      const ay = Math.abs(v) * 2.0;
      const rad = Math.hypot(ax, ay);
      const spikeX = Math.max(0, 1 - ax) * Math.exp(-Math.pow(ay * 4.8, 1.7));
      const spikeY = Math.max(0, 1 - ay) * Math.exp(-Math.pow(ax * 4.8, 1.7));
      const hotCore = Math.exp(-rad * rad * 9.5);
      const intensity = Math.min(1.0, hotCore * 1.1 + (spikeX + spikeY) * 0.92);
      const idx = (y * sSize + x) * 4;
      sPx[idx] = 255;
      sPx[idx + 1] = clampByte(165 + hotCore * 90);
      sPx[idx + 2] = clampByte(52 + hotCore * 185);
      sPx[idx + 3] = clampByte(intensity * 255);
    }
  }
  starTex.unlock();
  return starTex;
}

export function createMuzzleCoronaTexture(device: pc.GraphicsDevice): pc.Texture {
  const sSize = 64;
  const coronaTex = new pc.Texture(device, {
    name: 'vmMuzzleCoronaTex',
    width: sSize,
    height: sSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const cPx = coronaTex.lock() as Uint8Array;
  for (let y = 0; y < sSize; y++) {
    for (let x = 0; x < sSize; x++) {
      const u = (x + 0.5) / sSize - 0.5;
      const v = (y + 0.5) / sSize - 0.5;
      const r = Math.hypot(u, v) * 2.0;
      const angle = Math.atan2(v, u);
      const rayMod = 0.84 + 0.16 * Math.cos(angle * 8.0);
      const coreGlow = Math.exp(-r * r * 4.2);
      const shockRing = Math.exp(-Math.pow((r - 0.62) / 0.16, 2)) * 0.42;
      const alpha = r <= 1.0 ? Math.min(1.0, (coreGlow + shockRing) * rayMod) : 0;
      const idx = (y * sSize + x) * 4;
      cPx[idx] = 255;
      cPx[idx + 1] = clampByte(178 + coreGlow * 75);
      cPx[idx + 2] = clampByte(64 + coreGlow * 150);
      cPx[idx + 3] = clampByte(alpha * 255);
    }
  }
  coronaTex.unlock();
  return coronaTex;
}

export function createBarrelSmokeTexture(device: pc.GraphicsDevice): pc.Texture {
  const sSize = 64;
  const smokeTex = new pc.Texture(device, {
    name: 'vmBarrelSmokeWispTex',
    width: sSize,
    height: sSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const smPx = smokeTex.lock() as Uint8Array;
  for (let y = 0; y < sSize; y++) {
    for (let x = 0; x < sSize; x++) {
      const u = (x + 0.5) / sSize;
      const v = (y + 0.5) / sSize;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2.0;
      const turb = valueNoise2d(u, v, 5, 5107) * 0.6 + valueNoise2d(u, v, 11, 5233) * 0.4;
      const falloff = Math.max(0, 1 - r * r);
      const alpha = falloff * falloff * (0.38 + turb * 0.62);
      const lum = clampByte(196 + turb * 48);
      const idx = (y * sSize + x) * 4;
      smPx[idx] = lum;
      smPx[idx + 1] = lum;
      smPx[idx + 2] = clampByte(lum + 6);
      smPx[idx + 3] = clampByte(alpha * 255);
    }
  }
  smokeTex.unlock();
  return smokeTex;
}

export function createMachinedGrainNormalTexture(device: pc.GraphicsDevice, maxAniso: number): pc.Texture {
  const sSize = 64;
  const grainNormalTex = new pc.Texture(device, {
    name: 'vmMachinedMicroGrainNormalTex',
    width: sSize,
    height: sSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  grainNormalTex.anisotropy = maxAniso;
  const gPx = grainNormalTex.lock() as Uint8Array;
  const gH = new Float32Array(sSize * sSize);
  for (let y = 0; y < sSize; y++) {
    for (let x = 0; x < sSize; x++) {
      const u = x / sSize;
      const v = y / sSize;
      const brush = valueNoise2d(u * 3.0, v * 0.6, 12, 6101) * 0.65;
      const stipple = valueNoise2d(u, v, 22, 6217) * 0.35;
      gH[y * sSize + x] = brush + stipple;
    }
  }
  for (let y = 0; y < sSize; y++) {
    for (let x = 0; x < sSize; x++) {
      const hL = gH[y * sSize + ((x - 1 + sSize) % sSize)];
      const hR = gH[y * sSize + ((x + 1) % sSize)];
      const hD = gH[((y - 1 + sSize) % sSize) * sSize + x];
      const hU = gH[((y + 1) % sSize) * sSize + x];
      const nx = (hL - hR) * 1.1;
      const ny = (hD - hU) * 1.1;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * sSize + x) * 4;
      gPx[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
      gPx[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
      gPx[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      gPx[idx + 3] = 255;
    }
  }
  grainNormalTex.unlock();
  return grainNormalTex;
}
