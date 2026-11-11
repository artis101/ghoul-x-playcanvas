import * as pc from 'playcanvas';
import { WeaponSpec, AmmoSpec } from '../../contracts/ballistics.ts';
import { WEAPONS, WEAPON_M590 } from '../../core/ballistics/weapons.ts';
import {
  GlbModelRegistry,
  WEAPON_ASSET_IDS,
  WeaponAssetId,
  WeaponGlbInstance,
} from '../assets/glbLoader.ts';
import { EngineMaterialPalette } from '../materials.ts';
import { populatePlayerWeaponViewmodel } from '../retroMeshBuilder.ts';
import { HudController } from '../hudController.ts';

export interface WeaponAmmoState {
  magCap: number;
  mag: number;
  reserve: number;
  ammoIndex: number;
}

export const WEAPON_CAPACITIES: Record<string, { magCap: number; reserve: number }> = {
  m590_shotgun: { magCap: 8, reserve: 40 },
  silver_talon_50ae: { magCap: 7, reserve: 35 },
  msg90_sniper: { magCap: 20, reserve: 60 },
  m4a1_carbine: { magCap: 30, reserve: 120 },
};

interface BarrelSmokeWisp {
  entity: pc.Entity;
  material: pc.StandardMaterial;
  position: pc.Vec3;
  velocity: pc.Vec3;
  elapsedS: number;
  durationS: number;
  startScale: number;
  endScale: number;
  baseOpacity: number;
  spinSpeedDeg: number;
}

interface ViewmodelMuzzleFxAssets {
  quadMesh: pc.Mesh;
  starPetalMat: pc.StandardMaterial;
  coreSpearMat: pc.StandardMaterial;
  coronaHaloMat: pc.StandardMaterial;
  barrelSmokeTemplateMat: pc.StandardMaterial;
  machinedGrainNormalTex: pc.Texture;
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

function toWeaponAssetId(weaponId: string): WeaponAssetId | null {
  for (const candidate of WEAPON_ASSET_IDS) {
    if (candidate === weaponId) {
      return candidate;
    }
  }
  return null;
}

function resolveGraphicsDeviceFromEntity(entity: pc.Entity): pc.GraphicsDevice | null {
  const appRef = (entity as unknown as { _app?: pc.AppBase | null })._app;
  if (appRef && appRef.graphicsDevice) {
    return appRef.graphicsDevice;
  }
  return pc.Application.getApplication()?.graphicsDevice ?? null;
}

const muzzleFxAssetCache = new WeakMap<pc.GraphicsDevice, ViewmodelMuzzleFxAssets>();

function getOrCreateViewmodelFxAssets(device: pc.GraphicsDevice): ViewmodelMuzzleFxAssets {
  const cached = muzzleFxAssetCache.get(device);
  if (cached) {
    return cached;
  }

  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);

  // Unit XY quad mesh (double-sided via material cull = CULLFACE_NONE)
  const quadMesh = new pc.Mesh(device);
  quadMesh.setPositions([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ]);
  quadMesh.setNormals([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  quadMesh.setUvs(0, [
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  quadMesh.setIndices([0, 1, 2, 0, 2, 3]);
  quadMesh.update(pc.PRIMITIVE_TRIANGLES);

  // 1. Star-petal incandescent muzzle flash texture (64x64)
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

      // Sharp crossed diamond-spear spikes along X and Y + incandescent core
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

  // 2. Front corona shock-glow texture (64x64)
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

  // 3. Soft gunsmoke / barrel heat-haze wisp texture (64x64)
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

  // 4. Subtle machined gunmetal micro-grain normal map fallback (64x64)
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

  const starPetalMat = new pc.StandardMaterial();
  starPetalMat.name = 'vmAaaMuzzleStarPetalMat';
  starPetalMat.diffuse = new pc.Color(1.0, 0.9, 0.55);
  starPetalMat.emissive = new pc.Color(1.0, 0.82, 0.38);
  starPetalMat.emissiveMap = starTex;
  starPetalMat.emissiveIntensity = 4.6;
  starPetalMat.opacityMap = starTex;
  starPetalMat.opacityMapChannel = 'a';
  starPetalMat.blendType = pc.BLEND_ADDITIVEALPHA;
  starPetalMat.depthWrite = false;
  starPetalMat.cull = pc.CULLFACE_NONE;
  starPetalMat.update();

  const coreSpearMat = new pc.StandardMaterial();
  coreSpearMat.name = 'vmAaaMuzzleCoreSpearMat';
  coreSpearMat.diffuse = new pc.Color(1.0, 0.97, 0.85);
  coreSpearMat.emissive = new pc.Color(1.0, 0.92, 0.68);
  coreSpearMat.emissiveIntensity = 5.2;
  coreSpearMat.opacity = 0.95;
  coreSpearMat.blendType = pc.BLEND_ADDITIVEALPHA;
  coreSpearMat.depthWrite = false;
  coreSpearMat.cull = pc.CULLFACE_NONE;
  coreSpearMat.update();

  const coronaHaloMat = new pc.StandardMaterial();
  coronaHaloMat.name = 'vmAaaMuzzleCoronaMat';
  coronaHaloMat.diffuse = new pc.Color(1.0, 0.78, 0.32);
  coronaHaloMat.emissive = new pc.Color(1.0, 0.68, 0.22);
  coronaHaloMat.emissiveMap = coronaTex;
  coronaHaloMat.emissiveIntensity = 3.5;
  coronaHaloMat.opacityMap = coronaTex;
  coronaHaloMat.opacityMapChannel = 'a';
  coronaHaloMat.blendType = pc.BLEND_ADDITIVEALPHA;
  coronaHaloMat.depthWrite = false;
  coronaHaloMat.cull = pc.CULLFACE_NONE;
  coronaHaloMat.update();

  const barrelSmokeTemplateMat = new pc.StandardMaterial();
  barrelSmokeTemplateMat.name = 'vmBarrelSmokeWispMat';
  barrelSmokeTemplateMat.diffuse = new pc.Color(0.74, 0.76, 0.8);
  barrelSmokeTemplateMat.emissive = new pc.Color(0.11, 0.11, 0.12);
  barrelSmokeTemplateMat.opacity = 0.24;
  barrelSmokeTemplateMat.opacityMap = smokeTex;
  barrelSmokeTemplateMat.opacityMapChannel = 'a';
  barrelSmokeTemplateMat.blendType = pc.BLEND_NORMAL;
  barrelSmokeTemplateMat.depthWrite = false;
  barrelSmokeTemplateMat.cull = pc.CULLFACE_NONE;
  barrelSmokeTemplateMat.update();

  const assets: ViewmodelMuzzleFxAssets = {
    quadMesh,
    starPetalMat,
    coreSpearMat,
    coronaHaloMat,
    barrelSmokeTemplateMat,
    machinedGrainNormalTex: grainNormalTex,
  };
  muzzleFxAssetCache.set(device, assets);
  return assets;
}

export class ArsenalManager {
  public readonly weaponViewmodelEntity: pc.Entity;
  public muzzleFlashEntity: pc.Entity;
  public activeWeaponGlb: WeaponGlbInstance | null = null;
  public currentWeaponIndex = 0;
  public currentWeapon: WeaponSpec = WEAPON_M590;
  public currentAmmo: AmmoSpec = WEAPON_M590.defaultAmmo;
  public readonly ammoInventory: Map<string, WeaponAmmoState> = new Map();
  public reloadTimerS = 0;
  public fireCooldownTimerS = 0;

  private readonly cameraEntity: pc.Entity;
  private readonly viewmodelLightRig: pc.Entity;
  private readonly materials: EngineMaterialPalette;
  private readonly hudController: HudController;
  private readonly onWeaponSwitched?: (weapon: WeaponSpec) => void;
  private glbRegistry: GlbModelRegistry | null = null;

  private muzzleLightEntity: pc.Entity | null = null;
  private muzzleFlashTimerS = 0;
  private muzzleFlashDurationS = 0.056;
  private muzzleFlashPeakIntensity = 3.8;
  private muzzleFlashBaseScale = 1.0;
  private muzzleFlashTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;

  private readonly smokeWisps: BarrelSmokeWisp[] = [];
  private readonly activeViewmodelMaterials: pc.StandardMaterial[] = [];
  private smokeRootEntity: pc.Entity | null = null;
  private shotVisualCounter = 0;

  constructor(
    cameraEntity: pc.Entity,
    materials: EngineMaterialPalette,
    hudController: HudController,
    onWeaponSwitched?: (weapon: WeaponSpec) => void,
    glbRegistry?: GlbModelRegistry | null
  ) {
    this.cameraEntity = cameraEntity;
    this.materials = materials;
    this.hudController = hudController;
    this.onWeaponSwitched = onWeaponSwitched;
    this.glbRegistry = glbRegistry ?? null;

    // Physically balanced local first-person key + cool-rim fill light rig:
    // Tight 1.25..1.35m range prevents viewmodels from ever turning flat/black in dark corners
    // without spilling onto or washing out world geometry.
    this.viewmodelLightRig = new pc.Entity('ViewmodelLightRig');
    cameraEntity.addChild(this.viewmodelLightRig);

    const keyFillLight = new pc.Entity('ViewmodelKeyFillLight');
    keyFillLight.addComponent('light', {
      type: 'omni',
      color: new pc.Color(1.0, 0.95, 0.88),
      intensity: 0.78,
      range: 1.35,
      castShadows: false,
    });
    keyFillLight.setLocalPosition(0.36, 0.24, -0.26);
    this.viewmodelLightRig.addChild(keyFillLight);

    const rimFillLight = new pc.Entity('ViewmodelRimFillLight');
    rimFillLight.addComponent('light', {
      type: 'omni',
      color: new pc.Color(0.66, 0.84, 1.0),
      intensity: 0.54,
      range: 1.25,
      castShadows: false,
    });
    rimFillLight.setLocalPosition(-0.32, 0.18, -0.62);
    this.viewmodelLightRig.addChild(rimFillLight);

    this.weaponViewmodelEntity = new pc.Entity('WeaponViewmodel');
    this.weaponViewmodelEntity.setPosition(0.24, -0.22, -0.48);
    cameraEntity.addChild(this.weaponViewmodelEntity);

    this.muzzleFlashEntity = this.rebuildActiveViewmodel();

    this.initAmmoInventory();
    this.syncWeaponHud();
  }

  /**
   * Connects or upgrades the viewmodel arsenal to use sculpted & animated Blender `.glb` weapon models
   * (`m590_shotgun.glb`, `silver_talon_50ae.glb`, `msg90_sniper.glb`, `m4a1_carbine.glb`) once loaded.
   */
  public attachGlbRegistry(registry: GlbModelRegistry): void {
    this.glbRegistry = registry;
    this.muzzleFlashEntity = this.rebuildActiveViewmodel();
  }

  public rebuildActiveViewmodel(): pc.Entity {
    if (this.activeWeaponGlb) {
      this.activeWeaponGlb.destroy();
      this.activeWeaponGlb = null;
    }

    while (this.weaponViewmodelEntity.children.length > 0) {
      this.weaponViewmodelEntity.children[0].destroy();
    }

    for (const clonedMat of this.activeViewmodelMaterials) {
      clonedMat.destroy();
    }
    this.activeViewmodelMaterials.length = 0;

    const device = resolveGraphicsDeviceFromEntity(this.cameraEntity);
    const assetId = toWeaponAssetId(this.currentWeapon.id);

    if (assetId && this.glbRegistry && this.glbRegistry.isLoaded(assetId)) {
      try {
        const glbInst = this.glbRegistry.instantiateWeapon(assetId, {
          castShadows: false,
          receiveShadows: true,
        });
        this.activeWeaponGlb = glbInst;
        this.weaponViewmodelEntity.addChild(glbInst.rootEntity);
        this.upgradeViewmodelMaterials(glbInst.rootEntity, device);

        const flash = this.createMuzzleFlashStarEntity(device);
        glbInst.muzzleNode.addChild(flash);
        return flash;
      } catch {
        this.activeWeaponGlb = null;
      }
    }

    const legacyFlash = populatePlayerWeaponViewmodel(
      this.weaponViewmodelEntity,
      this.currentWeapon,
      this.materials
    );
    this.upgradeViewmodelMaterials(this.weaponViewmodelEntity, device);

    // Upgrade procedural fallback muzzle flash to the multi-layered AAA 3D star + corona + dynamic light rig
    const legacyPos = legacyFlash.getLocalPosition().clone();
    const flashParent = legacyFlash.parent ?? this.weaponViewmodelEntity;
    legacyFlash.destroy();

    const upgradedFlash = this.createMuzzleFlashStarEntity(device);
    upgradedFlash.setLocalPosition(legacyPos.x, legacyPos.y, legacyPos.z);
    flashParent.addChild(upgradedFlash);
    return upgradedFlash;
  }

  /**
   * Upgrades loaded viewmodel `StandardMaterial` instances for AAA first-person presentation:
   * - Anisotropic texture filtering & trilinear mipmaps across all existing GLB maps (zero texture overwrites!)
   * - Crisp normal-map `bumpiness` + subtle machined micro-grain normal fallback when absent
   * - Physically grounded gunmetal, brushed stainless/chrome, polymer, wood, brass, and optic lens gloss/metalness/fresnel
   */
  private upgradeViewmodelMaterials(
    root: pc.Entity,
    device: pc.GraphicsDevice | null
  ): void {
    const maxAniso = device ? Math.min(device.maxAnisotropy || 4, 8) : 1;
    const fxAssets = device ? getOrCreateViewmodelFxAssets(device) : null;
    const clonedBySource = new Map<pc.StandardMaterial, pc.StandardMaterial>();

    const tuneTexture = (tex: pc.Texture | null | undefined): void => {
      if (!tex) return;
      tex.anisotropy = maxAniso;
      if (tex.mipmaps) {
        tex.minFilter = pc.FILTER_LINEAR_MIPMAP_LINEAR;
        tex.magFilter = pc.FILTER_LINEAR;
      }
    };

    const applyMinSmoothness = (targetMat: pc.StandardMaterial, minSmoothness: number): void => {
      if (targetMat.glossMap) return;
      if (targetMat.glossInvert) {
        targetMat.gloss = Math.min(targetMat.gloss ?? 1.0, 1.0 - minSmoothness);
      } else {
        targetMat.gloss = Math.max(targetMat.gloss || 0, minSmoothness);
      }
    };

    const applySmoothnessRange = (
      targetMat: pc.StandardMaterial,
      minSmoothness: number,
      maxSmoothness: number,
      defaultSmoothness: number
    ): void => {
      if (targetMat.glossMap) return;
      if (targetMat.glossInvert) {
        const curRoughness = targetMat.gloss ?? (1.0 - defaultSmoothness);
        targetMat.gloss = Math.max(
          1.0 - maxSmoothness,
          Math.min(curRoughness, 1.0 - minSmoothness)
        );
      } else {
        targetMat.gloss = Math.max(
          minSmoothness,
          Math.min(targetMat.gloss || defaultSmoothness, maxSmoothness)
        );
      }
    };

    const applyClearCoat = (
      targetMat: pc.StandardMaterial,
      coatAmount: number,
      coatSmoothness: number
    ): void => {
      targetMat.clearCoat = coatAmount;
      targetMat.clearCoatGloss = targetMat.clearCoatGlossInvert
        ? 1.0 - coatSmoothness
        : coatSmoothness;
    };

    const renderComponents = root.findComponents('render') as pc.RenderComponent[];
    for (const rc of renderComponents) {
      for (const mi of rc.meshInstances) {
        const srcMat = mi.material;
        if (!(srcMat instanceof pc.StandardMaterial)) continue;
        // Skip additive FX materials
        if (
          srcMat.blendType === pc.BLEND_ADDITIVE ||
          srcMat.blendType === pc.BLEND_ADDITIVEALPHA
        ) {
          continue;
        }

        let mat = clonedBySource.get(srcMat);
        if (!mat) {
          mat = srcMat.clone();
          const hint = `${srcMat.name || ''} ${mi.node?.name || ''} ${this.currentWeapon.id}`.toLowerCase();

          // Preserve all custom GLB textures & maximize crisp anisotropic filtering
          tuneTexture(mat.diffuseMap);
          tuneTexture(mat.normalMap);
          tuneTexture(mat.metalnessMap);
          tuneTexture(mat.glossMap);
          tuneTexture(mat.aoMap);
          tuneTexture(mat.emissiveMap);
          tuneTexture(mat.specularMap);

          mat.fresnelModel = pc.FRESNEL_SCHLICK;
          mat.useMetalness = true;
          mat.enableGGXSpecular = true;
          mat.useSkybox = true;

          const isOpticLens =
            hint.includes('lens') ||
            hint.includes('glass') ||
            hint.includes('reflex') ||
            hint.includes('reticle');
          const isChromeOrSilver =
            hint.includes('silver') ||
            hint.includes('chrome') ||
            hint.includes('stainless') ||
            (this.currentWeapon.id === 'silver_talon_50ae' &&
              !hint.includes('grip') &&
              !hint.includes('polymer') &&
              !hint.includes('rubber'));
          const isBrass = hint.includes('brass') || hint.includes('cartridge');
          const isPolymerOrGrip =
            hint.includes('polymer') ||
            hint.includes('grip') ||
            hint.includes('stock') ||
            hint.includes('handguard') ||
            hint.includes('forend') ||
            hint.includes('rubber') ||
            hint.includes('pad');
          const isWood = hint.includes('wood') || hint.includes('walnut');

          if (isOpticLens) {
            if (!mat.metalnessMap) {
              mat.metalness = Math.min(mat.metalness || 0.1, 0.15);
            }
            if (mat.glossMap) {
              mat.gloss = 1.0;
            } else {
              mat.gloss = mat.glossInvert ? 0.05 : 0.95;
            }
            applyClearCoat(mat, 0.92, 0.98);
          } else if (isChromeOrSilver) {
            if (!mat.metalnessMap) {
              mat.metalness = Math.max(mat.metalness || 0, 0.92);
            }
            applyMinSmoothness(mat, 0.84);
            applyClearCoat(mat, 0.28, 0.9);
          } else if (isBrass) {
            if (!mat.metalnessMap) {
              mat.metalness = Math.max(mat.metalness || 0, 0.9);
            }
            applyMinSmoothness(mat, 0.85);
            applyClearCoat(mat, 0.25, 0.88);
          } else if (isPolymerOrGrip) {
            if (!mat.metalnessMap) {
              mat.metalness = Math.min(mat.metalness || 0.08, 0.12);
            }
            applySmoothnessRange(mat, 0.38, 0.54, 0.46);
            applyClearCoat(mat, 0.12, 0.58);
          } else if (isWood) {
            if (!mat.metalnessMap) {
              mat.metalness = 0.04;
            }
            applyMinSmoothness(mat, 0.62);
            applyClearCoat(mat, 0.35, 0.78);
          } else {
            // Parkerized / anodized ordnance steel receiver, barrel, bolt & rails
            if (!mat.metalnessMap) {
              mat.metalness = Math.max(mat.metalness || 0, 0.8);
            }
            applyMinSmoothness(mat, 0.7);
            applyClearCoat(mat, 0.22, 0.78);
          }

          if (mat.normalMap) {
            mat.bumpiness = Math.max(mat.bumpiness || 1.0, 1.22);
          } else if (!isOpticLens && fxAssets) {
            mat.normalMap = fxAssets.machinedGrainNormalTex;
            mat.bumpiness = isPolymerOrGrip ? 0.32 : 0.2;
          }

          mat.update();
          clonedBySource.set(srcMat, mat);
          this.activeViewmodelMaterials.push(mat);
        }

        mi.material = mat;
      }
    }
  }

  /**
   * Builds a multi-layered AAA 3D muzzle flash assembly:
   * - 4 crossed-star tapered petal planes (`0°`, `45°`, `90°`, `135°`)
   * - Forward incandescent plasma core spear along `-Z`
   * - Muzzle-orthogonal front corona shock disc
   * - Transient orange-amber dynamic point light (`~56ms` decay) illuminating barrel & nearby walls
   */
  private createMuzzleFlashStarEntity(device: pc.GraphicsDevice | null): pc.Entity {
    const flashRoot = new pc.Entity('MuzzleFlashStar');
    const fxAssets = device ? getOrCreateViewmodelFxAssets(device) : null;

    const caliberScale =
      this.currentWeapon.role === 'SHOTGUN'
        ? 1.32
        : this.currentWeapon.role === 'HEAVY_PISTOL'
          ? 1.24
          : this.currentWeapon.role === 'SNIPER'
            ? 1.18
            : 1.0;
    this.muzzleFlashBaseScale = caliberScale;

    if (fxAssets) {
      // 1. Multi-angle 3D crossed-star fins (axial + radial petals)
      const rollAngles = [0, 45, 90, 135];
      for (let i = 0; i < rollAngles.length; i++) {
        const fin = new pc.Entity(`FlashStarPetal_${i}`);
        const mi = new pc.MeshInstance(fxAssets.quadMesh, fxAssets.starPetalMat);
        fin.addComponent('render', {
          meshInstances: [mi],
          castShadows: false,
          receiveShadows: false,
        });
        // Rotate into axial plane along barrel (-Z) with 45-degree star roll increments
        fin.setLocalPosition(0, 0, -0.085);
        fin.setLocalEulerAngles(0, 90, rollAngles[i]);
        const s = i % 2 === 0 ? 0.25 : 0.2;
        fin.setLocalScale(0.24, s, 1);
        flashRoot.addChild(fin);
      }

      // 2. Front corona shock disc facing camera/barrel axis
      const corona = new pc.Entity('FlashFrontCorona');
      const coronaMi = new pc.MeshInstance(fxAssets.quadMesh, fxAssets.coronaHaloMat);
      corona.addComponent('render', {
        meshInstances: [coronaMi],
        castShadows: false,
        receiveShadows: false,
      });
      corona.setLocalPosition(0, 0, -0.025);
      corona.setLocalScale(0.26, 0.26, 1);
      flashRoot.addChild(corona);

      // 3. Incandescent plasma core spear jetting forward along -Z
      const coreSpear = new pc.Entity('FlashPlasmaSpear');
      coreSpear.addComponent('render', {
        type: 'cone',
        material: fxAssets.coreSpearMat,
        castShadows: false,
      });
      coreSpear.setLocalPosition(0, 0, -0.11);
      coreSpear.setLocalEulerAngles(-90, 0, 0);
      coreSpear.setLocalScale(0.048, 0.22, 0.048);
      flashRoot.addChild(coreSpear);
    } else {
      // Fallback when running without GraphicsDevice
      const fallbackMat = new pc.StandardMaterial();
      fallbackMat.name = 'glbMuzzleFlashStarMat';
      fallbackMat.diffuse = new pc.Color(1.0, 0.82, 0.32);
      fallbackMat.emissive = new pc.Color(1.0, 0.76, 0.22);
      fallbackMat.blendType = pc.BLEND_ADDITIVEALPHA;
      fallbackMat.opacity = 0.92;
      fallbackMat.depthWrite = false;
      fallbackMat.cull = pc.CULLFACE_NONE;
      fallbackMat.update();

      const fin = new pc.Entity('FlashFin_Fallback');
      fin.addComponent('render', {
        type: 'box',
        material: fallbackMat,
        castShadows: false,
      });
      fin.setLocalScale(0.16, 0.16, 0.18);
      flashRoot.addChild(fin);
    }

    // 4. Transient orange-amber muzzle flash omni light (~56ms decay)
    const flashLight = new pc.Entity('MuzzleFlashOmniLight');
    flashLight.addComponent('light', {
      type: 'omni',
      color: new pc.Color(1.0, 0.72, 0.28),
      intensity: 0,
      range: 8.5,
      castShadows: false,
    });
    flashLight.setLocalPosition(0, 0.02, -0.08);
    flashLight.enabled = false;
    flashRoot.addChild(flashLight);
    this.muzzleLightEntity = flashLight;

    flashRoot.setLocalPosition(0, 0, -0.04);
    flashRoot.setLocalScale(caliberScale, caliberScale, caliberScale);
    flashRoot.enabled = false;
    return flashRoot;
  }

  private spawnBarrelSmokeWisp(): void {
    const device = resolveGraphicsDeviceFromEntity(this.cameraEntity);
    if (!device || !this.muzzleFlashEntity) return;

    const appRoot = this.cameraEntity.root;
    if (!appRoot) return;
    if (!this.smokeRootEntity || this.smokeRootEntity.parent !== appRoot) {
      this.smokeRootEntity = new pc.Entity('ViewmodelBarrelSmokeRoot');
      appRoot.addChild(this.smokeRootEntity);
    }

    if (this.smokeWisps.length >= 20) {
      const oldest = this.smokeWisps.shift();
      if (oldest) {
        oldest.material.destroy();
        oldest.entity.destroy();
      }
    }

    const fxAssets = getOrCreateViewmodelFxAssets(device);
    const muzzleWorldPos = this.muzzleFlashEntity.getPosition();
    const camFwd = this.cameraEntity.forward;

    const wispCount = this.currentWeapon.role === 'SHOTGUN' ? 2 : 1;
    for (let i = 0; i < wispCount; i++) {
      const wispMat = fxAssets.barrelSmokeTemplateMat.clone();
      const baseOpacity = this.currentWeapon.role === 'SHOTGUN' ? 0.26 : 0.19;
      wispMat.opacity = baseOpacity;
      wispMat.update();

      const wispEnt = new pc.Entity('BarrelSmokeWisp');
      const mi = new pc.MeshInstance(fxAssets.quadMesh, wispMat);
      wispEnt.addComponent('render', {
        meshInstances: [mi],
        castShadows: false,
        receiveShadows: false,
      });

      const startPos = new pc.Vec3(
        muzzleWorldPos.x + camFwd.x * (0.08 + i * 0.06),
        muzzleWorldPos.y + camFwd.y * (0.08 + i * 0.06) + 0.015,
        muzzleWorldPos.z + camFwd.z * (0.08 + i * 0.06)
      );
      const startScale = 0.065 + i * 0.025;
      const endScale = 0.28 + Math.random() * 0.12;

      wispEnt.setPosition(startPos);
      wispEnt.setLocalScale(startScale, startScale, 1);
      this.smokeRootEntity.addChild(wispEnt);

      this.smokeWisps.push({
        entity: wispEnt,
        material: wispMat,
        position: startPos,
        velocity: new pc.Vec3(
          camFwd.x * (0.55 + Math.random() * 0.35) + (Math.random() - 0.5) * 0.18,
          0.34 + Math.random() * 0.22,
          camFwd.z * (0.55 + Math.random() * 0.35) + (Math.random() - 0.5) * 0.18
        ),
        elapsedS: 0,
        durationS: 0.58 + Math.random() * 0.24,
        startScale,
        endScale,
        baseOpacity,
        spinSpeedDeg: (Math.random() - 0.5) * 75,
      });
    }
  }

  public initAmmoInventory(): void {
    this.ammoInventory.clear();
    for (const w of WEAPONS) {
      const cap = WEAPON_CAPACITIES[w.id] || { magCap: 12, reserve: 48 };
      this.ammoInventory.set(w.id, {
        magCap: cap.magCap,
        mag: cap.magCap,
        reserve: cap.reserve,
        ammoIndex: 0,
      });
    }
    const activeInv = this.ammoInventory.get(this.currentWeapon.id);
    if (activeInv) {
      this.currentAmmo =
        this.currentWeapon.availableAmmo[activeInv.ammoIndex] || this.currentWeapon.defaultAmmo;
    }
    this.reloadTimerS = 0;
    this.syncWeaponHud();
  }

  public selectWeaponByIndex(idx: number): void {
    const wrapped = ((idx % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
    if (wrapped === this.currentWeaponIndex && this.reloadTimerS <= 0) return;

    this.currentWeaponIndex = wrapped;
    this.currentWeapon = WEAPONS[wrapped];
    const inv = this.ammoInventory.get(this.currentWeapon.id);
    const ammoIdx = inv ? inv.ammoIndex : 0;
    this.currentAmmo = this.currentWeapon.availableAmmo[ammoIdx] || this.currentWeapon.defaultAmmo;
    this.reloadTimerS = 0;
    this.muzzleFlashTimerS = 0;

    if (this.muzzleFlashTimeout !== null) {
      globalThis.clearTimeout(this.muzzleFlashTimeout);
      this.muzzleFlashTimeout = null;
    }

    this.muzzleFlashEntity = this.rebuildActiveViewmodel();

    this.onWeaponSwitched?.(this.currentWeapon);
    this.syncWeaponHud();
  }

  public cycleAmmoType(): void {
    const avail = this.currentWeapon.availableAmmo;
    if (avail.length <= 1) {
      this.hudController.pushSystemToast(
        this.currentWeapon.codeName,
        `${this.currentAmmo.caliber} ONLY`
      );
      return;
    }

    const inv = this.ammoInventory.get(this.currentWeapon.id);
    if (!inv) return;

    inv.ammoIndex = (inv.ammoIndex + 1) % avail.length;
    this.currentAmmo = avail[inv.ammoIndex];
    this.syncWeaponHud();
    this.hudController.pushSystemToast('AMMO LOADED', this.currentAmmo.name.toUpperCase());
  }

  public tryConsumeRoundForShot(): boolean {
    if (this.fireCooldownTimerS > 0 || this.reloadTimerS > 0) return false;

    const inv = this.ammoInventory.get(this.currentWeapon.id);
    if (!inv || inv.mag <= 0) {
      this.startReload(false);
      return false;
    }

    inv.mag -= 1;
    this.fireCooldownTimerS = 60 / this.currentWeapon.fireRateRpm;
    this.syncWeaponHud();

    this.activeWeaponGlb?.playFire(1.0);

    // Trigger multi-layered 3D muzzle flash + 56ms dynamic orange-amber light pulse + barrel smoke wisp
    this.shotVisualCounter++;
    const rollDeg = (this.shotVisualCounter * 67 + Math.random() * 28) % 360;
    const scaleJitter = this.muzzleFlashBaseScale * (0.9 + Math.random() * 0.24);
    this.muzzleFlashEntity.setLocalEulerAngles(0, 0, rollDeg);
    this.muzzleFlashEntity.setLocalScale(scaleJitter, scaleJitter, scaleJitter * 1.08);
    this.muzzleFlashEntity.enabled = true;

    this.muzzleFlashDurationS =
      this.currentWeapon.role === 'SHOTGUN' || this.currentWeapon.role === 'HEAVY_PISTOL'
        ? 0.062
        : 0.052;
    this.muzzleFlashTimerS = this.muzzleFlashDurationS;
    this.muzzleFlashPeakIntensity =
      this.currentWeapon.role === 'SHOTGUN' ? 4.4 : 3.6;

    if (this.muzzleLightEntity && this.muzzleLightEntity.light) {
      this.muzzleLightEntity.light.intensity = this.muzzleFlashPeakIntensity;
      this.muzzleLightEntity.enabled = true;
    }

    this.spawnBarrelSmokeWisp();

    if (this.muzzleFlashTimeout !== null) {
      globalThis.clearTimeout(this.muzzleFlashTimeout);
    }
    const timeoutMs = Math.round(this.muzzleFlashDurationS * 1000);
    this.muzzleFlashTimeout = globalThis.setTimeout(() => {
      if (this.muzzleFlashEntity && this.muzzleFlashTimerS <= 0.005) {
        this.muzzleFlashEntity.enabled = false;
      }
      if (this.muzzleLightEntity && this.muzzleFlashTimerS <= 0.005) {
        this.muzzleLightEntity.enabled = false;
      }
      this.muzzleFlashTimeout = null;
    }, timeoutMs);

    if (inv.mag === 0) {
      globalThis.setTimeout(() => this.startReload(false), 220);
    }

    return true;
  }

  public startReload(allTargetsDead: boolean, onRespawnAll?: () => void): void {
    if (this.reloadTimerS > 0) return;
    const inv = this.ammoInventory.get(this.currentWeapon.id);
    if (!inv) return;

    if (inv.mag >= inv.magCap) {
      // Convenience: if mag is already full and all hostiles are dead, [R] also spawns a fresh squad!
      if (allTargetsDead && onRespawnAll) {
        onRespawnAll();
        this.initAmmoInventory();
      }
      return;
    }

    if (inv.reserve <= 0) {
      // Refill tactical reserve from depot crate on empty so player never gets permanently stuck
      inv.reserve = inv.magCap * 3;
    }

    this.reloadTimerS = 0.65;
    this.activeWeaponGlb?.playReload(1.15);
    this.syncWeaponHud();
  }

  public syncWeaponHud(): void {
    const inv = this.ammoInventory.get(this.currentWeapon.id);
    if (!inv) return;
    this.hudController.updateWeaponHud(
      this.currentWeapon,
      this.currentAmmo,
      inv.mag,
      inv.reserve,
      this.reloadTimerS > 0
    );
  }

  public update(dt: number): void {
    if (this.fireCooldownTimerS > 0) {
      this.fireCooldownTimerS -= dt;
    }

    // Smooth quadratic decay for 52..62ms muzzle flash & dynamic orange-amber point light
    if (this.muzzleFlashTimerS > 0) {
      this.muzzleFlashTimerS = Math.max(0, this.muzzleFlashTimerS - dt);
      const rem = this.muzzleFlashTimerS / Math.max(0.01, this.muzzleFlashDurationS);
      if (this.muzzleLightEntity && this.muzzleLightEntity.light) {
        this.muzzleLightEntity.light.intensity = this.muzzleFlashPeakIntensity * rem * rem;
      }
      const shrink = this.muzzleFlashBaseScale * (0.72 + 0.36 * rem);
      this.muzzleFlashEntity.setLocalScale(shrink, shrink, shrink * (0.85 + 0.3 * rem));

      if (this.muzzleFlashTimerS <= 0) {
        this.muzzleFlashEntity.enabled = false;
        if (this.muzzleLightEntity) {
          if (this.muzzleLightEntity.light) {
            this.muzzleLightEntity.light.intensity = 0;
          }
          this.muzzleLightEntity.enabled = false;
        }
      }
    }

    // Animate drifting barrel gunsmoke / heat-haze wisps
    if (this.smokeWisps.length > 0) {
      const camPos = this.cameraEntity.getPosition();
      for (let i = this.smokeWisps.length - 1; i >= 0; i--) {
        const w = this.smokeWisps[i];
        w.elapsedS += dt;
        if (w.elapsedS >= w.durationS) {
          w.material.destroy();
          w.entity.destroy();
          this.smokeWisps.splice(i, 1);
          continue;
        }

        const t = w.elapsedS / w.durationS;
        const drag = Math.exp(-2.8 * dt);
        w.velocity.x *= drag;
        w.velocity.z *= drag;
        w.position.x += w.velocity.x * dt;
        w.position.y += w.velocity.y * dt;
        w.position.z += w.velocity.z * dt;

        w.entity.setPosition(w.position);
        w.entity.lookAt(camPos);
        w.entity.rotateLocal(0, 0, w.elapsedS * w.spinSpeedDeg);

        const curScale = w.startScale + (w.endScale - w.startScale) * (1 - (1 - t) * (1 - t));
        w.entity.setLocalScale(curScale, curScale, 1);
        const fadeIn = Math.min(1, t * 6.0);
        w.material.opacity = w.baseOpacity * fadeIn * (1 - t) * (1 - t);
        w.material.update();
      }
    }

    if (this.reloadTimerS > 0) {
      this.reloadTimerS -= dt;
      if (this.reloadTimerS <= 0) {
        this.reloadTimerS = 0;
        const inv = this.ammoInventory.get(this.currentWeapon.id);
        if (inv) {
          const needed = inv.magCap - inv.mag;
          const loaded = Math.min(needed, inv.reserve);
          inv.mag += loaded;
          inv.reserve -= loaded;
        }
        this.activeWeaponGlb?.playIdle(0.08);
        this.syncWeaponHud();
      }
    }
  }
}
