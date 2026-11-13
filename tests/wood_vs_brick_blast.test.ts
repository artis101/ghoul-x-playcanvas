import { describe, it, expect, beforeAll } from 'vitest';
import * as pc from 'playcanvas';
import { createSolidBrickWallGrid } from '../src/core/destruction/brick/brickWallGridBuilder.ts';
import { applyBlastToBrickGrid } from '../src/core/destruction/brick/brickDamageSolver.ts';
import { WoodWallSystem } from '../src/engine/destruction/woodWallSystem.ts';
import { initRapierPhysics, RapierPhysicsWorld } from '../src/engine/physics/rapierWorld.ts';
import { GRENADE_BLAST_RADIUS_M, GRENADE_PEAK_ENERGY_J } from '../src/engine/combat/fragGrenadeTypes.ts';
import { BARREL_BLAST_PEAK_ENERGY_J, BARREL_BLAST_RADIUS_M } from '../src/engine/fx/barrels/barrelTypes.ts';

const WALL_SIZE_M = 2.4;

function brickFractionDestroyed(standoffM: number, radiusM: number, peakEnergyJ: number): number {
  const grid = createSolidBrickWallGrid({ wallId: 'brick_probe', cols: 11, rows: 30 });
  applyBlastToBrickGrid(grid, { x: 0, y: grid.heightM * 0.5, z: standoffM }, radiusM, peakEnergyJ);
  let destroyed = 0;
  for (let i = 0; i < grid.hp.length; i++) {
    if (grid.hp[i] <= 0) destroyed++;
  }
  return destroyed / grid.hp.length;
}

function woodFractionDestroyed(standoffM: number, radiusM: number, peakEnergyJ: number): number {
  const canvasStub = { width: 64, height: 64 };
  const device = new pc.NullGraphicsDevice(canvasStub);
  const app = new pc.Application(canvasStub as unknown as HTMLCanvasElement, { graphicsDevice: device });
  const world = new RapierPhysicsWorld();
  const system = new WoodWallSystem(app, world);
  try {
    const wall = system.createWall({
      id: 'wood_probe',
      centerWorld: { x: 0, y: 1.2, z: -8 },
      widthM: WALL_SIZE_M,
      heightM: WALL_SIZE_M,
      thicknessM: 0.08,
      studSpacingM: 0.6,
    });
    const intactArea = system.getWallRemainingAreaM2(wall.id);
    system.applyBlast({
      centerWorld: { x: 0, y: 1.2, z: -8 + standoffM },
      radiusM,
      peakImpulseNs: 260,
      peakEnergyJ,
    });
    return 1 - system.getWallRemainingAreaM2(wall.id) / intactArea;
  } finally {
    system.destroy();
    world.destroy();
    app.destroy();
  }
}

describe('Wood framing is never tougher against blasts than brick masonry', () => {
  beforeAll(async () => {
    await initRapierPhysics();
  });

  const cases: Array<[string, number, number, number]> = [
    ['grenade at 1.5 m', 1.5, GRENADE_BLAST_RADIUS_M, GRENADE_PEAK_ENERGY_J],
    ['grenade at 3.5 m', 3.5, GRENADE_BLAST_RADIUS_M, GRENADE_PEAK_ENERGY_J],
    ['grenade at 5.5 m', 5.5, GRENADE_BLAST_RADIUS_M, GRENADE_PEAK_ENERGY_J],
    ['barrel at 0.6 m', 0.6, BARREL_BLAST_RADIUS_M, BARREL_BLAST_PEAK_ENERGY_J],
    ['barrel at 1.3 m', 1.3, BARREL_BLAST_RADIUS_M, BARREL_BLAST_PEAK_ENERGY_J],
  ];

  for (const [label, standoffM, radiusM, energyJ] of cases) {
    it(`${label}: wood loses at least as much of the wall as brick`, () => {
      const brick = brickFractionDestroyed(standoffM, radiusM, energyJ);
      const wood = woodFractionDestroyed(standoffM, radiusM, energyJ);
      expect(brick).toBeGreaterThan(0);
      expect(wood).toBeGreaterThanOrEqual(brick);
    });
  }
});
