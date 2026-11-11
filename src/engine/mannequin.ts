import * as pc from 'playcanvas';
import {
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../contracts/ballistics.ts';
import {
  ALL_GHOUL_ZONES,
  createTargetHealthState,
  updateStandingCombatPose,
} from '../core/ghoul/anatomy.ts';
import { add, cross, length, normalize, scale, sub, vec3 } from '../core/ballistics/vec3.ts';
import { EngineMaterialPalette } from './materials.ts';
import {
  ArchetypeRetroMaterialSet,
  getArchetypeRetroMaterials,
} from './retroTextures.ts';
import {
  attachCustomMesh,
  buildArchetypeHeadgearEntity,
  buildEnemyWeaponEntity,
  getOrCreateRetroMeshes,
} from './retroMeshBuilder.ts';
import {
  CombatantAnimationClipName,
  CombatantGlbInstance,
  getArchetypeWeaponAssetId,
  GlbModelRegistry,
  WeaponGlbInstance,
} from './assets/glbLoader.ts';
import { GoreAndBallisticsFxManager } from './goreFx.ts';

export interface ChildSocketStump {
  childZone: GhoulZoneId;
  node: pc.Entity;
}

export interface ZoneMeshBundle {
  zone: GhoulZoneId;
  zoneNode: pc.Entity;
  fleshNode: pc.Entity;
  fleshMeshInstances: pc.MeshInstance[];
  intactMaterials: pc.StandardMaterial[];
  laceratedMaterials: pc.StandardMaterial[];
  woundDecalNodes: pc.Entity[];
  boneNodes: pc.Entity[];
  organNodes: pc.Entity[];
  proximalStumpNode?: pc.Entity;
  distalChildStumps: ChildSocketStump[];
  intactAbdomenNode?: pc.Entity;
  evisceratedAbdomenNode?: pc.Entity;
}

/**
 * Parent-before-child topological ordering of all 22 GHOUL zones so setting world-space
 * transforms on `Bone_${zone}` nodes never gets overwritten by an ancestor bone update.
 */
const TOPOLOGICAL_GHOUL_ZONES: readonly GhoulZoneId[] = [
  'PELVIS_GROIN',
  'TORSO_LOWER_ABDOMEN',
  'TORSO_UPPER_THORAX',
  'NECK_CERVICAL',
  'HEAD_CRANIUM',
  'HEAD_FACE_JAW',
  'SHOULDER_LEFT',
  'UPPER_ARM_LEFT',
  'FOREARM_LEFT',
  'HAND_LEFT',
  'SHOULDER_RIGHT',
  'UPPER_ARM_RIGHT',
  'FOREARM_RIGHT',
  'HAND_RIGHT',
  'THIGH_LEFT',
  'KNEE_LEFT',
  'SHIN_LEFT',
  'FOOT_LEFT',
  'THIGH_RIGHT',
  'KNEE_RIGHT',
  'SHIN_RIGHT',
  'FOOT_RIGHT',
] as const;

interface RestRagdollBoneFrame {
  restPos: pc.Vec3;
  restRot: pc.Quat;
  restRotInv: pc.Quat;
}

function basisToQuat(
  right: Vec3Like,
  up: Vec3Like,
  forward: Vec3Like,
  tmpMat: pc.Mat4,
  outQuat: pc.Quat
): pc.Quat {
  const d = tmpMat.data;
  d[0] = right.x;
  d[1] = right.y;
  d[2] = right.z;
  d[3] = 0;

  d[4] = up.x;
  d[5] = up.y;
  d[6] = up.z;
  d[7] = 0;

  d[8] = forward.x;
  d[9] = forward.y;
  d[10] = forward.z;
  d[11] = 0;

  d[12] = 0;
  d[13] = 0;
  d[14] = 0;
  d[15] = 1;

  outQuat.setFromMat4(tmpMat);
  return outQuat;
}

const REST_RAGDOLL_FRAMES: ReadonlyMap<GhoulZoneId, RestRagdollBoneFrame> = (() => {
  const refState = createTargetHealthState('__glb_rest_ref__', 'RestRef', vec3(0, 0, 0), 0);
  const mat = new pc.Mat4();
  const map = new Map<GhoulZoneId, RestRagdollBoneFrame>();
  for (const zone of ALL_GHOUL_ZONES) {
    const b = refState.ragdollBones[zone];
    const restRot = basisToQuat(b.basisRight, b.basisUp, b.basisForward, mat, new pc.Quat());
    const restRotInv = restRot.clone().invert();
    map.set(zone, {
      restPos: new pc.Vec3(b.position.x, b.position.y, b.position.z),
      restRot,
      restRotInv,
    });
  }
  return map;
})();

interface GlbZoneMaterialPair {
  meshInstance: pc.MeshInstance;
  intactMat: pc.Material;
  laceratedMat: pc.Material;
}

const sharedGlbZoneMatCache = new WeakMap<
  pc.Material,
  Map<string, { intactMat: pc.Material; laceratedMat: pc.Material }>
>();
const sharedSwatGearMatCache = new WeakMap<pc.Material, pc.StandardMaterial>();

/**
 * Class GhoulMannequinEntity renders a sculpted 22-zone tactical combatant driven by
 * baked Blender 5.2 animations (right-handed ~87.5% & southpaw ~12.5%) and a 22-zone PBD
 * articulated ragdoll & GHOUL dismemberment skeleton — keeping the sculpted Blender GLB
 * active across ALL states (healthy, wounded, eviscerated, dismembered, and KIA/ragdoll)
 * with zero fallback swaps to legacy meshes once loaded.
 */
export class GhoulMannequinEntity {
  public readonly rootEntity: pc.Entity;
  public readonly healthState: TargetHealthState;
  public readonly app: pc.AppBase;
  public readonly materials: EngineMaterialPalette;
  public readonly retroMats: ArchetypeRetroMaterialSet;
  private readonly fxManager?: GoreAndBallisticsFxManager;

  private zoneBundles: Map<GhoulZoneId, ZoneMeshBundle> = new Map();
  private headgearNode: pc.Entity | null = null;
  private heldWeaponNode: pc.Entity | null = null;
  private heldWeaponGlb: WeaponGlbInstance | null = null;
  private glbExpected = false;
  private wasHeadgearIntact = true;
  private wasWeaponHeld = true;
  private syncedSurfaceWoundCount = 0;

  private isXRayActive = false;
  private heartEntity: pc.Entity | null = null;
  private brainEntity: pc.Entity | null = null;

  public combatantGlb: CombatantGlbInstance | null = null;
  private readonly glbZoneMaterialPairs = new Map<GhoulZoneId, GlbZoneMaterialPair[]>();
  private readonly glbGearOriginalMaterials = new Map<pc.MeshInstance, pc.Material>();
  private readonly clonedGlbMaterials: pc.StandardMaterial[] = [];
  private activeGlbClipKey: string | null = null;
  private readonly lastSyncedZoneGoreModes: Partial<Record<GhoulZoneId, string>> = {};
  private lastMatSyncXRay: boolean | null = null;
  private lastMatSyncHasGlb: boolean | null = null;
  private lastMatSyncGlbExpected: boolean | null = null;
  private lastMatSyncFractureCount = -1;
  private lastMatSyncWoundCount = -1;

  private readonly tmpMat4 = new pc.Mat4();
  private readonly tmpQuat = new pc.Quat();
  private readonly tmpRagQuat = new pc.Quat();
  private readonly tmpDeltaQuat = new pc.Quat();
  private readonly tmpWorldQuat = new pc.Quat();
  private readonly tmpBindInvQuat = new pc.Quat();
  private readonly tmpOffsetVec = new pc.Vec3();
  private readonly tmpRotOffsetVec = new pc.Vec3();

  constructor(
    app: pc.AppBase,
    healthState: TargetHealthState,
    materials: EngineMaterialPalette,
    fxManager?: GoreAndBallisticsFxManager,
    glbRegistry?: GlbModelRegistry | null
  ) {
    this.app = app;
    this.healthState = healthState;
    this.materials = materials;
    this.fxManager = fxManager;
    this.glbExpected = Boolean(glbRegistry);
    this.retroMats = getArchetypeRetroMaterials(app.graphicsDevice, healthState.archetype);

    // Keep rootEntity at world origin (0,0,0) identity so every zoneNode uses exact world-space coordinates
    this.rootEntity = new pc.Entity(`Combatant_${healthState.targetId}`);
    this.rootEntity.setPosition(0, 0, 0);
    this.rootEntity.setEulerAngles(0, 0, 0);

    this.buildCombatant();
    if (glbRegistry) {
      this.attachWeaponGlbIfReady(glbRegistry);
      if (glbRegistry.isLoaded('ghoul_combatant')) {
        this.attachCombatantGlb(glbRegistry);
      }
    }
    this.syncFromHealthState(0, 0);
  }

  private attachWeaponGlbIfReady(glbRegistry: GlbModelRegistry): void {
    if (this.heldWeaponGlb) return;
    const weaponAssetId = getArchetypeWeaponAssetId(this.healthState.archetype);
    if (!glbRegistry.isLoaded(weaponAssetId)) return;

    try {
      const wInst = glbRegistry.instantiateWeapon(weaponAssetId, {
        castShadows: false,
        receiveShadows: true,
      });
      if (wInst.animComponent) {
        wInst.animComponent.playing = false;
      }
      if (this.heldWeaponNode) {
        this.heldWeaponNode.destroy();
      }
      this.heldWeaponGlb = wInst;
      this.heldWeaponNode = wInst.rootEntity;
      this.heldWeaponNode.enabled = this.wasWeaponHeld;
      this.rootEntity.addChild(this.heldWeaponNode);
    } catch {
      // Keep existing heldWeaponNode if headless/null graphics context skips weapon container
    }
  }

  /**
   * Resolves a shared Blender GLB `StandardMaterial` pair (intact + bloody laceration variant)
   * cached per `(baseSource, archetype, garmentRole)` so all combatants share shader programs & uniforms.
   */
  private createArchetypeAndBloodyGlbMaterials(
    srcMat: pc.Material,
    zone: GhoulZoneId,
    primIndex: number,
    bareArmMat: pc.Material | null
  ): { intactMat: pc.Material; laceratedMat: pc.Material } {
    const arch = this.healthState.archetype;
    let baseSource = srcMat;

    // NYC Skinhead Punk wears a sleeveless biker vest showing bare muscular arms!
    if (
      arch === 'SKINHEAD_PUNK' &&
      bareArmMat &&
      primIndex === 0 &&
      (zone === 'SHOULDER_LEFT' ||
        zone === 'SHOULDER_RIGHT' ||
        zone === 'UPPER_ARM_LEFT' ||
        zone === 'UPPER_ARM_RIGHT')
    ) {
      baseSource = bareArmMat;
    }

    if (!(baseSource instanceof pc.StandardMaterial)) {
      return { intactMat: baseSource, laceratedMat: this.materials.goreStumpMat };
    }

    const isTorsoShirt = zone === 'TORSO_UPPER_THORAX' || zone === 'TORSO_LOWER_ABDOMEN';
    const isSleeve =
      zone === 'SHOULDER_LEFT' ||
      zone === 'SHOULDER_RIGHT' ||
      zone === 'UPPER_ARM_LEFT' ||
      zone === 'UPPER_ARM_RIGHT';
    const isForearmSkin = zone === 'FOREARM_LEFT' || zone === 'FOREARM_RIGHT';
    const isTrousers =
      zone === 'PELVIS_GROIN' ||
      zone === 'THIGH_LEFT' ||
      zone === 'THIGH_RIGHT' ||
      zone === 'KNEE_LEFT' ||
      zone === 'KNEE_RIGHT' ||
      zone === 'SHIN_LEFT' ||
      zone === 'SHIN_RIGHT';

    const garmentRole =
      primIndex !== 0
        ? 'SECONDARY'
        : isTorsoShirt
          ? 'TORSO'
          : isSleeve
            ? 'SLEEVE'
            : isForearmSkin
              ? 'FOREARM'
              : isTrousers
                ? 'TROUSERS'
                : 'OTHER';
    const cacheKey = `${arch}_${garmentRole}`;
    let byArchRole = sharedGlbZoneMatCache.get(baseSource);
    if (!byArchRole) {
      byArchRole = new Map();
      sharedGlbZoneMatCache.set(baseSource, byArchRole);
    }
    const cachedPair = byArchRole.get(cacheKey);
    if (cachedPair) {
      return cachedPair;
    }

    const intactClone = baseSource.clone();
    intactClone.fresnelModel = pc.FRESNEL_SCHLICK;
    if (intactClone.normalMap) {
      intactClone.bumpiness = Math.max(intactClone.bumpiness || 1.0, 1.15);
    }

    // Apply subtle archetype uniform palette variation on primary garment primitives while preserving baked PBR maps
    if (primIndex === 0) {
      if (arch === 'SKINHEAD_PUNK') {
        if (isTorsoShirt) {
          intactClone.diffuse.set(0.56, 0.56, 0.62);
        } else if (isTrousers) {
          intactClone.diffuse.set(0.76, 0.80, 0.86);
        }
      } else if (arch === 'HEAVY_ENFORCER') {
        if (isTorsoShirt || isSleeve || isTrousers) {
          intactClone.diffuse.set(0.50, 0.58, 0.72);
        } else if (isForearmSkin) {
          // Full-sleeve dark Kevlar SWAT uniform while keeping normal/roughness micro-detail
          intactClone.diffuseMap = null;
          intactClone.diffuse.set(0.14, 0.17, 0.22);
        }
      } else if (arch === 'SNIPER_OPERATIVE') {
        // Cold urban/arctic slate camo without exceeding realistic PBR albedo bounds
        if (isTorsoShirt || isSleeve) {
          intactClone.diffuse.set(0.92, 0.96, 1.02);
        } else if (isTrousers) {
          intactClone.diffuse.set(0.88, 0.85, 0.72);
        }
      }
    }
    intactClone.update();

    const bloodyClone = intactClone.clone();
    bloodyClone.diffuse.set(0.42, 0.04, 0.05);
    bloodyClone.emissive.set(0.04, 0.004, 0.005);
    // glTF StandardMaterials set glossInvert = true (where gloss stores roughness: 0 = mirror, 1 = matte)
    bloodyClone.gloss = bloodyClone.glossInvert ? 0.16 : 0.86;
    if (bloodyClone.useMetalness) {
      bloodyClone.metalness = 0.08;
    } else {
      bloodyClone.specular.set(0.24, 0.08, 0.08);
    }
    bloodyClone.fresnelModel = pc.FRESNEL_SCHLICK;
    bloodyClone.update();

    const pair = { intactMat: intactClone, laceratedMat: bloodyClone };
    byArchRole.set(cacheKey, pair);
    return pair;
  }

  /**
   * Unblocks procedural fallback only if GLB network/file preloading fails outright.
   */
  public allowProceduralFallback(): void {
    if (!this.combatantGlb) {
      this.glbExpected = false;
      this.syncFromHealthState(0, 0);
    }
  }

  /**
   * Attaches the sculpted & rigged Blender 5.2 `ghoul_combatant.glb` 22-zone hierarchy
   * (with ESAPI plate carrier, PASGT helmet, tactical visor, Spetsnaz beret, punk mohawk,
   * eviscerated gut cavity, sculpted X-Ray anatomy, and right-handed + southpaw animations).
   */
  public attachCombatantGlb(glbRegistry: GlbModelRegistry): boolean {
    this.glbExpected = true;
    this.attachWeaponGlbIfReady(glbRegistry);

    if (this.combatantGlb || !glbRegistry.isLoaded('ghoul_combatant')) {
      return false;
    }

    try {
      const inst = glbRegistry.instantiateCombatant({
        castShadows: true,
        receiveShadows: true,
        initialClip: 'CombatReadyIdle',
        southpaw: this.healthState.isLeftHanded,
      });
      this.combatantGlb = inst;
      this.activeGlbClipKey = `CombatReadyIdle_${this.healthState.isLeftHanded ? 'L' : 'R'}`;
      this.rootEntity.addChild(inst.rootEntity);

      // Extract bare forearm skin material reference so sleeveless archetypes can share packed skin texture
      const forearmSampleMat =
        inst.zoneEntities.get('FOREARM_LEFT')?.render?.meshInstances?.[0]?.material ?? null;

      // Build per-zone intact & bloody PBR material pairs so LACERATED zones never swap models
      for (const [zone, zEnt] of inst.zoneEntities) {
        if (!zEnt.render) continue;
        const pairs: GlbZoneMaterialPair[] = [];
        zEnt.render.meshInstances.forEach((mi, idx) => {
          const orig = mi.material;
          if (orig) {
            const { intactMat, laceratedMat } = this.createArchetypeAndBloodyGlbMaterials(
              orig,
              zone,
              idx,
              forearmSampleMat
            );
            mi.material = intactMat;
            pairs.push({ meshInstance: mi, intactMat, laceratedMat });
          }
        });
        this.glbZoneMaterialPairs.set(zone, pairs);
      }

      // Cache & tint archetype headgear/armor materials for clean [X] X-Ray toggling
      for (const gearEnt of [
        inst.esapiPlateCarrier,
        inst.pasgtHelmet,
        inst.tacticalVisor,
        inst.spetsnazBeret,
        inst.punkMohawk,
        inst.evisceratedGut,
      ]) {
        if (!gearEnt?.render) continue;
        for (const mi of gearEnt.render.meshInstances) {
          if (!mi.material) continue;
          let gearMat = mi.material;
          if (
            this.healthState.archetype === 'HEAVY_ENFORCER' &&
            (gearEnt === inst.pasgtHelmet || gearEnt === inst.esapiPlateCarrier) &&
            gearMat instanceof pc.StandardMaterial
          ) {
            let swatGear = sharedSwatGearMatCache.get(gearMat);
            if (!swatGear) {
              swatGear = gearMat.clone();
              swatGear.diffuse.set(0.55, 0.62, 0.72);
              swatGear.update();
              sharedSwatGearMatCache.set(gearMat, swatGear);
            }
            mi.material = swatGear;
            gearMat = swatGear;
          }
          this.glbGearOriginalMaterials.set(mi, gearMat);
        }
      }

      // Permanently disable legacy procedural flesh & headgear meshes once Blender GLB is attached!
      for (const bundle of this.zoneBundles.values()) {
        bundle.fleshNode.enabled = false;
      }
      if (this.headgearNode) {
        this.headgearNode.enabled = false;
      }

      this.syncFromHealthState(0, 0);
      return true;
    } catch {
      this.combatantGlb = null;
      this.glbExpected = false;
      return false;
    }
  }

  private buildCombatant(): void {
    for (const zone of ALL_GHOUL_ZONES) {
      const zoneNode = new pc.Entity(`Zone_${zone}`);
      this.rootEntity.addChild(zoneNode);

      const fleshNode = new pc.Entity(`Flesh_${zone}`);
      fleshNode.enabled = !this.glbExpected;
      zoneNode.addChild(fleshNode);

      const fleshMeshInstances: pc.MeshInstance[] = [];
      const intactMaterials: pc.StandardMaterial[] = [];
      const laceratedMaterials: pc.StandardMaterial[] = [];
      const woundDecalNodes: pc.Entity[] = [];
      const boneNodes: pc.Entity[] = [];
      const organNodes: pc.Entity[] = [];

      const { intactAbdomenNode, evisceratedAbdomenNode } = this.buildZoneRetroMesh(
        zone,
        fleshNode,
        fleshMeshInstances,
        intactMaterials,
        laceratedMaterials
      );

      this.buildZoneInternalAnatomy(zone, zoneNode, boneNodes, organNodes);
      // Internal X-ray skeleton & organs stay hidden until [X] anatomical inspector is toggled
      for (const b of boneNodes) b.enabled = false;
      for (const o of organNodes) o.enabled = false;

      const proximalStumpNode = this.buildProximalLimbStump(zone, zoneNode);
      const distalChildStumps = this.buildDistalParentSocketStumps(zone, zoneNode);

      this.zoneBundles.set(zone, {
        zone,
        zoneNode,
        fleshNode,
        fleshMeshInstances,
        intactMaterials,
        laceratedMaterials,
        woundDecalNodes,
        boneNodes,
        organNodes,
        proximalStumpNode,
        distalChildStumps,
        intactAbdomenNode,
        evisceratedAbdomenNode,
      });
    }

    // Fallback weapon entity (immediately replaced by Blender weapon GLB when glbRegistry is loaded)
    this.heldWeaponNode = buildEnemyWeaponEntity(
      this.app.graphicsDevice,
      this.healthState.archetype,
      this.retroMats
    );
    this.heldWeaponNode.enabled = !this.glbExpected;
    this.rootEntity.addChild(this.heldWeaponNode);
  }

  private buildZoneRetroMesh(
    zone: GhoulZoneId,
    fleshNode: pc.Entity,
    fleshMeshInstances: pc.MeshInstance[],
    intactMaterials: pc.StandardMaterial[],
    laceratedMaterials: pc.StandardMaterial[]
  ): { intactAbdomenNode?: pc.Entity; evisceratedAbdomenNode?: pc.Entity } {
    const lib = getOrCreateRetroMeshes(this.app.graphicsDevice);
    const rm = this.retroMats;

    const addPart = (
      name: string,
      mesh: pc.Mesh,
      intactMat: pc.StandardMaterial,
      bloodyMat: pc.StandardMaterial,
      parent: pc.Entity = fleshNode
    ): pc.Entity => {
      const ent = new pc.Entity(name);
      const mi = attachCustomMesh(ent, mesh, intactMat, true);
      parent.addChild(ent);
      fleshMeshInstances.push(mi);
      intactMaterials.push(intactMat);
      laceratedMaterials.push(bloodyMat);
      return ent;
    };

    switch (zone) {
      case 'HEAD_CRANIUM': {
        addPart('HeadCranium', lib.headCranium, rm.headMat, rm.headBloodyMat);
        this.headgearNode = buildArchetypeHeadgearEntity(
          this.app.graphicsDevice,
          this.healthState.archetype,
          rm
        );
        fleshNode.addChild(this.headgearNode);
        return {};
      }

      case 'HEAD_FACE_JAW': {
        addPart('HeadJaw', lib.headJaw, rm.jawMat, rm.jawBloodyMat);
        return {};
      }

      case 'NECK_CERVICAL': {
        addPart('NeckCollar', lib.neckCollar, rm.headMat, rm.headBloodyMat);
        return {};
      }

      case 'TORSO_UPPER_THORAX': {
        addPart('HeroicThorax', lib.thoraxHeroic, rm.torsoMat, rm.torsoBloodyMat);

        if (this.healthState.archetype !== 'SKINHEAD_PUNK') {
          for (const side of [-1, 1]) {
            const pouch = addPart(
              `ChestMagPouch_${side}`,
              lib.ammoPouch,
              rm.pouchWebbingMat,
              rm.torsoBloodyMat
            );
            pouch.setLocalPosition(side * 0.076, 0.055, 0.132);
            pouch.setLocalEulerAngles(-6, side * 8, 0);
          }
        }
        return {};
      }

      case 'TORSO_LOWER_ABDOMEN': {
        const intactAbdomenNode = new pc.Entity('AbdomenIntactGroup');
        fleshNode.addChild(intactAbdomenNode);
        addPart(
          'AbdomenIntactMesh',
          lib.abdomenIntact,
          rm.abdomenMat,
          rm.abdomenBloodyMat,
          intactAbdomenNode
        );

        const evisceratedAbdomenNode = new pc.Entity('AbdomenEvisceratedGroup');
        evisceratedAbdomenNode.enabled = false;
        fleshNode.addChild(evisceratedAbdomenNode);

        const outerCrater = new pc.Entity('AbdomenGoreShell');
        attachCustomMesh(outerCrater, lib.abdomenEvisceratedOuter, rm.abdomenBloodyMat, true);
        evisceratedAbdomenNode.addChild(outerCrater);

        const gutCore = new pc.Entity('VisceralGutCore');
        gutCore.addComponent('render', {
          type: 'box',
          material: this.materials.goreStumpMat,
        });
        gutCore.setLocalScale(0.20, 0.14, 0.11);
        gutCore.setLocalPosition(0, 0.085, 0.032);
        evisceratedAbdomenNode.addChild(gutCore);

        for (const side of [-1, 1]) {
          const ribTip = new pc.Entity(`BrokenRib_${side}`);
          ribTip.addComponent('render', {
            type: 'box',
            material: this.materials.exposedBoneMat,
          });
          ribTip.setLocalScale(0.022, 0.038, 0.018);
          ribTip.setLocalPosition(side * 0.068, 0.155, 0.088);
          ribTip.setLocalEulerAngles(22, 0, side * 28);
          evisceratedAbdomenNode.addChild(ribTip);
        }

        for (let i = 0; i < 3; i++) {
          const coil = new pc.Entity(`EntrailLoop_${i}`);
          coil.addComponent('render', {
            type: 'cylinder',
            material: i % 2 === 0 ? this.materials.liverGutMat : this.materials.goreStumpMat,
          });
          coil.setLocalScale(0.042, 0.095, 0.042);
          coil.setLocalPosition((i - 1) * 0.044, 0.048 - (i % 2) * 0.025, 0.096);
          coil.setLocalEulerAngles(25, 0, (i - 1) * 24);
          evisceratedAbdomenNode.addChild(coil);
        }

        return { intactAbdomenNode, evisceratedAbdomenNode };
      }

      case 'PELVIS_GROIN': {
        addPart('PelvisBelt', lib.pelvisBelt, rm.pelvisMat, rm.pelvisBloodyMat);

        const holsterSign = this.healthState.isLeftHanded ? 1 : -1;
        const sideHolster = addPart(
          'HipHolster',
          lib.ammoPouch,
          rm.pouchWebbingMat,
          rm.pelvisBloodyMat
        );
        sideHolster.setLocalPosition(holsterSign * 0.168, 0.05, 0.01);
        sideHolster.setLocalScale(0.75, 1.15, 1.1);

        const rearPouch = addPart(
          'RearButtpack',
          lib.ammoPouch,
          rm.pouchWebbingMat,
          rm.pelvisBloodyMat
        );
        rearPouch.setLocalPosition(0, 0.09, -0.122);
        rearPouch.setLocalScale(1.6, 0.9, 0.95);
        return {};
      }

      case 'SHOULDER_LEFT':
      case 'SHOULDER_RIGHT': {
        addPart(`${zone}_Cap`, lib.shoulderCap, rm.torsoMat, rm.torsoBloodyMat);
        return {};
      }

      case 'UPPER_ARM_LEFT':
      case 'UPPER_ARM_RIGHT': {
        addPart(`${zone}_Bicep`, lib.upperArmMuscle, rm.upperArmMat, rm.upperArmBloodyMat);
        return {};
      }

      case 'FOREARM_LEFT':
      case 'FOREARM_RIGHT': {
        addPart(`${zone}_Forearm`, lib.forearmTapered, rm.forearmMat, rm.forearmBloodyMat);
        return {};
      }

      case 'HAND_LEFT': {
        addPart('HandMittenL', lib.handMittenLeft, rm.handMat, rm.forearmBloodyMat);
        return {};
      }

      case 'HAND_RIGHT': {
        addPart('HandMittenR', lib.handMittenRight, rm.handMat, rm.forearmBloodyMat);
        return {};
      }

      case 'THIGH_LEFT':
      case 'THIGH_RIGHT': {
        addPart(`${zone}_Cargo`, lib.thighCargo, rm.legsMat, rm.legsBloodyMat);
        const sideSign = zone === 'THIGH_LEFT' ? -1 : 1;
        const cargoPocket = addPart(
          `${zone}_CargoPocket`,
          lib.ammoPouch,
          rm.legsMat,
          rm.legsBloodyMat
        );
        cargoPocket.setLocalPosition(sideSign * 0.092, -0.19, 0.005);
        cargoPocket.setLocalScale(0.55, 1.15, 1.35);
        return {};
      }

      case 'KNEE_LEFT':
      case 'KNEE_RIGHT': {
        addPart(`${zone}_KneePad`, lib.kneeCapPad, rm.kneePadMat, rm.legsBloodyMat);
        return {};
      }

      case 'SHIN_LEFT':
      case 'SHIN_RIGHT': {
        addPart(`${zone}_Shin`, lib.shinBloused, rm.legsMat, rm.legsBloodyMat);
        return {};
      }

      case 'FOOT_LEFT':
      case 'FOOT_RIGHT': {
        addPart(`${zone}_CombatBoot`, lib.combatBoot, rm.bootMat, rm.legsBloodyMat);
        return {};
      }
    }
  }

  /**
   * Builds a bloody GHOUL stump cap + exposed white cortical bone on a severable limb's proximal joint.
   */
  private buildProximalLimbStump(zone: GhoulZoneId, zoneNode: pc.Entity): pc.Entity | undefined {
    const specs: Partial<
      Record<GhoulZoneId, { radius: number; boneLen: number; dirY: number }>
    > = {
      HEAD_CRANIUM: { radius: 0.095, boneLen: 0.05, dirY: -1 },
      UPPER_ARM_LEFT: { radius: 0.095, boneLen: 0.065, dirY: 1 },
      UPPER_ARM_RIGHT: { radius: 0.095, boneLen: 0.065, dirY: 1 },
      FOREARM_LEFT: { radius: 0.082, boneLen: 0.055, dirY: 1 },
      FOREARM_RIGHT: { radius: 0.082, boneLen: 0.055, dirY: 1 },
      HAND_LEFT: { radius: 0.065, boneLen: 0.04, dirY: 1 },
      HAND_RIGHT: { radius: 0.065, boneLen: 0.04, dirY: 1 },
      THIGH_LEFT: { radius: 0.135, boneLen: 0.075, dirY: 1 },
      THIGH_RIGHT: { radius: 0.135, boneLen: 0.075, dirY: 1 },
      KNEE_LEFT: { radius: 0.11, boneLen: 0.06, dirY: 1 },
      KNEE_RIGHT: { radius: 0.11, boneLen: 0.06, dirY: 1 },
      SHIN_LEFT: { radius: 0.10, boneLen: 0.06, dirY: 1 },
      SHIN_RIGHT: { radius: 0.10, boneLen: 0.06, dirY: 1 },
      FOOT_LEFT: { radius: 0.085, boneLen: 0.045, dirY: 1 },
      FOOT_RIGHT: { radius: 0.085, boneLen: 0.045, dirY: 1 },
    };

    const spec = specs[zone];
    if (!spec) return undefined;

    const root = this.createStumpAssembly(`${zone}_ProximalStump`, spec.radius, spec.boneLen, spec.dirY);
    root.enabled = false;
    zoneNode.addChild(root);
    return root;
  }

  /**
   * Builds bloody GHOUL socket stumps on the PARENT body bone where severed child limbs detach!
   */
  private buildDistalParentSocketStumps(
    zone: GhoulZoneId,
    zoneNode: pc.Entity
  ): ChildSocketStump[] {
    const socketDefs: Partial<
      Record<
        GhoulZoneId,
        Array<{
          childZone: GhoulZoneId;
          offset: [number, number, number];
          radius: number;
          boneLen: number;
          dirY: number;
        }>
      >
    > = {
      NECK_CERVICAL: [
        { childZone: 'HEAD_CRANIUM', offset: [0, 0.085, 0], radius: 0.115, boneLen: 0.065, dirY: 1 },
      ],
      SHOULDER_LEFT: [
        { childZone: 'UPPER_ARM_LEFT', offset: [-0.045, -0.085, 0], radius: 0.11, boneLen: 0.065, dirY: -1 },
      ],
      SHOULDER_RIGHT: [
        { childZone: 'UPPER_ARM_RIGHT', offset: [0.045, -0.085, 0], radius: 0.11, boneLen: 0.065, dirY: -1 },
      ],
      UPPER_ARM_LEFT: [
        { childZone: 'FOREARM_LEFT', offset: [0, -0.245, 0], radius: 0.092, boneLen: 0.06, dirY: -1 },
      ],
      UPPER_ARM_RIGHT: [
        { childZone: 'FOREARM_RIGHT', offset: [0, -0.245, 0], radius: 0.092, boneLen: 0.06, dirY: -1 },
      ],
      FOREARM_LEFT: [
        { childZone: 'HAND_LEFT', offset: [0, -0.235, 0], radius: 0.074, boneLen: 0.05, dirY: -1 },
      ],
      FOREARM_RIGHT: [
        { childZone: 'HAND_RIGHT', offset: [0, -0.235, 0], radius: 0.074, boneLen: 0.05, dirY: -1 },
      ],
      PELVIS_GROIN: [
        { childZone: 'THIGH_LEFT', offset: [-0.115, -0.085, 0], radius: 0.145, boneLen: 0.075, dirY: -1 },
        { childZone: 'THIGH_RIGHT', offset: [0.115, -0.085, 0], radius: 0.145, boneLen: 0.075, dirY: -1 },
      ],
      THIGH_LEFT: [
        { childZone: 'KNEE_LEFT', offset: [0, -0.345, 0], radius: 0.125, boneLen: 0.07, dirY: -1 },
      ],
      THIGH_RIGHT: [
        { childZone: 'KNEE_RIGHT', offset: [0, -0.345, 0], radius: 0.125, boneLen: 0.07, dirY: -1 },
      ],
      KNEE_LEFT: [
        { childZone: 'SHIN_LEFT', offset: [0, -0.075, 0], radius: 0.11, boneLen: 0.065, dirY: -1 },
      ],
      KNEE_RIGHT: [
        { childZone: 'SHIN_RIGHT', offset: [0, -0.075, 0], radius: 0.11, boneLen: 0.065, dirY: -1 },
      ],
      SHIN_LEFT: [
        { childZone: 'FOOT_LEFT', offset: [0, -0.205, 0], radius: 0.092, boneLen: 0.055, dirY: -1 },
      ],
      SHIN_RIGHT: [
        { childZone: 'FOOT_RIGHT', offset: [0, -0.205, 0], radius: 0.092, boneLen: 0.055, dirY: -1 },
      ],
    };

    const list = socketDefs[zone];
    if (!list) return [];

    const result: ChildSocketStump[] = [];
    for (const item of list) {
      const node = this.createStumpAssembly(
        `${zone}_Socket_${item.childZone}`,
        item.radius,
        item.boneLen,
        item.dirY
      );
      node.setLocalPosition(item.offset[0], item.offset[1], item.offset[2]);
      node.enabled = false;
      zoneNode.addChild(node);
      result.push({ childZone: item.childZone, node });
    }
    return result;
  }

  private createStumpAssembly(
    name: string,
    meatDiameter: number,
    boneLen: number,
    dirY: number
  ): pc.Entity {
    const root = new pc.Entity(name);

    const meatCap = new pc.Entity('MeatCap');
    meatCap.addComponent('render', {
      type: 'cylinder',
      material: this.materials.goreStumpMat,
    });
    meatCap.setLocalScale(meatDiameter, 0.032, meatDiameter);
    root.addChild(meatCap);

    const boneShaft = new pc.Entity('ProtrudingCorticalBone');
    boneShaft.addComponent('render', {
      type: 'cylinder',
      material: this.materials.exposedBoneMat,
    });
    const boneDiam = meatDiameter * 0.34;
    boneShaft.setLocalScale(boneDiam, boneLen, boneDiam);
    boneShaft.setLocalPosition(0, dirY * (boneLen * 0.45), 0);
    root.addChild(boneShaft);

    return root;
  }

  /**
   * Builds internal 3D skeleton & organs for optional [X] Anatomical X-Ray Inspector mode
   * (used only in headless fallback when `ghoul_combatant.glb` is not loaded).
   */
  private buildZoneInternalAnatomy(
    zone: GhoulZoneId,
    zoneNode: pc.Entity,
    boneNodes: pc.Entity[],
    organNodes: pc.Entity[]
  ): void {
    const matPal = this.materials;

    switch (zone) {
      case 'HEAD_CRANIUM': {
        const skull = new pc.Entity('SkullBone');
        skull.addComponent('render', { type: 'sphere', material: matPal.boneMat });
        skull.setLocalScale(0.15, 0.16, 0.17);
        skull.setLocalPosition(0, 0.06, 0);
        zoneNode.addChild(skull);
        boneNodes.push(skull);

        const brain = new pc.Entity('BrainOrgan');
        brain.addComponent('render', { type: 'sphere', material: matPal.brainMat });
        brain.setLocalScale(0.12, 0.12, 0.13);
        brain.setLocalPosition(0, 0.07, -0.005);
        zoneNode.addChild(brain);
        organNodes.push(brain);
        this.brainEntity = brain;
        break;
      }

      case 'NECK_CERVICAL': {
        const cSpine = new pc.Entity('CervicalSpine');
        cSpine.addComponent('render', { type: 'cylinder', material: matPal.boneMat });
        cSpine.setLocalScale(0.042, 0.10, 0.042);
        cSpine.setLocalPosition(0, 0.02, -0.015);
        zoneNode.addChild(cSpine);
        boneNodes.push(cSpine);

        const carotid = new pc.Entity('CarotidArtery');
        carotid.addComponent('render', { type: 'cylinder', material: matPal.arteryMat });
        carotid.setLocalScale(0.024, 0.10, 0.024);
        carotid.setLocalPosition(0.025, 0.02, 0.015);
        zoneNode.addChild(carotid);
        organNodes.push(carotid);
        break;
      }

      case 'TORSO_UPPER_THORAX': {
        const ribcage = new pc.Entity('RibcageBone');
        ribcage.addComponent('render', { type: 'box', material: matPal.boneMat });
        ribcage.setLocalScale(0.27, 0.21, 0.18);
        ribcage.setLocalPosition(0, 0.10, 0);
        zoneNode.addChild(ribcage);
        boneNodes.push(ribcage);

        const heart = new pc.Entity('HeartOrgan');
        heart.addComponent('render', { type: 'sphere', material: matPal.heartMat });
        heart.setLocalScale(0.10, 0.11, 0.10);
        heart.setLocalPosition(-0.025, 0.08, 0.02);
        zoneNode.addChild(heart);
        organNodes.push(heart);
        this.heartEntity = heart;

        for (const side of [-1, 1]) {
          const lung = new pc.Entity(side < 0 ? 'LeftLung' : 'RightLung');
          lung.addComponent('render', { type: 'box', material: matPal.lungMat });
          lung.setLocalScale(0.085, 0.15, 0.10);
          lung.setLocalPosition(side * 0.08, 0.10, 0.01);
          zoneNode.addChild(lung);
          organNodes.push(lung);
        }
        break;
      }

      case 'TORSO_LOWER_ABDOMEN': {
        const lumbar = new pc.Entity('LumbarSpine');
        lumbar.addComponent('render', { type: 'cylinder', material: matPal.boneMat });
        lumbar.setLocalScale(0.05, 0.17, 0.05);
        lumbar.setLocalPosition(0, 0.08, -0.04);
        zoneNode.addChild(lumbar);
        boneNodes.push(lumbar);

        const guts = new pc.Entity('VisceralOrgans');
        guts.addComponent('render', { type: 'box', material: matPal.liverGutMat });
        guts.setLocalScale(0.18, 0.12, 0.11);
        guts.setLocalPosition(0, 0.08, 0.02);
        zoneNode.addChild(guts);
        organNodes.push(guts);
        break;
      }

      case 'PELVIS_GROIN': {
        const pel = new pc.Entity('PelvisBone');
        pel.addComponent('render', { type: 'box', material: matPal.boneMat });
        pel.setLocalScale(0.25, 0.13, 0.15);
        pel.setLocalPosition(0, 0.02, 0);
        zoneNode.addChild(pel);
        boneNodes.push(pel);
        break;
      }

      case 'UPPER_ARM_LEFT':
      case 'UPPER_ARM_RIGHT': {
        const hum = new pc.Entity(`${zone}_Humerus`);
        hum.addComponent('render', { type: 'cylinder', material: matPal.boneMat });
        hum.setLocalScale(0.036, 0.21, 0.036);
        hum.setLocalPosition(0, -0.12, 0);
        zoneNode.addChild(hum);
        boneNodes.push(hum);
        break;
      }

      case 'FOREARM_LEFT':
      case 'FOREARM_RIGHT': {
        const rad = new pc.Entity(`${zone}_RadiusUlna`);
        rad.addComponent('render', { type: 'cylinder', material: matPal.boneMat });
        rad.setLocalScale(0.03, 0.19, 0.03);
        rad.setLocalPosition(0, -0.11, 0);
        zoneNode.addChild(rad);
        boneNodes.push(rad);
        break;
      }

      case 'THIGH_LEFT':
      case 'THIGH_RIGHT': {
        const fem = new pc.Entity(`${zone}_Femur`);
        fem.addComponent('render', { type: 'cylinder', material: matPal.boneMat });
        fem.setLocalScale(0.045, 0.29, 0.045);
        fem.setLocalPosition(0, -0.17, 0);
        zoneNode.addChild(fem);
        boneNodes.push(fem);
        break;
      }

      case 'SHIN_LEFT':
      case 'SHIN_RIGHT': {
        const tib = new pc.Entity(`${zone}_Tibia`);
        tib.addComponent('render', { type: 'cylinder', material: matPal.boneMat });
        tib.setLocalScale(0.038, 0.18, 0.038);
        tib.setLocalPosition(0, -0.10, 0);
        zoneNode.addChild(tib);
        boneNodes.push(tib);
        break;
      }
    }
  }

  /**
   * Toggles optional Anatomical X-Ray Skeleton & Organ Inspector [X].
   */
  public setXRayMode(enabled: boolean): void {
    this.isXRayActive = enabled;
    this.lastMatSyncXRay = null;
    this.refreshZoneMaterialsAndAnatomy();
  }

  private refreshZoneMaterialsAndAnatomyIfDirty(): void {
    const hasGlb = this.combatantGlb !== null;
    const fracCount = this.healthState.fracturedBones.size;
    let dirty =
      this.lastMatSyncXRay !== this.isXRayActive ||
      this.lastMatSyncHasGlb !== hasGlb ||
      this.lastMatSyncGlbExpected !== this.glbExpected ||
      this.lastMatSyncFractureCount !== fracCount ||
      this.lastMatSyncWoundCount !== this.syncedSurfaceWoundCount;

    for (let i = 0; i < ALL_GHOUL_ZONES.length; i++) {
      const z = ALL_GHOUL_ZONES[i];
      const gm = this.healthState.zoneGoreMode[z];
      if (this.lastSyncedZoneGoreModes[z] !== gm) {
        this.lastSyncedZoneGoreModes[z] = gm;
        dirty = true;
      }
    }

    if (!dirty) return;

    this.lastMatSyncXRay = this.isXRayActive;
    this.lastMatSyncHasGlb = hasGlb;
    this.lastMatSyncGlbExpected = this.glbExpected;
    this.lastMatSyncFractureCount = fracCount;
    this.lastMatSyncWoundCount = this.syncedSurfaceWoundCount;
    this.refreshZoneMaterialsAndAnatomy();
  }

  private refreshZoneMaterialsAndAnatomy(): void {
    const xrayMat = this.materials.xraySkinMat;
    const isHeadPopped = this.healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';

    if (this.combatantGlb) {
      // Sculpted Blender GLB materials: X-Ray translucent shell vs Bloody Lacerated vs Intact Archetype PBR
      this.combatantGlb.setXRayVisible(this.isXRayActive);
      if (this.combatantGlb.internalAnatomyEntities.organBrain) {
        this.combatantGlb.internalAnatomyEntities.organBrain.enabled =
          this.isXRayActive && !isHeadPopped;
      }
      if (this.combatantGlb.internalAnatomyEntities.skeletSkull) {
        this.combatantGlb.internalAnatomyEntities.skeletSkull.enabled =
          isHeadPopped || this.isXRayActive;
      }

      for (const [zone, pairs] of this.glbZoneMaterialPairs) {
        const goreMode = this.healthState.zoneGoreMode[zone];
        const isBloody = goreMode === 'LACERATED' || goreMode === 'EVISCERATED';
        for (const pair of pairs) {
          pair.meshInstance.material = this.isXRayActive
            ? xrayMat
            : isBloody
              ? pair.laceratedMat
              : pair.intactMat;
        }
      }

      for (const [mi, origMat] of this.glbGearOriginalMaterials) {
        mi.material = this.isXRayActive ? xrayMat : origMat;
      }
    }

    for (const [zone, bundle] of this.zoneBundles) {
      const goreMode = this.healthState.zoneGoreMode[zone];
      const isPoppedZone =
        isHeadPopped && (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW');

      for (const b of bundle.boneNodes) {
        b.enabled = this.isXRayActive && !isPoppedZone && this.combatantGlb === null && !this.glbExpected;
        if (b.render) {
          b.render.material =
            this.healthState.fracturedBones.size > 0 && goreMode !== 'INTACT'
              ? this.materials.shatteredBoneMat
              : this.materials.boneMat;
        }
      }
      for (const o of bundle.organNodes) {
        o.enabled = this.isXRayActive && !isPoppedZone && this.combatantGlb === null && !this.glbExpected;
      }

      for (const decal of bundle.woundDecalNodes) {
        decal.enabled = !isPoppedZone && !this.isXRayActive;
      }

      if (!this.combatantGlb && !this.glbExpected) {
        for (let i = 0; i < bundle.fleshMeshInstances.length; i++) {
          const mi = bundle.fleshMeshInstances[i];
          if (this.isXRayActive) {
            mi.material = xrayMat;
          } else if (goreMode === 'LACERATED' || goreMode === 'EVISCERATED') {
            mi.material = bundle.laceratedMaterials[i] || bundle.intactMaterials[i];
          } else {
            mi.material = bundle.intactMaterials[i];
          }
        }
      }
    }
  }

  private setEntityBasisRotation(
    entity: pc.Entity,
    right: Vec3Like,
    up: Vec3Like,
    forward: Vec3Like
  ): void {
    basisToQuat(right, up, forward, this.tmpMat4, this.tmpQuat);
    entity.setLocalRotation(this.tmpQuat);
  }

  /**
   * Drives a single Blender GLB `Bone_${zone}` joint in world space from `healthState.ragdollBones[zone]`
   * using the exact bind-pose delta bijection so arbitrary Blender bone rolls/offsets cancel cleanly.
   */
  private applyRagdollBoneToGlbJoint(glb: CombatantGlbInstance, zone: GhoulZoneId): void {
    const boneNode = glb.boneNodes.get(zone);
    const bind = glb.boneBindPoses.get(zone);
    const rest = REST_RAGDOLL_FRAMES.get(zone);
    if (!boneNode || !bind || !rest) return;

    const boneState = this.healthState.ragdollBones[zone];

    // Lock Bone_HEAD_FACE_JAW rigidly to HEAD_CRANIUM's exact rigid delta unless the jaw is severed!
    if (zone === 'HEAD_FACE_JAW') {
      const headState = this.healthState.ragdollBones.HEAD_CRANIUM;
      const headRest = REST_RAGDOLL_FRAMES.get('HEAD_CRANIUM');
      if (boneState.componentId === headState.componentId && headRest) {
        basisToQuat(
          headState.basisRight,
          headState.basisUp,
          headState.basisForward,
          this.tmpMat4,
          this.tmpRagQuat
        );
        this.tmpDeltaQuat.mul2(this.tmpRagQuat, headRest.restRotInv);
        this.tmpWorldQuat.mul2(this.tmpDeltaQuat, bind.modelRot);

        this.tmpOffsetVec.sub2(bind.modelPos, headRest.restPos);
        this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);

        boneNode.setPosition(
          headState.position.x + this.tmpRotOffsetVec.x,
          headState.position.y + this.tmpRotOffsetVec.y,
          headState.position.z + this.tmpRotOffsetVec.z
        );
        boneNode.setRotation(this.tmpWorldQuat);
        return;
      }
    }

    basisToQuat(
      boneState.basisRight,
      boneState.basisUp,
      boneState.basisForward,
      this.tmpMat4,
      this.tmpRagQuat
    );

    // qDelta = qRag * restRot^-1
    this.tmpDeltaQuat.mul2(this.tmpRagQuat, rest.restRotInv);
    // qWorld = qDelta * bindRot
    this.tmpWorldQuat.mul2(this.tmpDeltaQuat, bind.modelRot);

    // pWorld = pRag + qDelta * (bindPos - restPos)
    this.tmpOffsetVec.sub2(bind.modelPos, rest.restPos);
    this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);

    boneNode.setPosition(
      boneState.position.x + this.tmpRotOffsetVec.x,
      boneState.position.y + this.tmpRotOffsetVec.y,
      boneState.position.z + this.tmpRotOffsetVec.z
    );
    boneNode.setRotation(this.tmpWorldQuat);
  }

  /**
   * Inverse of `applyRagdollBoneToGlbJoint`: aligns `bundle.zoneNode` to `combatantGlb`'s live
   * animated `Bone_${zone}` world transform so 3D bullet wound decals & bloody socket stumps
   * ride seamlessly on the animated Blender GLB with zero jump on ragdoll transition!
   */
  private alignZoneNodeFromAnimatedGlbJoint(
    glb: CombatantGlbInstance,
    zone: GhoulZoneId,
    zoneNode: pc.Entity
  ): boolean {
    const boneNode = glb.boneNodes.get(zone);
    const bind = glb.boneBindPoses.get(zone);
    const rest = REST_RAGDOLL_FRAMES.get(zone);
    if (!boneNode || !bind || !rest) return false;

    const pAnim = boneNode.getPosition();
    const qAnim = boneNode.getRotation();

    // qDelta = qAnim * bindRot^-1
    this.tmpBindInvQuat.copy(bind.modelRot).invert();
    this.tmpDeltaQuat.mul2(qAnim, this.tmpBindInvQuat);

    // qZoneWorld = qDelta * restRot
    this.tmpWorldQuat.mul2(this.tmpDeltaQuat, rest.restRot);

    // pZoneWorld = pAnim - qDelta * (bindPos - restPos)
    this.tmpOffsetVec.sub2(bind.modelPos, rest.restPos);
    this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);

    zoneNode.setLocalPosition(
      pAnim.x - this.tmpRotOffsetVec.x,
      pAnim.y - this.tmpRotOffsetVec.y,
      pAnim.z - this.tmpRotOffsetVec.z
    );
    zoneNode.setLocalRotation(this.tmpWorldQuat);
    return true;
  }

  /**
   * Spawns 3D entry/exit wound decals directly onto `zoneNode` so bullet holes & blowouts
   * stick to the sculpted Blender GLB character across animations, dismemberment, and ragdoll!
   */
  private syncSurfaceWoundDecals(): void {
    while (this.syncedSurfaceWoundCount < this.healthState.surfaceWounds.length) {
      const sw = this.healthState.surfaceWounds[this.syncedSurfaceWoundCount];
      this.syncedSurfaceWoundCount++;

      const bundle = this.zoneBundles.get(sw.zone);
      if (!bundle) continue;

      const decal = new pc.Entity(sw.id);
      decal.addComponent('render', {
        type: 'sphere',
        material: sw.armorDent
          ? this.materials.sandbagMat
          : sw.isExit
            ? this.materials.goreStumpMat
            : this.materials.woundGoreMat,
        castShadows: false,
      });

      const r = sw.radiusM * 2.0;
      decal.setLocalScale(r, r, r * 0.55);
      decal.setLocalPosition(sw.localOffset.x, sw.localOffset.y, sw.localOffset.z);
      bundle.zoneNode.addChild(decal);
      bundle.woundDecalNodes.push(decal);
    }
  }

  /**
   * Synchronizes all 22 anatomical zones, Blender GLB animations & ragdoll joints, GHOUL stumps,
   * archetype headgear, held/dropped weapons, and surface wounds every frame.
   */
  public syncFromHealthState(_dt: number, elapsedTime: number): void {
    // 1. Update procedural combat breathing / pain / crouch pose if standing & alive
    if (!this.healthState.isRagdollActive && this.healthState.alive) {
      updateStandingCombatPose(this.healthState, elapsedTime);
    }

    const isSouthpaw = this.healthState.isLeftHanded;
    const triggerHandZone: GhoulZoneId = isSouthpaw ? 'HAND_RIGHT' : 'HAND_LEFT';
    const triggerForearmZone: GhoulZoneId = isSouthpaw ? 'FOREARM_RIGHT' : 'FOREARM_LEFT';
    const triggerUpperArmZone: GhoulZoneId = isSouthpaw ? 'UPPER_ARM_RIGHT' : 'UPPER_ARM_LEFT';
    const supportHandZone: GhoulZoneId = isSouthpaw ? 'HAND_LEFT' : 'HAND_RIGHT';

    // 2. Check detached headgear transition (shoot-off helmet / beret / shades!)
    const isCranialPopped = this.healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';
    const isHeadPoppedOrSevered =
      isCranialPopped || this.healthState.severedZones.has('HEAD_CRANIUM');
    const headgearNowAttached = this.healthState.headgearIntact && !isHeadPoppedOrSevered;

    if (this.wasHeadgearIntact && !headgearNowAttached) {
      this.wasHeadgearIntact = false;
      if (this.headgearNode) {
        this.headgearNode.enabled = false;
      }
      if (this.fxManager) {
        const headBone = this.healthState.ragdollBones.HEAD_CRANIUM;
        this.fxManager.spawnDetachedHeadgearProp(
          this.healthState.archetype,
          add(headBone.position, scale(headBone.basisUp, 0.11)),
          this.healthState.activeReaction.hitDirectionWorld
        );
      }
    }

    // 3. Synchronize sculpted Blender `ghoul_combatant.glb` across ALL states (NEVER swap back to old skins!)
    const glb = this.combatantGlb;
    const isFullRagdoll = this.healthState.isRagdollActive || !this.healthState.alive;

    if (glb) {
      glb.rootEntity.enabled = true;

      const arch = this.healthState.archetype;
      const isEviscerated = this.healthState.zoneGoreMode.TORSO_LOWER_ABDOMEN === 'EVISCERATED';

      // Head & abdomen gore submesh visibility on the Blender GLB
      glb.setZoneVisible('HEAD_CRANIUM', !isCranialPopped);
      glb.setZoneVisible('HEAD_FACE_JAW', !isCranialPopped);
      glb.setZoneVisible('TORSO_LOWER_ABDOMEN', !isEviscerated || this.isXRayActive);
      if (glb.evisceratedGut) {
        glb.evisceratedGut.enabled = isEviscerated && !this.isXRayActive;
      }

      // Per-archetype modular Blender 3D armor & headgear visibility
      const showPlateCarrier =
        !this.isXRayActive &&
        (arch === 'HEAVY_ENFORCER' || arch === 'MILITIA_GUNNER' || arch === 'SNIPER_OPERATIVE');
      const showPasgtHelmet =
        !this.isXRayActive &&
        headgearNowAttached &&
        (arch === 'HEAVY_ENFORCER' || arch === 'MILITIA_GUNNER');
      const showVisor =
        !this.isXRayActive &&
        headgearNowAttached &&
        (arch === 'HEAVY_ENFORCER' || arch === 'SKINHEAD_PUNK');
      const showBeret =
        !this.isXRayActive && headgearNowAttached && arch === 'SNIPER_OPERATIVE';
      const showMohawk =
        !this.isXRayActive && !isCranialPopped && arch === 'SKINHEAD_PUNK';

      glb.setArmorVisible(showPlateCarrier, showPasgtHelmet);
      if (glb.tacticalVisor) glb.tacticalVisor.enabled = showVisor;
      if (glb.spetsnazBeret) glb.spetsnazBeret.enabled = showBeret;
      if (glb.punkMohawk) glb.punkMohawk.enabled = showMohawk;

      if (isFullRagdoll) {
        // Full Ragdoll / KIA: freeze AnimComponent and drive ALL 22 Blender bones directly from PBD ragdoll!
        if (glb.animComponent) {
          glb.animComponent.playing = false;
        }
        this.activeGlbClipKey = null;
        glb.rootEntity.setPosition(0, 0, 0);
        glb.rootEntity.setEulerAngles(0, 0, 0);

        for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
          this.applyRagdollBoneToGlbJoint(glb, zone);
        }
        glb.rootEntity.syncHierarchy();
      } else {
        // Living & Upright/Kneeling/Crawling: play right-handed or southpaw Blender NLA clip!
        if (glb.animComponent && !glb.animComponent.playing) {
          glb.animComponent.playing = true;
        }
        glb.rootEntity.setPosition(
          this.healthState.worldPosition.x,
          this.healthState.worldPosition.y,
          this.healthState.worldPosition.z
        );
        glb.rootEntity.setEulerAngles(
          0,
          (this.healthState.yawRad * 180) / Math.PI,
          0
        );

        const desiredClip: CombatantAnimationClipName =
          this.healthState.posture === 'LEG_BUCKLED'
            ? 'LegCollapseCrawl'
            : this.healthState.posture === 'GUT_HURT' ||
                this.healthState.posture === 'THROAT_CLUTCH'
              ? 'DiaphragmDropKneel'
              : this.healthState.posture === 'STAGGERED' ||
                  this.healthState.posture === 'DISARMED'
                ? 'HitStaggerChest'
                : 'CombatReadyIdle';
        const clipKey = `${desiredClip}_${isSouthpaw ? 'L' : 'R'}`;
        if (clipKey !== this.activeGlbClipKey) {
          glb.playClip(desiredClip, 0.12, 1.0, isSouthpaw);
          this.activeGlbClipKey = clipKey;
        }

        // Sync animated hierarchy first, then override ONLY severed limb subtrees so living amputees
        // keep animating their torso/legs while their severed Blender GLB limb tumbles across the floor!
        glb.rootEntity.syncHierarchy();
        if (this.healthState.severedZones.size > 0) {
          for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
            if (this.healthState.ragdollBones[zone].componentId !== 'BODY') {
              this.applyRagdollBoneToGlbJoint(glb, zone);
            }
          }
          glb.rootEntity.syncHierarchy();
        }
      }
    }

    // 4. Weapon disarm / death / ragdoll weapon drop transition & live hand attachment
    const shouldHoldWeapon =
      !this.healthState.weaponDropped &&
      this.healthState.alive &&
      !this.healthState.isRagdollActive &&
      !this.healthState.severedZones.has(triggerHandZone) &&
      !this.healthState.severedZones.has(triggerForearmZone) &&
      !this.healthState.severedZones.has(triggerUpperArmZone);

    if (this.wasWeaponHeld && !shouldHoldWeapon) {
      this.wasWeaponHeld = false;
      this.healthState.weaponDropped = true;
      if (this.heldWeaponNode) {
        this.heldWeaponNode.enabled = false;
      }
      if (this.fxManager) {
        const trigBone = this.healthState.ragdollBones[triggerHandZone];
        const glbHandNode = glb?.boneNodes.get(triggerHandZone);
        const dropPos = glbHandNode
          ? vec3(
              glbHandNode.getPosition().x,
              glbHandNode.getPosition().y,
              glbHandNode.getPosition().z
            )
          : trigBone.position;
        this.fxManager.spawnDroppedWeaponProp(
          this.healthState.archetype,
          dropPos,
          trigBone.velocity
        );
      }
    }

    if (this.heldWeaponNode) {
      this.heldWeaponNode.enabled = shouldHoldWeapon && (glb !== null || !this.glbExpected);
    }

    if (shouldHoldWeapon && this.heldWeaponNode) {
      const charFwd = vec3(
        Math.sin(this.healthState.yawRad),
        0,
        Math.cos(this.healthState.yawRad)
      );
      const weaponId = this.heldWeaponGlb?.weaponId ?? getArchetypeWeaponAssetId(this.healthState.archetype);
      const gripUpOffset =
        weaponId === 'msg90_sniper'
          ? 0.062
          : weaponId === 'm4a1_carbine'
            ? 0.056
            : 0.054;
      const gripFwdOffset =
        weaponId === 'm590_shotgun'
          ? 0.035
          : weaponId === 'm4a1_carbine'
            ? 0.018
            : 0.022;
      const forendRiseOffset =
        weaponId === 'msg90_sniper'
          ? 0.070
          : weaponId === 'm590_shotgun'
            ? 0.044
            : 0.032;

      let palmTrig: Vec3Like;
      let gunFwd: Vec3Like;

      const glbTrigNode = glb?.boneNodes.get(triggerHandZone);
      const glbSuppNode = glb?.boneNodes.get(supportHandZone);

      if (glb && glbTrigNode && glbSuppNode) {
        const pT = glbTrigNode.getPosition();
        const uT = glbTrigNode.up;
        const pS = glbSuppNode.getPosition();
        const uS = glbSuppNode.up;

        // Advance from wrist joint along hand +Y axis into actual palm grip & support cradle centers
        palmTrig = vec3(
          pT.x + uT.x * 0.052,
          pT.y + uT.y * 0.052,
          pT.z + uT.z * 0.052
        );
        const palmSupp = vec3(
          pS.x + uS.x * 0.050,
          pS.y + uS.y * 0.050,
          pS.z + uS.z * 0.050
        );

        const isOneHandedOrClutching =
          weaponId === 'silver_talon_50ae' ||
          this.healthState.archetype === 'SKINHEAD_PUNK' ||
          this.healthState.posture === 'GUT_HURT' ||
          this.healthState.posture === 'THROAT_CLUTCH' ||
          this.healthState.severedZones.has(supportHandZone);

        const aimSpan = sub(palmSupp, add(palmTrig, vec3(0, forendRiseOffset, 0)));
        if (!isOneHandedOrClutching && length(aimSpan) > 0.08) {
          gunFwd = normalize(add(scale(normalize(aimSpan), 0.88), scale(charFwd, 0.12)));
        } else {
          const handAim = vec3(uT.x, uT.y * 0.35, uT.z);
          gunFwd =
            length(handAim) > 0.15
              ? normalize(add(scale(normalize(handAim), 0.32), scale(charFwd, 0.68)))
              : normalize(charFwd);
        }
      } else {
        const handTrig = this.healthState.ragdollBones[triggerHandZone];
        const handSupp = this.healthState.ragdollBones[supportHandZone];
        const thorax = this.healthState.ragdollBones.TORSO_UPPER_THORAX;
        palmTrig = add(handTrig.position, scale(handTrig.basisForward, 0.045));
        const palmSupp = add(handSupp.position, scale(handSupp.basisForward, 0.045));
        const isOneHanded =
          weaponId === 'silver_talon_50ae' ||
          this.healthState.archetype === 'SKINHEAD_PUNK' ||
          this.healthState.severedZones.has(supportHandZone);
        const aimSpan = sub(palmSupp, add(palmTrig, vec3(0, forendRiseOffset, 0)));
        if (!isOneHanded && length(aimSpan) > 0.08) {
          gunFwd = normalize(add(scale(normalize(aimSpan), 0.82), scale(thorax.basisForward, 0.18)));
        } else {
          const inwardSign = isSouthpaw ? -0.16 : 0.16;
          gunFwd = normalize(
            add(scale(thorax.basisForward, 0.96), scale(thorax.basisRight, inwardSign))
          );
        }
      }

      const worldUp = vec3(0, 1, 0);
      if (this.heldWeaponGlb) {
        // Blender weapon GLBs have barrel along -Z, top rail along +Y, ejection port along +X,
        // and pistol grip center at local (0, -gripUpOffset, +gripFwdOffset) relative to Bone_Root!
        const zBack = scale(gunFwd, -1);
        let xRight = cross(worldUp, zBack);
        if (length(xRight) < 1e-4) xRight = vec3(1, 0, 0);
        xRight = normalize(xRight);
        const yUp = normalize(cross(zBack, xRight));
        this.heldWeaponNode.setLocalPosition(
          palmTrig.x + yUp.x * gripUpOffset + gunFwd.x * gripFwdOffset,
          palmTrig.y + yUp.y * gripUpOffset + gunFwd.y * gripFwdOffset,
          palmTrig.z + yUp.z * gripUpOffset + gunFwd.z * gripFwdOffset
        );
        this.setEntityBasisRotation(this.heldWeaponNode, xRight, yUp, zBack);
      } else {
        let gunRight = cross(worldUp, gunFwd);
        if (length(gunRight) < 1e-4) gunRight = vec3(1, 0, 0);
        gunRight = normalize(gunRight);
        const gunUp = normalize(cross(gunFwd, gunRight));
        this.heldWeaponNode.setLocalPosition(
          palmTrig.x + gunUp.x * 0.042 + gunFwd.x * 0.02,
          palmTrig.y + gunUp.y * 0.042 + gunFwd.y * 0.02,
          palmTrig.z + gunUp.z * 0.042 + gunFwd.z * 0.02
        );
        this.setEntityBasisRotation(this.heldWeaponNode, gunRight, gunUp, gunFwd);
      }
    }

    const useRetroFallback = glb === null && !this.glbExpected;
    if (this.headgearNode) {
      this.headgearNode.enabled = headgearNowAttached && useRetroFallback;
    }

    // 5. Synchronize all 22 zoneNodes (for GHOUL bloody bone stumps & 3D bullet wound decals)
    for (const zone of ALL_GHOUL_ZONES) {
      const bundle = this.zoneBundles.get(zone);
      if (!bundle) continue;

      const boneState = this.healthState.ragdollBones[zone];
      const goreMode = this.healthState.zoneGoreMode[zone];
      const isSevered = this.healthState.severedZones.has(zone);

      const alignedToAnimGlb =
        glb !== null &&
        !isFullRagdoll &&
        boneState.componentId === 'BODY' &&
        this.alignZoneNodeFromAnimatedGlbJoint(glb, zone, bundle.zoneNode);

      if (!alignedToAnimGlb) {
        const headState = this.healthState.ragdollBones.HEAD_CRANIUM;
        const headRest = REST_RAGDOLL_FRAMES.get('HEAD_CRANIUM');
        const jawRest = REST_RAGDOLL_FRAMES.get('HEAD_FACE_JAW');
        if (
          zone === 'HEAD_FACE_JAW' &&
          boneState.componentId === headState.componentId &&
          headRest &&
          jawRest
        ) {
          // Rigidly lock unsevered jaw zoneNode to HEAD_CRANIUM (0.000mm relative drift in fallback & decals)
          basisToQuat(
            headState.basisRight,
            headState.basisUp,
            headState.basisForward,
            this.tmpMat4,
            this.tmpRagQuat
          );
          this.tmpDeltaQuat.mul2(this.tmpRagQuat, headRest.restRotInv);
          this.tmpOffsetVec.sub2(jawRest.restPos, headRest.restPos);
          this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);
          bundle.zoneNode.setLocalPosition(
            headState.position.x + this.tmpRotOffsetVec.x,
            headState.position.y + this.tmpRotOffsetVec.y,
            headState.position.z + this.tmpRotOffsetVec.z
          );
          this.tmpWorldQuat.mul2(this.tmpDeltaQuat, jawRest.restRot);
          bundle.zoneNode.setLocalRotation(this.tmpWorldQuat);
        } else {
          bundle.zoneNode.setLocalPosition(
            boneState.position.x,
            boneState.position.y,
            boneState.position.z
          );
          this.setEntityBasisRotation(
            bundle.zoneNode,
            boneState.basisRight,
            boneState.basisUp,
            boneState.basisForward
          );
        }
      }

      // Legacy procedural flesh stays PERMANENTLY disabled whenever Blender GLB pipeline is active!
      if (isCranialPopped && (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW')) {
        bundle.fleshNode.enabled = false;
        if (bundle.proximalStumpNode) bundle.proximalStumpNode.enabled = false;
        continue;
      }

      bundle.fleshNode.enabled = useRetroFallback;

      if (
        useRetroFallback &&
        zone === 'TORSO_LOWER_ABDOMEN' &&
        bundle.intactAbdomenNode &&
        bundle.evisceratedAbdomenNode
      ) {
        const isEviscerated = goreMode === 'EVISCERATED';
        bundle.intactAbdomenNode.enabled = !isEviscerated;
        bundle.evisceratedAbdomenNode.enabled = isEviscerated;
      }

      // Show proximal stump cap + protruding cortical bone on detached limb root
      if (bundle.proximalStumpNode) {
        const parentZone = this.getParentZone(zone);
        const parentComp = parentZone ? this.healthState.ragdollBones[parentZone].componentId : 'BODY';
        const separatedFromParent = isSevered && boneState.componentId !== parentComp;
        bundle.proximalStumpNode.enabled = separatedFromParent;
      }

      // Show bloody parent-socket stump cap + protruding white bone whenever a child limb is severed off!
      for (const socketStump of bundle.distalChildStumps) {
        const childBone = this.healthState.ragdollBones[socketStump.childZone];
        const childPopped =
          socketStump.childZone === 'HEAD_CRANIUM' && isCranialPopped;
        socketStump.node.enabled = childPopped || childBone.componentId !== boneState.componentId;
      }
    }

    // 6. Sync 3D entry/exit bullet wound decals & zone material states
    this.syncSurfaceWoundDecals();
    this.refreshZoneMaterialsAndAnatomyIfDirty();

    // 7. Optional X-Ray Organ Pulsation when [X] Inspector is enabled
    if (this.isXRayActive && this.healthState.alive) {
      const bpmHz = (this.healthState.heartRateBpm / 60) * Math.PI * 2;
      const pulse = 1.0 + Math.sin(elapsedTime * bpmHz) * 0.10;
      const bPulse = 1.0 + Math.sin(elapsedTime * 2.5) * 0.04;
      if (glb) {
        if (glb.internalAnatomyEntities.organHeart) {
          glb.internalAnatomyEntities.organHeart.setLocalScale(pulse, pulse, pulse);
        }
        if (glb.internalAnatomyEntities.organBrain) {
          glb.internalAnatomyEntities.organBrain.setLocalScale(bPulse, bPulse, bPulse);
        }
      } else {
        if (this.heartEntity) {
          this.heartEntity.setLocalScale(0.10 * pulse, 0.11 * pulse, 0.10 * pulse);
        }
        if (this.brainEntity) {
          this.brainEntity.setLocalScale(0.12 * bPulse, 0.12 * bPulse, 0.13 * bPulse);
        }
      }
    }
  }

  private getParentZone(zone: GhoulZoneId): GhoulZoneId | undefined {
    const map: Partial<Record<GhoulZoneId, GhoulZoneId>> = {
      HEAD_CRANIUM: 'NECK_CERVICAL',
      HEAD_FACE_JAW: 'HEAD_CRANIUM',
      NECK_CERVICAL: 'TORSO_UPPER_THORAX',
      TORSO_UPPER_THORAX: 'TORSO_LOWER_ABDOMEN',
      TORSO_LOWER_ABDOMEN: 'PELVIS_GROIN',
      SHOULDER_LEFT: 'TORSO_UPPER_THORAX',
      UPPER_ARM_LEFT: 'SHOULDER_LEFT',
      FOREARM_LEFT: 'UPPER_ARM_LEFT',
      HAND_LEFT: 'FOREARM_LEFT',
      SHOULDER_RIGHT: 'TORSO_UPPER_THORAX',
      UPPER_ARM_RIGHT: 'SHOULDER_RIGHT',
      FOREARM_RIGHT: 'UPPER_ARM_RIGHT',
      HAND_RIGHT: 'FOREARM_RIGHT',
      THIGH_LEFT: 'PELVIS_GROIN',
      KNEE_LEFT: 'THIGH_LEFT',
      SHIN_LEFT: 'KNEE_LEFT',
      FOOT_LEFT: 'SHIN_LEFT',
      THIGH_RIGHT: 'PELVIS_GROIN',
      KNEE_RIGHT: 'THIGH_RIGHT',
      SHIN_RIGHT: 'KNEE_RIGHT',
      FOOT_RIGHT: 'SHIN_RIGHT',
    };
    return map[zone];
  }

  public destroy(): void {
    if (this.heldWeaponGlb) {
      this.heldWeaponGlb.destroy();
      this.heldWeaponGlb = null;
      this.heldWeaponNode = null;
    }
    if (this.combatantGlb) {
      this.combatantGlb.destroy();
      this.combatantGlb = null;
    }
    for (const m of this.clonedGlbMaterials) {
      m.destroy();
    }
    this.clonedGlbMaterials.length = 0;
    this.glbZoneMaterialPairs.clear();
    this.glbGearOriginalMaterials.clear();
    this.rootEntity.destroy();
    this.zoneBundles.clear();
  }
}
