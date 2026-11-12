import { beforeAll, describe, expect, it } from 'vitest';
import * as pc from 'playcanvas';
import { DEFAULT_ENVIRONMENT } from '../src/core/ballistics/weapons.ts';
import { spawnLiveFragGrenade } from '../src/engine/combat/fragGrenadeSpawner.ts';
import { stepActiveGrenades } from '../src/engine/combat/fragGrenadePhysics.ts';
import type { ActiveFragGrenade } from '../src/engine/combat/fragGrenadeTypes.ts';
import { DestructionManager } from '../src/engine/destruction/destructionManager.ts';
import { RapierPhysicsWorld, initRapierPhysics } from '../src/engine/physics/rapierWorld.ts';
import { DESTRUCTION_ZONE_LAYOUT } from '../src/engine/world/arenaBuilder.ts';

function createNullPlayCanvasApp(): pc.Application {
  const canvasStub = { width: 640, height: 480 } as unknown as HTMLCanvasElement;
  const device = new pc.NullGraphicsDevice(canvasStub);
  return new pc.Application(canvasStub, { graphicsDevice: device });
}

describe('Grenade Wall Bounce & Glass / Armored Glass Impact Physics', () => {
  beforeAll(async () => {
    await initRapierPhysics();
  });

  it('bounces thrown grenades off intact brick, wood, and concrete walls, and lets grenades pass through breached holes', () => {
    const app = createNullPlayCanvasApp();
    const rapier = new RapierPhysicsWorld();
    const dm = new DestructionManager(app, rapier, { buildDefaultArena: true });
    const fxRoot = new pc.Entity('TestFxRoot');
    app.root.addChild(fxRoot);

    try {
      rapier.step(1 / 60);

      // 1. Intact Brick Wall: grenade thrown straight at center bounces back (z stays > wall front)
      const brickPos = DESTRUCTION_ZONE_LAYOUT.instancedBrickWall.center;
      const gBrick = spawnLiveFragGrenade(
        { x: brickPos.x, y: 1.0, z: brickPos.z + 1.8 },
        { x: 0, y: 0, z: -1 },
        null,
        fxRoot
      );
      const activeBrick: ActiveFragGrenade[] = [gBrick];
      for (let step = 0; step < 18; step++) {
        stepActiveGrenades(
          activeBrick,
          1 / 60,
          DEFAULT_ENVIRONMENT,
          () => {},
          (prev, next, vel, r, crossed) => dm.resolveGrenadeStep(prev, next, vel, r, crossed)
        );
      }
      expect(gBrick.position.z).toBeGreaterThan(brickPos.z);
      expect(gBrick.velocity.z).toBeGreaterThan(0);

      // 2. Punch a breach hole through the brick wall at (brickPos.x, 1.0, brickPos.z) and throw a grenade through it!
      for (let shot = 0; shot < 3; shot++) {
        dm.interceptRaySegment(
          { x: brickPos.x, y: 1.0, z: brickPos.z + 2.0 },
          { x: 0, y: 0, z: -1 },
          6.0,
          3800,
          820,
          0.0078,
          true,
          2.35
        );
      }
      const gThroughHole = spawnLiveFragGrenade(
        { x: brickPos.x, y: 1.0, z: brickPos.z + 0.9 },
        { x: 0, y: -0.175, z: -0.985 }, // Cancels upward throw loft so flight stays level at y = 1.0m
        null,
        fxRoot
      );
      const activeHole: ActiveFragGrenade[] = [gThroughHole];
      for (let step = 0; step < 12; step++) {
        stepActiveGrenades(
          activeHole,
          1 / 60,
          DEFAULT_ENVIRONMENT,
          () => {},
          (prev, next, vel, r, crossed) => dm.resolveGrenadeStep(prev, next, vel, r, crossed)
        );
      }
      expect(gThroughHole.position.z).toBeLessThan(brickPos.z - 0.25);
      expect(gThroughHole.velocity.z).toBeLessThan(-8.0);

      // 3. Intact Reinforced Concrete Wall: grenade bounces off intact concrete chunks
      const concPos = DESTRUCTION_ZONE_LAYOUT.voronoiConcreteWall.center;
      const gConc = spawnLiveFragGrenade(
        { x: concPos.x, y: 1.1, z: concPos.z + 1.8 },
        { x: 0, y: 0, z: -1 },
        null,
        fxRoot
      );
      const activeConc: ActiveFragGrenade[] = [gConc];
      for (let step = 0; step < 18; step++) {
        stepActiveGrenades(
          activeConc,
          1 / 60,
          DEFAULT_ENVIRONMENT,
          () => {},
          (prev, next, vel, r, crossed) => dm.resolveGrenadeStep(prev, next, vel, r, crossed)
        );
      }
      expect(gConc.position.z).toBeGreaterThan(concPos.z);
      expect(gConc.velocity.z).toBeGreaterThan(0);

      // 4. Intact Wood Shoot-House Wall: direct sweep step bounces grenade off intact drywall
      const woodPos = DESTRUCTION_ZONE_LAYOUT.woodShootHouseWall.center;
      const woodBounce = dm.resolveGrenadeStep(
        { x: woodPos.x + 0.15, y: 1.2, z: woodPos.z + 0.35 },
        { x: woodPos.x + 0.15, y: 1.2, z: woodPos.z - 0.15 },
        { x: 0, y: 0, z: -12 },
        0.045,
        new Set()
      );
      expect(woodBounce.bounced).toBe(true);
      expect(woodBounce.velocity.z).toBeGreaterThan(0);
      expect(woodBounce.position.z).toBeGreaterThan(woodPos.z);
    } finally {
      fxRoot.destroy();
      dm.destroy();
      rapier.destroy();
      app.destroy();
    }
  });

  it('breaks regular glass while slowing the grenade by 50%, and visually breaks armored glass with zero fragments while bouncing the grenade', () => {
    const app = createNullPlayCanvasApp();
    const rapier = new RapierPhysicsWorld();
    const dm = new DestructionManager(app, rapier, { buildDefaultArena: false });

    try {
      const regWin = dm.glassSystem.createVoronoiWindow({
        id: 'test_regular_glass',
        centerWorld: { x: 0, y: 1.4, z: -4.0 },
        widthM: 2.0,
        heightM: 1.5,
      });
      const armWin = dm.glassSystem.createMarchingWindow({
        id: 'test_armored_glass',
        centerWorld: { x: 5.0, y: 1.4, z: -4.0 },
        widthM: 2.0,
        heightM: 1.5,
      });
      rapier.step(1 / 60);

      // A. Regular Voronoi Glass: shatters into shards, grenade passes through at exactly 50% speed!
      const crossedReg = new Set<string>();
      const regSweep = dm.resolveGrenadeStep(
        { x: 0, y: 1.4, z: -3.8 },
        { x: 0, y: 1.4, z: -4.2 },
        { x: 0, y: 2.0, z: -14.0 },
        0.045,
        crossedReg
      );
      expect(regSweep.bounced).toBe(false);
      expect(regSweep.brokeGlass).toBe(true);
      expect(regWin.shattered).toBe(true);
      expect(dm.glassSystem.activeVoronoiShardCount).toBeGreaterThan(8);
      expect(regSweep.velocity.z).toBeCloseTo(-7.0, 5);
      expect(regSweep.velocity.y).toBeCloseTo(1.0, 5);
      expect(regSweep.position.z).toBeLessThan(-4.0);

      // Clear regular glass shards before testing armored glass fragment count
      dm.glassSystem.voronoiShardPool.clear();
      expect(dm.glassSystem.activeVoronoiShardCount).toBe(0);

      // B. Armored Glass: visually breaks/crazes on impact, loses ZERO fragments/shards, and bounces grenade back!
      const crossedArm = new Set<string>();
      const armSweep = dm.resolveGrenadeStep(
        { x: 5.0, y: 1.4, z: -3.8 },
        { x: 5.0, y: 1.4, z: -4.2 },
        { x: 0, y: 1.0, z: -14.0 },
        0.045,
        crossedArm
      );
      expect(armSweep.bounced).toBe(true);
      expect(armSweep.brokeGlass).toBe(false);
      expect(armSweep.crazedArmoredGlass).toBe(true);
      expect(armWin.crazedChunkCount).toBeGreaterThanOrEqual(4);
      expect(armWin.detachedChunkCount).toBe(0);
      expect(dm.glassSystem.activeVoronoiShardCount).toBe(0);
      expect(dm.glassSystem.activeInstancedTriangleCount).toBe(0);
      expect(armSweep.velocity.z).toBeGreaterThan(0);
      expect(armSweep.position.z).toBeGreaterThan(-4.0);
    } finally {
      dm.destroy();
      rapier.destroy();
      app.destroy();
    }
  });
});
