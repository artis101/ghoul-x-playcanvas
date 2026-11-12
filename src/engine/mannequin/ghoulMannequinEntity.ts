import * as pc from 'playcanvas';
import { ALL_GHOUL_ZONES } from '../../core/ghoul/anatomy.ts';
import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { GlbModelRegistry, CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import { type ArchetypeRetroMaterialSet, getArchetypeRetroMaterials } from '../retroTextures.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { GlbZoneMaterialPair, ZoneMeshBundle } from './types.ts';
import { TOPOLOGICAL_GHOUL_ZONES } from './combatantPoseConstants.ts';
import { setupCombatantGlbInstance } from './combatantGlbSetup.ts';
import { CombatantAnimController, type CombatantAimPose } from './combatantAnimController.ts';
import { CombatantLocomotion } from './combatantLocomotion.ts';
import { CombatantBoneSync } from './combatantBoneSync.ts';
import { CombatantDismemberment } from './combatantDismemberment.ts';
import { CombatantVisualGoreSync } from './combatantVisualGoreSync.ts';
import { CombatantWoundDecals } from './combatantWoundDecals.ts';
import { CombatantWeaponMount } from './combatantWeaponMount.ts';
import { CombatantDeadLimbOverlay } from './combatantDeadLimbOverlay.ts';
import { buildDistalParentSocketStumps, buildProximalLimbStump } from './combatantStumpBuilder.ts';
import {
  resolveMannequinDriveState,
  type MannequinDriveMode,
  type MannequinDriveState,
} from './propAttachmentState.ts';

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
  public driveState: MannequinDriveState;

  private readonly animController = new CombatantAnimController();
  private readonly locomotion = new CombatantLocomotion();
  private readonly boneSync = new CombatantBoneSync();
  private readonly dismemberment = new CombatantDismemberment();
  private readonly visualGoreSync = new CombatantVisualGoreSync();
  private readonly woundDecals = new CombatantWoundDecals();
  private readonly weaponMount = new CombatantWeaponMount();
  private readonly deadLimbOverlay = new CombatantDeadLimbOverlay();

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
    this.driveState = resolveMannequinDriveState(healthState);

    this.rootEntity = new pc.Entity(`GhoulMannequin_${healthState.targetId}`);
    this.buildSkeleton();

    if (glbRegistry) {
      this.attachCombatantGlb(glbRegistry);
    }
  }

  public get driveMode(): MannequinDriveMode {
    return this.driveState.mode;
  }

  public reset(): void {
    this.dismemberment.reset();
    this.weaponMount.reset();
    this.animController.reset();
    this.driveState = resolveMannequinDriveState(this.healthState);
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

  public syncFromHealthState(dt: number, elapsedTime: number, guarding = false, aim?: CombatantAimPose): void {
    this.driveState = resolveMannequinDriveState(this.healthState);
    const movement = this.locomotion.sample(
      this.healthState.worldPosition, this.healthState.yawRad, dt, this.driveState.mode === 'ANIM_STANDING'
    );
    const headgearAttached = this.dismemberment.syncHeadgear(this.healthState, this.fxManager);
    const glb = this.combatantGlb;

    if (glb) {
      glb.rootEntity.enabled = true;
      this.dismemberment.syncGlbSeverances(glb, this.healthState, this.isXRayActive);
      this.dismemberment.syncGearVisibility(glb, this.healthState, this.isXRayActive, headgearAttached);

      switch (this.driveState.mode) {
        case 'FULL_RAGDOLL': {
          this.animController.freezeAnimation(glb);
          glb.rootEntity.setPosition(0, 0, 0);
          glb.rootEntity.setEulerAngles(0, 0, 0);
          for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
            this.boneSync.applyRagdollBoneToGlbJoint(glb, zone, this.healthState);
          }
          glb.rootEntity.syncHierarchy();
          break;
        }
        case 'ANIM_STANDING':
        case 'ANIM_WOUNDED_POSTURE': {
          this.animController.syncAnimation(glb, this.healthState, guarding, movement, aim);
          glb.rootEntity.setPosition(
            this.healthState.worldPosition.x,
            this.healthState.worldPosition.y,
            this.healthState.worldPosition.z
          );
          glb.rootEntity.setEulerAngles(0, (this.healthState.yawRad * 180) / Math.PI, 0);
          this.deadLimbOverlay.sync(glb, this.healthState, this.boneSync, dt);
          if (this.healthState.severedZones.size > 0) {
            for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
              if (this.healthState.ragdollBones[zone].componentId !== 'BODY') {
                this.boneSync.applyRagdollBoneToGlbJoint(glb, zone, this.healthState);
              }
            }
            glb.rootEntity.syncHierarchy();
          }
          break;
        }
      }
    }

    this.weaponMount.syncWeaponPosition(this.healthState, glb, this.fxManager, guarding);
    this.syncPoseAttachments();
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

  public syncPoseAttachments(): void {
    const state = this.healthState;
    const glb = this.combatantGlb;
    this.driveState = resolveMannequinDriveState(state);
    const animated = glb !== null && this.driveState.mode !== 'FULL_RAGDOLL';
    const leftArmDead = this.driveState.leftArmDeadAttached;
    const rightArmDead = this.driveState.rightArmDeadAttached;
    for (const [zone, bundle] of this.zoneBundles) {
      const skipRead =
        (leftArmDead && (zone === 'UPPER_ARM_LEFT' || zone === 'FOREARM_LEFT' || zone === 'HAND_LEFT')) ||
        (rightArmDead && (zone === 'UPPER_ARM_RIGHT' || zone === 'FOREARM_RIGHT' || zone === 'HAND_RIGHT'));
      if (animated && !skipRead) this.boneSync.readAnimatedBone(glb, zone, state);
      const bone = state.ragdollBones[zone];
      bundle.zoneNode.setPosition(bone.position.x, bone.position.y, bone.position.z);
      this.boneSync.setEntityBasisRotation(bundle.zoneNode, bone.basisRight, bone.basisUp, bone.basisForward);
    }
    if (animated) this.boneSync.readAnimatedAuxParticles(glb, state);
  }

  public playWeaponFire(): Vec3Like | undefined {
    return this.weaponMount.playFire();
  }

  public get isPlayingPistolAim(): boolean {
    return this.animController.clipState.kind === 'PLAYING' && this.animController.clipState.clip === 'PistolAim';
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
