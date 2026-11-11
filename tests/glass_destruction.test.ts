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
  ArmoredVoronoiGlassPane,
  DEFAULT_SHARD_FLOOR_Y,
  DEFAULT_VORONOI_SHARD_THICKNESS_M,
  GlassShardPool,
  ProgressiveVoronoiPane,
  computeSignedPolygonArea2D,
  extrudeConvexShard2D,
  shatterWindowVoronoi2D,
} from '../src/core/destruction/glassVoronoiShatter.ts';
import {
  GlassSystem,
  createMarchingGlassAtlasTexture,
  createWindowGlassPaneTexture,
  generateMarchingGlassAtlasRgba8,
  generateWindowGlassPaneRgba8,
} from '../src/engine/destruction/glassSystem.ts';
import {
  RapierPhysicsWorld,
  initRapierPhysics,
} from '../src/engine/physics/rapierWorld.ts';

describe('Pillar 4: Unified Voronoi Glass Destruction — Multi-Hit Armored Laminate & Large-Chunk Progressive Plate Glass', () => {
  beforeAll(async () => {
    await initRapierPhysics();
  });

  describe('1. Pure Marching-Tile Bitmask Contracts (0..255) & UV Sync Helpers', () => {
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

      expect(computeNeighborBitmask8(cells, gridW, gridH, 8, 8, false)).toBe(255);
      expect(computeNeighborBitmask8(cells, gridW, gridH, 8, 8, true)).toBe(255);

      expect(computeNeighborBitmask8(cells, gridW, gridH, 0, 0, false)).toBe(
        GLASS_DIR_N | GLASS_DIR_NE | GLASS_DIR_E,
      );
      expect(computeNeighborBitmask8(cells, gridW, gridH, 15, 0, false)).toBe(
        GLASS_DIR_N | GLASS_DIR_W | GLASS_DIR_NW,
      );
      expect(computeNeighborBitmask8(cells, gridW, gridH, 0, 15, false)).toBe(
        GLASS_DIR_E | GLASS_DIR_SE | GLASS_DIR_S,
      );
      expect(computeNeighborBitmask8(cells, gridW, gridH, 15, 15, false)).toBe(
        GLASS_DIR_S | GLASS_DIR_SW | GLASS_DIR_W,
      );

      expect(computeNeighborBitmask8(cells, gridW, gridH, 8, 0, false)).toBe(
        255 & ~(GLASS_DIR_SE | GLASS_DIR_S | GLASS_DIR_SW),
      );
      expect(computeNeighborBitmask8(cells, gridW, gridH, 8, 15, false)).toBe(
        255 & ~(GLASS_DIR_NW | GLASS_DIR_N | GLASS_DIR_NE),
      );
      expect(computeNeighborBitmask8(cells, gridW, gridH, 0, 8, false)).toBe(
        255 & ~(GLASS_DIR_NW | GLASS_DIR_W | GLASS_DIR_SW),
      );
      expect(computeNeighborBitmask8(cells, gridW, gridH, 15, 8, false)).toBe(
        255 & ~(GLASS_DIR_NE | GLASS_DIR_E | GLASS_DIR_SE),
      );

      expect(computeNeighborBitmask8(cells, gridW, gridH, 0, 0, true)).toBe(255);
      expect(computeNeighborBitmask8(cells, gridW, gridH, 15, 15, true)).toBe(255);

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

      expect(Array.from(paneA.cells)).toEqual(Array.from(paneB.cells));
      expect(impactA.alreadyBrokenHole).toBe(false);
      expect(impactA.tendrilsSpawned).toBeGreaterThanOrEqual(4);
      expect(impactA.tendrilsSpawned).toBeLessThanOrEqual(8);
      expect(impactA.cellsBroken).toBeGreaterThan(0);
      expect(impactA.cellsCracked).toBeGreaterThan(0);
      expect(paneA.isBrokenAtUv(0.5, 0.5)).toBe(true);

      const followUp = paneA.applyImpact({
        u: 0.5,
        v: 0.5,
        energyJ: 850,
        radiusM: 0.03,
        seed: 9999,
      });
      expect(followUp.alreadyBrokenHole).toBe(true);
      expect(followUp.cellsBroken).toBe(0);

      const postMesh = paneA.writeQuadGridBuffers();
      expect(postMesh.quadCount).toBe(paneA.survivingCellCount);
      expect(postMesh.quadCount).toBe(256 - impactA.cellsBroken);
      expect(postMesh.vertexCount).toBe(postMesh.quadCount * 4);
      expect(postMesh.indexCount).toBe(postMesh.quadCount * 6);
    });
  });

  describe('2. Delaunator 2D Voronoi Shatter (Both Large-Plate & Fine Modes), Topology & Prism Extrusion', () => {
    it('partitions [0, widthM] x [0, heightM] into gap-free convex Voronoi shards across both 18-26 large plates and 36-48 shards', () => {
      const cases = [
        { widthM: 2.2, heightM: 1.7, hitX: 1.1, hitY: 0.85, shardCount: 22, seed: 55 },
        { widthM: 1.8, heightM: 1.2, hitX: 0.9, hitY: 0.6, shardCount: 42, seed: 101 },
        { widthM: 2.4, heightM: 1.5, hitX: 0.35, hitY: 1.25, shardCount: 48, seed: 202 },
        { widthM: 1.1, heightM: 1.9, hitX: 0.95, hitY: 0.2, shardCount: 36, seed: 303 },
      ];

      for (const tc of cases) {
        const res = shatterWindowVoronoi2D(tc);
        const expectedArea = tc.widthM * tc.heightM;

        expect(res.shards.length).toBe(tc.shardCount);
        expect(Math.abs(res.totalAreaM2 - expectedArea)).toBeLessThan(1e-3);

        let nearAreaSum = 0;
        let nearCount = 0;
        let farAreaSum = 0;
        let farCount = 0;
        let frameTouchingCount = 0;
        const diag = Math.hypot(tc.widthM, tc.heightM);

        for (const shard of res.shards) {
          expect(shard.polygon.length).toBeGreaterThanOrEqual(3);
          expect(shard.areaM2).toBeGreaterThan(0);
          expect(computeSignedPolygonArea2D(shard.polygon)).toBeGreaterThan(0);
          expect(shard.neighbors.length).toBeGreaterThan(0);

          if (shard.touchesFrame) {
            frameTouchingCount++;
            expect(shard.frameContactLengthM).toBeGreaterThan(0);
          }

          for (const pt of shard.polygon) {
            expect(pt.x).toBeGreaterThanOrEqual(-1e-9);
            expect(pt.x).toBeLessThanOrEqual(tc.widthM + 1e-9);
            expect(pt.y).toBeGreaterThanOrEqual(-1e-9);
            expect(pt.y).toBeLessThanOrEqual(tc.heightM + 1e-9);
          }

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

        expect(frameTouchingCount).toBeGreaterThanOrEqual(4);
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

        for (let i = 0; i < sides; i++) {
          expect(ext.localPositions[i * 3 + 2]).toBeCloseTo(0.005, 6);
          expect(ext.localNormals[i * 3 + 2]).toBeCloseTo(1, 6);

          const backV = sides + i;
          expect(ext.localPositions[backV * 3 + 2]).toBeCloseTo(-0.005, 6);
          expect(ext.localNormals[backV * 3 + 2]).toBeCloseTo(-1, 6);
        }

        for (let v = 2 * sides; v < 6 * sides; v++) {
          const nx = ext.localNormals[v * 3];
          const ny = ext.localNormals[v * 3 + 1];
          const nz = ext.localNormals[v * 3 + 2];
          expect(nz).toBeCloseTo(0, 6);
          expect(Math.hypot(nx, ny)).toBeCloseTo(1, 5);
        }
      }
    });

    it('models multi-shot ArmoredVoronoiGlassPane crazing before detachment and ProgressiveVoronoiPane clinging fangs', () => {
      const armored = new ArmoredVoronoiGlassPane({
        widthM: 2.2,
        heightM: 1.7,
        cellCount: 68,
        thicknessM: 0.028,
        seed: 4242,
      });

      expect(Math.abs(armored.voronoi.totalAreaM2 - 2.2 * 1.7)).toBeLessThan(1e-3);
      expect(armored.survivingChunkCount).toBe(68);

      // Shot 1 with 9mm pistol (500 J): crazes & cracks Voronoi chunks, ZERO chunks detach!
      const pistolShot1 = armored.applyImpact({
        hitX: 1.1,
        hitY: 0.85,
        energyJ: 500,
        seed: 1001,
      });
      expect(pistolShot1.alreadyBrokenHole).toBe(false);
      expect(pistolShot1.newlyDetachedIndices.length).toBe(0);
      expect(pistolShot1.chunksCrazed).toBeGreaterThanOrEqual(4);
      expect(armored.detachedChunkCount).toBe(0);
      expect(armored.crazedChunkCount).toBeGreaterThanOrEqual(4);

      // Shot 2 with 9mm pistol at same crazed chunk: shears the weakened chunk out of the laminate!
      const pistolShot2 = armored.applyImpact({
        hitX: 1.1,
        hitY: 0.85,
        energyJ: 500,
        seed: 1002,
      });
      expect(pistolShot2.newlyDetachedIndices.length).toBeGreaterThanOrEqual(1);
      expect(armored.isDetachedAt(1.1, 0.85)).toBe(true);

      // Progressive regular glass pane: large breach + surviving perimeter fangs
      const shatter22 = shatterWindowVoronoi2D({
        widthM: 2.2,
        heightM: 1.7,
        hitX: 1.1,
        hitY: 0.85,
        shardCount: 22,
        seed: 8080,
      });
      const progressive = new ProgressiveVoronoiPane(shatter22);
      const initialDetached = progressive.triggerInitialBreach(520);
      expect(initialDetached.length).toBeGreaterThanOrEqual(12);
      expect(progressive.survivingFangCount).toBeGreaterThanOrEqual(2);
      expect(initialDetached.length + progressive.survivingFangCount).toBe(22);

      // Open breach shot hits nothing
      const openShot = progressive.strikeClingingFangs(1.1, 0.85, 520);
      expect(openShot.hitOpenBreach).toBe(true);
      expect(openShot.newlyDetachedIndices.length).toBe(0);

      // Shooting a surviving perimeter fang knocks it loose
      const fangIdx = progressive.attached.findIndex((v) => v === 1);
      expect(fangIdx).toBeGreaterThanOrEqual(0);
      const fangCentroid = shatter22.shards[fangIdx].centroid;
      const fangShot = progressive.strikeClingingFangs(
        fangCentroid.x,
        fangCentroid.y,
        520,
      );
      expect(fangShot.hitOpenBreach).toBe(false);
      expect(fangShot.newlyDetachedIndices.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('3. 500+ Shard Custom JS Floor-Bounce Simulator Performance & Ground Clamping', () => {
    it('simulates 520 concurrent Voronoi shards with y >= 0.008 floor bounce, restitution 0.28, and fast batched mesh output', () => {
      const pool = new GlassShardPool(550);
      const templateShatter = shatterWindowVoronoi2D({
        widthM: 1.6,
        heightM: 1.2,
        hitX: 0.8,
        hitY: 0.6,
        shardCount: 44,
        seed: 777,
      });

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

      const outPos = new Float32Array(550 * 96 * 3);
      const outNorm = new Float32Array(550 * 96 * 3);
      const outUv = new Float32Array(550 * 96 * 2);
      const outIdx = new Uint32Array(550 * 180);

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

      expect(minObservedY).toBeGreaterThanOrEqual(DEFAULT_SHARD_FLOOR_Y - 1e-6);
      expect(sawBounceUpward).toBe(true);
      expect(meshStats.activeShards).toBe(520);
      expect(meshStats.vertexCount).toBeGreaterThan(520 * 18);
      expect(meshStats.indexCount).toBeGreaterThan(520 * 24);
      expect(elapsedMs).toBeLessThan(1000);

      for (let step = 0; step < 150; step++) {
        pool.step(1 / 30);
      }
      expect(pool.activeCount).toBe(0);
    });
  });

  describe('4. GlassSystem Integration (Window-Space Texture, Multi-Hit Armored Glass, Progressive Large-Chunk Glass & Blast)', () => {
    it('uses seamless window-space [0,1] glass textures, takes multiple shots on armored glass before chunks fall out, and shatters regular glass into large chunks + shootable fangs', () => {
      // A. Procedural atlas & window-space texture checks
      const rgba = generateMarchingGlassAtlasRgba8(512);
      expect(rgba.length).toBe(512 * 512 * 4);

      let tile255ZeroAlphaCount = 0;
      let tile255MinR = 255;
      let tile255MaxR = 0;
      for (let ly = 0; ly < 32; ly++) {
        for (let lx = 0; lx < 32; lx++) {
          const idx = ((15 * 32 + ly) * 512 + (15 * 32 + lx)) * 4;
          if (rgba[idx + 3] === 0) tile255ZeroAlphaCount++;
          tile255MinR = Math.min(tile255MinR, rgba[idx]);
          tile255MaxR = Math.max(tile255MaxR, rgba[idx]);
        }
      }
      expect(tile255ZeroAlphaCount).toBe(0);
      // Tile 255 has no harsh per-tile diagonal contrast
      expect(tile255MaxR - tile255MinR).toBeLessThanOrEqual(4);

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

      const paneRgba = generateWindowGlassPaneRgba8(256);
      expect(paneRgba.length).toBe(256 * 256 * 4);
      // Center of pane is brighter than dark rubber perimeter gasket at (0, 0)
      const cornerG = paneRgba[1];
      const centerG = paneRgba[(128 * 256 + 128) * 4 + 1];
      expect(centerG).toBeGreaterThan(cornerG + 40);

      const canvasStub = { width: 640, height: 480 };
      const device = new pc.NullGraphicsDevice(canvasStub);
      const app = new pc.Application(
        canvasStub as unknown as HTMLCanvasElement,
        { graphicsDevice: device },
      );
      const physics = new RapierPhysicsWorld();
      const glassSystem = new GlassSystem(app, physics);

      try {
        const atlasTex = createMarchingGlassAtlasTexture(device, 512);
        const winTex = createWindowGlassPaneTexture(device, 256);
        expect(atlasTex.width).toBe(512);
        expect(winTex.width).toBe(256);
        atlasTex.destroy();
        winTex.destroy();

        const marchingWin = glassSystem.createMarchingWindow({
          id: 'win_marching_front',
          centerWorld: { x: 0, y: 1.5, z: -6.0 },
          widthM: 2.2,
          heightM: 1.7,
        });

        const voronoiWin = glassSystem.createVoronoiWindow({
          id: 'glass_voronoi_window',
          centerWorld: { x: 4.5, y: 1.5, z: -8.0 },
          widthM: 2.2,
          heightM: 1.7,
          voronoiShardCount: 42, // Legacy arena default automatically upgrades to bold 22-plate mode
        });
        expect(voronoiWin.voronoiShardCount).toBe(22);

        const farVoronoiWin = glassSystem.createVoronoiWindow({
          id: 'win_voronoi_far',
          centerWorld: { x: 22.0, y: 1.5, z: -8.0 },
          widthM: 1.6,
          heightM: 1.2,
        });

        // Verify armored window UVs span full [0, 1] window-space (NOT [15/16..1] tile 255!)
        const rawUvs: number[] = [];
        marchingWin.mesh.getUvs(0, rawUvs);
        let minU = 1;
        let maxU = 0;
        for (let i = 0; i < rawUvs.length; i += 2) {
          minU = Math.min(minU, rawUvs[i]);
          maxU = Math.max(maxU, rawUvs[i]);
        }
        expect(minU).toBeLessThan(0.02);
        expect(maxU).toBeGreaterThan(0.98);

        physics.step(1 / 60);
        const rootEntityCountBeforeShatter = app.root.children.length;

        // 1A. Pistol shot (500 J) at left side of Armored Window: crazes Voronoi chunks, 0 chunks fall out!
        const pistolHitX = -0.55;
        const pistolShot1 = glassSystem.handleRaySegment({
          originWorld: { x: pistolHitX, y: 1.5, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 500,
          speedMs: 360,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        expect(pistolShot1).not.toBeNull();
        expect(marchingWin.crazedChunkCount).toBeGreaterThanOrEqual(4);
        expect(marchingWin.detachedChunkCount).toBe(0);
        expect(marchingWin.isBrokenAtWorldPoint({ x: pistolHitX, y: 1.5, z: -6.0 })).toBe(false);
        expect(glassSystem.activeVoronoiShardCount).toBe(0);

        // 1B. Second pistol shot (500 J) at same spot shears the crazed armored Voronoi chunk loose into VoronoiShardPool!
        const pistolShot2 = glassSystem.handleRaySegment({
          originWorld: { x: pistolHitX, y: 1.5, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 500,
          speedMs: 360,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        expect(pistolShot2).not.toBeNull();
        expect(marchingWin.detachedChunkCount).toBeGreaterThanOrEqual(1);
        expect(marchingWin.isBrokenAtWorldPoint({ x: pistolHitX, y: 1.5, z: -6.0 })).toBe(true);
        expect(glassSystem.activeVoronoiShardCount).toBeGreaterThanOrEqual(1);

        // 2A. Rifle round (3400 J) hits right side of Armored Window: punches tight bullseye core + crazes wide halo
        const rifleHitX = 0.45;
        const detachedBeforeRifle = marchingWin.detachedChunkCount;
        const shot1 = glassSystem.handleRaySegment({
          originWorld: { x: rifleHitX, y: 1.5, z: 0 },
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
        // Tight core perforation (1..2 cells), while surrounding halo chunks stay held in the laminate!
        const rifleCoreDetached = marchingWin.detachedChunkCount - detachedBeforeRifle;
        expect(rifleCoreDetached).toBeGreaterThanOrEqual(1);
        expect(rifleCoreDetached).toBeLessThanOrEqual(3);
        expect(marchingWin.crazedChunkCount).toBeGreaterThanOrEqual(8);
        expect(marchingWin.pane.survivingCellCount).toBeLessThan(256);

        // 2B. Follow-up bullet through the SAME open rifle hole loses 0 J!
        const trianglesBeforePass = glassSystem.activeInstancedTriangleCount;
        const shot2 = glassSystem.handleRaySegment({
          originWorld: { x: rifleHitX, y: 1.5, z: 0 },
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
        expect(glassSystem.activeInstancedTriangleCount).toBe(trianglesBeforePass);

        // 2C. Offset follow-up rifle shot into the surviving crazed halo knocks out multiple weakened armored chunks!
        const haloTargetWorld = { x: rifleHitX + 0.28, y: 1.55, z: -6.0 };
        expect(marchingWin.isBrokenAtWorldPoint(haloTargetWorld)).toBe(false);
        const detachedBeforeHaloHit = marchingWin.detachedChunkCount;
        glassSystem.handleRaySegment({
          originWorld: { x: haloTargetWorld.x, y: haloTargetWorld.y, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 2400,
          speedMs: 760,
          caliberRadiusM: 0.0039,
          isArmorPiercing: false,
        });
        expect(marchingWin.isBrokenAtWorldPoint(haloTargetWorld)).toBe(true);
        expect(marchingWin.detachedChunkCount - detachedBeforeHaloHit).toBeGreaterThanOrEqual(2);

        // 3. Pistol round hits VoronoiGlassWindow: shatters into large plate breach + frame-clinging corner fangs!
        const shardsBeforeRegular = glassSystem.activeVoronoiShardCount;
        const shotVoronoi = glassSystem.handleRaySegment({
          originWorld: { x: 4.5, y: 1.5, z: 0 },
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
        expect(voronoiWin.survivingFangCount).toBeGreaterThanOrEqual(2);
        expect(voronoiWin.fangEntity.enabled).toBe(true);

        const spawnedLargePlates =
          glassSystem.activeVoronoiShardCount - shardsBeforeRegular;
        expect(spawnedLargePlates).toBeGreaterThanOrEqual(12);
        expect(spawnedLargePlates).toBeLessThan(22);
        expect(glassSystem.voronoiBatchEntity.enabled).toBe(true);
        // Strict Architecture Rule: ZERO new pc.Entity objects spawned at runtime!
        expect(app.root.children.length).toBe(rootEntityCountBeforeShatter);

        // Follow-up shot through the open center breach returns null (0 J loss)!
        physics.step(1 / 60);
        const shotVoronoiFollowUp = glassSystem.handleRaySegment({
          originWorld: { x: 4.5, y: 1.5, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 520,
          speedMs: 365,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        expect(shotVoronoiFollowUp).toBeNull();

        // Shooting a surviving corner fang knocks it loose into GlassShardPool!
        const fangsBeforeCornerShot = voronoiWin.survivingFangCount;
        // Probe corners until we find a surviving fang world coordinate
        const cornerCandidates = [
          { x: 4.5 - 1.02, y: 1.5 + 0.78, z: -8.0 },
          { x: 4.5 + 1.02, y: 1.5 + 0.78, z: -8.0 },
          { x: 4.5 - 1.02, y: 1.5 - 0.78, z: -8.0 },
          { x: 4.5 + 1.02, y: 1.5 - 0.78, z: -8.0 },
        ];
        const liveCorner = cornerCandidates.find(
          (pt) => !voronoiWin.isOpenAtWorldPoint(pt),
        );
        expect(liveCorner).toBeDefined();

        const cornerShot = glassSystem.handleRaySegment({
          originWorld: { x: liveCorner!.x, y: liveCorner!.y, z: 0 },
          directionWorld: { x: 0, y: 0, z: -1 },
          maxDistanceM: 15,
          kineticEnergyJ: 520,
          speedMs: 365,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        expect(cornerShot).not.toBeNull();
        expect(voronoiWin.survivingFangCount).toBeLessThan(fangsBeforeCornerShot);

        // Step 1.6s -> 1.5s instanced spall chips expire cleanly while 3D Voronoi chunks bounce on floor
        for (let i = 0; i < 96; i++) {
          glassSystem.update(1 / 60);
        }
        expect(glassSystem.activeInstancedTriangleCount).toBe(0);
        expect(glassSystem.activeVoronoiShardCount).toBeGreaterThan(0);

        // 4. Blast shockwave shatters windows inside radius (removing all fangs) while leaving far windows outside radius intact
        expect(farVoronoiWin.shattered).toBe(false);
        glassSystem.applyBlast({
          centerWorld: { x: 20.5, y: 1.2, z: -7.5 },
          radiusM: 4.5,
          peakImpulseNs: 45,
          peakEnergyJ: 14000,
        });
        expect(farVoronoiWin.shattered).toBe(true);
        expect(farVoronoiWin.survivingFangCount).toBe(0);

        // Reset restores all windows and clears pools
        glassSystem.reset();
        expect(farVoronoiWin.shattered).toBe(false);
        expect(voronoiWin.shattered).toBe(false);
        expect(voronoiWin.fangEntity.enabled).toBe(false);
        expect(marchingWin.survivingChunkCount).toBe(68);
        expect(marchingWin.crazedChunkCount).toBe(0);
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
