import * as pc from 'playcanvas';
import { Vec3Like } from '../../contracts/ballistics.ts';
import {
  CharacterTransform,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityState,
  VascularWoundRecord,
  VesselKind,
} from '../../contracts/physiology.ts';
import {
  characterLocalDirectionToWorld,
  characterLocalPointToWorld,
} from '../../core/ghoul/bvhVolumes.ts';
import { normalize } from '../../core/ballistics/vec3.ts';
import { EngineMaterialPalette } from '../materials.ts';

export interface VascularBloodMaterials {
  readonly arterialJetMat: pc.StandardMaterial;
  readonly arterialPoolMat: pc.StandardMaterial;
  readonly venousOozeMat: pc.StandardMaterial;
  readonly venousPoolMat: pc.StandardMaterial;
}

export interface ActiveVascularParticle {
  readonly entity: pc.Entity;
  readonly vesselKind: VesselKind;
  readonly position: pc.Vec3;
  readonly velocity: pc.Vec3;
  ageS: number;
  readonly maxLifeS: number;
}

export interface ActiveVascularFloorPool {
  readonly entity: pc.Entity;
  readonly vesselKind: VesselKind;
  readonly centerX: number;
  readonly centerZ: number;
  currentRadiusM: number;
  targetRadiusM: number;
  growthRateMPerSec: number;
}

interface ActiveVascularMistPuff {
  readonly entity: pc.Entity;
  readonly position: pc.Vec3;
  readonly velocity: pc.Vec3;
  ageS: number;
  readonly maxLifeS: number;
  readonly startScale: number;
  readonly endScale: number;
}

interface BoundPhysiologyEmitter {
  readonly state: PhysiologicalEntityState;
  readonly getTransform?: () => CharacterTransform;
  readonly woundTimers: Map<string, number>;
}

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

interface WetBloodProceduralMaps {
  readonly dropletNormalMap: pc.Texture;
  readonly poolAlbedoAlphaArterial: pc.Texture;
  readonly poolAlbedoAlphaVenous: pc.Texture;
  readonly poolMeniscusNormalMap: pc.Texture;
  readonly mistAlphaMap: pc.Texture;
}

const deviceMapCache = new WeakMap<pc.GraphicsDevice, WetBloodProceduralMaps>();

function getOrCreateWetBloodMaps(device: pc.GraphicsDevice): WetBloodProceduralMaps {
  const existing = deviceMapCache.get(device);
  if (existing) {
    return existing;
  }

  const aniso = Math.max(1, Math.min(device.maxAnisotropy || 4, 8));

  // 1. 64x64 Wet liquid surface-tension micro-normal map for droplets & streams
  const dropSize = 64;
  const dropNormPixels = new Uint8Array(dropSize * dropSize * 4);
  for (let y = 0; y < dropSize; y++) {
    for (let x = 0; x < dropSize; x++) {
      const u = x / dropSize;
      const v = y / dropSize;
      const hC = valueNoise2d(u * 12, v * 12, 101) * 0.65 + valueNoise2d(u * 26, v * 26, 211) * 0.35;
      const hR =
        valueNoise2d((u + 1 / dropSize) * 12, v * 12, 101) * 0.65 +
        valueNoise2d((u + 1 / dropSize) * 26, v * 26, 211) * 0.35;
      const hU =
        valueNoise2d(u * 12, (v + 1 / dropSize) * 12, 101) * 0.65 +
        valueNoise2d(u * 26, (v + 1 / dropSize) * 26, 211) * 0.35;

      let nx = -(hR - hC) * 2.2;
      let ny = -(hU - hC) * 2.2;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;

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

  // 2. 128x128 Organic multi-lobed liquid blood pool height + meniscus normal + arterial/venous RGBA
  const poolSize = 128;
  const poolHeight = new Float32Array(poolSize * poolSize);
  const artPixels = new Uint8Array(poolSize * poolSize * 4);
  const venPixels = new Uint8Array(poolSize * poolSize * 4);
  const poolNormPixels = new Uint8Array(poolSize * poolSize * 4);

  for (let y = 0; y < poolSize; y++) {
    const v = (y + 0.5) / poolSize;
    for (let x = 0; x < poolSize; x++) {
      const u = (x + 0.5) / poolSize;
      const dx = (u - 0.5) * 2;
      const dy = (v - 0.5) * 2;
      const r = Math.hypot(dx, dy);
      const theta = Math.atan2(dy, dx);

      // Multi-lobed viscous surface-tension contour
      const lobes =
        0.12 * Math.sin(theta * 3 + 0.4) +
        0.075 * Math.cos(theta * 5 - 1.1) +
        0.045 * Math.sin(theta * 8 + 2.1) +
        (valueNoise2d(u * 9.5, v * 9.5, 307) - 0.5) * 0.12;
      const edgeR = 0.82 + lobes;

      let thickness = 0;
      if (r < edgeR) {
        const edgeDist = (edgeR - r) / Math.max(0.15, edgeR);
        // Classic liquid meniscus: plump rounded rim right inside the boundary + glossy flat-ish interior
        const meniscus = Math.min(1, Math.pow(edgeDist * 4.2, 0.58));
        const rimBead =
          edgeDist > 0.02 && edgeDist < 0.24
            ? Math.sin(((edgeDist - 0.02) / 0.22) * Math.PI) * 0.22
            : 0;
        const ripple = (valueNoise2d(u * 18, v * 18, 409) - 0.5) * 0.04;
        thickness = Math.max(0, Math.min(1, meniscus + rimBead + ripple));
      }
      poolHeight[y * poolSize + x] = thickness;

      const alpha = thickness > 0.01 ? Math.min(1, thickness * 2.8) : 0;
      // Deeper coagulating dark ruby center, brighter translucent oxygenated crimson rim
      const centerCoag = Math.max(0, 1 - r / Math.max(0.2, edgeR));
      const p4 = (y * poolSize + x) * 4;

      // Arterial pool: rich oxygenated crimson rim -> deep ruby-garnet core
      const artRimBoost = 1.0 - centerCoag * 0.44;
      artPixels[p4] = Math.round((152 * artRimBoost + 22));
      artPixels[p4 + 1] = Math.round(10 * artRimBoost + 2);
      artPixels[p4 + 2] = Math.round(16 * artRimBoost + 4);
      artPixels[p4 + 3] = Math.round(alpha * 250);

      // Venous pool: dark deoxygenated maroon-burgundy
      const venRimBoost = 1.0 - centerCoag * 0.38;
      venPixels[p4] = Math.round(88 * venRimBoost + 12);
      venPixels[p4 + 1] = Math.round(5 * venRimBoost + 1);
      venPixels[p4 + 2] = Math.round(12 * venRimBoost + 3);
      venPixels[p4 + 3] = Math.round(alpha * 252);
    }
  }

  for (let y = 0; y < poolSize; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(poolSize - 1, y + 1);
    for (let x = 0; x < poolSize; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(poolSize - 1, x + 1);
      const dhdx = (poolHeight[y * poolSize + xp] - poolHeight[y * poolSize + xm]) * 3.6;
      const dhdy = (poolHeight[yp * poolSize + x] - poolHeight[ym * poolSize + x]) * 3.6;
      let nx = -dhdx;
      let ny = -dhdy;
      let nz = 1.0;
      const nLen = Math.hypot(nx, ny, nz);
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      const p4 = (y * poolSize + x) * 4;
      poolNormPixels[p4] = Math.round((nx * 0.5 + 0.5) * 255);
      poolNormPixels[p4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      poolNormPixels[p4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      poolNormPixels[p4 + 3] = 255;
    }
  }

  const makePoolTex = (name: string, data: Uint8Array): pc.Texture => {
    const tex = new pc.Texture(device, {
      name,
      width: poolSize,
      height: poolSize,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: pc.FILTER_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      anisotropy: aniso,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    (tex.lock() as Uint8Array).set(data);
    tex.unlock();
    return tex;
  };

  // 3. 64x64 Soft backlit arterial aerosol mist texture
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
      mistPixels[p4] = 165;
      mistPixels[p4 + 1] = 12;
      mistPixels[p4 + 2] = 18;
      mistPixels[p4 + 3] = Math.round(alpha * 220);
    }
  }
  const mistAlphaMap = new pc.Texture(device, {
    name: 'vascularArterialMistTex',
    width: mistSize,
    height: mistSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
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

/**
 * Builds distinct oxygenated rich-crimson arterial vs deoxygenated dark-maroon venous PlayCanvas
 * wet PBR materials (`metalness: 0.08..0.14`, high `gloss: 0.88..0.94`, wet clearCoat + meniscus normals).
 */
export function createVascularBloodMaterials(
  palette?: EngineMaterialPalette,
  device?: pc.GraphicsDevice | null
): VascularBloodMaterials {
  const [ar, ag, ab] = PHYSIOLOGY_CONSTANTS.ARTERIAL_CRIMSON_RGB;
  const [vr, vg, vb] = PHYSIOLOGY_CONSTANTS.VENOUS_MAROON_RGB;
  const maps = device ? getOrCreateWetBloodMaps(device) : null;

  const arterialJetMat = new pc.StandardMaterial();
  arterialJetMat.name = 'vascularArterialJetMat';
  arterialJetMat.diffuse = new pc.Color(ar, ag, ab);
  arterialJetMat.emissive = new pc.Color(0.055, 0.002, 0.004);
  arterialJetMat.useMetalness = true;
  arterialJetMat.metalness = 0.09;
  arterialJetMat.gloss = palette ? Math.max(0.88, palette.bloodDropMat.shininess / 100) : 0.9;
  arterialJetMat.clearCoat = 0.86;
  arterialJetMat.clearCoatGloss = 0.95;
  arterialJetMat.fresnelModel = pc.FRESNEL_SCHLICK;
  if (maps) {
    arterialJetMat.normalMap = maps.dropletNormalMap;
    arterialJetMat.bumpiness = 0.45;
  }
  arterialJetMat.update();

  const arterialPoolMat = new pc.StandardMaterial();
  arterialPoolMat.name = 'vascularArterialPoolMat';
  arterialPoolMat.diffuse = maps
    ? new pc.Color(0.88, 0.82, 0.82)
    : new pc.Color(ar * 0.48, ag * 0.35, ab * 0.38);
  arterialPoolMat.emissive = new pc.Color(0.025, 0.001, 0.002);
  arterialPoolMat.useMetalness = true;
  arterialPoolMat.metalness = 0.12;
  arterialPoolMat.gloss = palette ? Math.max(0.91, palette.bloodPoolMat.shininess / 100) : 0.92;
  arterialPoolMat.clearCoat = 0.92;
  arterialPoolMat.clearCoatGloss = 0.96;
  arterialPoolMat.fresnelModel = pc.FRESNEL_SCHLICK;
  arterialPoolMat.opacity = 0.94;
  arterialPoolMat.blendType = pc.BLEND_NORMAL;
  arterialPoolMat.depthWrite = false;
  if (maps) {
    arterialPoolMat.diffuseMap = maps.poolAlbedoAlphaArterial;
    arterialPoolMat.opacityMap = maps.poolAlbedoAlphaArterial;
    arterialPoolMat.opacityMapChannel = 'a';
    arterialPoolMat.normalMap = maps.poolMeniscusNormalMap;
    arterialPoolMat.bumpiness = 1.15;
  }
  arterialPoolMat.update();

  const venousOozeMat = new pc.StandardMaterial();
  venousOozeMat.name = 'vascularVenousOozeMat';
  venousOozeMat.diffuse = new pc.Color(vr, vg, vb);
  venousOozeMat.emissive = new pc.Color(0.018, 0.0, 0.003);
  venousOozeMat.useMetalness = true;
  venousOozeMat.metalness = 0.1;
  venousOozeMat.gloss = 0.88;
  venousOozeMat.clearCoat = 0.84;
  venousOozeMat.clearCoatGloss = 0.94;
  venousOozeMat.fresnelModel = pc.FRESNEL_SCHLICK;
  if (maps) {
    venousOozeMat.normalMap = maps.dropletNormalMap;
    venousOozeMat.bumpiness = 0.4;
  }
  venousOozeMat.update();

  const venousPoolMat = new pc.StandardMaterial();
  venousPoolMat.name = 'vascularVenousPoolMat';
  venousPoolMat.diffuse = maps
    ? new pc.Color(0.84, 0.8, 0.82)
    : new pc.Color(vr * 0.68, vg * 0.6, vb * 0.68);
  venousPoolMat.emissive = new pc.Color(0.012, 0.0, 0.002);
  venousPoolMat.useMetalness = true;
  venousPoolMat.metalness = 0.13;
  venousPoolMat.gloss = palette ? Math.max(0.92, palette.bloodPoolMat.shininess / 100) : 0.94;
  venousPoolMat.clearCoat = 0.94;
  venousPoolMat.clearCoatGloss = 0.97;
  venousPoolMat.fresnelModel = pc.FRESNEL_SCHLICK;
  venousPoolMat.opacity = 0.95;
  venousPoolMat.blendType = pc.BLEND_NORMAL;
  venousPoolMat.depthWrite = false;
  if (maps) {
    venousPoolMat.diffuseMap = maps.poolAlbedoAlphaVenous;
    venousPoolMat.opacityMap = maps.poolAlbedoAlphaVenous;
    venousPoolMat.opacityMapChannel = 'a';
    venousPoolMat.normalMap = maps.poolMeniscusNormalMap;
    venousPoolMat.bumpiness = 1.2;
  }
  venousPoolMat.update();

  return {
    arterialJetMat,
    arterialPoolMat,
    venousOozeMat,
    venousPoolMat,
  };
}

/**
 * Pure helper computing instantaneous systolic pulse intensity [0..1] synced to `heartRateBpm`.
 */
export function evaluateSystolicPulseWave(elapsedTimeS: number, heartRateBpm: number): number {
  if (heartRateBpm <= 0) return 0;
  const freqHz = heartRateBpm / 60;
  const phase = ((elapsedTimeS * freqHz) % 1 + 1) % 1;
  // Crisp systolic ejection peak over first 26% of cardiac cycle followed by dicrotic diastolic decay
  if (phase < 0.26) {
    return Math.sin((phase / 0.26) * Math.PI * 0.5);
  }
  return Math.exp(-(phase - 0.26) * 4.6);
}

/**
 * Renders distinct systolic-pulsed crimson arterial jets, backlit aerosol mist, and dark maroon
 * venous oozing & glossy meniscus floor pools driven directly by `PhysiologicalEntityState` vascular wounds.
 */
export class VascularBloodFxEmitter {
  public readonly app: pc.AppBase;
  public readonly palette: EngineMaterialPalette;
  public readonly vascularMaterials: VascularBloodMaterials;
  public readonly fxRoot: pc.Entity;

  private readonly maxParticles: number;
  private readonly maxPools: number;
  private readonly particles: ActiveVascularParticle[] = [];
  private readonly pools: ActiveVascularFloorPool[] = [];
  private readonly mistPuffs: ActiveVascularMistPuff[] = [];
  private readonly boundEntities = new Map<string, BoundPhysiologyEmitter>();
  private readonly mistMaterial: pc.StandardMaterial | null = null;
  private readonly scratchLookAt = new pc.Vec3();

  constructor(
    app: pc.AppBase,
    palette: EngineMaterialPalette,
    maxParticles = 160,
    maxPools = 48
  ) {
    this.app = app;
    this.palette = palette;
    const device = app.graphicsDevice ?? null;
    this.vascularMaterials = createVascularBloodMaterials(palette, device);
    this.maxParticles = maxParticles;
    this.maxPools = maxPools;

    if (device) {
      const maps = getOrCreateWetBloodMaps(device);
      const mistMat = new pc.StandardMaterial();
      mistMat.name = 'vascularBacklitMistMat';
      mistMat.diffuse = new pc.Color(0.44, 0.016, 0.026);
      mistMat.emissive = new pc.Color(0.11, 0.006, 0.01);
      mistMat.opacityMap = maps.mistAlphaMap;
      mistMat.opacityMapChannel = 'a';
      mistMat.opacity = 0.44;
      mistMat.blendType = pc.BLEND_NORMAL;
      mistMat.depthWrite = false;
      mistMat.cull = pc.CULLFACE_NONE;
      mistMat.useLighting = true;
      mistMat.update();
      this.mistMaterial = mistMat;
    }

    this.fxRoot = new pc.Entity('VascularBloodFxRoot', this.app);
    this.app.root.addChild(this.fxRoot);
  }

  public bindEntity(
    state: PhysiologicalEntityState,
    getTransform?: () => CharacterTransform
  ): void {
    this.boundEntities.set(state.entityId, {
      state,
      getTransform,
      woundTimers: new Map(),
    });
  }

  public unbindEntity(entityId: string): boolean {
    return this.boundEntities.delete(entityId);
  }

  public getActiveCounts(): {
    particles: number;
    arterialParticles: number;
    venousParticles: number;
    floorPools: number;
  } {
    let arterialParticles = 0;
    let venousParticles = 0;
    for (const p of this.particles) {
      if (p.vesselKind === 'ARTERIAL') arterialParticles++;
      else venousParticles++;
    }
    return {
      particles: this.particles.length,
      arterialParticles,
      venousParticles,
      floorPools: this.pools.length,
    };
  }

  /**
   * Emits systolic arterial jets or dark venous ooze droplets for a single entity over `dt`.
   */
  public emitFromEntityState(
    state: PhysiologicalEntityState,
    dt: number,
    transform?: CharacterTransform,
    woundTimers?: Map<string, number>
  ): void {
    if (state.vascularWounds.length === 0 || dt <= 0) return;

    const mapRatio = state.alive
      ? Math.max(0, state.meanArterialPressureMmHg / PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG)
      : 0;
    const systolicWave = evaluateSystolicPulseWave(state.elapsedTimeS, state.heartRateBpm);

    for (let i = 0; i < state.vascularWounds.length; i++) {
      const wound = state.vascularWounds[i];
      const key = `${wound.vesselId}_${wound.vesselKind}_${i}`;
      const prevTimer = woundTimers ? (woundTimers.get(key) ?? 0) : 0;
      let timer = prevTimer + dt;

      const worldOrigin = transform
        ? characterLocalPointToWorld(wound.positionLocal, transform, wound.ghoulZone)
        : wound.positionWorld;
      const worldDir = transform
        ? characterLocalDirectionToWorld(wound.sprayDirectionWorld, transform)
        : normalize(wound.sprayDirectionWorld);

      if (wound.vesselKind === 'ARTERIAL' && state.alive && mapRatio > 0.12) {
        // Systolic-pulsed high-velocity crimson arterial jet (3.5–6.5 m/s) + backlit aerosol mist
        const pulseGate = 0.22 + 0.78 * systolicWave;
        const intervalS = Math.max(0.022, 0.075 / Math.max(0.25, pulseGate * mapRatio));

        while (timer >= intervalS) {
          timer -= intervalS;
          if (systolicWave >= 0.25) {
            const jetSpeed =
              (3.5 + Math.min(3.0, (wound.baseBleedMlPerSec / 95) * 3.0)) *
              (0.45 + 0.55 * mapRatio) *
              (0.55 + 0.45 * systolicWave);
            this.spawnArterialJetDroplet(worldOrigin, worldDir, jetSpeed);
            if (systolicWave >= 0.65 && this.mistPuffs.length < 24) {
              this.spawnArterialMistWisp(worldOrigin, worldDir, jetSpeed * 0.36);
            }
          }
        }
      } else if (state.alive || mapRatio > 0 || wound.vesselKind === 'VENOUS') {
        // Steady low-pressure deoxygenated dark-maroon venous drip + floor pool expansion
        const oozeFactor = state.alive ? Math.max(0.25, mapRatio) : 0.12;
        const intervalS = Math.max(
          0.065,
          0.18 / Math.max(0.2, (wound.baseBleedMlPerSec / 14) * oozeFactor)
        );
        while (timer >= intervalS) {
          timer -= intervalS;
          this.spawnVenousOozeDrip(worldOrigin, worldDir, 0.38 + 0.35 * oozeFactor);
        }
      }

      if (woundTimers) {
        woundTimers.set(key, timer);
      }
    }
  }

  public spawnArterialJetDroplet(
    originWorld: Vec3Like,
    sprayDirWorld: Vec3Like,
    jetSpeedMs: number
  ): ActiveVascularParticle {
    this.enforceParticleCap();
    const dir = normalize(sprayDirWorld);

    const drop = new pc.Entity('ArterialJetDrop', this.app);
    if (this.app.systems?.render) {
      drop.addComponent('render', {
        type: 'sphere',
        material: this.vascularMaterials.arterialJetMat,
        castShadows: false,
      });
    }
    const streakLen = Math.min(0.068, Math.max(0.028, jetSpeedMs * 0.009));
    drop.setLocalScale(0.013, 0.013, streakLen);
    drop.setPosition(originWorld.x, originWorld.y, originWorld.z);
    this.fxRoot.addChild(drop);

    const jitter = 0.22;
    const vx = dir.x * jetSpeedMs + (Math.random() - 0.5) * jitter * jetSpeedMs;
    const vy = dir.y * jetSpeedMs + 0.58 + (Math.random() - 0.5) * jitter * jetSpeedMs;
    const vz = dir.z * jetSpeedMs + (Math.random() - 0.5) * jitter * jetSpeedMs;

    if (Math.hypot(vx, vy, vz) > 1e-3) {
      drop.lookAt(originWorld.x + vx, originWorld.y + vy, originWorld.z + vz);
    }

    const p: ActiveVascularParticle = {
      entity: drop,
      vesselKind: 'ARTERIAL',
      position: new pc.Vec3(originWorld.x, originWorld.y, originWorld.z),
      velocity: new pc.Vec3(vx, vy, vz),
      ageS: 0,
      maxLifeS: 2.2,
    };
    this.particles.push(p);
    return p;
  }

  public spawnVenousOozeDrip(
    originWorld: Vec3Like,
    oozeDirWorld: Vec3Like,
    dripSpeedMs = 0.52
  ): ActiveVascularParticle {
    this.enforceParticleCap();
    const dir = normalize(oozeDirWorld);

    const drip = new pc.Entity('VenousOozeDrip', this.app);
    if (this.app.systems?.render) {
      drip.addComponent('render', {
        type: 'sphere',
        material: this.vascularMaterials.venousOozeMat,
        castShadows: false,
      });
    }
    drip.setLocalScale(0.018, 0.026, 0.018);
    drip.setPosition(originWorld.x, originWorld.y, originWorld.z);
    this.fxRoot.addChild(drip);

    const vx = dir.x * dripSpeedMs * 0.45 + (Math.random() - 0.5) * 0.14;
    const vy = -Math.abs(dripSpeedMs) * 0.65;
    const vz = dir.z * dripSpeedMs * 0.45 + (Math.random() - 0.5) * 0.14;

    const p: ActiveVascularParticle = {
      entity: drip,
      vesselKind: 'VENOUS',
      position: new pc.Vec3(originWorld.x, originWorld.y, originWorld.z),
      velocity: new pc.Vec3(vx, vy, vz),
      ageS: 0,
      maxLifeS: 2.6,
    };
    this.particles.push(p);
    return p;
  }

  private spawnArterialMistWisp(
    originWorld: Vec3Like,
    sprayDirWorld: Vec3Like,
    driftSpeedMs: number
  ): void {
    if (!this.app.systems?.render || !this.mistMaterial) return;

    const dir = normalize(sprayDirWorld);
    const wisp = new pc.Entity('ArterialMistWisp', this.app);
    wisp.addComponent('render', {
      type: 'plane',
      material: this.mistMaterial,
      castShadows: false,
    });
    wisp.setPosition(originWorld.x, originWorld.y, originWorld.z);
    wisp.setLocalEulerAngles(90, Math.random() * 360, (Math.random() - 0.5) * 45);
    const startScale = 0.065 + Math.random() * 0.035;
    wisp.setLocalScale(startScale, 1, startScale);
    this.fxRoot.addChild(wisp);

    this.mistPuffs.push({
      entity: wisp,
      position: new pc.Vec3(originWorld.x, originWorld.y, originWorld.z),
      velocity: new pc.Vec3(
        dir.x * driftSpeedMs + (Math.random() - 0.5) * 0.45,
        dir.y * driftSpeedMs + 0.18 + Math.random() * 0.25,
        dir.z * driftSpeedMs + (Math.random() - 0.5) * 0.45
      ),
      ageS: 0,
      maxLifeS: 0.46 + Math.random() * 0.22,
      startScale,
      endScale: startScale * (2.6 + Math.random() * 0.8),
    });
  }

  private spawnOrGrowFloorPool(x: number, z: number, vesselKind: VesselKind): void {
    // Coalesce into nearby pool of same vesselKind within 18 cm to prevent z-fighting decal spam
    for (const pool of this.pools) {
      if (pool.vesselKind !== vesselKind) continue;
      const dx = pool.centerX - x;
      const dz = pool.centerZ - z;
      if (dx * dx + dz * dz <= 0.18 * 0.18) {
        pool.targetRadiusM = Math.min(0.74, pool.targetRadiusM + 0.036);
        return;
      }
    }

    if (this.pools.length >= this.maxPools) {
      const oldest = this.pools.shift();
      if (oldest) oldest.entity.destroy();
    }

    const poolEnt = new pc.Entity(
      vesselKind === 'ARTERIAL' ? 'ArterialBloodPool' : 'VenousBloodPool',
      this.app
    );
    if (this.app.systems?.render) {
      poolEnt.addComponent('render', {
        type: 'cylinder',
        material:
          vesselKind === 'ARTERIAL'
            ? this.vascularMaterials.arterialPoolMat
            : this.vascularMaterials.venousPoolMat,
        castShadows: false,
        receiveShadows: true,
      });
    }
    const slotBias = (this.pools.length % 12) * 0.00012;
    const yHeight = (vesselKind === 'ARTERIAL' ? 0.0086 : 0.0074) + slotBias;
    poolEnt.setLocalScale(0.05, 0.0024, 0.05);
    poolEnt.setPosition(x, yHeight, z);
    poolEnt.setLocalEulerAngles(0, Math.random() * 360, 0);
    this.fxRoot.addChild(poolEnt);

    this.pools.push({
      entity: poolEnt,
      vesselKind,
      centerX: x,
      centerZ: z,
      currentRadiusM: 0.05,
      targetRadiusM: vesselKind === 'ARTERIAL' ? 0.3 : 0.38,
      growthRateMPerSec: vesselKind === 'ARTERIAL' ? 0.32 : 0.18,
    });
  }

  private enforceParticleCap(): void {
    if (this.particles.length >= this.maxParticles) {
      const oldest = this.particles.shift();
      if (oldest) oldest.entity.destroy();
    }
  }

  /**
   * Steps bound emitters, airborne velocity-aligned arterial/venous droplets, backlit mist, and expanding floor pools.
   */
  public update(dt: number): void {
    if (dt <= 0 || !Number.isFinite(dt)) return;

    for (const bound of this.boundEntities.values()) {
      const transform = bound.getTransform ? bound.getTransform() : undefined;
      this.emitFromEntityState(bound.state, dt, transform, bound.woundTimers);
    }

    const gravityY = -9.81;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.ageS += dt;
      p.velocity.y += gravityY * dt;

      // Subtle aerodynamic drag on high-speed arterial spray droplets
      if (p.vesselKind === 'ARTERIAL') {
        const drag = Math.max(0.85, 1 - dt * 1.35);
        p.velocity.x *= drag;
        p.velocity.z *= drag;
      }

      p.position.x += p.velocity.x * dt;
      p.position.y += p.velocity.y * dt;
      p.position.z += p.velocity.z * dt;
      p.entity.setPosition(p.position.x, p.position.y, p.position.z);

      if (p.vesselKind === 'ARTERIAL') {
        const spd = p.velocity.length();
        if (spd > 0.15) {
          this.scratchLookAt.set(
            p.position.x + p.velocity.x,
            p.position.y + p.velocity.y,
            p.position.z + p.velocity.z
          );
          p.entity.lookAt(this.scratchLookAt);
          const stretchZ = Math.min(0.075, Math.max(0.022, spd * 0.0085));
          p.entity.setLocalScale(0.012, 0.012, stretchZ);
        }
      }

      if (p.position.y <= 0.012) {
        this.spawnOrGrowFloorPool(p.position.x, p.position.z, p.vesselKind);
        p.entity.destroy();
        this.particles.splice(i, 1);
        continue;
      }

      if (p.ageS >= p.maxLifeS) {
        p.entity.destroy();
        this.particles.splice(i, 1);
      }
    }

    for (let i = this.mistPuffs.length - 1; i >= 0; i--) {
      const m = this.mistPuffs[i];
      m.ageS += dt;
      if (m.ageS >= m.maxLifeS) {
        m.entity.destroy();
        this.mistPuffs.splice(i, 1);
        continue;
      }
      const t = m.ageS / m.maxLifeS;
      const damp = Math.max(0.7, 1 - dt * 3.8);
      m.velocity.scale(damp);
      m.velocity.y -= 1.15 * dt;
      m.position.x += m.velocity.x * dt;
      m.position.y += m.velocity.y * dt;
      m.position.z += m.velocity.z * dt;
      m.entity.setPosition(m.position.x, m.position.y, m.position.z);
      const curS = m.startScale + (m.endScale - m.startScale) * (1 - (1 - t) * (1 - t));
      m.entity.setLocalScale(curS, 1, curS);
    }

    for (const pool of this.pools) {
      if (pool.currentRadiusM < pool.targetRadiusM) {
        pool.currentRadiusM = Math.min(
          pool.targetRadiusM,
          pool.currentRadiusM + pool.growthRateMPerSec * dt
        );
        pool.entity.setLocalScale(pool.currentRadiusM * 2, 0.0024, pool.currentRadiusM * 2);
      }
    }
  }

  public clearAll(): void {
    for (const p of this.particles) p.entity.destroy();
    for (const pool of this.pools) pool.entity.destroy();
    for (const m of this.mistPuffs) m.entity.destroy();
    this.particles.length = 0;
    this.pools.length = 0;
    this.mistPuffs.length = 0;
    for (const b of this.boundEntities.values()) {
      b.woundTimers.clear();
    }
  }

  public destroy(): void {
    this.clearAll();
    this.boundEntities.clear();
    this.fxRoot.destroy();
  }
}

export type { VascularWoundRecord };
