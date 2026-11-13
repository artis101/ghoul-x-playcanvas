import * as pc from 'playcanvas';
import { EngineMaterialPalette, upgradePaletteWithProceduralPbrMaps } from '../materials.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { buildArenaGeometry } from './arenaGeometry.ts';
import { getOrCreateProceduralIblEnvironment } from './arenaIblLighting.ts';

export * from './arenaLayout.ts';
export * from './arenaIblLighting.ts';

// Light balance for the hall, tuned against the filmic tone curve of the player camera's HDR frame.
// The key leans 36 degrees off vertical and across the hall, so shadows fall sideways in view.
const KEY_LIGHT_INTENSITY = 1.6;
const KEY_LIGHT_PITCH_DEG = 36;
const KEY_LIGHT_YAW_DEG = -118;
const AMBIENT_FILL_INTENSITY = 0.55;
const SCENE_EXPOSURE = 1.2;

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

    // Raking key standing in for the ceiling fixtures. It has to out-shine the lamps and the
    // ambient fill, or the shadows it casts wash out and bodies and props float over the floor.
    const overheadLight = new pc.Entity('OverheadKeyLight');
    overheadLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1.0, 0.93, 0.74),
      intensity: KEY_LIGHT_INTENSITY,
      castShadows: true,
      shadowType: pc.SHADOW_PCF3_16F,
      shadowResolution: 1536,
      // One cascade over the fighting distance. A second one redrew every caster (some 300 once
      // gibs and dropped weapons litter the floor) for shadows too far away to read.
      shadowDistance: 32,
      // A larger depth bias swallows the short contact shadows under feet and barrels.
      shadowBias: 0.02,
      normalOffsetBias: 0.03,
      shadowIntensity: 0.92,
      numCascades: 1,
    });
    overheadLight.setEulerAngles(KEY_LIGHT_PITCH_DEG, KEY_LIGHT_YAW_DEG, 0);
    this.arenaRootEntity.addChild(overheadLight);
    overheadLight.syncHierarchy();

    const scene = this.app.scene;
    scene.exposure = SCENE_EXPOSURE;
    scene.ambientLight = new pc.Color(0.2, 0.18, 0.12);
    scene.fog.type = pc.FOG_EXP2;
    scene.fog.color = new pc.Color(0.1, 0.09, 0.06);
    scene.fog.density = 0.011;
    scene.lighting.maxLightsPerCell = Math.max(scene.lighting.maxLightsPerCell, 12);

    // Indoors there is no sky to draw; the environment atlas only tints ambient light and reflections.
    const ibl = getOrCreateProceduralIblEnvironment(this.app.graphicsDevice, overheadLight.up);
    if (ibl) {
      scene.envAtlas = ibl.envAtlas;
      scene.skyboxIntensity = AMBIENT_FILL_INTENSITY;
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
