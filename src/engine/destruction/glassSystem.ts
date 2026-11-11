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
  ArmoredVoronoiGlassPane,
  DEFAULT_VORONOI_SHARD_THICKNESS_M,
  GLASS_SHARD_STYLE_ARMORED,
  GLASS_SHARD_STYLE_CLEAR,
  GlassShardPool,
  ProgressiveVoronoiPane,
  extrudeConvexShard2D,
  shatterWindowVoronoi2D,
} from '../../core/destruction/glassVoronoiShatter.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

const INSTANCED_SHARDS_PER_MARCHING_HIT = 10;
const INSTANCED_SHARD_TTL_S = 1.5;
const MIN_GLASS_ENERGY_LOSS_J = 25;
const MAX_GLASS_ENERGY_LOSS_J = 45;
const DEFAULT_REGULAR_VORONOI_PLATE_COUNT = 22;
const DEFAULT_ARMORED_VORONOI_CELL_COUNT = 68;

export interface GlassWindowCreateOptions {
  id?: string;
  centerWorld: Vec3Like;
  widthM: number;
  heightM: number;
  thicknessM?: number;
  rotationQuat?: QuatLike;
  /** Energy lost when breaking fresh glass (clamped to `25..45 J` for realistic pass-through). */
  penetrationResistanceJ?: number;
  /** Grid columns for `MarchingGlassPane` state sync (default `16`). */
  gridW?: number;
  /** Grid rows for `MarchingGlassPane` state sync (default `16`). */
  gridH?: number;
  /** Organic Voronoi chunk count for `MarchingTileGlassWindow` ballistic laminate (default `68`). */
  armoredChunkCount?: number;
  /** Large angular Voronoi shard count for `VoronoiGlassWindow` (default `22`). */
  voronoiShardCount?: number;
}

export interface GlassSystemOptions {
  id?: string;
  atlasSizePx?: number;
  windowTextureSizePx?: number;
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
  const tx = 2 * (-q.y * v.z + q.z * v.y);
  const ty = 2 * (-q.z * v.x + q.x * v.z);
  const tz = 2 * (-q.x * v.y + q.y * v.x);
  return {
    x: v.x + q.w * tx + (-q.y * tz + q.z * ty),
    y: v.y + q.w * ty + (-q.z * tx + q.x * tz),
    z: v.z + q.w * tz + (-q.x * ty - q.y * tx),
  };
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function hashStringSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
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
 * Generates a natural `RGBA8` window-space `[0, 1] x [0, 1]` architectural & ballistic glass
 * texture (`default 256x256`) mapped ONCE across an entire window pane (never repeating per cell!):
 * - Smooth vertical sky-to-horizon reflection gradient
 * - Broad soft architectural diagonal sky-glint bands across the whole pane
 * - High-iron / polycarbonate emerald-cyan edge refraction glow + subtle perimeter rubber gasket seal
 */
export function generateWindowGlassPaneRgba8(textureSize = 256): Uint8Array {
  const size = Math.max(32, Math.floor(textureSize));
  const rgba = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size; // 0 (bottom sill) -> 1 (top header)
    const edgeDistY = Math.min(v, 1 - v);

    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size; // 0 (left jamb) -> 1 (right jamb)
      const edgeDistX = Math.min(u, 1 - u);
      const borderDist = Math.min(edgeDistX, edgeDistY);

      // 1. Vertical sky-to-ground environmental reflection base
      const skyGrad = smoothstep(0.08, 0.96, v);
      let r = 128 + skyGrad * 34;
      let g = 186 + skyGrad * 36;
      let b = 204 + skyGrad * 34;

      // 2. Soft architectural diagonal reflection bands across the entire pane (never tiled!)
      const diagCoord = u * 0.64 + v * 0.77;
      const primaryBand =
        (1 - smoothstep(0.0, 0.24, Math.abs(diagCoord - 0.60))) * 0.85;
      const secondaryBand =
        (1 - smoothstep(0.0, 0.11, Math.abs(diagCoord - 0.96))) * 0.45;
      const reflection = primaryBand + secondaryBand;

      r += reflection * 42;
      g += reflection * 40;
      b += reflection * 34;

      // 3. Subtle optical emerald-cyan internal refraction glow near the sash perimeter (2%..8%)
      const edgeGlow =
        smoothstep(0.014, 0.032, borderDist) *
        (1 - smoothstep(0.032, 0.095, borderDist));
      r -= edgeGlow * 10;
      g += edgeGlow * 18;
      b += edgeGlow * 14;

      // 4. Perimeter rubber glazing gasket shading (< 1.8% from frame edge)
      const gasketMask = 1 - smoothstep(0.004, 0.020, borderDist);
      r = r * (1 - gasketMask * 0.58) + 26 * gasketMask * 0.58;
      g = g * (1 - gasketMask * 0.58) + 36 * gasketMask * 0.58;
      b = b * (1 - gasketMask * 0.58) + 42 * gasketMask * 0.58;

      // 5. Ultra-subtle organic optical variation (±1.5/255) to avoid sterile flat banding
      const micro =
        (Math.sin(u * 19.7 + v * 13.1) * 0.5 + Math.cos(u * 11.3 - v * 23.9) * 0.5) *
        1.5;

      // High base alpha so `opacityVertexColor` cleanly controls translucent face vs crisp fracture rim!
      const alpha = 224 + reflection * 18 + gasketMask * 24;

      const outIdx = (py * size + px) * 4;
      rgba[outIdx] = Math.max(0, Math.min(255, Math.round(r + micro)));
      rgba[outIdx + 1] = Math.max(0, Math.min(255, Math.round(g + micro)));
      rgba[outIdx + 2] = Math.max(0, Math.min(255, Math.round(b + micro)));
      rgba[outIdx + 3] = Math.max(0, Math.min(255, Math.round(alpha)));
    }
  }

  return rgba;
}

/**
 * Creates the window-space `[0, 1]` procedural architectural/ballistic glass `pc.Texture`.
 */
export function createWindowGlassPaneTexture(
  device: pc.GraphicsDevice,
  textureSize = 256,
): pc.Texture {
  const size = Math.max(32, Math.floor(textureSize));
  const rgba = generateWindowGlassPaneRgba8(size);

  return new pc.Texture(device, {
    name: 'WindowGlassPaneTexture',
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
 * Generates the raw `RGBA8` (`size x size x 4`, default `512x512`, `32x32` px per bitmask
 * `0..255`) procedural crack & jagged crystalline edge atlas buffer:
 * - Missing neighbor directions (`(mask & bit) === 0`) carve translucent jagged crystalline
 *   glass teeth (`alpha = 0` void) + bright icy specular fracture rims + internal crack lines.
 * - Tile `255` (`0b11111111`) renders smooth uniform architectural glass without harsh per-tile
 *   diagonal checkerboard banding.
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
      const v = (ly + 0.5) / tilePx;
      const py = basePxY + ly;

      for (let lx = 0; lx < tilePx; lx++) {
        const u = (lx + 0.5) / tilePx;
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

        if (missNE) {
          const diagDist = 1 - u + (1 - v);
          const notch = 0.22 + 0.17 * jaggedCrystallineTeethProfile(u - v + 1, 0.19);
          minMargin = Math.min(minMargin, (diagDist - notch) * 0.72);
        }
        if (missSE) {
          const diagDist = 1 - u + v;
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

        if (minMargin < 0) {
          rgba[outIdx] = 0;
          rgba[outIdx + 1] = 0;
          rgba[outIdx + 2] = 0;
          rgba[outIdx + 3] = 0;
          continue;
        }

        // Smooth uniform glass base (avoids repeating per-cell diagonal stripes on tile 255!)
        let r = 158;
        let g = 214;
        let b = 230;
        let a = 74;

        if (mask !== 255) {
          const dx = u - crackOriginX;
          const dy = v - crackOriginY;
          const radialDist = Math.hypot(dx, dy);
          const angle01 = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);

          const radialSpokeWave = triangleWave(
            angle01 * (5 + (mask % 3)) + radialDist * 0.55 + maskPhase,
          );
          const radialCrack =
            radialSpokeWave < 0.064
              ? (1 - radialSpokeWave / 0.064) * Math.max(0.25, 1 - radialDist * 0.65)
              : 0;

          const rimWidth = 2.8 / tilePx;
          if (radialCrack > 0) {
            r = r + (232 - r) * radialCrack;
            g = g + (250 - g) * radialCrack;
            b = b + (255 - b) * radialCrack;
            a = Math.max(a, 96 + radialCrack * 120);
          }

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
 * Builds a sharp double-sided 3D crystalline triangular glass spall prism mesh (`1` unit scale)
 * used by the shared `HardwareInstancedPool` when ballistic spall chips eject from impacts.
 */
function createCrystallineTriangleShardMesh(device: pc.GraphicsDevice): pc.Mesh {
  const hz = 0.08;
  const p0x = -0.5;
  const p0y = -0.36;
  const p1x = 0.56;
  const p1y = -0.22;
  const p2x = -0.06;
  const p2y = 0.58;

  const positions = new Float32Array([
    p0x, p0y, hz,
    p1x, p1y, hz,
    p2x, p2y, hz,
    p0x, p0y, -hz,
    p2x, p2y, -hz,
    p1x, p1y, -hz,
    p0x, p0y, hz,
    p1x, p1y, -hz,
    p1x, p1y, hz,
    p0x, p0y, hz,
    p0x, p0y, -hz,
    p1x, p1y, -hz,
    p1x, p1y, hz,
    p2x, p2y, -hz,
    p2x, p2y, hz,
    p1x, p1y, hz,
    p1x, p1y, -hz,
    p2x, p2y, -hz,
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
 * Builds a clean window-space `[0, 1]` UV extruded rectangular glass prism mesh (`widthM x heightM x thicknessM`)
 * with translucent faces and subtle perimeter bevels for intact `VoronoiGlassWindow` panes.
 */
function createIntactWindowPanePrismMesh(
  device: pc.GraphicsDevice,
  widthM: number,
  heightM: number,
  thicknessM: number,
): pc.Mesh {
  const rectPoly = [
    { x: 0, y: 0 },
    { x: widthM, y: 0 },
    { x: widthM, y: heightM },
    { x: 0, y: heightM },
  ];
  const ext = extrudeConvexShard2D(
    rectPoly,
    { x: widthM * 0.5, y: heightM * 0.5 },
    widthM,
    heightM,
    thicknessM,
  );

  const colors = new Float32Array(ext.vertexCount * 4);
  for (let v = 0; v < ext.vertexCount; v++) {
    const lnz = ext.localNormals[v * 3 + 2];
    const isRim = Math.abs(lnz) < 0.5;
    const c4 = v * 4;
    colors[c4] = isRim ? 0.52 : 0.76;
    colors[c4 + 1] = isRim ? 0.74 : 0.93;
    colors[c4 + 2] = isRim ? 0.80 : 0.99;
    colors[c4 + 3] = isRim ? 0.72 : 0.42;
  }

  const mesh = new pc.Mesh(device);
  mesh.setPositions(ext.localPositions, 3, ext.vertexCount);
  mesh.setNormals(ext.localNormals, 3, ext.vertexCount);
  mesh.setUvs(0, ext.localUvs, 2, ext.vertexCount);
  mesh.setColors(colors, 4, ext.vertexCount);
  mesh.setIndices(ext.localIndices, ext.indexCount);
  mesh.update(pc.PRIMITIVE_TRIANGLES, true);
  return mesh;
}

/**
 * Ballistic Laminated Armored Glass Window (`GLASS_MARCHING_256`):
 * - Visual & physical fracture geometry is built from **organic 2D Voronoi polygonal chunks**
 *   (`ArmoredVoronoiGlassPane`) mapped in seamless **window-space `[0, 1]` UVs** (zero 16x16 square grid!).
 * - Multi-shot polycarbonate-interlayer durability:
 *   - Pistol/SMG/buckshot hits (`< 1350 J`) craze & spiderweb-crack the Voronoi chunks on Shot 1
 *     (emitting fine spall chips) while holding the chunks stubbornly in the frame until repeated
 *     shots shear them out!
 *   - High-velocity rifle hits (`>= 1350 J`) punch a tight 1-cell bullet core perforation at the
 *     bullseye while crazing a wide surrounding armored Voronoi halo that takes multiple follow-up
 *     shots before thick 3D Voronoi chunks detach and tumble onto the floor via `GlassShardPool`!
 * - Keeps `pane` (`MarchingGlassPane`) synchronized on every hit for full API compatibility.
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
  public readonly armoredPane: ArmoredVoronoiGlassPane;
  public readonly entity: pc.Entity;
  public readonly mesh: pc.Mesh;
  public readonly meshInstance: pc.MeshInstance;

  private colliderHandleValue = -1;
  private hitSeedCounter = 0;

  private readonly meshPositions: Float32Array;
  private readonly meshNormals: Float32Array;
  private readonly meshUvs: Float32Array;
  private readonly meshColors: Float32Array;
  private readonly meshIndices: Uint16Array;

  public constructor(
    app: pc.Application,
    private readonly physics: RapierPhysicsWorld,
    material: pc.Material,
    private readonly instancedPool: HardwareInstancedPool,
    _atlasSizePx: number,
    options: GlassWindowCreateOptions,
    private readonly voronoiShardPool?: GlassShardPool,
  ) {
    this.id = options.id ?? `glass_marching_${Math.random().toString(36).slice(2, 8)}`;
    this.centerWorld = {
      x: options.centerWorld.x,
      y: options.centerWorld.y,
      z: options.centerWorld.z,
    };
    this.widthM = Math.max(0.1, options.widthM);
    this.heightM = Math.max(0.1, options.heightM);
    this.thicknessM = Math.max(0.018, options.thicknessM ?? 0.024);
    this.rotationQuat = normalizeQuat(options.rotationQuat);
    this.penetrationResistanceJ = Math.max(
      MIN_GLASS_ENERGY_LOSS_J,
      Math.min(MAX_GLASS_ENERGY_LOSS_J, options.penetrationResistanceJ ?? 38),
    );

    this.pane = new MarchingGlassPane({
      widthM: this.widthM,
      heightM: this.heightM,
      gridW: options.gridW ?? 16,
      gridH: options.gridH ?? 16,
      frameBorderIntact: true,
    });

    const layoutSeed =
      hashStringSeed(this.id) ^
      Math.round(this.widthM * 1009) ^
      Math.round(this.heightM * 2003);

    this.armoredPane = new ArmoredVoronoiGlassPane({
      widthM: this.widthM,
      heightM: this.heightM,
      cellCount: options.armoredChunkCount ?? DEFAULT_ARMORED_VORONOI_CELL_COUNT,
      thicknessM: this.thicknessM,
      seed: layoutSeed,
    });

    const maxVerts = Math.min(64000, this.armoredPane.totalChunks * 220);
    const maxIndices = this.armoredPane.totalChunks * 360;
    this.meshPositions = new Float32Array(maxVerts * 3);
    this.meshNormals = new Float32Array(maxVerts * 3);
    this.meshUvs = new Float32Array(maxVerts * 2);
    this.meshColors = new Float32Array(maxVerts * 4);
    this.meshIndices = new Uint16Array(maxIndices);

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

  public get survivingChunkCount(): number {
    return this.armoredPane.survivingChunkCount;
  }

  public get detachedChunkCount(): number {
    return this.armoredPane.detachedChunkCount;
  }

  public get crazedChunkCount(): number {
    return this.armoredPane.crazedChunkCount;
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
    const rel: Vec3Like = {
      x: pointWorld.x - this.centerWorld.x,
      y: pointWorld.y - this.centerWorld.y,
      z: pointWorld.z - this.centerWorld.z,
    };
    const local = inverseRotateVec3ByQuat(rel, this.rotationQuat);
    const x2d = local.x + this.widthM * 0.5;
    const y2d = local.y + this.heightM * 0.5;
    if (x2d < 0 || x2d > this.widthM || y2d < 0 || y2d > this.heightM) {
      return true;
    }
    return this.armoredPane.isDetachedAt(x2d, y2d);
  }

  /**
   * Applies ballistic or blast stress at `pointWorld` onto the armored Voronoi laminate:
   * - Crazes/fractures Voronoi chunks on initial moderate hits (`0` chunks detached!) and detaches
   *   thick 3D Voronoi chunks into `GlassShardPool` once polycarbonate interlayer health is exhausted!
   * - Emits crystalline rear-face spall triangles via `HardwareInstancedPool`.
   */
  public breakAtWorldPoint(
    pointWorld: Vec3Like,
    directionWorld: Vec3Like,
    kineticEnergyJ: number,
    impactRadiusM?: number,
    instancedCount = INSTANCED_SHARDS_PER_MARCHING_HIT,
    isArmorPiercing = false,
  ): {
    alreadyBroken: boolean;
    energyAbsorbedJ: number;
    spawnedTriangles: number;
    spawnedVoronoiChunks: number;
  } {
    const { u, v } = this.worldPointToUv(pointWorld);
    const hitX = u * this.widthM;
    const hitY = v * this.heightM;
    const hitChunkIdx = this.armoredPane.findChunkAt(hitX, hitY);
    const wasAlreadyCrazed =
      hitChunkIdx >= 0 && this.armoredPane.stage[hitChunkIdx] > 0;

    const seed = ++this.hitSeedCounter * 2654435761;
    const report = this.armoredPane.applyImpact({
      hitX,
      hitY,
      energyJ: kineticEnergyJ,
      radiusM: impactRadiusM,
      isArmorPiercing,
      seed,
    });

    if (report.alreadyBrokenHole) {
      return {
        alreadyBroken: true,
        energyAbsorbedJ: 0,
        spawnedTriangles: 0,
        spawnedVoronoiChunks: 0,
      };
    }

    this.pane.syncFromUvSampler((su, sv) =>
      this.armoredPane.sampleCellStateAtUv(su, sv),
    );
    this.rebuildDynamicMesh();

    if (this.armoredPane.survivingChunkCount === 0 && this.colliderHandleValue >= 0) {
      this.physics.removeCollider(this.colliderHandleValue);
      this.colliderHandleValue = -1;
    }

    // Spawn fine crystalline spall chips on impact
    const spallCount =
      report.newlyDetachedIndices.length > 0
        ? instancedCount
        : Math.max(6, Math.round(instancedCount * 0.7));
    const spawnedTriangles = this.emitInstancedTriangles(
      pointWorld,
      directionWorld,
      kineticEnergyJ,
      spallCount,
    );

    // Spawn real thick 3D extruded Voronoi chunks into `GlassShardPool` whenever chunks shear out!
    let spawnedVoronoiChunks = 0;
    if (this.voronoiShardPool && report.newlyDetachedIndices.length > 0) {
      spawnedVoronoiChunks = this.voronoiShardPool.spawnShardsSubset(
        this.armoredPane.voronoi,
        report.newlyDetachedIndices,
        {
          windowCenterWorld: this.centerWorld,
          windowRotationQuat: this.rotationQuat,
          impactDirectionWorld: directionWorld,
          impactEnergyJ: kineticEnergyJ,
          ttlSeconds: 4.0,
          seed: seed ^ 0x27d4eb2d,
          impactOrigin2D: { x: hitX, y: hitY },
          shardStyle: GLASS_SHARD_STYLE_ARMORED,
        },
      );
    }

    const energyAbsorbedJ = wasAlreadyCrazed
      ? Math.max(MIN_GLASS_ENERGY_LOSS_J, this.penetrationResistanceJ * 0.78)
      : Math.min(MAX_GLASS_ENERGY_LOSS_J, this.penetrationResistanceJ * 1.08);

    return {
      alreadyBroken: false,
      energyAbsorbedJ,
      spawnedTriangles,
      spawnedVoronoiChunks,
    };
  }

  public reset(): void {
    this.armoredPane.reset();
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
        z: Math.max(0.01, this.thicknessM * 0.5),
      },
      this.rotationQuat,
      tag,
    );
  }

  private rebuildDynamicMesh(): void {
    const build = this.armoredPane.writeArmoredMeshBuffers(
      this.meshPositions,
      this.meshNormals,
      this.meshUvs,
      this.meshColors,
      this.meshIndices,
    );

    if (build.vertexCount === 0 || build.indexCount === 0) {
      this.entity.enabled = false;
      return;
    }

    this.entity.enabled = true;
    this.mesh.setPositions(this.meshPositions, 3, build.vertexCount);
    this.mesh.setNormals(this.meshNormals, 3, build.vertexCount);
    this.mesh.setUvs(0, this.meshUvs, 2, build.vertexCount);
    this.mesh.setColors(this.meshColors, 4, build.vertexCount);
    this.mesh.setIndices(this.meshIndices, build.indexCount);
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
      6.2,
      1.6 + Math.sqrt(Math.max(20, kineticEnergyJ)) * 0.052,
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
      const jitterOffset = 0.018 + rand() * 0.042;

      const pos: Vec3Like = {
        x: originWorld.x + radialWorld.x * jitterOffset + dx * 0.02,
        y: Math.max(0.03, originWorld.y + radialWorld.y * jitterOffset + dy * 0.02),
        z: originWorld.z + radialWorld.z * jitterOffset + dz * 0.02,
      };

      const fwdSpeed = speedBase * (0.55 + rand() * 0.75);
      const outSpeed = 0.75 + rand() * 1.75;
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

      const shardSize = 0.032 + rand() * 0.040;
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
 * Regular Tempered/Plate Glass Window (`GLASS_VORONOI`):
 * - Renders a sleek architectural window-space `[0, 1]` UV pane when intact.
 * - On impact, fractures into **large, dramatic angular plate wedges** (`~20–24` big bold chunks):
 *   a wide central/impact breach cascades into `GlassShardPool` while leaving sharp **perimeter/corner
 *   glass fangs** clinging to the sash frame!
 * - Follow-up shots through the open breach pass cleanly (`0 J` loss), while shots hitting surviving
 *   perimeter fangs knock those remaining large chunks loose onto the floor!
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
  public readonly fangEntity: pc.Entity;
  public readonly fangMesh: pc.Mesh;
  public readonly fangMeshInstance: pc.MeshInstance;

  private colliderHandleValue = -1;
  private isShattered = false;
  private shatterCounter = 0;
  private progressivePane: ProgressiveVoronoiPane | null = null;

  private readonly fangPositions: Float32Array;
  private readonly fangNormals: Float32Array;
  private readonly fangUvs: Float32Array;
  private readonly fangColors: Float32Array;
  private readonly fangIndices: Uint16Array;

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
      0.008,
      options.thicknessM ?? DEFAULT_VORONOI_SHARD_THICKNESS_M,
    );
    this.rotationQuat = normalizeQuat(options.rotationQuat);
    this.penetrationResistanceJ = Math.max(
      MIN_GLASS_ENERGY_LOSS_J,
      Math.min(MAX_GLASS_ENERGY_LOSS_J, options.penetrationResistanceJ ?? 34),
    );

    // Upgrade legacy default arena 42-count to bold 22-plate mode while honoring explicit custom counts
    const rawRequestedCount =
      options.voronoiShardCount === undefined ||
      (this.id === 'glass_voronoi_window' && options.voronoiShardCount === 42)
        ? DEFAULT_REGULAR_VORONOI_PLATE_COUNT
        : options.voronoiShardCount;
    this.voronoiShardCount = Math.max(12, Math.min(64, Math.round(rawRequestedCount)));

    this.intactMesh = createIntactWindowPanePrismMesh(
      app.graphicsDevice,
      this.widthM,
      this.heightM,
      this.thicknessM,
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

    // Pre-allocate dynamic perimeter fang mesh & entity upfront (zero runtime pc.Entity creation on shatter!)
    const maxFangVerts = this.voronoiShardCount * 96;
    const maxFangIndices = this.voronoiShardCount * 180;
    this.fangPositions = new Float32Array(maxFangVerts * 3);
    this.fangNormals = new Float32Array(maxFangVerts * 3);
    this.fangUvs = new Float32Array(maxFangVerts * 2);
    this.fangColors = new Float32Array(maxFangVerts * 4);
    this.fangIndices = new Uint16Array(maxFangIndices);

    this.fangMesh = new pc.Mesh(app.graphicsDevice);
    this.fangMesh.clear(true, true, maxFangVerts, maxFangIndices);
    this.fangNormals[2] = 1;
    this.fangNormals[5] = 1;
    this.fangNormals[8] = 1;
    this.fangIndices[0] = 0;
    this.fangIndices[1] = 1;
    this.fangIndices[2] = 2;
    this.fangMesh.setPositions(this.fangPositions, 3, 3);
    this.fangMesh.setNormals(this.fangNormals, 3, 3);
    this.fangMesh.setUvs(0, this.fangUvs, 2, 3);
    this.fangMesh.setColors(this.fangColors, 4, 3);
    this.fangMesh.setIndices(this.fangIndices, 3);
    this.fangMesh.update(pc.PRIMITIVE_TRIANGLES, false);

    this.fangMeshInstance = new pc.MeshInstance(this.fangMesh, intactMaterial);
    this.fangMeshInstance.castShadows = false;

    this.fangEntity = new pc.Entity(`${this.id}_fangs`);
    this.fangEntity.setPosition(
      this.centerWorld.x,
      this.centerWorld.y,
      this.centerWorld.z,
    );
    this.fangEntity.setRotation(
      this.rotationQuat.x,
      this.rotationQuat.y,
      this.rotationQuat.z,
      this.rotationQuat.w,
    );
    this.fangEntity.addComponent('render', {
      meshInstances: [this.fangMeshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    this.fangEntity.enabled = false;
    app.root.addChild(this.fangEntity);

    this.createCollider();
  }

  public get colliderHandle(): number {
    return this.colliderHandleValue;
  }

  public get shattered(): boolean {
    return this.isShattered;
  }

  public get survivingFangCount(): number {
    if (!this.isShattered) {
      return this.voronoiShardCount;
    }
    return this.progressivePane ? this.progressivePane.survivingFangCount : 0;
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

  public isOpenAtWorldPoint(pointWorld: Vec3Like): boolean {
    if (!this.isShattered) return false;
    if (!this.progressivePane || this.progressivePane.survivingFangCount === 0) {
      return true;
    }
    const { hitX, hitY } = this.worldPointToWindowCoords(pointWorld);
    const shards = this.progressivePane.shatter.shards;
    for (let i = 0; i < shards.length; i++) {
      if (this.progressivePane.attached[i] === 0) continue;
      const poly = shards[i].polygon;
      let inside = true;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % poly.length];
        if ((b.x - a.x) * (hitY - a.y) - (b.y - a.y) * (hitX - a.x) < -1e-5) {
          inside = false;
          break;
        }
      }
      if (inside) return false;
    }
    return true;
  }

  /**
   * Shatters the pane into large dramatic angular plate chunks around `pointWorld`:
   * - On first hit: launches a wide central/impact breach into `GlassShardPool` while leaving
   *   jagged perimeter/corner glass fangs clinging to the frame!
   * - On follow-up hits: passes cleanly through open breaches (`alreadyShattered: true`, `0 J` loss),
   *   or knocks hit perimeter fangs loose into `GlassShardPool`!
   */
  public shatterAtWorldPoint(
    pointWorld: Vec3Like,
    directionWorld: Vec3Like,
    kineticEnergyJ: number,
    impactRadiusM = 0.035,
  ): { alreadyShattered: boolean; energyAbsorbedJ: number; spawnedShards: number } {
    const { hitX, hitY } = this.worldPointToWindowCoords(pointWorld);

    if (!this.isShattered) {
      this.isShattered = true;
      this.intactEntity.enabled = false;

      const seed =
        ++this.shatterCounter * 15485863 + Math.round(hitX * 997 + hitY * 991);

      const voronoiResult = shatterWindowVoronoi2D({
        widthM: this.widthM,
        heightM: this.heightM,
        hitX,
        hitY,
        shardCount: this.voronoiShardCount,
        thicknessM: this.thicknessM,
        seed,
      });

      this.progressivePane = new ProgressiveVoronoiPane(voronoiResult);
      const detachedIndices = this.progressivePane.triggerInitialBreach(kineticEnergyJ);

      const spawnedShards = this.shardPool.spawnShardsSubset(
        voronoiResult,
        detachedIndices,
        {
          windowCenterWorld: this.centerWorld,
          windowRotationQuat: this.rotationQuat,
          impactDirectionWorld: directionWorld,
          impactEnergyJ: kineticEnergyJ,
          ttlSeconds: 3.9,
          seed: seed ^ 0x5bd1e995,
          impactOrigin2D: { x: hitX, y: hitY },
          shardStyle: GLASS_SHARD_STYLE_CLEAR,
        },
      );

      this.rebuildFangMeshAndCollider();

      return {
        alreadyShattered: false,
        energyAbsorbedJ: this.penetrationResistanceJ,
        spawnedShards,
      };
    }

    // Already shattered: check if follow-up shot or blast strikes surviving perimeter fangs
    if (!this.progressivePane || this.progressivePane.survivingFangCount === 0) {
      return {
        alreadyShattered: true,
        energyAbsorbedJ: 0,
        spawnedShards: 0,
      };
    }

    const fangHit = this.progressivePane.strikeClingingFangs(
      hitX,
      hitY,
      kineticEnergyJ,
      impactRadiusM,
    );
    if (fangHit.hitOpenBreach || fangHit.newlyDetachedIndices.length === 0) {
      return {
        alreadyShattered: true,
        energyAbsorbedJ: 0,
        spawnedShards: 0,
      };
    }

    const seed =
      ++this.shatterCounter * 15485863 + Math.round(hitX * 997 + hitY * 991);
    const spawnedShards = this.shardPool.spawnShardsSubset(
      this.progressivePane.shatter,
      fangHit.newlyDetachedIndices,
      {
        windowCenterWorld: this.centerWorld,
        windowRotationQuat: this.rotationQuat,
        impactDirectionWorld: directionWorld,
        impactEnergyJ: kineticEnergyJ,
        ttlSeconds: 3.8,
        seed: seed ^ 0x1b873593,
        impactOrigin2D: { x: hitX, y: hitY },
        shardStyle: GLASS_SHARD_STYLE_CLEAR,
      },
    );

    this.rebuildFangMeshAndCollider();

    return {
      alreadyShattered: false,
      energyAbsorbedJ: Math.max(
        MIN_GLASS_ENERGY_LOSS_J,
        this.penetrationResistanceJ * 0.78,
      ),
      spawnedShards,
    };
  }

  public reset(): void {
    this.isShattered = false;
    this.progressivePane = null;
    this.intactEntity.enabled = true;
    this.fangEntity.enabled = false;
    if (this.colliderHandleValue < 0) {
      this.createCollider();
    }
  }

  public destroy(): void {
    if (this.colliderHandleValue >= 0) {
      this.physics.removeCollider(this.colliderHandleValue);
      this.colliderHandleValue = -1;
    }
    this.fangEntity.destroy();
    this.fangMesh.destroy();
    this.intactEntity.destroy();
    this.intactMesh.destroy();
  }

  private rebuildFangMeshAndCollider(): void {
    if (!this.progressivePane || this.progressivePane.survivingFangCount === 0) {
      this.fangEntity.enabled = false;
      if (this.colliderHandleValue >= 0) {
        this.physics.removeCollider(this.colliderHandleValue);
        this.colliderHandleValue = -1;
      }
      return;
    }

    const stats = this.progressivePane.writeClingingFangsMeshBuffers(
      this.fangPositions,
      this.fangNormals,
      this.fangUvs,
      this.fangColors,
      this.fangIndices,
    );

    if (stats.vertexCount === 0 || stats.indexCount === 0) {
      this.fangEntity.enabled = false;
      if (this.colliderHandleValue >= 0) {
        this.physics.removeCollider(this.colliderHandleValue);
        this.colliderHandleValue = -1;
      }
      return;
    }

    this.fangEntity.enabled = true;
    this.fangMesh.setPositions(this.fangPositions, 3, stats.vertexCount);
    this.fangMesh.setNormals(this.fangNormals, 3, stats.vertexCount);
    this.fangMesh.setUvs(0, this.fangUvs, 2, stats.vertexCount);
    this.fangMesh.setColors(this.fangColors, 4, stats.vertexCount);
    this.fangMesh.setIndices(this.fangIndices, stats.indexCount);
    this.fangMesh.update(pc.PRIMITIVE_TRIANGLES, true);
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
 * Unified Dual Glass Destruction Subsystem (`IDestructibleSubsystem`) managing:
 * 1. `MarchingTileGlassWindow` (`GLASS_MARCHING_256` — Ballistic Laminated Voronoi Armored Glass)
 * 2. `VoronoiGlassWindow` (`GLASS_VORONOI` — Large-Chunk Progressive Plate Glass with Clinging Fangs)
 * Both share window-space `[0, 1]` reflection textures and the custom JS `GlassShardPool` 3D floor-bounce batch!
 */
export class GlassSystem implements IDestructibleSubsystem {
  public readonly id: string;
  public readonly atlasTexture: pc.Texture;
  public readonly windowGlassTexture: pc.Texture;
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
    const windowTexSizePx = options.windowTextureSizePx ?? 256;
    const maxInstancedTriangles = options.maxInstancedTriangles ?? 512;
    const maxVoronoiShards = options.maxVoronoiShards ?? 640;

    // 1. Legacy 512x512 bitmask crack atlas + new seamless 256x256 window-space architectural glass texture
    this.atlasTexture = createMarchingGlassAtlasTexture(
      app.graphicsDevice,
      this.atlasSizePx,
    );
    this.windowGlassTexture = createWindowGlassPaneTexture(
      app.graphicsDevice,
      windowTexSizePx,
    );

    // 2. Realistic Window-Space Glass Materials (zero per-cell checkerboard tiling!)
    this.marchingMaterial = new pc.StandardMaterial();
    this.marchingMaterial.name = 'ArmoredVoronoiGlassMaterial';
    this.marchingMaterial.diffuse.set(0.84, 0.96, 0.96);
    this.marchingMaterial.diffuseMap = this.windowGlassTexture;
    this.marchingMaterial.opacityMap = this.windowGlassTexture;
    this.marchingMaterial.opacityMapChannel = 'a';
    this.marchingMaterial.emissive.set(0.18, 0.30, 0.32);
    this.marchingMaterial.emissiveMap = this.windowGlassTexture;
    this.marchingMaterial.useMetalness = true;
    this.marchingMaterial.metalness = 0.16;
    this.marchingMaterial.gloss = 0.95;
    this.marchingMaterial.blendType = pc.BLEND_NORMAL;
    this.marchingMaterial.depthWrite = false;
    this.marchingMaterial.cull = pc.CULLFACE_NONE;
    this.marchingMaterial.diffuseVertexColor = true;
    this.marchingMaterial.opacityVertexColor = true;
    this.marchingMaterial.update();

    this.voronoiIntactMaterial = new pc.StandardMaterial();
    this.voronoiIntactMaterial.name = 'VoronoiIntactGlassMaterial';
    this.voronoiIntactMaterial.diffuse.set(0.82, 0.94, 1.0);
    this.voronoiIntactMaterial.diffuseMap = this.windowGlassTexture;
    this.voronoiIntactMaterial.opacityMap = this.windowGlassTexture;
    this.voronoiIntactMaterial.opacityMapChannel = 'a';
    this.voronoiIntactMaterial.emissive.set(0.14, 0.24, 0.28);
    this.voronoiIntactMaterial.emissiveMap = this.windowGlassTexture;
    this.voronoiIntactMaterial.useMetalness = true;
    this.voronoiIntactMaterial.metalness = 0.18;
    this.voronoiIntactMaterial.gloss = 0.96;
    this.voronoiIntactMaterial.blendType = pc.BLEND_NORMAL;
    this.voronoiIntactMaterial.depthWrite = false;
    this.voronoiIntactMaterial.cull = pc.CULLFACE_BACK;
    this.voronoiIntactMaterial.diffuseVertexColor = true;
    this.voronoiIntactMaterial.opacityVertexColor = true;
    this.voronoiIntactMaterial.update();

    this.voronoiShardMaterial = new pc.StandardMaterial();
    this.voronoiShardMaterial.name = 'VoronoiExtrudedShardMaterial';
    this.voronoiShardMaterial.diffuse.set(0.84, 0.95, 1.0);
    this.voronoiShardMaterial.diffuseMap = this.windowGlassTexture;
    this.voronoiShardMaterial.emissive.set(0.18, 0.28, 0.34);
    this.voronoiShardMaterial.emissiveMap = this.windowGlassTexture;
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
    this.instancedTriangleMaterial.diffuse.set(0.84, 0.97, 1.0);
    this.instancedTriangleMaterial.emissive.set(0.28, 0.42, 0.48);
    this.instancedTriangleMaterial.useMetalness = true;
    this.instancedTriangleMaterial.metalness = 0.22;
    this.instancedTriangleMaterial.gloss = 0.96;
    this.instancedTriangleMaterial.opacity = 0.74;
    this.instancedTriangleMaterial.blendType = pc.BLEND_NORMAL;
    this.instancedTriangleMaterial.depthWrite = false;
    this.instancedTriangleMaterial.cull = pc.CULLFACE_NONE;
    this.instancedTriangleMaterial.update();

    // 3. Shared HardwareInstancedPool for ballistic spall crystalline chips
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

    // 4. Shared Custom JS Floor-Bounce Pool + Single Dynamic Batched `pc.Mesh` for Voronoi Chunks & Plates
    this.voronoiShardPool = new GlassShardPool(maxVoronoiShards);
    const maxBatchVerts = maxVoronoiShards * 96;
    const maxBatchIndices = maxVoronoiShards * 180;

    this.batchPositions = new Float32Array(maxBatchVerts * 3);
    this.batchNormals = new Float32Array(maxBatchVerts * 3);
    this.batchUvs = new Float32Array(maxBatchVerts * 2);
    this.batchColors = new Float32Array(maxBatchVerts * 4);
    this.batchIndices = new Uint32Array(maxBatchIndices);

    this.voronoiBatchMesh = new pc.Mesh(app.graphicsDevice);
    this.voronoiBatchMesh.clear(true, true, maxBatchVerts, maxBatchIndices);
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
      this.voronoiShardPool,
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
   * - Passes bullets cleanly through already-broken Voronoi holes / breaches with `0 J` loss!
   * - When crazing/breaking surviving glass, subtracts `~25–45 J` (`stopped: false`) so projectiles
   *   continue downrange while armored glass progressively fractures & drops 3D Voronoi chunks and
   *   regular glass shatters into large plate shards + shootable perimeter fangs!
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
    let sawMarchingWindowHit = false;

    for (let i = 0; i < glassHits.length; i++) {
      const hit = glassHits[i];
      const mat = hit.surface.material;

      if (mat === 'GLASS_MARCHING_256') {
        const win = this.marchingWindowMap.get(hit.surface.objectId);
        if (!win) continue;
        sawMarchingWindowHit = true;

        const outcome = win.breakAtWorldPoint(
          hit.pointWorld,
          seg.directionWorld,
          remainingEnergyJ,
          Math.max(0.035, seg.caliberRadiusM * 5.5),
          INSTANCED_SHARDS_PER_MARCHING_HIT,
          seg.isArmorPiercing,
        );
        if (!outcome.alreadyBroken) {
          if (!brokeAnyFreshGlass) {
            primaryHit = hit;
            brokeAnyFreshGlass = true;
          }
          remainingEnergyJ = Math.max(0, remainingEnergyJ - outcome.energyAbsorbedJ);
          if (outcome.spawnedVoronoiChunks > 0) {
            this.uploadVoronoiBatchedMesh();
            this.voronoiShardPool.clearDirty();
          }
        }
      } else if (mat === 'GLASS_VORONOI') {
        const win = this.voronoiWindowMap.get(hit.surface.objectId);
        if (!win) continue;

        const outcome = win.shatterAtWorldPoint(
          hit.pointWorld,
          seg.directionWorld,
          remainingEnergyJ,
          Math.max(0.03, seg.caliberRadiusM * 5.0),
        );
        if (!outcome.alreadyShattered) {
          if (!brokeAnyFreshGlass) {
            primaryHit = hit;
            brokeAnyFreshGlass = true;
          }
          remainingEnergyJ = Math.max(0, remainingEnergyJ - outcome.energyAbsorbedJ);
          this.uploadVoronoiBatchedMesh();
          this.voronoiShardPool.clearDirty();
        }
      }

      if (remainingEnergyJ <= 0) {
        remainingEnergyJ = 0;
        stopped = true;
        break;
      }
    }

    // If ray only passed through the open breach of a shattered VoronoiGlassWindow (missing any surviving fangs),
    // treat as pure empty air (`null`) so callers observe zero hit & zero energy loss!
    if (!brokeAnyFreshGlass && !sawMarchingWindowHit) {
      return null;
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
   * Shatters any glass windows or surviving perimeter fangs within blast shockwave radius and kicks floor shards.
   */
  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed || blast.radiusM <= 0 || blast.peakEnergyJ <= 0) {
      return;
    }

    this.voronoiShardPool.applyBlast(blast);

    for (const win of this.marchingWindowMap.values()) {
      if (win.survivingChunkCount === 0) continue;

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
        0.24,
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

    let shatteredAnyVoronoi = false;
    for (const win of this.voronoiWindowMap.values()) {
      if (win.shattered && win.survivingFangCount === 0) continue;

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
      const blastRadiusOnPane = Math.max(
        0.35,
        Math.hypot(win.widthM, win.heightM) * (0.4 + 0.6 * falloff),
      );
      const dir =
        dist > 1e-4
          ? { x: dx / dist, y: dy / dist, z: dz / dist }
          : rotateVec3ByQuat({ x: 0, y: 0, z: 1 }, win.rotationQuat);

      const res = win.shatterAtWorldPoint(
        closest,
        dir,
        shockEnergyJ,
        blastRadiusOnPane,
      );
      if (!res.alreadyShattered) {
        shatteredAnyVoronoi = true;
      }
    }

    if (shatteredAnyVoronoi || this.voronoiShardPool.dirty) {
      this.uploadVoronoiBatchedMesh();
      this.voronoiShardPool.clearDirty();
    }
  }

  public update(dt: number): void {
    if (this.destroyed) {
      return;
    }

    this.instancedTrianglePool.syncFromPhysics(this.physics, dt);

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
    this.windowGlassTexture.destroy();
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
