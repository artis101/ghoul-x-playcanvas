import { beforeAll, describe, expect, it } from 'vitest';
import * as pc from 'playcanvas';
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
import { computePanelRemainingAreaM2 } from '../src/core/destruction/woodPolygonClipper.ts';
import { TacticalCombatAiSystem } from '../src/engine/ai/tacticalCombatAi.ts';
import { CombatAudioEngine } from '../src/engine/audio/combatAudioEngine.ts';
import { CombatDirector } from '../src/engine/combat/combatDirector.ts';
import { DestructionManager } from '../src/engine/destruction/destructionManager.ts';
import { MayhemDirector } from '../src/engine/fx/mayhemDirector.ts';
import { GoreAndBallisticsFxManager } from '../src/engine/goreFx.ts';
import { HudController } from '../src/engine/hudController.ts';
import { getOrCreateMaterials } from '../src/engine/materials.ts';
import {
  initRapierPhysics,
  RapierPhysicsWorld,
} from '../src/engine/physics/rapierWorld.ts';
import { DESTRUCTION_ZONE_LAYOUT } from '../src/engine/world/arenaBuilder.ts';

interface UnifiedArenaHarness {
  app: pc.Application;
  rapierWorld: RapierPhysicsWorld;
  combatAudio: CombatAudioEngine;
  mayhemDirector: MayhemDirector;
  destructionManager: DestructionManager;
  tacticalAi: TacticalCombatAiSystem;
  hudController: HudController;
  fxManager: GoreAndBallisticsFxManager;
  combatDirector: CombatDirector;
  stepFrames(frameCount: number, rawDt?: number): void;
  destroy(): void;
}

function createUnifiedArenaHarness(): UnifiedArenaHarness {
  const canvasStub = { width: 1280, height: 720 };
  const device = new pc.NullGraphicsDevice(canvasStub);
  const app = new pc.Application(canvasStub as unknown as HTMLCanvasElement, {
    graphicsDevice: device,
  });

  const rapierWorld = new RapierPhysicsWorld();
  const materials = getOrCreateMaterials();
  const hudController = new HudController();
  const combatAudio = new CombatAudioEngine({ autoUnlockOnGesture: false });
  const fxManager = new GoreAndBallisticsFxManager(app, materials);

  let combatDirectorRef: CombatDirector | null = null;
  let destructionManagerRef: DestructionManager | null = null;
  let tacticalAiRef: TacticalCombatAiSystem | null = null;

  const mayhemDirector = new MayhemDirector({
    app,
    rapierWorld,
    bulletTimeOptions: {
      onVignetteUpdate: (st) => hudController.updateBulletTimeHud(st),
    },
    onCasingBounce: (ev) => {
      combatAudio.playShellCasingBounce(
        ev.isShotgunHull ? 'SHOTGUN_HULL' : 'BRASS',
        ev.position,
        vec3(0, 1.62, 0)
      );
    },
    onExplosionBlast: (blast) => {
      destructionManagerRef?.applyBlast(blast);
      combatDirectorRef?.applyExternalExplosionTrauma(blast, 'HAZARD BARREL');
      tacticalAiRef?.notifyGunshotOrExplosion(blast.centerWorld, 45.0, 0.78);
    },
  });

  const destructionManager = new DestructionManager(app, rapierWorld, {
    materials,
    barrelManager: mayhemDirector.barrels,
    combatAudio,
    getListenerPos: () => vec3(0, 1.62, 0),
    buildDefaultArena: true,
  });
  destructionManagerRef = destructionManager;

  const tacticalAi = new TacticalCombatAiSystem({
    app,
    rapierWorld,
  });
  tacticalAiRef = tacticalAi;

  const combatDirector = new CombatDirector(
    app,
    materials,
    fxManager,
    hudController,
    undefined,
    {
      mayhemDirector,
      tacticalAi,
      combatAudio,
    }
  );
  combatDirectorRef = combatDirector;

  combatDirector.environmentRayInterceptor = (
    origin,
    dir,
    maxDistM,
    energyJ,
    speedMs,
    caliberDiameterM,
    isAp
  ) =>
    destructionManager.interceptRaySegment(
      origin,
      dir,
      maxDistM,
      energyJ,
      speedMs,
      caliberDiameterM,
      isAp
    );

  combatDirector.onExplosionBlast = (center, radiusM, peakImpulseNs, peakEnergyJ) => {
    const blast = { centerWorld: center, radiusM, peakImpulseNs, peakEnergyJ };
    destructionManager.applyBlast(blast);
    mayhemDirector.notifyExternalExplosion(blast, 0);
    tacticalAi.notifyGunshotOrExplosion(center, 45.0, 0.72);
  };

  combatDirector.spawnAllTargets();

  let elapsedS = 0;
  const stepFrames = (frameCount: number, rawDt = 1 / 60): void => {
    for (let i = 0; i < frameCount; i++) {
      const scaledDt = mayhemDirector.update(rawDt);
      elapsedS += scaledDt;
      combatAudio.setTimeScale(mayhemDirector.bulletTime.timeScale);
      combatAudio.update(rawDt);
      destructionManager.update(scaledDt);
      combatDirector.update(scaledDt, elapsedS, null, hudController);
      fxManager.update(scaledDt, false);
    }
  };

  return {
    app,
    rapierWorld,
    combatAudio,
    mayhemDirector,
    destructionManager,
    tacticalAi,
    hudController,
    fxManager,
    combatDirector,
    stepFrames,
    destroy(): void {
      combatDirector.destroy();
      tacticalAi.destroy();
      destructionManager.destroy();
      mayhemDirector.destroy();
      combatAudio.destroy();
      rapierWorld.destroy();
      app.destroy();
    },
  };
}

describe('Phase 3 Grand Unified Max Mayhem Arena Integration', () => {
  beforeAll(async () => {
    await initRapierPhysics();
  });

  it('penetrates R6 wood shoot-house wall, wounds hostile + BVH physiology behind it, and passes re-shots through carved Clipper2 hole with 0 J loss', () => {
    const arena = createUnifiedArenaHarness();
    try {
      expect(arena.combatDirector.targets).toHaveLength(7);

      const woodId = DESTRUCTION_ZONE_LAYOUT.woodShootHouseWall.id;
      const woodWall = arena.destructionManager.woodWalls.getWall(woodId);
      expect(woodWall).toBeDefined();
      const initialWoodArea = computePanelRemainingAreaM2(woodWall!.panelState);

      // Target 1 is stationed at (-2.3, 0, -8.35) behind wood_shoot_house_wall at z = -7.2m.
      // Aim at target_1's supraclavicular/upper-thorax zone (x = -2.26, y = 1.48, z = -8.35).
      const shooterOrigin = vec3(-2.26, 1.48, -2.5);
      const aimTarget = vec3(-2.26, 1.49, -8.35);
      const aimDir = normalize(sub(aimTarget, shooterOrigin));

      const target1 = arena.combatDirector.targets[1];
      expect(target1.healthState.targetId).toBe('target_1');
      const initialHp = target1.healthState.currentHp;

      arena.combatAudio.playWeaponFire(WEAPON_MSG90.id, AMMO_762_NATO_AP_TUNGSTEN.type, true);
      arena.mayhemDirector.onPlayerWeaponFired(
        shooterOrigin,
        aimDir,
        WEAPON_MSG90,
        AMMO_762_NATO_AP_TUNGSTEN
      );
      arena.tacticalAi.notifyGunshotOrExplosion(shooterOrigin, 40.0, 0.24);
      arena.combatDirector.fireWeapon(
        WEAPON_MSG90,
        AMMO_762_NATO_AP_TUNGSTEN,
        shooterOrigin,
        aimDir
      );

      // 1. Clipper2 carved a real polygon hole in the wood wall
      const areaAfterRifle = computePanelRemainingAreaM2(woodWall!.panelState);
      expect(areaAfterRifle).toBeLessThan(initialWoodArea);

      // 2. Hostile behind wood wall took attenuated ballistic damage + 3D BVH internal trauma
      expect(target1.healthState.currentHp).toBeLessThan(initialHp);
      expect(arena.combatDirector.lastInternalBallisticsReport).not.toBeNull();
      expect(arena.combatDirector.lastInternalBallisticsReport!.hitOuterShell).toBe(true);

      // 3. Audio diagnostics recorded weapon fire, wood material impact, and gore foley
      const audioDiag = arena.combatAudio.getDiagnostics();
      expect(audioDiag.weaponFireCount).toBe(1);
      expect(audioDiag.materialImpactCount).toBeGreaterThanOrEqual(1);
      expect(audioDiag.goreImpactCount).toBeGreaterThanOrEqual(1);

      // 4. Carve a wide shotgun breach hole at (-1.85, 1.35, -7.2) and verify a follow-up 5.56mm ray
      //    through the exact hole center loses ZERO Joules!
      const breachOrigin = vec3(-1.85, 1.35, -5.6);
      const breachDir = vec3(0, 0, -1);
      arena.combatDirector.fireWeapon(WEAPON_M590, AMMO_12G_00_BUCK, breachOrigin, breachDir);

      const reshotThroughHole = arena.destructionManager.interceptRaySegment(
        breachOrigin,
        breachDir,
        3.0,
        1700,
        910,
        0.0057,
        false
      );
      expect(reshotThroughHole.blocked).toBe(false);
      expect(reshotThroughHole.remainingEnergyJ).toBe(1700);
    } finally {
      arena.destroy();
    }
  });

  it('shatters both 256 Marching-Squares and Runtime Voronoi glass windows, wounding gallery sentries behind each pane', () => {
    const arena = createUnifiedArenaHarness();
    try {
      const marchingId = DESTRUCTION_ZONE_LAYOUT.glassMarchingWindow.id;
      const voronoiId = DESTRUCTION_ZONE_LAYOUT.glassVoronoiWindow.id;
      const marchingWin = arena.destructionManager.glassSystem.marchingWindows.find(
        (w) => w.id === marchingId
      );
      const voronoiWin = arena.destructionManager.glassSystem.voronoiWindows.find(
        (w) => w.id === voronoiId
      );
      expect(marchingWin).toBeDefined();
      expect(voronoiWin).toBeDefined();
      expect(marchingWin!.isBrokenAtWorldPoint(vec3(-5.5, 1.385, -6.5))).toBe(false);
      expect(voronoiWin!.shattered).toBe(false);

      // West lane: shoot through Marching-Squares window (x = -5.5, z = -6.5) into target_2 (x = -5.5, z = -7.9)
      const target2 = arena.combatDirector.targets[2];
      const t2InitialHp = target2.healthState.currentHp;
      const westOrigin = vec3(-5.5, 1.38, -2.5);
      const westDir = normalize(sub(vec3(-5.5, 1.39, -7.9), westOrigin));

      arena.combatDirector.fireWeapon(WEAPON_M4A1, AMMO_556_NATO_M855, westOrigin, westDir);

      expect(marchingWin!.isBrokenAtWorldPoint(vec3(-5.5, 1.385, -6.5))).toBe(true);
      expect(arena.destructionManager.glassSystem.activeInstancedTriangleCount).toBeGreaterThan(0);
      expect(target2.healthState.currentHp).toBeLessThan(t2InitialHp);

      // East lane: shoot through Voronoi window (x = 5.5, z = -6.5) into target_3's unarmored head/neck (x = 5.5, y = 1.62, z = -8.1)
      const target3 = arena.combatDirector.targets[3];
      const t3InitialHp = target3.healthState.currentHp;
      const eastOrigin = vec3(5.5, 1.62, -2.5);
      const eastDir = normalize(sub(vec3(5.5, 1.63, -8.1), eastOrigin));

      arena.combatDirector.fireWeapon(
        WEAPON_MSG90,
        AMMO_762_NATO_AP_TUNGSTEN,
        eastOrigin,
        eastDir
      );

      expect(voronoiWin!.shattered).toBe(true);
      expect(arena.destructionManager.glassSystem.activeVoronoiShardCount).toBeGreaterThan(8);
      expect(target3.healthState.currentHp).toBeLessThan(t3InitialHp);

      // Subsequent shot through shattered Voronoi window loses 0 J
      const clearPass = arena.destructionManager.interceptRaySegment(
        eastOrigin,
        eastDir,
        5.0,
        1650,
        900,
        0.0057,
        false
      );
      expect(clearPass.blocked).toBe(false);
      expect(clearPass.remainingEnergyJ).toBe(1650);
    } finally {
      arena.destroy();
    }
  });

  it('chains red hazard barrel explosions into BFS brick/concrete collapse + GHOUL physiology blast trauma, supports [Z] Bullet-Time, and resets cleanly', () => {
    const arena = createUnifiedArenaHarness();
    try {
      const brickId = DESTRUCTION_ZONE_LAYOUT.instancedBrickWall.id;
      const concreteId = DESTRUCTION_ZONE_LAYOUT.voronoiConcreteWall.id;
      const brickWall = arena.destructionManager.brickWalls.getWall(brickId);
      const concreteWall = arena.destructionManager.concreteWalls.getWall(concreteId);
      expect(brickWall).toBeDefined();
      expect(concreteWall).toBeDefined();
      expect(brickWall!.detachedBrickCount).toBe(0);
      expect(concreteWall!.detachedChunkCount).toBe(0);

      // Shoot hazard_barrel_1 at (-2.35, 0, -12.2) with Silver Talon .50 AE FMJ
      const barrel1 = arena.mayhemDirector.barrels.barrels[1];
      const barrel2 = arena.mayhemDirector.barrels.barrels[2];
      expect(barrel1.state).toBe('INTACT');
      expect(barrel2.state).toBe('INTACT');

      const shotOrigin = vec3(-2.35, 0.5, -6.0);
      const shotDir = vec3(0, 0, -1);
      arena.combatDirector.fireWeapon(
        WEAPON_SILVER_TALON,
        AMMO_50AE_FMJ_SOLID,
        shotOrigin,
        shotDir
      );

      expect(barrel1.state).toBe('IGNITED_HISSING');

      // Step 26 frames (0.43s > 0.18s primary fuse + 0.08s sympathetic chain fuse)
      arena.stepFrames(26, 1 / 60);

      // Both barrels detonated via chain reaction!
      expect(barrel1.state).toBe('DETONATED');
      expect(barrel2.state).toBe('DETONATED');

      // Running-bond brick wall & 36-cell MultiDraw Voronoi concrete barrier both suffered BFS chunk detachment!
      expect(brickWall!.detachedBrickCount).toBeGreaterThan(0);
      expect(concreteWall!.detachedChunkCount).toBeGreaterThan(0);

      // Hostiles 4 (behind brick wall) & 5 (behind concrete wall) suffered blast shrapnel trauma & ragdoll launch!
      const target4 = arena.combatDirector.targets[4];
      const target5 = arena.combatDirector.targets[5];
      expect(target4.healthState.currentHp).toBeLessThan(target4.healthState.maxHp);
      expect(target5.healthState.currentHp).toBeLessThan(target5.healthState.maxHp);
      expect(target4.healthState.isRagdollActive).toBe(true);
      expect(target5.healthState.isRagdollActive).toBe(true);
      expect(arena.combatAudio.getDiagnostics().explosionCount).toBeGreaterThanOrEqual(2);

      // Toggle [Z] Reflex Bullet-Time and verify timeScale dilates smoothly below 1.0x
      const activated = arena.mayhemDirector.bulletTime.toggleReflex();
      expect(activated).toBe(true);
      arena.combatAudio.playSlowMoTransition(activated);
      arena.stepFrames(12, 1 / 60);
      expect(arena.mayhemDirector.bulletTime.timeScale).toBeLessThan(0.5);
      expect(arena.combatAudio.getTimeScale()).toBeCloseTo(
        arena.mayhemDirector.bulletTime.timeScale,
        4
      );
      arena.mayhemDirector.bulletTime.setReflexActive(false);

      // Full Breaching Wave Reset restores intact walls, barrels, and 7 healthy combatants!
      arena.destructionManager.resetAll();
      arena.mayhemDirector.resetWave(true);
      arena.tacticalAi.notifyWaveCleared();
      arena.combatDirector.spawnAllTargets();

      const restoredBrick = arena.destructionManager.brickWalls.getWall(brickId);
      const restoredConcrete = arena.destructionManager.concreteWalls.getWall(concreteId);
      expect(restoredBrick!.detachedBrickCount).toBe(0);
      expect(restoredConcrete!.detachedChunkCount).toBe(0);
      expect(arena.mayhemDirector.barrels.barrels.every((b) => b.state === 'INTACT')).toBe(true);
      expect(arena.combatDirector.targets).toHaveLength(7);
      expect(
        arena.combatDirector.targets.every(
          (t) =>
            t.healthState.alive &&
            t.healthState.currentHp === t.healthState.maxHp &&
            t.healthState.bloodVolumeMl === 5000
        )
      ).toBe(true);
    } finally {
      arena.destroy();
    }
  });
});
