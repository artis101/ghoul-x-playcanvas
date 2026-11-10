import { beforeAll, describe, expect, it } from 'vitest';
import * as pc from 'playcanvas';
import {
  BARREL_BLAST_PEAK_ENERGY_J,
  BARREL_BLAST_PEAK_IMPULSE_NS,
  BARREL_BLAST_RADIUS_M,
  BARREL_FUSE_DURATION_S,
  BulletTimeController,
  CasingBounceEvent,
  ExplosiveBarrelManager,
  MayhemDirector,
  computeSurfaceAlignedQuadQuaternion,
} from '../src/engine/fx/mayhemDirector.ts';
import {
  DOWNED_ONE_HANDED_SPREAD_MULTIPLIER,
  EnemyTacticalAiState,
  EnemyTracerFireEvent,
  TacticalCombatAiSystem,
} from '../src/engine/ai/tacticalCombatAi.ts';
import {
  initRapierPhysics,
  RapierPhysicsWorld,
  writeColumnMajorTrsMatrix4,
} from '../src/engine/physics/rapierWorld.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import {
  AMMO_12G_00_BUCK,
  AMMO_50AE_JHP,
  AMMO_762_NATO_M118LR,
  WEAPON_M590,
  WEAPON_MSG90,
} from '../src/core/ballistics/weapons.ts';
import type { BlastEvent, ColliderSurfaceTag } from '../src/contracts/destruction.ts';

function createHeadlessPlayCanvasApp(): pc.Application {
  const canvasStub = { width: 800, height: 600 };
  const device = new pc.NullGraphicsDevice(canvasStub);
  return new pc.Application(canvasStub as unknown as HTMLCanvasElement, {
    graphicsDevice: device,
  });
}

describe('AAA FPS Mayhem Director, Bullet-Time & Tactical Combat AI', () => {
  beforeAll(async () => {
    await initRapierPhysics();
  });

  // ==========================================================================
  // 1. BulletTimeController
  // ==========================================================================
  describe('1. BulletTimeController (F.E.A.R. Reflex Slow-Mo & Kill-Punch)', () => {
    it('drains and recharges the 100% Reflex meter, lerps to 0.22x, and computes exact effectiveDt', () => {
      const vignettes: string[] = [];
      const bt = new BulletTimeController({
        reflexTargetScale: 0.22,
        drainPctPerRealSec: 25,
        rechargePctPerRealSec: 20,
        rechargeCooldownS: 0.3,
        minActivationPct: 12,
        onVignetteUpdate: (v) => {
          if (v.tint !== 'NONE') vignettes.push(v.tint);
        },
      });

      expect(bt.timeScale).toBe(1.0);
      expect(bt.reflexEnergyPct).toBe(100);
      expect(bt.effectiveDt(0.016)).toBeCloseTo(0.016, 6);

      // Toggle [Z] Reflex Slow-Motion ON
      expect(bt.toggleReflex()).toBe(true);
      expect(bt.isReflexActive).toBe(true);

      // Advance 0.8s in 16ms steps -> timeScale converges to 0.22x and meter drains 20%
      for (let i = 0; i < 50; i++) {
        const scaled = bt.update(0.016);
        expect(scaled).toBeCloseTo(bt.effectiveDt(0.016), 8);
        expect(bt.timeScale).toBeGreaterThanOrEqual(0.08);
        expect(bt.timeScale).toBeLessThanOrEqual(1.0);
      }

      expect(bt.timeScale).toBeCloseTo(0.22, 2);
      expect(bt.effectiveDt(0.05)).toBeCloseTo(0.011, 3);
      expect(bt.reflexEnergyPct).toBeCloseTo(80, 1);
      expect(vignettes).toContain('CYAN_REFLEX');

      // Drain remaining 80% completely (3.2s real time at 25%/s) -> auto-disengages at 0%
      for (let i = 0; i < 32; i++) {
        bt.update(0.1);
      }
      expect(bt.reflexEnergyPct).toBeCloseTo(0, 5);
      expect(bt.isReflexActive).toBe(false);

      // Cannot re-activate while below 12% minActivationPct
      expect(bt.toggleReflex()).toBe(false);

      // Wait out 0.3s cooldown + 5.0s recharge -> returns to 100% and 1.0x timeScale
      for (let i = 0; i < 55; i++) {
        bt.update(0.1);
      }
      expect(bt.reflexEnergyPct).toBeCloseTo(100, 1);
      expect(bt.timeScale).toBeCloseTo(1.0, 3);
      bt.destroy();
    });

    it('triggers automatic 0.35s micro-dilation Kill-Punch on CRANIAL_POP / multi-kill without draining meter', () => {
      const bt = new BulletTimeController({ drainPctPerRealSec: 25 });
      bt.setReflexActive(true);
      bt.update(0.2); // Drain to 95%
      bt.setReflexActive(false);
      const energyBeforePunch = bt.reflexEnergyPct;

      bt.triggerKillPunch('CRANIAL_POP', 0.35);
      expect(bt.isKillPunchActive).toBe(true);
      expect(bt.reflexEnergyPct).toBeGreaterThan(energyBeforePunch);

      for (let i = 0; i < 10; i++) {
        bt.update(0.02); // 0.20s elapsed -> inside 0.35s punch
      }
      expect(bt.isKillPunchActive).toBe(true);
      expect(bt.timeScale).toBeLessThan(0.25);
      expect(bt.getVignetteState().tint).toBe('AMBER_KILL_PUNCH');

      // Advance past 0.35s punch -> recovers smoothly to 1.0x
      for (let i = 0; i < 30; i++) {
        bt.update(0.03);
      }
      expect(bt.isKillPunchActive).toBe(false);
      expect(bt.timeScale).toBeCloseTo(1.0, 2);
      bt.destroy();
    });
  });

  // ==========================================================================
  // 2. ExplosiveBarrelManager & MayhemDirector
  // ==========================================================================
  describe('2. ExplosiveBarrelManager & MayhemDirector Instanced FX', () => {
    it('enforces 1 rifle/.50AE/slug vs 2 buckshot hit thresholds, 0.18s fuse, BlastEvent stats & clean wave reset', () => {
      const world = new RapierPhysicsWorld();
      const app = createHeadlessPlayCanvasApp();
      const detonatedBlasts: BlastEvent[] = [];

      try {
        const manager = new ExplosiveBarrelManager({
          app,
          rapierWorld: world,
          barrelPositions: [
            { x: -2.0, y: 0, z: -8.0 },
            { x: 2.0, y: 0, z: -8.0 },
          ],
          onBarrelDetonated: (_b, blast) => detonatedBlasts.push(blast),
        });

        // Verify STEEL Rapier collider registration with hazard_barrel_<i>
        const rayHits = world.castPenetrationRay(
          { x: -2.0, y: 0.45, z: -5.0 },
          { x: 0, y: 0, z: -1 },
          6.0,
        );
        expect(rayHits.length).toBe(1);
        expect(rayHits[0].surface.material).toBe('STEEL');
        expect(rayHits[0].surface.objectId).toBe('hazard_barrel_0');

        // Barrel 0: 1st buckshot hit deals 0.5 -> stays INTACT
        const ignitedOnFirstBuck = manager.registerBarrelHit(0, {
          ammoType: 'BUCKSHOT_00',
          kineticEnergyJ: 240,
        });
        expect(ignitedOnFirstBuck).toBe(false);
        expect(manager.barrels[0].state).toBe('INTACT');

        // Barrel 0: 2nd buckshot hit reaches 1.0 -> IGNITED_HISSING with 0.18s fuse!
        const ignitedOnSecondBuck = manager.registerBarrelHit(0, {
          ammoType: 'BUCKSHOT_00',
          kineticEnergyJ: 240,
        });
        expect(ignitedOnSecondBuck).toBe(true);
        expect(manager.barrels[0].state).toBe('IGNITED_HISSING');
        expect(manager.barrels[0].fuseRemainingS).toBeCloseTo(BARREL_FUSE_DURATION_S, 4);
        expect(manager.barrels[0].flameJetEntity?.enabled).toBe(true);

        // Barrel 1: 1 .50 AE / rifle hit ignites immediately!
        const ignitedRifle = manager.registerBarrelHit('hazard_barrel_1', {
          ammoType: AMMO_50AE_JHP.type,
          kineticEnergyJ: 1850,
        });
        expect(ignitedRifle).toBe(true);
        expect(manager.barrels[1].state).toBe('IGNITED_HISSING');

        // Step 0.10s -> still hissing before 0.18s fuse completes
        manager.update(0.1);
        expect(detonatedBlasts.length).toBe(0);

        // Step another 0.10s (total 0.20s >= 0.18s) -> both detonate!
        manager.update(0.1);
        expect(detonatedBlasts.length).toBe(2);
        expect(detonatedBlasts[0].radiusM).toBe(BARREL_BLAST_RADIUS_M);
        expect(detonatedBlasts[0].peakImpulseNs).toBe(BARREL_BLAST_PEAK_IMPULSE_NS);
        expect(detonatedBlasts[0].peakEnergyJ).toBe(BARREL_BLAST_PEAK_ENERGY_J);

        expect(manager.barrels[0].state).toBe('DETONATED');
        expect(manager.barrels[0].intactDrumEntity?.enabled).toBe(false);
        expect(manager.barrels[0].crumpledBaseEntity?.enabled).toBe(true);
        expect(manager.barrels[0].scorchDecalEntity?.enabled).toBe(true);

        // Intact Rapier collider was removed on detonation
        const postBlastHits = world.castPenetrationRay(
          { x: -2.0, y: 0.45, z: -5.0 },
          { x: 0, y: 0, z: -1 },
          6.0,
        );
        expect(postBlastHits.length).toBe(0);

        // Respawn cleanly on new wave
        manager.resetBarrels();
        expect(manager.barrels[0].state).toBe('INTACT');
        expect(manager.barrels[0].crumpledBaseEntity?.enabled).toBe(false);
        expect(manager.barrels[0].intactDrumEntity?.enabled).toBe(true);

        const respawnHits = world.castPenetrationRay(
          { x: -2.0, y: 0.45, z: -5.0 },
          { x: 0, y: 0, z: -1 },
          6.0,
        );
        expect(respawnHits.length).toBe(1);

        manager.destroy();
      } finally {
        app.destroy();
        world.destroy();
      }
    });

    it('triggers chain-reaction detonations across close barrels while strictly preventing infinite recursion', () => {
      const world = new RapierPhysicsWorld();
      const detonationOrder: string[] = [];

      try {
        // Place 3 barrels 3.2m apart (well inside 6.5m blast radius) with synchronous chain fuse (0s)
        // AND cyclic re-entry inside onBarrelDetonated -> applyBlast to stress-test recursion safety!
        const manager = new ExplosiveBarrelManager({
          rapierWorld: world,
          sympatheticChainFuseS: 0,
          barrelPositions: [
            { x: -3.2, y: 0, z: -10.0 },
            { x: 0.0, y: 0, z: -10.0 },
            { x: 3.2, y: 0, z: -10.0 },
          ],
          onBarrelDetonated: (barrel, blast) => {
            detonationOrder.push(barrel.objectId);
            // Explicitly feed blast right back into applyBlast to prove zero cyclic re-detonation
            manager.applyBlast(blast);
          },
        });

        // Shoot barrel 0 via handleRaySegment with a high-energy rifle round
        const segRes = manager.handleRaySegment({
          originWorld: { x: -3.2, y: 0.45, z: -6.0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 8.0,
          kineticEnergyJ: 3400,
          speedMs: 805,
          caliberRadiusM: 0.0039,
          isArmorPiercing: false,
        });
        expect(segRes).not.toBeNull();
        expect(manager.barrels[0].state).toBe('IGNITED_HISSING');

        // Advance past 0.18s fuse -> Barrel 0 detonates -> chains to Barrel 1 -> chains to Barrel 2!
        manager.update(0.2);

        expect(detonationOrder).toEqual([
          'hazard_barrel_0',
          'hazard_barrel_1',
          'hazard_barrel_2',
        ]);
        expect(manager.barrels.every((b) => b.state === 'DETONATED')).toBe(true);

        manager.destroy();
      } finally {
        world.destroy();
      }
    });

    it('drives instanced brass/12G casings + bounce clinks, dynamic lights, and normal-aligned wall/floor blood decals', () => {
      const world = new RapierPhysicsWorld();
      const app = createHeadlessPlayCanvasApp();
      const bounces: CasingBounceEvent[] = [];

      try {
        // Place a brick/concrete backstop wall at z = -10.0 (front face normal +Z = (0, 0, 1))
        const wallTag: ColliderSurfaceTag = {
          material: 'BRICK_MASONRY',
          objectId: 'test_backstop_wall',
          thicknessM: 0.2,
          penetrationResistanceJ: 1600,
        };
        world.createStaticBox(
          { x: 0, y: 1.2, z: -10.0 },
          { x: 2.0, y: 1.2, z: 0.1 },
          undefined,
          wallTag,
        );
        world.step(1 / 60);

        const mayhem = new MayhemDirector({
          app,
          rapierWorld: world,
          barrelPositions: [],
          onCasingBounce: (ev) => bounces.push(ev),
        });

        // 1. Fire rifle & 12G shotgun -> separate HardwareInstancedPools + 45ms muzzle light
        mayhem.onPlayerWeaponFired(
          { x: 0, y: 1.62, z: 0 },
          { x: 0, y: 0, z: -1 },
          WEAPON_MSG90,
          AMMO_762_NATO_M118LR,
        );
        mayhem.onPlayerWeaponFired(
          { x: 0, y: 1.62, z: 0 },
          { x: 0, y: 0, z: -1 },
          WEAPON_M590,
          AMMO_12G_00_BUCK,
        );

        expect(mayhem.brassCasingPool.activeCount).toBe(1);
        expect(mayhem.shotgunHullPool.activeCount).toBe(1);
        expect(mayhem.activeDynamicLightCount).toBe(2);

        // Step 1.0s so casings fall to y = 0.012 and trigger metallic/hull bounce callbacks, and 45ms lights expire
        for (let i = 0; i < 60; i++) {
          mayhem.update(1 / 60);
        }
        expect(bounces.length).toBeGreaterThanOrEqual(2);
        expect(bounces.some((b) => !b.isShotgunHull)).toBe(true);
        expect(bounces.some((b) => b.isShotgunHull)).toBe(true);
        expect(mayhem.activeDynamicLightCount).toBe(0);

        // 2. Low-energy non-sever exit (exitEnergyJ = 40 <= 80) stamps 0 decals
        expect(
          mayhem.projectBloodSplatter({
            originWorld: { x: 0, y: 1.35, z: -8.2 },
            impactDirectionWorld: { x: 0, y: 0, z: -1 },
            exitEnergyJ: 40,
          }),
        ).toBe(0);

        // 3. Penetrating torso exit (exitEnergyJ = 420 > 80) within 4.5m of wall at z = -10 (front face z = -9.9)
        const wallStamped = mayhem.projectBloodSplatter({
          originWorld: { x: 0.25, y: 1.35, z: -8.2 },
          impactDirectionWorld: { x: 0, y: 0, z: -1 },
          exitEnergyJ: 420,
        });
        expect(wallStamped).toBe(1);
        expect(mayhem.bloodSplatterPool.activeCount).toBe(1);

        // Decal Z position is wall front face (-9.9) + 0.004m normal offset = -9.896m!
        expect(mayhem.bloodSplatterPool.matrixData[12]).toBeCloseTo(0.25, 4);
        expect(mayhem.bloodSplatterPool.matrixData[13]).toBeCloseTo(1.35, 4);
        expect(mayhem.bloodSplatterPool.matrixData[14]).toBeCloseTo(-9.896, 3);

        // Verify quad local +Z column (indices 8, 9, 10) aligns exactly with wall normal (0, 0, +1)
        expect(mayhem.bloodSplatterPool.matrixData[8]).toBeCloseTo(0, 5);
        expect(mayhem.bloodSplatterPool.matrixData[9]).toBeCloseTo(0, 5);
        expect(mayhem.bloodSplatterPool.matrixData[10]).toBeCloseTo(1, 5);

        // 4. Downward floor splatter hits y = 0 + 0.004m offset with normal (0, +1, 0)
        const floorQuat = computeSurfaceAlignedQuadQuaternion(
          { x: 0, y: 1, z: 0 },
          { x: 0, y: -0.6, z: -0.8 },
          0,
        );
        const floorMat = new Float32Array(16);
        writeColumnMajorTrsMatrix4(
          floorMat,
          0,
          0,
          0.004,
          -7.0,
          floorQuat.x,
          floorQuat.y,
          floorQuat.z,
          floorQuat.w,
        );
        expect(floorMat[8]).toBeCloseTo(0, 5);
        expect(floorMat[9]).toBeCloseTo(1, 5);
        expect(floorMat[10]).toBeCloseTo(0, 5);

        const cranPopStamped = mayhem.projectBloodSplatter({
          originWorld: { x: -0.5, y: 1.1, z: -7.5 },
          impactDirectionWorld: { x: 0, y: -0.8, z: -0.6 },
          exitEnergyJ: 20, // <= 80, but CRANIAL_POP still stamps wall/floor gore!
          goreMode: 'CRANIAL_POP',
        });
        expect(cranPopStamped).toBeGreaterThanOrEqual(1);

        mayhem.destroy();
      } finally {
        app.destroy();
        world.destroy();
      }
    });
  });

  // ==========================================================================
  // 3. TacticalCombatAiSystem
  // ==========================================================================
  describe('3. TacticalCombatAiSystem (State Machine, Cover Peek & Trauma Accuracy)', () => {
    it('transitions PATROL_GUARD -> ALERTED_ENGAGING -> DOWNED_CRAWLING -> DEAD and degrades aim 4.5x on leg trauma', () => {
      const stateHistory: EnemyTacticalAiState[] = [];
      const firedTracers: EnemyTracerFireEvent[] = [];

      const ai = new TacticalCombatAiSystem({
        sightDetectionRangeM: 12,
        initialPlayerHealth: 90,
        initialPlayerArmor: 40,
        onEnemyFireTracer: (ev) => firedTracers.push(ev),
        onEnemyStateChanged: (_id, _prev, next) => stateHistory.push(next),
      });

      const enemy = createTargetHealthState(
        'hostile_alpha',
        'Militia Guard',
        { x: -1.8, y: 0, z: -18.0 },
        0,
        'MILITIA_GUNNER',
      );
      ai.registerWaveTargets([enemy], false);

      const agent = ai.getAgent('hostile_alpha')!;
      expect(agent.state).toBe('PATROL_GUARD');
      expect(agent.adrenaline).toBeLessThan(0.2);

      // Healthy baseline aim profile
      const healthyAim = ai.computeEnemyAimProfile(enemy, agent);
      expect(healthyAim.spreadMultiplier).toBeCloseTo(1.0, 3);

      // Gunshot alerts guard -> ALERTED_ENGAGING + adrenaline surge!
      ai.notifyGunshotOrExplosion({ x: 0, y: 1.6, z: 0 }, 35.0);
      expect(agent.state).toBe('ALERTED_ENGAGING');
      expect(agent.adrenaline).toBeGreaterThanOrEqual(0.85);

      // Step 2.5s so enemy strafes/peeks out from cover, turns toward player, and fires glowing tracer bursts!
      const startX = enemy.worldPosition.x;
      for (let i = 0; i < 50; i++) {
        ai.update(0.05, [enemy], { x: 1.5, y: 1.62, z: 0 });
      }
      expect(Math.abs(enemy.worldPosition.x - startX)).toBeGreaterThan(0.15);
      expect(enemy.yawRad).toBeGreaterThan(0.05); // Turned toward player at x = +1.5
      expect(firedTracers.length).toBeGreaterThan(0);

      // Shoot out left leg -> collapses to DOWNED_CRAWLING (LEG_BUCKLED) with >= 4.5x one-handed aim cone!
      enemy.leftLegFunctional = false;
      enemy.painShock = 0.45;
      ai.notifyEnemyHit(enemy, { hitZone: 'THIGH_LEFT', energyDepositedJ: 520 });

      expect(agent.state).toBe('DOWNED_CRAWLING');
      expect(enemy.posture).toBe('LEG_BUCKLED');

      const crippledAim = ai.computeEnemyAimProfile(enemy, agent);
      expect(crippledAim.canReturnFire).toBe(true);
      expect(crippledAim.isOneHandedDownedFire).toBe(true);
      expect(crippledAim.spreadMultiplier).toBeGreaterThanOrEqual(
        DOWNED_ONE_HANDED_SPREAD_MULTIPLIER,
      );
      expect(crippledAim.effectiveSpreadRad).toBeGreaterThan(
        healthyAim.effectiveSpreadRad * 4.4,
      );

      // Step downed fighter -> still bravely fires wildly with >= 4.5x spread cone!
      const countBeforeDownedFire = firedTracers.length;
      for (let i = 0; i < 60; i++) {
        ai.update(0.05, [enemy], { x: 0, y: 1.62, z: 0 });
      }
      expect(firedTracers.length).toBeGreaterThan(countBeforeDownedFire);
      const lastTracer = firedTracers[firedTracers.length - 1];
      expect(lastTracer.spreadMultiplier).toBeGreaterThanOrEqual(
        DOWNED_ONE_HANDED_SPREAD_MULTIPLIER,
      );

      // Disarm enemy (weaponDropped = true) -> clutches wound helplessly and stops firing
      enemy.weaponDropped = true;
      const disarmedAim = ai.computeEnemyAimProfile(enemy, agent);
      expect(disarmedAim.canReturnFire).toBe(false);
      expect(disarmedAim.clutchingWound).toBe(true);

      // Exsanguinate / kill enemy -> transitions to DEAD
      enemy.currentHp = 0;
      enemy.alive = false;
      ai.update(0.05, [enemy], { x: 0, y: 1.62, z: 0 });
      expect(agent.state).toBe('DEAD');

      expect(stateHistory).toEqual([
        'ALERTED_ENGAGING',
        'DOWNED_CRAWLING',
        'DEAD',
      ]);

      // Verify player brutal-kill & wave-clear armor/HP boost
      const armorBefore = ai.playerVitals.armor;
      ai.grantBrutalKillReward('CRANIAL_POP');
      expect(ai.playerVitals.armor).toBeGreaterThan(armorBefore);
      ai.notifyWaveCleared();
      expect(ai.playerVitals.health).toBe(100);

      ai.destroy();
    });

    it('applies neurogenic shock stagger on unsuspecting torso hits and prevents mortally wounded laser-aiming', () => {
      const ai = new TacticalCombatAiSystem();

      const unsuspectingGuard = createTargetHealthState(
        'guard_unsuspecting',
        'Sentry',
        { x: -2.0, y: 0, z: -22.0 },
        0,
        'SKINHEAD_PUNK',
      );
      const alertedFighter = createTargetHealthState(
        'fighter_alerted',
        'Alerted Gunner',
        { x: 2.0, y: 0, z: -22.0 },
        0,
        'MILITIA_GUNNER',
      );

      ai.registerWaveTargets([unsuspectingGuard, alertedFighter], false);

      // Alert only the second fighter beforehand so they have combat adrenaline
      const alertedAgent = ai.getAgent('fighter_alerted')!;
      alertedAgent.state = 'ALERTED_ENGAGING';
      alertedAgent.adrenaline = 0.9;

      // Hit unsuspecting guard in torso -> immediate neurogenic shock stagger!
      const nextGuardState = ai.notifyEnemyHit(unsuspectingGuard, {
        hitZone: 'TORSO_UPPER_THORAX',
        energyDepositedJ: 420,
      });
      const guardAgent = ai.getAgent('guard_unsuspecting')!;
      expect(nextGuardState).toBe('SUPPRESSED_STAGGERED');
      expect(guardAgent.neurogenicShockTimerS).toBeGreaterThan(1.0);
      expect(unsuspectingGuard.painShock).toBeGreaterThanOrEqual(0.8);
      expect(unsuspectingGuard.consciousness).toBeLessThan(0.5);
      expect(ai.computeEnemyAimProfile(unsuspectingGuard, guardAgent).canReturnFire).toBe(
        false,
      );

      // Hit alerted high-adrenaline fighter with same moderate hit -> stays conscious & combat-capable!
      const nextAlertedState = ai.notifyEnemyHit(alertedFighter, {
        hitZone: 'TORSO_UPPER_THORAX',
        energyDepositedJ: 420,
      });
      expect(nextAlertedState).toBe('ALERTED_ENGAGING');
      expect(alertedFighter.consciousness).toBeGreaterThan(0.9);
      expect(alertedAgent.adrenaline).toBeGreaterThanOrEqual(0.9);

      // Inflict organ rupture / heavy blood loss -> MORTALLY_WOUNDED clutches wounds instead of laser-aiming!
      alertedFighter.rupturedOrgans.add('ORGAN_LIVER');
      alertedFighter.systolicBpMmHg = 68;
      const mortalAim = ai.computeEnemyAimProfile(alertedFighter, alertedAgent);
      expect(mortalAim.clutchingWound).toBe(true);
      expect(mortalAim.canReturnFire).toBe(false);
      expect(mortalAim.aimAccuracyMultiplier).toBeLessThanOrEqual(0.12);

      ai.destroy();
    });
  });
});
