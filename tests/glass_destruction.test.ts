import { beforeAll, describe, expect, it } from 'vitest';
import * as pc from 'playcanvas';
import {
  GLASS_CELL_CRACKED,
  GLASS_CELL_INTACT,
  GLASS_CELL_VOID,
  GLASS_DIR_E,
  GLASS_DIR_N,
  GLASS_DIR_NE,
  GLASS_DIR_NW,
  GLASS_DIR_S,
  GLASS_DIR_SE,
  GLASS_DIR_SW,
  GLASS_DIR_W,
  MARCHING_ATLAS_TILE_SPAN,
  MarchingGlassPane,
  bitmaskToAtlasUv,
  computeNeighborBitmask8,
} from '../src/core/destruction/glassMarchingTiles.ts';
import {
  DEFAULT_SHARD_FLOOR_Y,
  DEFAULT_VORONOI_SHARD_THICKNESS_M,
  GlassShardPool,
  computeSignedPolygonArea2D,
  extrudeConvexShard2D,
  shatterWindowVoronoi2D,
} from '../src/core/destruction/glassVoronoiShatter.ts';
import {
  GlassSystem,
  createMarchingGlassAtlasTexture,
  generateMarchingGlassAtlasRgba8,
} from '../src/engine/destruction/glassSystem.ts';
import {
  RapierPhysicsWorld,
  initRapierPhysics,
} from '../src/engine/physics/rapierWorld.ts';

describe('Pillar 4: Dual Glass Destruction — 256 Marching-Tile Atlas & Delaunator 2D Voronoi Shatter', () => {
  beforeAll(async () => {
    await initRapierPhysics();
  });

  describe('1. Method A: 8-Neighbor Bitmask (0..255) -> 16x16 Atlas UVs, Radial Walk & Zero-Quad Holes', () => {
    it('maps all 256 bitmasks (0..255) bijectively to 16x16 UV tiles via u0=(mask%16)/16, v0=floor(mask/16)/16', () => {
      const seenKeys = new Set<string>();

      for (let mask = 0; mask <= 255; mask++) {
        const uv = bitmaskToAtlasUv(mask);
        const expectedU0 = (mask % 16) / 16;
        const expectedV0 = Math.floor(mask / 16) / 16;

        expect(uv.tileSpan).toBeCloseTo(1 / 16, 8);
        expect(uv.tileSpan).toBe(MARCHING_ATLAS_TILE_SPAN);
        expect(uv.u0).toBeCloseTo(expectedU0, 8);
        expect(uv.v0).toBeCloseTo(expectedV0, 8);
        expect(uv.u1).toBeCloseTo(expectedU0 + 1 / 16, 8);
        expect(uv.v1).toBeCloseTo(expectedV0 + 1 / 16, 8);
        expect(uv.u0).toBeGreaterThanOrEqual(0);
        expect(uv.v0).toBeGreaterThanOrEqual(0);
        expect(uv.u1).toBeLessThanOrEqual(1);
        expect(uv.v1).toBeLessThanOrEqual(1);

        const key = `${uv.u0.toFixed(6)},${uv.v0.toFixed(6)}`;
        expect(seenKeys.has(key)).toBe(false);
        seenKeys.add(key);
      }

      expect(seenKeys.size).toBe(256);
    });

    it('computes exact 8-neighbor bitmasks across all corners, edges, and single-direction interior cases', () => {
      const gridW = 16;
      const gridH = 16;
      const cells = new Uint8Array(gridW * gridH).fill(GLASS_CELL_INTACT);

      // Interior cell with all neighbors intact -> 255
      expect(computeNeighborBitmask8(cells, gridW, gridH, 8, 8, false)).toBe(255);
      expect(computeNeighborBitmask8(cells, gridW, gridH, 8, 8, true)).toBe(255);

      // Corners when out-of-bounds is treated as missing (outOfBoundsIntact = false):
      // SW corner (0, 0): only N, NE, E exist
      expect(computeNeighborBitmask8(cells, gridW, gridH, 0, 0, false)).toBe(
        GLASS_DIR_N | GLASS_DIR_NE | GLASS_DIR_E,
      );
      // SE corner (15, 0): only N, W, NW exist
      expect(computeNeighborBitmask8(cells, gridW, gridH, 15, 0, false)).toBe(
        GLASS_DIR_N | GLASS_DIR_W | GLASS_DIR_NW,
      );
      // NW corner (0, 15): only E, SE, S exist
      expect(computeNeighborBitmask8(cells, gridW, gridH, 0, 15, false)).toBe(
        GLASS_DIR_E | GLASS_DIR_SE | GLASS_DIR_S,
      );
      // NE corner (15, 15): only S, SW, W exist
      expect(computeNeighborBitmask8(cells, gridW, gridH, 15, 15, false)).toBe(
        GLASS_DIR_S | GLASS_DIR_SW | GLASS_DIR_W,
      );

      // Edges when outOfBoundsIntact = false:
      // South edge (8, 0): missing SE, S, SW
      expect(computeNeighborBitmask8(cells, gridW, gridH, 8, 0, false)).toBe(
        255 & ~(GLASS_DIR_SE | GLASS_DIR_S | GLASS_DIR_SW),
      );
      // North edge (8, 15): missing NW, N, NE
      expect(computeNeighborBitmask8(cells, gridW, gridH, 8, 15, false)).toBe(
        255 & ~(GLASS_DIR_NW | GLASS_DIR_N | GLASS_DIR_NE),
      );
      // West edge (0, 8): missing NW, W, SW
      expect(computeNeighborBitmask8(cells, gridW, gridH, 0, 8, false)).toBe(
        255 & ~(GLASS_DIR_NW | GLASS_DIR_W | GLASS_DIR_SW),
      );
      // East edge (15, 8): missing NE, E, SE
      expect(computeNeighborBitmask8(cells, gridW, gridH, 15, 8, false)).toBe(
        255 & ~(GLASS_DIR_NE | GLASS_DIR_E | GLASS_DIR_SE),
      );

      // Framed window mode (outOfBoundsIntact = true): intact border cells read 255
      expect(computeNeighborBitmask8(cells, gridW, gridH, 0, 0, true)).toBe(255);
      expect(computeNeighborBitmask8(cells, gridW, gridH, 15, 15, true)).toBe(255);

      // Knock out each of the 8 neighbors around interior cell (7, 7) one by one and verify each bit 0..7
      const dirChecks: Array<{ dc: number; dr: number; bit: number }> = [
        { dc: 0, dr: 1, bit: GLASS_DIR_N },
        { dc: 1, dr: 1, bit: GLASS_DIR_NE },
        { dc: 1, dr: 0, bit: GLASS_DIR_E },
        { dc: 1, dr: -1, bit: GLASS_DIR_SE },
        { dc: 0, dr: -1, bit: GLASS_DIR_S },
        { dc: -1, dr: -1, bit: GLASS_DIR_SW },
        { dc: -1, dr: 0, bit: GLASS_DIR_W },
        { dc: -1, dr: 1, bit: GLASS_DIR_NW },
      ];

      for (const { dc, dr, bit } of dirChecks) {
        const nIdx = (7 + dr) * gridW + (7 + dc);
        cells[nIdx] = GLASS_CELL_VOID;
        expect(computeNeighborBitmask8(cells, gridW, gridH, 7, 7, false)).toBe(
          255 & ~bit,
        );
        // Cracked neighbor (state = 2) still counts as physically present glass for bitmask!
        cells[nIdx] = GLASS_CELL_CRACKED;
        expect(computeNeighborBitmask8(cells, gridW, gridH, 7, 7, false)).toBe(255);
        cells[nIdx] = GLASS_CELL_INTACT;
      }
    });

    it('zeroes impacted cells, runs deterministic 4-8 radial crack walk tendrils, and emits 0 quads for open holes', () => {
      const paneA = new MarchingGlassPane({ widthM: 1.6, heightM: 1.2 });
      const paneB = new MarchingGlassPane({ widthM: 1.6, heightM: 1.2 });

      const initialMesh = paneA.writeQuadGridBuffers();
      expect(initialMesh.quadCount).toBe(256);
      expect(initialMesh.vertexCount).toBe(256 * 4);
      expect(initialMesh.indexCount).toBe(256 * 6);

      const impactA = paneA.applyImpact({
        u: 0.5,
        v: 0.5,
        energyJ: 850,
        radiusM: 0.08,
        seed: 1337,
      });
      const impactB = paneB.applyImpact({
        u: 0.5,
        v: 0.5,
        energyJ: 850,
        radiusM: 0.08,
        seed: 1337,
      });

      // Deterministic PRNG walk produces identical grid state
      expect(Array.from(paneA.cells)).toEqual(Array.from(paneB.cells));
      expect(impactA.alreadyBrokenHole).toBe(false);
      expect(impactA.tendrilsSpawned).toBeGreaterThanOrEqual(4);
      expect(impactA.tendrilsSpawned).toBeLessThanOrEqual(8);
      expect(impactA.cellsBroken).toBeGreaterThan(0);
      expect(impactA.cellsCracked).toBeGreaterThan(0);
      expect(paneA.isBrokenAtUv(0.5, 0.5)).toBe(true);

      // Follow-up bullet through the exact same broken hole does zero extra work
      const followUp = paneA.applyImpact({
        u: 0.5,
        v: 0.5,
        energyJ: 850,
        radiusM: 0.03,
        seed: 9999,
      });
      expect(followUp.alreadyBrokenHole).toBe(true);
      expect(followUp.cellsBroken).toBe(0);

      // Emitted quad count strictly equals survivingCellCount (0 quads for zeroed-out cells!)
      const postMesh = paneA.writeQuadGridBuffers();
      expect(postMesh.quadCount).toBe(paneA.survivingCellCount);
      expect(postMesh.quadCount).toBe(256 - impactA.cellsBroken);
      expect(postMesh.vertexCount).toBe(postMesh.quadCount * 4);
      expect(postMesh.indexCount).toBe(postMesh.quadCount * 6);
    });
  });

  describe('2. Method B: Delaunator 2D Voronoi Shatter, Sutherland-Hodgman Clipping & 1 cm Prism Extrusion', () => {
    it('partitions [0, widthM] x [0, heightM] into 36-48 convex shards with total area matching widthM * heightM within < 1e-3', () => {
      const cases = [
        { widthM: 1.8, heightM: 1.2, hitX: 0.9, hitY: 0.6, shardCount: 42, seed: 101 },
        { widthM: 2.4, heightM: 1.5, hitX: 0.35, hitY: 1.25, shardCount: 48, seed: 202 },
        { widthM: 1.1, heightM: 1.9, hitX: 0.95, hitY: 0.2, shardCount: 36, seed: 303 },
      ];

      for (const tc of cases) {
        const res = shatterWindowVoronoi2D(tc);
        const expectedArea = tc.widthM * tc.heightM;

        expect(res.shards.length).toBeGreaterThanOrEqual(36);
        expect(res.shards.length).toBeLessThanOrEqual(48);
        expect(Math.abs(res.totalAreaM2 - expectedArea)).toBeLessThan(1e-3);

        let nearAreaSum = 0;
        let nearCount = 0;
        let farAreaSum = 0;
        let farCount = 0;
        const diag = Math.hypot(tc.widthM, tc.heightM);

        for (const shard of res.shards) {
          expect(shard.polygon.length).toBeGreaterThanOrEqual(3);
          expect(shard.areaM2).toBeGreaterThan(0);
          expect(computeSignedPolygonArea2D(shard.polygon)).toBeGreaterThan(0);

          // Every clipped vertex lies cleanly inside [0, widthM] x [0, heightM]
          for (const pt of shard.polygon) {
            expect(pt.x).toBeGreaterThanOrEqual(-1e-9);
            expect(pt.x).toBeLessThanOrEqual(tc.widthM + 1e-9);
            expect(pt.y).toBeGreaterThanOrEqual(-1e-9);
            expect(pt.y).toBeLessThanOrEqual(tc.heightM + 1e-9);
          }

          // Convexity check: all consecutive edge cross products >= -1e-9
          const n = shard.polygon.length;
          for (let i = 0; i < n; i++) {
            const a = shard.polygon[i];
            const b = shard.polygon[(i + 1) % n];
            const c = shard.polygon[(i + 2) % n];
            const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
            expect(cross).toBeGreaterThanOrEqual(-1e-7);
          }

          if (shard.radialDistanceM < diag * 0.18) {
            nearAreaSum += shard.areaM2;
            nearCount++;
          } else if (shard.radialDistanceM > diag * 0.38) {
            farAreaSum += shard.areaM2;
            farCount++;
          }
        }

        // Shards concentrated near bullet impact are smaller on average than outer frame shards
        if (nearCount > 0 && farCount > 0) {
          expect(nearAreaSum / nearCount).toBeLessThan(farAreaSum / farCount);
        }
      }
    });

    it('extrudes 1 cm (0.01m) convex shard prisms with exact 6*N vertices, 12*N-12 indices, and unit normals', () => {
      for (const sides of [3, 4, 5, 6, 7]) {
        const poly = [];
        const cx = 0.6;
        const cy = 0.45;
        const r = 0.08;
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2;
          poly.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
        }

        const ext = extrudeConvexShard2D(
          poly,
          { x: cx, y: cy },
          1.2,
          0.9,
          DEFAULT_VORONOI_SHARD_THICKNESS_M,
        );

        expect(ext.polygonVertexCount).toBe(sides);
        expect(ext.vertexCount).toBe(6 * sides);
        expect(ext.indexCount).toBe(12 * sides - 12);
        expect(ext.localPositions.length).toBe(6 * sides * 3);
        expect(ext.localNormals.length).toBe(6 * sides * 3);
        expect(ext.localUvs.length).toBe(6 * sides * 2);
        expect(ext.localIndices.length).toBe(12 * sides - 12);

        // Front face vertices at +0.005 (+Z normal), back face vertices at -0.005 (-Z normal)
        for (let i = 0; i < sides; i++) {
          expect(ext.localPositions[i * 3 + 2]).toBeCloseTo(0.005, 6);
          expect(ext.localNormals[i * 3 + 2]).toBeCloseTo(1, 6);

          const backV = sides + i;
          expect(ext.localPositions[backV * 3 + 2]).toBeCloseTo(-0.005, 6);
          expect(ext.localNormals[backV * 3 + 2]).toBeCloseTo(-1, 6);
        }

        // Rim bevel vertices have unit horizontal normals (nz === 0, hypot(nx, ny) === 1)
        for (let v = 2 * sides; v < 6 * sides; v++) {
          const nx = ext.localNormals[v * 3];
          const ny = ext.localNormals[v * 3 + 1];
          const nz = ext.localNormals[v * 3 + 2];
          expect(nz).toBeCloseTo(0, 6);
          expect(Math.hypot(nx, ny)).toBeCloseTo(1, 5);
        }
      }
    });
  });

  describe('3. 500+ Shard Custom JS Floor-Bounce Simulator Performance & Ground Clamping', () => {
    it('simulates 520 concurrent 1 cm Voronoi shards with y >= 0.008 floor bounce, restitution 0.28, and fast batched mesh output', () => {
      const pool = new GlassShardPool(550);
      const templateShatter = shatterWindowVoronoi2D({
        widthM: 1.6,
        heightM: 1.2,
        hitX: 0.8,
        hitY: 0.6,
        shardCount: 44,
        seed: 777,
      });

      // Spawn 12 windows worth -> 528 shards (clamped/pooled cleanly, >= 520 active)
      let totalSpawned = 0;
      for (let w = 0; w < 12; w++) {
        for (let s = 0; s < templateShatter.shards.length && totalSpawned < 520; s++) {
          const shard = templateShatter.shards[s];
          pool.spawnShard(
            { x: (w - 6) * 0.5, y: 0.18 + (s % 5) * 0.14, z: -6 - (w % 3) },
            { x: 0.8, y: -2.5, z: -1.4 },
            { x: 9.0, y: -11.0, z: 6.5 },
            { x: 0.2, y: 0.1, z: 0.3, w: 0.927 },
            shard.extruded,
            4.0,
          );
          totalSpawned++;
        }
      }

      expect(pool.activeCount).toBe(520);

      const outPos = new Float32Array(550 * 48 * 3);
      const outNorm = new Float32Array(550 * 48 * 3);
      const outUv = new Float32Array(550 * 48 * 2);
      const outIdx = new Uint32Array(550 * 96);

      let sawBounceUpward = false;
      let minObservedY = Infinity;
      const startMs = performance.now();

      for (let step = 0; step < 120; step++) {
        pool.step(1 / 60);

        for (let i = 0; i < pool.activeCount; i++) {
          const py = pool.posY[i];
          if (py < minObservedY) {
            minObservedY = py;
          }
          if (Math.abs(py - DEFAULT_SHARD_FLOOR_Y) < 1e-5 && pool.velY[i] > 0.2) {
            sawBounceUpward = true;
          }
        }
      }

      const meshStats = pool.writeBatchedMeshBuffers(outPos, outNorm, outUv, outIdx);
      const elapsedMs = performance.now() - startMs;

      // Strict ground plane clamping at y = 0.008 across all 520 shards & 120 steps
      expect(minObservedY).toBeGreaterThanOrEqual(DEFAULT_SHARD_FLOOR_Y - 1e-6);
      expect(sawBounceUpward).toBe(true);
      expect(meshStats.activeShards).toBe(520);
      expect(meshStats.vertexCount).toBeGreaterThan(520 * 18);
      expect(meshStats.indexCount).toBeGreaterThan(520 * 24);
      // 120 physics steps of 520 3D shards + batched mesh write runs well within frame budget
      expect(elapsedMs).toBeLessThan(1000);

      // Advance past 4.0s TTL -> all shards smoothly fade and clean up to 0
      for (let step = 0; step < 150; step++) {
        pool.step(1 / 30);
      }
      expect(pool.activeCount).toBe(0);
    });
  });

  describe('4. GlassSystem Integration (Procedural 512x512 Atlas, Ballistic Pass-Through & Blast)', () => {
    it('generates crisp 512x512 RGBA8 crack atlas and passes bullets through broken panes with 0 J loss', () => {
      const rgba = generateMarchingGlassAtlasRgba8(512);
      expect(rgba.length).toBe(512 * 512 * 4);

      // Tile 255 (top-right tile col=15, row=15) has all 8 neighbors intact -> 0 transparent void pixels
      let tile255ZeroAlphaCount = 0;
      for (let ly = 0; ly < 32; ly++) {
        for (let lx = 0; lx < 32; lx++) {
          const px = 15 * 32 + lx;
          const py = 15 * 32 + ly;
          if (rgba[(py * 512 + px) * 4 + 3] === 0) {
            tile255ZeroAlphaCount++;
          }
        }
      }
      expect(tile255ZeroAlphaCount).toBe(0);

      // Tile 0 (col=0, row=0) has all 8 neighbors missing -> carved alpha=0 teeth + bright fracture rim
      let tile0ZeroAlphaCount = 0;
      let tile0BrightRimCount = 0;
      for (let ly = 0; ly < 32; ly++) {
        for (let lx = 0; lx < 32; lx++) {
          const idx = (ly * 512 + lx) * 4;
          if (rgba[idx + 3] === 0) {
            tile0ZeroAlphaCount++;
          } else if (rgba[idx] >= 225 && rgba[idx + 1] >= 245 && rgba[idx + 2] >= 250) {
            tile0BrightRimCount++;
          }
        }
      }
      expect(tile0ZeroAlphaCount).toBeGreaterThan(80);
      expect(tile0BrightRimCount).toBeGreaterThan(20);

      const canvasStub = { width: 640, height: 480 };
      const device = new pc.NullGraphicsDevice(canvasStub);
      const app = new pc.Application(
        canvasStub as unknown as HTMLCanvasElement,
        { graphicsDevice: device },
      );
      const physics = new RapierPhysicsWorld();
      const glassSystem = new GlassSystem(app, physics);

      try {
        const tex = createMarchingGlassAtlasTexture(device, 512);
        expect(tex.width).toBe(512);
        expect(tex.height).toBe(512);
        tex.destroy();

        const marchingWin = glassSystem.createMarchingWindow({
          id: 'win_marching_front',
          centerWorld: { x: 0, y: 1.5, z: -6.0 },
          widthM: 1.6,
          heightM: 1.2,
        });

        const voronoiWin = glassSystem.createVoronoiWindow({
          id: 'win_voronoi_rear',
          centerWorld: { x: 3.5, y: 1.5, z: -8.0 },
          widthM: 1.8,
          heightM: 1.4,
        });

        const farVoronoiWin = glassSystem.createVoronoiWindow({
          id: 'win_voronoi_far',
          centerWorld: { x: 22.0, y: 1.5, z: -8.0 },
          widthM: 1.6,
          heightM: 1.2,
        });

        physics.step(1 / 60);
        const rootEntityCountBeforeShatter = app.root.children.length;

        // 1. Rifle round hits fresh MarchingTileGlassWindow: loses 25..45 J, stopped: false, spawns 10 instanced triangles
        const shot1 = glassSystem.handleRaySegment({
          originWorld: { x: 0, y: 1.5, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 3400,
          speedMs: 820,
          caliberRadiusM: 0.0039,
          isArmorPiercing: false,
        });

        expect(shot1).not.toBeNull();
        expect(shot1!.stopped).toBe(false);
        expect(shot1!.hitMaterial).toBe('GLASS_MARCHING_256');
        const loss1 = 3400 - shot1!.remainingEnergyJ;
        expect(loss1).toBeGreaterThanOrEqual(25);
        expect(loss1).toBeLessThanOrEqual(45);
        expect(glassSystem.activeInstancedTriangleCount).toBe(10);
        expect(marchingWin.pane.survivingCellCount).toBeLessThan(256);

        // 2. Follow-up bullet through the SAME open hole loses 0 J!
        const shot2 = glassSystem.handleRaySegment({
          originWorld: { x: 0, y: 1.5, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 520,
          speedMs: 365,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });

        expect(shot2).not.toBeNull();
        expect(shot2!.stopped).toBe(false);
        expect(shot2!.remainingEnergyJ).toBe(520);
        expect(shot2!.remainingSpeedMs).toBeCloseTo(365, 6);
        // Zero new triangles spawned on open-hole pass-through
        expect(glassSystem.activeInstancedTriangleCount).toBe(10);

        // 3. Pistol round hits VoronoiGlassWindow: shatters pane into 36..48 shards, loses 25..45 J, spawns 0 pc.Entities!
        const shotVoronoi = glassSystem.handleRaySegment({
          originWorld: { x: 3.5, y: 1.5, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 520,
          speedMs: 365,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });

        expect(shotVoronoi).not.toBeNull();
        expect(shotVoronoi!.stopped).toBe(false);
        expect(shotVoronoi!.hitMaterial).toBe('GLASS_VORONOI');
        expect(520 - shotVoronoi!.remainingEnergyJ).toBeGreaterThanOrEqual(25);
        expect(520 - shotVoronoi!.remainingEnergyJ).toBeLessThanOrEqual(45);
        expect(voronoiWin.shattered).toBe(true);
        expect(voronoiWin.intactEntity.enabled).toBe(false);
        expect(glassSystem.activeVoronoiShardCount).toBeGreaterThanOrEqual(36);
        expect(glassSystem.activeVoronoiShardCount).toBeLessThanOrEqual(48);
        expect(glassSystem.voronoiBatchEntity.enabled).toBe(true);
        // Strict Architecture Rule: ZERO new pc.Entity objects spawned per shard!
        expect(app.root.children.length).toBe(rootEntityCountBeforeShatter);

        // Follow-up shot along the shattered Voronoi window path hits no intact collider (null -> 0 J loss)
        physics.step(1 / 60);
        const shotVoronoiFollowUp = glassSystem.handleRaySegment({
          originWorld: { x: 3.5, y: 1.5, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 520,
          speedMs: 365,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        expect(shotVoronoiFollowUp).toBeNull();

        // Step 1.6s -> 1.5s instanced triangles expire cleanly while Voronoi shards bounce on floor
        for (let i = 0; i < 96; i++) {
          glassSystem.update(1 / 60);
        }
        expect(glassSystem.activeInstancedTriangleCount).toBe(0);
        expect(glassSystem.activeVoronoiShardCount).toBeGreaterThan(0);

        // 4. Blast shockwave shatters windows inside radius while leaving far window outside radius intact
        expect(farVoronoiWin.shattered).toBe(false);
        glassSystem.applyBlast({
          centerWorld: { x: 20.5, y: 1.2, z: -7.5 },
          radiusM: 4.5,
          peakImpulseNs: 45,
          peakEnergyJ: 14000,
        });
        expect(farVoronoiWin.shattered).toBe(true);

        // Reset restores all windows and clears pools
        glassSystem.reset();
        expect(farVoronoiWin.shattered).toBe(false);
        expect(voronoiWin.shattered).toBe(false);
        expect(marchingWin.pane.survivingCellCount).toBe(256);
        expect(glassSystem.activeVoronoiShardCount).toBe(0);
      } finally {
        glassSystem.destroy();
        physics.destroy();
        app.destroy();
      }
    });
  });
});
