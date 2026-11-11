import * as pc from 'playcanvas';
import {
  Vec3Like,
  DismembermentEvent,
  TargetHealthState,
  TrajectorySample,
  GhoulZoneId,
  EnemyArchetypeId,
} from '../contracts/ballistics.ts';
import { copyVec3, length, normalize, sub, scale } from '../core/ballistics/vec3.ts';
import { EngineMaterialPalette } from './materials.ts';
import { getArchetypeRetroMaterials } from './retroTextures.ts';
import {
  buildArchetypeHeadgearEntity,
  buildEnemyWeaponEntity,
} from './retroMeshBuilder.ts';
import {
  getArchetypeWeaponAssetId,
  GlbModelRegistry,
} from './assets/glbLoader.ts';

export interface ActiveProjectileFx {
  entity: pc.Entity;
  shockwaveRing?: pc.Entity;
  trajectorySamples: TrajectorySample[];
  currentSampleIndex: number;
  progressTimeS: number;
  totalFlightTimeS: number;
  finished: boolean;
  trailPoints: pc.Vec3[];
}

export interface InFlightBloodDrop {
  entity: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  life: number;
  maxLife: number;
  baseRadius?: number;
}

export interface BloodPoolDecal {
  entity: pc.Entity;
  currentScale: number;
  targetScale: number;
  growthRate: number;
  aspectRatio?: number;
}

export interface GibChunk {
  entity: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  angularVelocity: pc.Vec3;
  bounces: number;
  life: number;
  maxLife: number;
  leavesBlood: boolean;
  restHeight: number;
}

export interface BoneShardSpark {
  entity: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  life: number;
}

export interface ArterialFountainStream {
  target?: TargetHealthState;
  zone?: GhoulZoneId;
  parentZone?: GhoulZoneId;
  stumpPos: Vec3Like;
  sprayDir: Vec3Like;
  durationS: number;
  elapsedS: number;
  dropTimerS: number;
}

interface BloodMistPuff {
  entity: pc.Entity;
  meshInstance: pc.MeshInstance | null;
  position: pc.Vec3;
  velocity: pc.Vec3;
  life: number;
  maxLife: number;
  startScale: number;
  endScale: number;
  spinSpeedDeg: number;
}

interface WetGoreMaterialSuite {
  wetBloodDropMat: pc.StandardMaterial;
  wetBloodPoolMat: pc.StandardMaterial;
  wetBloodMistBaseMat: pc.StandardMaterial;
  wetFleshGibMat: pc.StandardMaterial;
  wetCorticalBoneMat: pc.StandardMaterial;
  wetMarrowCapMat: pc.StandardMaterial;
  incandescentSparkMat: pc.StandardMaterial;
  tracerTailMat: pc.StandardMaterial;
  floorQuadMesh: pc.Mesh | null;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hash2d(x: number, y: number, seed: number): number {
  let n = Math.imul(
    x * 374761393 + y * 668265263 + seed * 1442695041,
    1274126177
  );
  n = (n ^ (n >>> 13)) >>> 0;
  return (n & 0xffff) / 0xffff;
}

function valueNoise2d(u: number, v: number, freq: number, seed: number): number {
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

function buildFloorQuadMesh(device: pc.GraphicsDevice): pc.Mesh {
  const mesh = new pc.Mesh(device);
  mesh.setPositions([
    -0.5, 0, -0.5,
    -0.5, 0, 0.5,
    0.5, 0, 0.5,
    0.5, 0, -0.5,
  ]);
  mesh.setNormals([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ]);
  mesh.setUvs(0, [
    0, 0,
    0, 1,
    1, 1,
    1, 0,
  ]);
  mesh.setIndices([0, 1, 2, 0, 2, 3]);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  // Retain permanent refCount >= 1 so clearing blood pool entities between waves never frees
  // the shared GPU vertex/index buffers in goreSuiteCache!
  mesh.incRefCount();
  return mesh;
}

const goreSuiteCache = new WeakMap<pc.GraphicsDevice, WetGoreMaterialSuite>();

function createWetGoreMaterialSuite(device: pc.GraphicsDevice | null): WetGoreMaterialSuite {
  if (device) {
    const cached = goreSuiteCache.get(device);
    if (cached) {
      return cached;
    }
  }

  const maxAniso = device ? Math.min(device.maxAnisotropy || 4, 8) : 1;

  // 1. Wet Arterial Blood Droplet Material (deep crimson PBR with clearcoat meniscus)
  const wetBloodDropMat = new pc.StandardMaterial();
  wetBloodDropMat.name = 'goreWetArterialDropPbrMat';
  wetBloodDropMat.diffuse = new pc.Color(0.42, 0.014, 0.022);
  wetBloodDropMat.emissive = new pc.Color(0.048, 0.003, 0.005);
  wetBloodDropMat.useMetalness = true;
  wetBloodDropMat.metalness = 0.09;
  wetBloodDropMat.gloss = 0.91;
  wetBloodDropMat.clearCoat = 0.88;
  wetBloodDropMat.clearCoatGloss = 0.95;
  wetBloodDropMat.fresnelModel = pc.FRESNEL_SCHLICK;

  // 2. Glossy Wet-Edge Arterial Blood Pool Material
  const wetBloodPoolMat = new pc.StandardMaterial();
  wetBloodPoolMat.name = 'goreWetArterialPoolPbrMat';
  wetBloodPoolMat.diffuse = new pc.Color(0.32, 0.012, 0.018);
  wetBloodPoolMat.emissive = new pc.Color(0.018, 0.001, 0.002);
  wetBloodPoolMat.useMetalness = true;
  wetBloodPoolMat.metalness = 0.11;
  wetBloodPoolMat.gloss = 0.93;
  wetBloodPoolMat.clearCoat = 0.92;
  wetBloodPoolMat.clearCoatGloss = 0.96;
  wetBloodPoolMat.fresnelModel = pc.FRESNEL_SCHLICK;
  wetBloodPoolMat.blendType = pc.BLEND_NORMAL;
  wetBloodPoolMat.depthWrite = false;

  // 3. Backlit Arterial Blood Mist Material
  const wetBloodMistBaseMat = new pc.StandardMaterial();
  wetBloodMistBaseMat.name = 'goreBacklitMistMat';
  wetBloodMistBaseMat.diffuse = new pc.Color(0.46, 0.024, 0.034);
  wetBloodMistBaseMat.emissive = new pc.Color(0.15, 0.009, 0.014);
  wetBloodMistBaseMat.opacity = 0.54;
  wetBloodMistBaseMat.blendType = pc.BLEND_NORMAL;
  wetBloodMistBaseMat.depthWrite = false;
  wetBloodMistBaseMat.cull = pc.CULLFACE_NONE;

  // 4. Wet Striated Muscle & Fascia Gib Material
  const wetFleshGibMat = new pc.StandardMaterial();
  wetFleshGibMat.name = 'goreWetMuscleGibPbrMat';
  wetFleshGibMat.diffuse = new pc.Color(0.38, 0.032, 0.042);
  wetFleshGibMat.emissive = new pc.Color(0.025, 0.002, 0.004);
  wetFleshGibMat.useMetalness = true;
  wetFleshGibMat.metalness = 0.07;
  wetFleshGibMat.gloss = 0.86;
  wetFleshGibMat.clearCoat = 0.84;
  wetFleshGibMat.clearCoatGloss = 0.92;
  wetFleshGibMat.fresnelModel = pc.FRESNEL_SCHLICK;

  // 5. Wet Ivory Cortical Bone & Marrow Materials
  const wetCorticalBoneMat = new pc.StandardMaterial();
  wetCorticalBoneMat.name = 'goreWetCorticalBonePbrMat';
  wetCorticalBoneMat.diffuse = new pc.Color(0.84, 0.78, 0.68);
  wetCorticalBoneMat.useMetalness = true;
  wetCorticalBoneMat.metalness = 0.05;
  wetCorticalBoneMat.gloss = 0.82;
  wetCorticalBoneMat.clearCoat = 0.64;
  wetCorticalBoneMat.clearCoatGloss = 0.88;
  wetCorticalBoneMat.fresnelModel = pc.FRESNEL_SCHLICK;

  const wetMarrowCapMat = new pc.StandardMaterial();
  wetMarrowCapMat.name = 'goreTrabecularMarrowMat';
  wetMarrowCapMat.diffuse = new pc.Color(0.28, 0.016, 0.022);
  wetMarrowCapMat.useMetalness = true;
  wetMarrowCapMat.metalness = 0.08;
  wetMarrowCapMat.gloss = 0.88;
  wetMarrowCapMat.clearCoat = 0.85;
  wetMarrowCapMat.clearCoatGloss = 0.92;
  wetMarrowCapMat.fresnelModel = pc.FRESNEL_SCHLICK;

  // 6. Incandescent Ballistic Spark & Tracer Tail Materials
  const incandescentSparkMat = new pc.StandardMaterial();
  incandescentSparkMat.name = 'goreIncandescentSparkMat';
  incandescentSparkMat.diffuse = new pc.Color(1.0, 0.84, 0.42);
  incandescentSparkMat.emissive = new pc.Color(1.0, 0.66, 0.18);
  incandescentSparkMat.emissiveIntensity = 2.8;
  incandescentSparkMat.blendType = pc.BLEND_ADDITIVEALPHA;
  incandescentSparkMat.depthWrite = false;

  const tracerTailMat = new pc.StandardMaterial();
  tracerTailMat.name = 'goreProjectileTracerTailMat';
  tracerTailMat.diffuse = new pc.Color(1.0, 0.92, 0.62);
  tracerTailMat.emissive = new pc.Color(1.0, 0.72, 0.24);
  tracerTailMat.emissiveIntensity = 3.2;
  tracerTailMat.opacity = 0.88;
  tracerTailMat.blendType = pc.BLEND_ADDITIVEALPHA;
  tracerTailMat.depthWrite = false;
  tracerTailMat.cull = pc.CULLFACE_NONE;

  let floorQuadMesh: pc.Mesh | null = null;

  if (device) {
    floorQuadMesh = buildFloorQuadMesh(device);

    // Droplet micro-normal map (64x64)
    const dropNSize = 64;
    const dropNormalTex = new pc.Texture(device, {
      name: 'goreDropletNormalTex',
      width: dropNSize,
      height: dropNSize,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: true,
      minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_REPEAT,
      addressV: pc.ADDRESS_REPEAT,
    });
    dropNormalTex.anisotropy = maxAniso;
    const dnPx = dropNormalTex.lock() as Uint8Array;
    const dropH = new Float32Array(dropNSize * dropNSize);
    for (let y = 0; y < dropNSize; y++) {
      for (let x = 0; x < dropNSize; x++) {
        const u = x / dropNSize;
        const v = y / dropNSize;
        dropH[y * dropNSize + x] =
          valueNoise2d(u, v, 6, 307) * 0.65 + valueNoise2d(u, v, 14, 613) * 0.35;
      }
    }
    for (let y = 0; y < dropNSize; y++) {
      for (let x = 0; x < dropNSize; x++) {
        const hL = dropH[y * dropNSize + ((x - 1 + dropNSize) % dropNSize)];
        const hR = dropH[y * dropNSize + ((x + 1) % dropNSize)];
        const hD = dropH[((y - 1 + dropNSize) % dropNSize) * dropNSize + x];
        const hU = dropH[((y + 1) % dropNSize) * dropNSize + x];
        const nx = (hL - hR) * 1.4;
        const ny = (hD - hU) * 1.4;
        const nz = 1.0;
        const inv = 1 / Math.hypot(nx, ny, nz);
        const idx = (y * dropNSize + x) * 4;
        dnPx[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
        dnPx[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
        dnPx[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
        dnPx[idx + 3] = 255;
      }
    }
    dropNormalTex.unlock();
    wetBloodDropMat.normalMap = dropNormalTex;
    wetBloodDropMat.bumpiness = 0.38;

    // Organic multi-lobed blood pool albedo/alpha + meniscus normal map (128x128)
    const pSize = 128;
    const poolTex = new pc.Texture(device, {
      name: 'gorePoolAlbedoAlphaTex',
      width: pSize,
      height: pSize,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: true,
      minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    poolTex.anisotropy = maxAniso;
    const poolNormalTex = new pc.Texture(device, {
      name: 'gorePoolMeniscusNormalTex',
      width: pSize,
      height: pSize,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: true,
      minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    poolNormalTex.anisotropy = maxAniso;

    const pPx = poolTex.lock() as Uint8Array;
    const pnPx = poolNormalTex.lock() as Uint8Array;
    const poolHeight = new Float32Array(pSize * pSize);

    for (let y = 0; y < pSize; y++) {
      for (let x = 0; x < pSize; x++) {
        const u = (x + 0.5) / pSize;
        const v = (y + 0.5) / pSize;
        const dx = u - 0.5;
        const dy = v - 0.5;
        const angle = Math.atan2(dy, dx);
        const rad = Math.hypot(dx, dy);

        const lobeWarp =
          Math.sin(angle * 3.0 + 0.7) * 0.055 +
          Math.cos(angle * 5.0 - 1.2) * 0.035 +
          (valueNoise2d(u, v, 7, 811) - 0.5) * 0.095 +
          (valueNoise2d(u, v, 15, 929) - 0.5) * 0.045;

        const edgeDist = 0.41 + lobeWarp - rad;
        let alpha = 0;
        if (edgeDist > 0.032) {
          alpha = 0.97;
        } else if (edgeDist > 0) {
          const t = edgeDist / 0.032;
          alpha = t * t * (3 - 2 * t) * 0.97;
        } else if (edgeDist > -0.055) {
          // Occasional tiny satellite droplets near pool perimeter
          const sat = valueNoise2d(u, v, 26, 1103);
          if (sat > 0.83) {
            alpha = ((sat - 0.83) / 0.17) * 0.88;
          }
        }

        // Meniscus height profile: flat liquid interior with raised surface-tension rim
        const meniscus =
          alpha > 0.05
            ? Math.min(1.0, edgeDist * 12.0) * (1.0 + Math.exp(-Math.pow((edgeDist - 0.025) / 0.022, 2)) * 0.42)
            : 0;
        poolHeight[y * pSize + x] = meniscus;

        // Deep venous maroon core -> rich translucent oxygenated crimson edge
        const depthFactor = Math.max(0, Math.min(1, edgeDist / 0.24));
        const rCol = 96 * (1 - depthFactor * 0.58) + 22;
        const gCol = 5 * (1 - depthFactor * 0.5) + 1;
        const bCol = 8 * (1 - depthFactor * 0.45) + 2;

        const idx = (y * pSize + x) * 4;
        pPx[idx] = clampByte(rCol);
        pPx[idx + 1] = clampByte(gCol);
        pPx[idx + 2] = clampByte(bCol);
        pPx[idx + 3] = clampByte(alpha * 255);
      }
    }

    for (let y = 0; y < pSize; y++) {
      for (let x = 0; x < pSize; x++) {
        const xm = Math.max(0, x - 1);
        const xp = Math.min(pSize - 1, x + 1);
        const ym = Math.max(0, y - 1);
        const yp = Math.min(pSize - 1, y + 1);
        const nx = (poolHeight[y * pSize + xm] - poolHeight[y * pSize + xp]) * 2.8;
        const ny = (poolHeight[ym * pSize + x] - poolHeight[yp * pSize + x]) * 2.8;
        const nz = 1.0;
        const inv = 1 / Math.hypot(nx, ny, nz);
        const idx = (y * pSize + x) * 4;
        pnPx[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
        pnPx[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
        pnPx[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
        pnPx[idx + 3] = 255;
      }
    }
    poolTex.unlock();
    poolNormalTex.unlock();

    wetBloodPoolMat.diffuse = new pc.Color(1, 1, 1);
    wetBloodPoolMat.diffuseMap = poolTex;
    wetBloodPoolMat.opacityMap = poolTex;
    wetBloodPoolMat.opacityMapChannel = 'a';
    wetBloodPoolMat.normalMap = poolNormalTex;
    wetBloodPoolMat.bumpiness = 0.82;

    // Backlit blood mist aerosol texture (64x64)
    const mSize = 64;
    const mistTex = new pc.Texture(device, {
      name: 'goreBacklitMistTex',
      width: mSize,
      height: mSize,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: true,
      minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    const mPx = mistTex.lock() as Uint8Array;
    for (let y = 0; y < mSize; y++) {
      for (let x = 0; x < mSize; x++) {
        const u = (x + 0.5) / mSize;
        const v = (y + 0.5) / mSize;
        const d = Math.hypot(u - 0.5, v - 0.5) * 2.0;
        const wisp =
          valueNoise2d(u, v, 5, 1301) * 0.6 + valueNoise2d(u, v, 11, 1453) * 0.4;
        const falloff = Math.max(0, 1 - d * d);
        const alpha = falloff * falloff * (0.45 + wisp * 0.55);
        const idx = (y * mSize + x) * 4;
        mPx[idx] = clampByte(128 + wisp * 36);
        mPx[idx + 1] = clampByte(8 + wisp * 6);
        mPx[idx + 2] = clampByte(12 + wisp * 8);
        mPx[idx + 3] = clampByte(alpha * 255);
      }
    }
    mistTex.unlock();
    wetBloodMistBaseMat.diffuse = new pc.Color(1, 1, 1);
    wetBloodMistBaseMat.diffuseMap = mistTex;
    wetBloodMistBaseMat.opacityMap = mistTex;
    wetBloodMistBaseMat.opacityMapChannel = 'a';

    // Striated wet muscle & fascia texture + normal map (64x64)
    const fSize = 64;
    const fleshTex = new pc.Texture(device, {
      name: 'goreMuscleFasciaTex',
      width: fSize,
      height: fSize,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: true,
      minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_REPEAT,
      addressV: pc.ADDRESS_REPEAT,
    });
    fleshTex.anisotropy = maxAniso;
    const fleshNormalTex = new pc.Texture(device, {
      name: 'goreMuscleNormalTex',
      width: fSize,
      height: fSize,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: true,
      minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_REPEAT,
      addressV: pc.ADDRESS_REPEAT,
    });
    fleshNormalTex.anisotropy = maxAniso;

    const fPx = fleshTex.lock() as Uint8Array;
    const fnPx = fleshNormalTex.lock() as Uint8Array;
    const fleshH = new Float32Array(fSize * fSize);

    for (let y = 0; y < fSize; y++) {
      for (let x = 0; x < fSize; x++) {
        const u = x / fSize;
        const v = y / fSize;
        const warp = valueNoise2d(u, v, 5, 1607) * 0.25;
        const fiber = Math.sin((u + warp) * Math.PI * 14) * 0.5 + 0.5;
        const marbling = valueNoise2d(u, v, 9, 1721);
        const fasciaBand = marbling > 0.76 ? (marbling - 0.76) / 0.24 : 0;

        fleshH[y * fSize + x] = fiber * 0.55 + marbling * 0.45;

        const r = 98 + fiber * 34 + fasciaBand * 88;
        const g = 10 + fiber * 8 + fasciaBand * 62;
        const b = 15 + fiber * 9 + fasciaBand * 58;
        const idx = (y * fSize + x) * 4;
        fPx[idx] = clampByte(r);
        fPx[idx + 1] = clampByte(g);
        fPx[idx + 2] = clampByte(b);
        fPx[idx + 3] = 255;
      }
    }
    for (let y = 0; y < fSize; y++) {
      for (let x = 0; x < fSize; x++) {
        const hL = fleshH[y * fSize + ((x - 1 + fSize) % fSize)];
        const hR = fleshH[y * fSize + ((x + 1) % fSize)];
        const hD = fleshH[((y - 1 + fSize) % fSize) * fSize + x];
        const hU = fleshH[((y + 1) % fSize) * fSize + x];
        const nx = (hL - hR) * 2.2;
        const ny = (hD - hU) * 2.2;
        const nz = 1.0;
        const inv = 1 / Math.hypot(nx, ny, nz);
        const idx = (y * fSize + x) * 4;
        fnPx[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
        fnPx[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
        fnPx[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
        fnPx[idx + 3] = 255;
      }
    }
    fleshTex.unlock();
    fleshNormalTex.unlock();

    wetFleshGibMat.diffuse = new pc.Color(1, 1, 1);
    wetFleshGibMat.diffuseMap = fleshTex;
    wetFleshGibMat.normalMap = fleshNormalTex;
    wetFleshGibMat.bumpiness = 0.85;
  }

  wetBloodDropMat.update();
  wetBloodPoolMat.update();
  wetBloodMistBaseMat.update();
  wetFleshGibMat.update();
  wetCorticalBoneMat.update();
  wetMarrowCapMat.update();
  incandescentSparkMat.update();
  tracerTailMat.update();

  const suite: WetGoreMaterialSuite = {
    wetBloodDropMat,
    wetBloodPoolMat,
    wetBloodMistBaseMat,
    wetFleshGibMat,
    wetCorticalBoneMat,
    wetMarrowCapMat,
    incandescentSparkMat,
    tracerTailMat,
    floorQuadMesh,
  };

  if (device) {
    goreSuiteCache.set(device, suite);
  }
  return suite;
}

/**
 * Class GoreAndBallisticsFxManager manages:
 * - In-flight 3D spinning bullet models, incandescent tracer streaks, and Mach shockwave rings
 * - Ballistic trajectory trails & armor/bone impact sparks
 * - High-velocity velocity-stretched arterial blood splatter, backlit aerosol mist & glossy wet-edge pools
 * - Anatomically convincing wet striated flesh & splintered cortical bone/marrow dismemberment gibs
 * - Detached physics props (shot-off helmets/berets/shades & dropped AK-47/MP5/SVD weapons)
 * - Pulsing arterial stump blood fountains
 */
export class GoreAndBallisticsFxManager {
  public readonly app: pc.AppBase;
  public readonly materials: EngineMaterialPalette;
  public readonly fxRoot: pc.Entity;

  private activeProjectiles: ActiveProjectileFx[] = [];
  private bloodDrops: InFlightBloodDrop[] = [];
  private bloodPools: BloodPoolDecal[] = [];
  private gibChunks: GibChunk[] = [];
  private boneShards: BoneShardSpark[] = [];
  private arterialFountains: ArterialFountainStream[] = [];
  private mistPuffs: BloodMistPuff[] = [];
  private glbRegistry: GlbModelRegistry | null = null;
  private readonly goreSuite: WetGoreMaterialSuite;
  private poolDepthBiasCounter = 0;
  private cachedPlayerCamera: pc.Entity | null = null;

  constructor(app: pc.AppBase, materials: EngineMaterialPalette, glbRegistry?: GlbModelRegistry | null) {
    this.app = app;
    this.materials = materials;
    this.glbRegistry = glbRegistry ?? null;
    this.goreSuite = createWetGoreMaterialSuite(this.app.graphicsDevice ?? null);
    this.fxRoot = new pc.Entity('GoreAndBallisticsFxRoot');
    this.app.root.addChild(this.fxRoot);
  }

  public attachGlbRegistry(glbRegistry: GlbModelRegistry): void {
    this.glbRegistry = glbRegistry;
  }

  /**
   * Spawns an animated 3D projectile following RK4 trajectory samples with a hot incandescent tail.
   */
  public spawnFlyingProjectile(
    trajectorySamples: TrajectorySample[],
    isShotgunPellet = false
  ): ActiveProjectileFx | null {
    if (!trajectorySamples || trajectorySamples.length < 2) return null;

    const pEntity = new pc.Entity(isShotgunPellet ? 'PelletProjectile' : 'RifleProjectile');
    pEntity.addComponent('render', {
      type: isShotgunPellet ? 'sphere' : 'capsule',
      material: isShotgunPellet ? this.materials.copperPelletMat : this.materials.brassBulletMat,
    });

    if (isShotgunPellet) {
      pEntity.setLocalScale(0.015, 0.015, 0.015);
    } else {
      pEntity.setLocalScale(0.016, 0.052, 0.016);

      // Hot incandescent tracer wake behind supersonic/rifle projectile
      const tracerTail = new pc.Entity('ProjectileTracerStreak');
      tracerTail.addComponent('render', {
        type: 'cone',
        material: this.goreSuite.tracerTailMat,
        castShadows: false,
      });
      tracerTail.setLocalPosition(0, -1.8, 0);
      tracerTail.setLocalEulerAngles(180, 0, 0);
      tracerTail.setLocalScale(0.85, 3.6, 0.85);
      pEntity.addChild(tracerTail);
    }

    const firstPos = trajectorySamples[0].position;
    pEntity.setPosition(firstPos.x, firstPos.y, firstPos.z);
    this.fxRoot.addChild(pEntity);

    let shockwaveRing: pc.Entity | undefined;
    if (!isShotgunPellet && trajectorySamples[0].mach > 1.0) {
      shockwaveRing = new pc.Entity('MachShockwaveRing');
      shockwaveRing.addComponent('render', {
        type: 'cone',
        material: this.materials.shockwaveRingMat,
        castShadows: false,
      });
      shockwaveRing.setLocalScale(4.8, 1.4, 4.8);
      pEntity.addChild(shockwaveRing);
    }

    const totalFlightTimeS = Math.max(0.045, trajectorySamples[trajectorySamples.length - 1].timeS);

    const projFx: ActiveProjectileFx = {
      entity: pEntity,
      shockwaveRing,
      trajectorySamples,
      currentSampleIndex: 0,
      progressTimeS: 0,
      totalFlightTimeS,
      finished: false,
      trailPoints: [new pc.Vec3(firstPos.x, firstPos.y, firstPos.z)],
    };

    this.activeProjectiles.push(projFx);
    return projFx;
  }

  /**
   * Spawns a shot-off helmet, beret, watch-cap, or shades spinning through the air!
   */
  public spawnDetachedHeadgearProp(
    archetype: EnemyArchetypeId,
    worldPos: Vec3Like,
    shotDir: Vec3Like
  ): void {
    let prop: pc.Entity | null = null;
    if (this.glbRegistry && this.glbRegistry.isLoaded('ghoul_combatant')) {
      prop = this.glbRegistry.instantiateDetachedHeadgearProp(archetype);
    }
    if (!prop) {
      const mats = getArchetypeRetroMaterials(this.app.graphicsDevice, archetype);
      prop = buildArchetypeHeadgearEntity(this.app.graphicsDevice, archetype, mats);
    }
    prop.setPosition(worldPos.x, worldPos.y, worldPos.z);
    this.fxRoot.addChild(prop);

    const vx = shotDir.x * 4.5 + (Math.random() - 0.5) * 2.2;
    const vy = 3.2 + Math.random() * 2.0;
    const vz = shotDir.z * 4.5 + (Math.random() - 0.5) * 2.2;

    this.gibChunks.push({
      entity: prop,
      position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
      velocity: new pc.Vec3(vx, vy, vz),
      angularVelocity: new pc.Vec3(
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18
      ),
      bounces: 0,
      life: 0,
      maxLife: 24.0,
      leavesBlood: false,
      restHeight: 0.03,
    });
  }

  /**
   * Spawns the combatant's dropped 3D weapon clattering onto the concrete floor!
   */
  public spawnDroppedWeaponProp(
    archetype: EnemyArchetypeId,
    worldPos: Vec3Like,
    inheritedVel: Vec3Like
  ): void {
    let gun: pc.Entity | null = null;
    const weaponId = getArchetypeWeaponAssetId(archetype);
    if (this.glbRegistry && this.glbRegistry.isLoaded(weaponId)) {
      const inst = this.glbRegistry.instantiateWeapon(weaponId, {
        castShadows: true,
        receiveShadows: true,
      });
      if (inst.animComponent) {
        inst.animComponent.playing = false;
      }
      gun = inst.rootEntity;
    } else {
      const mats = getArchetypeRetroMaterials(this.app.graphicsDevice, archetype);
      gun = buildEnemyWeaponEntity(this.app.graphicsDevice, archetype, mats);
    }
    gun.setPosition(worldPos.x, worldPos.y, worldPos.z);
    this.fxRoot.addChild(gun);

    const vx = inheritedVel.x * 0.45 + (Math.random() - 0.5) * 2.2;
    const vy = Math.max(1.2, inheritedVel.y * 0.35 + 1.4);
    const vz = inheritedVel.z * 0.45 + (Math.random() - 0.5) * 2.2 + 0.8;

    this.gibChunks.push({
      entity: gun,
      position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
      velocity: new pc.Vec3(vx, vy, vz),
      angularVelocity: new pc.Vec3(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 12,
        6 + Math.random() * 6
      ),
      bounces: 0,
      life: 0,
      maxLife: 30.0,
      leavesBlood: false,
      restHeight: 0.04,
    });
  }

  /**
   * Spawns incandescent ballistic sparks + Kevlar/ceramic fragments when armor stops a round!
   */
  public spawnArmorImpactSparks(worldPos: Vec3Like, normalDir: Vec3Like): void {
    for (let i = 0; i < 14; i++) {
      const isHotSpark = i < 8;
      const spark = new pc.Entity('ArmorSpark');
      spark.addComponent('render', {
        type: isHotSpark ? 'sphere' : 'box',
        material: isHotSpark ? this.goreSuite.incandescentSparkMat : this.materials.sandbagMat,
        castShadows: false,
      });
      const s = isHotSpark ? 0.008 + Math.random() * 0.008 : 0.011 + Math.random() * 0.012;
      spark.setLocalScale(s, s, isHotSpark ? s * 3.8 : s);
      spark.setPosition(worldPos.x, worldPos.y, worldPos.z);
      this.fxRoot.addChild(spark);

      const spd = (isHotSpark ? 4.2 : 2.2) + Math.random() * 4.5;
      const vx = normalDir.x * spd + (Math.random() - 0.5) * 3.8;
      const vy = normalDir.y * spd + Math.random() * 2.8;
      const vz = normalDir.z * spd + (Math.random() - 0.5) * 3.8;
      if (isHotSpark) {
        spark.lookAt(worldPos.x + vx, worldPos.y + vy, worldPos.z + vz);
      }

      this.boneShards.push({
        entity: spark,
        position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
        velocity: new pc.Vec3(vx, vy, vz),
        life: isHotSpark ? 2.65 : 0, // Hot sparks burn out crisp & fast (~0.55s)
      });
    }
  }

  /**
   * Spawns high-velocity wet PBR arterial blood spray arcs & fine backlit mist that splat into floor pools.
   */
  public spawnBloodBurst(
    worldPos: Vec3Like,
    normalDir: Vec3Like,
    energyJ: number,
    count = 16
  ): void {
    const burstCount = Math.min(52, Math.max(count, Math.floor(energyJ / 22)));
    const baseSpeed = Math.min(10.2, Math.max(2.8, Math.sqrt(Math.max(1, energyJ)) * 0.175));

    // Fine backlit arterial blood mist puffs on medium/high-energy trauma
    if (energyJ >= 32 && this.mistPuffs.length < 44) {
      const mistCount = energyJ > 280 ? 3 : energyJ > 90 ? 2 : 1;
      for (let m = 0; m < mistCount; m++) {
        this.spawnBacklitMistPuff(worldPos, normalDir, baseSpeed * (0.28 + m * 0.12), energyJ);
      }
    }

    for (let i = 0; i < burstCount; i++) {
      const dropEnt = new pc.Entity('BloodDrop');
      dropEnt.addComponent('render', {
        type: 'sphere',
        material: this.goreSuite.wetBloodDropMat,
        castShadows: false,
      });

      // Coherent arterial stream jet for the first 40% of droplets, wider spray cone for the rest
      const isStreamCore = i < burstCount * 0.4;
      const spreadScale = isStreamCore ? 0.42 : 1.08;
      const speedJitter = isStreamCore ? 0.85 + Math.random() * 0.45 : 0.55 + Math.random() * 0.7;
      const radius = (isStreamCore ? 0.015 : 0.011) + Math.random() * 0.016;

      const vx =
        normalDir.x * baseSpeed * speedJitter +
        (Math.random() - 0.5) * baseSpeed * spreadScale;
      const vy =
        normalDir.y * baseSpeed * speedJitter +
        Math.random() * baseSpeed * 0.58 +
        0.65;
      const vz =
        normalDir.z * baseSpeed * speedJitter +
        (Math.random() - 0.5) * baseSpeed * spreadScale;

      const spd = Math.hypot(vx, vy, vz);
      const stretch = Math.min(3.4, 1.0 + spd * 0.24);
      dropEnt.setLocalScale(radius * 0.82, radius * 0.82, radius * stretch);
      dropEnt.setPosition(worldPos.x, worldPos.y, worldPos.z);
      if (spd > 0.1) {
        dropEnt.lookAt(worldPos.x + vx, worldPos.y + vy, worldPos.z + vz);
      }
      this.fxRoot.addChild(dropEnt);

      this.bloodDrops.push({
        entity: dropEnt,
        position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
        velocity: new pc.Vec3(vx, vy, vz),
        life: 0,
        maxLife: 2.5,
        baseRadius: radius,
      });
    }
  }

  private spawnBacklitMistPuff(
    worldPos: Vec3Like,
    dir: Vec3Like,
    driftSpeed: number,
    energyJ: number
  ): void {
    const puff = new pc.Entity('ArterialMistPuff');
    puff.addComponent('render', {
      type: 'plane',
      material: this.goreSuite.wetBloodMistBaseMat,
      castShadows: false,
      receiveShadows: false,
    });
    const puffMi = puff.render?.meshInstances?.[0] ?? null;
    puffMi?.setParameter('material_opacity', 0.52);

    const energyScale = Math.min(1.65, 0.75 + energyJ / 650);
    const startScale = (0.16 + Math.random() * 0.08) * energyScale;
    const endScale = (0.58 + Math.random() * 0.28) * energyScale;
    puff.setPosition(worldPos.x, worldPos.y, worldPos.z);
    puff.setLocalEulerAngles(90, Math.random() * 360, 0);
    puff.setLocalScale(startScale, 1, startScale);
    this.fxRoot.addChild(puff);

    this.mistPuffs.push({
      entity: puff,
      meshInstance: puffMi,
      position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
      velocity: new pc.Vec3(
        dir.x * driftSpeed + (Math.random() - 0.5) * 0.85,
        Math.max(0.25, dir.y * driftSpeed * 0.65 + 0.42),
        dir.z * driftSpeed + (Math.random() - 0.5) * 0.85
      ),
      life: 0,
      maxLife: 0.62 + Math.random() * 0.34,
      startScale,
      endScale,
      spinSpeedDeg: (Math.random() - 0.5) * 65,
    });
  }

  /**
   * Spawns anatomically convincing wet muscle/fascia & splintered cortical bone/marrow gibs on severing.
   */
  public spawnDismembermentGibs(event: DismembermentEvent): void {
    const count = Math.max(4, event.gibCount);
    const origin = event.stumpWorldPosition;
    const launchVel = event.severedLimbVelocity;

    // Immediate fine backlit mist cloud & arterial spray burst at severing plane
    this.spawnBloodBurst(origin, event.arterialSprayDirection, 360, 18);

    for (let i = 0; i < count; i++) {
      const isBonePredominant = i % 3 === 0;
      const gibRoot = new pc.Entity('GibChunk');

      if (isBonePredominant) {
        // Splintered cortical bone diaphysis fragment with exposed crimson marrow core & attached wet tissue
        const boneShaft = new pc.Entity('CorticalBoneFragment');
        boneShaft.addComponent('render', {
          type: 'cylinder',
          material: this.goreSuite.wetCorticalBoneMat,
          castShadows: true,
          receiveShadows: true,
        });
        const r = 0.015 + Math.random() * 0.01;
        const len = 0.058 + Math.random() * 0.038;
        boneShaft.setLocalScale(r, len, r * 0.88);
        gibRoot.addChild(boneShaft);

        const marrowCore = new pc.Entity('TrabecularMarrowCore');
        marrowCore.addComponent('render', {
          type: 'cylinder',
          material: this.goreSuite.wetMarrowCapMat,
          castShadows: false,
        });
        marrowCore.setLocalPosition(0, len * 0.48, 0);
        marrowCore.setLocalScale(r * 0.68, 0.012, r * 0.68);
        gibRoot.addChild(marrowCore);

        const tissueCuff = new pc.Entity('AdherentMuscleCuff');
        tissueCuff.addComponent('render', {
          type: 'sphere',
          material: this.goreSuite.wetFleshGibMat,
          castShadows: true,
        });
        tissueCuff.setLocalPosition(r * 0.35, -len * 0.18, 0);
        tissueCuff.setLocalScale(r * 1.65, len * 0.55, r * 1.45);
        gibRoot.addChild(tissueCuff);
      } else {
        // Wet striated muscle & fascia chunk with protruding bone splinter
        const meatMass = new pc.Entity('WetMuscleMass');
        meatMass.addComponent('render', {
          type: i % 2 === 0 ? 'capsule' : 'sphere',
          material: this.goreSuite.wetFleshGibMat,
          castShadows: true,
          receiveShadows: true,
        });
        const s = 0.036 + Math.random() * 0.036;
        meatMass.setLocalScale(s * 0.92, s * 1.38, s * 0.84);
        gibRoot.addChild(meatMass);

        if (i % 2 === 1) {
          const boneSplinter = new pc.Entity('BoneSplinterSpur');
          boneSplinter.addComponent('render', {
            type: 'cone',
            material: this.goreSuite.wetCorticalBoneMat,
            castShadows: false,
          });
          boneSplinter.setLocalPosition(0, s * 0.58, 0);
          boneSplinter.setLocalScale(s * 0.32, s * 0.72, s * 0.32);
          gibRoot.addChild(boneSplinter);
        }
      }

      gibRoot.setPosition(origin.x, origin.y, origin.z);
      gibRoot.setLocalEulerAngles(
        Math.random() * 360,
        Math.random() * 360,
        Math.random() * 360
      );
      this.fxRoot.addChild(gibRoot);

      const vx = launchVel.x * 0.68 + (Math.random() - 0.5) * 4.5;
      const vy = Math.max(1.9, launchVel.y * 0.58 + Math.random() * 3.4);
      const vz = launchVel.z * 0.68 + (Math.random() - 0.5) * 4.5;

      this.gibChunks.push({
        entity: gibRoot,
        position: new pc.Vec3(origin.x, origin.y, origin.z),
        velocity: new pc.Vec3(vx, vy, vz),
        angularVelocity: new pc.Vec3(
          (Math.random() - 0.5) * 22,
          (Math.random() - 0.5) * 22,
          (Math.random() - 0.5) * 22
        ),
        bounces: 0,
        life: 0,
        maxLife: 12.0,
        leavesBlood: true,
        restHeight: 0.026,
      });
    }
  }

  /**
   * Attaches a continuous pulsing arterial blood stream spraying from the parent body's severed stump socket!
   */
  public attachArterialFountain(
    target: TargetHealthState,
    event: DismembermentEvent
  ): void {
    this.arterialFountains.push({
      target,
      zone: event.zone,
      parentZone: event.parentZone,
      stumpPos: copyVec3(event.stumpWorldPosition),
      sprayDir: copyVec3(event.arterialSprayDirection),
      durationS: 3.8,
      elapsedS: 0,
      dropTimerS: 0,
    });
  }

  /**
   * Spawns wet ivory cortical bone shards when a projectile shatters bone.
   */
  public spawnBoneShatterSparks(worldPos: Vec3Like, dir: Vec3Like): void {
    const shardCount = 12;
    for (let i = 0; i < shardCount; i++) {
      const shard = new pc.Entity('BoneShard');
      shard.addComponent('render', {
        type: i % 3 === 0 ? 'cone' : 'box',
        material: this.goreSuite.wetCorticalBoneMat,
      });
      const s = 0.011 + Math.random() * 0.015;
      shard.setLocalScale(s * 0.75, s * 2.3, s * 0.55);
      shard.setPosition(worldPos.x, worldPos.y, worldPos.z);
      shard.setLocalEulerAngles(Math.random() * 360, Math.random() * 360, Math.random() * 360);
      this.fxRoot.addChild(shard);

      const spd = 2.4 + Math.random() * 4.0;
      this.boneShards.push({
        entity: shard,
        position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
        velocity: new pc.Vec3(
          dir.x * spd + (Math.random() - 0.5) * 2.8,
          dir.y * spd + Math.random() * 2.4,
          dir.z * spd + (Math.random() - 0.5) * 2.8
        ),
        life: 0,
      });
    }
  }

  /**
   * Spawns an organic multi-lobed glossy wet-edge arterial pool on the floor.
   */
  private spawnBloodPool(pos: pc.Vec3, maxRadius = 0.34): void {
    const pool = new pc.Entity('BloodPoolDecal');
    if (this.goreSuite.floorQuadMesh) {
      const mi = new pc.MeshInstance(this.goreSuite.floorQuadMesh, this.goreSuite.wetBloodPoolMat);
      pool.addComponent('render', {
        meshInstances: [mi],
        castShadows: false,
        receiveShadows: true,
      });
    } else {
      pool.addComponent('render', {
        type: 'cylinder',
        material: this.goreSuite.wetBloodPoolMat,
        castShadows: false,
        receiveShadows: true,
      });
    }

    const depthBias = 0.0065 + ((this.poolDepthBiasCounter++ % 16) * 0.00018);
    const aspectRatio = 0.84 + Math.random() * 0.34;
    pool.setLocalScale(0.05, 0.003, 0.05 * aspectRatio);
    pool.setPosition(pos.x, depthBias, pos.z);
    pool.setLocalEulerAngles(0, Math.random() * 360, 0);
    this.fxRoot.addChild(pool);

    this.bloodPools.push({
      entity: pool,
      currentScale: 0.05,
      targetScale: maxRadius * 2.1 * (0.82 + Math.random() * 0.42),
      growthRate: 0.62,
      aspectRatio,
    });

    if (this.bloodPools.length > 65) {
      const oldest = this.bloodPools.shift();
      if (oldest) oldest.entity.destroy();
    }
  }

  /**
   * Main per-frame update loop.
   */
  public update(dt: number, showTrails = true): void {
    const gravity = -9.81;

    // 1. Update In-Flight Projectiles
    for (let i = this.activeProjectiles.length - 1; i >= 0; i--) {
      const p = this.activeProjectiles[i];
      p.progressTimeS += dt;

      const samples = p.trajectorySamples;
      while (
        p.currentSampleIndex < samples.length - 1 &&
        samples[p.currentSampleIndex + 1].timeS <= p.progressTimeS
      ) {
        p.currentSampleIndex++;
      }

      const curSample = samples[p.currentSampleIndex];
      const nextSample = samples[Math.min(samples.length - 1, p.currentSampleIndex + 1)];

      let px = curSample.position.x;
      let py = curSample.position.y;
      let pz = curSample.position.z;

      const segDt = nextSample.timeS - curSample.timeS;
      if (segDt > 1e-6) {
        const factor = Math.min(1.0, (p.progressTimeS - curSample.timeS) / segDt);
        px += (nextSample.position.x - curSample.position.x) * factor;
        py += (nextSample.position.y - curSample.position.y) * factor;
        pz += (nextSample.position.z - curSample.position.z) * factor;
      }

      p.entity.setPosition(px, py, pz);

      const vel = curSample.velocity;
      const speed = length(vel);
      if (speed > 1e-2) {
        const dir = normalize(vel);
        const lookTarget = new pc.Vec3(px + dir.x, py + dir.y, pz + dir.z);
        p.entity.lookAt(lookTarget);
        p.entity.rotateLocal(90, 0, 0);
      }

      const curPosVec = new pc.Vec3(px, py, pz);
      if (
        p.trailPoints.length === 0 ||
        curPosVec.distance(p.trailPoints[p.trailPoints.length - 1]) > 0.35
      ) {
        p.trailPoints.push(curPosVec);
      }

      if (showTrails && p.trailPoints.length >= 2) {
        for (let ptIdx = 0; ptIdx < p.trailPoints.length - 1; ptIdx++) {
          this.app.drawLine(
            p.trailPoints[ptIdx],
            p.trailPoints[ptIdx + 1],
            pc.Color.YELLOW,
            true
          );
        }
      }

      if (p.progressTimeS >= p.totalFlightTimeS) {
        p.finished = true;
        p.entity.destroy();
        this.activeProjectiles.splice(i, 1);
      }
    }

    // 2. Update Arterial Fountains (systolic cardiac pulses tracking the severed stump socket)
    for (let i = this.arterialFountains.length - 1; i >= 0; i--) {
      const f = this.arterialFountains[i];
      f.elapsedS += dt;
      f.dropTimerS += dt;

      if (f.target) {
        const socketZone = f.parentZone || f.zone;
        if (socketZone && f.target.ragdollBones[socketZone]) {
          const b = f.target.ragdollBones[socketZone];
          f.stumpPos = copyVec3(b.distalPosition || b.position);
          const out = sub(b.distalPosition, b.position);
          if (length(out) > 0.02) {
            f.sprayDir = normalize(scale(out, 1));
          } else {
            f.sprayDir = copyVec3(b.basisUp);
          }
        }
      }

      const pressureDecay = Math.max(0.28, 1.0 - (f.elapsedS / f.durationS) * 0.65);
      const systolicPulse = 1.0 + Math.max(0, Math.sin(f.elapsedS * 11.2)) * 0.95;
      const pulseRate = systolicPulse * pressureDecay;
      if (f.dropTimerS >= 0.048 / Math.max(0.3, pulseRate)) {
        f.dropTimerS = 0;
        const sprayDirNorm = normalize(f.sprayDir);
        this.spawnBloodBurst(f.stumpPos, sprayDirNorm, 48 * pulseRate, 4);
      }

      if (f.elapsedS >= f.durationS) {
        this.arterialFountains.splice(i, 1);
      }
    }

    // 3. Update In-Flight Velocity-Stretched Blood Droplets
    for (let i = this.bloodDrops.length - 1; i >= 0; i--) {
      const drop = this.bloodDrops[i];
      drop.life += dt;
      drop.velocity.y += gravity * dt;

      drop.position.x += drop.velocity.x * dt;
      drop.position.y += drop.velocity.y * dt;
      drop.position.z += drop.velocity.z * dt;

      drop.entity.setPosition(drop.position.x, drop.position.y, drop.position.z);

      const spd = drop.velocity.length();
      if (spd > 0.25) {
        const r = drop.baseRadius ?? 0.016;
        const stretch = Math.min(3.4, 1.0 + spd * 0.24);
        drop.entity.setLocalScale(r * 0.82, r * 0.82, r * stretch);
        drop.entity.lookAt(
          drop.position.x + drop.velocity.x,
          drop.position.y + drop.velocity.y,
          drop.position.z + drop.velocity.z
        );
      }

      if (drop.position.y <= 0.015) {
        this.spawnBloodPool(drop.position, 0.25);
        drop.entity.destroy();
        this.bloodDrops.splice(i, 1);
        continue;
      }

      if (drop.life >= drop.maxLife) {
        drop.entity.destroy();
        this.bloodDrops.splice(i, 1);
      }
    }

    // 4. Update Backlit Arterial Blood Mist Puffs
    if (
      this.mistPuffs.length > 0 &&
      (!this.cachedPlayerCamera ||
        (this.cachedPlayerCamera as unknown as { _destroyed?: boolean })._destroyed)
    ) {
      this.cachedPlayerCamera = this.app.root.findByName('PlayerCamera') as pc.Entity | null;
    }
    const camPos =
      this.mistPuffs.length > 0 && this.cachedPlayerCamera
        ? this.cachedPlayerCamera.getPosition()
        : null;
    for (let i = this.mistPuffs.length - 1; i >= 0; i--) {
      const puff = this.mistPuffs[i];
      puff.life += dt;
      if (puff.life >= puff.maxLife) {
        puff.entity.destroy();
        this.mistPuffs.splice(i, 1);
        continue;
      }

      const t = puff.life / puff.maxLife;
      const drag = Math.exp(-3.2 * dt);
      puff.velocity.scale(drag);
      puff.velocity.y -= 0.65 * dt;
      puff.position.x += puff.velocity.x * dt;
      puff.position.y = Math.max(0.08, puff.position.y + puff.velocity.y * dt);
      puff.position.z += puff.velocity.z * dt;

      puff.entity.setPosition(puff.position.x, puff.position.y, puff.position.z);
      if (camPos) {
        puff.entity.lookAt(camPos);
        puff.entity.rotateLocal(90, puff.life * puff.spinSpeedDeg, 0);
      }

      const curScale = puff.startScale + (puff.endScale - puff.startScale) * (1 - (1 - t) * (1 - t));
      puff.entity.setLocalScale(curScale, 1, curScale);
      puff.meshInstance?.setParameter('material_opacity', 0.54 * (1 - t) * (1 - t));
    }

    // 5. Update Gib Chunks & Detached Physics Props (Helmets / Weapons)
    for (let i = this.gibChunks.length - 1; i >= 0; i--) {
      const gib = this.gibChunks[i];
      gib.life += dt;
      gib.velocity.y += gravity * dt;

      gib.position.x += gib.velocity.x * dt;
      gib.position.y += gib.velocity.y * dt;
      gib.position.z += gib.velocity.z * dt;

      gib.entity.setPosition(gib.position.x, gib.position.y, gib.position.z);
      if (gib.angularVelocity.length() > 0.05) {
        gib.entity.rotate(
          gib.angularVelocity.x * dt * 45,
          gib.angularVelocity.y * dt * 45,
          gib.angularVelocity.z * dt * 45
        );
      }

      if (gib.position.y <= gib.restHeight) {
        gib.position.y = gib.restHeight;
        gib.bounces++;
        if (gib.leavesBlood && gib.bounces <= 2) {
          this.spawnBloodPool(gib.position, 0.3);
        }

        if (gib.bounces <= 2 && Math.abs(gib.velocity.y) > 0.5) {
          gib.velocity.y = -gib.velocity.y * 0.32;
          gib.velocity.x *= 0.58;
          gib.velocity.z *= 0.58;
          gib.angularVelocity.set(
            gib.angularVelocity.x * 0.5,
            gib.angularVelocity.y * 0.5,
            gib.angularVelocity.z * 0.2
          );
        } else {
          gib.velocity.set(0, 0, 0);
          gib.angularVelocity.set(0, 0, 0);
          if (!gib.leavesBlood && gib.bounces === 3) {
            const eul = gib.entity.getLocalEulerAngles();
            gib.entity.setLocalEulerAngles(0, eul.y, 88);
          }
        }
      }

      if (gib.life >= gib.maxLife) {
        gib.entity.destroy();
        this.gibChunks.splice(i, 1);
      }
    }

    // 6. Update Bone & Armor Sparks
    for (let i = this.boneShards.length - 1; i >= 0; i--) {
      const shard = this.boneShards[i];
      shard.life += dt;
      shard.velocity.y += gravity * dt;

      shard.position.x += shard.velocity.x * dt;
      shard.position.y += shard.velocity.y * dt;
      shard.position.z += shard.velocity.z * dt;

      shard.entity.setPosition(shard.position.x, shard.position.y, shard.position.z);

      if (shard.position.y <= 0.015) {
        shard.position.y = 0.015;
        shard.velocity.set(0, 0, 0);
      }

      if (shard.life >= 3.2) {
        shard.entity.destroy();
        this.boneShards.splice(i, 1);
      }
    }

    // 7. Expand Glossy Wet-Edge Ground Blood Pools
    for (const pool of this.bloodPools) {
      if (pool.currentScale < pool.targetScale) {
        pool.currentScale = Math.min(
          pool.targetScale,
          pool.currentScale + pool.growthRate * dt
        );
        const ar = pool.aspectRatio ?? 1.0;
        pool.entity.setLocalScale(pool.currentScale, 0.003, pool.currentScale * ar);
      }
    }
  }

  /**
   * Resets all active FX when respawning targets.
   */
  public clearAll(): void {
    for (const p of this.activeProjectiles) p.entity.destroy();
    for (const d of this.bloodDrops) d.entity.destroy();
    for (const m of this.mistPuffs) {
      m.entity.destroy();
    }
    for (const g of this.gibChunks) g.entity.destroy();
    for (const s of this.boneShards) s.entity.destroy();
    for (const b of this.bloodPools) b.entity.destroy();

    this.activeProjectiles = [];
    this.bloodDrops = [];
    this.mistPuffs = [];
    this.gibChunks = [];
    this.boneShards = [];
    this.bloodPools = [];
    this.arterialFountains = [];
  }
}
