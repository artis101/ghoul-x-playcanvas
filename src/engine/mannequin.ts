import * as pc from 'playcanvas';
import {
  GhoulZoneId,
  TargetHealthState,
  GoreMode,
} from '../contracts/ballistics.ts';
import {
  ALL_GHOUL_ZONES,
  GHOUL_ZONE_HIERARCHY,
  buildAnatomicalColliders,
} from '../core/ghoul/anatomy.ts';
import { EngineMaterialPalette } from './materials.ts';

export interface ZoneMeshBundle {
  zone: GhoulZoneId;
  zoneNode: pc.Entity;
  fleshNode: pc.Entity;
  fleshRenders: pc.RenderComponent[];
  defaultMaterials: pc.StandardMaterial[];
  boneNodes: pc.Entity[];
  boneLabels: string[];
  organNodes: pc.Entity[];
  stumpNode?: pc.Entity;
  boneProtrusionNode?: pc.Entity;
  childStumps: Map<GhoulZoneId, { stump: pc.Entity; bone: pc.Entity }>;
}

/**
 * Class GhoulMannequinEntity represents an articulated 22-zone enemy mannequin in PlayCanvas.
 * Supports:
 * - Full 22-zone kinematic and ragdoll bone updates
 * - Procedural outer tactical / skin flesh meshes
 * - Internal 3D skeleton (skull, ribs, spine, pelvis, humerus, femur, tibia)
 * - Beating 3D heart, lungs, brain, aorta/carotid arteries
 * - Early-2000s Soldier of Fortune clean sever stump caps & bone marrow protrusions
 * - X-Ray Mode: switches outer flesh to translucent cyan/blue rim silhouetted xraySkinMat
 * - Cranial pop: hides head mesh and shows jagged cranial stump on cervical neck
 */
export class GhoulMannequinEntity {
  public readonly rootEntity: pc.Entity;
  public readonly healthState: TargetHealthState;
  public readonly app: pc.AppBase;
  public readonly materials: EngineMaterialPalette;

  private zoneBundles: Map<GhoulZoneId, ZoneMeshBundle> = new Map();
  private isXRayActive = false;
  private highlightedZone: GhoulZoneId | null = null;
  private heartEntity: pc.Entity | null = null;
  private brainEntity: pc.Entity | null = null;

  constructor(
    app: pc.AppBase,
    healthState: TargetHealthState,
    materials: EngineMaterialPalette
  ) {
    this.app = app;
    this.healthState = healthState;
    this.materials = materials;

    this.rootEntity = new pc.Entity(`Mannequin_${healthState.targetId}`);
    this.rootEntity.setPosition(
      healthState.worldPosition.x,
      healthState.worldPosition.y,
      healthState.worldPosition.z
    );
    this.rootEntity.setEulerAngles(0, (healthState.yawRad * 180) / Math.PI, 0);

    this.buildMannequin();
  }

  private buildMannequin(): void {
    const colliders = buildAnatomicalColliders();
    const collidersByZone = new Map<GhoulZoneId, typeof colliders>();
    for (const c of colliders) {
      if (!collidersByZone.has(c.ghoulZone)) {
        collidersByZone.set(c.ghoulZone, []);
      }
      collidersByZone.get(c.ghoulZone)!.push(c);
    }

    for (const zone of ALL_GHOUL_ZONES) {
      const boneState = this.healthState.ragdollBones[zone];
      const zoneColliders = collidersByZone.get(zone) || [];
      const boneLabels = zoneColliders
        .filter((c) => c.layerType === 'CORTICAL_BONE')
        .map((c) => c.label);

      const zoneNode = new pc.Entity(`Zone_${zone}`);
      this.rootEntity.addChild(zoneNode);
      zoneNode.setPosition(boneState.position.x, boneState.position.y, boneState.position.z);
      zoneNode.setEulerAngles(
        (boneState.rotationEuler.x * 180) / Math.PI,
        (boneState.rotationEuler.y * 180) / Math.PI,
        (boneState.rotationEuler.z * 180) / Math.PI
      );

      const fleshNode = new pc.Entity(`Flesh_${zone}`);
      zoneNode.addChild(fleshNode);

      const fleshRenders: pc.RenderComponent[] = [];
      const defaultMaterials: pc.StandardMaterial[] = [];
      const boneNodes: pc.Entity[] = [];
      const organNodes: pc.Entity[] = [];

      // 1. Outer Flesh / Tactical Meshes
      this.buildZoneOuterMesh(zone, fleshNode, fleshRenders, defaultMaterials);

      // 2. Internal 3D Skeleton & Organs
      this.buildZoneInternalAnatomy(zone, zoneNode, boneNodes, organNodes);

      // 3. Bloody Stump Cap & Protruding Bone (on severed limb root + parent-side joint caps)
      const { stumpNode, boneProtrusionNode, childStumps } = this.buildGoreCapNodes(
        zone,
        zoneNode
      );

      this.zoneBundles.set(zone, {
        zone,
        zoneNode,
        fleshNode,
        fleshRenders,
        defaultMaterials,
        boneNodes,
        boneLabels,
        organNodes,
        stumpNode,
        boneProtrusionNode,
        childStumps,
      });
    }
  }

  private buildZoneOuterMesh(
    zone: GhoulZoneId,
    fleshNode: pc.Entity,
    fleshRenders: pc.RenderComponent[],
    defaultMaterials: pc.StandardMaterial[]
  ): void {
    const matPal = this.materials;

    switch (zone) {
      case 'HEAD_CRANIUM': {
        const head = new pc.Entity('HeadCraniumMesh');
        head.addComponent('render', {
          type: 'sphere',
          material: matPal.skinTone,
        });
        head.setLocalScale(0.2, 0.22, 0.22);
        head.setLocalPosition(0, 0.05, 0);
        fleshNode.addChild(head);
        if (head.render) {
          fleshRenders.push(head.render);
          defaultMaterials.push(matPal.skinTone);
        }
        break;
      }

      case 'HEAD_FACE_JAW': {
        const jaw = new pc.Entity('FaceMesh');
        jaw.addComponent('render', {
          type: 'box',
          material: matPal.tacticalOlive,
        });
        jaw.setLocalScale(0.16, 0.12, 0.12);
        jaw.setLocalPosition(0, 0, 0.02);
        fleshNode.addChild(jaw);
        if (jaw.render) {
          fleshRenders.push(jaw.render);
          defaultMaterials.push(matPal.tacticalOlive);
        }
        break;
      }

      case 'NECK_CERVICAL': {
        const neck = new pc.Entity('NeckMesh');
        neck.addComponent('render', {
          type: 'cylinder',
          material: matPal.skinTone,
        });
        neck.setLocalScale(0.12, 0.12, 0.12);
        fleshNode.addChild(neck);
        if (neck.render) {
          fleshRenders.push(neck.render);
          defaultMaterials.push(matPal.skinTone);
        }
        break;
      }

      case 'TORSO_UPPER_THORAX': {
        const chest = new pc.Entity('ChestVestMesh');
        chest.addComponent('render', {
          type: 'box',
          material: matPal.tacticalArmorVest,
        });
        chest.setLocalScale(0.36, 0.28, 0.26);
        fleshNode.addChild(chest);
        if (chest.render) {
          fleshRenders.push(chest.render);
          defaultMaterials.push(matPal.tacticalArmorVest);
        }
        break;
      }

      case 'TORSO_LOWER_ABDOMEN': {
        const gut = new pc.Entity('AbdomenMesh');
        gut.addComponent('render', {
          type: 'box',
          material: matPal.tacticalOlive,
        });
        gut.setLocalScale(0.32, 0.2, 0.24);
        fleshNode.addChild(gut);
        if (gut.render) {
          fleshRenders.push(gut.render);
          defaultMaterials.push(matPal.tacticalOlive);
        }
        break;
      }

      case 'PELVIS_GROIN': {
        const pelvis = new pc.Entity('PelvisMesh');
        pelvis.addComponent('render', {
          type: 'box',
          material: matPal.tacticalOlive,
        });
        pelvis.setLocalScale(0.34, 0.18, 0.24);
        fleshNode.addChild(pelvis);
        if (pelvis.render) {
          fleshRenders.push(pelvis.render);
          defaultMaterials.push(matPal.tacticalOlive);
        }
        break;
      }

      case 'SHOULDER_LEFT':
      case 'SHOULDER_RIGHT': {
        const shoulder = new pc.Entity(`${zone}_Mesh`);
        shoulder.addComponent('render', {
          type: 'sphere',
          material: matPal.tacticalOlive,
        });
        shoulder.setLocalScale(0.15, 0.15, 0.15);
        fleshNode.addChild(shoulder);
        if (shoulder.render) {
          fleshRenders.push(shoulder.render);
          defaultMaterials.push(matPal.tacticalOlive);
        }
        break;
      }

      case 'UPPER_ARM_LEFT':
      case 'UPPER_ARM_RIGHT': {
        const arm = new pc.Entity(`${zone}_Mesh`);
        arm.addComponent('render', {
          type: 'cylinder',
          material: matPal.tacticalOlive,
        });
        arm.setLocalScale(0.12, 0.24, 0.12);
        arm.setLocalPosition(0, -0.1, 0);
        fleshNode.addChild(arm);
        if (arm.render) {
          fleshRenders.push(arm.render);
          defaultMaterials.push(matPal.tacticalOlive);
        }
        break;
      }

      case 'FOREARM_LEFT':
      case 'FOREARM_RIGHT': {
        const forearm = new pc.Entity(`${zone}_Mesh`);
        forearm.addComponent('render', {
          type: 'cylinder',
          material: matPal.skinTone,
        });
        forearm.setLocalScale(0.09, 0.22, 0.09);
        forearm.setLocalPosition(0, -0.1, 0);
        fleshNode.addChild(forearm);
        if (forearm.render) {
          fleshRenders.push(forearm.render);
          defaultMaterials.push(matPal.skinTone);
        }
        break;
      }

      case 'HAND_LEFT':
      case 'HAND_RIGHT': {
        const hand = new pc.Entity(`${zone}_Mesh`);
        hand.addComponent('render', {
          type: 'box',
          material: matPal.bootsDark,
        });
        hand.setLocalScale(0.08, 0.1, 0.05);
        hand.setLocalPosition(0, -0.04, 0);
        fleshNode.addChild(hand);
        if (hand.render) {
          fleshRenders.push(hand.render);
          defaultMaterials.push(matPal.bootsDark);
        }
        break;
      }

      case 'THIGH_LEFT':
      case 'THIGH_RIGHT': {
        const thigh = new pc.Entity(`${zone}_Mesh`);
        thigh.addComponent('render', {
          type: 'cylinder',
          material: matPal.tacticalOlive,
        });
        thigh.setLocalScale(0.16, 0.3, 0.16);
        thigh.setLocalPosition(0, -0.14, 0);
        fleshNode.addChild(thigh);
        if (thigh.render) {
          fleshRenders.push(thigh.render);
          defaultMaterials.push(matPal.tacticalOlive);
        }
        break;
      }

      case 'KNEE_LEFT':
      case 'KNEE_RIGHT': {
        const knee = new pc.Entity(`${zone}_Mesh`);
        knee.addComponent('render', {
          type: 'sphere',
          material: matPal.bootsDark,
        });
        knee.setLocalScale(0.12, 0.12, 0.12);
        fleshNode.addChild(knee);
        if (knee.render) {
          fleshRenders.push(knee.render);
          defaultMaterials.push(matPal.bootsDark);
        }
        break;
      }

      case 'SHIN_LEFT':
      case 'SHIN_RIGHT': {
        const shin = new pc.Entity(`${zone}_Mesh`);
        shin.addComponent('render', {
          type: 'cylinder',
          material: matPal.tacticalOlive,
        });
        shin.setLocalScale(0.12, 0.28, 0.12);
        shin.setLocalPosition(0, -0.12, 0);
        fleshNode.addChild(shin);
        if (shin.render) {
          fleshRenders.push(shin.render);
          defaultMaterials.push(matPal.tacticalOlive);
        }
        break;
      }

      case 'FOOT_LEFT':
      case 'FOOT_RIGHT': {
        const foot = new pc.Entity(`${zone}_Mesh`);
        foot.addComponent('render', {
          type: 'box',
          material: matPal.bootsDark,
        });
        foot.setLocalScale(0.1, 0.08, 0.22);
        foot.setLocalPosition(0, -0.04, 0.04);
        fleshNode.addChild(foot);
        if (foot.render) {
          fleshRenders.push(foot.render);
          defaultMaterials.push(matPal.bootsDark);
        }
        break;
      }
    }
  }

  private buildZoneInternalAnatomy(
    zone: GhoulZoneId,
    zoneNode: pc.Entity,
    boneNodes: pc.Entity[],
    organNodes: pc.Entity[]
  ): void {
    const matPal = this.materials;

    switch (zone) {
      case 'HEAD_CRANIUM': {
        // Skull Bone
        const skull = new pc.Entity('SkullBone');
        skull.addComponent('render', {
          type: 'sphere',
          material: matPal.boneMat,
        });
        skull.setLocalScale(0.17, 0.17, 0.19);
        skull.setLocalPosition(0, 0.04, 0);
        zoneNode.addChild(skull);
        boneNodes.push(skull);

        // Brain Organ
        const brain = new pc.Entity('BrainOrgan');
        brain.addComponent('render', {
          type: 'sphere',
          material: matPal.brainMat,
        });
        brain.setLocalScale(0.13, 0.13, 0.14);
        brain.setLocalPosition(0, 0.04, -0.01);
        zoneNode.addChild(brain);
        organNodes.push(brain);
        this.brainEntity = brain;
        break;
      }

      case 'HEAD_FACE_JAW': {
        const jawBone = new pc.Entity('JawBone');
        jawBone.addComponent('render', {
          type: 'box',
          material: matPal.boneMat,
        });
        jawBone.setLocalScale(0.12, 0.08, 0.09);
        jawBone.setLocalPosition(0, 0, 0.02);
        zoneNode.addChild(jawBone);
        boneNodes.push(jawBone);
        break;
      }

      case 'NECK_CERVICAL': {
        const cervicalSpine = new pc.Entity('CervicalSpine');
        cervicalSpine.addComponent('render', {
          type: 'cylinder',
          material: matPal.boneMat,
        });
        cervicalSpine.setLocalScale(0.05, 0.11, 0.05);
        cervicalSpine.setLocalPosition(0, 0, -0.02);
        zoneNode.addChild(cervicalSpine);
        boneNodes.push(cervicalSpine);

        const carotid = new pc.Entity('CarotidArtery');
        carotid.addComponent('render', {
          type: 'cylinder',
          material: matPal.arteryMat,
        });
        carotid.setLocalScale(0.03, 0.1, 0.03);
        carotid.setLocalPosition(0.02, 0, 0.02);
        zoneNode.addChild(carotid);
        organNodes.push(carotid);
        break;
      }

      case 'TORSO_UPPER_THORAX': {
        // Ribcage bone frame
        const ribcage = new pc.Entity('RibcageBone');
        ribcage.addComponent('render', {
          type: 'box',
          material: matPal.boneMat,
        });
        ribcage.setLocalScale(0.32, 0.26, 0.22);
        zoneNode.addChild(ribcage);
        boneNodes.push(ribcage);

        // Heart
        const heart = new pc.Entity('HeartOrgan');
        heart.addComponent('render', {
          type: 'sphere',
          material: matPal.heartMat,
        });
        heart.setLocalScale(0.12, 0.13, 0.12);
        heart.setLocalPosition(-0.03, -0.01, 0.02);
        zoneNode.addChild(heart);
        organNodes.push(heart);
        this.heartEntity = heart;

        // Lungs
        const lungL = new pc.Entity('LeftLung');
        lungL.addComponent('render', {
          type: 'box',
          material: matPal.lungMat,
        });
        lungL.setLocalScale(0.09, 0.18, 0.11);
        lungL.setLocalPosition(-0.09, 0, 0.01);
        zoneNode.addChild(lungL);
        organNodes.push(lungL);

        const lungR = new pc.Entity('RightLung');
        lungR.addComponent('render', {
          type: 'box',
          material: matPal.lungMat,
        });
        lungR.setLocalScale(0.09, 0.18, 0.11);
        lungR.setLocalPosition(0.09, 0, 0.01);
        zoneNode.addChild(lungR);
        organNodes.push(lungR);

        // Aorta
        const aorta = new pc.Entity('AortaTube');
        aorta.addComponent('render', {
          type: 'cylinder',
          material: matPal.arteryMat,
        });
        aorta.setLocalScale(0.04, 0.16, 0.04);
        aorta.setLocalPosition(0.01, 0, -0.03);
        zoneNode.addChild(aorta);
        organNodes.push(aorta);
        break;
      }

      case 'TORSO_LOWER_ABDOMEN': {
        // Lumbar Spine
        const lumbar = new pc.Entity('LumbarSpine');
        lumbar.addComponent('render', {
          type: 'cylinder',
          material: matPal.boneMat,
        });
        lumbar.setLocalScale(0.06, 0.18, 0.06);
        lumbar.setLocalPosition(0, 0, -0.05);
        zoneNode.addChild(lumbar);
        boneNodes.push(lumbar);

        // Liver
        const liver = new pc.Entity('LiverOrgan');
        liver.addComponent('render', {
          type: 'sphere',
          material: matPal.liverGutMat,
        });
        liver.setLocalScale(0.12, 0.1, 0.11);
        liver.setLocalPosition(0.07, 0.02, 0.02);
        zoneNode.addChild(liver);
        organNodes.push(liver);

        // Stomach / Guts
        const guts = new pc.Entity('GutsOrgan');
        guts.addComponent('render', {
          type: 'box',
          material: matPal.liverGutMat,
        });
        guts.setLocalScale(0.14, 0.12, 0.12);
        guts.setLocalPosition(-0.04, -0.02, 0.02);
        zoneNode.addChild(guts);
        organNodes.push(guts);
        break;
      }

      case 'PELVIS_GROIN': {
        const pelvisBone = new pc.Entity('PelvisBone');
        pelvisBone.addComponent('render', {
          type: 'box',
          material: matPal.boneMat,
        });
        pelvisBone.setLocalScale(0.3, 0.16, 0.18);
        zoneNode.addChild(pelvisBone);
        boneNodes.push(pelvisBone);
        break;
      }

      case 'UPPER_ARM_LEFT':
      case 'UPPER_ARM_RIGHT': {
        const humerus = new pc.Entity(`${zone}_Humerus`);
        humerus.addComponent('render', {
          type: 'cylinder',
          material: matPal.boneMat,
        });
        humerus.setLocalScale(0.04, 0.22, 0.04);
        humerus.setLocalPosition(0, -0.1, 0);
        zoneNode.addChild(humerus);
        boneNodes.push(humerus);
        break;
      }

      case 'FOREARM_LEFT':
      case 'FOREARM_RIGHT': {
        const ulna = new pc.Entity(`${zone}_UlnaRadius`);
        ulna.addComponent('render', {
          type: 'cylinder',
          material: matPal.boneMat,
        });
        ulna.setLocalScale(0.035, 0.2, 0.035);
        ulna.setLocalPosition(0, -0.1, 0);
        zoneNode.addChild(ulna);
        boneNodes.push(ulna);
        break;
      }

      case 'THIGH_LEFT':
      case 'THIGH_RIGHT': {
        const femur = new pc.Entity(`${zone}_Femur`);
        femur.addComponent('render', {
          type: 'cylinder',
          material: matPal.boneMat,
        });
        femur.setLocalScale(0.05, 0.28, 0.05);
        femur.setLocalPosition(0, -0.14, 0);
        zoneNode.addChild(femur);
        boneNodes.push(femur);
        break;
      }

      case 'SHIN_LEFT':
      case 'SHIN_RIGHT': {
        const tibia = new pc.Entity(`${zone}_Tibia`);
        tibia.addComponent('render', {
          type: 'cylinder',
          material: matPal.boneMat,
        });
        tibia.setLocalScale(0.045, 0.26, 0.045);
        tibia.setLocalPosition(0, -0.12, 0);
        zoneNode.addChild(tibia);
        boneNodes.push(tibia);
        break;
      }
    }
  }

  private buildGoreCapNodes(
    zone: GhoulZoneId,
    zoneNode: pc.Entity
  ): {
    stumpNode?: pc.Entity;
    boneProtrusionNode?: pc.Entity;
    childStumps: Map<GhoulZoneId, { stump: pc.Entity; bone: pc.Entity }>;
  } {
    const matPal = this.materials;
    const childStumps = new Map<GhoulZoneId, { stump: pc.Entity; bone: pc.Entity }>();
    const hierNode = GHOUL_ZONE_HIERARCHY[zone];

    // Build parent-side bloody stump caps & protruding cortical bone at each child joint offset
    for (const childZone of hierNode.children) {
      const childHier = GHOUL_ZONE_HIERARCHY[childZone];
      const ox = childHier.jointLocalPos.x - hierNode.jointLocalPos.x;
      const oy = childHier.jointLocalPos.y - hierNode.jointLocalPos.y;
      const oz = childHier.jointLocalPos.z - hierNode.jointLocalPos.z;

      const stump = new pc.Entity(`${zone}_ChildStump_${childZone}`);
      stump.addComponent('render', {
        type: 'cylinder',
        material: matPal.goreStumpMat,
      });
      stump.setLocalScale(0.11, 0.03, 0.11);
      stump.setLocalPosition(ox, oy, oz);
      stump.enabled = false;
      zoneNode.addChild(stump);

      const bone = new pc.Entity(`${zone}_ChildBone_${childZone}`);
      bone.addComponent('render', {
        type: 'cylinder',
        material: matPal.exposedBoneMat,
      });
      bone.setLocalScale(0.038, 0.07, 0.038);
      bone.setLocalPosition(ox, oy + 0.02, oz);
      bone.enabled = false;
      zoneNode.addChild(bone);

      childStumps.set(childZone, { stump, bone });
    }

    // Build cap on severable limbs themselves (visible at the cut end of the flying limb)
    const severableZones = new Set<GhoulZoneId>([
      'HEAD_CRANIUM',
      'NECK_CERVICAL',
      'SHOULDER_LEFT',
      'SHOULDER_RIGHT',
      'UPPER_ARM_LEFT',
      'UPPER_ARM_RIGHT',
      'FOREARM_LEFT',
      'FOREARM_RIGHT',
      'HAND_LEFT',
      'HAND_RIGHT',
      'THIGH_LEFT',
      'THIGH_RIGHT',
      'KNEE_LEFT',
      'KNEE_RIGHT',
      'SHIN_LEFT',
      'SHIN_RIGHT',
      'FOOT_LEFT',
      'FOOT_RIGHT',
    ]);

    if (!severableZones.has(zone)) {
      return { childStumps };
    }

    const stumpNode = new pc.Entity(`${zone}_StumpCap`);
    stumpNode.addComponent('render', {
      type: 'cylinder',
      material: matPal.goreStumpMat,
    });
    stumpNode.setLocalScale(0.11, 0.03, 0.11);
    stumpNode.enabled = false;
    zoneNode.addChild(stumpNode);

    const boneProtrusionNode = new pc.Entity(`${zone}_ExposedBone`);
    boneProtrusionNode.addComponent('render', {
      type: 'cylinder',
      material: matPal.exposedBoneMat,
    });
    boneProtrusionNode.setLocalScale(0.035, 0.06, 0.035);
    boneProtrusionNode.setLocalPosition(0, 0.02, 0);
    boneProtrusionNode.enabled = false;
    zoneNode.addChild(boneProtrusionNode);

    return { stumpNode, boneProtrusionNode, childStumps };
  }

  /**
   * Toggles anatomical X-Ray silhouette view mode.
   * In X-Ray mode, outer flesh is rendered translucent with cyan/blue rim emission.
   */
  public setXRayMode(enabled: boolean, highlightZone: GhoulZoneId | null = null): void {
    this.isXRayActive = enabled;
    this.highlightedZone = highlightZone;

    const xrayMat = this.materials.xraySkinMat;
    const woundMat = this.materials.woundGoreMat;

    for (const [zone, bundle] of this.zoneBundles) {
      const isSevered = this.healthState.severedZones.has(zone);
      if (isSevered) continue;

      for (let i = 0; i < bundle.fleshRenders.length; i++) {
        const render = bundle.fleshRenders[i];
        if (enabled) {
          render.material = xrayMat;
        } else {
          // Restore tactical material or wound tint
          const goreMode = this.healthState.zoneGoreMode[zone];
          if (goreMode === 'EVISCERATED' || goreMode === 'LACERATED') {
            render.material = woundMat;
          } else {
            render.material = bundle.defaultMaterials[i] || this.materials.tacticalOlive;
          }
        }
      }
    }
  }

  /**
   * Synchronizes 3D mesh transforms and visibility from TargetHealthState.
   */
  public syncFromHealthState(dt: number, elapsedTime: number): void {
    const isAlive = this.healthState.alive;
    const isRagdoll = this.healthState.isRagdollActive;
    const isHeadPopped =
      this.healthState.zoneGoreMode['HEAD_CRANIUM'] === 'CRANIAL_POP' ||
      this.healthState.zoneGoreMode['HEAD_FACE_JAW'] === 'CRANIAL_POP';

    // 1. Idle stance sway & tactical breathing if intact and alive
    let idleBreathY = 0;
    let idleSwayX = 0;
    if (!isRagdoll && isAlive) {
      idleBreathY = Math.sin(elapsedTime * 2.5) * 0.008;
      idleSwayX = Math.cos(elapsedTime * 1.2) * 0.006;
    }

    // 2. Synchronize each of the 22 zone nodes
    for (const zone of ALL_GHOUL_ZONES) {
      const bundle = this.zoneBundles.get(zone);
      if (!bundle) continue;

      const boneState = this.healthState.ragdollBones[zone];
      const isSevered = this.healthState.severedZones.has(zone);
      const goreMode = this.healthState.zoneGoreMode[zone];

      // Update position and rotation
      let wx = boneState.position.x;
      let wy = boneState.position.y;
      let wz = boneState.position.z;

      if (!isRagdoll && isAlive) {
        if (zone === 'TORSO_UPPER_THORAX' || zone === 'NECK_CERVICAL' || zone === 'HEAD_CRANIUM') {
          wy += idleBreathY;
          wx += idleSwayX;
        }
      }

      bundle.zoneNode.setPosition(wx, wy, wz);
      bundle.zoneNode.setEulerAngles(
        (boneState.rotationEuler.x * 180) / Math.PI,
        (boneState.rotationEuler.y * 180) / Math.PI,
        (boneState.rotationEuler.z * 180) / Math.PI
      );

      // Handle gore mode / severing visuals
      if (isHeadPopped && (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW')) {
        // Upper head obliterated into gibs; bloody stump stays on parent NECK_CERVICAL
        bundle.fleshNode.enabled = false;
        for (const b of bundle.boneNodes) b.enabled = false;
        for (const o of bundle.organNodes) o.enabled = false;
        if (bundle.stumpNode) bundle.stumpNode.enabled = false;
        if (bundle.boneProtrusionNode) bundle.boneProtrusionNode.enabled = false;
        for (const cs of bundle.childStumps.values()) {
          cs.stump.enabled = false;
          cs.bone.enabled = false;
        }
      } else if (isSevered) {
        // Detached limb segment flying/tumbling on floor: show cut cap only on the severed root joint
        bundle.fleshNode.enabled = true;
        const isSeverRoot = goreMode === 'CLEAN_SEVER' || goreMode === 'EVISCERATED';
        if (bundle.stumpNode) bundle.stumpNode.enabled = isSeverRoot;
        if (bundle.boneProtrusionNode) bundle.boneProtrusionNode.enabled = isSeverRoot;
        for (const [childZone, cs] of bundle.childStumps) {
          const childIndependentlySevered =
            this.healthState.zoneGoreMode[childZone] !== 'INTACT' &&
            this.healthState.severedZones.has(childZone);
          cs.stump.enabled = childIndependentlySevered;
          cs.bone.enabled = childIndependentlySevered;
        }
      } else {
        bundle.fleshNode.enabled = true;
        if (bundle.stumpNode) bundle.stumpNode.enabled = false;
        if (bundle.boneProtrusionNode) bundle.boneProtrusionNode.enabled = false;

        // Show bloody stump & protruding marrow on this intact parent joint for any severed direct child!
        for (const [childZone, cs] of bundle.childStumps) {
          const childSevered = this.healthState.severedZones.has(childZone);
          cs.stump.enabled = childSevered;
          cs.bone.enabled = childSevered;
        }

        // Apply wound tint in normal view when zone is lacerated or eviscerated
        if (!this.isXRayActive && (goreMode === 'LACERATED' || goreMode === 'EVISCERATED')) {
          for (const render of bundle.fleshRenders) {
            render.material = this.materials.woundGoreMat;
          }
        }

        // Highlight ONLY bones belonging to this specific zone that were fractured
        const hasZoneFracture = bundle.boneLabels.some((lbl) =>
          this.healthState.fracturedBones.has(lbl)
        );
        if (hasZoneFracture) {
          for (const bNode of bundle.boneNodes) {
            if (bNode.render) {
              bNode.render.material = this.materials.shatteredBoneMat;
            }
          }
        }
      }
    }

    // 3. Heart rate pulsation
    if (this.heartEntity && isAlive) {
      // Beating heart: 80 bpm = 1.33 Hz
      const pulse = 1.0 + Math.sin(elapsedTime * 8.3) * 0.12;
      this.heartEntity.setLocalScale(0.12 * pulse, 0.13 * pulse, 0.12 * pulse);
    }

    // 4. Brain rhythmic cranial pulsation
    if (this.brainEntity && isAlive) {
      const brainPulse = 1.0 + Math.sin(elapsedTime * 2.5) * 0.04;
      this.brainEntity.setLocalScale(0.13 * brainPulse, 0.13 * brainPulse, 0.14 * brainPulse);
    }
  }

  /**
   * Cleans up resources when mannequin is destroyed.
   */
  public destroy(): void {
    this.rootEntity.destroy();
    this.zoneBundles.clear();
  }
}
