import { describe, it, expect, beforeAll } from 'vitest';
import * as pc from 'playcanvas';
import {
  computePanelRemainingAreaM2,
  createJaggedHoleStamp,
  createWoodPanelState,
  isPointInOpenHole,
  stampHoleInWoodPanel,
  triangulateWoodPanelToBuffers,
  type WoodMeshScratchBuffers,
} from '../src/core/destruction/woodPolygonClipper.ts';
import {
  computeWallStudPositionsU,
  createProceduralSplinterMeshes,
  WoodWallSystem,
} from '../src/engine/destruction/woodWallSystem.ts';
import {
  initRapierPhysics,
  RapierPhysicsWorld,
} from '../src/engine/physics/rapierWorld.ts';

function allocateScratchBuffers(
  maxVerts = 24_576,
  maxIndices = 73_728,
): WoodMeshScratchBuffers {
  return {
    positions: new Float32Array(maxVerts * 3),
    normals: new Float32Array(maxVerts * 3),
    uvs: new Float32Array(maxVerts * 2),
    indices: new Uint16Array(maxIndices),
  };
}

/**
 * Sums exact 3D triangle areas from `buffers` categorized by Front Face (+Z), Back Face (-Z), and Rim (XY),
 * while asserting right-handed winding matches vertex normals.
 */
function measure3DSandwichGeometry(
  buffers: WoodMeshScratchBuffers,
  indexCount: number,
): {
  frontAreaM2: number;
  backAreaM2: number;
  rimAreaM2: number;
  rimTriangleCount: number;
} {
  let frontAreaM2 = 0;
  let backAreaM2 = 0;
  let rimAreaM2 = 0;
  let rimTriangleCount = 0;

  const pos = buffers.positions;
  const norm = buffers.normals;
  const idx = buffers.indices;

  for (let i = 0; i < indexCount; i += 3) {
    const i0 = idx[i];
    const i1 = idx[i + 1];
    const i2 = idx[i + 2];

    const x0 = pos[i0 * 3];
    const y0 = pos[i0 * 3 + 1];
    const z0 = pos[i0 * 3 + 2];

    const x1 = pos[i1 * 3];
    const y1 = pos[i1 * 3 + 1];
    const z1 = pos[i1 * 3 + 2];

    const x2 = pos[i2 * 3];
    const y2 = pos[i2 * 3 + 1];
    const z2 = pos[i2 * 3 + 2];

    const ux = x1 - x0;
    const uy = y1 - y0;
    const uz = z1 - z0;
    const vx = x2 - x0;
    const vy = y2 - y0;
    const vz = z2 - z0;

    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const crossLen = Math.hypot(cx, cy, cz);
    expect(crossLen).toBeGreaterThan(1e-9);

    const triArea = 0.5 * crossLen;
    const gnx = cx / crossLen;
    const gny = cy / crossLen;
    const gnz = cz / crossLen;

    const vnx = norm[i0 * 3];
    const vny = norm[i0 * 3 + 1];
    const vnz = norm[i0 * 3 + 2];

    // Stored vertex normal must be unit length and align with right-handed triangle winding
    expect(Math.hypot(vnx, vny, vnz)).toBeCloseTo(1, 4);
    expect(gnx * vnx + gny * vny + gnz * vnz).toBeGreaterThan(0.999);

    if (vnz > 0.9) {
      frontAreaM2 += triArea;
    } else if (vnz < -0.9) {
      backAreaM2 += triArea;
    } else {
      expect(Math.abs(vnz)).toBeLessThan(1e-4);
      rimAreaM2 += triArea;
      rimTriangleCount++;
    }
  }

  return { frontAreaM2, backAreaM2, rimAreaM2, rimTriangleCount };
}

describe('Pillar 3: R6 Siege Clipper2 + Earcut Wood Walls & Instanced Splinters', () => {
  beforeAll(async () => {
    await initRapierPhysics();
  });

  describe('1. Pure TS 2D Sandwich Polygon Clipper & Earcut Triangulation', () => {
    it('triangulates an intact [0, widthM] x [0, heightM] wood panel with exact front/back/rim areas', () => {
      const widthM = 2.4;
      const heightM = 2.2;
      const thicknessM = 0.08;
      const expectedArea = widthM * heightM;

      const state = createWoodPanelState(widthM, heightM, thicknessM);
      const buffers = allocateScratchBuffers();
      const stats = triangulateWoodPanelToBuffers(state, buffers);

      expect(stats.remainingAreaM2).toBeCloseTo(expectedArea, 4);
      expect(computePanelRemainingAreaM2(state)).toBeCloseTo(expectedArea, 4);
      expect(stats.frontFaceTriangleCount).toBe(2);
      expect(stats.backFaceTriangleCount).toBe(2);
      expect(stats.holeRimTriangleCount).toBe(0);
      expect(stats.outerRimTriangleCount).toBe(8);
      expect(isPointInOpenHole(state, 1.2, 1.1)).toBe(false);
      expect(isPointInOpenHole(state, -0.1, 1.1)).toBe(false);

      const geom = measure3DSandwichGeometry(buffers, stats.indexCount);
      expect(geom.frontAreaM2).toBeCloseTo(expectedArea, 4);
      expect(geom.backAreaM2).toBeCloseTo(expectedArea, 4);
      // Outer board perimeter rim area = 2 * (width + height) * thickness
      expect(geom.rimAreaM2).toBeCloseTo(2 * (widthM + heightM) * thicknessM, 4);
    });

    it('generates deterministic 10-14 vertex jagged stamps scaled by ballistic profile', () => {
      const rifleStampA = createJaggedHoleStamp({
        u: 1.0,
        v: 1.2,
        caliberRadiusM: 0.0039,
        kineticEnergyJ: 3400,
        profile: 'RIFLE_FMJ_AP',
        seed: 7,
      });
      const rifleStampB = createJaggedHoleStamp({
        u: 1.0,
        v: 1.2,
        caliberRadiusM: 0.0039,
        kineticEnergyJ: 3400,
        profile: 'RIFLE_FMJ_AP',
        seed: 7,
      });
      expect(rifleStampA).toEqual(rifleStampB);
      expect(rifleStampA.length).toBeGreaterThanOrEqual(10);
      expect(rifleStampA.length).toBeLessThanOrEqual(14);

      const pelletStamp = createJaggedHoleStamp({
        u: 1.0,
        v: 1.2,
        caliberRadiusM: 0.0042,
        kineticEnergyJ: 240,
        profile: 'BUCKSHOT_PELLET',
        seed: 1,
      });
      const slugStamp = createJaggedHoleStamp({
        u: 1.0,
        v: 1.2,
        caliberRadiusM: 0.00825,
        kineticEnergyJ: 3100,
        profile: 'HEAVY_50AE_SLUG',
        seed: 1,
      });
      const blastStamp = createJaggedHoleStamp({
        u: 1.0,
        v: 1.2,
        caliberRadiusM: 0.04,
        kineticEnergyJ: 9000,
        profile: 'BLAST_BREACH',
        seed: 1,
      });

      for (const s of [pelletStamp, slugStamp, blastStamp]) {
        expect(s.length).toBeGreaterThanOrEqual(10);
        expect(s.length).toBeLessThanOrEqual(14);
      }

      const avgRadius = (pts: ReadonlyArray<{ u: number; v: number }>): number =>
        pts.reduce((acc, p) => acc + Math.hypot(p.u - 1.0, p.v - 1.2), 0) / pts.length;

      expect(avgRadius(slugStamp)).toBeGreaterThan(avgRadius(rifleStampA));
      expect(avgRadius(blastStamp)).toBeGreaterThan(avgRadius(slugStamp));
    });

    it('subtracts single & overlapping multi-shot holes, validates extruded inner rims, and emits 4-6 tangent splinters', () => {
      const widthM = 2.4;
      const heightM = 2.4;
      const thicknessM = 0.08;
      const intactArea = widthM * heightM;

      const state = createWoodPanelState(widthM, heightM, thicknessM);
      const buffers = allocateScratchBuffers();

      // Shot 1: .50 AE / 12G slug fist-sized hole at (1.2, 1.2)
      const stamp1 = createJaggedHoleStamp({
        u: 1.2,
        v: 1.2,
        caliberRadiusM: 0.008,
        kineticEnergyJ: 2800,
        profile: 'HEAVY_50AE_SLUG',
        seed: 1,
      });
      const res1 = stampHoleInWoodPanel(state, stamp1, buffers, 6);

      expect(res1.cutAnyWood).toBe(true);
      expect(res1.removedAreaM2).toBeGreaterThan(0.01);
      expect(res1.meshStats.holeCount).toBe(1);
      expect(res1.meshStats.holeRimTriangleCount).toBeGreaterThanOrEqual(20);
      expect(isPointInOpenHole(state, 1.2, 1.2)).toBe(true);
      expect(isPointInOpenHole(state, 0.35, 0.35)).toBe(false);

      // Verify 4-6 perimeter splinter tangent descriptors
      expect(res1.splinters.length).toBeGreaterThanOrEqual(4);
      expect(res1.splinters.length).toBeLessThanOrEqual(6);
      for (const sp of res1.splinters) {
        expect(sp.u).toBeGreaterThanOrEqual(0);
        expect(sp.u).toBeLessThanOrEqual(widthM);
        expect(sp.v).toBeGreaterThanOrEqual(0);
        expect(sp.v).toBeLessThanOrEqual(heightM);
        expect(Math.hypot(sp.tangentU, sp.tangentV)).toBeCloseTo(1, 5);
        expect(Math.hypot(sp.radialU, sp.radialV)).toBeCloseTo(1, 5);
      }

      // Verify 3D Front & Back triangulated areas match exact Clipper2 remaining area,
      // and inner hole rim vertices bridge +thicknessM*0.5 to -thicknessM*0.5!
      const geom1 = measure3DSandwichGeometry(buffers, res1.meshStats.indexCount);
      expect(geom1.frontAreaM2).toBeCloseTo(res1.meshStats.remainingAreaM2, 3);
      expect(geom1.backAreaM2).toBeCloseTo(res1.meshStats.remainingAreaM2, 3);
      expect(res1.meshStats.remainingAreaM2).toBeLessThan(intactArea - 0.01);
      // Rim area now exceeds outer board rim because of the extruded inner hole rim!
      const outerOnlyRimArea = 2 * (widthM + heightM) * thicknessM;
      expect(geom1.rimAreaM2).toBeGreaterThan(outerOnlyRimArea + 0.02);

      // Verify z-coordinates of vertices all lie cleanly at ±thicknessM * 0.5
      const halfZ = thicknessM * 0.5;
      for (let v = 0; v < res1.meshStats.vertexCount; v++) {
        const vz = buffers.positions[v * 3 + 2];
        expect(Math.abs(Math.abs(vz) - halfZ)).toBeLessThan(1e-5);
      }

      // Shot 2: Overlapping shot right next to Shot 1 -> merges cleanly into ONE larger breach hole!
      const areaAfter1 = res1.meshStats.remainingAreaM2;
      const stamp2 = createJaggedHoleStamp({
        u: 1.26,
        v: 1.22,
        caliberRadiusM: 0.008,
        kineticEnergyJ: 2800,
        profile: 'HEAVY_50AE_SLUG',
        seed: 2,
      });
      const res2 = stampHoleInWoodPanel(state, stamp2, buffers, 5);

      expect(res2.cutAnyWood).toBe(true);
      expect(res2.meshStats.holeCount).toBe(1);
      expect(res2.meshStats.remainingAreaM2).toBeLessThan(areaAfter1);
      // Because Shot 2 overlapped Shot 1, incremental area removed is strictly less than a full isolated stamp
      expect(res2.removedAreaM2).toBeLessThan(res1.removedAreaM2);
      expect(isPointInOpenHole(state, 1.2, 1.2)).toBe(true);
      expect(isPointInOpenHole(state, 1.26, 1.22)).toBe(true);

      const geom2 = measure3DSandwichGeometry(buffers, res2.meshStats.indexCount);
      expect(geom2.frontAreaM2).toBeCloseTo(res2.meshStats.remainingAreaM2, 3);
      expect(geom2.backAreaM2).toBeCloseTo(res2.meshStats.remainingAreaM2, 3);
    });
  });

  describe('2. WoodWallSystem Ballistic Penetration, Studs vs Drywall, Zero Reallocations & Blasts', () => {
    function createTestContext(customSplinters = false): {
      app: pc.Application;
      world: RapierPhysicsWorld;
      system: WoodWallSystem;
      cleanup: () => void;
    } {
      const canvasStub = { width: 640, height: 480 };
      const device = new pc.NullGraphicsDevice(canvasStub);
      const app = new pc.Application(
        canvasStub as unknown as HTMLCanvasElement,
        { graphicsDevice: device },
      );
      const world = new RapierPhysicsWorld();
      const customMeshes = customSplinters
        ? createProceduralSplinterMeshes(device).slice(0, 2)
        : undefined;
      const system = new WoodWallSystem(app, world, {
        splinterMeshes: customMeshes,
      });

      return {
        app,
        world,
        system,
        cleanup: () => {
          system.destroy();
          if (customMeshes) {
            for (const m of customMeshes) {
              m.destroy();
            }
          }
          world.destroy();
          app.destroy();
        },
      };
    }

    it('attenuates ~140-240 J on intact drywall, spawns 4-6 instanced splinters (0 entities), and loses 0 J through open hole', () => {
      const ctx = createTestContext();
      try {
        // 2.4m x 2.4m wall centered at (0, 1.2, -8.0) -> local u in [0, 2.4] maps to world x in [-1.2, +1.2]
        // Studs are at u = [0.0225, 0.60, 1.20, 1.80, 2.3775]
        // u = 0.90 -> world x = -0.30 is dead-center between the 0.60m and 1.20m studs!
        const wall = ctx.system.createWall({
          id: 'shoothouse_plywood_01',
          centerWorld: { x: 0, y: 1.2, z: -8.0 },
          widthM: 2.4,
          heightM: 2.4,
          thicknessM: 0.08,
          studSpacingM: 0.6,
        });
        expect(wall.studPositionsU).toEqual([0.0225, 0.6, 1.2, 1.8, 2.3775]);

        ctx.world.step(1 / 60);
        const rootChildrenBefore = ctx.app.root.children.length;

        // First shot at world (-0.30, 1.20) => local (u = 0.90, v = 1.20) intact drywall
        const shot1 = ctx.system.handleRaySegment({
          originWorld: { x: -0.3, y: 1.2, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 20,
          kineticEnergyJ: 1800,
          speedMs: 850,
          caliberRadiusM: 0.0039,
          isArmorPiercing: false,
        });

        expect(shot1).not.toBeNull();
        expect(shot1!.stopped).toBe(false);
        expect(shot1!.hitMaterial).toBe('WOOD_DRYWALL');
        const energyLost1 = 1800 - shot1!.remainingEnergyJ;
        expect(energyLost1).toBeGreaterThanOrEqual(140);
        expect(energyLost1).toBeLessThanOrEqual(240);
        expect(shot1!.remainingSpeedMs).toBeLessThan(850);
        expect(shot1!.remainingSpeedMs).toBeGreaterThan(750);

        // 4-6 hardware-instanced splinters spawned, ZERO new pc.Entity objects added!
        expect(ctx.system.activeSplinterCount).toBeGreaterThanOrEqual(4);
        expect(ctx.system.activeSplinterCount).toBeLessThanOrEqual(6);
        expect(ctx.app.root.children.length).toBe(rootChildrenBefore);
        expect(isPointInOpenHole(wall.panelState, 0.9, 1.2)).toBe(true);

        const splintersAfterShot1 = ctx.system.activeSplinterCount;

        // Follow-up shot along the exact same line -> passes cleanly through open breach with ZERO energy loss!
        const shot2 = ctx.system.handleRaySegment({
          originWorld: { x: -0.3, y: 1.2, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 20,
          kineticEnergyJ: 1800,
          speedMs: 850,
          caliberRadiusM: 0.0039,
          isArmorPiercing: false,
        });

        expect(shot2).not.toBeNull();
        expect(shot2!.stopped).toBe(false);
        expect(shot2!.remainingEnergyJ).toBe(1800);
        expect(shot2!.remainingSpeedMs).toBe(850);
        expect(ctx.system.activeSplinterCount).toBe(splintersAfterShot1);
      } finally {
        ctx.cleanup();
      }
    });

    it('stops low-energy buckshot & JHP on WOOD_STUD (~650 J resistance) while AP/rifle rounds punch through', () => {
      const ctx = createTestContext(true);
      try {
        ctx.system.createWall({
          id: 'stud_test_wall',
          centerWorld: { x: 0, y: 1.2, z: -6.0 },
          widthM: 2.4,
          heightM: 2.4,
          thicknessM: 0.08,
          studSpacingM: 0.6,
        });
        ctx.world.step(1 / 60);

        // Local u = 0.60 -> world x = -0.60 is directly on a 2x4 vertical WOOD_STUD!
        // 1) 12G 00 Buckshot pellet (260 J) -> STOPPED by WOOD_STUD!
        const buckshotRes = ctx.system.handleRaySegment({
          originWorld: { x: -0.6, y: 1.0, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 260,
          speedMs: 385,
          caliberRadiusM: 0.0042,
          isArmorPiercing: false,
        });
        expect(buckshotRes).not.toBeNull();
        expect(buckshotRes!.hitMaterial).toBe('WOOD_STUD');
        expect(buckshotRes!.stopped).toBe(true);
        expect(buckshotRes!.remainingEnergyJ).toBe(0);
        expect(buckshotRes!.remainingSpeedMs).toBe(0);

        // 2) Low-energy JHP round (560 J) hitting stud at u = 1.20 (world x = 0.0, y = 1.4) -> STOPPED!
        const jhpStudRes = ctx.system.handleRaySegment({
          originWorld: { x: 0.0, y: 1.4, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 560,
          speedMs: 420,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        expect(jhpStudRes).not.toBeNull();
        expect(jhpStudRes!.hitMaterial).toBe('WOOD_STUD');
        expect(jhpStudRes!.stopped).toBe(true);
        expect(jhpStudRes!.remainingEnergyJ).toBe(0);

        // 3) 7.62x51mm NATO Tungsten AP round (3,850 J) hitting stud at u = 1.80 (world x = +0.60) -> PUNCHES RIGHT THROUGH!
        const apStudRes = ctx.system.handleRaySegment({
          originWorld: { x: 0.6, y: 1.3, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 3850,
          speedMs: 815,
          caliberRadiusM: 0.00391,
          isArmorPiercing: true,
        });
        expect(apStudRes).not.toBeNull();
        expect(apStudRes!.hitMaterial).toBe('WOOD_STUD');
        expect(apStudRes!.stopped).toBe(false);
        const apStudLoss = 3850 - apStudRes!.remainingEnergyJ;
        expect(apStudLoss).toBeGreaterThan(500);
        expect(apStudLoss).toBeLessThan(750);
        expect(apStudRes!.remainingEnergyJ).toBeGreaterThan(3100);
      } finally {
        ctx.cleanup();
      }
    });

    it('sustains 105 rifle rounds into a single BUFFER_DYNAMIC pc.Mesh with ZERO GPU buffer reallocations, plus blast & reset', () => {
      const ctx = createTestContext();
      try {
        const wall = ctx.system.createWall({
          id: 'stress_wall_100_shots',
          centerWorld: { x: 0, y: 1.2, z: -10.0 },
          widthM: 3.0,
          heightM: 2.4,
          thicknessM: 0.08,
        });
        ctx.world.step(1 / 60);

        const initialVB = wall.panelMesh.vertexBuffer;
        const initialIB = wall.panelMesh.indexBuffer[0];
        expect(initialVB).toBeDefined();
        expect(initialIB).toBeDefined();

        const intactArea = ctx.system.getWallRemainingAreaM2(wall.id);
        expect(intactArea).toBeCloseTo(3.0 * 2.4, 3);

        // Fire 105 rounds across a 15x7 grid on the wall
        for (let row = 0; row < 7; row++) {
          for (let col = 0; col < 15; col++) {
            const wx = -1.35 + col * 0.19;
            const wy = 0.25 + row * 0.3;
            const res = ctx.system.handleRaySegment({
              originWorld: { x: wx, y: wy, z: 0 },
              directionWorld: { x: 0, y: 0, z: -1 },
              maxDistanceM: 25,
              kineticEnergyJ: 2400,
              speedMs: 880,
              caliberRadiusM: 0.003,
              isArmorPiercing: true,
            });
            expect(res).not.toBeNull();
          }
        }

        // Exact same GPU VertexBuffer and IndexBuffer instances -> ZERO reallocations!
        expect(wall.panelMesh.vertexBuffer).toBe(initialVB);
        expect(wall.panelMesh.indexBuffer[0]).toBe(initialIB);
        expect(ctx.system.getWallRemainingAreaM2(wall.id)).toBeLessThan(intactArea - 0.25);

        // Clear splinters and detonate an explosive blast next to the wall -> punches huge hole + 25+ splinters!
        for (const pool of ctx.system.splinterPools) {
          pool.clear();
        }
        expect(ctx.system.activeSplinterCount).toBe(0);

        const areaBeforeBlast = ctx.system.getWallRemainingAreaM2(wall.id);
        ctx.system.applyBlast({
          centerWorld: { x: 0.2, y: 1.1, z: -9.4 },
          radiusM: 3.5,
          peakImpulseNs: 45,
          peakEnergyJ: 14000,
        });

        expect(ctx.system.getWallRemainingAreaM2(wall.id)).toBeLessThan(areaBeforeBlast - 0.1);
        expect(ctx.system.activeSplinterCount).toBeGreaterThanOrEqual(25);
        expect(wall.panelMesh.vertexBuffer).toBe(initialVB);

        // Step splinter kinematics & floor bounce cleanly
        for (let step = 0; step < 30; step++) {
          ctx.system.update(1 / 60);
        }
        expect(ctx.system.activeSplinterCount).toBeGreaterThan(0);

        // Reset restores intact panel area and reuses the same GPU buffers!
        ctx.system.reset();
        expect(ctx.system.getWallRemainingAreaM2(wall.id)).toBeCloseTo(intactArea, 3);
        expect(ctx.system.activeSplinterCount).toBe(0);
        expect(wall.panelMesh.vertexBuffer).toBe(initialVB);
        expect(wall.panelMesh.indexBuffer[0]).toBe(initialIB);
      } finally {
        ctx.cleanup();
      }
    });
  });
});
