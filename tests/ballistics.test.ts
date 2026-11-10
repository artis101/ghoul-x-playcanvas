import { describe, it, expect } from 'vitest';
import { vec3, length, distance, normalize, sub } from '../src/core/ballistics/vec3.ts';
import {
  WEAPON_MSG90,
  WEAPON_M590,
  WEAPON_SILVER_TALON,
  WEAPON_M4A1,
  AMMO_762_NATO_M118LR,
  AMMO_12G_00_BUCK,
  AMMO_12G_FLECHETTE_SLUG,
  AMMO_50AE_JHP,
  AMMO_556_NATO_M855,
  DEFAULT_ENVIRONMENT,
} from '../src/core/ballistics/weapons.ts';
import {
  createTargetHealthState,
  getSubtreeZones,
} from '../src/core/ghoul/anatomy.ts';
import {
  stepProjectileRK4,
  simulateShot,
  applyShotReportToTarget,
  stepRagdollPhysics,
  targetLocalToWorld,
  computeBallisticZeroAimDirection,
} from '../src/core/ballistics/solver.ts';
import { EnvironmentState, ProjectileState } from '../src/contracts/ballistics.ts';

describe('GHOUL-X Ballistics Simulation Core', () => {
  describe('1. Sniper Elite External Ballistics (RK4 Integration)', () => {
    it('calculates realistic 7.62 NATO bullet drop and velocity decay at 100m and 200m', () => {
      const ammo = AMMO_762_NATO_M118LR;
      const muzzleV = ammo.muzzleVelocityMs; // 805 m/s

      let proj: ProjectileState = {
        id: 'test_bullet',
        ammo,
        position: vec3(0, 1.5, 0), // rifle fired from shoulder height
        velocity: vec3(0, 0, muzzleV), // fired towards +Z
        spinRadS: 2400,
        currentDiameterM: ammo.diameterM,
        flightTimeS: 0,
        distanceTraveledM: 0,
        kineticEnergyJ: 0.5 * ammo.massKg * muzzleV * muzzleV,
        penetratedLayers: 0,
        alive: true,
      };

      const dt = 0.001; // 1 ms
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
          // Initial ray was horizontal at y = 1.5
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

      // In real-world 7.62x51mm M118LR:
      // At 100m: flight time ~0.13s, gravity drop ~ 0.5 * 9.81 * 0.13^2 = ~0.08m (8cm), velocity ~740-770 m/s
      // At 200m: flight time ~0.27s, gravity drop ~ 0.5 * 9.81 * 0.27^2 = ~0.35m (35cm), velocity ~680-720 m/s
      expect(dropAt100m).toBeGreaterThan(0.05); // > 5cm drop
      expect(dropAt100m).toBeLessThan(0.15); // < 15cm drop
      expect(speedAt100m).toBeLessThan(muzzleV);
      expect(speedAt100m).toBeGreaterThan(720);

      expect(dropAt200m).toBeGreaterThan(0.22); // > 22cm drop
      expect(dropAt200m).toBeLessThan(0.50); // < 50cm drop
      expect(speedAt200m).toBeLessThan(speedAt100m);
    });

    it('deflects bullet downwind with crosswind drift', () => {
      const ammo = AMMO_762_NATO_M118LR;
      const crosswindEnv: EnvironmentState = {
        ...DEFAULT_ENVIRONMENT,
        windVelocity: vec3(10.0, 0, 0), // 10 m/s wind blowing towards +X
      };

      let proj: ProjectileState = {
        id: 'test_crosswind',
        ammo,
        position: vec3(0, 1.5, 0),
        velocity: vec3(0, 0, ammo.muzzleVelocityMs),
        spinRadS: 2400,
        currentDiameterM: ammo.diameterM,
        flightTimeS: 0,
        distanceTraveledM: 0,
        kineticEnergyJ: 0.5 * ammo.massKg * ammo.muzzleVelocityMs * ammo.muzzleVelocityMs,
        penetratedLayers: 0,
        alive: true,
      };

      const dt = 0.001;
      while (proj.alive && proj.distanceTraveledM < 200) {
        proj = stepProjectileRK4(proj, crosswindEnv, dt);
      }

      // Wind pushing +X should drift bullet to the right
      expect(proj.position.x).toBeGreaterThan(0.05); // Drifted at least 5cm at 200m
    });

    it('reports signed crosswind drift (+X vs -X) and non-zero drop/drift on near-misses', () => {
      const target = createTargetHealthState('target_wind_sign', 'Range Target', vec3(0, 0, -55), Math.PI);
      const shooterPos = vec3(0, 1.4, 0);
      // Aim slightly wide so shot misses target, testing predictor fallback at targetDistanceM
      const missAimDir = normalize(sub(vec3(1.2, 1.4, -55), shooterPos));

      const rightWindEnv: EnvironmentState = {
        ...DEFAULT_ENVIRONMENT,
        windVelocity: vec3(10.0, 0, 0),
      };
      const leftWindEnv: EnvironmentState = {
        ...DEFAULT_ENVIRONMENT,
        windVelocity: vec3(-10.0, 0, 0),
      };

      const repRight = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        shooterPos,
        missAimDir,
        target,
        rightWindEnv
      );
      const repLeft = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        shooterPos,
        missAimDir,
        target,
        leftWindEnv
      );

      expect(repRight.hitTarget).toBe(false);
      expect(repRight.bulletDropAtImpactCm).toBeGreaterThan(1.5);
      expect(repRight.windDriftAtImpactCm).toBeGreaterThan(0.5);
      expect(repLeft.windDriftAtImpactCm).toBeLessThan(-0.5);
    });
  });

  describe('2. Multi-Layer Anatomical Penetration & X-Ray Kill Cam', () => {
    it('MSG90 7.62 NATO shot to upper thorax penetrates flesh, ribcage bone, and heart', () => {
      // Place target at z = 20m facing shooter (facing -Z, yaw = Math.PI)
      const target = createTargetHealthState('target_alpha', 'Enemy Marksman', vec3(0, 0, 20), Math.PI);

      const shooterPos = vec3(0.02, 1.33, 0); // Aim directly at heart height & X
      const aimDir = normalize(sub(vec3(0.02, 1.33, 20), shooterPos));

      const report = simulateShot(
        WEAPON_MSG90,
        AMMO_762_NATO_M118LR,
        shooterPos,
        aimDir,
        target,
        DEFAULT_ENVIRONMENT
      );

      expect(report.hitTarget).toBe(true);
      expect(report.woundEvents.length).toBeGreaterThanOrEqual(2);

      // Check penetrated layers
      const layerTypes = report.woundEvents.map((w) => w.layerType);
      expect(layerTypes).toContain('SOFT_FLESH');
      expect(layerTypes).toContain('CORTICAL_BONE');
      expect(layerTypes).toContain('ORGAN_HEART');

      // Check lethality & X-Ray Kill Cam
      expect(report.isLethalKill).toBe(true);
      expect(report.triggerXRayKillCam).toBe(true);
      expect(report.xRayFocusZone).toBe('TORSO_UPPER_THORAX');
      expect(report.rupturedOrgans.length).toBeGreaterThan(0);

      // Apply report to target
      applyShotReportToTarget(target, report);
      expect(target.alive).toBe(false);
      expect(target.isRagdollActive).toBe(true);
      expect(target.fracturedBones.size).toBeGreaterThan(0);
      expect(target.rupturedOrgans.size).toBeGreaterThan(0);
    });

    it('Preset 4 (65m MSG90 sniper shot) hits Heart & Ribcage and triggers X-Ray Kill Cam in 2.5 m/s and 10 m/s crosswinds', () => {
      for (const windSpeed of [2.5, 10.0, -10.0]) {
        const target = createTargetHealthState(
          'target_3',
          'OVERWATCH SNIPER (55m)',
          vec3(0.5, 0, -55),
          Math.PI
        );
        const shooterPos = vec3(0.5, 1.50, 10.0); // 65m range
        const env: EnvironmentState = {
          ...DEFAULT_ENVIRONMENT,
          windVelocity: vec3(windSpeed, 0, 0),
        };
        const heartWorld = targetLocalToWorld(
          vec3(-0.02, 1.33, 0.01),
          target.worldPosition,
          target.yawRad
        );
        const aimDir = computeBallisticZeroAimDirection(
          WEAPON_MSG90,
          AMMO_762_NATO_M118LR,
          shooterPos,
          heartWorld,
          env
        );

        const report = simulateShot(
          WEAPON_MSG90,
          AMMO_762_NATO_M118LR,
          shooterPos,
          aimDir,
          target,
          env
        );

        expect(report.hitTarget).toBe(true);
        const layerTypes = report.woundEvents.map((w) => w.layerType);
        expect(layerTypes).toContain('CORTICAL_BONE');
        expect(layerTypes).toContain('ORGAN_HEART');
        expect(report.isLethalKill).toBe(true);
        expect(report.triggerXRayKillCam).toBe(true);
      }
    });
  });

  describe('3. Pre-Calculated Shotgun Lethality & Articulated Ragdoll Launch', () => {
    it('M590 Shotgun blast at 5 meters pre-calculates instant lethality and launches articulated ragdoll together', () => {
      // Enemy standing 5 meters away at (0, 0, 5)
      const target = createTargetHealthState('target_shotgun', 'CQB Guard', vec3(0, 0, 5), Math.PI);

      const shooterPos = vec3(0, 1.3, 0);
      const aimDir = normalize(sub(vec3(0, 1.3, 5), shooterPos));

      const report = simulateShot(
        WEAPON_M590,
        AMMO_12G_00_BUCK,
        shooterPos,
        aimDir,
        target,
        DEFAULT_ENVIRONMENT
      );

      expect(report.hitTarget).toBe(true);
      expect(report.pelletCount).toBe(10);
      expect(report.isLethalKill).toBe(true);
      expect(report.ragdollPlan.willEnableRagdoll).toBe(true);

      // Upward launch lift velocity must be substantial (> 2.0 m/s)
      expect(report.ragdollPlan.launchLiftVelocityMs).toBeGreaterThan(2.0);
      // Victim launched backwards (> 2.5 meters estimated travel)
      expect(report.ragdollPlan.estimatedLaunchDistanceM).toBeGreaterThan(2.5);

      // Apply and step ragdoll physics
      applyShotReportToTarget(target, report);
      expect(target.isRagdollActive).toBe(true);
      expect(target.ragdollRootVelocity.z).toBeGreaterThan(1.0); // Pushed in direction of shot (+Z)
      expect(target.ragdollRootVelocity.y).toBeGreaterThan(2.0); // Airborne launch

      // Step physics over 0.5 seconds
      const initialZ = target.worldPosition.z;
      for (let s = 0; s < 50; s++) {
        stepRagdollPhysics(target, 0.01, 0.0);
      }

      // Enemy must have flown backwards
      expect(target.worldPosition.z).toBeGreaterThan(initialZ + 0.8);

      // Articulated stick constraints: unsevered pelvis, thorax, and feet stay connected to the body
      const pelvisPos = target.ragdollBones['PELVIS_GROIN'].position;
      const thoraxPos = target.ragdollBones['TORSO_UPPER_THORAX'].position;
      const footLeftPos = target.ragdollBones['FOOT_LEFT'].position;

      expect(pelvisPos.z).toBeGreaterThan(initialZ + 0.8);
      if (!target.severedZones.has('TORSO_UPPER_THORAX')) {
        expect(distance(pelvisPos, thoraxPos)).toBeLessThan(0.55);
      }
      if (!target.severedZones.has('FOOT_LEFT')) {
        expect(distance(pelvisPos, footLeftPos)).toBeLessThan(1.15);
      }
    });
  });

  describe('4. Soldier of Fortune GHOUL Dismemberment & Kinematic Tree', () => {
    it('HEAD_CRANIUM hit with .50 AE triggers CRANIAL_POP and head explosion gibs', () => {
      const target = createTargetHealthState('target_headshot', 'Enemy Leader', vec3(0, 0, 3), Math.PI);

      // Head cranium is at y = 1.70m
      const shooterPos = vec3(0, 1.70, 0);
      const aimDir = normalize(sub(vec3(0, 1.70, 3), shooterPos));

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

      // Check dismemberment event
      const headPop = report.dismembermentEvents.find((d) => d.goreMode === 'CRANIAL_POP');
      expect(headPop).toBeDefined();
      expect(headPop!.gibCount).toBeGreaterThanOrEqual(10);
      expect(report.severedZones).toContain('HEAD_CRANIUM');
      expect(report.severedZones).toContain('HEAD_FACE_JAW'); // child zone severed as part of subtree

      // Apply to target
      applyShotReportToTarget(target, report);
      expect(target.zoneGoreMode['HEAD_CRANIUM']).toBe('CRANIAL_POP');
      expect(target.severedZones.has('HEAD_CRANIUM')).toBe(true);
      expect(target.severedZones.has('HEAD_FACE_JAW')).toBe(true);
    });

    it('UPPER_ARM_LEFT hit triggers CLEAN_SEVER detaching upper arm, forearm, and hand while keeping severed limb segments articulated', () => {
      // Kinematic subtree test
      const armSubtree = getSubtreeZones('UPPER_ARM_LEFT');
      expect(armSubtree).toEqual(['UPPER_ARM_LEFT', 'FOREARM_LEFT', 'HAND_LEFT']);

      const target = createTargetHealthState('target_arm', 'Rifleman', vec3(0, 0, 4), 0);
      // With yaw = 0, target faces +Z. UPPER_ARM_LEFT is on local -X: (-0.29, 1.28, 0)
      const armWorldPos = vec3(-0.29, 1.28, 4);
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
      expect(length(armSever!.severedLimbVelocity)).toBeGreaterThan(0);
      expect(armSever!.arterialSprayDirection).toBeDefined();

      applyShotReportToTarget(target, report);
      expect(target.severedZones.has('UPPER_ARM_LEFT')).toBe(true);
      expect(target.severedZones.has('FOREARM_LEFT')).toBe(true);
      expect(target.severedZones.has('HAND_LEFT')).toBe(true);

      // Step physics so severed arm flies off while staying connected internally
      for (let s = 0; s < 30; s++) {
        stepRagdollPhysics(target, 0.01, 0.0);
      }
      const upperArmPos = target.ragdollBones['UPPER_ARM_LEFT'].position;
      const forearmPos = target.ragdollBones['FOREARM_LEFT'].position;
      const handPos = target.ragdollBones['HAND_LEFT'].position;
      if ( !target.ragdollBones['FOREARM_LEFT'].goreMode || target.ragdollBones['FOREARM_LEFT'].goreMode === 'INTACT' ) {
        expect(distance(upperArmPos, forearmPos)).toBeLessThan(0.35);
      }
      if ( !target.ragdollBones['HAND_LEFT'].goreMode || target.ragdollBones['HAND_LEFT'].goreMode === 'INTACT' ) {
        expect(distance(forearmPos, handPos)).toBeLessThan(0.30);
      }
    });

    it('Preset 3 (6m M590 12G Slug) cleanly severs UPPER_ARM_LEFT without hitting torso', () => {
      const target = createTargetHealthState('target_0', 'MERCENARY POINTMAN', vec3(0, 0, -5), Math.PI);
      const shooterPos = vec3(0.32, 1.28, 1.0);
      const armCenterWorld = targetLocalToWorld(vec3(-0.29, 1.28, 0), target.worldPosition, target.yawRad);
      const env: EnvironmentState = { ...DEFAULT_ENVIRONMENT, windVelocity: vec3(2.5, 0, 0) };
      const aimDir = computeBallisticZeroAimDirection(
        WEAPON_M590,
        AMMO_12G_FLECHETTE_SLUG,
        shooterPos,
        armCenterWorld,
        env
      );

      const report = simulateShot(
        WEAPON_M590,
        AMMO_12G_FLECHETTE_SLUG,
        shooterPos,
        aimDir,
        target,
        env
      );

      expect(report.hitTarget).toBe(true);
      expect(report.severedZones).toContain('UPPER_ARM_LEFT');
      expect(report.severedZones).toContain('FOREARM_LEFT');
      expect(report.severedZones).toContain('HAND_LEFT');
      expect(report.woundEvents.every((w) => w.ghoulZone !== 'TORSO_UPPER_THORAX')).toBe(true);
    });

    it('non-severing 5.56mm limb wound degrades zoneIntegrity and sets zoneGoreMode to LACERATED', () => {
      const target = createTargetHealthState('target_lacerate', 'Guard', vec3(0, 0, -10), Math.PI);
      const outerThighWorld = targetLocalToWorld(vec3(-0.15, 0.69, 0), target.worldPosition, target.yawRad);
      const shooterPos = vec3(outerThighWorld.x, outerThighWorld.y, 0);
      const aimDir = normalize(sub(outerThighWorld, shooterPos));

      const report = simulateShot(
        WEAPON_M4A1,
        AMMO_556_NATO_M855,
        shooterPos,
        aimDir,
        target,
        DEFAULT_ENVIRONMENT
      );

      expect(report.hitTarget).toBe(true);
      expect(report.severedZones).not.toContain('THIGH_LEFT');

      applyShotReportToTarget(target, report);
      expect(target.zoneIntegrity['THIGH_LEFT']).toBeLessThan(100);
      expect(target.zoneGoreMode['THIGH_LEFT']).toBe('LACERATED');
    });
  });
});

