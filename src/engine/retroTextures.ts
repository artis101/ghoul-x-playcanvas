import * as pc from 'playcanvas';
import { EnemyArchetypeId } from '../contracts/ballistics.ts';

type RGB = [number, number, number];

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hash2d(x: number, y: number, seed: number): number {
  let n = Math.imul(x * 374761393 + y * 668265263 + seed * 1442695041, 1274126177);
  n = (n ^ (n >>> 13)) >>> 0;
  return (n & 0xffff) / 0xffff;
}

function valueNoise2d(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);

  const x0 = ((xi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y0 = ((yi % period) + period) % period;
  const y1 = (y0 + 1) % period;

  const n00 = hash2d(x0, y0, seed);
  const n10 = hash2d(x1, y0, seed);
  const n01 = hash2d(x0, y1, seed);
  const n11 = hash2d(x1, y1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

function getDeviceAnisotropy(device: pc.GraphicsDevice): number {
  if (device instanceof pc.NullGraphicsDevice) {
    return 1;
  }
  return Math.max(1, Math.min(16, device.maxAnisotropy || 1));
}

/**
 * Creates a filtered, mipmapped, anisotropic PBR albedo texture from a procedural pixel painter.
 */
function createTacticalAlbedoTexture(
  device: pc.GraphicsDevice,
  name: string,
  size: number,
  painter: (x: number, y: number, u: number, v: number) => RGB,
  bloodSplatterSeed = 0
): pc.Texture {
  const tex = new pc.Texture(device, {
    name,
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
    anisotropy: getDeviceAnisotropy(device),
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let [r, g, b] = painter(x, y, u, v);

      // Subtle micro-grain instead of harsh 5-bit posterization
      const grain = (hash2d(x, y, 17) - 0.5) * 4.0;
      r += grain;
      g += grain;
      b += grain;

      // Optional GHOUL arterial laceration overlay
      if (bloodSplatterSeed > 0) {
        const cx = u - 0.5;
        const cy = v - 0.5;
        const n1 = valueNoise2d(u * 12, v * 12, 12, bloodSplatterSeed);
        const n2 = hash2d(x, y, bloodSplatterSeed + 99);
        const dist = Math.sqrt(cx * cx * 0.8 + cy * cy * 1.1) - n1 * 0.28;
        if (dist < 0.14) {
          r = n2 > 0.35 ? 108 : 68;
          g = n2 > 0.35 ? 9 : 5;
          b = n2 > 0.35 ? 12 : 7;
        } else if (dist < 0.28 || n1 > 0.82) {
          r = r * 0.28 + 112 * 0.72;
          g = g * 0.12 + 8 * 0.88;
          b = b * 0.12 + 11 * 0.88;
        }
      }

      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(r);
      pixels[idx + 1] = clampByte(g);
      pixels[idx + 2] = clampByte(b);
      pixels[idx + 3] = 255;
    }
  }
  tex.unlock();
  return tex;
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

interface TacticalMaterialOptions {
  gloss?: number;
  metalness?: number;
  useMetalness?: boolean;
  normalMap?: pc.Texture | null;
  bumpiness?: number;
}

function makeTacticalMaterial(
  name: string,
  tex: pc.Texture,
  opts: TacticalMaterialOptions = {}
): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.name = name;
  mat.diffuse = new pc.Color(1, 1, 1);
  mat.diffuseMap = tex;
  mat.enableGGXSpecular = true;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  if (opts.useMetalness) {
    mat.useMetalness = true;
    mat.metalness = opts.metalness ?? 0.8;
  } else {
    mat.specular = new pc.Color(0.06, 0.06, 0.06);
  }
  mat.gloss = opts.gloss ?? 0.28;
  if (opts.normalMap) {
    mat.normalMap = opts.normalMap;
    mat.bumpiness = opts.bumpiness ?? 0.75;
  }
  mat.pixelSnap = false;
  mat.update();
  return mat;
}

export interface ArchetypeRetroMaterialSet {
  headMat: pc.StandardMaterial;
  headBloodyMat: pc.StandardMaterial;
  jawMat: pc.StandardMaterial;
  jawBloodyMat: pc.StandardMaterial;
  torsoMat: pc.StandardMaterial;
  torsoBloodyMat: pc.StandardMaterial;
  abdomenMat: pc.StandardMaterial;
  abdomenBloodyMat: pc.StandardMaterial;
  pelvisMat: pc.StandardMaterial;
  pelvisBloodyMat: pc.StandardMaterial;
  upperArmMat: pc.StandardMaterial;
  upperArmBloodyMat: pc.StandardMaterial;
  forearmMat: pc.StandardMaterial;
  forearmBloodyMat: pc.StandardMaterial;
  handMat: pc.StandardMaterial;
  legsMat: pc.StandardMaterial;
  legsBloodyMat: pc.StandardMaterial;
  kneePadMat: pc.StandardMaterial;
  bootMat: pc.StandardMaterial;
  headgearMat: pc.StandardMaterial;
  visorMat: pc.StandardMaterial;
  pouchWebbingMat: pc.StandardMaterial;
  weaponMetalMat: pc.StandardMaterial;
  weaponFurnitureMat: pc.StandardMaterial;
}

interface DeviceSharedFabricMaps {
  fabricNormal: pc.Texture;
  metalNormal: pc.Texture;
}

const cachedArchetypeByDevice = new WeakMap<
  pc.GraphicsDevice,
  Map<EnemyArchetypeId, ArchetypeRetroMaterialSet>
>();
const cachedFabricMapsByDevice = new WeakMap<pc.GraphicsDevice, DeviceSharedFabricMaps>();
const cachedEnvMapsByDevice = new WeakMap<
  pc.GraphicsDevice,
  {
    floorDiffuse: pc.Texture;
    floorNormal: pc.Texture;
    floorGloss: pc.Texture;
    wallDiffuse: pc.Texture;
    wallNormal: pc.Texture;
    wallGloss: pc.Texture;
  }
>();

function getSharedFabricMaps(device: pc.GraphicsDevice): DeviceSharedFabricMaps {
  const existing = cachedFabricMapsByDevice.get(device);
  if (existing) return existing;

  const { normalMap: fabricNormal } = createProceduralNormalAndGlossMaps(
    device,
    'tactical_ripstop_weave',
    64,
    (x, y, u, v) => {
      const warp = Math.sin(x * Math.PI * 0.5) * 0.18;
      const weft = Math.sin(y * Math.PI * 0.5) * 0.18;
      const crease = (valueNoise2d(u * 8, v * 8, 8, 71) - 0.5) * 0.45;
      return { height: warp + weft + crease, gloss: 0.28 };
    },
    1.6
  );

  const { normalMap: metalNormal } = createProceduralNormalAndGlossMaps(
    device,
    'brushed_gunmetal',
    64,
    (_x, y, u, v) => {
      const brush = (valueNoise2d(u * 4, v * 32, 32, 83) - 0.5) * 0.25;
      const mill = Math.sin(y * 0.8) * 0.06;
      return { height: brush + mill, gloss: 0.68 };
    },
    1.2
  );

  const shared = { fabricNormal, metalNormal };
  cachedFabricMapsByDevice.set(device, shared);
  return shared;
}

/**
 * Generates and caches PBR tactical fallback materials (intact & GHOUL lacerated variants) for each enemy archetype.
 */
export function getArchetypeRetroMaterials(
  device: pc.GraphicsDevice,
  archetype: EnemyArchetypeId
): ArchetypeRetroMaterialSet {
  let deviceMap = cachedArchetypeByDevice.get(device);
  if (!deviceMap) {
    deviceMap = new Map<EnemyArchetypeId, ArchetypeRetroMaterialSet>();
    cachedArchetypeByDevice.set(device, deviceMap);
  }
  const existing = deviceMap.get(archetype);
  if (existing) return existing;

  const S = 64;
  const { fabricNormal, metalNormal } = getSharedFabricMaps(device);

  const bootTex = createTacticalAlbedoTexture(device, `${archetype}_boot`, S, (x, y, u, v) => {
    const grain = (hash2d(x, y, 11) - 0.5) * 10;
    if (v < 0.18) {
      const tread = x % 6 < 3 ? -10 : 6;
      return [24 + tread, 24 + tread, 26 + tread];
    }
    if (Math.abs(u - 0.5) < 0.08 && v > 0.25 && v < 0.85) {
      const rung = y % 5 === 0;
      return rung ? [72, 72, 76] : [18, 18, 20];
    }
    const crease = Math.sin(v * 18) * 6;
    return [34 + grain + crease, 33 + grain + crease, 37 + grain + crease];
  });

  const kneePadTex = createTacticalAlbedoTexture(device, `${archetype}_kneepad`, S, (x, y, u, v) => {
    const border = u < 0.12 || u > 0.88 || v < 0.12 || v > 0.88;
    const rivet = (Math.abs(u - 0.2) < 0.04 || Math.abs(u - 0.8) < 0.04) &&
      (Math.abs(v - 0.2) < 0.04 || Math.abs(v - 0.8) < 0.04);
    if (rivet) return [135, 138, 142];
    if (border) return [24, 26, 28];
    const n = (hash2d(x, y, 21) - 0.5) * 8;
    return [46 + n, 49 + n, 52 + n];
  });

  const weaponMetalTex = createTacticalAlbedoTexture(device, `${archetype}_gunmetal`, S, (x, y, _u, v) => {
    const n = (hash2d(x, y, 77) - 0.5) * 10;
    const vent = y % 8 === 0 && x > 20 && x < 52 ? -14 : 0;
    const highlight = Math.abs(v - 0.55) < 0.08 ? 18 : 0;
    return [72 + n + vent + highlight, 76 + n + vent + highlight, 84 + n + vent + highlight];
  });

  const weaponWoodOrPolyTex = createTacticalAlbedoTexture(
    device,
    `${archetype}_gunfurn`,
    S,
    (x, y, u, v) => {
      if (archetype === 'MILITIA_GUNNER' || archetype === 'SNIPER_OPERATIVE') {
        const streak = Math.sin(v * 28 + valueNoise2d(u * 6, v * 12, 12, 55) * 2.5) * 14;
        return [122 + streak, 66 + streak * 0.5, 34 + streak * 0.3];
      }
      const checkering = (x + y) % 2 === 0 && u > 0.25 && u < 0.75 ? -8 : 3;
      return [38 + checkering, 40 + checkering, 44 + checkering];
    }
  );

  const headPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 101) - 0.5) * 10;
    const du = Math.abs(u - 0.5);

    if (archetype === 'MILITIA_GUNNER') {
      const knit = (x % 2 === 0 ? 3 : -3) + (y % 3 === 0 ? -4 : 2);
      if (v > 0.44 && v < 0.60 && du > 0.04 && du < 0.16) {
        if (v > 0.49 && v < 0.56 && Math.abs(du - 0.10) < 0.03) {
          return [22, 18, 16];
        }
        if (v > 0.49 && v < 0.56 && Math.abs(du - 0.10) < 0.05) {
          return [215, 210, 205];
        }
        return [186 + n, 142 + n, 112 + n];
      }
      return [34 + knit + n * 0.5, 36 + knit + n * 0.5, 38 + knit + n * 0.5];
    }

    const baseSkin: RGB =
      archetype === 'SKINHEAD_PUNK'
        ? [204, 154, 124]
        : archetype === 'HEAVY_ENFORCER'
          ? [186, 138, 108]
          : [210, 166, 136];

    let [r, g, b] = [baseSkin[0] + n, baseSkin[1] + n, baseSkin[2] + n];

    if (archetype === 'SNIPER_OPERATIVE' && du < 0.25) {
      const stripe = Math.sin(u * 26 + v * 12);
      if (stripe > 0.55 && v > 0.25 && v < 0.65) {
        r -= 72;
        g -= 50;
        b -= 64;
      }
    }

    if (v > 0.72 || du > 0.27) {
      if (archetype === 'SKINHEAD_PUNK') {
        if (du < 0.06 && v > 0.62) return [162 + n, 28, 28];
        return [r * 0.78, g * 0.76, b * 0.76];
      }
      return [66 + n, 52 + n, 42 + n];
    }

    if (v > 0.58 && v < 0.64 && du > 0.03 && du < 0.18) {
      return [48, 36, 28];
    }
    if (v > 0.48 && v < 0.57 && du > 0.05 && du < 0.16) {
      if (Math.abs(du - 0.105) < 0.028) return [24, 22, 20];
      return [222, 218, 212];
    }
    if (du < 0.035 && v > 0.34 && v < 0.54) {
      return [r - 20, g - 18, b - 16];
    }

    return [r, g, b];
  };

  const jawPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 109) - 0.5) * 10;
    const du = Math.abs(u - 0.5);
    if (archetype === 'MILITIA_GUNNER') {
      if (du < 0.09 && v > 0.35 && v < 0.65) {
        return v > 0.46 && v < 0.54 ? [78, 28, 28] : [175 + n, 130 + n, 102 + n];
      }
      return [32 + n * 0.5, 34 + n * 0.5, 36 + n * 0.5];
    }
    if (du < 0.10 && v > 0.48 && v < 0.58) {
      return [76, 36, 34];
    }
    const stubble = (x + y) % 2 === 0 ? -12 : -4;
    return [182 + stubble + n, 136 + stubble + n, 108 + stubble + n];
  };

  const torsoPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 203) - 0.5) * 10;
    const du = Math.abs(u - 0.5);

    if (archetype === 'SKINHEAD_PUNK') {
      if (du < 0.11 && v < 0.85) {
        const rib = x % 3 === 0 ? -12 : 5;
        return [196 + rib + n, 192 + rib + n, 182 + rib + n];
      }
      if (Math.abs(du - 0.13) < 0.025 && y % 8 < 2) {
        return [205, 210, 218];
      }
      if (du > 0.39 && v > 0.35 && v < 0.72) {
        return [150 + n, 26, 24];
      }
      const leatherCrease = Math.sin(v * 16 + u * 8) * 8;
      return [32 + leatherCrease + n * 0.6, 32 + leatherCrease + n * 0.6, 36 + leatherCrease + n * 0.6];
    }

    if (archetype === 'MILITIA_GUNNER') {
      if (du < 0.02) return [42, 46, 36];
      if (Math.abs(du - 0.14) < 0.035) {
        return [116 + n, 102 + n, 70 + n];
      }
      if (v > 0.25 && v < 0.48 && du < 0.24) {
        const pocketSeam = x % 8 === 0 ? -16 : 5;
        return [110 + pocketSeam + n, 96 + pocketSeam + n, 64 + pocketSeam + n];
      }
      const fold = Math.sin(v * 20) * 7;
      return [74 + fold + n, 84 + fold + n, 56 + fold + n];
    }

    if (archetype === 'HEAVY_ENFORCER') {
      const weave = (x + y) % 4 === 0 ? 8 : -5;
      if (du < 0.14 && v > 0.62 && v < 0.74 && x % 3 !== 0) {
        return [210, 178, 56];
      }
      if (Math.abs(du - 0.19) < 0.02 || Math.abs(v - 0.2) < 0.03) {
        return [24, 28, 32];
      }
      return [48 + weave + n * 0.5, 54 + weave + n * 0.5, 62 + weave + n * 0.5];
    }

    if (Math.abs(u - v * 0.5 - 0.25) < 0.035) {
      return [46 + n, 36 + n, 28 + n];
    }
    const c1 = valueNoise2d(u * 8, v * 8, 8, 311);
    const c2 = valueNoise2d(u * 14, v * 14, 14, 317);
    if (c1 > 0.62) return [88 + n, 98 + n, 108 + n];
    if (c2 < 0.34) return [54 + n, 62 + n, 70 + n];
    return [136 + n, 142 + n, 148 + n];
  };

  const legsPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 401) - 0.5) * 10;
    const crease = Math.sin(v * 22 + u * 6) * 7;
    const blotch = valueNoise2d(u * 10, v * 10, 10, 409);

    if (archetype === 'SKINHEAD_PUNK') {
      if (blotch > 0.66) return [152 + n + crease, 156 + n + crease, 162 + n + crease];
      if (blotch < 0.34) return [38 + n + crease, 40 + n + crease, 44 + n + crease];
      return [88 + n + crease, 92 + n + crease, 98 + n + crease];
    }

    if (archetype === 'MILITIA_GUNNER') {
      if (blotch > 0.68) return [96 + n + crease, 74 + n + crease, 48 + n + crease];
      if (blotch < 0.30) return [32 + n + crease, 36 + n + crease, 28 + n + crease];
      return [62 + n + crease, 78 + n + crease, 48 + n + crease];
    }

    if (archetype === 'HEAVY_ENFORCER') {
      const ripstop = x % 4 === 0 || y % 4 === 0 ? -4 : 3;
      return [42 + ripstop + n + crease, 52 + ripstop + n + crease, 68 + ripstop + n + crease];
    }

    if (v > 0.28 && v < 0.72 && blotch > 0.55) {
      return [92 + n + crease, 88 + n + crease, 64 + n + crease];
    }
    return [116 + n + crease, 112 + n + crease, 86 + n + crease];
  };

  const armPainter = (isForearm: boolean) => (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 503) - 0.5) * 10;
    if (archetype === 'SKINHEAD_PUNK') {
      const muscleShade = Math.cos((u - 0.5) * Math.PI * 2) * 12;
      if (!isForearm && v > 0.42 && v < 0.58 && (x + y) % 3 === 0) {
        return [42, 54, 58];
      }
      return [202 + muscleShade + n, 150 + muscleShade + n, 118 + muscleShade + n];
    }
    if (archetype === 'MILITIA_GUNNER' && isForearm && v < 0.55) {
      return [186 + n, 142 + n, 112 + n];
    }
    return torsoPainter(x, y, u, v);
  };

  const beltPelvisPainter = (x: number, y: number, u: number, v: number): RGB => {
    if (v > 0.72) {
      if (Math.abs(u - 0.5) < 0.07) {
        return [178, 162, 92];
      }
      const grommet = x % 6 === 0 && y % 3 === 0 ? 32 : 0;
      return [30 + grommet, 32 + grommet, 30 + grommet];
    }
    return legsPainter(x, y, u, v);
  };

  const handGlovePainter = (x: number, y: number, _u: number, v: number): RGB => {
    const n = (hash2d(x, y, 601) - 0.5) * 8;
    if (archetype === 'SKINHEAD_PUNK' || archetype === 'MILITIA_GUNNER') {
      if (v < 0.36) {
        return [192 + n, 145 + n, 114 + n];
      }
      return [32 + n, 32 + n, 35 + n];
    }
    return [36 + n, 38 + n, 42 + n];
  };

  const headgearPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 701) - 0.5) * 10;
    if (archetype === 'SKINHEAD_PUNK') {
      return [182 + n, 24 + Math.max(0, n), 28];
    }
    if (archetype === 'SNIPER_OPERATIVE') {
      if (Math.abs(u - 0.42) < 0.05 && v > 0.25 && v < 0.65) {
        return [220, 185, 52];
      }
      if (v < 0.16) return [24, 24, 26];
      return [146 + n, 22 + n * 0.3, 32 + n * 0.3];
    }
    if (archetype === 'HEAVY_ENFORCER') {
      if (v > 0.32 && v < 0.46) return [30 + n, 34 + n, 32 + n];
      return [54 + n, 62 + n, 68 + n];
    }
    const rib = x % 3 === 0 ? -8 : 5;
    return [44 + rib + n * 0.4, 48 + rib + n * 0.4, 38 + rib + n * 0.4];
  };

  const visorPainter = (x: number, y: number, _u: number, v: number): RGB => {
    const glint = x + y > 48 && x + y < 60 ? 55 : 0;
    if (archetype === 'HEAVY_ENFORCER') {
      return [195 + glint, 138 + glint, 28 + glint];
    }
    return [22 + glint, 28 + glint + (v > 0.6 ? 18 : 0), 36 + glint];
  };

  const pouchPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 809) - 0.5) * 10;
    const flap = Math.abs(v - 0.62) < 0.05 ? -20 : 0;
    const snap = Math.abs(u - 0.5) < 0.12 && Math.abs(v - 0.52) < 0.08;
    if (snap) return [155, 150, 118];
    if (archetype === 'HEAVY_ENFORCER') return [36 + flap + n, 40 + flap + n, 45 + flap + n];
    return [96 + flap + n, 88 + flap + n, 58 + flap + n];
  };

  const fabricOpts: TacticalMaterialOptions = { gloss: 0.24, normalMap: fabricNormal, bumpiness: 0.7 };
  const goreOpts: TacticalMaterialOptions = { gloss: 0.84, normalMap: fabricNormal, bumpiness: 0.9 };
  const skinOpts: TacticalMaterialOptions = { gloss: 0.36, normalMap: fabricNormal, bumpiness: 0.35 };

  const set: ArchetypeRetroMaterialSet = {
    headMat: makeTacticalMaterial(`${archetype}_head`, createTacticalAlbedoTexture(device, `${archetype}_head`, S, headPainter), skinOpts),
    headBloodyMat: makeTacticalMaterial(`${archetype}_head_gore`, createTacticalAlbedoTexture(device, `${archetype}_head_gore`, S, headPainter, 11), goreOpts),
    jawMat: makeTacticalMaterial(`${archetype}_jaw`, createTacticalAlbedoTexture(device, `${archetype}_jaw`, S, jawPainter), skinOpts),
    jawBloodyMat: makeTacticalMaterial(`${archetype}_jaw_gore`, createTacticalAlbedoTexture(device, `${archetype}_jaw_gore`, S, jawPainter, 17), goreOpts),
    torsoMat: makeTacticalMaterial(`${archetype}_torso`, createTacticalAlbedoTexture(device, `${archetype}_torso`, S, torsoPainter), fabricOpts),
    torsoBloodyMat: makeTacticalMaterial(`${archetype}_torso_gore`, createTacticalAlbedoTexture(device, `${archetype}_torso_gore`, S, torsoPainter, 23), goreOpts),
    abdomenMat: makeTacticalMaterial(`${archetype}_abd`, createTacticalAlbedoTexture(device, `${archetype}_abd`, S, torsoPainter), fabricOpts),
    abdomenBloodyMat: makeTacticalMaterial(`${archetype}_abd_gore`, createTacticalAlbedoTexture(device, `${archetype}_abd_gore`, S, torsoPainter, 31), goreOpts),
    pelvisMat: makeTacticalMaterial(`${archetype}_pelvis`, createTacticalAlbedoTexture(device, `${archetype}_pelvis`, S, beltPelvisPainter), fabricOpts),
    pelvisBloodyMat: makeTacticalMaterial(`${archetype}_pelvis_gore`, createTacticalAlbedoTexture(device, `${archetype}_pelvis_gore`, S, beltPelvisPainter, 41), goreOpts),
    upperArmMat: makeTacticalMaterial(`${archetype}_uarm`, createTacticalAlbedoTexture(device, `${archetype}_uarm`, S, armPainter(false)), fabricOpts),
    upperArmBloodyMat: makeTacticalMaterial(`${archetype}_uarm_gore`, createTacticalAlbedoTexture(device, `${archetype}_uarm_gore`, S, armPainter(false), 53), goreOpts),
    forearmMat: makeTacticalMaterial(`${archetype}_farm`, createTacticalAlbedoTexture(device, `${archetype}_farm`, S, armPainter(true)), fabricOpts),
    forearmBloodyMat: makeTacticalMaterial(`${archetype}_farm_gore`, createTacticalAlbedoTexture(device, `${archetype}_farm_gore`, S, armPainter(true), 59), goreOpts),
    handMat: makeTacticalMaterial(`${archetype}_hand`, createTacticalAlbedoTexture(device, `${archetype}_hand`, S, handGlovePainter), { gloss: 0.34, normalMap: fabricNormal, bumpiness: 0.6 }),
    legsMat: makeTacticalMaterial(`${archetype}_legs`, createTacticalAlbedoTexture(device, `${archetype}_legs`, S, legsPainter), fabricOpts),
    legsBloodyMat: makeTacticalMaterial(`${archetype}_legs_gore`, createTacticalAlbedoTexture(device, `${archetype}_legs_gore`, S, legsPainter, 67), goreOpts),
    kneePadMat: makeTacticalMaterial(`${archetype}_kneepad`, kneePadTex, { gloss: 0.46, normalMap: fabricNormal, bumpiness: 0.55 }),
    bootMat: makeTacticalMaterial(`${archetype}_boot`, bootTex, { gloss: 0.42, normalMap: fabricNormal, bumpiness: 0.65 }),
    headgearMat: makeTacticalMaterial(`${archetype}_headgear`, createTacticalAlbedoTexture(device, `${archetype}_headgear`, S, headgearPainter), { gloss: 0.34, normalMap: fabricNormal, bumpiness: 0.6 }),
    visorMat: makeTacticalMaterial(`${archetype}_visor`, createTacticalAlbedoTexture(device, `${archetype}_visor`, S, visorPainter), { gloss: 0.90, useMetalness: true, metalness: 0.65 }),
    pouchWebbingMat: makeTacticalMaterial(`${archetype}_pouch`, createTacticalAlbedoTexture(device, `${archetype}_pouch`, S, pouchPainter), fabricOpts),
    weaponMetalMat: makeTacticalMaterial(`${archetype}_wmetal`, weaponMetalTex, { gloss: 0.68, useMetalness: true, metalness: 0.85, normalMap: metalNormal, bumpiness: 0.9 }),
    weaponFurnitureMat: makeTacticalMaterial(`${archetype}_wfurn`, weaponWoodOrPolyTex, { gloss: 0.38, normalMap: fabricNormal, bumpiness: 0.5 }),
  };

  deviceMap.set(archetype, set);
  return set;
}

/**
 * Applies high-resolution PBR albedo, tangent-space normal, and gloss/roughness maps
 * to the firing-range concrete slab floor and reinforced jersey barriers.
 */
export function applyRetroEnvironmentTextures(
  device: pc.GraphicsDevice,
  floorMat: pc.StandardMaterial,
  concreteMat: pc.StandardMaterial
): void {
  let envMaps = cachedEnvMapsByDevice.get(device);
  if (!envMaps) {
    const S = 128;

    const floorDiffuse = createTacticalAlbedoTexture(device, 'pbr_range_floor_albedo', S, (x, y, u, v) => {
      const fine = (hash2d(x, y, 901) - 0.5) * 10;
      const macro = (valueNoise2d(u * 6, v * 6, 6, 903) - 0.5) * 16;
      const half = S >> 1;
      const dxSeam = Math.min(x, S - x, Math.abs(x - half));
      const dySeam = Math.min(y, S - y, Math.abs(y - half));
      const seamDist = Math.min(dxSeam, dySeam);

      if (seamDist === 0) {
        return [16, 19, 24];
      }
      if (seamDist === 1) {
        return [48, 54, 62];
      }
      const scuff = valueNoise2d(u * 12, v * 12, 12, 907) > 0.72 ? -8 : 0;
      return [38 + fine + macro + scuff, 43 + fine + macro + scuff, 50 + fine + macro + scuff];
    });

    const { normalMap: floorNormal, glossMap: floorGloss } = createProceduralNormalAndGlossMaps(
      device,
      'pbr_range_floor',
      S,
      (x, y, u, v) => {
        const half = S >> 1;
        const dxSeam = Math.min(x, S - x, Math.abs(x - half));
        const dySeam = Math.min(y, S - y, Math.abs(y - half));
        const seamDist = Math.min(dxSeam, dySeam);
        const seamGroove = seamDist === 0 ? -0.65 : seamDist === 1 ? -0.22 : 0.0;

        const brush = Math.sin(v * Math.PI * 32) * 0.04;
        const pitting = (valueNoise2d(u * 24, v * 24, 24, 911) - 0.5) * 0.24;
        const polishPatch = valueNoise2d(u * 5, v * 5, 5, 913);
        const gloss = seamDist <= 1 ? 0.16 : 0.34 + polishPatch * 0.36;
        return { height: seamGroove + brush + pitting, gloss };
      },
      2.6
    );

    const wallDiffuse = createTacticalAlbedoTexture(device, 'pbr_concrete_barrier_albedo', S, (x, y, u, v) => {
      const fine = (hash2d(x, y, 919) - 0.5) * 12;
      const mottling = (valueNoise2d(u * 8, v * 8, 8, 923) - 0.5) * 20;

      // Industrial safety hazard chevron band along barrier base
      if (v < 0.16) {
        const stripePhase = Math.floor((u * 8 + v * 6) * 2) & 1;
        const wear = valueNoise2d(u * 20, v * 20, 20, 929) > 0.76 ? -28 : 0;
        if (stripePhase === 0) {
          return [198 + fine * 0.5 + wear, 152 + fine * 0.5 + wear, 28];
        }
        return [26 + fine * 0.4, 28 + fine * 0.4, 31 + fine * 0.4];
      }

      // Formwork tie-rod recesses & horizontal pour lines
      const formLine = y % 32 === 0 ? -18 : y % 32 === 1 ? 8 : 0;
      const tieX = Math.min(Math.abs(u - 0.25), Math.abs(u - 0.75));
      const tieY = Math.min(Math.abs(v - 0.42), Math.abs(v - 0.76));
      const tieDist = Math.hypot(tieX * 2.2, tieY);
      const tieShade = tieDist < 0.032 ? -28 : 0;

      const base = 92 + fine + mottling + formLine + tieShade;
      return [base, base + 3, base + 7];
    });

    const { normalMap: wallNormal, glossMap: wallGloss } = createProceduralNormalAndGlossMaps(
      device,
      'pbr_concrete_barrier',
      S,
      (_x, y, u, v) => {
        const pores = (valueNoise2d(u * 28, v * 28, 28, 937) - 0.5) * 0.34;
        const coarse = (valueNoise2d(u * 8, v * 8, 8, 941) - 0.5) * 0.22;
        const formSeam = y % 32 === 0 ? -0.55 : 0.0;
        const tieX = Math.min(Math.abs(u - 0.25), Math.abs(u - 0.75));
        const tieY = Math.min(Math.abs(v - 0.42), Math.abs(v - 0.76));
        const tieDent = Math.hypot(tieX * 2.2, tieY) < 0.032 ? -0.6 : 0.0;
        const gloss = v < 0.16 ? 0.44 : 0.22 + valueNoise2d(u * 10, v * 10, 10, 947) * 0.18;
        return { height: pores + coarse + formSeam + tieDent, gloss };
      },
      2.8
    );

    envMaps = { floorDiffuse, floorNormal, floorGloss, wallDiffuse, wallNormal, wallGloss };
    cachedEnvMapsByDevice.set(device, envMaps);
  }

  const floorTiling = new pc.Vec2(20, 80);
  floorMat.diffuse = new pc.Color(1, 1, 1);
  floorMat.diffuseMap = envMaps.floorDiffuse;
  floorMat.diffuseMapTiling = floorTiling;
  floorMat.normalMap = envMaps.floorNormal;
  floorMat.normalMapTiling = floorTiling.clone();
  floorMat.bumpiness = 1.15;
  floorMat.glossMap = envMaps.floorGloss;
  floorMat.glossMapChannel = 'g';
  floorMat.glossMapTiling = floorTiling.clone();
  floorMat.gloss = 0.85;
  floorMat.useMetalness = true;
  floorMat.metalness = 0.06;
  floorMat.enableGGXSpecular = true;
  floorMat.fresnelModel = pc.FRESNEL_SCHLICK;
  floorMat.update();

  const wallTiling = new pc.Vec2(3, 1);
  concreteMat.diffuse = new pc.Color(1, 1, 1);
  concreteMat.diffuseMap = envMaps.wallDiffuse;
  concreteMat.diffuseMapTiling = wallTiling;
  concreteMat.normalMap = envMaps.wallNormal;
  concreteMat.normalMapTiling = wallTiling.clone();
  concreteMat.bumpiness = 1.25;
  concreteMat.glossMap = envMaps.wallGloss;
  concreteMat.glossMapChannel = 'g';
  concreteMat.glossMapTiling = wallTiling.clone();
  concreteMat.gloss = 0.78;
  concreteMat.useMetalness = true;
  concreteMat.metalness = 0.04;
  concreteMat.enableGGXSpecular = true;
  concreteMat.fresnelModel = pc.FRESNEL_SCHLICK;
  concreteMat.update();
}
