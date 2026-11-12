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
import {
  HudController,
  type ProjectedTargetTriageEntry,
} from '../src/engine/hudController.ts';
import { getOrCreateMaterials } from '../src/engine/materials.ts';
import {
  initRapierPhysics,
  RapierPhysicsWorld,
} from '../src/engine/physics/rapierWorld.ts';
import {
  ArenaBuilder,
  DESTRUCTION_ZONE_LAYOUT,
} from '../src/engine/world/arenaBuilder.ts';

interface UnifiedArenaHarness {
  app: pc.Application;
  rapierWorld: RapierPhysicsWorld;
  arenaBuilder: ArenaBuilder;
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

  const arenaBuilder = new ArenaBuilder(app, materials, rapierWorld);
  arenaBuilder.build();

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
    isLineOfSightBlocked: (from, to) => destructionManager.isLineOfSightBlocked(from, to),
    interceptEnemyShotCover: (origin, dir, maxDistM) =>
      destructionManager.interceptEnemyShot(origin, dir, maxDistM),
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
      isLineOfSightBlocked: (from, to) => destructionManager.isLineOfSightBlocked(from, to),
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
    arenaBuilder,
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
      arenaBuilder.destroy();
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

  it('detonates a shot hazard barrel into a localized brick breach + blast trauma without chaining across arena stations, supports [Z] Bullet-Time, and resets cleanly', () => {
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
      const [barrel0, barrel1, barrel2, barrel3] = arena.mayhemDirector.barrels.barrels;
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

      // Step 26 frames (0.43s > 0.18s primary fuse + any chain fuse)
      arena.stepFrames(26, 1 / 60);

      // Only barrel_1 detonates — no arena-wide chain reaction across other stations!
      expect(barrel1.state).toBe('DETONATED');
      expect(barrel0.state).toBe('INTACT');
      expect(barrel2.state).toBe('INTACT');
      expect(barrel3.state).toBe('INTACT');

      // Running-bond brick wall suffers a localized breach (not total collapse), while concrete wall stays intact!
      expect(brickWall!.detachedBrickCount).toBeGreaterThan(0);
      expect(brickWall!.intactBrickCount).toBeGreaterThan(0);
      expect(concreteWall!.detachedChunkCount).toBe(0);

      // Hostile 4 (behind brick wall) suffers blast trauma, while Hostile 5 (behind concrete wall) is untouched!
      const target4 = arena.combatDirector.targets[4];
      const target5 = arena.combatDirector.targets[5];
      expect(target4.healthState.currentHp).toBeLessThan(target4.healthState.maxHp);
      expect(target4.healthState.isRagdollActive).toBe(true);
      expect(target5.healthState.currentHp).toBe(target5.healthState.maxHp);
      expect(target5.healthState.isRagdollActive).toBe(false);
      expect(arena.combatAudio.getDiagnostics().explosionCount).toBe(1);

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

  it('registers Rapier colliders on ArenaBuilder perimeter concrete barriers & marker posts, blocking sight, shots, and walk-through', () => {
    const arena = createUnifiedArenaHarness();
    try {
      // 10 concrete distance marker posts + 8 perimeter concrete barriers = 18 static colliders
      expect(arena.arenaBuilder.registeredColliderCount).toBe(18);

      // Barrier_-9.5_-8 sits at (-9.5, 0.675, -8.0) with scale 1.1 x 1.35 x 7.5 -> x in [-10.05, -8.95], y in [0, 1.35]
      const enemyEye = vec3(-6.0, 1.15, -8.0);
      const crouchedPlayerHuggingBarrier = vec3(-10.15, 1.05, -8.0); // only 0.10m from outer face -10.05!
      expect(
        arena.destructionManager.isLineOfSightBlocked(
          enemyEye,
          crouchedPlayerHuggingBarrier
        )
      ).toBe(true);

      // Player bullet fired into Barrier_-9.5_-8 is stopped cold and stamps a POM concrete crater
      const cratersBefore = arena.destructionManager.pomDecals.activeDecalCount;
      const barrierShot = arena.destructionManager.interceptRaySegment(
        vec3(-7.0, 0.85, -8.0),
        vec3(-1, 0, 0),
        5.0,
        1750,
        900,
        0.0057,
        false
      );
      expect(barrierShot.blocked).toBe(true);
      expect(barrierShot.remainingEnergyJ).toBe(0);
      expect(arena.destructionManager.pomDecals.activeDecalCount).toBeGreaterThan(
        cratersBefore
      );

      // Concrete marker post at (-8.5, 0.55, -10.0) also stops enemy rounds
      const markerPostEnemyShot = arena.destructionManager.interceptEnemyShot(
        vec3(-7.0, 0.75, -10.0),
        vec3(-1, 0, 0),
        3.0
      );
      expect(markerPostEnemyShot.blocked).toBe(true);

      // Horizontal player collision blocks walking straight through Barrier_-9.5_-8 while allowing smooth Z sliding
      const slideRes = arena.destructionManager.resolvePlayerHorizontalCollision(
        vec3(-8.55, 0, -8.0),
        vec3(-9.2, 0, -7.6),
        0.36
      );
      expect(slideRes.x).toBeCloseTo(-8.55, 4);
      expect(slideRes.z).toBeCloseTo(-7.6, 4);

      // Alert all arena hostiles while player crouches 0.10m behind Barrier_-9.5_-8 -> 0 player damage!
      const hpBefore = arena.tacticalAi.playerVitals.health;
      const armorBefore = arena.tacticalAi.playerVitals.armor;
      arena.tacticalAi.notifyGunshotOrExplosion(vec3(-8.0, 1.2, -8.0), 40.0, 0.25);
      for (let i = 0; i < 90; i++) {
        arena.tacticalAi.update(
          1 / 30,
          arena.combatDirector.targets.map((t) => t.healthState),
          crouchedPlayerHuggingBarrier
        );
      }
      expect(arena.tacticalAi.playerVitals.health).toBe(hpBefore);
      expect(arena.tacticalAi.playerVitals.armor).toBe(armorBefore);
    } finally {
      arena.destroy();
    }
  });

  it('enforces breach-aware wood wall LOS/fire and occludes floating HUD enemy health bars behind solid cover until X-Ray or wallbang', () => {
    const arena = createUnifiedArenaHarness();
    try {
      // 1. Intact wood_shoot_house_wall (z = -7.2) blocks sight & proximity detection for target_1 at (-2.3, 0, -8.35)
      //    even when the player stands 0.10m in front of the wall (-7.04, horizDist = 1.31m <= 6.5m)!
      const target1 = arena.combatDirector.targets[1];
      const hugWoodPlayerPos = vec3(-2.3, 1.52, -7.04);
      expect(
        arena.destructionManager.isLineOfSightBlocked(
          vec3(-2.3, 1.55, -8.35),
          hugWoodPlayerPos
        )
      ).toBe(true);

      for (let i = 0; i < 30; i++) {
        arena.tacticalAi.update(1 / 30, [target1.healthState], hugWoodPlayerPos);
      }
      expect(arena.tacticalAi.getAgent('target_1')!.state).toBe('PATROL_GUARD');

      // 2. Verify HUD floating health bar occlusion behind opaque walls when X-Ray mode is OFF
      let capturedEntries: ProjectedTargetTriageEntry[] = [];
      let capturedFocusId: string | null = null;
      const origUpdateTriage = arena.hudController.updateTriageOverlays.bind(
        arena.hudController
      );
      arena.hudController.updateTriageOverlays = (entries, focused, physio) => {
        capturedEntries = entries;
        capturedFocusId = focused?.targetId ?? null;
        origUpdateTriage(entries, focused, physio);
      };

      const camEntity = new pc.Entity('TestHudCamera');
      camEntity.addComponent('camera', { fov: 75 });
      // Aim camera directly toward target_1 (-2.3, 1.5, -8.35) from (-2.3, 1.62, -2.5) through intact wood wall
      camEntity.setPosition(-2.3, 1.62, -2.5);
      camEntity.lookAt(-2.3, 1.5, -8.35);
      arena.app.root.addChild(camEntity);
      camEntity.syncHierarchy();

      arena.combatDirector.update(1 / 60, 0.5, camEntity.camera, arena.hudController);

      const entryById = (id: string) =>
        capturedEntries.find((e) => e.state.targetId === id);

      // X-Ray is OFF -> target_1 (behind wood), target_4 (behind brick), target_5 (behind concrete) are hidden!
      expect(entryById('target_1')?.visible).toBe(false);
      expect(entryById('target_4')?.visible).toBe(false);
      expect(entryById('target_5')?.visible).toBe(false);
      // Wall-occluded target_1 must NOT be selected as aimedTarget even when centered under crosshair!
      expect(capturedFocusId).not.toBe('target_1');
      // Meanwhile target_2 behind transparent West glass window IS visible if in frustum
      expect(
        arena.destructionManager.isLineOfSightBlocked(
          vec3(-5.5, 1.62, -2.5),
          vec3(-5.5, 1.55, -7.9)
        )
      ).toBe(false);

      // 3. Toggle X-Ray [X] ON -> occluded target_1 immediately becomes visible through the wall!
      arena.combatDirector.setXRayMode(true);
      arena.combatDirector.update(1 / 60, 0.6, camEntity.camera, arena.hudController);
      expect(entryById('target_1')?.visible).toBe(true);

      // Toggle X-Ray back OFF -> hidden again before breaching
      arena.combatDirector.setXRayMode(false);
      arena.combatDirector.update(1 / 60, 0.7, camEntity.camera, arena.hudController);
      expect(entryById('target_1')?.visible).toBe(false);

      // 4. Carve a wide shotgun breach hole through wood_shoot_house_wall at (-2.3, 1.52, -7.2)
      const breachOrigin = vec3(-2.3, 1.52, -5.6);
      const breachDir = vec3(0, 0, -1);
      arena.combatDirector.fireWeapon(
        WEAPON_M590,
        AMMO_12G_00_BUCK,
        breachOrigin,
        breachDir
      );

      // Sightline AND enemy shot line through the carved Clipper2 breach hole are now OPEN!
      expect(
        arena.destructionManager.isLineOfSightBlocked(
          vec3(-2.3, 1.52, -5.6),
          vec3(-2.3, 1.52, -8.35)
        )
      ).toBe(false);
      const enemyThroughBreach = arena.destructionManager.interceptEnemyShot(
        vec3(-2.3, 1.52, -8.35),
        vec3(0, 0, 1),
        3.0
      );
      expect(enemyThroughBreach.blocked).toBe(false);

      // HUD plate for target_1 is now visible through the breach (and via wallbang confirmation window)!
      arena.combatDirector.update(1 / 60, 0.75, camEntity.camera, arena.hudController);
      expect(entryById('target_1')?.visible).toBe(true);

      camEntity.destroy();
    } finally {
      arena.destroy();
    }
  });
});
