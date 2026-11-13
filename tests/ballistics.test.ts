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
  computeCombatantTriageStatus,
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

    it('rifle plate stops buckshot, pistol rounds, ball, JHP and slugs; only 7.62 tungsten AP perforates it', () => {
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

      expect(slugRep.woundEvents.every((w) => w.armorStopped)).toBe(true);
      expect(m855Rep.woundEvents.every((w) => w.armorStopped)).toBe(true);
      expect(ap762Rep.woundEvents.some((w) => w.armorStopped)).toBe(false);
      expect(ap762Rep.woundEvents.some((w) => w.layerType === 'ORGAN_HEART')).toBe(true);
    });

    it('femur fracture disables leg support, an upper-arm wound is fought through, a grip-hand hit disarms', () => {
      const target = createTargetHealthState('target_limb', 'Militia', vec3(0, 0, -6), 0);

      const rArmPos = target.ragdollBones.UPPER_ARM_LEFT.position;
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
      expect(target.weaponDropped).toBe(false);

      const gripPos = target.ragdollBones.HAND_RIGHT.position;
      const gripOrigin = vec3(gripPos.x, gripPos.y, 0);
      const gripReport = simulateShot(
        WEAPON_M4A1,
        AMMO_556_NATO_M855,
        gripOrigin,
        normalize(sub(gripPos, gripOrigin)),
        target,
        DEFAULT_ENVIRONMENT
      );
      expect(gripReport.woundEvents.some((w) => w.ghoulZone === 'HAND_RIGHT')).toBe(true);
      applyShotReportToTarget(target, gripReport);
      expect(target.alive).toBe(true);
      expect(target.weaponDropped).toBe(true);

      const lThighPos = target.ragdollBones.THIGH_RIGHT.position;
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
      expect(target.rightLegFunctional).toBe(false);
    });
  });

  describe('3. Realistic 82 kg Human Body Ragdoll Physics (1.1m Close Blast vs 20m Wide Spread & Distant Fall)', () => {
    it('1.1m point-blank 12G shotgun blast delivers punchy close-range knockback (~1.6m-3.8m) with rigid unified skeleton!', () => {
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

      const restRightTibiaSpan = distance(
        target.ragdollBones.KNEE_RIGHT.position,
        target.ragdollBones.FOOT_RIGHT.position
      );

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
      expect(report.ragdollPlan.launchLiftVelocityMs).toBeGreaterThan(0.35);
      expect(report.ragdollPlan.launchLiftVelocityMs).toBeLessThan(1.25);

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

      // Tibia stays straight and rigid (colinear KNEE -> SHIN -> FOOT)
      const finalRightTibiaSpan = distance(
        target.ragdollBones.KNEE_RIGHT.position,
        target.ragdollBones.FOOT_RIGHT.position
      );
      expect(Math.abs(finalRightTibiaSpan - restRightTibiaSpan)).toBeLessThan(0.02);

      const backwardMoveM = initialPelvisZ - target.ragdollBones.PELVIS_GROIN.position.z;
      expect(backwardMoveM).toBeGreaterThan(1.4);
      expect(backwardMoveM).toBeLessThan(4.2);
    });

    it('20m 12G buckshot blooms into a wide pattern (> 2.2m) and 20m kills collapse in place (< 0.45m)', () => {
      // 1) 20m Shotgun shot on unarmored combatant: wide aerodynamic wake spread + zero launch!
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

      // Measure lateral pellet spread across the z = -20m plane across all 9 pellets
      let minX = Infinity;
      let maxX = -Infinity;
      for (const pr of buck20Report.pelletResults) {
        const sampleNear20 = pr.trajectorySamples.find((s) => s.position.z <= -19.5)
          ?? pr.trajectorySamples[pr.trajectorySamples.length - 1];
        minX = Math.min(minX, sampleNear20.position.x);
        maxX = Math.max(maxX, sampleNear20.position.x);
      }
      expect(maxX - minX).toBeGreaterThan(2.2);

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

      // 2) 20m Rifle brain shot collapse
      const rifleTarget20m = createTargetHealthState(
        'target_20m_rifle',
        'Sniper Operative',
        vec3(0, 0, -20.0),
        0,
        'SNIPER_OPERATIVE'
      );
      const brainAim = normalize(sub(vec3(0, 1.66, -20.0), vec3(0, 1.66, 0)));
      const rifleRep = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        vec3(0, 1.66, 0),
        brainAim,
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
      expect(target.ragdollBones.THIGH_RIGHT.componentId).toBe('BODY');
      expect(target.ragdollBones.UPPER_ARM_RIGHT.componentId).toBe('BODY');
    });

    it('Close-range 12G blast to UPPER_ARM_RIGHT triggers CLEAN_SEVER detaching arm subtree as one connected limb', () => {
      const armSubtree = getSubtreeZones('UPPER_ARM_RIGHT');
      expect(armSubtree).toEqual(['UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 'HAND_RIGHT']);

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
      const armSever = report.dismembermentEvents.find((d) => d.zone === 'UPPER_ARM_RIGHT');
      expect(armSever).toBeDefined();
      expect(armSever!.goreMode).toBe('CLEAN_SEVER');
      expect(armSever!.detachedSubtree).toEqual(['UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 'HAND_RIGHT']);

      const restForearmLen = distance(
        target.ragdollBones.UPPER_ARM_RIGHT.position,
        target.ragdollBones.FOREARM_RIGHT.position
      );

      applyShotReportToTarget(target, report);
      expect(target.ragdollBones.UPPER_ARM_RIGHT.componentId).toBe('SEVERED_UPPER_ARM_RIGHT');
      expect(target.ragdollBones.FOREARM_RIGHT.componentId).toBe('SEVERED_UPPER_ARM_RIGHT');
      expect(target.ragdollBones.HAND_RIGHT.componentId).toBe('SEVERED_UPPER_ARM_RIGHT');
      expect(target.ragdollBones.SHOULDER_RIGHT.componentId).toBe('BODY');

      for (let i = 0; i < 40; i++) {
        stepRagdollPhysics(target, 0.01, 0.0);
      }
      const postForearmLen = distance(
        target.ragdollBones.UPPER_ARM_RIGHT.position,
        target.ragdollBones.FOREARM_RIGHT.position
      );
      expect(Math.abs(postForearmLen - restForearmLen)).toBeLessThan(0.02);
    });
  });

  describe('5. Grounded Joint Dismemberment, Living Downed Leg-Shot Posture & 4-State Triage', () => {
    it('rewards deliberate large-caliber joint shots with CLEAN_SEVER while 5.56mm and off-joint mid-shaft hits do NOT amputate', () => {
      // 1) 5.56mm M4A1 shot directly at knee joint does NOT sever leg
      const m4Target = createTargetHealthState('m4_knee', 'Militia', vec3(0, 0, -6), 0);
      const kneePos = m4Target.ragdollBones.KNEE_RIGHT.position;
      const m4Origin = vec3(kneePos.x, kneePos.y, 0);
      const m4Dir = normalize(sub(kneePos, m4Origin));
      const m4Rep = simulateShot(
        WEAPON_M4A1,
        AMMO_556_NATO_SOST_JHP,
        m4Origin,
        m4Dir,
        m4Target,
        DEFAULT_ENVIRONMENT
      );
      expect(m4Rep.hitTarget).toBe(true);
      expect(m4Rep.dismembermentEvents.length).toBe(0);

      // 2) 7.62 NATO mid-thigh (off-joint) fractures femur without severing leg
      const midShaftTarget = createTargetHealthState('mid_thigh', 'Militia', vec3(0, 0, -6), 0);
      const midThighPt = vec3(-0.12, 0.68, -6);
      const midOrigin = vec3(-0.12, 0.68, 0);
      const midRep = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        midOrigin,
        normalize(sub(midThighPt, midOrigin)),
        midShaftTarget,
        DEFAULT_ENVIRONMENT
      );
      expect(midRep.hitTarget).toBe(true);
      expect(midRep.dismembermentEvents.length).toBe(0);

      // 3) Deliberate 7.62 NATO shot directly into KNEE_RIGHT joint severs lower leg cleanly AND keeps enemy ALIVE!
      const jointTarget = createTargetHealthState('joint_knee', 'Militia', vec3(0, 0, -6), 0);
      const jointKneePt = jointTarget.ragdollBones.KNEE_RIGHT.position;
      const jointOrigin = vec3(jointKneePt.x, jointKneePt.y, 0);
      const jointRep = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        jointOrigin,
        normalize(sub(jointKneePt, jointOrigin)),
        jointTarget,
        DEFAULT_ENVIRONMENT
      );
      expect(jointRep.hitTarget).toBe(true);
      expect(jointRep.isLethalKill).toBe(false);
      expect(jointRep.dismembermentEvents.some((d) => d.zone === 'KNEE_RIGHT' && d.goreMode === 'CLEAN_SEVER')).toBe(true);

      applyShotReportToTarget(jointTarget, jointRep);
      expect(jointTarget.alive).toBe(true);

      // 4) Deliberate .50 AE shot at wrist/hand severs HAND_RIGHT while keeping enemy standing & alive!
      const handTarget = createTargetHealthState('joint_hand', 'Punk', vec3(0, 0, -5), 0);
      const handPt = handTarget.ragdollBones.HAND_RIGHT.position;
      const handOrigin = vec3(handPt.x, handPt.y, 0);
      const handRep = simulateShot(
        WEAPON_SILVER_TALON,
        AMMO_50AE_JHP,
        handOrigin,
        normalize(sub(handPt, handOrigin)),
        handTarget,
        DEFAULT_ENVIRONMENT
      );
      expect(handRep.hitTarget).toBe(true);
      expect(handRep.isLethalKill).toBe(false);
      expect(handRep.dismembermentEvents.some((d) => d.zone === 'HAND_RIGHT')).toBe(true);
      applyShotReportToTarget(handTarget, handRep);
      expect(handTarget.alive).toBe(true);
      expect(handTarget.rightLegFunctional).toBe(true);
      expect(handTarget.leftLegFunctional).toBe(true);
    });

    it('leg-shot enemy staggers then goes down ALIVE (propped up by muscle tone, not a sandbag) and transitions across all 4 Triage states', () => {
      const target = createTargetHealthState('leg_triage', 'Balkan Militia', vec3(0, 0, -7), 0, 'MILITIA_GUNNER');
      expect(computeCombatantTriageStatus(target)).toBe('HEALTHY');

      // Shoot right thigh with 5.56 JHP — enemy must survive, become WOUNDED, stumble briefly, then go down onto ground ALIVE
      const thighPt = vec3(-0.12, 0.70, -7);
      const origin = vec3(-0.12, 0.70, 0);
      const legRep = simulateShot(
        WEAPON_M4A1,
        AMMO_556_NATO_SOST_JHP,
        origin,
        normalize(sub(thighPt, origin)),
        target,
        DEFAULT_ENVIRONMENT
      );
      expect(legRep.hitTarget).toBe(true);
      expect(legRep.isLethalKill).toBe(false);
      applyShotReportToTarget(target, legRep);

      expect(target.alive).toBe(true);
      expect(target.rightLegFunctional).toBe(false);
      expect(computeCombatantTriageStatus(target)).toBe('WOUNDED');

      // During brief stumble (t = 0.15s), still upright in LEG_BUCKLE before hitting the ground
      for (let i = 0; i < 15; i++) {
        stepRagdollPhysics(target, 0.01, 0.0);
      }
      expect(target.isRagdollActive).toBe(false);

      // Step forward ~1.8s: combatant goes down to the ground (pelvis on floor) WITH active muscle tone holding head/chest up!
      for (let i = 0; i < 180; i++) {
        stepRagdollPhysics(target, 0.01, 0.0);
      }
      expect(target.isRagdollActive).toBe(true);
      expect(target.alive).toBe(true);
      expect(target.ragdollBones.PELVIS_GROIN.position.y).toBeLessThan(0.24);
      // Propped semi-upright (~45 deg): head stays well off the concrete (> 0.42m), NOT flat like a dead sandbag!
      expect(target.ragdollBones.HEAD_CRANIUM.position.y).toBeGreaterThan(0.42);

      // Severing femoral artery / dropping HP low transitions triage to MORTALLY_WOUNDED while still alive
      target.bloodLossRateMlPerSec = 95;
      expect(computeCombatantTriageStatus(target)).toBe('MORTALLY_WOUNDED');

      // Once killed, triage becomes DEAD and all muscle tone cuts out so head slumps flat onto the floor!
      target.alive = false;
      target.currentHp = 0;
      expect(computeCombatantTriageStatus(target)).toBe('DEAD');

      for (let i = 0; i < 120; i++) {
        stepRagdollPhysics(target, 0.01, 0.0);
      }
      expect(target.ragdollBones.HEAD_CRANIUM.position.y).toBeLessThan(0.22);
    });

    it('keeps ordinary cumulative gunfire non-dismembering while rewarding surgical sniper cervical neck shots with clean decapitation', () => {
      // 1) Ordinary combat: spray mid-bicep with 3x 5.56mm rounds + follow-up 8m .50 AE mid-bicep hit -> gory laceration, ZERO accidental amputation!
      const ordinaryTarget = createTargetHealthState('ord_target', 'Militia Regular', vec3(0, 0, -8), 0);
      const midArmAimPt = vec3(-0.29, 1.24, -8); // off-joint bicep shaft
      const origin8m = vec3(-0.29, 1.24, 0);
      const dir8m = normalize(sub(midArmAimPt, origin8m));

      for (let i = 0; i < 3; i++) {
        const rep556 = simulateShot(WEAPON_M4A1, AMMO_556_NATO_SOST_JHP, origin8m, dir8m, ordinaryTarget, DEFAULT_ENVIRONMENT);
        expect(rep556.dismembermentEvents).toHaveLength(0);
        applyShotReportToTarget(ordinaryTarget, rep556);
      }
      const rep50Mid = simulateShot(WEAPON_SILVER_TALON, AMMO_50AE_JHP, origin8m, dir8m, ordinaryTarget, DEFAULT_ENVIRONMENT);
      expect(rep50Mid.hitTarget).toBe(true);
      expect(rep50Mid.dismembermentEvents).toHaveLength(0);

      // 2) Surgical sniper cervical neck shot at 22m -> shoots the head clean off (NECK_CERVICAL subtree detached)!
      const neckTarget = createTargetHealthState('neck_decap', 'Sniper Target', vec3(0, 0, -22), 0);
      const neckPivot = neckTarget.ragdollBones.NECK_CERVICAL.position;
      const sniperOrigin = vec3(neckPivot.x, neckPivot.y, 0);
      const neckRep = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        sniperOrigin,
        normalize(sub(neckPivot, sniperOrigin)),
        neckTarget,
        DEFAULT_ENVIRONMENT
      );
      expect(neckRep.hitTarget).toBe(true);
      expect(neckRep.isLethalKill).toBe(true);
      const neckSever = neckRep.dismembermentEvents.find((d) => d.zone === 'NECK_CERVICAL');
      expect(neckSever).toBeDefined();
      expect(neckSever!.goreMode).toBe('CLEAN_SEVER');
      expect(neckSever!.detachedSubtree).toEqual(
        expect.arrayContaining(['NECK_CERVICAL', 'HEAD_CRANIUM', 'HEAD_FACE_JAW'])
      );
      expect(neckRep.combatantEffects.some((e) => e.includes('CERVICAL DECAPITATION'))).toBe(true);

      applyShotReportToTarget(neckTarget, neckRep);
      expect(neckTarget.alive).toBe(false);
      expect(neckTarget.ragdollBones.HEAD_CRANIUM.componentId).not.toBe('BODY');
      expect(neckTarget.ragdollBones.TORSO_UPPER_THORAX.componentId).toBe('BODY');
    });
  });
});
