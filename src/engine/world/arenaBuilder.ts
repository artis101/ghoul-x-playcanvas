import * as pc from 'playcanvas';
import { EngineMaterialPalette, upgradePaletteWithProceduralPbrMaps } from '../materials.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { buildArenaGeometry } from './arenaGeometry.ts';
import { getOrCreateProceduralIblEnvironment } from './arenaIblLighting.ts';

export * from './arenaLayout.ts';
export * from './arenaIblLighting.ts';

export type ArenaBuildState =
  | { readonly kind: 'UNBUILT' }
  | {
      readonly kind: 'BUILT';
      readonly colliderHandles: number[];
      readonly detailMaterials: pc.StandardMaterial[];
    }
  | { readonly kind: 'DESTROYED' };

export class ArenaBuilder {
  public readonly app: pc.AppBase;
  public readonly materials: EngineMaterialPalette;
  public readonly rapierWorld: RapierPhysicsWorld | null;
  public readonly arenaRootEntity: pc.Entity;
  public buildState: ArenaBuildState = { kind: 'UNBUILT' };

  private preRenderHookBound = false;

  private readonly onPreRenderCamera = (camera: pc.CameraComponent): void => {
    camera.toneMapping = pc.TONEMAP_ACES;
    camera.gammaCorrection = pc.GAMMA_SRGB;
  };

  public constructor(
    app: pc.AppBase,
    materials: EngineMaterialPalette,
    rapierWorld: RapierPhysicsWorld | null = null
  ) {
    this.app = app;
    this.materials = materials;
    this.rapierWorld = rapierWorld;
    this.arenaRootEntity = new pc.Entity('TacticalFiringRangeRoot');
    this.app.root.addChild(this.arenaRootEntity);
  }

  public get registeredColliderCount(): number {
    return this.buildState.kind === 'BUILT' ? this.buildState.colliderHandles.length : 0;
  }

  public build(): void {
    if (this.buildState.kind === 'DESTROYED') {
      throw new Error('Cannot build ArenaBuilder after it has been destroyed.');
    }
    this.teardownBuiltResources();

    const colliderHandles: number[] = [];
    const detailMaterials: pc.StandardMaterial[] = [];

    upgradePaletteWithProceduralPbrMaps(this.app.graphicsDevice, this.materials);

    const sunLight = new pc.Entity('SunLight');
    sunLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1.0, 0.95, 0.86),
      intensity: 1.85,
      castShadows: true,
      shadowType: pc.SHADOW_PCF3_16F,
      shadowResolution: 1536,
      shadowDistance: 55,
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

    buildArenaGeometry(
      this.arenaRootEntity,
      this.materials,
      this.rapierWorld,
      colliderHandles,
      detailMaterials
    );

    this.buildState = {
      kind: 'BUILT',
      colliderHandles,
      detailMaterials,
    };
  }

  public destroy(): void {
    if (this.buildState.kind === 'DESTROYED') return;
    if (this.preRenderHookBound) {
      this.app.scene.off('prerender', this.onPreRenderCamera);
      this.preRenderHookBound = false;
    }
    this.teardownBuiltResources();
    this.arenaRootEntity.destroy();
    this.buildState = { kind: 'DESTROYED' };
  }

  private teardownBuiltResources(): void {
    if (this.buildState.kind === 'BUILT') {
      if (this.rapierWorld) {
        for (const handle of this.buildState.colliderHandles) {
          this.rapierWorld.removeCollider(handle);
        }
      }
      for (const m of this.buildState.detailMaterials) {
        m.destroy();
      }
    }
    while (this.arenaRootEntity.children.length > 0) {
      const child = this.arenaRootEntity.children[0];
      child.destroy();
    }
  }
}
