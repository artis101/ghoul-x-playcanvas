import * as pc from 'playcanvas';
import { describe, expect, it } from 'vitest';
import { AmmoSpec, GhoulZoneId } from '../src/contracts/ballistics.ts';
import { applyShotReportToTarget, simulateShot } from '../src/core/ballistics/solver.ts';
import { add, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_50AE_FMJ_SOLID,
  AMMO_556_NATO_M855,
  DEFAULT_ENVIRONMENT,
  WEAPON_M4A1,
  WEAPON_SILVER_TALON,
} from '../src/core/ballistics/weapons.ts';
import {
  ALL_GHOUL_ZONES,
  createTargetHealthState,
  LEFT_HANDED_PROBABILITY,
  updateStandingCombatPose,
} from '../src/core/ghoul/anatomy.ts';
import { COMBATANT_ANIMATION_CLIPS, GlbModelRegistry } from '../src/engine/assets/glbLoader.ts';
import { GoreAndBallisticsFxManager } from '../src/engine/goreFx.ts';
import { GhoulMannequinEntity } from '../src/engine/mannequin.ts';
import { getOrCreateMaterials } from '../src/engine/materials.ts';

describe('Blender combatant runtime', () => {
  it('enforces ~87.5% right-handed / 12.5% southpaw probability, handedness-aware wound clutching, and trigger-hand disarm', () => {
    expect(LEFT_HANDED_PROBABILITY).toBeGreaterThanOrEqual(0.10);
    expect(LEFT_HANDED_PROBABILITY).toBeLessThanOrEqual(0.15);

    // Deterministic Monte Carlo check over 2,000 draws using LCG
    let seed = 0x5f3759df;
    let southpawCount = 0;
    const totalSamples = 2000;
    for (let i = 0; i < totalSamples; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const u = seed / 0x100000000;
      if (u < LEFT_HANDED_PROBABILITY) {
        southpawCount++;
      }
    }
    const empiricalRate = southpawCount / totalSamples;
    expect(empiricalRate).toBeGreaterThan(0.09);
    expect(empiricalRate).toBeLessThan(0.16);

    // Right-handed default (isLeftHanded = false) vs Southpaw (isLeftHanded = true) wound clutching
    const rhTarget = createTargetHealthState('rh_test', 'RightHanded', vec3(0, 0, 0), 0, 'MILITIA_GUNNER', false);
    const lhTarget = createTargetHealthState('lh_test', 'Southpaw', vec3(0, 0, 0), 0, 'MILITIA_GUNNER', true);
    expect(rhTarget.isLeftHanded).toBe(false);
    expect(lhTarget.isLeftHanded).toBe(true);

    rhTarget.posture = 'THROAT_CLUTCH';
    lhTarget.posture = 'THROAT_CLUTCH';
    updateStandingCombatPose(rhTarget, 1.0);
    updateStandingCombatPose(lhTarget, 1.0);

    // Facing +Z: a right-hander holds the gun in HAND_RIGHT (-X) and clutches the throat with HAND_LEFT (+X);
    // a southpaw holds the gun in HAND_LEFT (+X) and clutches the throat with HAND_RIGHT (-X).
    expect(rhTarget.ragdollBones.HAND_LEFT.position.y).toBeGreaterThan(1.48);
    expect(rhTarget.ragdollBones.HAND_RIGHT.position.y).toBeLessThan(1.38);
    expect(lhTarget.ragdollBones.HAND_RIGHT.position.y).toBeGreaterThan(1.48);
    expect(lhTarget.ragdollBones.HAND_LEFT.position.y).toBeLessThan(1.38);

    // Trigger-hand disarm: moderate ~190 J pistol round into HAND_RIGHT disarms right-handed (trigger hand)
    // without severing, leaving southpaw (whose trigger hand is HAND_LEFT) still holding their weapon!
    const lightPistolAmmo: AmmoSpec = {
      ...AMMO_556_NATO_M855,
      id: '9mm_subsonic_test',
      massKg: 0.008,
      diameterM: 0.009,
      muzzleVelocityMs: 225, // ~202 J muzzle energy (>65 J disarm, well below hand severing threshold)
      tissueExpansionFactor: 1.35,
      goreFactor: 0.5,
    };
    const rhDisarmTest = createTargetHealthState('rh_disarm', 'RH', vec3(0, 0, -4), 0, 'SKINHEAD_PUNK', false);
    const lhDisarmTest = createTargetHealthState('lh_disarm', 'LH', vec3(0, 0, -4), 0, 'SKINHEAD_PUNK', true);

    const handRightTargetPt = rhDisarmTest.ragdollBones.HAND_RIGHT.position;
    const muzzleRightOrigin = add(handRightTargetPt, vec3(0, 0, 1.2));
    const aimToHandRight = normalize(sub(handRightTargetPt, muzzleRightOrigin));

    const rhReport = simulateShot(
      WEAPON_M4A1,
      lightPistolAmmo,
      muzzleRightOrigin,
      aimToHandRight,
      rhDisarmTest,
      DEFAULT_ENVIRONMENT
    );
    applyShotReportToTarget(rhDisarmTest, rhReport);

    const lhOffhandReport = simulateShot(
      WEAPON_M4A1,
      lightPistolAmmo,
      muzzleRightOrigin,
      aimToHandRight,
      lhDisarmTest,
      DEFAULT_ENVIRONMENT
    );
    applyShotReportToTarget(lhDisarmTest, lhOffhandReport);

    expect(rhReport.hitTarget).toBe(true);
    expect(lhOffhandReport.hitTarget).toBe(true);
    expect(rhDisarmTest.weaponDropped).toBe(true);
    expect(lhDisarmTest.weaponDropped).toBe(false);

    // Hitting HAND_LEFT disarms the southpaw combatant!
    const handLeftTargetPt = lhDisarmTest.ragdollBones.HAND_LEFT.position;
    const muzzleLeftOrigin = add(handLeftTargetPt, vec3(0, 0, 1.2));
    const aimToHandLeft = normalize(sub(handLeftTargetPt, muzzleLeftOrigin));
    const lhTriggerReport = simulateShot(
      WEAPON_M4A1,
      lightPistolAmmo,
      muzzleLeftOrigin,
      aimToHandLeft,
      lhDisarmTest,
      DEFAULT_ENVIRONMENT
    );
    applyShotReportToTarget(lhDisarmTest, lhTriggerReport);
    expect(lhTriggerReport.hitTarget).toBe(true);
    expect(lhDisarmTest.weaponDropped).toBe(true);
  });

  it('keeps sculpted Blender GLB combatant, headgear & weapon models active across LACERATED, EVISCERATED, CRANIAL_POP, living dismemberment & KIA ragdoll with ZERO swap back to old retro skins', () => {
    const canvasStub = { width: 640, height: 480 };
    const device = new pc.NullGraphicsDevice(canvasStub);
    const app = new pc.Application(canvasStub as unknown as HTMLCanvasElement, {
      graphicsDevice: device,
    });

    try {
      const refRest = createTargetHealthState('__bind_ref__', 'BindRef', vec3(0, 0, 0), 0);
      const parentOf: Partial<Record<GhoulZoneId, GhoulZoneId>> = {
        TORSO_LOWER_ABDOMEN: 'PELVIS_GROIN',
        TORSO_UPPER_THORAX: 'TORSO_LOWER_ABDOMEN',
        NECK_CERVICAL: 'TORSO_UPPER_THORAX',
        HEAD_CRANIUM: 'NECK_CERVICAL',
        HEAD_FACE_JAW: 'HEAD_CRANIUM',
        SHOULDER_RIGHT: 'TORSO_UPPER_THORAX',
        UPPER_ARM_RIGHT: 'SHOULDER_RIGHT',
        FOREARM_RIGHT: 'UPPER_ARM_RIGHT',
        HAND_RIGHT: 'FOREARM_RIGHT',
        SHOULDER_LEFT: 'TORSO_UPPER_THORAX',
        UPPER_ARM_LEFT: 'SHOULDER_LEFT',
        FOREARM_LEFT: 'UPPER_ARM_LEFT',
        HAND_LEFT: 'FOREARM_LEFT',
        THIGH_RIGHT: 'PELVIS_GROIN',
        KNEE_RIGHT: 'THIGH_RIGHT',
        SHIN_RIGHT: 'KNEE_RIGHT',
        FOOT_RIGHT: 'SHIN_RIGHT',
        THIGH_LEFT: 'PELVIS_GROIN',
        KNEE_LEFT: 'THIGH_LEFT',
        SHIN_LEFT: 'KNEE_LEFT',
        FOOT_LEFT: 'SHIN_LEFT',
      };

      const unitBoxMesh = pc.Mesh.fromGeometry(device, new pc.BoxGeometry());
      const makeRenderSubmesh = (name: string): pc.Entity => {
        const ent = new pc.Entity(name);
        const mat = new pc.StandardMaterial();
        mat.name = `Mat_${name}`;
        mat.diffuse = new pc.Color(0.35, 0.38, 0.32);
        mat.update();
        ent.addComponent('render', {
          meshInstances: [new pc.MeshInstance(unitBoxMesh, mat)],
        });
        return ent;
      };

      const animAssets: Array<pc.Asset> = [];
      for (const baseClip of COMBATANT_ANIMATION_CLIPS) {
        for (const clipName of [baseClip, `${baseClip}_Southpaw`]) {
          const track = new pc.AnimTrack(clipName, 1.2, [], [], []);
          const a = new pc.Asset(clipName, 'animation');
          a.resource = track;
          animAssets.push(a);
        }
      }

      const combatantContainer: pc.ContainerResource = {
        renders: [],
        materials: [],
        textures: [],
        animations: animAssets as pc.ContainerResource['animations'],
        gsplats: [],
        instantiateModelEntity: () => new pc.Entity('UnusedModel'),
        instantiateRenderEntity: () => {
          const root = new pc.Entity('GhoulCombatantTemplate');
          const armature = new pc.Entity('GhoulArmature');
          root.addChild(armature);

          const boneMap = new Map<GhoulZoneId, pc.Entity>();
          for (const zone of ALL_GHOUL_ZONES) {
            const b = new pc.Entity(`Bone_${zone}`);
            boneMap.set(zone, b);
          }
          for (const zone of ALL_GHOUL_ZONES) {
            const b = boneMap.get(zone)!;
            const pZone = parentOf[zone];
            const restPos = refRest.ragdollBones[zone].position;
            if (pZone) {
              const pPos = refRest.ragdollBones[pZone].position;
              boneMap.get(pZone)!.addChild(b);
              b.setLocalPosition(restPos.x - pPos.x, restPos.y - pPos.y, restPos.z - pPos.z);
            } else {
              armature.addChild(b);
              b.setLocalPosition(restPos.x, restPos.y, restPos.z);
            }
          }

          for (const zone of ALL_GHOUL_ZONES) {
            root.addChild(makeRenderSubmesh(`Zone_${zone}`));
          }
          for (const extra of [
            'Gear_ESAPI_PlateCarrier',
            'Gear_PASGT_Helmet',
            'Gear_TacticalVisor',
            'Gear_BoonieHat',
            'Gear_PunkMohawk',
            'Gear_EvisceratedGut',
            'Organ_Brain',
            'Organ_Heart',
            'Organ_Lungs',
            'Organ_Liver',
            'Skelet_Skull',
            'Skelet_RibcageSpine',
            'Skelet_Pelvis',
          ]) {
            root.addChild(makeRenderSubmesh(extra));
          }
          return root;
        },
        getMaterialVariants: () => [],
        applyMaterialVariant: () => {},
        applyMaterialVariantInstances: () => {},
      };

      const makeWeaponContainer = (label: string): pc.ContainerResource => ({
        renders: [],
        materials: [],
        textures: [],
        animations: [],
        gsplats: [],
        instantiateModelEntity: () => new pc.Entity('UnusedWeaponModel'),
        instantiateRenderEntity: () => {
          const wRoot = new pc.Entity(label);
          wRoot.addChild(makeRenderSubmesh(`${label}_Receiver`));
          const muzzle = new pc.Entity('Bone_Muzzle');
          muzzle.setLocalPosition(0, 0.015, -0.58);
          wRoot.addChild(muzzle);
          return wRoot;
        },
        getMaterialVariants: () => [],
        applyMaterialVariant: () => {},
        applyMaterialVariantInstances: () => {},
      });

      const glbRegistry = new GlbModelRegistry(app);
      glbRegistry.registerContainerResource('ghoul_combatant', combatantContainer);
      glbRegistry.registerContainerResource('m4a1_carbine', makeWeaponContainer('M4A1_GLB'));
      glbRegistry.registerContainerResource('m590_shotgun', makeWeaponContainer('M590_GLB'));
      glbRegistry.registerContainerResource('msg90_sniper', makeWeaponContainer('MSG90_GLB'));
      glbRegistry.registerContainerResource('silver_talon_50ae', makeWeaponContainer('SilverTalon_GLB'));

      const materials = getOrCreateMaterials();
      const fxManager = new GoreAndBallisticsFxManager(app, materials, glbRegistry);

      const assertZeroLegacyFleshEnabled = (m: GhoulMannequinEntity, phaseLabel: string): void => {
        expect(m.combatantGlb, `${phaseLabel}: combatantGlb present`).not.toBeNull();
        expect(m.combatantGlb!.rootEntity.enabled, `${phaseLabel}: GLB rootEntity MUST stay enabled`).toBe(true);
        for (const zone of ALL_GHOUL_ZONES) {
          const legacyFlesh = m.rootEntity.findByName(`Flesh_${zone}`) as pc.Entity | null;
          expect(legacyFlesh, `${phaseLabel}: Flesh_${zone} node must be null`).toBeNull();
        }
        const legacyHeadgear = m.rootEntity.findByName('Headgear_HEAVY_ENFORCER') as pc.Entity | null;
        expect(legacyHeadgear, `${phaseLabel}: Legacy headgear must be null`).toBeNull();
      };

      // Verify Southpaw sniper selects *_Southpaw animation & Spetsnaz beret
      const southpawSniperState = createTargetHealthState(
        'sp_sniper',
        'Southpaw Sniper',
        vec3(2, 0, -10),
        0,
        'SNIPER_OPERATIVE',
        true
      );
      const southpawMannequin = new GhoulMannequinEntity(
        app,
        southpawSniperState,
        materials,
        fxManager,
        glbRegistry
      );
      app.root.addChild(southpawMannequin.rootEntity);
      expect(southpawMannequin.combatantGlb!.boonieHat!.enabled).toBe(true);
      expect(southpawMannequin.combatantGlb!.pasgtHelmet!.enabled).toBe(false);
      expect(southpawMannequin.combatantGlb!.animComponent!.baseLayer!.activeState).toBe(
        'CombatReadyIdle_Southpaw'
      );
      assertZeroLegacyFleshEnabled(southpawMannequin, 'Southpaw Intact');

      // Verify Right-Handed Heavy Enforcer through EVERY gore, dismemberment & KIA transition!
      const enforcerState = createTargetHealthState(
        'rh_enforcer',
        'Heavy Enforcer',
        vec3(-1.5, 0, -8),
        0,
        'HEAVY_ENFORCER',
        false
      );
      const mannequin = new GhoulMannequinEntity(app, enforcerState, materials, fxManager, glbRegistry);
      app.root.addChild(mannequin.rootEntity);

      expect(mannequin.combatantGlb!.animComponent!.baseLayer!.activeState).toBe('CombatReadyIdle');
      expect(mannequin.combatantGlb!.esapiPlateCarrier!.enabled).toBe(true);
      expect(mannequin.combatantGlb!.pasgtHelmet!.enabled).toBe(true);
      expect(mannequin.combatantGlb!.tacticalVisor!.enabled).toBe(true);
      assertZeroLegacyFleshEnabled(mannequin, '1. Healthy Intact');

      // Phase 2: LACERATED + EVISCERATED gut cavity (must stay on Blender GLB, enabling Gear_EvisceratedGut!)
      enforcerState.zoneGoreMode.TORSO_UPPER_THORAX = 'LACERATED';
      enforcerState.zoneGoreMode.TORSO_LOWER_ABDOMEN = 'EVISCERATED';
      enforcerState.posture = 'GUT_HURT';
      mannequin.syncFromHealthState(0.016, 0.5);
      expect(mannequin.combatantGlb!.evisceratedGut!.enabled).toBe(true);
      assertZeroLegacyFleshEnabled(mannequin, '2. Lacerated & Eviscerated');

      // Phase 3: LIVING DISMEMBERMENT — sever entire right trigger arm (.50 AE blowoff) while target is STILL ALIVE!
      const upperArmPos = enforcerState.ragdollBones.UPPER_ARM_RIGHT.position;
      const armOrigin = add(upperArmPos, vec3(0.0, 0.0, 0.8));
      const armAimDir = normalize(sub(add(upperArmPos, vec3(-0.08, 0, -0.2)), armOrigin));
      const severArmAmmo: AmmoSpec = {
        ...AMMO_50AE_FMJ_SOLID,
        tissueExpansionFactor: 2.8,
        goreFactor: 2.5,
      };
      const armReport = simulateShot(
        WEAPON_SILVER_TALON,
        severArmAmmo,
        armOrigin,
        armAimDir,
        enforcerState,
        DEFAULT_ENVIRONMENT
      );
      applyShotReportToTarget(enforcerState, armReport);
      expect(enforcerState.severedZones.has('UPPER_ARM_RIGHT')).toBe(true);
      expect(enforcerState.alive).toBe(true);

      // Move detached arm component 2.4m away across the arena floor
      for (const z of ['UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 'HAND_RIGHT'] as const) {
        enforcerState.ragdollBones[z].position.x -= 2.4;
        enforcerState.ragdollBones[z].position.y = 0.08;
      }
      mannequin.syncFromHealthState(0.016, 1.0);

      // Living amputee MUST still render sculpted GLB (zero swap to old skin!), keep AnimComponent playing for BODY,
      // move Bone_UPPER_ARM_RIGHT in world space to match the severed ragdoll limb, and spawn GLB dropped weapon prop!
      assertZeroLegacyFleshEnabled(mannequin, '3. Living Limb Dismemberment');
      expect(mannequin.combatantGlb!.animComponent!.playing).toBe(true);
      const glbSeveredArmPos = mannequin.combatantGlb!.boneNodes.get('UPPER_ARM_RIGHT')!.getPosition();
      expect(glbSeveredArmPos.x).toBeCloseTo(enforcerState.ragdollBones.UPPER_ARM_RIGHT.position.x, 2);
      expect(glbSeveredArmPos.y).toBeCloseTo(0.08, 2);
      expect(fxManager.fxRoot.findByName('M590_GLB_Receiver')).not.toBeNull();

      // Phase 4: CRANIAL_POP + Headgear Shoot-Off + Lethal KIA Full Ragdoll + Severed Leg!
      enforcerState.headgearIntact = false;
      enforcerState.zoneGoreMode.HEAD_CRANIUM = 'CRANIAL_POP';
      enforcerState.severedZones.add('THIGH_RIGHT');
      enforcerState.ragdollBones.THIGH_RIGHT.componentId = 'LIMB_LEG';
      enforcerState.ragdollBones.THIGH_RIGHT.position = vec3(-3.2, 0.12, -8.5);
      enforcerState.alive = false;
      enforcerState.isRagdollActive = true;
      enforcerState.ragdollBones.PELVIS_GROIN.position = vec3(-1.5, 0.14, -8.9);

      mannequin.syncFromHealthState(0.016, 1.5);

      assertZeroLegacyFleshEnabled(mannequin, '4. Cranial Pop + KIA Full Ragdoll');
      expect(mannequin.combatantGlb!.animComponent!.playing).toBe(false);
      expect(mannequin.combatantGlb!.zoneEntities.get('HEAD_CRANIUM')!.enabled).toBe(false);
      expect(mannequin.combatantGlb!.internalAnatomyEntities.skeletSkull!.enabled).toBe(true);
      expect(mannequin.combatantGlb!.pasgtHelmet!.enabled).toBe(false);
      expect(mannequin.combatantGlb!.tacticalVisor!.enabled).toBe(false);
      expect(fxManager.fxRoot.findByName('DetachedHeadgear_HEAVY_ENFORCER')).not.toBeNull();

      const glbPelvisPos = mannequin.combatantGlb!.boneNodes.get('PELVIS_GROIN')!.getPosition();
      expect(glbPelvisPos.y).toBeCloseTo(0.14, 2);
      const glbSeveredThighPos = mannequin.combatantGlb!.boneNodes.get('THIGH_RIGHT')!.getPosition();
      expect(glbSeveredThighPos.x).toBeCloseTo(-3.2, 2);

      southpawMannequin.destroy();
      mannequin.destroy();
      fxManager.clearAll();
    } finally {
      app.destroy();
    }
  });
});
