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
    camera.toneMapping = pc.TONEMAP_LINEAR;
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

    // Soft overhead key standing in for the ceiling fixtures: it gives bodies and props
    // grounded shadows, while the fixtures' own lamps pool warm light along the hall.
    const overheadLight = new pc.Entity('OverheadKeyLight');
    overheadLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1.0, 0.93, 0.74),
      intensity: 0.5,
      castShadows: true,
      shadowType: pc.SHADOW_PCF3_16F,
      shadowResolution: 1536,
      shadowDistance: 45,
      shadowBias: 0.1,
      normalOffsetBias: 0.05,
      shadowIntensity: 0.6,
      numCascades: 2,
      cascadeBlend: 0.15,
    });
    overheadLight.setEulerAngles(14, 28, 0);
    this.arenaRootEntity.addChild(overheadLight);
    overheadLight.syncHierarchy();

    const scene = this.app.scene;
    scene.exposure = 1.0;
    scene.ambientLight = new pc.Color(0.2, 0.18, 0.12);
    scene.fog.type = pc.FOG_EXP2;
    scene.fog.color = new pc.Color(0.1, 0.09, 0.06);
    scene.fog.density = 0.011;
    scene.lighting.maxLightsPerCell = Math.max(scene.lighting.maxLightsPerCell, 12);

    // Indoors there is no sky to draw; the environment atlas only tints ambient light and reflections.
    const ibl = getOrCreateProceduralIblEnvironment(this.app.graphicsDevice, overheadLight.up);
    if (ibl) {
      scene.envAtlas = ibl.envAtlas;
      scene.skyboxIntensity = 1.0;
    }

    const existingCameras = this.app.root.findComponents('camera') as pc.CameraComponent[];
    for (const cam of existingCameras) {
      cam.toneMapping = pc.TONEMAP_LINEAR;
      cam.gammaCorrection = pc.GAMMA_SRGB;
    }
    if (!this.preRenderHookBound) {
      scene.on('prerender', this.onPreRenderCamera);
      this.preRenderHookBound = true;
    }

    buildArenaGeometry(
      this.arenaRootEntity,
      this.app.graphicsDevice,
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
