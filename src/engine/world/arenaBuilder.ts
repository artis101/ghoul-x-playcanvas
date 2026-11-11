import * as pc from 'playcanvas';
import { Vec3Like } from '../../contracts/ballistics.ts';
import type { ColliderSurfaceTag } from '../../contracts/destruction.ts';
import {
  EngineMaterialPalette,
  upgradePaletteWithProceduralPbrMaps,
} from '../materials.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

export interface DestructionStationSpec {
  readonly id: string;
  readonly label: string;
  readonly center: Vec3Like;
  readonly widthM: number;
  readonly heightM: number;
  readonly thicknessM: number;
  readonly halfExtents: Vec3Like;
  readonly yawDeg: number;
}

export interface DestructionZoneLayout {
  readonly woodShootHouseWall: DestructionStationSpec;
  readonly glassMarchingWindow: DestructionStationSpec;
  readonly glassVoronoiWindow: DestructionStationSpec;
  readonly instancedBrickWall: DestructionStationSpec;
  readonly voronoiConcreteWall: DestructionStationSpec;
}

/**
 * Structured range station coordinates for destructible tactical cover stations.
 * Positioned along clear firing lanes and aligned with downrange GHOUL combatants.
 */
export const DESTRUCTION_ZONE_LAYOUT: DestructionZoneLayout = {
  woodShootHouseWall: {
    id: 'wood_shoot_house_wall',
    label: 'Wood & Drywall Shoot-House Partition',
    center: { x: -2.3, y: 1.2, z: -7.2 },
    widthM: 3.0,
    heightM: 2.4,
    thicknessM: 0.12,
    halfExtents: { x: 1.5, y: 1.2, z: 0.06 },
    yawDeg: 0,
  },
  glassMarchingWindow: {
    id: 'glass_marching_window',
    label: 'Marching-Squares 256 Tactical Window',
    center: { x: -5.5, y: 1.45, z: -6.5 },
    widthM: 2.2,
    heightM: 1.7,
    thicknessM: 0.03,
    halfExtents: { x: 1.1, y: 0.85, z: 0.015 },
    yawDeg: 0,
  },
  glassVoronoiWindow: {
    id: 'glass_voronoi_window',
    label: 'Runtime Voronoi Tempered Glass Window',
    center: { x: 5.5, y: 1.45, z: -6.5 },
    widthM: 2.2,
    heightM: 1.7,
    thicknessM: 0.03,
    halfExtents: { x: 1.1, y: 0.85, z: 0.015 },
    yawDeg: 0,
  },
  instancedBrickWall: {
    id: 'instanced_brick_wall',
    label: 'Instanced Masonry Brick Cover Wall',
    center: { x: -3.8, y: 1.05, z: -12.5 },
    widthM: 3.0,
    heightM: 2.1,
    thicknessM: 0.2,
    halfExtents: { x: 1.5, y: 1.05, z: 0.1 },
    yawDeg: 0,
  },
  voronoiConcreteWall: {
    id: 'voronoi_concrete_wall',
    label: 'MultiDraw Voronoi Concrete Barrier Wall',
    center: { x: 2.3, y: 1.15, z: -13.5 },
    widthM: 3.2,
    heightM: 2.3,
    thicknessM: 0.28,
    halfExtents: { x: 1.6, y: 1.15, z: 0.14 },
    yawDeg: 0,
  },
};

export const RANGE_MARKER_DISTANCES_M: readonly number[] = [5, 10, 15, 25, 42];
export const PERIMETER_BARRIER_Z_OFFSETS_M: readonly number[] = [-8, -20, -34, -48];

interface CachedIblEnvironment {
  envAtlas: pc.Texture;
  skyboxCubemap: pc.Texture;
}

const cachedIblByDevice = new WeakMap<pc.GraphicsDevice, CachedIblEnvironment>();

/**
 * Encodes linear HDR RGB values (up to 64.0) into PlayCanvas RGBM RGBA8 texels.
 * Inverse of PlayCanvas `decodeRGBM`: `linear = ((8.0 * a) * rgb)^2`.
 */
function writeRgbmPixel(
  pixels: Uint8Array,
  idx: number,
  rLin: number,
  gLin: number,
  bLin: number
): void {
  const sr = Math.sqrt(Math.max(0, rLin)) * 0.125;
  const sg = Math.sqrt(Math.max(0, gLin)) * 0.125;
  const sb = Math.sqrt(Math.max(0, bLin)) * 0.125;
  const maxC = Math.min(1.0, Math.max(sr, sg, sb, 1.0 / 255.0));
  const aByte = Math.max(1, Math.min(255, Math.ceil(maxC * 255.0)));
  const aNorm = aByte / 255.0;

  pixels[idx] = Math.min(255, Math.round(Math.min(1.0, sr / aNorm) * 255.0));
  pixels[idx + 1] = Math.min(255, Math.round(Math.min(1.0, sg / aNorm) * 255.0));
  pixels[idx + 2] = Math.min(255, Math.round(Math.min(1.0, sb / aNorm) * 255.0));
  pixels[idx + 3] = aByte;
}

/**
 * Generates a procedural HDR tactical firing-range sky & overhead skylight dome,
 * prefiltered into a PlayCanvas 2.4 `envAtlas` and crisp `skyboxCubemap` so metallic
 * gunmetal, brushed chrome, optics, and ballistic visors reflect rich environment highlights.
 */
function getOrCreateProceduralIblEnvironment(
  device: pc.GraphicsDevice,
  sunDir: pc.Vec3
): CachedIblEnvironment | null {
  if (device instanceof pc.NullGraphicsDevice) {
    return null;
  }

  const cached = cachedIblByDevice.get(device);
  if (cached) {
    return cached;
  }

  try {
    const width = 512;
    const height = 256;
    const equirect = new pc.Texture(device, {
      name: 'procedural_tactical_hdr_equirect',
      width,
      height,
      format: pc.PIXELFORMAT_RGBA8,
      type: pc.TEXTURETYPE_RGBM,
      projection: pc.TEXTUREPROJECTION_EQUIRECT,
      mipmaps: false,
      minFilter: pc.FILTER_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_REPEAT,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });

    const sx = sunDir.x;
    const sy = sunDir.y;
    const sz = sunDir.z;

    const pixels = equirect.lock() as Uint8Array;
    for (let y = 0; y < height; y++) {
      // PlayCanvas sampleEquirect maps row 0 -> +Y zenith, row height-1 -> -Y nadir
      const elev = (0.5 - (y + 0.5) / height) * Math.PI;
      const sinEl = Math.sin(elev);
      const cosEl = Math.cos(elev);

      for (let x = 0; x < width; x++) {
        const phi = ((x + 0.5) / width - 0.5) * Math.PI * 2.0;
        const dx = cosEl * Math.sin(phi);
        const dy = sinEl;
        const dz = cosEl * Math.cos(phi);

        let rLin: number;
        let gLin: number;
        let bLin: number;

        if (dy >= 0) {
          // Crisp tactical overcast-break sky gradient: deep cobalt zenith to warm atmospheric horizon
          const zenithT = Math.pow(dy, 0.55);
          const horizonGlow = Math.pow(1.0 - dy, 4.0);
          rLin = 0.16 * (1.0 - zenithT) + 0.065 * zenithT + horizonGlow * 0.42;
          gLin = 0.24 * (1.0 - zenithT) + 0.135 * zenithT + horizonGlow * 0.36;
          bLin = 0.36 * (1.0 - zenithT) + 0.285 * zenithT + horizonGlow * 0.28;

          // Subtle high-altitude cirrus bands + overhead range skylight strips for crisp metal reflections
          const cloudWave =
            Math.sin(dx * 5.0 + dz * 3.2) * Math.cos(dz * 4.4 - dx * 2.1) * 0.5 + 0.5;
          const cloudFactor = cloudWave * (1.0 - zenithT * 0.55) * 0.16;
          rLin += cloudFactor * 0.95;
          gLin += cloudFactor * 0.98;
          bLin += cloudFactor * 1.05;

          // Overhead industrial range skylight strips (gives gun slides & scopes clean linear specular catchlights)
          if (dy > 0.48) {
            const stripBand = Math.abs(Math.sin((dz / Math.max(0.22, dy)) * 3.6));
            const lateralMask = Math.max(0, 1.0 - Math.abs(dx / Math.max(0.22, dy)) * 0.85);
            if (stripBand > 0.92 && lateralMask > 0.25) {
              const stripBoost = ((stripBand - 0.92) / 0.08) * lateralMask * 2.4;
              rLin += stripBoost * 1.05;
              gLin += stripBoost * 1.08;
              bLin += stripBoost * 1.15;
            }
          }

          // Directional solar disc & Mie scattering corona aligned with SunLight
          const sunDot = Math.max(0, dx * sx + dy * sy + dz * sz);
          const mieWide = Math.pow(sunDot, 8.0) * 0.65;
          const mieTight = Math.pow(sunDot, 96.0) * 3.8;
          const sunDisc = sunDot > 0.9985 ? 24.0 : 0.0;

          rLin += (mieWide + mieTight + sunDisc) * 1.08;
          gLin += (mieWide * 0.92 + mieTight * 0.94 + sunDisc * 0.96);
          bLin += (mieWide * 0.74 + mieTight * 0.80 + sunDisc * 0.84);
        } else {
          // Grounded dark asphalt/concrete range floor bounce hemisphere (prevents glowing underside reflections)
          const groundDepth = Math.min(1.0, -dy * 2.5);
          const horizonBounce = Math.pow(1.0 + dy, 5.0);
          rLin = 0.032 * (1.0 - groundDepth * 0.45) + horizonBounce * 0.18;
          gLin = 0.038 * (1.0 - groundDepth * 0.45) + horizonBounce * 0.19;
          bLin = 0.048 * (1.0 - groundDepth * 0.45) + horizonBounce * 0.22;
        }

        writeRgbmPixel(pixels, (y * width + x) * 4, rLin, gLin, bLin);
      }
    }
    equirect.unlock();

    const lightingSource = pc.EnvLighting.generateLightingSource(equirect, { size: 256 });
    const envAtlas = pc.EnvLighting.generateAtlas(lightingSource);
    const skyboxCubemap = pc.EnvLighting.generateSkyboxCubemap(lightingSource, 256);

    lightingSource.destroy();
    equirect.destroy();

    const bundle: CachedIblEnvironment = { envAtlas, skyboxCubemap };
    cachedIblByDevice.set(device, bundle);
    return bundle;
  } catch {
    return null;
  }
}

export class ArenaBuilder {
  public readonly app: pc.AppBase;
  public readonly materials: EngineMaterialPalette;
  public readonly rapierWorld: RapierPhysicsWorld | null;
  public readonly arenaRootEntity: pc.Entity;

  private readonly colliderHandles: number[] = [];
  private readonly customDetailMaterials: pc.StandardMaterial[] = [];
  private preRenderHookBound = false;

  private readonly onPreRenderCamera = (camera: pc.CameraComponent): void => {
    if (camera.toneMapping === pc.TONEMAP_LINEAR) {
      camera.toneMapping = pc.TONEMAP_ACES;
    }
    camera.gammaCorrection = pc.GAMMA_SRGB;
  };

  constructor(
    app: pc.AppBase,
    materials: EngineMaterialPalette,
    rapierWorld: RapierPhysicsWorld | null = null,
  ) {
    this.app = app;
    this.materials = materials;
    this.rapierWorld = rapierWorld;
    this.arenaRootEntity = new pc.Entity('ArenaRoot');
    this.app.root.addChild(this.arenaRootEntity);
  }

  public get registeredColliderCount(): number {
    return this.colliderHandles.length;
  }

  public build(): void {
    this.clearPhysicsColliders();
    this.clearCustomDetailMaterials();

    // 1. Ensure arena floor, jersey barriers, sandbags & gore shaders have procedural normal + gloss maps
    upgradePaletteWithProceduralPbrMaps(this.app.graphicsDevice, this.materials);

    // 2. Cinematic 3-Point Tactical Lighting (Key Sun with soft PCF5 shadows + Sky Fill + Crisp Rim)
    const sunLight = new pc.Entity('SunLight');
    sunLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1.0, 0.95, 0.86),
      intensity: 1.85,
      castShadows: true,
      shadowType: pc.SHADOW_PCF5_32F,
      shadowResolution: 2048,
      shadowDistance: 80,
      shadowBias: 0.1,
      normalOffsetBias: 0.05,
      shadowIntensity: 0.88,
      numCascades: 2,
      cascadeBlend: 0.15,
    });
    sunLight.setEulerAngles(48, 32, 0);
    this.arenaRootEntity.addChild(sunLight);
    sunLight.syncHierarchy();

    const fillLight = new pc.Entity('FillLight');
    fillLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(0.34, 0.48, 0.68),
      intensity: 0.62,
      castShadows: false,
    });
    fillLight.setEulerAngles(-42, -142, 0);
    this.arenaRootEntity.addChild(fillLight);

    const rimLight = new pc.Entity('RimLight');
    rimLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(0.74, 0.86, 1.0),
      intensity: 0.68,
      castShadows: false,
    });
    rimLight.setEulerAngles(36, 172, 0);
    this.arenaRootEntity.addChild(rimLight);

    // 3. Scene IBL Environment Atlas, Skybox, Exposure, Atmosphere & ACES Camera Tonemapping
    const scene = this.app.scene;
    scene.exposure = 1.15;
    scene.ambientLight = new pc.Color(0.14, 0.17, 0.22);
    scene.fog.type = pc.FOG_EXP2;
    scene.fog.color = new pc.Color(0.07, 0.09, 0.13);
    scene.fog.density = 0.0055;

    const ibl = getOrCreateProceduralIblEnvironment(this.app.graphicsDevice, sunLight.up);
    if (ibl) {
      scene.envAtlas = ibl.envAtlas;
      scene.skybox = ibl.skyboxCubemap;
      scene.skyboxMip = 0;
      scene.skyboxIntensity = 1.05;
    }

    const existingCameras = this.app.root.findComponents('camera') as pc.CameraComponent[];
    for (const cam of existingCameras) {
      cam.toneMapping = pc.TONEMAP_ACES;
      cam.gammaCorrection = pc.GAMMA_SRGB;
    }
    if (!this.preRenderHookBound) {
      scene.on('prerender', this.onPreRenderCamera);
      this.preRenderHookBound = true;
    }

    // 4. Firing Range Slab Floor & Distance Markers (preserving exact 18 Rapier static colliders)
    const floor = new pc.Entity('ArenaFloor');
    floor.addComponent('render', {
      type: 'box',
      material: this.materials.floorGridMat,
      receiveShadows: true,
    });
    floor.setLocalScale(40, 0.2, 160);
    floor.setPosition(0, -0.1, -50);
    this.arenaRootEntity.addChild(floor);

    for (const d of RANGE_MARKER_DISTANCES_M) {
      const lineMarker = new pc.Entity(`DistanceMarker_${d}m`);
      lineMarker.addComponent('render', {
        type: 'box',
        material: this.materials.rangeDistanceMarkerMat,
        receiveShadows: true,
      });
      lineMarker.setLocalScale(17, 0.02, 0.08);
      lineMarker.setPosition(0, 0.01, -d);
      this.arenaRootEntity.addChild(lineMarker);

      for (const side of [-8.5, 8.5]) {
        const objectId = `MarkerPost_${d}m_${side}`;
        const post = new pc.Entity(objectId);
        post.addComponent('render', {
          type: 'box',
          material: this.materials.barrierConcreteMat,
          castShadows: true,
          receiveShadows: true,
        });
        post.setLocalScale(0.32, 1.1, 0.32);
        post.setPosition(side, 0.55, -d);
        this.arenaRootEntity.addChild(post);

        if (this.rapierWorld) {
          const postTag: ColliderSurfaceTag = {
            material: 'CONCRETE_INTACT',
            objectId,
            thicknessM: 0.32,
            penetrationResistanceJ: 12000,
          };
          this.colliderHandles.push(
            this.rapierWorld.createStaticBox(
              { x: side, y: 0.55, z: -d },
              { x: 0.16, y: 0.55, z: 0.16 },
              undefined,
              postTag,
            ),
          );
        }
      }
    }

    for (const z of PERIMETER_BARRIER_Z_OFFSETS_M) {
      for (const side of [-9.5, 9.5]) {
        const objectId = `Barrier_${side}_${z}`;
        const barrier = new pc.Entity(objectId);
        barrier.addComponent('render', {
          type: 'box',
          material: this.materials.barrierConcreteMat,
          castShadows: true,
          receiveShadows: true,
        });
        barrier.setLocalScale(1.1, 1.35, 7.5);
        barrier.setPosition(side, 0.675, z);
        this.arenaRootEntity.addChild(barrier);

        // Visual precast New Jersey barrier wide base plinth & top cap
        const footing = new pc.Entity(`${objectId}_Footing`);
        footing.addComponent('render', {
          type: 'box',
          material: this.materials.barrierConcreteMat,
          castShadows: true,
          receiveShadows: true,
        });
        footing.setLocalScale(1.44, 0.24, 7.56);
        footing.setPosition(side, 0.12, z);
        this.arenaRootEntity.addChild(footing);

        if (this.rapierWorld) {
          const barrierTag: ColliderSurfaceTag = {
            material: 'CONCRETE_INTACT',
            objectId,
            thicknessM: 1.1,
            penetrationResistanceJ: 16000,
          };
          this.colliderHandles.push(
            this.rapierWorld.createStaticBox(
              { x: side, y: 0.675, z },
              { x: 0.55, y: 0.675, z: 3.75 },
              undefined,
              barrierTag,
            ),
          );
        }
      }
    }

    // 5. Visual-only Architectural Firing-Range Trusses, Ballistic Baffles & Bullet-Trap Backstop
    this.buildArchitecturalRangeDetails();
  }

  private buildArchitecturalRangeDetails(): void {
    const luminaireMat = new pc.StandardMaterial();
    luminaireMat.name = 'rangeLuminaireStripMat';
    luminaireMat.diffuse = new pc.Color(0.95, 0.97, 1.0);
    luminaireMat.emissive = new pc.Color(0.92, 0.96, 1.0);
    luminaireMat.emissiveIntensity = 2.2;
    luminaireMat.update();
    this.customDetailMaterials.push(luminaireMat);

    const archGroup = new pc.Entity('RangeArchitecture');
    this.arenaRootEntity.addChild(archGroup);

    const addBoxDetail = (
      name: string,
      mat: pc.StandardMaterial,
      sx: number,
      sy: number,
      sz: number,
      px: number,
      py: number,
      pz: number,
      rx = 0,
      castShadows = false
    ): void => {
      const ent = new pc.Entity(name);
      ent.addComponent('render', {
        type: 'box',
        material: mat,
        castShadows,
        receiveShadows: true,
      });
      ent.setLocalScale(sx, sy, sz);
      ent.setPosition(px, py, pz);
      if (rx !== 0) {
        ent.setEulerAngles(rx, 0, 0);
      }
      archGroup.addChild(ent);
    };

    // Overhead structural steel trusses, angled ballistic ceiling baffles & LED luminaire strips
    const trussZOffsets = [-2, -14, -26, -38, -50];
    for (const z of trussZOffsets) {
      for (const side of [-11.4, 11.4]) {
        addBoxDetail(`RangeColumn_${side}_${z}`, this.materials.targetStandMat, 0.36, 6.8, 0.36, side, 3.4, z, 0, true);
      }
      addBoxDetail(`OverheadTrussBeam_${z}`, this.materials.targetStandMat, 23.2, 0.32, 0.36, 0, 6.65, z, 0, true);
      addBoxDetail(`BallisticBaffle_${z}`, this.materials.tacticalArmorVest, 21.8, 0.85, 0.14, 0, 6.12, z - 0.35, 22, false);
      addBoxDetail(`LuminaireStripL_${z}`, luminaireMat, 5.2, 0.06, 0.14, -4.6, 6.42, z + 0.12);
      addBoxDetail(`LuminaireStripR_${z}`, luminaireMat, 5.2, 0.06, 0.14, 4.6, 6.42, z + 0.12);
    }

    // Longitudinal overhead catwalk/conduit rails tying trusses together
    for (const railX of [-7.8, 0, 7.8]) {
      addBoxDetail(`LongitudinalRail_${railX}`, this.materials.targetStandMat, 0.18, 0.18, 56.0, railX, 6.82, -26);
    }

    // Downrange armored steel bullet-trap backstop berm & side containment walls
    addBoxDetail('BulletTrapBermBase', this.materials.barrierConcreteMat, 24.0, 2.4, 2.6, 0, 1.2, -62.0, 0, true);
    addBoxDetail('BulletTrapSteelPlate', this.materials.tacticalArmorVest, 22.8, 3.4, 0.35, 0, 2.25, -60.6, -28, true);
    for (const wallSide of [-11.8, 11.8]) {
      addBoxDetail(`PerimeterContainmentWall_${wallSide}`, this.materials.barrierConcreteMat, 0.45, 2.2, 68.0, wallSide, 1.1, -30.0, 0, true);
    }
  }

  public destroy(): void {
    if (this.preRenderHookBound) {
      this.app.scene.off('prerender', this.onPreRenderCamera);
      this.preRenderHookBound = false;
    }
    this.clearPhysicsColliders();
    this.arenaRootEntity.destroy();
    this.clearCustomDetailMaterials();
  }

  private clearCustomDetailMaterials(): void {
    for (const m of this.customDetailMaterials) {
      m.destroy();
    }
    this.customDetailMaterials.length = 0;
  }

  private clearPhysicsColliders(): void {
    if (this.rapierWorld) {
      for (const handle of this.colliderHandles) {
        this.rapierWorld.removeCollider(handle);
      }
    }
    this.colliderHandles.length = 0;
  }
}
