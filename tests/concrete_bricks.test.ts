import { beforeAll, describe, expect, it } from 'vitest';
import * as pc from 'playcanvas';
import {
  createRuntimeConnectivityGraph,
  findDetachedChunkIndices,
  generateRunningBondBrickGraph,
  parseConnectivityGraphJson,
  serializeConnectivityGraphJson,
  severEdgesAtPoint,
  severEdgesFromBlast,
} from '../src/core/destruction/connectivityGraph.ts';
import {
  buildVoronoiWallDataFromImportedMeshes,
  generateVoronoiWallData,
  type ImportedVoronoiChunkMesh,
} from '../src/core/destruction/voronoiWallGenerator.ts';
import { BrickWallSystem } from '../src/engine/destruction/brickWallSystem.ts';
import { ConcreteWallSystem } from '../src/engine/destruction/concreteWallSystem.ts';
import { PomCraterDecalSystem } from '../src/engine/destruction/pomCraterDecals.ts';
import {
  initRapierPhysics,
  RapierPhysicsWorld,
} from '../src/engine/physics/rapierWorld.ts';

function createHeadlessPlayCanvasApp(): {
  app: pc.Application;
  device: pc.NullGraphicsDevice;
} {
  const canvasStub = { width: 640, height: 480 };
  const device = new pc.NullGraphicsDevice(canvasStub);
  const app = new pc.Application(canvasStub as unknown as HTMLCanvasElement, {
    graphicsDevice: device,
  });
  return { app, device };
}

describe('Pillar 2: Concrete & Bricks Destruction (BFS + Instancing + MultiDraw Voronoi + POM)', () => {
  beforeAll(async () => {
    await initRapierPhysics();
  });

  describe('1. Running-Bond Masonry Graph & BFS Island Detachment Solver', () => {
    it('builds a symmetric staggered running-bond brick graph and round-trips JSON', () => {
      const cols = 8;
      const rows = 6;
      const graph = generateRunningBondBrickGraph(
        'brick_wall_alpha',
        cols,
        rows,
        0.215,
        0.065,
        0.1025,
        700,
      );

      expect(graph.version).toBe(1);
      expect(graph.wallId).toBe('brick_wall_alpha');
      expect(graph.nodes).toHaveLength(cols * rows);

      // Row 0 is anchored; upper rows are unanchored; odd rows stagger horizontally by half-brick pitch
      const row0Brick0 = graph.nodes[0];
      const row1Brick0 = graph.nodes[cols];
      expect(row0Brick0.isAnchored).toBe(true);
      expect(row1Brick0.isAnchored).toBe(false);
      expect(row1Brick0.localCenter.x - row0Brick0.localCenter.x).toBeCloseTo(
        (0.215 + 0.008) * 0.5,
        5,
      );

      // Verify undirected symmetry across all mortar edges
      for (const node of graph.nodes) {
        expect(node.meshVariant).toBeGreaterThanOrEqual(0);
        expect(node.meshVariant).toBeLessThan(3);
        for (const edge of node.edges) {
          const neighbor = graph.nodes[edge.neighborIndex];
          const reverse = neighbor.edges.find((e) => e.neighborIndex === node.index);
          expect(reverse).toBeDefined();
          expect(reverse!.breakThresholdJ).toBe(edge.breakThresholdJ);
        }
      }

      // Intact wall has 0 detached bricks
      const runtime = createRuntimeConnectivityGraph(serializeConnectivityGraphJson(graph));
      expect(findDetachedChunkIndices(runtime)).toEqual([]);

      // Asymmetric input JSON is symmetrized by parseConnectivityGraphJson
      const parsedSym = parseConnectivityGraphJson({
        version: 1,
        wallId: 'asym_test',
        nodes: [
          {
            index: 0,
            isAnchored: true,
            localCenter: { x: 0, y: 0.1, z: 0 },
            massKg: 2,
            edges: [{ neighborIndex: 1, breakThresholdJ: 550, severed: false }],
          },
          {
            index: 1,
            isAnchored: false,
            localCenter: { x: 0, y: 0.2, z: 0 },
            massKg: 2,
            edges: [],
          },
        ],
      });
      expect(parsedSym.nodes[1].edges).toHaveLength(1);
      expect(parsedSym.nodes[1].edges[0].neighborIndex).toBe(0);
    });

    it('detaches an entire floating upper arch via BFS when its supporting course is blown out (even with upper edges untouched)', () => {
      const cols = 6;
      const rows = 7;
      const brickW = 0.215;
      const brickH = 0.065;
      const gap = 0.008;
      const runtime = createRuntimeConnectivityGraph(
        generateRunningBondBrickGraph('arch_test_wall', cols, rows, brickW, brickH, 0.1025, 600, gap),
      );

      // Sever ONLY the mortar joints along row 1 (y ~ 0.105 m) across the width of the wall,
      // keeping blast radius tight (0.14 m) so rows 4, 5, 6 above (y > 0.32 m) are NEVER touched!
      const row1Y = 1 * (brickH + gap) + brickH * 0.5;
      let totalSevered = 0;
      for (let c = 0; c < cols; c++) {
        const brick = runtime.nodes[1 * cols + c];
        totalSevered += severEdgesAtPoint(
          runtime,
          brick.localCenter,
          1350, // > 600 J mortar threshold, < 2.25 * 600 foundation rip threshold
          0.14,
        );
      }
      expect(totalSevered).toBeGreaterThan(cols);

      // Confirm upper rows (rows 4..6) still have 100% unbroken internal mortar bonds!
      for (let r = 4; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const upperNode = runtime.nodes[r * cols + c];
          expect(upperNode.edges.every((e) => !e.severed)).toBe(true);
        }
      }

      // Run 20-line BFS island solver: row 0 stays anchored, while ALL upper rows (rows 2..6)
      // have lost connectivity to row 0 and must detach as dynamic bodies!
      const detached = findDetachedChunkIndices(runtime);
      const detachedSet = new Set(detached);

      // Row 0 remains anchored on the foundation
      for (let c = 0; c < cols; c++) {
        expect(detachedSet.has(c)).toBe(false);
        expect(runtime.nodes[c].isAnchored).toBe(true);
      }

      // Every single brick in rows 2..6 (30 upper bricks) detached via island BFS!
      for (let r = 2; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          expect(detachedSet.has(r * cols + c)).toBe(true);
        }
      }

      // Subsequent BFS call returns empty (already marked detached)
      expect(findDetachedChunkIndices(runtime)).toEqual([]);
    });

    it('preserves masonry corbel/arch stability when only a small center opening is knocked out', () => {
      const cols = 8;
      const rows = 6;
      const runtime = createRuntimeConnectivityGraph(
        generateRunningBondBrickGraph('corbel_wall', cols, rows, 0.215, 0.065, 0.1025, 600),
      );

      // Punch out a single center brick in row 2 (col 4) using world-to-local rotated blast
      const targetBrick = runtime.nodes[2 * cols + 4];
      const severed = severEdgesFromBlast(
        runtime,
        { position: { x: 5, y: 0, z: -10 } },
        {
          centerWorld: {
            x: 5 + targetBrick.localCenter.x,
            y: targetBrick.localCenter.y,
            z: -10 + targetBrick.localCenter.z,
          },
          radiusM: 0.15,
          peakImpulseNs: 20,
          peakEnergyJ: 1800,
        },
      );
      expect(severed).toBeGreaterThanOrEqual(5);

      const detached = findDetachedChunkIndices(runtime);
      expect(detached).toContain(2 * cols + 4);
      // Top row remains supported around the 1-brick hole via left & right running-bond pillars!
      for (let c = 0; c < cols; c++) {
        expect(detached).not.toContain((rows - 1) * cols + c);
      }
    });
  });

  describe('2. 3D Voronoi Convex Fracture & Single-Buffer MultiDraw Packing', () => {
    it('partitions wall volume into watertight convex 3D Voronoi cells and packs contiguous sub-draw index ranges', () => {
      const width = 3.0;
      const height = 2.0;
      const depth = 0.3;
      const cellCount = 24;

      const voronoiA = generateVoronoiWallData(
        'concrete_barrier_01',
        width,
        height,
        depth,
        cellCount,
        4242,
      );
      const voronoiB = generateVoronoiWallData(
        'concrete_barrier_01',
        width,
        height,
        depth,
        cellCount,
        4242,
      );

      // Deterministic across runs
      expect(voronoiA.chunks).toHaveLength(cellCount);
      expect(voronoiA.combinedBuffer.totalVertices).toBe(voronoiB.combinedBuffer.totalVertices);
      expect(voronoiA.combinedBuffer.positions).toEqual(voronoiB.combinedBuffer.positions);

      // Sum of convex Voronoi cell volumes matches exact wall box volume (3.0 * 2.0 * 0.3 = 1.8 m^3)
      const expectedVolume = width * height * depth;
      let summedVolume = 0;
      let anchoredCount = 0;

      for (let i = 0; i < cellCount; i++) {
        const chunk = voronoiA.chunks[i];
        expect(chunk.volumeM3).toBeGreaterThan(0.001);
        expect(chunk.hullVertices.length).toBeGreaterThanOrEqual(12); // >= 4 3D vertices
        expect(chunk.indices.length).toBeGreaterThanOrEqual(12);
        summedVolume += chunk.volumeM3;
        if (chunk.isAnchored) {
          anchoredCount++;
        }

        // Convex Voronoi property: every corner of cell i is at least as close to seed[i] as to any other seed[j]
        for (let c = 0; c < chunk.hullVertices.length; c += 3) {
          const wx = chunk.hullVertices[c] + chunk.localCenter.x;
          const wy = chunk.hullVertices[c + 1] + chunk.localCenter.y;
          const wz = chunk.hullVertices[c + 2] + chunk.localCenter.z;
          const distSelf = Math.hypot(
            wx - chunk.seedPoint.x,
            wy - chunk.seedPoint.y,
            wz - chunk.seedPoint.z,
          );
          for (let j = 0; j < cellCount; j++) {
            if (j === i) continue;
            const otherSeed = voronoiA.chunks[j].seedPoint;
            const distOther = Math.hypot(
              wx - otherSeed.x,
              wy - otherSeed.y,
              wz - otherSeed.z,
            );
            expect(distSelf).toBeLessThanOrEqual(distOther + 1e-4);
          }
        }
      }

      expect(summedVolume).toBeCloseTo(expectedVolume, 3);
      expect(anchoredCount).toBeGreaterThan(0);

      // Combined single-buffer index range packing invariants
      const packed = voronoiA.combinedBuffer;
      expect(packed.subDraws).toHaveLength(cellCount);
      expect(packed.indices).toBeInstanceOf(Uint16Array);

      let expectedFirstIndex = 0;
      let expectedBaseVertex = 0;
      for (let i = 0; i < packed.subDraws.length; i++) {
        const sub = packed.subDraws[i];
        expect(sub.chunkIndex).toBe(i);
        expect(sub.baseVertex).toBe(expectedBaseVertex);
        expect(sub.firstIndex).toBe(expectedFirstIndex);
        expect(sub.indexCount).toBe(voronoiA.chunks[i].indices.length);

        for (let k = 0; k < sub.indexCount; k++) {
          const idxVal = packed.indices[sub.firstIndex + k];
          expect(idxVal).toBeGreaterThanOrEqual(sub.baseVertex);
          expect(idxVal).toBeLessThan(sub.baseVertex + sub.vertexCount);
        }

        expectedBaseVertex += sub.vertexCount;
        expectedFirstIndex += sub.indexCount;
      }
      expect(expectedBaseVertex).toBe(packed.totalVertices);
      expect(expectedFirstIndex).toBe(packed.totalIndices);

      // Verify external Blender .glb chunk + connectivity JSON adapter
      const importedInputs: ImportedVoronoiChunkMesh[] = voronoiA.chunks.map((c) => ({
        name: c.name,
        positions: c.localPositions,
        normals: c.normals,
        uvs: c.uvs,
        indices: c.indices,
        positionsAreWallLocal: false,
      }));
      const rebuilt = buildVoronoiWallDataFromImportedMeshes(
        importedInputs,
        voronoiA.connectivity,
      );
      expect(rebuilt.chunks).toHaveLength(cellCount);
      expect(rebuilt.combinedBuffer.totalIndices).toBe(packed.totalIndices);
    });
  });

  describe('3. BrickWallSystem (Solid Wall Mesh + Progressive Brick Damage + Zero Rigid Bodies)', () => {
    it('renders solid masonry wall with 1 collider & 0 rigid bodies, progressively chips/cracks bricks before punching holes through, and passes bullets cleanly through breaches', () => {
      const { app } = createHeadlessPlayCanvasApp();
      const rapier = new RapierPhysicsWorld();
      const collidersBefore = rapier.world.colliders.len();
      const brickSystem = new BrickWallSystem(app, rapier);

      try {
        const wall = brickSystem.addBrickWall({
          wallId: 'masonry_cover_01',
          position: { x: 0, y: 0, z: -8 },
          cols: 6,
          rows: 6,
          mortarBreakJ: 600,
        });

        // Entire 36-brick solid wall uses ONLY 1 static Rapier box collider and 0 dynamic bodies!
        expect(rapier.world.colliders.len() - collidersBefore).toBe(1);
        expect(rapier.activeDynamicBodyCount).toBe(0);
        expect(wall.intactBrickCount).toBe(36);
        expect(wall.damagedBrickCount).toBe(0);
        expect(wall.destroyedBrickCount).toBe(0);

        rapier.step(1 / 60);

        const targetIdx = 2 * 6 + 3;
        const targetPos = brickSystem.getBrickWorldCenter('masonry_cover_01', targetIdx)!;

        // 1) 9mm pistol shot (520 J) -> chips brick progressively (does NOT destroy it), stops cleanly
        const pistolRes = brickSystem.handleRaySegment({
          originWorld: { x: targetPos.x, y: targetPos.y, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 20,
          kineticEnergyJ: 520,
          speedMs: 360,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        expect(pistolRes).not.toBeNull();
        expect(pistolRes!.stopped).toBe(true);
        expect(wall.damagedBrickCount).toBeGreaterThanOrEqual(1);
        expect(wall.destroyedBrickCount).toBe(0);
        expect(wall.grid.hp[targetIdx]).toBeLessThan(wall.grid.cells[targetIdx].maxHp);
        expect(wall.grid.hp[targetIdx]).toBeGreaterThan(50);
        expect(brickSystem.mortarChipPool.activeCount).toBeGreaterThan(0);

        // 2) M4A1 5.56 rifle rounds (1,550 J) into the chipped brick -> gouges & cracks deeply, still standing!
        //    Bricks are tough: it takes about half a magazine of concentrated fire to put one down.
        const fireRifle = () =>
          brickSystem.handleRaySegment({
            originWorld: { x: targetPos.x, y: targetPos.y, z: 0 },
            directionWorld: { x: 0, y: 0, z: -1 },
            maxDistanceM: 20,
            kineticEnergyJ: 1550,
            speedMs: 880,
            caliberRadiusM: 0.00285,
            isArmorPiercing: false,
          });
        let rifleRes = fireRifle();
        expect(rifleRes).not.toBeNull();
        expect(rifleRes!.stopped).toBe(true);
        let rifleShots = 1;
        while (wall.grid.frontGouge[targetIdx] <= 0.4 && rifleShots < 20) {
          rifleRes = fireRifle();
          rifleShots++;
        }
        expect(wall.destroyedBrickCount).toBe(0);
        expect(wall.grid.frontGouge[targetIdx]).toBeGreaterThan(0.4);
        expect(rifleShots).toBeGreaterThan(2);
        while (wall.grid.hp[targetIdx] > 8 && rifleShots < 40) {
          fireRifle();
          rifleShots++;
        }
        expect(wall.destroyedBrickCount).toBe(0);
        expect(rifleShots).toBeGreaterThanOrEqual(8);
        expect(rifleShots).toBeLessThanOrEqual(16);

        // 3) Finishing heavy hit (2,600 J) -> shatters weakened brick out, punches hole through & over-penetrates!
        const slugRes = brickSystem.handleRaySegment({
          originWorld: { x: targetPos.x, y: targetPos.y, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 20,
          kineticEnergyJ: 2600,
          speedMs: 780,
          caliberRadiusM: 0.0085,
          isArmorPiercing: true,
        });
        expect(slugRes).not.toBeNull();
        expect(slugRes!.stopped).toBe(false);
        expect(slugRes!.remainingEnergyJ).toBeGreaterThan(1000);
        expect(wall.destroyedBrickCount).toBeGreaterThanOrEqual(1);
        // Zero Rapier dynamic rigid bodies spawned — only lightweight kinematic rubble particles!
        expect(rapier.activeDynamicBodyCount).toBe(0);

        // Follow-up pistol round aimed through the punched hole passes straight through (returns null)!
        const throughHoleRes = brickSystem.handleRaySegment({
          originWorld: { x: targetPos.x, y: targetPos.y, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 20,
          kineticEnergyJ: 450,
          speedMs: 350,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        expect(throughHoleRes).toBeNull();
        expect(
          brickSystem.isWallOpenAlongRay(
            'masonry_cover_01',
            { x: targetPos.x, y: targetPos.y, z: 0 },
            { x: 0, y: 0, z: -1 },
            20
          )
        ).toBe(true);

        // 4) Grenade blast punches a breach hole AND leaves a damaged ring of cracked bricks around it
        brickSystem.applyBlast({
          centerWorld: { x: 0, y: 0.25, z: -7.9 },
          radiusM: 0.85,
          peakImpulseNs: 45,
          peakEnergyJ: 8500,
        });
        expect(wall.destroyedBrickCount).toBeGreaterThan(4);
        expect(rapier.activeDynamicBodyCount).toBe(0);

        for (let step = 0; step < 20; step++) {
          rapier.step(1 / 60);
          brickSystem.update(1 / 60);
        }

        // Reset restores intact 36-brick solid wall cleanly
        brickSystem.reset();
        expect(wall.intactBrickCount).toBe(36);
        expect(wall.damagedBrickCount).toBe(0);
        expect(wall.destroyedBrickCount).toBe(0);
      } finally {
        brickSystem.destroy();
        rapier.destroy();
        app.destroy();
      }
    });
  });

  describe('4. ConcreteWallSystem (MultiDraw Voronoi + POM GLSL/WGSL Craters + Rifle Non-Fracture Invariant)', () => {
    it('never fractures concrete on rifle/pistol hits (spawning POM craters & chips instead) and fractures via MultiDraw on blasts', () => {
      const { app } = createHeadlessPlayCanvasApp();
      const rapier = new RapierPhysicsWorld();
      const pomSystem = new PomCraterDecalSystem(app, 8, 128, 64);
      const concreteSystem = new ConcreteWallSystem(app, rapier, {
        pomDecalSystem: pomSystem,
      });

      try {
        // Verify GLSL + WGSL POM shader chunks are installed on both decal material and concrete wall material
        const decalGlsl = pomSystem.decalMaterial.getShaderChunks(pc.SHADERLANGUAGE_GLSL);
        const decalWgsl = pomSystem.decalMaterial.getShaderChunks(pc.SHADERLANGUAGE_WGSL);
        expect(decalGlsl.get('parallaxPS')).toContain('uPomCraterDepth');
        expect(decalGlsl.get('diffusePS')).toContain('uPomScorchDarkening');
        expect(decalWgsl.get('parallaxPS')).toContain('uniform.uPomCraterDepth');
        expect(decalWgsl.get('diffusePS')).toContain('uniform.uPomScorchDarkening');

        const wallGlsl = concreteSystem.concreteMaterial.getShaderChunks(
          pc.SHADERLANGUAGE_GLSL,
        );
        const wallWgsl = concreteSystem.concreteMaterial.getShaderChunks(
          pc.SHADERLANGUAGE_WGSL,
        );
        expect(wallGlsl.get('litUserDeclarationPS')).toContain('uCraterSpheres');
        expect(wallWgsl.get('litUserDeclarationPS')).toContain('uCraterSpheres');

        const wall = concreteSystem.addConcreteWall({
          wallId: 'bunker_wall_01',
          position: { x: 0, y: 0, z: -12 },
          width: 3.0,
          height: 2.0,
          depth: 0.3,
          cellCount: 20,
          seed: 9001,
          bondStrengthPerSqM: 12000,
        });

        expect(wall.activeIntactChunkCount).toBe(20);
        expect(wall.detachedChunkCount).toBe(0);
        expect(wall.drawCommands).toBeDefined();
        expect(wall.drawCommands!.multiDraw).toBe(true);
        expect(wall.drawCommands!.count).toBe(20);
        expect(wall.intactEntity.enabled).toBe(true);
        expect(concreteSystem.dynamicEntity.enabled).toBe(false);

        rapier.step(1 / 60);

        // Fire 10 non-explosive pistol, assault rifle, and .338 AP sniper rounds (up to 6,800 J)
        // Invariant: NEVER fractures or detaches ANY Voronoi chunk; spawns ring-buffered POM craters + chips!
        const testEnergies = [480, 950, 1750, 2400, 3300, 4100, 5200, 6800, 1900, 3550];
        for (let s = 0; s < testEnergies.length; s++) {
          const hitX = -0.9 + s * 0.2;
          const res = concreteSystem.handleRaySegment({
            originWorld: { x: hitX, y: 1.1, z: 0 },
            directionWorld: { x: 0, y: 0, z: -1 },
            maxDistanceM: 25,
            kineticEnergyJ: testEnergies[s],
            speedMs: 850,
            caliberRadiusM: 0.004,
            isArmorPiercing: true,
          });
          expect(res).not.toBeNull();
          expect(res!.stopped).toBe(true);
          expect(res!.remainingEnergyJ).toBe(0);
          expect(res!.hitMaterial).toBe('CONCRETE_INTACT');
        }

        // Zero Voronoi chunks fractured after 10 heavy rifle rounds!
        expect(wall.detachedChunkCount).toBe(0);
        expect(wall.activeIntactChunkCount).toBe(20);
        expect(wall.drawCommands!.count).toBe(20);
        expect(rapier.activeDynamicBodyCount).toBe(0);

        // Ring-buffered POM decal pool capped cleanly at maxDecals = 8 after 10 impacts!
        expect(pomSystem.totalCraterCount).toBe(10);
        expect(pomSystem.activeDecalCount).toBe(8);
        expect(pomSystem.activeChipCount).toBeGreaterThan(0);

        // Now detonate a high-explosive C4 charge against the center of the concrete wall!
        concreteSystem.applyBlast({
          centerWorld: { x: 0, y: 1.1, z: -11.85 },
          radiusM: 1.35,
          peakImpulseNs: 180,
          peakEnergyJ: 38000,
        });

        expect(wall.detachedChunkCount).toBeGreaterThan(0);
        expect(wall.activeIntactChunkCount).toBe(20 - wall.detachedChunkCount);
        expect(wall.drawCommands!.count).toBe(wall.activeIntactChunkCount);
        expect(concreteSystem.activeDetachedChunkCount).toBe(wall.detachedChunkCount);
        expect(concreteSystem.dynamicEntity.enabled).toBe(true);
        expect(rapier.activeDynamicBodyCount).toBe(wall.detachedChunkCount);

        // Step physics so dynamic Voronoi convex-hull rubble tumbles out of the breach
        for (let step = 0; step < 30; step++) {
          rapier.step(1 / 60);
          concreteSystem.update(1 / 60);
        }

        // Detonate a massive demolition blast wiping out all remaining chunks -> intactEntity hides!
        concreteSystem.applyBlast({
          centerWorld: { x: 0, y: 0.5, z: -12 },
          radiusM: 6.0,
          peakImpulseNs: 450,
          peakEnergyJ: 250000,
        });

        expect(wall.activeIntactChunkCount).toBe(0);
        expect(wall.drawCommands!.count).toBe(0);
        expect(wall.intactEntity.enabled).toBe(false);
        expect(concreteSystem.activeDetachedChunkCount).toBe(20);

        // Reset restores all 20 chunks to single-draw-call intact MultiDraw state
        concreteSystem.reset();
        expect(wall.activeIntactChunkCount).toBe(20);
        expect(wall.drawCommands!.count).toBe(20);
        expect(wall.intactEntity.enabled).toBe(true);
        expect(concreteSystem.activeDetachedChunkCount).toBe(0);
        expect(concreteSystem.dynamicEntity.enabled).toBe(false);
      } finally {
        concreteSystem.destroy();
        pomSystem.destroy();
        rapier.destroy();
        app.destroy();
      }
    });
  });
});
