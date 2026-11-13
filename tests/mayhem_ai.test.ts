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
  BACKUP_SIDEARM_WEAPON_ID,
  CombatantResolveProfile,
  DOWNED_ONE_HANDED_SPREAD_MULTIPLIER,
  EnemyTacticalAiState,
  EnemyTracerFireEvent,
  OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
  SIDEARM_DRAW_DURATION_S,
  TacticalCombatAiSystem,
  resolveDefaultCombatantProfile,
} from '../src/engine/ai/tacticalCombatAi.ts';
import {
  initRapierPhysics,
  RapierPhysicsWorld,
  writeColumnMajorTrsMatrix4,
} from '../src/engine/physics/rapierWorld.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { simulateShot, applyShotReportToTarget } from '../src/core/ballistics/solver.ts';
import { add, distance, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_12G_00_BUCK,
  AMMO_50AE_JHP,
  AMMO_762_NATO_M118LR,
  DEFAULT_ENVIRONMENT,
  WEAPON_SILVER_TALON,
  WEAPON_M590,
  WEAPON_MSG90,
} from '../src/core/ballistics/weapons.ts';
import { CombatDirector, TARGET_CONFIGS } from '../src/engine/combat/combatDirector.ts';
import { getOrCreateMaterials } from '../src/engine/materials.ts';
import { GoreAndBallisticsFxManager } from '../src/engine/goreFx.ts';
import { HudController } from '../src/engine/hudController.ts';
import type { GlbModelRegistry } from '../src/engine/assets/glbLoader.ts';
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

    it('chains only tightly clustered pallet barrels without recursion while keeping separated station barrels intact', () => {
      const world = new RapierPhysicsWorld();
      const detonationOrder: string[] = [];

      try {
        // Barrels 0..2 sit 1.4m apart in a tight pallet cluster; Barrel 3 sits 3.4m away at another station
        // AND cyclic re-entry inside onBarrelDetonated -> applyBlast stress-tests recursion safety!
        const manager = new ExplosiveBarrelManager({
          rapierWorld: world,
          sympatheticChainFuseS: 0,
          barrelPositions: [
            { x: -1.4, y: 0, z: -10.0 },
            { x: 0.0, y: 0, z: -10.0 },
            { x: 1.4, y: 0, z: -10.0 },
            { x: 4.8, y: 0, z: -10.0 },
          ],
          onBarrelDetonated: (barrel, blast) => {
            detonationOrder.push(barrel.objectId);
            // Explicitly feed blast right back into applyBlast to prove zero cyclic re-detonation
            manager.applyBlast(blast);
          },
        });

        // Shoot barrel 0 via handleRaySegment with a high-energy rifle round
        const segRes = manager.handleRaySegment({
          originWorld: { x: -1.4, y: 0.45, z: -6.0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 8.0,
          kineticEnergyJ: 3400,
          speedMs: 805,
          caliberRadiusM: 0.0039,
          isArmorPiercing: false,
        });
        expect(segRes).not.toBeNull();
        expect(manager.barrels[0].state).toBe('IGNITED_HISSING');

        // Advance past 0.18s fuse -> Barrel 0 detonates -> chains across pallet cluster (1, 2), leaving separated Barrel 3 intact!
        manager.update(0.2);

        expect(detonationOrder).toEqual([
          'hazard_barrel_0',
          'hazard_barrel_1',
          'hazard_barrel_2',
        ]);
        expect(manager.barrels[0].state).toBe('DETONATED');
        expect(manager.barrels[1].state).toBe('DETONATED');
        expect(manager.barrels[2].state).toBe('DETONATED');
        expect(manager.barrels[3].state).toBe('INTACT');

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
    it('turns toward the live player position before firing at someone behind it', () => {
      const app = createHeadlessPlayCanvasApp();
      const materials = getOrCreateMaterials();
      const fx = new GoreAndBallisticsFxManager(app, materials);
      const hud = new HudController();
      const eye = vec3(0, 1.62, -18);
      const shotYaw: number[] = [];
      const targetId = 'target_0';
      const ai = new TacticalCombatAiSystem({
        onEnemyFireTracer: (event) => {
          if (event.targetId === targetId) shotYaw.push(enemy.yawRad);
        },
      });
      const director = new CombatDirector(app, materials, fx, hud, undefined, {
        tacticalAi: ai,
        getPlayerEyePosition: () => eye,
      });

      director.spawnAllTargets();
      const enemy = director.targets.find((target) => target.healthState.targetId === targetId)!.healthState;

      try {
        ai.notifyGunshotOrExplosion(enemy.worldPosition);
        const agent = ai.getAgent(targetId)!;
        agent.peekCycleTimerS = 1;
        agent.burstShotsRemaining = 1;
        enemy.yawRad = 0;

        director.update(0.05, 0.05, null, hud);
        expect(shotYaw).toHaveLength(0);
        expect(Math.abs(enemy.yawRad)).toBeGreaterThan(0.1);

        for (let i = 2; i <= 25; i++) director.update(0.05, i * 0.05, null, hud);
        expect(shotYaw.length).toBeGreaterThan(0);
        const toEye = normalize(vec3(eye.x - enemy.worldPosition.x, 0, eye.z - enemy.worldPosition.z));
        expect(Math.sin(enemy.yawRad) * toEye.x + Math.cos(enemy.yawRad) * toEye.z).toBeGreaterThan(0.99);
        expect(Math.cos(shotYaw[0])).toBeLessThan(-0.9);
      } finally {
        director.destroy();
        ai.destroy();
        fx.clearAll();
        app.destroy();
      }
    });

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

      // Shoot out right leg -> collapses to DOWNED_CRAWLING (LEG_BUCKLED) with >= 4.5x one-handed aim cone!
      enemy.rightLegFunctional = false;
      enemy.painShock = 0.45;
      ai.notifyEnemyHit(enemy, { hitZone: 'THIGH_RIGHT', energyDepositedJ: 520 });

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

      // Inflict organ rupture / heavy blood loss -> MORTALLY_WOUNDED still fights till death,
      // while physiological tremor & hypotension severely degrade aim (no laser-aiming!)
      alertedFighter.rupturedOrgans.add('ORGAN_LIVER');
      alertedFighter.systolicBpMmHg = 68;
      const mortalAim = ai.computeEnemyAimProfile(alertedFighter, alertedAgent);
      expect(mortalAim.clutchingWound).toBe(false);
      expect(mortalAim.canReturnFire).toBe(true);
      expect(mortalAim.spreadMultiplier).toBeGreaterThan(3.5);
      expect(mortalAim.aimAccuracyMultiplier).toBeLessThanOrEqual(0.28);

      ai.destroy();
    });

    it('prevents PATROL_GUARD proximity wallhacks (<= 6.5m) through solid wood, brick, and concrete walls even when hugging < 0.15m', () => {
      const world = new RapierPhysicsWorld();
      const firedTracers: EnemyTracerFireEvent[] = [];

      try {
        // Build 3 opaque cover walls: wood (185 J), brick (1600 J), and concrete (12000 J)
        world.createStaticBox(
          { x: 0, y: 1.2, z: -6.0 },
          { x: 2.0, y: 1.2, z: 0.06 },
          undefined,
          {
            material: 'WOOD_DRYWALL',
            objectId: 'test_wood_wall',
            thicknessM: 0.12,
            penetrationResistanceJ: 185,
          },
        );
        world.createStaticBox(
          { x: 0, y: 1.1, z: -14.0 },
          { x: 2.0, y: 1.1, z: 0.1 },
          undefined,
          {
            material: 'BRICK_MASONRY',
            objectId: 'test_brick_wall',
            thicknessM: 0.2,
            penetrationResistanceJ: 1600,
          },
        );
        world.createStaticBox(
          { x: 0, y: 1.15, z: -22.0 },
          { x: 2.0, y: 1.15, z: 0.14 },
          undefined,
          {
            material: 'CONCRETE_INTACT',
            objectId: 'test_concrete_wall',
            thicknessM: 0.28,
            penetrationResistanceJ: 12000,
          },
        );

        const ai = new TacticalCombatAiSystem({
          rapierWorld: world,
          onEnemyFireTracer: (ev) => firedTracers.push(ev),
        });

        const woodGuard = createTargetHealthState(
          'guard_wood',
          'Wood Guard',
          { x: 0, y: 0, z: -6.55 },
          0,
          'SKINHEAD_PUNK',
        );
        const brickGuard = createTargetHealthState(
          'guard_brick',
          'Brick Guard',
          { x: 0, y: 0, z: -14.65 },
          0,
          'MILITIA_GUNNER',
        );
        const concreteGuard = createTargetHealthState(
          'guard_concrete',
          'Concrete Guard',
          { x: 0, y: 0, z: -22.75 },
          0,
          'HEAVY_ENFORCER',
        );

        ai.registerWaveTargets([woodGuard, brickGuard, concreteGuard], false);

        // Player hugs < 0.12m from the front face of each wall (horizDist ~ 0.7m, well inside <= 6.5m!)
        const hugPositions = [
          { x: 0, y: 1.55, z: -5.84 },   // 0.10m from wood front face (-5.94)
          { x: 0, y: 1.55, z: -13.8 },   // 0.10m from brick front face (-13.90)
          { x: 0, y: 1.55, z: -21.76 },  // 0.10m from concrete front face (-21.86)
        ];

        for (const playerPos of hugPositions) {
          for (let step = 0; step < 25; step++) {
            ai.update(0.05, [woodGuard, brickGuard, concreteGuard], playerPos);
          }
        }

        expect(ai.getAgent('guard_wood')!.state).toBe('PATROL_GUARD');
        expect(ai.getAgent('guard_brick')!.state).toBe('PATROL_GUARD');
        expect(ai.getAgent('guard_concrete')!.state).toBe('PATROL_GUARD');
        expect(firedTracers).toHaveLength(0);

        // Once player steps out past the right edge of the wood wall (x = 3.2, z = -5.8) with clear LOS,
        // the guard within <= 6.5m immediately spots the player!
        for (let step = 0; step < 6; step++) {
          ai.update(0.05, [woodGuard], { x: 3.2, y: 1.62, z: -5.8 });
        }
        expect(ai.getAgent('guard_wood')!.state).toBe('ALERTED_ENGAGING');

        ai.destroy();
      } finally {
        world.destroy();
      }
    });

    it('blocks alerted & downed enemy fire through solid wood/brick/sill cover (even at < 0.15m) and peeks wide enough around 3.0m walls', () => {
      // Part A: Sealed full-lane wood partition + low concrete sill protect cover-hugging player 100%
      const sealedWorld = new RapierPhysicsWorld();
      const sealedShots: EnemyTracerFireEvent[] = [];
      try {
        sealedWorld.createStaticBox(
          { x: 0, y: 1.2, z: -7.0 },
          { x: 9.5, y: 1.2, z: 0.06 },
          undefined,
          {
            material: 'WOOD_DRYWALL',
            objectId: 'sealed_wood_partition',
            thicknessM: 0.12,
            penetrationResistanceJ: 185,
          },
        );
        sealedWorld.createStaticBox(
          { x: 0, y: 0.65, z: -3.5 },
          { x: 3.0, y: 0.65, z: 0.12 },
          undefined,
          {
            material: 'CONCRETE_INTACT',
            objectId: 'low_concrete_barricade',
            thicknessM: 0.24,
            penetrationResistanceJ: 12000,
          },
        );

        const ai = new TacticalCombatAiSystem({
          rapierWorld: sealedWorld,
          initialPlayerHealth: 100,
          initialPlayerArmor: 50,
          onEnemyFireTracer: (ev) => sealedShots.push(ev),
        });

        // Enemy pressed close (0.42m) behind wood wall (previously 0.38m muzzle + 0.25m skip + 185J < 350J wallhacked!)
        const standingEnemy = createTargetHealthState(
          'standing_behind_wood',
          'Wood Gunner',
          { x: 0, y: 0, z: -7.48 },
          0,
          'MILITIA_GUNNER',
        );
        const downedEnemy = createTargetHealthState(
          'downed_behind_wood',
          'Downed Crawler',
          { x: -1.5, y: 0, z: -7.48 },
          0,
          'SKINHEAD_PUNK',
        );
        downedEnemy.rightLegFunctional = false;

        ai.registerWaveTargets([standingEnemy, downedEnemy], false);
        ai.notifyGunshotOrExplosion({ x: 0, y: 1.5, z: -6.8 }, 30.0);

        // Player hugs 0.10m in front of the wood wall (-6.94 + 0.10 = -6.84)
        for (let i = 0; i < 70; i++) {
          ai.update(0.05, [standingEnemy, downedEnemy], { x: 0, y: 1.55, z: -6.84 });
        }

        expect(sealedShots).toHaveLength(0);
        expect(ai.playerVitals.health).toBe(100);
        expect(ai.playerVitals.armor).toBe(50);

        // Now place an alerted gunner in front of the wood wall (z = -5.5), while player crouches (y = 1.05)
        // hugging 0.10m behind the 1.30m-tall concrete barricade at z = -3.5 (back/front faces -3.62 / -3.38)
        const frontGunner = createTargetHealthState(
          'front_gunner',
          'Front Gunner',
          { x: 0, y: 0, z: -5.5 },
          0,
          'MILITIA_GUNNER',
        );
        ai.registerWaveTargets([frontGunner], false);
        ai.notifyGunshotOrExplosion({ x: 0, y: 1.0, z: -3.2 }, 25.0);

        for (let i = 0; i < 60; i++) {
          ai.update(0.05, [frontGunner], { x: 0, y: 1.05, z: -3.28 });
        }
        expect(sealedShots.filter((s) => s.hitPlayer)).toHaveLength(0);
        expect(ai.playerVitals.health).toBe(100);
        expect(ai.playerVitals.armor).toBe(50);

        ai.destroy();
      } finally {
        sealedWorld.destroy();
      }

      // Part B: 3.0m-wide solid cover -> alerted enemy dynamically peeks past x = ±1.5m edge to acquire LOS and fire!
      const peekWorld = new RapierPhysicsWorld();
      const peekShots: EnemyTracerFireEvent[] = [];
      try {
        peekWorld.createStaticBox(
          { x: 0, y: 1.15, z: -8.0 },
          { x: 1.5, y: 1.15, z: 0.12 },
          undefined,
          {
            material: 'BRICK_MASONRY',
            objectId: 'wide_3m_brick_cover',
            thicknessM: 0.24,
            penetrationResistanceJ: 1600,
          },
        );

        const ai = new TacticalCombatAiSystem({
          rapierWorld: peekWorld,
          onEnemyFireTracer: (ev) => peekShots.push(ev),
        });

        const peeker = createTargetHealthState(
          'wide_wall_peeker',
          'Militia Peeker',
          { x: 0, y: 0, z: -9.2 },
          0,
          'MILITIA_GUNNER',
        );
        ai.registerWaveTargets([peeker], false);
        ai.notifyGunshotOrExplosion({ x: 0, y: 1.62, z: 0 }, 30.0);

        let maxLateralReachM = 0;
        for (let i = 0; i < 90; i++) {
          ai.update(0.05, [peeker], { x: 0, y: 1.62, z: 0 });
          maxLateralReachM = Math.max(maxLateralReachM, Math.abs(peeker.worldPosition.x));
        }

        // Must have stepped clear past the 1.5m half-width wall edge and fired around the corner!
        expect(maxLateralReachM).toBeGreaterThan(1.52);
        expect(peekShots.length).toBeGreaterThan(0);
        // Every shot that wasn't blocked by grazing the corner was fired only after clearing the wall!
        expect(peekShots.some((s) => !s.blockedByCover)).toBe(true);

        ai.destroy();
      } finally {
        peekWorld.destroy();
      }
    });

    it('keeps gut-shot, chest-shot, hypotensive, hypoxic, and leg-buckled combatants fighting till death', () => {
      const firedShots: EnemyTracerFireEvent[] = [];
      const ai = new TacticalCombatAiSystem({
        onEnemyFireTracer: (ev) => firedShots.push(ev),
      });

      const lastStandGunner = createTargetHealthState(
        'last_stand_gunner',
        'Wounded Militia',
        { x: 0, y: 0, z: -12.0 },
        0,
        'MILITIA_GUNNER',
      );
      ai.registerWaveTargets([lastStandGunner], false);
      ai.notifyGunshotOrExplosion({ x: 0, y: 1.6, z: 0 }, 30.0);

      // Inflict severe gut/chest trauma, hypotension (<72 mmHg), hypoxia (<74%), low consciousness (0.22 > 0.12), AND leg buckle!
      lastStandGunner.currentHp = 14;
      lastStandGunner.systolicBpMmHg = 62;
      lastStandGunner.oxygenSaturationPct = 66;
      lastStandGunner.consciousness = 0.22;
      lastStandGunner.painShock = 0.85;
      lastStandGunner.rupturedOrgans.add('ORGAN_LIVER');
      lastStandGunner.rupturedOrgans.add('ORGAN_LUNG_RIGHT');
      lastStandGunner.rightLegFunctional = false;
      ai.notifyEnemyHit(lastStandGunner, {
        hitZone: 'TORSO_LOWER_ABDOMEN',
        energyDepositedJ: 680,
      });

      // Step through brief hit flinch and verify mortally wounded, leg-buckled fighter actively returns fire!
      for (let i = 0; i < 45; i++) {
        ai.update(0.05, [lastStandGunner], { x: 0, y: 1.62, z: 0 });
      }
      expect(firedShots.length).toBeGreaterThan(0);
      expect(lastStandGunner.combatantStatusTag).toBe('LAST_STAND');

      // Verify airborne ragdoll temporarily prevents shooting, while grounded living ragdoll resumes shooting!
      lastStandGunner.isRagdollActive = true;
      lastStandGunner.posture = 'AIRBORNE_RAGDOLL';
      expect(ai.computeEnemyAimProfile(lastStandGunner, ai.getAgent('last_stand_gunner')).canReturnFire).toBe(false);

      lastStandGunner.posture = 'RAGDOLL_GROUNDED';
      lastStandGunner.weaponDropped = true; // Dropped 2-handed rifle on ragdoll ground settle, arms still intact!
      const countBeforeGrounded = firedShots.length;
      for (let i = 0; i < 40; i++) {
        ai.update(0.05, [lastStandGunner], { x: 0, y: 1.62, z: 0 });
      }
      expect(firedShots.length).toBeGreaterThan(countBeforeGrounded);

      // Dropping consciousness <= 0.12 or dying finally stops return fire
      lastStandGunner.consciousness = 0.08;
      expect(ai.computeEnemyAimProfile(lastStandGunner, ai.getAgent('last_stand_gunner')).canReturnFire).toBe(false);

      ai.destroy();
    });

    it('exhibits deterministic combatant resolve variety across arena squad and distinct wounded behaviors', () => {
      // 1. All 4 resolve personalities are represented deterministically across the 7 arena hostiles
      const profiles = new Set<CombatantResolveProfile>();
      for (const cfg of TARGET_CONFIGS) {
        const res = resolveDefaultCombatantProfile(cfg.id, cfg.archetype);
        profiles.add(res.resolveProfile);
      }
      expect(profiles.has('HARDENED_VETERAN')).toBe(true);
      expect(profiles.has('FANATIC_BERSERKER')).toBe(true);
      expect(profiles.has('GRITTY_REGULAR')).toBe(true);
      expect(profiles.has('PANICKED_SCRAPPER')).toBe(true);

      // 2. Compare wounded FANATIC_BERSERKER (charges forward at 1.0 adrenaline), PANICKED_SCRAPPER (high-cadence wide panic bursts), and HARDENED_VETERAN (composed tighter spread)
      const shotsByTarget: Record<string, EnemyTracerFireEvent[]> = {
        berserker: [],
        scrapper: [],
        veteran: [],
      };
      const ai = new TacticalCombatAiSystem({
        resolveProfileOverrides: {
          berserker: 'FANATIC_BERSERKER',
          scrapper: 'PANICKED_SCRAPPER',
          veteran: 'HARDENED_VETERAN',
        },
        onEnemyFireTracer: (ev) => shotsByTarget[ev.targetId]?.push(ev),
      });

      const berserker = createTargetHealthState('berserker', 'Berserker', { x: -3, y: 0, z: -12 }, 0, 'MILITIA_GUNNER');
      const scrapper = createTargetHealthState('scrapper', 'Scrapper', { x: 0, y: 0, z: -12 }, 0, 'MILITIA_GUNNER');
      const veteran = createTargetHealthState('veteran', 'Veteran', { x: 3, y: 0, z: -12 }, 0, 'MILITIA_GUNNER');

      ai.registerWaveTargets([berserker, scrapper, veteran], false);
      ai.notifyGunshotOrExplosion({ x: 0, y: 1.62, z: 0 }, 35);

      for (const t of [berserker, scrapper, veteran]) {
        t.currentHp = 48;
        t.painShock = 0.55;
        ai.notifyEnemyHit(t, { hitZone: 'TORSO_UPPER_THORAX', energyDepositedJ: 380 });
      }

      const startBerserkerZ = berserker.worldPosition.z;
      for (let i = 0; i < 65; i++) {
        ai.update(0.05, [berserker, scrapper, veteran], { x: 0, y: 1.62, z: 0 });
      }

      // Fanatic berserker surges to max adrenaline (1.0) and pushes aggressively forward (+Z toward player)
      expect(ai.getAgent('berserker')!.adrenaline).toBeCloseTo(1.0, 3);
      expect(berserker.worldPosition.z).toBeGreaterThan(startBerserkerZ + 1.2);
      expect(veteran.worldPosition.z).toBeLessThan(berserker.worldPosition.z - 0.8);

      // Panicked scrapper fires rapid panic bursts with wider spread than hardened veteran under identical wounds
      expect(shotsByTarget.scrapper.length).toBeGreaterThanOrEqual(shotsByTarget.veteran.length);
      const scrapperAim = ai.computeEnemyAimProfile(scrapper, ai.getAgent('scrapper'));
      const veteranAim = ai.computeEnemyAimProfile(veteran, ai.getAgent('veteran'));
      expect(scrapperAim.spreadMultiplier).toBeGreaterThan(veteranAim.spreadMultiplier * 1.25);

      ai.destroy();
    });

    it('disables standard combatants on hand/arm dismemberment while hardened veterans draw an off-hand Beretta M9 and stop only when BOTH hands are lost', () => {
      const regularShots: EnemyTracerFireEvent[] = [];
      const veteranShots: EnemyTracerFireEvent[] = [];
      const handAtShot = new Map<EnemyTracerFireEvent, { x: number; y: number; z: number }>();
      const sniperRightHandShots: EnemyTracerFireEvent[] = [];

      const ai = new TacticalCombatAiSystem({
        resolveProfileOverrides: {
          std_gunner: 'GRITTY_REGULAR',
          hardened_vet: 'HARDENED_VETERAN',
          hardened_sniper: 'HARDENED_VETERAN',
        },
        hardenedSidearmOverrides: {
          std_gunner: false,
          hardened_vet: true,
          hardened_sniper: true,
        },
        onEnemyFireTracer: (ev) => {
          if (ev.targetId === 'std_gunner') regularShots.push(ev);
          // Record the firing hand where it was at the moment of the shot: combatants now
          // juke between shots, so the hand's end-of-test position no longer matches.
          if (ev.targetId === 'hardened_vet') {
            veteranShots.push(ev);
            handAtShot.set(ev, { ...hardenedVet.ragdollBones.HAND_LEFT.position });
          }
          if (ev.targetId === 'hardened_sniper') {
            sniperRightHandShots.push(ev);
            handAtShot.set(ev, { ...hardenedSniper.ragdollBones.HAND_RIGHT.position });
          }
        },
      });

      const stdGunner = createTargetHealthState(
        'std_gunner',
        'Standard Gunner',
        { x: -2.0, y: 0, z: -8.0 },
        0,
        'MILITIA_GUNNER',
        false,
      );
      const hardenedVet = createTargetHealthState(
        'hardened_vet',
        'Hardened Enforcer',
        { x: 2.0, y: 0, z: -8.0 },
        0,
        'HEAVY_ENFORCER',
        false,
      );
      const hardenedSniper = createTargetHealthState(
        'hardened_sniper',
        'Hardened Sniper',
        { x: 0.0, y: 0, z: -10.0 },
        0,
        'SNIPER_OPERATIVE',
        true,
      );

      ai.registerWaveTargets([stdGunner, hardenedVet, hardenedSniper], false);
      ai.notifyGunshotOrExplosion({ x: 0, y: 1.62, z: 0 }, 30);

      // 1. Ballistically sever HAND_RIGHT on stdGunner & hardenedVet, and HAND_LEFT on hardenedSniper!
      for (const combatant of [stdGunner, hardenedVet]) {
        const handPt = combatant.ragdollBones.HAND_RIGHT.position;
        const shotOrigin = add(handPt, vec3(0, 0, 0.9));
        const aimDir = normalize(sub(handPt, shotOrigin));
        const rep = simulateShot(
          WEAPON_SILVER_TALON,
          AMMO_50AE_JHP,
          shotOrigin,
          aimDir,
          combatant,
          DEFAULT_ENVIRONMENT,
        );
        applyShotReportToTarget(combatant, rep);
        expect(combatant.severedZones.has('HAND_RIGHT')).toBe(true);
        expect(combatant.weaponDropped).toBe(true);
        expect(combatant.alive).toBe(true);
        ai.notifyEnemyHit(combatant, { hitZone: 'HAND_RIGHT', energyDepositedJ: rep.totalEnergyDepositedJ });
      }

      {
        const sniperHandPt = hardenedSniper.ragdollBones.HAND_LEFT.position;
        const sniperOrigin = add(sniperHandPt, vec3(0, 0, 0.9));
        const sniperRep = simulateShot(
          WEAPON_SILVER_TALON,
          AMMO_50AE_JHP,
          sniperOrigin,
          normalize(sub(sniperHandPt, sniperOrigin)),
          hardenedSniper,
          DEFAULT_ENVIRONMENT,
        );
        applyShotReportToTarget(hardenedSniper, sniperRep);
        expect(hardenedSniper.severedZones.has('HAND_LEFT')).toBe(true);
        expect(hardenedSniper.weaponDropped).toBe(true);
        ai.notifyEnemyHit(hardenedSniper, { hitZone: 'HAND_LEFT', energyDepositedJ: sniperRep.totalEnergyDepositedJ });
      }

      // Standard combatant is immediately disarmed and NEVER fires again!
      const stdAgent = ai.getAgent('std_gunner')!;
      expect(ai.computeEnemyAimProfile(stdGunner, stdAgent).canReturnFire).toBe(false);
      expect(stdGunner.posture).toBe('DISARMED');

      // Hardened veterans enter ~0.6s sidearmDrawTimerS transition on their remaining intact hand!
      const vetAgent = ai.getAgent('hardened_vet')!;
      const sniperAgent = ai.getAgent('hardened_sniper')!;
      expect(vetAgent.sidearmDrawing).toBe(true);
      expect(vetAgent.sidearmDrawTimerS).toBeCloseTo(SIDEARM_DRAW_DURATION_S, 2);
      expect(vetAgent.activeFiringHand).toBe('LEFT');
      expect(sniperAgent.activeFiringHand).toBe('RIGHT');
      expect(ai.computeEnemyAimProfile(hardenedVet, vetAgent).canReturnFire).toBe(false);

      // Step 0.3s (still mid-draw < 0.6s) -> zero shots yet
      for (let i = 0; i < 6; i++) {
        ai.update(0.05, [stdGunner, hardenedVet, hardenedSniper], { x: 0, y: 1.62, z: 0 });
      }
      expect(veteranShots).toHaveLength(0);
      expect(sniperRightHandShots).toHaveLength(0);
      expect(regularShots).toHaveLength(0);

      // Step another 2.2s -> hardened veterans complete draw, activate Beretta M9 in intact OTHER hand, and fire!
      for (let i = 0; i < 44; i++) {
        ai.update(0.05, [stdGunner, hardenedVet, hardenedSniper], { x: 0, y: 1.62, z: 0 });
      }
      expect(regularShots).toHaveLength(0);
      expect(stdGunner.posture).toBe('DISARMED');

      expect(vetAgent.sidearmActive).toBe(true);
      expect(vetAgent.activeFiringHand).toBe('LEFT');
      expect(veteranShots.length).toBeGreaterThanOrEqual(2);
      expect(sniperAgent.sidearmActive).toBe(true);
      expect(sniperAgent.activeFiringHand).toBe('RIGHT');
      expect(sniperRightHandShots.length).toBeGreaterThanOrEqual(2);

      const m9Shot = veteranShots[0];
      expect(m9Shot.usedBackupSidearm).toBe(true);
      expect(m9Shot.weaponId).toBe(BACKUP_SIDEARM_WEAPON_ID);
      expect(m9Shot.activeFiringHand).toBe('LEFT');
      expect(m9Shot.spreadMultiplier).toBeGreaterThanOrEqual(1.65);
      // Up to 1.35x more if the veteran fired while juking (moving-fire penalty).
      expect(m9Shot.spreadMultiplier).toBeLessThanOrEqual(1.98 * 1.35);
      expect(OFFHAND_SIDEARM_SPREAD_MULTIPLIER).toBeGreaterThanOrEqual(1.65);

      const distToLeftHand = distance(m9Shot.muzzleOriginWorld, handAtShot.get(m9Shot)!);
      expect(distToLeftHand).toBeLessThan(0.55);

      const sniperShot = sniperRightHandShots[0];
      expect(sniperShot.activeFiringHand).toBe('RIGHT');
      expect(
        distance(sniperShot.muzzleOriginWorld, handAtShot.get(sniperShot)!),
      ).toBeLessThan(0.55);

      // Now sever the hardened veteran's REMAINING second hand (HAND_LEFT) -> drops backup M9 and is finally disabled!
      const secondHandPt = hardenedVet.ragdollBones.HAND_LEFT.position;
      const secondOrigin = add(secondHandPt, vec3(0, 0, 0.9));
      const secondRep = simulateShot(
        WEAPON_SILVER_TALON,
        AMMO_50AE_JHP,
        secondOrigin,
        normalize(sub(secondHandPt, secondOrigin)),
        hardenedVet,
        DEFAULT_ENVIRONMENT,
      );
      applyShotReportToTarget(hardenedVet, secondRep);
      expect(hardenedVet.severedZones.has('HAND_LEFT')).toBe(true);
      ai.notifyEnemyHit(hardenedVet, { hitZone: 'HAND_LEFT', energyDepositedJ: secondRep.totalEnergyDepositedJ });

      const shotsBeforeBothLost = veteranShots.length;
      for (let i = 0; i < 30; i++) {
        ai.update(0.05, [hardenedVet], { x: 0, y: 1.62, z: 0 });
      }
      expect(vetAgent.sidearmActive).toBe(false);
      expect(vetAgent.sidearmDropped).toBe(true);
      expect(hardenedVet.posture).toBe('DISARMED');
      expect(ai.computeEnemyAimProfile(hardenedVet, vetAgent).canReturnFire).toBe(false);
      expect(veteranShots.length).toBe(shotsBeforeBothLost);

      ai.destroy();
    });

    it('mounts visible 3D weapon_beretta_m9 on t.rootEntity and poses intact off-hand arm toward player in CombatDirector', () => {
      const app = createHeadlessPlayCanvasApp();
      const requestedWeapons: string[] = [];

      const mockGlbRegistry = {
        isLoaded: () => false,
        instantiateWeapon: (weaponId: string) => {
          requestedWeapons.push(weaponId);
          const rootEntity = new pc.Entity(`MockGlb_${weaponId}`);
          return {
            weaponId: weaponId as never,
            rootEntity,
            boneNodes: new Map<string, pc.GraphNode>(),
            muzzleNode: null,
            ejectionNode: null,
            slideOrBoltNode: null,
            magazineNode: null,
            animComponent: null,
            playClip: () => false,
            destroy: () => rootEntity.destroy(),
          };
        },
        instantiateCombatant: () => {
          throw new Error('not loaded');
        },
      } as unknown as GlbModelRegistry;

      const materials = getOrCreateMaterials();
      const fx = new GoreAndBallisticsFxManager(app, materials);
      const hud = new HudController();
      const ai = new TacticalCombatAiSystem();
      const director = new CombatDirector(app, materials, fx, hud, undefined, {
        tacticalAi: ai,
        glbRegistry: mockGlbRegistry,
      });

      try {
        director.spawnAllTargets();
        // Pick target_5: KOSOVO HEAVY ENFORCER (HARDENED_VETERAN with backup sidearm)
        const enforcerMannequin = director.targets.find(
          (t) => t.healthState.targetId === 'target_5',
        )!;
        const hs = enforcerMannequin.healthState;

        // Attach skeletal Bone_* nodes for intact off-hand arm so we verify 3D bone posing too
        const boneUpperL = new pc.Entity('Bone_UPPER_ARM_LEFT');
        const boneForearmL = new pc.Entity('Bone_FOREARM_LEFT');
        const boneHandL = new pc.Entity('Bone_HAND_LEFT');
        enforcerMannequin.rootEntity.addChild(boneUpperL);
        enforcerMannequin.rootEntity.addChild(boneForearmL);
        enforcerMannequin.rootEntity.addChild(boneHandL);

        // Sever primary right arm (`FOREARM_RIGHT`) while keeping left arm/hand intact
        hs.severedZones.add('FOREARM_RIGHT');
        hs.severedZones.add('HAND_RIGHT');
        hs.rightArmFunctional = false;
        hs.weaponDropped = true;
        hs.primaryArmDisarmed = true;
        ai.notifyEnemyHit(hs, { hitZone: 'FOREARM_RIGHT', energyDepositedJ: 900 });

        // Step CombatDirector for 0.8s so sidearm finishes drawing and aims toward viewer at (0, 1.62, 0)
        for (let i = 0; i < 16; i++) {
          director.update(0.05, (i + 1) * 0.05, null, hud);
        }

        expect(requestedWeapons).toContain('weapon_beretta_m9');
        const m9Holder = enforcerMannequin.rootEntity.findByName('OffhandBackupHandgun_M9') as pc.Entity | null;
        expect(m9Holder).not.toBeNull();
        expect(m9Holder!.enabled).toBe(true);

        // Intact left hand should be raised to shoulder/aim height and extended forward (+Z toward viewer at z=0 from z=-14.85)
        expect(hs.ragdollBones.HAND_LEFT.position.z).toBeGreaterThan(
          hs.ragdollBones.UPPER_ARM_LEFT.position.z + 0.35,
        );
        expect(boneHandL.getPosition().z).toBeCloseTo(hs.ragdollBones.HAND_LEFT.position.z, 2);

        // Sever remaining left hand -> 3D Beretta M9 immediately hides/drops!
        hs.severedZones.add('HAND_LEFT');
        hs.leftArmFunctional = false;
        ai.notifyEnemyHit(hs, { hitZone: 'HAND_LEFT', energyDepositedJ: 800 });
        director.update(0.05, 1.0, null, hud);

        expect(m9Holder!.enabled).toBe(false);
      } finally {
        director.destroy();
        ai.destroy();
        fx.clearAll();
        app.destroy();
      }
    });
  });
});
