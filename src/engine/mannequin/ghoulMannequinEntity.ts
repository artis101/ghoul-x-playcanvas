import * as pc from 'playcanvas';
import { ALL_GHOUL_ZONES } from '../../core/ghoul/anatomy.ts';
import type { GhoulZoneId, TargetHealthState } from '../../contracts/ballistics.ts';
import type { GlbModelRegistry, CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import { type ArchetypeRetroMaterialSet, getArchetypeRetroMaterials } from '../retroTextures.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { GlbZoneMaterialPair, ZoneMeshBundle } from './types.ts';
import { TOPOLOGICAL_GHOUL_ZONES } from './combatantPoseConstants.ts';
import { setupCombatantGlbInstance } from './combatantGlbSetup.ts';
import { CombatantAnimController } from './combatantAnimController.ts';
import { CombatantBoneSync } from './combatantBoneSync.ts';
import { CombatantDismemberment } from './combatantDismemberment.ts';
import { CombatantVisualGoreSync } from './combatantVisualGoreSync.ts';
import { CombatantWoundDecals } from './combatantWoundDecals.ts';
import { CombatantWeaponMount } from './combatantWeaponMount.ts';
import { buildDistalParentSocketStumps, buildProximalLimbStump } from './combatantStumpBuilder.ts';

export class GhoulMannequinEntity {
  public readonly rootEntity: pc.Entity;
  public readonly healthState: TargetHealthState;
  public readonly app: pc.AppBase;
  public readonly materials: EngineMaterialPalette;
  public readonly retroMats: ArchetypeRetroMaterialSet;
  private readonly fxManager?: GoreAndBallisticsFxManager;

  public combatantGlb: CombatantGlbInstance | null = null;
  public zoneBundles: Map<GhoulZoneId, ZoneMeshBundle> = new Map();
  public isXRayActive = false;

  private readonly animController = new CombatantAnimController();
  private readonly boneSync = new CombatantBoneSync();
  private readonly dismemberment = new CombatantDismemberment();
  private readonly visualGoreSync = new CombatantVisualGoreSync();
  private readonly woundDecals = new CombatantWoundDecals();
  private readonly weaponMount = new CombatantWeaponMount();

  private readonly glbZoneMaterialPairs = new Map<GhoulZoneId, GlbZoneMaterialPair[]>();
  private readonly glbGearOriginalMaterials = new Map<pc.MeshInstance, pc.Material>();

  public constructor(
    app: pc.AppBase,
    healthState: TargetHealthState,
    materials: EngineMaterialPalette,
    fxManager?: GoreAndBallisticsFxManager,
    glbRegistry?: GlbModelRegistry
  ) {
    this.app = app;
    this.healthState = healthState;
    this.materials = materials;
    this.fxManager = fxManager;
    this.retroMats = getArchetypeRetroMaterials(app.graphicsDevice, healthState.archetype);

    this.rootEntity = new pc.Entity(`GhoulMannequin_${healthState.targetId}`);
    this.buildSkeleton();

    if (glbRegistry) {
      this.attachCombatantGlb(glbRegistry);
    }
  }

  private buildSkeleton(): void {
    for (const zone of ALL_GHOUL_ZONES) {
      const zoneNode = new pc.Entity(`Zone_${zone}`);
      this.rootEntity.addChild(zoneNode);

      const proximalStumpNode = buildProximalLimbStump(zone, zoneNode, this.materials);
      const distalChildStumps = buildDistalParentSocketStumps(zone, zoneNode, this.materials);

      this.zoneBundles.set(zone, {
        zone,
        zoneNode,
        fleshMeshInstances: [],
        intactMaterials: [],
        laceratedMaterials: [],
        woundDecalNodes: [],
        boneNodes: [],
        organNodes: [],
        proximalStumpNode,
        distalChildStumps,
      });
    }
  }

  public attachCombatantGlb(glbRegistry: GlbModelRegistry): boolean {
    this.weaponMount.attachGlbWeaponIfReady(glbRegistry, this.healthState, this.rootEntity);
    const inst = setupCombatantGlbInstance(
      glbRegistry,
      this.healthState,
      this.materials,
      this.glbZoneMaterialPairs,
      this.glbGearOriginalMaterials
    );
    if (!inst) return false;

    this.combatantGlb = inst;
    this.rootEntity.addChild(inst.rootEntity);
    this.syncFromHealthState(0, 0);
    return true;
  }

  public setXRayMode(enabled: boolean): void {
    this.isXRayActive = enabled;
    this.visualGoreSync.refreshIfDirty(
      this.healthState, this.combatantGlb, this.isXRayActive, this.woundDecals.syncedCount,
      this.glbZoneMaterialPairs, this.glbGearOriginalMaterials, this.zoneBundles, this.materials
    );
  }

  public syncFromHealthState(_dt: number, elapsedTime: number): void {
    const headgearAttached = this.dismemberment.syncHeadgear(this.healthState, this.fxManager);
    const glb = this.combatantGlb;
    const isFullRagdoll = this.healthState.isRagdollActive || !this.healthState.alive;

    if (glb) {
      glb.rootEntity.enabled = true;
      this.dismemberment.syncGlbSeverances(glb, this.healthState, this.isXRayActive);
      this.dismemberment.syncGearVisibility(glb, this.healthState, this.isXRayActive, headgearAttached);

      if (isFullRagdoll) {
        this.animController.freezeAnimation(glb);
        glb.rootEntity.setPosition(0, 0, 0);
        glb.rootEntity.setEulerAngles(0, 0, 0);
        for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
          this.boneSync.applyRagdollBoneToGlbJoint(glb, zone, this.healthState);
        }
        glb.rootEntity.syncHierarchy();
      } else {
        this.animController.syncAnimation(glb, this.healthState);
        glb.rootEntity.setPosition(
          this.healthState.worldPosition.x,
          this.healthState.worldPosition.y,
          this.healthState.worldPosition.z
        );
        glb.rootEntity.setEulerAngles(0, (this.healthState.yawRad * 180) / Math.PI, 0);
        glb.rootEntity.syncHierarchy();

        if (this.healthState.severedZones.size > 0) {
          for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
            if (this.healthState.ragdollBones[zone].componentId !== 'BODY') {
              this.boneSync.applyRagdollBoneToGlbJoint(glb, zone, this.healthState);
            }
          }
          glb.rootEntity.syncHierarchy();
        }
      }
    } else {
      for (const [zone, bundle] of this.zoneBundles) {
        const boneState = this.healthState.ragdollBones[zone];
        bundle.zoneNode.setLocalPosition(boneState.position.x, boneState.position.y, boneState.position.z);
        this.boneSync.setEntityBasisRotation(bundle.zoneNode, boneState.basisRight, boneState.basisUp, boneState.basisForward);
        if (bundle.boneNodes[0]) {
          bundle.boneNodes[0].setPosition(boneState.position.x, boneState.position.y, boneState.position.z);
        }
      }
    }

    this.weaponMount.syncWeaponPosition(this.healthState, glb, this.fxManager);
    this.dismemberment.syncStumps(this.zoneBundles, this.healthState);
    this.woundDecals.syncSurfaceWounds(this.healthState, this.zoneBundles, this.materials);
    this.visualGoreSync.refreshIfDirty(
      this.healthState,
      glb,
      this.isXRayActive,
      this.woundDecals.syncedCount,
      this.glbZoneMaterialPairs,
      this.glbGearOriginalMaterials,
      this.zoneBundles,
      this.materials
    );

    this.visualGoreSync.pulseXRayOrgans(glb, this.healthState, this.isXRayActive, elapsedTime);
  }

  public destroy(): void {
    this.weaponMount.destroy();
    if (this.combatantGlb) {
      this.combatantGlb.destroy();
      this.combatantGlb = null;
    }
    this.rootEntity.destroy();
  }
}
