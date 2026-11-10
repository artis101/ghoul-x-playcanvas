import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  ColliderSurfaceTag,
  IDestructibleSubsystem,
  PenetrationRayHit,
  QuatLike,
} from '../../contracts/destruction.ts';
import {
  GLASS_CELL_CRACKED,
  GLASS_CELL_VOID,
  GLASS_DIR_E,
  GLASS_DIR_N,
  GLASS_DIR_NE,
  GLASS_DIR_NW,
  GLASS_DIR_S,
  GLASS_DIR_SE,
  GLASS_DIR_SW,
  GLASS_DIR_W,
  MARCHING_ATLAS_GRID_DIM,
  MarchingGlassPane,
  createDeterministicPrng,
} from '../../core/destruction/glassMarchingTiles.ts';
import {
  DEFAULT_VORONOI_SHARD_THICKNESS_M,
  GlassShardPool,
  shatterWindowVoronoi2D,
} from '../../core/destruction/glassVoronoiShatter.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };
const INSTANCED_SHARDS_PER_MARCHING_HIT = 10;
const INSTANCED_SHARD_TTL_S = 1.5;
const MIN_GLASS_ENERGY_LOSS_J = 25;
const MAX_GLASS_ENERGY_LOSS_J = 45;

export interface GlassWindowCreateOptions {
  id?: string;
  centerWorld: Vec3Like;
  widthM: number;
  heightM: number;
  thicknessM?: number;
  rotationQuat?: QuatLike;
  /** Energy lost when breaking fresh glass (clamped to `25..45 J` for realistic pass-through). */
  penetrationResistanceJ?: number;
  /** Grid columns for `MarchingTileGlassWindow` (default `16`). */
  gridW?: number;
  /** Grid rows for `MarchingTileGlassWindow` (default `16`). */
  gridH?: number;
  /** Interior Voronoi shard count in `[36, 48]` for `VoronoiGlassWindow` (default `42`). */
  voronoiShardCount?: number;
}

export interface GlassSystemOptions {
  id?: string;
  atlasSizePx?: number;
  maxInstancedTriangles?: number;
  maxVoronoiShards?: number;
}

function normalizeQuat(q?: QuatLike): QuatLike {
  if (!q) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-7) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const inv = 1 / len;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
}

function rotateVec3ByQuat(v: Vec3Like, q: QuatLike): Vec3Like {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function inverseRotateVec3ByQuat(v: Vec3Like, q: QuatLike): Vec3Like {
  // Conjugate quaternion (-x, -y, -z, w)
  const tx = 2 * (-q.y * v.z + q.z * v.y);
  const ty = 2 * (-q.z * v.x + q.x * v.z);
  const tz = 2 * (-q.x * v.y + q.y * v.x);
  return {
    x: v.x + q.w * tx + (-q.y * tz + q.z * ty),
    y: v.y + q.w * ty + (-q.z * tx + q.x * tz),
    z: v.z + q.w * tz + (-q.x * ty + q.y * tx),
  };
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function triangleWave(t: number): number {
  return Math.abs(fract(t) - 0.5) * 2;
}

function jaggedCrystallineTeethProfile(coord01: number, phase: number): number {
  const c1 = triangleWave(coord01 * 3.0 + phase);
  const c2 = triangleWave(coord01 * 7.0 + phase * 1.73);
  const c3 = triangleWave(coord01 * 13.0 + phase * 2.41);
  return c1 * 0.54 + c2 * 0.31 + c3 * 0.15;
}

/**
 * Generates the raw `RGBA8` (`size x size x 4`, default `512x512`, `32x32` px per bitmask
 * `0..255`) procedural crack & jagged crystalline edge atlas buffer:
 * - Missing neighbor directions (`(mask & bit) === 0`) carve translucent jagged crystalline
 *   glass teeth (`alpha = 0` void) + bright icy specular fracture rims + internal spiderweb
 *   crack lines!
 * - Tile `255` (`0b11111111`) renders smooth semi-transparent architectural tempered glass.
 */
export function generateMarchingGlassAtlasRgba8(atlasSize = 512): Uint8Array {
  const tilePx = Math.max(8, Math.floor(atlasSize / MARCHING_ATLAS_GRID_DIM));
  const size = tilePx * MARCHING_ATLAS_GRID_DIM;
  const rgba = new Uint8Array(size * size * 4);

  for (let mask = 0; mask < 256; mask++) {
    const tileCol = mask % MARCHING_ATLAS_GRID_DIM;
    const tileRow = Math.floor(mask / MARCHING_ATLAS_GRID_DIM);
    const basePxX = tileCol * tilePx;
    const basePxY = tileRow * tilePx;

    const missN = (mask & GLASS_DIR_N) === 0;
    const missNE = (mask & GLASS_DIR_NE) === 0;
    const missE = (mask & GLASS_DIR_E) === 0;
    const missSE = (mask & GLASS_DIR_SE) === 0;
    const missS = (mask & GLASS_DIR_S) === 0;
    const missSW = (mask & GLASS_DIR_SW) === 0;
    const missW = (mask & GLASS_DIR_W) === 0;
    const missNW = (mask & GLASS_DIR_NW) === 0;

    // Weighted fracture origin bias toward missing directions for internal spiderweb rays
    let crackOriginX = 0.5;
    let crackOriginY = 0.5;
    let missingWeight = 0;
    const accumOrigin = (ox: number, oy: number): void => {
      crackOriginX += ox;
      crackOriginY += oy;
      missingWeight++;
    };
    if (missN) accumOrigin(0.5, 1.0);
    if (missNE) accumOrigin(1.0, 1.0);
    if (missE) accumOrigin(1.0, 0.5);
    if (missSE) accumOrigin(1.0, 0.0);
    if (missS) accumOrigin(0.5, 0.0);
    if (missSW) accumOrigin(0.0, 0.0);
    if (missW) accumOrigin(0.0, 0.5);
    if (missNW) accumOrigin(0.0, 1.0);

    if (missingWeight > 0) {
      crackOriginX /= missingWeight + 1;
      crackOriginY /= missingWeight + 1;
    }

    const maskPhase = ((mask * 2654435761) >>> 0) * 2.3283064365386963e-10;

    for (let ly = 0; ly < tilePx; ly++) {
      const v = (ly + 0.5) / tilePx; // 0 (South) -> 1 (North)
      const py = basePxY + ly;

      for (let lx = 0; lx < tilePx; lx++) {
        const u = (lx + 0.5) / tilePx; // 0 (West) -> 1 (East)
        const px = basePxX + lx;
        const outIdx = (py * size + px) * 4;

        let minMargin = 10.0;

        if (missN) {
          const depth = 0.13 + 0.24 * jaggedCrystallineTeethProfile(u, 0.11);
          minMargin = Math.min(minMargin, 1 - v - depth);
        }
        if (missS) {
          const depth = 0.13 + 0.24 * jaggedCrystallineTeethProfile(u, 0.61);
          minMargin = Math.min(minMargin, v - depth);
        }
        if (missE) {
          const depth = 0.13 + 0.24 * jaggedCrystallineTeethProfile(v, 0.37);
          minMargin = Math.min(minMargin, 1 - u - depth);
        }
        if (missW) {
          const depth = 0.13 + 0.24 * jaggedCrystallineTeethProfile(v, 0.87);
          minMargin = Math.min(minMargin, u - depth);
        }

        // Diagonal corner notches when corner neighbor is broken out
        if (missNE) {
          const diagDist = (1 - u) + (1 - v);
          const notch = 0.22 + 0.17 * jaggedCrystallineTeethProfile(u - v + 1, 0.19);
          minMargin = Math.min(minMargin, (diagDist - notch) * 0.72);
        }
        if (missSE) {
          const diagDist = (1 - u) + v;
          const notch = 0.22 + 0.17 * jaggedCrystallineTeethProfile(u + v, 0.43);
          minMargin = Math.min(minMargin, (diagDist - notch) * 0.72);
        }
        if (missSW) {
          const diagDist = u + v;
          const notch = 0.22 + 0.17 * jaggedCrystallineTeethProfile(u - v + 1, 0.71);
          minMargin = Math.min(minMargin, (diagDist - notch) * 0.72);
        }
        if (missNW) {
          const diagDist = u + (1 - v);
          const notch = 0.22 + 0.17 * jaggedCrystallineTeethProfile(u + v, 0.93);
          minMargin = Math.min(minMargin, (diagDist - notch) * 0.72);
        }

        // Open carved tooth void -> completely transparent!
        if (minMargin < 0) {
          rgba[outIdx] = 0;
          rgba[outIdx + 1] = 0;
          rgba[outIdx + 2] = 0;
          rgba[outIdx + 3] = 0;
          continue;
        }

        // Base architectural tempered glass tint + subtle diagonal reflection sheen
        const sheen = Math.max(0, 1 - Math.abs(u * 0.75 + v * 0.65 - 0.72) * 3.4);
        let r = 148 + sheen * 34;
        let g = 208 + sheen * 28;
        let b = 226 + sheen * 22;
        let a = 64 + sheen * 24;

        if (mask !== 255) {
          // Internal spiderweb crack network radiating across surviving glass adjacent to hole
          const dx = u - crackOriginX;
          const dy = v - crackOriginY;
          const radialDist = Math.hypot(dx, dy);
          const angle01 = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);

          const radialSpokeWave = triangleWave(
            angle01 * (5 + (mask % 3)) + radialDist * 0.55 + maskPhase,
          );
          const radialCrack =
            radialSpokeWave < 0.068
              ? (1 - radialSpokeWave / 0.068) * Math.max(0.25, 1 - radialDist * 0.65)
              : 0;

          const ringJitter = 0.04 * triangleWave(angle01 * 6.0 + maskPhase * 2.1);
          const ringWave = triangleWave(radialDist * 3.4 + ringJitter + maskPhase);
          const concentricCrack =
            ringWave < 0.055 && minMargin < 0.45
              ? (1 - ringWave / 0.055) * 0.82
              : 0;

          const crackStrength = Math.min(1, Math.max(radialCrack, concentricCrack));
          if (crackStrength > 0) {
            r = r + (232 - r) * crackStrength;
            g = g + (250 - g) * crackStrength;
            b = b + (255 - b) * crackStrength;
            a = Math.max(a, 96 + crackStrength * 124);
          }

          // Bright crystalline specular fracture rim right along carved tooth edges (~2.8 px)
          const rimWidth = 2.8 / tilePx;
          if (minMargin < rimWidth) {
            const rimT = 1 - minMargin / rimWidth;
            const sharpRim = rimT * (0.45 + 0.55 * rimT);
            r = r + (246 - r) * sharpRim;
            g = g + (254 - g) * sharpRim;
            b = b + (255 - b) * sharpRim;
            a = Math.max(a, 145 + sharpRim * 105);
          }
        }

        rgba[outIdx] = Math.max(0, Math.min(255, Math.round(r)));
        rgba[outIdx + 1] = Math.max(0, Math.min(255, Math.round(g)));
        rgba[outIdx + 2] = Math.max(0, Math.min(255, Math.round(b)));
        rgba[outIdx + 3] = Math.max(0, Math.min(255, Math.round(a)));
      }
    }
  }

  return rgba;
}

/**
 * Procedural 16x16 (256-Tile) Crack & Jagged Edge Atlas `pc.Texture` (`512x512` RGBA8).
 */
export function createMarchingGlassAtlasTexture(
  device: pc.GraphicsDevice,
  atlasSize = 512,
): pc.Texture {
  const tilePx = Math.max(8, Math.floor(atlasSize / MARCHING_ATLAS_GRID_DIM));
  const size = tilePx * MARCHING_ATLAS_GRID_DIM;
  const rgba = generateMarchingGlassAtlasRgba8(size);

  return new pc.Texture(device, {
    name: 'MarchingGlassAtlas256',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    flipY: false,
    levels: [rgba],
  });
}

/**
 * Builds a sharp double-sided 3D crystalline triangular glass shard prism mesh (`1` unit scale)
 * used by the shared `HardwareInstancedPool` when marching-tile cells shatter.
 */
function createCrystallineTriangleShardMesh(device: pc.GraphicsDevice): pc.Mesh {
  const hz = 0.08;
  // Asymmetric sharp shard triangle in XY extruded along Z
  const p0x = -0.5;
  const p0y = -0.36;
  const p1x = 0.56;
  const p1y = -0.22;
  const p2x = -0.06;
  const p2y = 0.58;

  const positions = new Float32Array([
    // Front face (+Z)
    p0x, p0y, hz,
    p1x, p1y, hz,
    p2x, p2y, hz,
    // Back face (-Z)
    p0x, p0y, -hz,
    p2x, p2y, -hz,
    p1x, p1y, -hz,
    // Bevel edge 0->1
    p0x, p0y, hz,
    p1x, p1y, -hz,
    p1x, p1y, hz,
    p0x, p0y, hz,
    p0x, p0y, -hz,
    p1x, p1y, -hz,
    // Bevel edge 1->2
    p1x, p1y, hz,
    p2x, p2y, -hz,
    p2x, p2y, hz,
    p1x, p1y, hz,
    p1x, p1y, -hz,
    p2x, p2y, -hz,
    // Bevel edge 2->0
    p2x, p2y, hz,
    p0x, p0y, -hz,
    p0x, p0y, hz,
    p2x, p2y, hz,
    p2x, p2y, -hz,
    p0x, p0y, -hz,
  ]);

  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1,
    0.13, -0.99, 0, 0.13, -0.99, 0, 0.13, -0.99, 0,
    0.13, -0.99, 0, 0.13, -0.99, 0, 0.13, -0.99, 0,
    0.79, 0.61, 0, 0.79, 0.61, 0, 0.79, 0.61, 0,
    0.79, 0.61, 0, 0.79, 0.61, 0, 0.79, 0.61, 0,
    -0.91, 0.41, 0, -0.91, 0.41, 0, -0.91, 0.41, 0,
    -0.91, 0.41, 0, -0.91, 0.41, 0, -0.91, 0.41, 0,
  ]);

  const indices = new Uint16Array(24);
  for (let i = 0; i < 24; i++) {
    indices[i] = i;
  }

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions, 3, 24);
  mesh.setNormals(normals, 3, 24);
  mesh.setIndices(indices, 24);
  mesh.update(pc.PRIMITIVE_TRIANGLES, true);
  return mesh;
}

/**
 * Method A Window Instance — `GLASS_MARCHING_256` Rapier static collider paired with a single
 * `BUFFER_DYNAMIC` quad-grid `pc.Mesh` and pooled hardware-instanced glass shard emission.
 */
export class MarchingTileGlassWindow {
  public readonly id: string;
  public readonly centerWorld: Vec3Like;
  public readonly widthM: number;
  public readonly heightM: number;
  public readonly thicknessM: number;
  public readonly rotationQuat: QuatLike;
  public readonly penetrationResistanceJ: number;
  public readonly pane: MarchingGlassPane;
  public readonly entity: pc.Entity;
  public readonly mesh: pc.Mesh;
  public readonly meshInstance: pc.MeshInstance;

  private colliderHandleValue = -1;
  private readonly uvInset: number;
  private hitSeedCounter = 0;

  public constructor(
    app: pc.Application,
    private readonly physics: RapierPhysicsWorld,
    material: pc.Material,
    private readonly instancedPool: HardwareInstancedPool,
    atlasSizePx: number,
    options: GlassWindowCreateOptions,
  ) {
    this.id = options.id ?? `glass_marching_${Math.random().toString(36).slice(2, 8)}`;
    this.centerWorld = {
      x: options.centerWorld.x,
      y: options.centerWorld.y,
      z: options.centerWorld.z,
    };
    this.widthM = Math.max(0.1, options.widthM);
    this.heightM = Math.max(0.1, options.heightM);
    this.thicknessM = Math.max(0.006, options.thicknessM ?? 0.01);
    this.rotationQuat = normalizeQuat(options.rotationQuat);
    this.penetrationResistanceJ = Math.max(
      MIN_GLASS_ENERGY_LOSS_J,
      Math.min(MAX_GLASS_ENERGY_LOSS_J, options.penetrationResistanceJ ?? 34),
    );
    this.uvInset = 0.45 / Math.max(64, atlasSizePx);

    this.pane = new MarchingGlassPane({
      widthM: this.widthM,
      heightM: this.heightM,
      gridW: options.gridW ?? 16,
      gridH: options.gridH ?? 16,
      frameBorderIntact: true,
    });

    const maxVerts = this.pane.totalCells * 4;
    const maxIndices = this.pane.totalCells * 6;

    this.entity = new pc.Entity(this.id);
    this.entity.setPosition(
      this.centerWorld.x,
      this.centerWorld.y,
      this.centerWorld.z,
    );
    this.entity.setRotation(
      this.rotationQuat.x,
      this.rotationQuat.y,
      this.rotationQuat.z,
      this.rotationQuat.w,
    );

    this.mesh = new pc.Mesh(app.graphicsDevice);
    this.mesh.clear(true, true, maxVerts, maxIndices);
    this.rebuildDynamicMesh();

    this.meshInstance = new pc.MeshInstance(this.mesh, material);
    this.meshInstance.castShadows = false;

    this.entity.addComponent('render', {
      meshInstances: [this.meshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    app.root.addChild(this.entity);

    this.createCollider();
  }

  public get colliderHandle(): number {
    return this.colliderHandleValue;
  }

  public worldPointToUv(pointWorld: Vec3Like): { u: number; v: number; local: Vec3Like } {
    const rel: Vec3Like = {
      x: pointWorld.x - this.centerWorld.x,
      y: pointWorld.y - this.centerWorld.y,
      z: pointWorld.z - this.centerWorld.z,
    };
    const local = inverseRotateVec3ByQuat(rel, this.rotationQuat);
    const u = Math.max(0, Math.min(1, local.x / this.widthM + 0.5));
    const v = Math.max(0, Math.min(1, local.y / this.heightM + 0.5));
    return { u, v, local };
  }

  public isBrokenAtWorldPoint(pointWorld: Vec3Like): boolean {
    const { u, v } = this.worldPointToUv(pointWorld);
    return this.pane.isBrokenAtUv(u, v);
  }

  /**
   * Breaks glass at `pointWorld`, updates the `BUFFER_DYNAMIC` quad-grid `pc.Mesh`, and spawns
   * **10 pooled hardware-instanced glass triangles** via `HardwareInstancedPool.spawnKinematicParticle`
   * that fall, glint, bounce, and shrink/fade over `1.5s`.
   */
  public breakAtWorldPoint(
    pointWorld: Vec3Like,
    directionWorld: Vec3Like,
    kineticEnergyJ: number,
    impactRadiusM?: number,
    instancedCount = INSTANCED_SHARDS_PER_MARCHING_HIT,
  ): { alreadyBroken: boolean; energyAbsorbedJ: number; spawnedTriangles: number } {
    const { u, v } = this.worldPointToUv(pointWorld);
    const cellStateBefore = this.pane.getCellStateAtUv(u, v);

    const report = this.pane.applyImpact({
      u,
      v,
      energyJ: kineticEnergyJ,
      radiusM: impactRadiusM,
      seed: ++this.hitSeedCounter * 2654435761,
    });

    if (report.alreadyBrokenHole) {
      return {
        alreadyBroken: true,
        energyAbsorbedJ: 0,
        spawnedTriangles: 0,
      };
    }

    this.rebuildDynamicMesh();

    if (this.pane.survivingCellCount === 0 && this.colliderHandleValue >= 0) {
      this.physics.removeCollider(this.colliderHandleValue);
      this.colliderHandleValue = -1;
    }

    // Spawn 10 pooled hardware-instanced crystalline triangles over 1.5s
    const spawnedTriangles = this.emitInstancedTriangles(
      pointWorld,
      directionWorld,
      kineticEnergyJ,
      instancedCount,
    );

    // Pre-weakened spiderweb-cracked cells absorb slightly less energy (~26 J) than pristine (~34 J)
    const energyAbsorbedJ =
      cellStateBefore === GLASS_CELL_CRACKED
        ? Math.max(MIN_GLASS_ENERGY_LOSS_J, this.penetrationResistanceJ * 0.78)
        : this.penetrationResistanceJ;

    return {
      alreadyBroken: false,
      energyAbsorbedJ,
      spawnedTriangles,
    };
  }

  public reset(): void {
    this.pane.reset();
    this.hitSeedCounter = 0;
    this.rebuildDynamicMesh();
    if (this.colliderHandleValue < 0) {
      this.createCollider();
    }
  }

  public destroy(): void {
    if (this.colliderHandleValue >= 0) {
      this.physics.removeCollider(this.colliderHandleValue);
      this.colliderHandleValue = -1;
    }
    this.entity.destroy();
    this.mesh.destroy();
  }

  private createCollider(): void {
    const tag: ColliderSurfaceTag = {
      material: 'GLASS_MARCHING_256',
      objectId: this.id,
      thicknessM: this.thicknessM,
      penetrationResistanceJ: this.penetrationResistanceJ,
    };
    this.colliderHandleValue = this.physics.createStaticBox(
      this.centerWorld,
      {
        x: this.widthM * 0.5,
        y: this.heightM * 0.5,
        z: Math.max(0.008, this.thicknessM * 0.5),
      },
      this.rotationQuat,
      tag,
    );
  }

  private rebuildDynamicMesh(): void {
    const build = this.pane.writeQuadGridBuffers(
      this.pane.positions,
      this.pane.normals,
      this.pane.uvs,
      this.pane.indices,
      this.uvInset,
      this.pane.colors,
    );

    if (build.vertexCount === 0 || build.indexCount === 0) {
      this.entity.enabled = false;
      return;
    }

    this.entity.enabled = true;
    this.mesh.setPositions(this.pane.positions, 3, build.vertexCount);
    this.mesh.setNormals(this.pane.normals, 3, build.vertexCount);
    this.mesh.setUvs(0, this.pane.uvs, 2, build.vertexCount);
    this.mesh.setColors(this.pane.colors, 4, build.vertexCount);
    this.mesh.setIndices(this.pane.indices, build.indexCount);
    this.mesh.update(pc.PRIMITIVE_TRIANGLES, true);
  }

  private emitInstancedTriangles(
    originWorld: Vec3Like,
    directionWorld: Vec3Like,
    kineticEnergyJ: number,
    count: number,
  ): number {
    const rand = createDeterministicPrng(
      (this.hitSeedCounter * 73856093) ^ Math.round(kineticEnergyJ * 17),
    );
    const dirLen = Math.hypot(
      directionWorld.x,
      directionWorld.y,
      directionWorld.z,
    );
    const dx = dirLen > 1e-6 ? directionWorld.x / dirLen : 0;
    const dy = dirLen > 1e-6 ? directionWorld.y / dirLen : 0;
    const dz = dirLen > 1e-6 ? directionWorld.z / dirLen : -1;

    const speedBase = Math.min(
      6.5,
      1.8 + Math.sqrt(Math.max(20, kineticEnergyJ)) * 0.055,
    );

    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const radialLocal: Vec3Like = {
        x: Math.cos(angle),
        y: Math.sin(angle),
        z: 0,
      };
      const radialWorld = rotateVec3ByQuat(radialLocal, this.rotationQuat);
      const jitterOffset = 0.02 + rand() * 0.045;

      const pos: Vec3Like = {
        x: originWorld.x + radialWorld.x * jitterOffset + dx * 0.02,
        y: Math.max(0.03, originWorld.y + radialWorld.y * jitterOffset + dy * 0.02),
        z: originWorld.z + radialWorld.z * jitterOffset + dz * 0.02,
      };

      const fwdSpeed = speedBase * (0.55 + rand() * 0.75);
      const outSpeed = (0.8 + rand() * 1.9);
      const vel: Vec3Like = {
        x: dx * fwdSpeed + radialWorld.x * outSpeed,
        y: dy * fwdSpeed + radialWorld.y * outSpeed + 0.35 + rand() * 0.85,
        z: dz * fwdSpeed + radialWorld.z * outSpeed,
      };

      const angVel: Vec3Like = {
        x: (rand() - 0.5) * 24,
        y: (rand() - 0.5) * 24,
        z: (rand() - 0.5) * 24,
      };

      const shardSize = 0.038 + rand() * 0.045;
      const scale: Vec3Like = {
        x: shardSize,
        y: shardSize * (0.75 + rand() * 0.5),
        z: 0.012,
      };

      const slot = this.instancedPool.spawnKinematicParticle(
        pos,
        vel,
        angVel,
        scale,
        -9.81,
        0.28,
        INSTANCED_SHARD_TTL_S,
        this.rotationQuat,
      );
      if (slot >= 0) {
        spawned++;
      }
    }

    return spawned;
  }
}

/**
 * Method B Window Instance — `GLASS_VORONOI` Rapier static collider paired with an intact pane
 * entity that on impact disables the intact collider/mesh and shatters into `36–48` `delaunator`
 * `1 cm` extruded Voronoi shards simulated in `GlassShardPool`.
 */
export class VoronoiGlassWindow {
  public readonly id: string;
  public readonly centerWorld: Vec3Like;
  public readonly widthM: number;
  public readonly heightM: number;
  public readonly thicknessM: number;
  public readonly rotationQuat: QuatLike;
  public readonly penetrationResistanceJ: number;
  public readonly voronoiShardCount: number;
  public readonly intactEntity: pc.Entity;
  public readonly intactMesh: pc.Mesh;
  public readonly intactMeshInstance: pc.MeshInstance;

  private colliderHandleValue = -1;
  private isShattered = false;
  private shatterCounter = 0;

  public constructor(
    app: pc.Application,
    private readonly physics: RapierPhysicsWorld,
    intactMaterial: pc.Material,
    private readonly shardPool: GlassShardPool,
    options: GlassWindowCreateOptions,
  ) {
    this.id = options.id ?? `glass_voronoi_${Math.random().toString(36).slice(2, 8)}`;
    this.centerWorld = {
      x: options.centerWorld.x,
      y: options.centerWorld.y,
      z: options.centerWorld.z,
    };
    this.widthM = Math.max(0.1, options.widthM);
    this.heightM = Math.max(0.1, options.heightM);
    this.thicknessM = Math.max(
      0.006,
      options.thicknessM ?? DEFAULT_VORONOI_SHARD_THICKNESS_M,
    );
    this.rotationQuat = normalizeQuat(options.rotationQuat);
    this.penetrationResistanceJ = Math.max(
      MIN_GLASS_ENERGY_LOSS_J,
      Math.min(MAX_GLASS_ENERGY_LOSS_J, options.penetrationResistanceJ ?? 38),
    );
    this.voronoiShardCount = Math.max(
      36,
      Math.min(48, Math.round(options.voronoiShardCount ?? 42)),
    );

    this.intactMesh = pc.Mesh.fromGeometry(
      app.graphicsDevice,
      new pc.BoxGeometry({
        halfExtents: new pc.Vec3(
          this.widthM * 0.5,
          this.heightM * 0.5,
          this.thicknessM * 0.5,
        ),
      }),
    );
    this.intactMeshInstance = new pc.MeshInstance(this.intactMesh, intactMaterial);
    this.intactMeshInstance.castShadows = false;

    this.intactEntity = new pc.Entity(this.id);
    this.intactEntity.setPosition(
      this.centerWorld.x,
      this.centerWorld.y,
      this.centerWorld.z,
    );
    this.intactEntity.setRotation(
      this.rotationQuat.x,
      this.rotationQuat.y,
      this.rotationQuat.z,
      this.rotationQuat.w,
    );
    this.intactEntity.addComponent('render', {
      meshInstances: [this.intactMeshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    app.root.addChild(this.intactEntity);

    this.createCollider();
  }

  public get colliderHandle(): number {
    return this.colliderHandleValue;
  }

  public get shattered(): boolean {
    return this.isShattered;
  }

  public worldPointToWindowCoords(pointWorld: Vec3Like): { hitX: number; hitY: number } {
    const rel: Vec3Like = {
      x: pointWorld.x - this.centerWorld.x,
      y: pointWorld.y - this.centerWorld.y,
      z: pointWorld.z - this.centerWorld.z,
    };
    const local = inverseRotateVec3ByQuat(rel, this.rotationQuat);
    return {
      hitX: Math.max(0, Math.min(this.widthM, local.x + this.widthM * 0.5)),
      hitY: Math.max(0, Math.min(this.heightM, local.y + this.heightM * 0.5)),
    };
  }

  /**
   * Shatters the intact pane at `pointWorld`, removes its Rapier static collider so follow-up
   * bullets fly straight through with `0 J` loss, and spawns `36–48` `1 cm` extruded Voronoi
   * shards into `GlassShardPool`.
   */
  public shatterAtWorldPoint(
    pointWorld: Vec3Like,
    directionWorld: Vec3Like,
    kineticEnergyJ: number,
  ): { alreadyShattered: boolean; energyAbsorbedJ: number; spawnedShards: number } {
    if (this.isShattered) {
      return {
        alreadyShattered: true,
        energyAbsorbedJ: 0,
        spawnedShards: 0,
      };
    }

    this.isShattered = true;
    this.intactEntity.enabled = false;
    if (this.colliderHandleValue >= 0) {
      this.physics.removeCollider(this.colliderHandleValue);
      this.colliderHandleValue = -1;
    }

    const { hitX, hitY } = this.worldPointToWindowCoords(pointWorld);
    const seed = ++this.shatterCounter * 15485863 + Math.round(hitX * 997 + hitY * 991);

    const voronoiResult = shatterWindowVoronoi2D({
      widthM: this.widthM,
      heightM: this.heightM,
      hitX,
      hitY,
      shardCount: this.voronoiShardCount,
      thicknessM: this.thicknessM,
      seed,
    });

    const spawnedShards = this.shardPool.spawnWindowShatter(voronoiResult, {
      windowCenterWorld: this.centerWorld,
      windowRotationQuat: this.rotationQuat,
      impactDirectionWorld: directionWorld,
      impactEnergyJ: kineticEnergyJ,
      ttlSeconds: 3.8,
      seed: seed ^ 0x5bd1e995,
    });

    return {
      alreadyShattered: false,
      energyAbsorbedJ: this.penetrationResistanceJ,
      spawnedShards,
    };
  }

  public reset(): void {
    this.isShattered = false;
    this.intactEntity.enabled = true;
    if (this.colliderHandleValue < 0) {
      this.createCollider();
    }
  }

  public destroy(): void {
    if (this.colliderHandleValue >= 0) {
      this.physics.removeCollider(this.colliderHandleValue);
      this.colliderHandleValue = -1;
    }
    this.intactEntity.destroy();
    this.intactMesh.destroy();
  }

  private createCollider(): void {
    const tag: ColliderSurfaceTag = {
      material: 'GLASS_VORONOI',
      objectId: this.id,
      thicknessM: this.thicknessM,
      penetrationResistanceJ: this.penetrationResistanceJ,
    };
    this.colliderHandleValue = this.physics.createStaticBox(
      this.centerWorld,
      {
        x: this.widthM * 0.5,
        y: this.heightM * 0.5,
        z: Math.max(0.008, this.thicknessM * 0.5),
      },
      this.rotationQuat,
      tag,
    );
  }
}

/**
 * Dual Glass Destruction Subsystem (`IDestructibleSubsystem`) managing both:
 * 1. `MarchingTileGlassWindow` (`GLASS_MARCHING_256` 16x16 crack atlas + `HardwareInstancedPool` triangles)
 * 2. `VoronoiGlassWindow` (`GLASS_VORONOI` runtime `delaunator` 2D Voronoi shatter + `GlassShardPool` dynamic batch mesh)
 */
export class GlassSystem implements IDestructibleSubsystem {
  public readonly id: string;
  public readonly atlasTexture: pc.Texture;
  public readonly instancedTrianglePool: HardwareInstancedPool;
  public readonly voronoiShardPool: GlassShardPool;
  public readonly voronoiBatchEntity: pc.Entity;
  public readonly voronoiBatchMesh: pc.Mesh;

  private readonly atlasSizePx: number;
  private readonly marchingMaterial: pc.StandardMaterial;
  private readonly voronoiIntactMaterial: pc.StandardMaterial;
  private readonly voronoiShardMaterial: pc.StandardMaterial;
  private readonly instancedTriangleMaterial: pc.StandardMaterial;
  private readonly instancedTriangleMesh: pc.Mesh;

  private readonly marchingWindowMap = new Map<string, MarchingTileGlassWindow>();
  private readonly voronoiWindowMap = new Map<string, VoronoiGlassWindow>();

  private readonly batchPositions: Float32Array;
  private readonly batchNormals: Float32Array;
  private readonly batchUvs: Float32Array;
  private readonly batchColors: Float32Array;
  private readonly batchIndices: Uint32Array;

  private destroyed = false;

  public constructor(
    private readonly app: pc.Application,
    private readonly physics: RapierPhysicsWorld,
    options: GlassSystemOptions = {},
  ) {
    this.id = options.id ?? 'glass';
    this.atlasSizePx = options.atlasSizePx ?? 512;
    const maxInstancedTriangles = options.maxInstancedTriangles ?? 512;
    const maxVoronoiShards = options.maxVoronoiShards ?? 640;

    // 1. Procedural 512x512 (256-tile) crack & jagged crystalline edge atlas
    this.atlasTexture = createMarchingGlassAtlasTexture(
      app.graphicsDevice,
      this.atlasSizePx,
    );

    // 2. Materials
    this.marchingMaterial = new pc.StandardMaterial();
    this.marchingMaterial.name = 'MarchingGlass256Material';
    this.marchingMaterial.diffuse.set(0.85, 0.96, 1.0);
    this.marchingMaterial.diffuseMap = this.atlasTexture;
    this.marchingMaterial.opacityMap = this.atlasTexture;
    this.marchingMaterial.opacityMapChannel = 'a';
    this.marchingMaterial.emissive.set(0.22, 0.34, 0.38);
    this.marchingMaterial.emissiveMap = this.atlasTexture;
    this.marchingMaterial.useMetalness = true;
    this.marchingMaterial.metalness = 0.14;
    this.marchingMaterial.gloss = 0.93;
    this.marchingMaterial.blendType = pc.BLEND_NORMAL;
    this.marchingMaterial.depthWrite = false;
    this.marchingMaterial.cull = pc.CULLFACE_NONE;
    this.marchingMaterial.diffuseVertexColor = true;
    this.marchingMaterial.opacityVertexColor = true;
    this.marchingMaterial.update();

    this.voronoiIntactMaterial = new pc.StandardMaterial();
    this.voronoiIntactMaterial.name = 'VoronoiIntactGlassMaterial';
    this.voronoiIntactMaterial.diffuse.set(0.62, 0.84, 0.92);
    this.voronoiIntactMaterial.emissive.set(0.08, 0.16, 0.2);
    this.voronoiIntactMaterial.useMetalness = true;
    this.voronoiIntactMaterial.metalness = 0.18;
    this.voronoiIntactMaterial.gloss = 0.95;
    this.voronoiIntactMaterial.opacity = 0.38;
    this.voronoiIntactMaterial.blendType = pc.BLEND_NORMAL;
    this.voronoiIntactMaterial.depthWrite = false;
    this.voronoiIntactMaterial.cull = pc.CULLFACE_BACK;
    this.voronoiIntactMaterial.update();

    this.voronoiShardMaterial = new pc.StandardMaterial();
    this.voronoiShardMaterial.name = 'VoronoiExtrudedShardMaterial';
    this.voronoiShardMaterial.diffuse.set(0.76, 0.93, 0.99);
    this.voronoiShardMaterial.emissive.set(0.18, 0.28, 0.34);
    this.voronoiShardMaterial.useMetalness = true;
    this.voronoiShardMaterial.metalness = 0.2;
    this.voronoiShardMaterial.gloss = 0.96;
    this.voronoiShardMaterial.blendType = pc.BLEND_NORMAL;
    this.voronoiShardMaterial.depthWrite = false;
    this.voronoiShardMaterial.cull = pc.CULLFACE_BACK;
    this.voronoiShardMaterial.diffuseVertexColor = true;
    this.voronoiShardMaterial.opacityVertexColor = true;
    this.voronoiShardMaterial.update();

    this.instancedTriangleMaterial = new pc.StandardMaterial();
    this.instancedTriangleMaterial.name = 'InstancedGlassTriangleMaterial';
    this.instancedTriangleMaterial.diffuse.set(0.82, 0.96, 1.0);
    this.instancedTriangleMaterial.emissive.set(0.28, 0.42, 0.48);
    this.instancedTriangleMaterial.useMetalness = true;
    this.instancedTriangleMaterial.metalness = 0.22;
    this.instancedTriangleMaterial.gloss = 0.96;
    this.instancedTriangleMaterial.opacity = 0.72;
    this.instancedTriangleMaterial.blendType = pc.BLEND_NORMAL;
    this.instancedTriangleMaterial.depthWrite = false;
    this.instancedTriangleMaterial.cull = pc.CULLFACE_NONE;
    this.instancedTriangleMaterial.update();

    // 3. Shared HardwareInstancedPool for Marching-Tile flying crystalline triangles
    this.instancedTriangleMesh = createCrystallineTriangleShardMesh(
      app.graphicsDevice,
    );
    this.instancedTrianglePool = new HardwareInstancedPool(
      app,
      this.instancedTriangleMesh,
      this.instancedTriangleMaterial,
      maxInstancedTriangles,
      'GlassInstancedTrianglePool',
      false,
    );

    // 4. Shared Custom JS Floor-Bounce Pool + Single Dynamic Batched `pc.Mesh` for Voronoi Shards
    this.voronoiShardPool = new GlassShardPool(maxVoronoiShards);
    const maxBatchVerts = maxVoronoiShards * 48;
    const maxBatchIndices = maxVoronoiShards * 96;

    this.batchPositions = new Float32Array(maxBatchVerts * 3);
    this.batchNormals = new Float32Array(maxBatchVerts * 3);
    this.batchUvs = new Float32Array(maxBatchVerts * 2);
    this.batchColors = new Float32Array(maxBatchVerts * 4);
    this.batchIndices = new Uint32Array(maxBatchIndices);

    this.voronoiBatchMesh = new pc.Mesh(app.graphicsDevice);
    this.voronoiBatchMesh.clear(true, true, maxBatchVerts, maxBatchIndices);
    // Prime all 4 vertex streams upfront so MeshInstance binds POSITION+NORMAL+UV0+COLOR cleanly
    this.batchNormals[2] = 1;
    this.batchNormals[5] = 1;
    this.batchNormals[8] = 1;
    this.batchIndices[0] = 0;
    this.batchIndices[1] = 1;
    this.batchIndices[2] = 2;
    this.voronoiBatchMesh.setPositions(this.batchPositions, 3, 3);
    this.voronoiBatchMesh.setNormals(this.batchNormals, 3, 3);
    this.voronoiBatchMesh.setUvs(0, this.batchUvs, 2, 3);
    this.voronoiBatchMesh.setColors(this.batchColors, 4, 3);
    this.voronoiBatchMesh.setIndices(this.batchIndices, 3);
    this.voronoiBatchMesh.update(pc.PRIMITIVE_TRIANGLES, false);

    const batchMeshInstance = new pc.MeshInstance(
      this.voronoiBatchMesh,
      this.voronoiShardMaterial,
    );
    batchMeshInstance.cull = false;
    batchMeshInstance.castShadows = false;

    this.voronoiBatchEntity = new pc.Entity('VoronoiGlassShardsBatch');
    this.voronoiBatchEntity.addComponent('render', {
      meshInstances: [batchMeshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    if (this.voronoiBatchEntity.render) {
      this.voronoiBatchEntity.render.customAabb = new pc.BoundingBox(
        new pc.Vec3(0, 10, -20),
        new pc.Vec3(80, 30, 120),
      );
    }
    this.voronoiBatchEntity.enabled = false;
    app.root.addChild(this.voronoiBatchEntity);
  }

  public get activeInstancedTriangleCount(): number {
    return this.instancedTrianglePool.activeCount;
  }

  public get activeVoronoiShardCount(): number {
    return this.voronoiShardPool.activeCount;
  }

  public get marchingWindows(): ReadonlyArray<MarchingTileGlassWindow> {
    return Array.from(this.marchingWindowMap.values());
  }

  public get voronoiWindows(): ReadonlyArray<VoronoiGlassWindow> {
    return Array.from(this.voronoiWindowMap.values());
  }

  public createMarchingWindow(
    options: GlassWindowCreateOptions,
  ): MarchingTileGlassWindow {
    const win = new MarchingTileGlassWindow(
      this.app,
      this.physics,
      this.marchingMaterial,
      this.instancedTrianglePool,
      this.atlasSizePx,
      options,
    );
    this.marchingWindowMap.set(win.id, win);
    return win;
  }

  public createVoronoiWindow(options: GlassWindowCreateOptions): VoronoiGlassWindow {
    const win = new VoronoiGlassWindow(
      this.app,
      this.physics,
      this.voronoiIntactMaterial,
      this.voronoiShardPool,
      options,
    );
    this.voronoiWindowMap.set(win.id, win);
    return win;
  }

  public getWindow(
    id: string,
  ): MarchingTileGlassWindow | VoronoiGlassWindow | undefined {
    return this.marchingWindowMap.get(id) ?? this.voronoiWindowMap.get(id);
  }

  /**
   * Ballistic Penetration Handler (`IDestructibleSubsystem.handleRaySegment`):
   * - Passes bullets cleanly through already-broken glass cells/panes with `0 J` loss!
   * - When breaking fresh glass, subtracts only `~25–45 J` (`stopped: false`) so rifle/pistol/shotgun
   *   rounds shatter the window and continue straight into GHOUL combatants behind the glass!
   */
  public handleRaySegment(
    seg: BallisticSegmentImpact,
  ): BallisticPenetrationResult | null {
    if (this.destroyed || seg.maxDistanceM <= 0 || seg.kineticEnergyJ <= 0) {
      return null;
    }

    const allHits = this.physics.castPenetrationRay(
      seg.originWorld,
      seg.directionWorld,
      seg.maxDistanceM,
    );

    const glassHits: PenetrationRayHit[] = [];
    for (let i = 0; i < allHits.length; i++) {
      const h = allHits[i];
      const mat = h.surface.material;
      if (
        (mat === 'GLASS_MARCHING_256' && this.marchingWindowMap.has(h.surface.objectId)) ||
        (mat === 'GLASS_VORONOI' && this.voronoiWindowMap.has(h.surface.objectId))
      ) {
        glassHits.push(h);
      }
    }

    if (glassHits.length === 0) {
      return null;
    }

    let remainingEnergyJ = seg.kineticEnergyJ;
    let stopped = false;
    let primaryHit: PenetrationRayHit = glassHits[0];
    let brokeAnyFreshGlass = false;

    for (let i = 0; i < glassHits.length; i++) {
      const hit = glassHits[i];
      const mat = hit.surface.material;

      if (mat === 'GLASS_MARCHING_256') {
        const win = this.marchingWindowMap.get(hit.surface.objectId);
        if (!win) continue;

        const outcome = win.breakAtWorldPoint(
          hit.pointWorld,
          seg.directionWorld,
          remainingEnergyJ,
          Math.max(0.035, seg.caliberRadiusM * 5.5),
        );
        if (!outcome.alreadyBroken) {
          if (!brokeAnyFreshGlass) {
            primaryHit = hit;
            brokeAnyFreshGlass = true;
          }
          remainingEnergyJ = Math.max(0, remainingEnergyJ - outcome.energyAbsorbedJ);
        }
      } else if (mat === 'GLASS_VORONOI') {
        const win = this.voronoiWindowMap.get(hit.surface.objectId);
        if (!win) continue;

        const outcome = win.shatterAtWorldPoint(
          hit.pointWorld,
          seg.directionWorld,
          remainingEnergyJ,
        );
        if (!outcome.alreadyShattered) {
          if (!brokeAnyFreshGlass) {
            primaryHit = hit;
            brokeAnyFreshGlass = true;
          }
          remainingEnergyJ = Math.max(0, remainingEnergyJ - outcome.energyAbsorbedJ);
          this.uploadVoronoiBatchedMesh();
        }
      }

      if (remainingEnergyJ <= 0) {
        remainingEnergyJ = 0;
        stopped = true;
        break;
      }
    }

    const speedRatio =
      seg.kineticEnergyJ > 1e-6
        ? Math.sqrt(Math.max(0, remainingEnergyJ) / seg.kineticEnergyJ)
        : 0;

    return {
      remainingEnergyJ,
      remainingSpeedMs: stopped ? 0 : seg.speedMs * speedRatio,
      stopped,
      impactPointWorld: primaryHit.pointWorld,
      impactNormalWorld: primaryHit.normalWorld,
      hitMaterial: primaryHit.surface.material,
    };
  }

  /**
   * Shatters any glass windows within blast shockwave radius and kicks active floor shards.
   */
  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed || blast.radiusM <= 0 || blast.peakEnergyJ <= 0) {
      return;
    }

    // Kick any shards already flying or resting on the floor
    this.voronoiShardPool.applyBlast(blast);

    // Check Marching-Tile windows
    for (const win of this.marchingWindowMap.values()) {
      if (win.pane.survivingCellCount === 0) continue;

      const closest = this.closestPointOnWindowWorld(
        blast.centerWorld,
        win.centerWorld,
        win.rotationQuat,
        win.widthM,
        win.heightM,
      );
      const dx = closest.x - blast.centerWorld.x;
      const dy = closest.y - blast.centerWorld.y;
      const dz = closest.z - blast.centerWorld.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > blast.radiusM) continue;

      const falloff = Math.max(0.15, 1 - dist / blast.radiusM);
      const shockEnergyJ = blast.peakEnergyJ * falloff;
      const blastHoleRadiusM = Math.max(
        0.22,
        Math.hypot(win.widthM, win.heightM) * (0.35 + 0.65 * falloff),
      );
      const dir =
        dist > 1e-4
          ? { x: dx / dist, y: dy / dist, z: dz / dist }
          : rotateVec3ByQuat({ x: 0, y: 0, z: 1 }, win.rotationQuat);

      win.breakAtWorldPoint(
        closest,
        dir,
        shockEnergyJ,
        blastHoleRadiusM,
        INSTANCED_SHARDS_PER_MARCHING_HIT * 2,
      );
    }

    // Check Voronoi windows
    let shatteredAnyVoronoi = false;
    for (const win of this.voronoiWindowMap.values()) {
      if (win.shattered) continue;

      const closest = this.closestPointOnWindowWorld(
        blast.centerWorld,
        win.centerWorld,
        win.rotationQuat,
        win.widthM,
        win.heightM,
      );
      const dx = closest.x - blast.centerWorld.x;
      const dy = closest.y - blast.centerWorld.y;
      const dz = closest.z - blast.centerWorld.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > blast.radiusM) continue;

      const falloff = Math.max(0.2, 1 - dist / blast.radiusM);
      const shockEnergyJ = blast.peakEnergyJ * falloff;
      const dir =
        dist > 1e-4
          ? { x: dx / dist, y: dy / dist, z: dz / dist }
          : rotateVec3ByQuat({ x: 0, y: 0, z: 1 }, win.rotationQuat);

      const res = win.shatterAtWorldPoint(closest, dir, shockEnergyJ);
      if (!res.alreadyShattered) {
        shatteredAnyVoronoi = true;
      }
    }

    if (shatteredAnyVoronoi || this.voronoiShardPool.dirty) {
      this.uploadVoronoiBatchedMesh();
    }
  }

  public update(dt: number): void {
    if (this.destroyed) {
      return;
    }

    // 1. Step pooled hardware-instanced glass triangles (1.5s fall, glint, floor bounce & shrink)
    this.instancedTrianglePool.syncFromPhysics(this.physics, dt);

    // 2. Step custom JS Voronoi shard Verlet/ballistic pool and upload single batched dynamic mesh
    this.voronoiShardPool.step(dt);
    if (this.voronoiShardPool.dirty) {
      this.uploadVoronoiBatchedMesh();
      this.voronoiShardPool.clearDirty();
    }
  }

  public reset(): void {
    if (this.destroyed) {
      return;
    }
    this.instancedTrianglePool.clear();
    this.voronoiShardPool.clear();
    this.voronoiBatchEntity.enabled = false;
    this.voronoiShardPool.clearDirty();

    for (const win of this.marchingWindowMap.values()) {
      win.reset();
    }
    for (const win of this.voronoiWindowMap.values()) {
      win.reset();
    }
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    for (const win of this.marchingWindowMap.values()) {
      win.destroy();
    }
    this.marchingWindowMap.clear();

    for (const win of this.voronoiWindowMap.values()) {
      win.destroy();
    }
    this.voronoiWindowMap.clear();

    this.instancedTrianglePool.destroy();
    this.instancedTriangleMesh.destroy();

    this.voronoiBatchEntity.destroy();
    this.voronoiBatchMesh.destroy();

    this.marchingMaterial.destroy();
    this.voronoiIntactMaterial.destroy();
    this.voronoiShardMaterial.destroy();
    this.instancedTriangleMaterial.destroy();
    this.atlasTexture.destroy();
  }

  private uploadVoronoiBatchedMesh(): void {
    if (this.voronoiShardPool.activeCount === 0) {
      this.voronoiBatchEntity.enabled = false;
      return;
    }

    const stats = this.voronoiShardPool.writeBatchedMeshBuffers(
      this.batchPositions,
      this.batchNormals,
      this.batchUvs,
      this.batchIndices,
      this.batchColors,
    );

    if (stats.vertexCount === 0 || stats.indexCount === 0) {
      this.voronoiBatchEntity.enabled = false;
      return;
    }

    this.voronoiBatchEntity.enabled = true;
    this.voronoiBatchMesh.setPositions(this.batchPositions, 3, stats.vertexCount);
    this.voronoiBatchMesh.setNormals(this.batchNormals, 3, stats.vertexCount);
    this.voronoiBatchMesh.setUvs(0, this.batchUvs, 2, stats.vertexCount);
    this.voronoiBatchMesh.setColors(this.batchColors, 4, stats.vertexCount);
    this.voronoiBatchMesh.setIndices(this.batchIndices, stats.indexCount);
    this.voronoiBatchMesh.update(pc.PRIMITIVE_TRIANGLES, false);
  }

  private closestPointOnWindowWorld(
    queryWorld: Vec3Like,
    centerWorld: Vec3Like,
    rotationQuat: QuatLike,
    widthM: number,
    heightM: number,
  ): Vec3Like {
    const rel: Vec3Like = {
      x: queryWorld.x - centerWorld.x,
      y: queryWorld.y - centerWorld.y,
      z: queryWorld.z - centerWorld.z,
    };
    const local = inverseRotateVec3ByQuat(rel, rotationQuat);
    const clampedLocal: Vec3Like = {
      x: Math.max(-widthM * 0.5, Math.min(widthM * 0.5, local.x)),
      y: Math.max(-heightM * 0.5, Math.min(heightM * 0.5, local.y)),
      z: 0,
    };
    const worldOffset = rotateVec3ByQuat(clampedLocal, rotationQuat);
    return {
      x: centerWorld.x + worldOffset.x,
      y: centerWorld.y + worldOffset.y,
      z: centerWorld.z + worldOffset.z,
    };
  }
}
