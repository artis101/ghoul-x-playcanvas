import * as pc from 'playcanvas';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_12G_00_BUCK,
  AMMO_50AE_FMJ_SOLID,
  AMMO_556_NATO_M855,
  AMMO_762_NATO_AP_TUNGSTEN,
  WEAPON_M4A1,
  WEAPON_M590,
  WEAPON_MSG90,
  WEAPON_SILVER_TALON,
} from '../src/core/ballistics/weapons.ts';
import { TacticalCombatAiSystem } from '../src/engine/ai/tacticalCombatAi.ts';
import { GlbModelRegistry } from '../src/engine/assets/glbLoader.ts';
import { wireCombatDirectorInterceptors } from '../src/engine/app/combatEventWiring.ts';
import { CombatAudioEngine } from '../src/engine/audio/combatAudioEngine.ts';
import { CombatDirector } from '../src/engine/combat/combatDirector.ts';
import { DestructionManager } from '../src/engine/destruction/destructionManager.ts';
import { MayhemDirector } from '../src/engine/fx/mayhemDirector.ts';
import { GoreAndBallisticsFxManager } from '../src/engine/goreFx.ts';
import { HudController } from '../src/engine/hudController.ts';
import { getOrCreateMaterials } from '../src/engine/materials.ts';
import { initRapierPhysics, RapierPhysicsWorld } from '../src/engine/physics/rapierWorld.ts';
import { ArenaBuilder, DESTRUCTION_ZONE_LAYOUT } from '../src/engine/world/arenaBuilder.ts';

function createHeadlessArena() {
  const canvasStub = { width: 1280, height: 720 };
  const device = new pc.NullGraphicsDevice(canvasStub);
  const app = new pc.Application(canvasStub as unknown as HTMLCanvasElement, {
    graphicsDevice: device,
  });
  const rapierWorld = new RapierPhysicsWorld();
  const materials = getOrCreateMaterials();
  const hudController = new HudController();
  const combatAudio = new CombatAudioEngine();
  const glbRegistry = new GlbModelRegistry(app);
  const fxManager = new GoreAndBallisticsFxManager(app, materials, glbRegistry);
  const arenaBuilder = new ArenaBuilder(app, materials, rapierWorld);
  arenaBuilder.build();

  let destructionManager!: DestructionManager;
  let combatDirector!: CombatDirector;
  let tacticalAi!: TacticalCombatAiSystem;

  const mayhemDirector = new MayhemDirector({
    app,
    rapierWorld,
    sympatheticChainFuseS: 0,
    onExplosionBlast: (blast) => {
      destructionManager.applyBlast(blast);
      combatDirector.applyExternalExplosionTrauma(blast, 'HAZARD BARREL');
    },
  });

  destructionManager = new DestructionManager(app, rapierWorld, {
    materials,
    barrelManager: mayhemDirector.barrels,
    combatAudio,
    buildDefaultArena: true,
  });

  tacticalAi = new TacticalCombatAiSystem({
    app,
    rapierWorld,
    isLineOfSightBlocked: (from, to) => destructionManager.isLineOfSightBlocked(from, to),
    interceptEnemyShotCover: (origin, dir, maxDistM) =>
      destructionManager.interceptEnemyShot(origin, dir, maxDistM),
  });

  combatDirector = new CombatDirector(app, materials, fxManager, hudController, glbRegistry, {
    mayhemDirector,
    tacticalAi,
    combatAudio,
    glbRegistry,
    isLineOfSightBlocked: (from, to) => destructionManager.isLineOfSightBlocked(from, to),
    getCoverBreachVersion: () => destructionManager.breachVersion,
  });

  wireCombatDirectorInterceptors(combatDirector, destructionManager, mayhemDirector, tacticalAi);
  combatDirector.spawnAllTargets();
  destructionManager.update(1 / 60);

  return {
    app,
    rapierWorld,
    mayhemDirector,
    destructionManager,
    combatDirector,
    tacticalAi,
    destroy(): void {
      combatDirector.targets.forEach((t) => t.destroy());
      tacticalAi.destroy();
      destructionManager.destroy();
      mayhemDirector.destroy();
      arenaBuilder.destroy();
      combatAudio.destroy();
      rapierWorld.destroy();
      app.destroy();
    },
  };
}

describe('Destroyed Surfaces Let Bullets, Enemy Fire, and Visual Tracers Through Cleanly', () => {
  beforeAll(async () => {
    await initRapierPhysics();
  });

  it('passes bullets, tracers (0 mid-air sparks), and enemy shots through wood holes, grenade-blasted studs, and shattered windows', () => {
    const arena = createHeadlessArena();
    try {
      // 1. M67-scale grenade blast in front of wood shoot-house wall (-2.3, 1.2, -7.2) at 3.2m standoff
      //    blows open both the wood panel AND interior 2x4 stud spans inside the breach!
      arena.destructionManager.applyBlast({
        centerWorld: vec3(-2.3, 1.25, -4.0),
        radiusM: 7.5,
        peakImpulseNs: 260,
        peakEnergyJ: 6200,
      });
      arena.destructionManager.update(1 / 60);

      const woodId = DESTRUCTION_ZONE_LAYOUT.woodShootHouseWall.id;
      expect(arena.destructionManager.woodWalls.getWallBrokenStudSectionCount(woodId)).toBeGreaterThan(0);

      // Clear transient sparks/plumes before firing through the blasted wood opening
      arena.mayhemDirector.impactSparkPool.clear();
      const originWood = vec3(-2.3, 1.35, -3.0);
      const dirWood = normalize(sub(vec3(-2.3, 1.35, -8.35), originWood));

      arena.mayhemDirector.onPlayerWeaponFired(originWood, dirWood, WEAPON_M4A1, AMMO_556_NATO_M855);
      // Zero mid-air impact sparks spawned on the open wood wall collider!
      expect(arena.mayhemDirector.impactSparkPool.activeCount).toBe(0);

      const woodPass = arena.destructionManager.interceptRaySegment(
        originWood,
        dirWood,
        5.5,
        480,
        360,
        0.009,
        false
      );
      expect(woodPass.blocked).toBe(false);
      expect(woodPass.remainingEnergyJ).toBe(480);

      const enemyWoodPass = arena.destructionManager.interceptEnemyShot(
        vec3(-2.3, 1.35, -8.35),
        vec3(0, 0, 1),
        4.5
      );
      expect(enemyWoodPass.blocked).toBe(false);

      // 2. Break both Marching-Squares (west) and Voronoi (east) glass windows, then verify
      //    follow-up shots spawn 0 sparks on the broken glass colliders and pass with 0 J loss!
      const westOrigin = vec3(-5.5, 1.4, -2.5);
      const eastOrigin = vec3(5.5, 1.4, -2.5);
      const straightBack = vec3(0, 0, -1);

      arena.combatDirector.fireWeapon(WEAPON_MSG90, AMMO_762_NATO_AP_TUNGSTEN, westOrigin, straightBack);
      arena.combatDirector.fireWeapon(WEAPON_MSG90, AMMO_762_NATO_AP_TUNGSTEN, eastOrigin, straightBack);

      arena.mayhemDirector.impactSparkPool.clear();
      arena.mayhemDirector.onPlayerWeaponFired(westOrigin, straightBack, WEAPON_M4A1, AMMO_556_NATO_M855);
      arena.mayhemDirector.onPlayerWeaponFired(eastOrigin, straightBack, WEAPON_M4A1, AMMO_556_NATO_M855);
      expect(arena.mayhemDirector.impactSparkPool.activeCount).toBe(0);

      expect(arena.destructionManager.interceptEnemyShot(vec3(-5.5, 1.4, -7.8), vec3(0, 0, 1), 4.0).blocked).toBe(false);
      expect(arena.destructionManager.interceptEnemyShot(vec3(5.5, 1.4, -7.8), vec3(0, 0, 1), 4.0).blocked).toBe(false);
    } finally {
      arena.destroy();
    }
  });

  it('dislodges off-center struck bricks on >1,400 J hits and clears blasted concrete chunks so bullets pass through breaches', () => {
    const arena = createHeadlessArena();
    try {
      // 1. Off-center (+0.08m near right edge!) .50 AE FMJ hit (2,200 J > 1,400 J) on masonry brick wall
      const brickId = DESTRUCTION_ZONE_LAYOUT.instancedBrickWall.id;
      const brickCenter = arena.destructionManager.brickWalls.getBrickWorldCenter(brickId, 14 * 13 + 6)!;
      expect(brickCenter).not.toBeNull();

      const offCenterX = brickCenter.x + 0.08;
      const shotOrigin = vec3(offCenterX, brickCenter.y, -8.5);
      const shotDir = vec3(0, 0, -1);

      const firstHeavy = arena.destructionManager.interceptRaySegment(
        shotOrigin,
        shotDir,
        6.0,
        2200,
        470,
        0.0127,
        false
      );
      expect(firstHeavy.blocked).toBe(false);

      // Step physics so dislodged brick clears the hole
      for (let i = 0; i < 35; i++) {
        arena.destructionManager.update(1 / 60);
      }

      // Weak 500 J pistol round AND enemy shot now pass cleanly through the dislodged brick opening!
      const pistolFollowUp = arena.destructionManager.interceptRaySegment(
        shotOrigin,
        shotDir,
        5.0,
        500,
        355,
        0.009,
        false
      );
      expect(pistolFollowUp.blocked).toBe(false);
      expect(pistolFollowUp.remainingEnergyJ).toBe(500);
      expect(
        arena.destructionManager.interceptEnemyShot(
          vec3(offCenterX, brickCenter.y, -13.5),
          vec3(0, 0, 1),
          3.0
        ).blocked
      ).toBe(false);

      // 2. Blast Voronoi concrete wall (x = 2.6, z = -13.5) and step physics -> chunks eject clear out of breach!
      const concreteId = DESTRUCTION_ZONE_LAYOUT.voronoiConcreteWall.id;
      const concreteWall = arena.destructionManager.concreteWalls.getWall(concreteId)!;
      arena.destructionManager.applyBlast({
        centerWorld: vec3(2.6, 1.25, -13.15),
        radiusM: 2.2,
        peakImpulseNs: 260,
        peakEnergyJ: 24000,
      });
      expect(concreteWall.detachedChunkCount).toBeGreaterThan(0);

      for (let i = 0; i < 45; i++) {
        arena.destructionManager.update(1 / 60);
      }

      // Respawn targets (in case nearby hazard barrel blast killed target_5) and shoot through the blasted concrete opening!
      arena.combatDirector.spawnAllTargets();
      const target5 = arena.combatDirector.targets[5];
      const hpBefore = target5.healthState.currentHp;
      expect(hpBefore).toBeGreaterThan(0);

      const concOrigin = vec3(2.6, 1.35, -10.0);
      const concDir = normalize(sub(vec3(2.6, 1.36, -14.7), concOrigin));
      expect(
        arena.destructionManager.interceptRaySegment(
          concOrigin,
          concDir,
          4.7,
          500,
          355,
          0.009,
          false
        ).blocked
      ).toBe(false);
      expect(
        arena.destructionManager.interceptEnemyShot(
          vec3(2.6, 1.35, -14.5),
          vec3(0, 0, 1),
          4.0
        ).blocked
      ).toBe(false);

      arena.combatDirector.fireWeapon(WEAPON_SILVER_TALON, AMMO_50AE_FMJ_SOLID, concOrigin, concDir);
      expect(target5.healthState.currentHp).toBeLessThan(hpBefore);
    } finally {
      arena.destroy();
    }
  });

  it('filters out blocked buckshot pellets when firing partially across solid cover into a target', () => {
    const arena = createHeadlessArena();
    try {
      // Place two identical test comparisons using target_5 behind the right edge of a concrete barrier:
      // Place a solid narrow steel blocker right in front of half the shotgun cone
      const target = arena.combatDirector.targets[0];
      const tPos = target.healthState.worldPosition;
      const blockerHandle = arena.rapierWorld.createStaticBox(
        { x: tPos.x - 0.14, y: 1.35, z: tPos.z + 1.2 },
        { x: 0.16, y: 0.6, z: 0.1 },
        undefined,
        {
          material: 'STEEL',
          objectId: 'partial_buckshot_blocker',
          thicknessM: 0.2,
          penetrationResistanceJ: 25000,
        }
      );

      const shotOrigin = vec3(tPos.x - 0.02, 1.35, tPos.z + 4.5);
      const aimDir = normalize(sub(vec3(tPos.x - 0.02, 1.35, tPos.z), shotOrigin));

      let unblockedHits = 0;
      let blockedHits = 0;
      for (let p = 0; p < 9; p++) {
        const res = arena.destructionManager.interceptRaySegment(
          shotOrigin,
          vec3(aimDir.x + (p < 4 ? -0.04 : 0.03), aimDir.y, aimDir.z),
          4.5,
          280,
          400,
          0.0084,
          false
        );
        if (res.blocked) blockedHits++;
        else unblockedHits++;
      }
      expect(blockedHits).toBeGreaterThan(0);
      expect(unblockedHits).toBeGreaterThan(0);

      const hpBefore = target.healthState.currentHp;
      arena.combatDirector.fireWeapon(WEAPON_M590, AMMO_12G_00_BUCK, shotOrigin, aimDir);
      const damageWithPartialCover = hpBefore - target.healthState.currentHp;
      expect(damageWithPartialCover).toBeGreaterThan(0);

      arena.rapierWorld.removeCollider(blockerHandle);
      arena.combatDirector.spawnAllTargets();
      const freshTarget = arena.combatDirector.targets[0];
      const freshHpBefore = freshTarget.healthState.currentHp;
      arena.combatDirector.fireWeapon(WEAPON_M590, AMMO_12G_00_BUCK, shotOrigin, aimDir);
      const damageWithoutCover = freshHpBefore - freshTarget.healthState.currentHp;
      expect(damageWithPartialCover).toBeLessThan(damageWithoutCover);
    } finally {
      arena.destroy();
    }
  });
});
