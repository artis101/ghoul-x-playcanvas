import * as pc from 'playcanvas';
import {
  GhoulZoneId,
  TargetHealthState,
} from '../contracts/ballistics.ts';
import {
  ALL_GHOUL_ZONES,
  updateStandingCombatPose,
} from '../core/ghoul/anatomy.ts';
import { add, cross, length, normalize, scale } from '../core/ballistics/vec3.ts';
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
  boneNodes: pc.Entity[];
  organNodes: pc.Entity[];
  proximalStumpNode?: pc.Entity;
  distalChildStumps: ChildSocketStump[];
  intactAbdomenNode?: pc.Entity;
  evisceratedAbdomenNode?: pc.Entity;
}

/**
 * Class GhoulMannequinEntity renders an authentic 1998–2001 PS1/PS2 / Soldier of Fortune (2000)
 * sculpted low-poly combatant driven by a 22-zone PBD articulated ragdoll skeleton.
 *
 * Features:
 * - Faceted low-poly anatomy with 64x64 nearest-neighbor Bayer-dithered pixel-art textures
 * - 4 distinct enemy archetypes (NYC Skinhead Punk, Balkan Militia Gunner, Kosovo Heavy Enforcer, Spetsnaz Sniper)
 * - Shootable detachable headgear (helmets, berets, shades, watch-caps) & droppable 3D weapons (MP5, AK-47, 12G, SVD)
 * - Soldier of Fortune GHOUL gore: localized lacerated bloody textures, 3D entry/exit wound decals,
 *   parent-socket + detached-limb bloody stumps with protruding white cortical bone, CRANIAL_POP,
 *   and non-detaching EVISCERATED open-stomach wounds
 * - Full 3D quaternion alignment from orthonormal bone basis vectors (zero joint gaps or gimbal lock)
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
  private wasHeadgearIntact = true;
  private wasWeaponHeld = true;
  private syncedSurfaceWoundCount = 0;

  private isXRayActive = false;
  private heartEntity: pc.Entity | null = null;
  private brainEntity: pc.Entity | null = null;

  private readonly tmpMat4 = new pc.Mat4();
  private readonly tmpQuat = new pc.Quat();

  constructor(
    app: pc.AppBase,
    healthState: TargetHealthState,
    materials: EngineMaterialPalette,
    fxManager?: GoreAndBallisticsFxManager
  ) {
    this.app = app;
    this.healthState = healthState;
    this.materials = materials;
    this.fxManager = fxManager;
    this.retroMats = getArchetypeRetroMaterials(app.graphicsDevice, healthState.archetype);

    // Keep rootEntity at world origin (0,0,0) identity so every zoneNode uses exact world-space coordinates
    this.rootEntity = new pc.Entity(`Combatant_${healthState.targetId}`);
    this.rootEntity.setPosition(0, 0, 0);
    this.rootEntity.setEulerAngles(0, 0, 0);

    this.buildCombatant();
    this.syncFromHealthState(0, 0);
  }

  private buildCombatant(): void {
    for (const zone of ALL_GHOUL_ZONES) {
      const zoneNode = new pc.Entity(`Zone_${zone}`);
      this.rootEntity.addChild(zoneNode);

      const fleshNode = new pc.Entity(`Flesh_${zone}`);
      zoneNode.addChild(fleshNode);

      const fleshMeshInstances: pc.MeshInstance[] = [];
      const intactMaterials: pc.StandardMaterial[] = [];
      const laceratedMaterials: pc.StandardMaterial[] = [];
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
        boneNodes,
        organNodes,
        proximalStumpNode,
        distalChildStumps,
        intactAbdomenNode,
        evisceratedAbdomenNode,
      });
    }

    // Build held 3D PS1/PS2 firearm (MP5, AK-47, Combat 12G, or SVD Dragunov)
    this.heldWeaponNode = buildEnemyWeaponEntity(
      this.app.graphicsDevice,
      this.healthState.archetype,
      this.retroMats
    );
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

        // Tactical 3D chest rig mag pouches (for armed military/SWAT archetypes)
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

        // Soldier of Fortune EVISCERATED stomach wound group (toggled on heavy gut blast without breaking spine!)
        const evisceratedAbdomenNode = new pc.Entity('AbdomenEvisceratedGroup');
        evisceratedAbdomenNode.enabled = false;
        fleshNode.addChild(evisceratedAbdomenNode);

        const outerCrater = new pc.Entity('AbdomenGoreShell');
        attachCustomMesh(outerCrater, lib.abdomenEvisceratedOuter, rm.abdomenBloodyMat, true);
        evisceratedAbdomenNode.addChild(outerCrater);

        // Deep wet crimson visceral cavity inside hollowed gut
        const gutCore = new pc.Entity('VisceralGutCore');
        gutCore.addComponent('render', {
          type: 'box',
          material: this.materials.goreStumpMat,
        });
        gutCore.setLocalScale(0.20, 0.14, 0.11);
        gutCore.setLocalPosition(0, 0.085, 0.032);
        evisceratedAbdomenNode.addChild(gutCore);

        // Jagged white lower rib tips framing top of stomach crater
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

        // Hanging glistening entrail coils
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

        // Right hip sidearm/utility pouch & rear canteen pouch
        const sideHolster = addPart(
          'HipHolster',
          lib.ammoPouch,
          rm.pouchWebbingMat,
          rm.pelvisBloodyMat
        );
        sideHolster.setLocalPosition(0.168, 0.05, 0.01);
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
   * Builds internal 3D skeleton & organs for optional [X] Anatomical X-Ray Inspector mode.
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
    this.refreshZoneMaterialsAndAnatomy();
  }

  private refreshZoneMaterialsAndAnatomy(): void {
    const xrayMat = this.materials.xraySkinMat;

    for (const [zone, bundle] of this.zoneBundles) {
      const goreMode = this.healthState.zoneGoreMode[zone];
      const isPoppedHead =
        goreMode === 'CRANIAL_POP' && (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW');

      for (const b of bundle.boneNodes) {
        b.enabled = this.isXRayActive && !isPoppedHead;
        if (b.render) {
          b.render.material =
            this.healthState.fracturedBones.size > 0 && goreMode !== 'INTACT'
              ? this.materials.shatteredBoneMat
              : this.materials.boneMat;
        }
      }
      for (const o of bundle.organNodes) {
        o.enabled = this.isXRayActive && !isPoppedHead;
      }

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

  private setEntityBasisRotation(
    entity: pc.Entity,
    right: { x: number; y: number; z: number },
    up: { x: number; y: number; z: number },
    forward: { x: number; y: number; z: number }
  ): void {
    const d = this.tmpMat4.data;
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

    this.tmpQuat.setFromMat4(this.tmpMat4);
    entity.setLocalRotation(this.tmpQuat);
  }

  /**
   * Spawns 3D entry/exit wound decals directly onto hit bones so bullet holes & blowouts stick to the character!
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
      bundle.fleshNode.addChild(decal);
    }
  }

  /**
   * Synchronizes all 22 low-poly anatomical zones, GHOUL stumps, headgear, weapons, and wounds every frame.
   */
  public syncFromHealthState(_dt: number, elapsedTime: number): void {
    // 1. Update procedural combat breathing / pain / crouch pose if standing & alive
    if (!this.healthState.isRagdollActive && this.healthState.alive) {
      updateStandingCombatPose(this.healthState, elapsedTime);
    }

    // 2. Check detached headgear transition (shoot-off helmet / beret / shades!)
    const isHeadPoppedOrSevered =
      this.healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP' ||
      this.healthState.severedZones.has('HEAD_CRANIUM');
    const headgearNowAttached = this.healthState.headgearIntact && !isHeadPoppedOrSevered;

    if (this.wasHeadgearIntact && !headgearNowAttached) {
      this.wasHeadgearIntact = false;
      if (this.headgearNode) {
        this.headgearNode.enabled = false;
      }
      if (this.fxManager && this.healthState.zoneGoreMode.HEAD_CRANIUM !== 'CRANIAL_POP') {
        const headBone = this.healthState.ragdollBones.HEAD_CRANIUM;
        this.fxManager.spawnDetachedHeadgearProp(
          this.healthState.archetype,
          add(headBone.position, scale(headBone.basisUp, 0.11)),
          this.healthState.activeReaction.hitDirectionWorld
        );
      }
    }

    // 3. Check weapon disarm / death / ragdoll weapon drop transition!
    const shouldHoldWeapon =
      !this.healthState.weaponDropped &&
      this.healthState.alive &&
      !this.healthState.isRagdollActive &&
      !this.healthState.severedZones.has('HAND_RIGHT') &&
      !this.healthState.severedZones.has('FOREARM_RIGHT') &&
      !this.healthState.severedZones.has('UPPER_ARM_RIGHT');

    if (this.wasWeaponHeld && !shouldHoldWeapon) {
      this.wasWeaponHeld = false;
      this.healthState.weaponDropped = true;
      if (this.heldWeaponNode) {
        this.heldWeaponNode.enabled = false;
      }
      if (this.fxManager) {
        const handR = this.healthState.ragdollBones.HAND_RIGHT;
        this.fxManager.spawnDroppedWeaponProp(
          this.healthState.archetype,
          handR.position,
          handR.velocity
        );
      }
    }

    // Orient held weapon in combatant's hands when active
    if (shouldHoldWeapon && this.heldWeaponNode) {
      const handR = this.healthState.ragdollBones.HAND_RIGHT;
      const thorax = this.healthState.ragdollBones.TORSO_UPPER_THORAX;
      this.heldWeaponNode.setLocalPosition(handR.position.x, handR.position.y, handR.position.z);

      // Barrel aims forward across chest toward player (+Forward slightly angled inward)
      const gunFwd = normalize(
        add(scale(thorax.basisForward, 0.94), scale(thorax.basisRight, -0.26))
      );
      const gunRight = normalize(cross(thorax.basisUp, gunFwd));
      const gunUp = normalize(cross(gunFwd, gunRight));
      this.setEntityBasisRotation(this.heldWeaponNode, gunRight, gunUp, gunFwd);
    }

    // 4. Synchronize all 22 anatomical bone nodes via full 3D orthonormal basis quaternions
    for (const zone of ALL_GHOUL_ZONES) {
      const bundle = this.zoneBundles.get(zone);
      if (!bundle) continue;

      const boneState = this.healthState.ragdollBones[zone];
      const goreMode = this.healthState.zoneGoreMode[zone];
      const isSevered = this.healthState.severedZones.has(zone);

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

      // Cranial pop obliterates upper head & jaw while leaving bloody stump on NECK_CERVICAL
      if (goreMode === 'CRANIAL_POP' && (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW')) {
        bundle.fleshNode.enabled = false;
        if (bundle.proximalStumpNode) bundle.proximalStumpNode.enabled = false;
        continue;
      }

      bundle.fleshNode.enabled = true;

      // Toggle intact vs eviscerated open-stomach cavity on TORSO_LOWER_ABDOMEN
      if (zone === 'TORSO_LOWER_ABDOMEN' && bundle.intactAbdomenNode && bundle.evisceratedAbdomenNode) {
        const isEviscerated = goreMode === 'EVISCERATED';
        bundle.intactAbdomenNode.enabled = !isEviscerated;
        bundle.evisceratedAbdomenNode.enabled = isEviscerated;
      }

      // Show proximal stump cap on detached limb root (where its component separated from its parent!)
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
          socketStump.childZone === 'HEAD_CRANIUM' &&
          this.healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';
        socketStump.node.enabled = childPopped || childBone.componentId !== boneState.componentId;
      }
    }

    // 5. Sync 3D entry/exit bullet wound decals & lacerated pixel-art textures
    this.syncSurfaceWoundDecals();
    this.refreshZoneMaterialsAndAnatomy();

    // 6. Optional X-Ray Organ Pulsation when [X] Inspector is enabled
    if (this.isXRayActive && this.healthState.alive) {
      const bpmHz = (this.healthState.heartRateBpm / 60) * Math.PI * 2;
      if (this.heartEntity) {
        const pulse = 1.0 + Math.sin(elapsedTime * bpmHz) * 0.12;
        this.heartEntity.setLocalScale(0.10 * pulse, 0.11 * pulse, 0.10 * pulse);
      }
      if (this.brainEntity) {
        const bPulse = 1.0 + Math.sin(elapsedTime * 2.5) * 0.04;
        this.brainEntity.setLocalScale(0.12 * bPulse, 0.12 * bPulse, 0.13 * bPulse);
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
    this.rootEntity.destroy();
    this.zoneBundles.clear();
  }
}
