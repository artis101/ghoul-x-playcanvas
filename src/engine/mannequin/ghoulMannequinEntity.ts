import * as pc from 'playcanvas';
import { ALL_GHOUL_ZONES } from '../../core/ghoul/anatomy.ts';
import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { GlbModelRegistry, CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import { type ArchetypeRetroMaterialSet, getArchetypeRetroMaterials } from '../retroTextures.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { GlbZoneMaterialPair, StumpCap, ZoneMeshBundle } from './types.ts';
import { TOPOLOGICAL_GHOUL_ZONES } from './combatantPoseConstants.ts';
import { setupCombatantGlbInstance } from './combatantGlbSetup.ts';
import { CombatantAnimController, type CombatantAimPose } from './combatantAnimController.ts';
import { CombatantLocomotion } from './combatantLocomotion.ts';
import { CombatantAimFacing } from './combatantAimFacing.ts';
import { CombatantBoneSync } from './combatantBoneSync.ts';
import { CombatantDismemberment } from './combatantDismemberment.ts';
import { CombatantSeveredSkin } from './combatantSeveredSkin.ts';
import { CombatantImpactCuts } from './combatantImpactCuts.ts';
import { CombatantVisualGoreSync } from './combatantVisualGoreSync.ts';
import { CombatantWoundDecals } from './combatantWoundDecals.ts';
import { CombatantWeaponMount } from './combatantWeaponMount.ts';
import { CombatantDeadLimbOverlay } from './combatantDeadLimbOverlay.ts';
import { CombatantCrawlOverlay } from './combatantCrawlOverlay.ts';
import { buildStumpCaps } from './combatantStumpCaps.ts';
import type { WoundClipOwner } from './combatantWoundClips.ts';
import type { SeatedClipPlan } from './combatantSeatedClips.ts';
import { markFlinchClipHeld } from '../ai/woundClipHold.ts';
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
  private stumpCaps: Map<GhoulZoneId, StumpCap> = new Map();
  public driveState: MannequinDriveState;

  private readonly animController = new CombatantAnimController();
  private readonly locomotion = new CombatantLocomotion();
  // Turns the body so a side-on one-handed aim clip still points its gun at the target.
  private readonly aimFacing = new CombatantAimFacing();
  private readonly boneSync = new CombatantBoneSync();
  private readonly dismemberment = new CombatantDismemberment();
  private readonly severedSkin = new CombatantSeveredSkin();
  private readonly impactCuts = new CombatantImpactCuts();
  private readonly visualGoreSync = new CombatantVisualGoreSync();
  private readonly woundDecals = new CombatantWoundDecals();
  private readonly weaponMount = new CombatantWeaponMount();
  private readonly deadLimbOverlay = new CombatantDeadLimbOverlay();
  private readonly crawlOverlay = new CombatantCrawlOverlay();

  private readonly glbZoneMaterialPairs = new Map<GhoulZoneId, GlbZoneMaterialPair[]>();

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
    this.driveState = this.resolveDriveState();

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
    this.severedSkin.reset();
    this.impactCuts.reset();
    this.crawlOverlay.reset();
    this.weaponMount.reset();
    this.animController.reset();
    this.aimFacing.reset();
    this.driveState = this.resolveDriveState();
  }

  /**
   * A hand or forearm stump follows the body clip once the GLB has the stump clips; before they
   * are baked it hangs as a dead arm, since the idle clip would hold it out at a missing gun.
   */
  private get stumpClipsBaked(): boolean {
    return this.combatantGlb?.availableClips.has('StumpClutchRight') ?? false;
  }

  private resolveDriveState(): MannequinDriveState {
    return resolveMannequinDriveState(this.healthState, this.stumpClipsBaked);
  }

  private buildSkeleton(): void {
    for (const zone of ALL_GHOUL_ZONES) {
      const zoneNode = new pc.Entity(`Zone_${zone}`);
      this.rootEntity.addChild(zoneNode);

      this.zoneBundles.set(zone, {
        zone,
        zoneNode,
        fleshMeshInstances: [],
        intactMaterials: [],
        laceratedMaterials: [],
        woundDecalNodes: [],
        boneNodes: [],
        organNodes: [],
      });
    }
  }

  public attachCombatantGlb(glbRegistry: GlbModelRegistry): boolean {
    this.weaponMount.attachGlbWeaponIfReady(glbRegistry, this.healthState, this.rootEntity);
    const inst = setupCombatantGlbInstance(
      glbRegistry,
      this.healthState,
      this.materials,
      this.glbZoneMaterialPairs
    );
    if (!inst) return false;

    this.combatantGlb = inst;
    this.stumpCaps = buildStumpCaps(inst, this.materials);
    this.impactCuts.bind(this.stumpCaps, this.materials);
    this.rootEntity.addChild(inst.rootEntity);
    this.syncFromHealthState(0, 0);
    return true;
  }

  public syncFromHealthState(dt: number, elapsedTime: number, guarding = false, aim?: CombatantAimPose): void {
    this.driveState = this.resolveDriveState();
    // The gait is picked against the way the body visibly faces, bladed aim turn included.
    const movement = this.locomotion.sample(
      this.healthState.worldPosition, this.healthState.yawRad + this.aimFacing.yawRad, dt, this.driveState.mode === 'ANIM_STANDING'
    );
    const headgearAttached = this.dismemberment.syncHeadgear(this.healthState, this.fxManager);
    const glb = this.combatantGlb;

    if (glb) {
      glb.rootEntity.enabled = true;
      this.dismemberment.syncGlbSeverances(glb, this.healthState);
      this.severedSkin.sync(glb, this.healthState, this.impactCuts);
      this.dismemberment.syncGearVisibility(glb, this.healthState, headgearAttached);

      switch (this.driveState.mode) {
        case 'FULL_RAGDOLL': {
          this.animController.freezeAnimation(glb);
          this.animController.seatedClip = null;
          glb.rootEntity.setPosition(0, 0, 0);
          glb.rootEntity.setEulerAngles(0, 0, 0);
          this.aimFacing.reset();
          for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
            this.boneSync.applyRagdollBoneToGlbJoint(glb, zone, this.healthState);
          }
          glb.rootEntity.syncHierarchy();
          break;
        }
        case 'ANIM_DYING': {
          // Killed on its feet: the death clip brings it down; a later hit only jolts it.
          this.animController.syncDying(glb, this.healthState);
          this.placeAnimatedRoot(glb, dt);
          this.deadLimbOverlay.syncDyingJolt(glb, this.healthState, dt);
          markFlinchClipHeld(this.healthState, false);
          this.applySeveredBones(glb);
          break;
        }
        case 'ANIM_STANDING':
        case 'ANIM_WOUNDED_POSTURE': {
          this.animController.syncAnimation(
            glb, this.healthState, guarding, movement, aim, this.locomotion.groundSpeed, dt
          );
          this.placeAnimatedRoot(glb, dt);
          // A wound, fall, seated, stump-clutch or crawl clip already shows the hit, so the graze
          // jolt is off under it; with no such clip it plays in full.
          this.deadLimbOverlay.sync(glb, this.healthState, this.boneSync, dt, {
            woundClip: this.animController.activeWoundClip,
            bodyClip:
              this.animController.seatedClip !== null ||
              this.animController.isStumpClutching ||
              this.animController.isCrawling,
          }, this.stumpClipsBaked);
          // Tell the AI a flinch clip still holds the body, so it is not walked or strafed meanwhile.
          markFlinchClipHeld(this.healthState, this.animController.isFlinchHolding);
          this.crawlOverlay.sync(
            glb, this.healthState, this.animController.isCrawling, dt, elapsedTime, this.fxManager
          );
          this.applySeveredBones(glb);
          break;
        }
      }
    }

    this.weaponMount.syncWeaponPosition(
      this.healthState, glb, this.fxManager, guarding, dt,
      aim && aim.clip !== 'LongGunAim' ? aim.hand ?? null : null
    );
    this.syncPoseAttachments();
    this.dismemberment.syncStumps(this.stumpCaps, this.healthState);
    this.woundDecals.syncSurfaceWounds(this.healthState, this.zoneBundles, this.materials);
    this.visualGoreSync.refreshIfDirty(
      this.healthState, glb, this.woundDecals.syncedCount, this.glbZoneMaterialPairs, this.zoneBundles
    );
  }

  /** Stands the animated body where the health state is, turned by its facing and bladed aim. */
  private placeAnimatedRoot(glb: CombatantGlbInstance, dt: number): void {
    const p = this.healthState.worldPosition;
    glb.rootEntity.setPosition(p.x, p.y, p.z);
    const facingYaw = this.healthState.yawRad + this.aimFacing.update(glb, this.healthState.alive, dt);
    glb.rootEntity.setEulerAngles(0, (facingYaw * 180) / Math.PI, 0);
  }

  /** Severed parts follow their own physics pieces, not the clip. */
  private applySeveredBones(glb: CombatantGlbInstance): void {
    if (this.healthState.severedZones.size === 0) return;
    for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
      if (this.healthState.ragdollBones[zone].componentId !== 'BODY') {
        this.boneSync.applyRagdollBoneToGlbJoint(glb, zone, this.healthState);
      }
    }
    glb.rootEntity.syncHierarchy();
  }

  public syncPoseAttachments(): void {
    const state = this.healthState;
    const glb = this.combatantGlb;
    this.driveState = this.resolveDriveState();
    const animated = glb !== null && this.driveState.mode !== 'FULL_RAGDOLL';
    state.poseFromAnimation = animated;
    const rightArmDead = this.driveState.rightArmDeadAttached;
    const leftArmDead = this.driveState.leftArmDeadAttached;
    for (const [zone, bundle] of this.zoneBundles) {
      const skipRead =
        (rightArmDead && (zone === 'UPPER_ARM_RIGHT' || zone === 'FOREARM_RIGHT' || zone === 'HAND_RIGHT')) ||
        (leftArmDead && (zone === 'UPPER_ARM_LEFT' || zone === 'FOREARM_LEFT' || zone === 'HAND_LEFT'));
      if (animated && !skipRead) this.boneSync.readAnimatedBone(glb, zone, state);
      const bone = state.ragdollBones[zone];
      bundle.zoneNode.setPosition(bone.position.x, bone.position.y, bone.position.z);
      this.boneSync.setEntityBasisRotation(bundle.zoneNode, bone.basisRight, bone.basisUp, bone.basisForward);
    }
    if (animated) this.boneSync.readAnimatedAuxParticles(glb, state);
  }

  /** The gun in this combatant's hands, while it is still held. */
  public get heldWeaponEntity(): pc.Entity | null {
    const node = this.weaponMount.heldWeaponNode;
    return node && node.enabled && this.weaponMount.wasWeaponHeld ? node : null;
  }

  public playWeaponReload(): number | undefined {
    return this.weaponMount.playReload();
  }

  public playWeaponFire(): Vec3Like | undefined {
    return this.weaponMount.playFire();
  }

  /** True while the two-handed pistol aim plays, on the whole body or over a gait on the upper layer. */
  public get isPlayingPistolAim(): boolean {
    const state = this.animController.clipState;
    return (state.kind === 'PLAYING' && state.clip === 'PistolAim') || this.animController.upperBody.clip === 'PistolAim';
  }

  /** The seated last-stand clip asked for this frame (draw, aim or agony), or null. */
  public get seatedClip(): SeatedClipPlan | null {
    return this.animController.seatedClip;
  }

  /** True while the downed body drags itself along in the crawl loop. */
  public get isCrawling(): boolean {
    return this.animController.isCrawling;
  }

  /** Which kind of wound clip owns the body this frame, if any. */
  public get activeWoundClip(): WoundClipOwner {
    return this.animController.activeWoundClip;
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
