import { describe, it, expect } from 'vitest';
import { vec3, length, distance, normalize, sub } from '../src/core/ballistics/vec3.ts';
import {
  WEAPON_MSG90,
  WEAPON_M590,
  WEAPON_SILVER_TALON,
  WEAPON_M4A1,
  AMMO_762_NATO_M118LR,
  AMMO_762_NATO_AP_TUNGSTEN,
  AMMO_12G_00_BUCK,
  AMMO_12G_FLECHETTE_SLUG,
  AMMO_50AE_JHP,
  AMMO_50AE_FMJ_SOLID,
  AMMO_556_NATO_M855,
  AMMO_556_NATO_SOST_JHP,
  DEFAULT_ENVIRONMENT,
} from '../src/core/ballistics/weapons.ts';
import {
  ALL_GHOUL_ZONES,
  GHOUL_ZONE_HIERARCHY,
  createTargetHealthState,
  getSubtreeZones,
} from '../src/core/ghoul/anatomy.ts';
import {
  stepProjectileRK4,
  simulateShot,
  applyShotReportToTarget,
  stepRagdollPhysics,
  computeBallisticZeroAimDirection,
} from '../src/core/ballistics/solver.ts';
import { EnvironmentState, ProjectileState } from '../src/contracts/ballistics.ts';

describe('GHOUL-X Realistic Ballistics, Stopping vs Penetration Power & Heavy-Body PBD Ragdoll', () => {
  describe('1. External Ballistics & Zeroing (RK4 Integration)', () => {
    it('calculates realistic 7.62 NATO bullet drop and velocity decay at 100m and 200m', () => {
      const ammo = AMMO_762_NATO_M118LR;
      const muzzleV = ammo.muzzleVelocityMs;

      let proj: ProjectileState = {
        id: 'test_bullet',
        ammo,
        position: vec3(0, 1.5, 0),
        velocity: vec3(0, 0, muzzleV),
        spinRadS: 2400,
        currentDiameterM: ammo.diameterM,
        flightTimeS: 0,
        distanceTraveledM: 0,
        kineticEnergyJ: 0.5 * ammo.massKg * muzzleV * muzzleV,
        penetratedLayers: 0,
        alive: true,
      };

      const dt = 0.001;
      let reached100m = false;
      let reached200m = false;
      let dropAt100m = 0;
      let speedAt100m = 0;
      let dropAt200m = 0;
      let speedAt200m = 0;

      while (proj.alive && proj.distanceTraveledM < 210) {
        proj = stepProjectileRK4(proj, DEFAULT_ENVIRONMENT, dt);

        if (!reached100m && proj.position.z >= 100.0) {
          reached100m = true;
          dropAt100m = 1.5 - proj.position.y;
          speedAt100m = length(proj.velocity);
        }

        if (!reached200m && proj.position.z >= 200.0) {
          reached200m = true;
          dropAt200m = 1.5 - proj.position.y;
          speedAt200m = length(proj.velocity);
        }
      }

      expect(reached100m).toBe(true);
      expect(reached200m).toBe(true);
      expect(dropAt100m).toBeGreaterThan(0.05);
      expect(dropAt100m).toBeLessThan(0.15);
      expect(speedAt100m).toBeLessThan(muzzleV);
      expect(speedAt100m).toBeGreaterThan(720);

      expect(dropAt200m).toBeGreaterThan(0.22);
      expect(dropAt200m).toBeLessThan(0.5);
      expect(speedAt200m).toBeLessThan(speedAt100m);
    });

    it('deflects bullet downwind with signed crosswind drift and zeroes accurately at 120m', () => {
      const crosswindEnv: EnvironmentState = {
        ...DEFAULT_ENVIRONMENT,
        windVelocity: vec3(8.0, 0, 0),
      };
      const target = createTargetHealthState(
        'zero_target',
        'Distant Sniper',
        vec3(0, 0, -120),
        0,
        'SNIPER_OPERATIVE'
      );
      const shooterPos = vec3(0, 1.33, 0);
      const chestPoint = vec3(-0.02, 1.33, -120);

      const zeroedAim = computeBallisticZeroAimDirection(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        shooterPos,
        chestPoint,
        crosswindEnv
      );
      const report = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        shooterPos,
        zeroedAim,
        target,
        crosswindEnv
      );

      expect(report.hitTarget).toBe(true);
      expect(Math.abs(report.windDriftAtImpactCm)).toBeGreaterThan(4.0);
    });
  });

  describe('2. Stopping Power vs Penetration Power & Armor Interaction', () => {
    it('Stopping Power JHP dumps far more energy & damage in unarmored flesh while AP over-penetrates with high exit energy', () => {
      // Unarmored flank/abdomen flesh shot (avoiding spine bone at x = 0.09)
      const jhpTarget = createTargetHealthState('unarmored_jhp', 'Punk', vec3(0, 0, -8), 0, 'SKINHEAD_PUNK');
      const apTarget = createTargetHealthState('unarmored_ap', 'Punk', vec3(0, 0, -8), 0, 'SKINHEAD_PUNK');
      const origin = vec3(0.09, 1.12, 0);
      const aimDir = normalize(sub(vec3(0.09, 1.12, -8), origin));

      const jhp50Report = simulateShot(
        WEAPON_SILVER_TALON,
        AMMO_50AE_JHP,
        origin,
        aimDir,
        jhpTarget,
        DEFAULT_ENVIRONMENT
      );
      const fmj50Report = simulateShot(
        WEAPON_SILVER_TALON,
        AMMO_50AE_FMJ_SOLID,
        origin,
        aimDir,
        apTarget,
        DEFAULT_ENVIRONMENT
      );

      expect(jhp50Report.hitTarget).toBe(true);
      expect(fmj50Report.hitTarget).toBe(true);
      expect(jhp50Report.totalEnergyDepositedJ).toBeGreaterThan(fmj50Report.totalEnergyDepositedJ * 1.4);
      expect(jhp50Report.totalDamageHp).toBeGreaterThan(fmj50Report.totalDamageHp * 1.6);

      // 5.56 77gr JHP vs 5.56 M855 Green Tip on unarmored target vs Heavy Enforcer Kevlar
      const soft556Jhp = createTargetHealthState('s1', 'Militia', vec3(0, 0, -10), 0, 'MILITIA_GUNNER');
      const soft556Pen = createTargetHealthState('s2', 'Militia', vec3(0, 0, -10), 0, 'MILITIA_GUNNER');
      const aim10 = normalize(sub(vec3(0.09, 1.12, -10), vec3(0.09, 1.12, 0)));

      const r556Jhp = simulateShot(
        WEAPON_M4A1,
        AMMO_556_NATO_SOST_JHP,
        vec3(0.09, 1.12, 0),
        aim10,
        soft556Jhp,
        DEFAULT_ENVIRONMENT
      );
      const r556Pen = simulateShot(
        WEAPON_M4A1,
        AMMO_556_NATO_M855,
        vec3(0.09, 1.12, 0),
        aim10,
        soft556Pen,
        DEFAULT_ENVIRONMENT
      );
      expect(r556Jhp.totalDamageHp).toBeGreaterThan(r556Pen.totalDamageHp * 1.5);
      // M855 over-penetrates unarmored soft tissue with substantial exit energy
      const m855LastWound = r556Pen.woundEvents[r556Pen.woundEvents.length - 1];
      expect(m855LastWound.exitEnergyJ).toBeGreaterThan(500);
    });

    it('NIJ IIIA Kevlar stops 00 Buckshot, .50 AE JHP, and 5.56 JHP while Sabot Slug, M855, and 7.62 AP perforate it', () => {
      const shooterPos = vec3(-0.02, 1.33, 0);
      const chestTargetPos = vec3(0, 0, -12);
      const aimDir = normalize(sub(vec3(-0.02, 1.33, -12), shooterPos));

      const buckTarget = createTargetHealthState('h1', 'Heavy', chestTargetPos, 0, 'HEAVY_ENFORCER');
      const jhp50Target = createTargetHealthState('h2', 'Heavy', chestTargetPos, 0, 'HEAVY_ENFORCER');
      const jhp556Target = createTargetHealthState('h3', 'Heavy', chestTargetPos, 0, 'HEAVY_ENFORCER');
      const slugTarget = createTargetHealthState('h4', 'Heavy', chestTargetPos, 0, 'HEAVY_ENFORCER');
      const m855Target = createTargetHealthState('h5', 'Heavy', chestTargetPos, 0, 'HEAVY_ENFORCER');
      const ap762Target = createTargetHealthState('h6', 'Heavy', chestTargetPos, 0, 'HEAVY_ENFORCER');

      const buckRep = simulateShot(WEAPON_M590, AMMO_12G_00_BUCK, shooterPos, aimDir, buckTarget, DEFAULT_ENVIRONMENT);
      const jhp50Rep = simulateShot(WEAPON_SILVER_TALON, AMMO_50AE_JHP, shooterPos, aimDir, jhp50Target, DEFAULT_ENVIRONMENT);
      const jhp556Rep = simulateShot(WEAPON_M4A1, AMMO_556_NATO_SOST_JHP, shooterPos, aimDir, jhp556Target, DEFAULT_ENVIRONMENT);

      expect(buckRep.woundEvents.some((w) => w.armorStopped)).toBe(true);
      expect(jhp50Rep.woundEvents.every((w) => w.armorStopped)).toBe(true);
      expect(jhp556Rep.woundEvents.every((w) => w.armorStopped)).toBe(true);

      const slugRep = simulateShot(WEAPON_M590, AMMO_12G_FLECHETTE_SLUG, shooterPos, aimDir, slugTarget, DEFAULT_ENVIRONMENT);
      const m855Rep = simulateShot(WEAPON_M4A1, AMMO_556_NATO_M855, shooterPos, aimDir, m855Target, DEFAULT_ENVIRONMENT);
      const ap762Rep = simulateShot(WEAPON_MSG90, AMMO_762_NATO_AP_TUNGSTEN, shooterPos, aimDir, ap762Target, DEFAULT_ENVIRONMENT);

      expect(slugRep.woundEvents.some((w) => w.armorStopped)).toBe(false);
      expect(slugRep.woundEvents.some((w) => w.layerType === 'CORTICAL_BONE')).toBe(true);
      expect(m855Rep.woundEvents.some((w) => w.armorStopped)).toBe(false);
      expect(ap762Rep.woundEvents.some((w) => w.armorStopped)).toBe(false);
      expect(ap762Rep.woundEvents.some((w) => w.layerType === 'ORGAN_HEART')).toBe(true);
    });

    it('femur fracture disables leg support and weapon-arm shot disarms enemy without instant death', () => {
      const target = createTargetHealthState('target_limb', 'Militia', vec3(0, 0, -6), 0);

      const rArmPos = target.ragdollBones.UPPER_ARM_RIGHT.position;
      const origin = vec3(rArmPos.x, rArmPos.y - 0.1, 0);
      const armDir = normalize(sub(vec3(rArmPos.x, rArmPos.y - 0.1, rArmPos.z), origin));
      const armReport = simulateShot(
        WEAPON_M4A1,
        AMMO_556_NATO_M855,
        origin,
        armDir,
        target,
        DEFAULT_ENVIRONMENT
      );
      expect(armReport.hitTarget).toBe(true);
      applyShotReportToTarget(target, armReport);
      expect(target.alive).toBe(true);
      expect(target.weaponDropped).toBe(true);

      const lThighPos = target.ragdollBones.THIGH_LEFT.position;
      const legOrigin = vec3(lThighPos.x, lThighPos.y - 0.14, 0);
      const legDir = normalize(sub(vec3(lThighPos.x, lThighPos.y - 0.14, lThighPos.z), legOrigin));
      const legReport = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_AP_TUNGSTEN,
        legOrigin,
        legDir,
        target,
        DEFAULT_ENVIRONMENT
      );
      expect(legReport.hitTarget).toBe(true);
      applyShotReportToTarget(target, legReport);
      expect(target.leftLegFunctional).toBe(false);
    });
  });

  describe('3. Realistic 82 kg Human Body Ragdoll Physics (1.1m Close Blast vs 20m Distant Fall)', () => {
    it('1.1m point-blank 12G shotgun blast moves an 82 kg body ~1-2m backward (no cartoon flight) with unified spine!', () => {
      const target = createTargetHealthState(
        'target_close_1m',
        'NYC Skinhead Punk',
        vec3(0, 0, -1.1),
        0,
        'SKINHEAD_PUNK'
      );

      const restEdgeLengths: Array<{
        parent: (typeof ALL_GHOUL_ZONES)[number];
        child: (typeof ALL_GHOUL_ZONES)[number];
        restLen: number;
      }> = [];
      for (const zone of ALL_GHOUL_ZONES) {
        const p = GHOUL_ZONE_HIERARCHY[zone].parent;
        if (p) {
          restEdgeLengths.push({
            parent: p,
            child: zone,
            restLen: distance(target.ragdollBones[p].position, target.ragdollBones[zone].position),
          });
        }
      }

      const shooterPos = vec3(0, 1.13, 0);
      const aimDir = normalize(sub(vec3(0, 1.13, -1.1), shooterPos));

      const report = simulateShot(
        WEAPON_M590,
        AMMO_12G_00_BUCK,
        shooterPos,
        aimDir,
        target,
        DEFAULT_ENVIRONMENT
      );

      expect(report.hitTarget).toBe(true);
      expect(report.isLethalKill).toBe(true);
      expect(report.ragdollPlan.launchLiftVelocityMs).toBeLessThan(0.6);

      applyShotReportToTarget(target, report);

      // Stomach is EVISCERATED at 1.1m point-blank, NOT detached into loose blocks
      expect(target.zoneGoreMode.TORSO_LOWER_ABDOMEN).toBe('EVISCERATED');
      expect(target.severedZones.has('TORSO_LOWER_ABDOMEN')).toBe(false);
      expect(target.ragdollBones.TORSO_LOWER_ABDOMEN.componentId).toBe('BODY');

      const initialPelvisZ = target.ragdollBones.PELVIS_GROIN.position.z;

      for (let step = 0; step < 120; step++) {
        stepRagdollPhysics(target, 0.01, 0.0);

        for (const edge of restEdgeLengths) {
          const bP = target.ragdollBones[edge.parent];
          const bC = target.ragdollBones[edge.child];
          if (bP.componentId === bC.componentId) {
            const curLen = distance(bP.position, bC.position);
            expect(Math.abs(curLen - edge.restLen)).toBeLessThan(0.03);
          }
        }
      }

      const backwardMoveM = initialPelvisZ - target.ragdollBones.PELVIS_GROIN.position.z;
      // Moves realistically ~0.9m - 2.1m from a 1.1m point-blank 12G blast — never flying 4-8m!
      expect(backwardMoveM).toBeGreaterThan(0.85);
      expect(backwardMoveM).toBeLessThan(2.2);
    });

    it('20m 12G shotgun blast and 20m rifle kill do NOT send an 82 kg body flying (collapse < 0.45m)', () => {
      // 1) 20m Shotgun shot on unarmored combatant
      const shotgunTarget20m = createTargetHealthState(
        'target_20m_buck',
        'Militia Gunner',
        vec3(0, 0, -20.0),
        0,
        'MILITIA_GUNNER'
      );
      const shooterPos = vec3(0, 1.25, 0);
      const aim20m = normalize(sub(vec3(0, 1.25, -20.0), shooterPos));

      const buck20Report = simulateShot(
        WEAPON_M590,
        AMMO_12G_00_BUCK,
        shooterPos,
        aim20m,
        shotgunTarget20m,
        DEFAULT_ENVIRONMENT
      );
      expect(buck20Report.hitTarget).toBe(true);
      expect(buck20Report.ragdollPlan.launchLiftVelocityMs).toBe(0);
      expect(buck20Report.dismembermentEvents.length).toBe(0);

      // Even if weakened so the 20m shotgun shot finishes him off, he collapses in place without flying!
      shotgunTarget20m.currentHp = 10;
      const lethalBuck20 = simulateShot(
        WEAPON_M590,
        AMMO_12G_00_BUCK,
        shooterPos,
        aim20m,
        shotgunTarget20m,
        DEFAULT_ENVIRONMENT
      );
      const startPelvisZ = shotgunTarget20m.ragdollBones.PELVIS_GROIN.position.z;
      applyShotReportToTarget(shotgunTarget20m, lethalBuck20);
      for (let step = 0; step < 120; step++) {
        stepRagdollPhysics(shotgunTarget20m, 0.01, 0.0);
      }
      const move20mBuck = Math.abs(shotgunTarget20m.ragdollBones.PELVIS_GROIN.position.z - startPelvisZ);
      expect(move20mBuck).toBeLessThan(0.45);

      // 2) 20m Rifle heart shot collapse
      const rifleTarget20m = createTargetHealthState(
        'target_20m_rifle',
        'Sniper Operative',
        vec3(0, 0, -20.0),
        0,
        'SNIPER_OPERATIVE'
      );
      const heartAim = normalize(sub(vec3(-0.02, 1.33, -20.0), vec3(-0.02, 1.33, 0)));
      const rifleRep = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        vec3(-0.02, 1.33, 0),
        heartAim,
        rifleTarget20m,
        DEFAULT_ENVIRONMENT
      );
      expect(rifleRep.isLethalKill).toBe(true);
      expect(rifleRep.ragdollPlan.launchLiftVelocityMs).toBe(0);
      const rifleStartZ = rifleTarget20m.ragdollBones.PELVIS_GROIN.position.z;
      applyShotReportToTarget(rifleTarget20m, rifleRep);
      for (let step = 0; step < 120; step++) {
        stepRagdollPhysics(rifleTarget20m, 0.01, 0.0);
      }
      const move20mRifle = Math.abs(rifleTarget20m.ragdollBones.PELVIS_GROIN.position.z - rifleStartZ);
      expect(move20mRifle).toBeLessThan(0.45);
    });
  });

  describe('4. Soldier of Fortune GHOUL Dismemberment & Subtree Separation', () => {
    it('HEAD_CRANIUM close hit with .50 AE JHP triggers CRANIAL_POP while keeping rest of body unified', () => {
      const target = createTargetHealthState('target_headshot', 'Enemy Leader', vec3(0, 0, 3), Math.PI);

      const shooterPos = vec3(0, 1.7, 0);
      const aimDir = normalize(sub(vec3(0, 1.7, 3), shooterPos));

      const report = simulateShot(
        WEAPON_SILVER_TALON,
        AMMO_50AE_JHP,
        shooterPos,
        aimDir,
        target,
        DEFAULT_ENVIRONMENT
      );

      expect(report.hitTarget).toBe(true);
      expect(report.isLethalKill).toBe(true);

      const headPop = report.dismembermentEvents.find((d) => d.goreMode === 'CRANIAL_POP');
      expect(headPop).toBeDefined();
      expect(report.severedZones).toContain('HEAD_CRANIUM');
      expect(report.severedZones).toContain('HEAD_FACE_JAW');

      applyShotReportToTarget(target, report);
      expect(target.zoneGoreMode.HEAD_CRANIUM).toBe('CRANIAL_POP');
      expect(target.ragdollBones.TORSO_UPPER_THORAX.componentId).toBe('BODY');
      expect(target.ragdollBones.THIGH_LEFT.componentId).toBe('BODY');
      expect(target.ragdollBones.UPPER_ARM_LEFT.componentId).toBe('BODY');
    });

    it('Close-range 12G blast to UPPER_ARM_LEFT triggers CLEAN_SEVER detaching arm subtree as one connected limb', () => {
      const armSubtree = getSubtreeZones('UPPER_ARM_LEFT');
      expect(armSubtree).toEqual(['UPPER_ARM_LEFT', 'FOREARM_LEFT', 'HAND_LEFT']);

      const target = createTargetHealthState('target_arm', 'Rifleman', vec3(0, 0, 2.5), 0);
      const armWorldPos = vec3(-0.29, 1.28, 2.5);
      const shooterPos = vec3(-0.29, 1.28, 0);
      const aimDir = normalize(sub(armWorldPos, shooterPos));

      const report = simulateShot(
        WEAPON_M590,
        AMMO_12G_00_BUCK,
        shooterPos,
        aimDir,
        target,
        DEFAULT_ENVIRONMENT
      );

      expect(report.hitTarget).toBe(true);
      const armSever = report.dismembermentEvents.find((d) => d.zone === 'UPPER_ARM_LEFT');
      expect(armSever).toBeDefined();
      expect(armSever!.goreMode).toBe('CLEAN_SEVER');
      expect(armSever!.detachedSubtree).toEqual(['UPPER_ARM_LEFT', 'FOREARM_LEFT', 'HAND_LEFT']);

      const restForearmLen = distance(
        target.ragdollBones.UPPER_ARM_LEFT.position,
        target.ragdollBones.FOREARM_LEFT.position
      );

      applyShotReportToTarget(target, report);
      expect(target.ragdollBones.UPPER_ARM_LEFT.componentId).toBe('SEVERED_UPPER_ARM_LEFT');
      expect(target.ragdollBones.FOREARM_LEFT.componentId).toBe('SEVERED_UPPER_ARM_LEFT');
      expect(target.ragdollBones.HAND_LEFT.componentId).toBe('SEVERED_UPPER_ARM_LEFT');
      expect(target.ragdollBones.SHOULDER_LEFT.componentId).toBe('BODY');

      for (let i = 0; i < 40; i++) {
        stepRagdollPhysics(target, 0.01, 0.0);
      }
      const postForearmLen = distance(
        target.ragdollBones.UPPER_ARM_LEFT.position,
        target.ragdollBones.FOREARM_LEFT.position
      );
      expect(Math.abs(postForearmLen - restForearmLen)).toBeLessThan(0.02);
    });
  });
});
