import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  ColliderSurfaceTag,
  DestructibleMaterialKind,
  IDestructibleSubsystem,
  PenetrationRayHit,
  QuatLike,
} from '../../contracts/destruction.ts';
import {
  computePanelRemainingAreaM2,
  createJaggedHoleStamp,
  createWoodPanelState,
  inferWoodStampProfile,
  isPointInOpenHole,
  resetWoodPanelState,
  stampHoleInWoodPanel,
  triangulateWoodPanelToBuffers,
  type SplinterSpawnDescriptor,
  type WoodMeshBuildStats,
  type WoodMeshScratchBuffers,
  type WoodPanelClipperState,
} from '../../core/destruction/woodPolygonClipper.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

export const DEFAULT_WOOD_WALL_MAX_VERTICES = 24_576;
export const DEFAULT_WOOD_WALL_MAX_INDICES = 73_728;
export const DEFAULT_WOOD_STUD_WIDTH_M = 0.045;
export const DEFAULT_WOOD_STUD_DEPTH_M = 0.085;
export const DEFAULT_WOOD_STUD_SPACING_M = 0.60;

export interface WoodWallConfig {
  id: string;
  /** World-space center of the wall (e.g. `y = heightM * 0.5` rests flush on `y = 0` ground) */
  centerWorld: Vec3Like;
  /** Width of the wood panel in meters (default `2.4`) */
  widthM?: number;
  /** Height of the wood panel in meters (default `2.4`) */
  heightM?: number;
  /** Sandwich thickness of the wood panel in meters (default `0.08`) */
  thicknessM?: number;
  /** Rotation around world `+Y` axis in radians (default `0` -> normal along `+Z`) */
  yawRad?: number;
  /** Horizontal center-to-center stud spacing in meters (default `0.60`) */
  studSpacingM?: number;
}

export interface WoodWallSystemOptions {
  id?: string;
  /**
   * Optional Blender-authored splinter meshes (e.g. `Splinter_0..2`).
   * Falls back to 3 procedural sharp jagged wood-splinter prisms when omitted.
   */
  splinterMeshes?: readonly pc.Mesh[];
  /** Optional override material for destructible wood panels */
  panelMaterial?: pc.Material;
  /** Optional override material for interior 2x4 pine studs */
  studMaterial?: pc.Material;
  /** Optional override material for flying instanced wood splinters */
  splinterMaterial?: pc.Material;
  /** Total hardware-instanced splinter capacity across pools (default `768`) */
  maxSplinterInstances?: number;
  /** Pre-allocated `BUFFER_DYNAMIC` vertex capacity per wall `pc.Mesh` (default `24576`) */
  maxPanelVertices?: number;
  /** Pre-allocated `BUFFER_DYNAMIC` index capacity per wall `pc.Mesh` (default `73728`) */
  maxPanelIndices?: number;
}

export interface WoodWallInstance {
  readonly id: string;
  readonly centerWorld: Vec3Like;
  readonly widthM: number;
  readonly heightM: number;
  readonly thicknessM: number;
  readonly yawRad: number;
  readonly studSpacingM: number;
  readonly cosYaw: number;
  readonly sinYaw: number;
  readonly rotationQuat: QuatLike;
  readonly studPositionsU: readonly number[];
  readonly drywallColliderHandle: number;
  readonly studColliderHandles: readonly number[];
  readonly rootEntity: pc.Entity;
  readonly panelEntity: pc.Entity;
  readonly studFrameEntity: pc.Entity;
  readonly panelMesh: pc.Mesh;
  readonly studFrameMesh: pc.Mesh;
  readonly panelState: WoodPanelClipperState;
  readonly scratchBuffers: WoodMeshScratchBuffers;
  lastMeshStats: WoodMeshBuildStats;
}

function hash2d(x: number, y: number, seed: number): number {
  let n = Math.imul(
    x * 374761393 + y * 668265263 + seed * 1442695041,
    1274126177,
  );
  n = (n ^ (n >>> 13)) >>> 0;
  return (n & 0xffff) / 0xffff;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Generates a crisp retro wood-plank & raw-splinter-core RGBA8 texture:
 * - `v in [0.0, 0.85]`: painted/varnished plywood & horizontal shiplap plank grain (front/back faces)
 * - `v in [0.86, 1.0]`: bright raw splintered pale pine core (extruded inner bullet-hole rims!)
 */
function createProceduralWoodPanelTexture(device: pc.GraphicsDevice): pc.Texture {
  const size = 128;
  const tex = new pc.Texture(device, {
    name: 'wood_wall_sandwich_tex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_NEAREST,
    magFilter: pc.FILTER_NEAREST,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const fineNoise = (hash2d(x, y, 31) - 0.5) * 16;
      let r: number;
      let g: number;
      let b: number;

      if (v >= 0.86) {
        // Raw freshly-splintered pale pine / gypsum core for extruded 3D hole rims
        const fiber = Math.sin(x * 1.35 + hash2d(x >> 1, y, 73) * 3.2) * 18;
        r = 214 + fiber + fineNoise * 0.6;
        g = 176 + fiber * 0.85 + fineNoise * 0.5;
        b = 118 + fiber * 0.65 + fineNoise * 0.4;
      } else {
        // Varnished shoot-house plywood sheathing with subtle plank seams & knots
        const plankRow = Math.floor((v / 0.85) * 6);
        const plankLocalV = ((v / 0.85) * 6) % 1;
        const seam = plankLocalV < 0.045 || plankLocalV > 0.965;
        const grainWave =
          Math.sin(y * 0.75 + Math.sin(x * 0.14 + plankRow * 2.1) * 2.8) * 14;
        const knotDist = Math.hypot(
          ((u * 3 + plankRow * 0.37) % 1) - 0.5,
          (plankLocalV - 0.5) * 1.4,
        );
        const knotDarken = knotDist < 0.11 ? -26 * (1 - knotDist / 0.11) : 0;

        if (seam) {
          r = 72 + fineNoise * 0.4;
          g = 50 + fineNoise * 0.4;
          b = 32 + fineNoise * 0.4;
        } else {
          r = 148 + grainWave + knotDarken + fineNoise * 0.55;
          g = 108 + grainWave * 0.78 + knotDarken * 0.8 + fineNoise * 0.45;
          b = 68 + grainWave * 0.52 + knotDarken * 0.6 + fineNoise * 0.35;
        }
      }

      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(r);
      pixels[idx + 1] = clampByte(g);
      pixels[idx + 2] = clampByte(b);
      pixels[idx + 3] = 255;
    }
  }
  tex.unlock();
  return tex;
}

function createProceduralPineStudTexture(device: pc.GraphicsDevice): pc.Texture {
  const size = 64;
  const tex = new pc.Texture(device, {
    name: 'wood_stud_lumber_tex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_NEAREST,
    magFilter: pc.FILTER_NEAREST,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = (hash2d(x, y, 97) - 0.5) * 14;
      // Vertical pine grain streaks along Y
      const streak = Math.sin(x * 1.1 + hash2d(x, y >> 3, 131) * 2.4) * 15;
      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(188 + streak + n);
      pixels[idx + 1] = clampByte(144 + streak * 0.8 + n);
      pixels[idx + 2] = clampByte(88 + streak * 0.55 + n);
      pixels[idx + 3] = 255;
    }
  }
  tex.unlock();
  return tex;
}

/**
 * Builds 3 sharp, elongated, asymmetric wood-splinter prism meshes aligned along local `+X`
 * (unit length `1.0` along X so per-instance `scale.x` controls splinter length directly).
 */
export function createProceduralSplinterMeshes(
  device: pc.GraphicsDevice,
): pc.Mesh[] {
  const variants: Array<{
    tipSkewY: number;
    tipSkewZ: number;
    midBulgeY: number;
    midBulgeZ: number;
  }> = [
    { tipSkewY: 0.16, tipSkewZ: -0.12, midBulgeY: 0.52, midBulgeZ: 0.44 },
    { tipSkewY: -0.22, tipSkewZ: 0.18, midBulgeY: 0.42, midBulgeZ: 0.58 },
    { tipSkewY: 0.08, tipSkewZ: 0.24, midBulgeY: 0.62, midBulgeZ: 0.36 },
  ];

  const meshes: pc.Mesh[] = [];

  for (let vIdx = 0; vIdx < variants.length; vIdx++) {
    const v = variants[vIdx];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const emitTri = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
    ): void => {
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];

      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9) {
        return;
      }
      nx /= len;
      ny /= len;
      nz /= len;

      const base = positions.length / 3;
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      uvs.push(
        a[0] + 0.5,
        0.90,
        b[0] + 0.5,
        0.95,
        c[0] + 0.5,
        0.98,
      );
      indices.push(base, base + 1, base + 2);
    };

    // Jagged 6-vertex bipyramid / triangular-shard splinter spanning x in [-0.5, +0.5]
    const tailTip: [number, number, number] = [-0.5, -v.tipSkewY, -v.tipSkewZ];
    const headTip: [number, number, number] = [0.5, v.tipSkewY, v.tipSkewZ];
    const mTop: [number, number, number] = [-0.06, v.midBulgeY, 0.05];
    const mRight: [number, number, number] = [0.04, -v.midBulgeY * 0.65, v.midBulgeZ];
    const mLeft: [number, number, number] = [0.02, -v.midBulgeY * 0.55, -v.midBulgeZ];

    // Forward sharp shard faces (toward headTip +X)
    emitTri(mTop, mRight, headTip);
    emitTri(mRight, mLeft, headTip);
    emitTri(mLeft, mTop, headTip);

    // Rear jagged tear faces (toward tailTip -X)
    emitTri(mRight, mTop, tailTip);
    emitTri(mLeft, mRight, tailTip);
    emitTri(mTop, mLeft, tailTip);

    const mesh = new pc.Mesh(device);
    mesh.setPositions(positions);
    mesh.setNormals(normals);
    mesh.setUvs(0, uvs);
    mesh.setIndices(indices);
    mesh.update(pc.PRIMITIVE_TRIANGLES, true);
    mesh.incRefCount();
    meshes.push(mesh);
  }

  return meshes;
}

/**
 * Computes evenly spaced vertical 2x4 stud `u` positions in `[0, widthM]` (every `studSpacingM` on-center,
 * plus flush left & right framing studs).
 */
export function computeWallStudPositionsU(
  widthM: number,
  studSpacingM = DEFAULT_WOOD_STUD_SPACING_M,
  studWidthM = DEFAULT_WOOD_STUD_WIDTH_M,
): number[] {
  const halfStudW = studWidthM * 0.5;
  if (widthM <= studWidthM * 2.2) {
    return [widthM * 0.5];
  }

  const positions: number[] = [halfStudW];
  const rightEdgeU = widthM - halfStudW;
  const safeSpacing = Math.max(0.18, studSpacingM);

  for (let stepIdx = 1; ; stepIdx++) {
    const u = Math.round(stepIdx * safeSpacing * 1_000_000) / 1_000_000;
    if (u >= rightEdgeU - studWidthM * 1.15) {
      break;
    }
    positions.push(u);
  }

  positions.push(rightEdgeU);
  return positions;
}

/**
 * Builds a single combined static `pc.Mesh` containing all vertical 2x4 studs and top/bottom
 * framing plates for one wall so the entire timber frame renders in 1 draw call and is exposed
 * cleanly inside blown-out holes.
 */
function buildWallStudFrameMesh(
  device: pc.GraphicsDevice,
  widthM: number,
  heightM: number,
  visualDepthM: number,
  studPositionsU: readonly number[],
  studWidthM = DEFAULT_WOOD_STUD_WIDTH_M,
): pc.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const appendBox = (
    cx: number,
    cy: number,
    cz: number,
    wx: number,
    wy: number,
    wz: number,
  ): void => {
    const hx = wx * 0.5;
    const hy = wy * 0.5;
    const hz = wz * 0.5;

    const faces: Array<{
      n: [number, number, number];
      verts: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
      uvSpanU: number;
      uvSpanV: number;
    }> = [
      // +Z
      {
        n: [0, 0, 1],
        verts: [
          [cx - hx, cy - hy, cz + hz],
          [cx + hx, cy - hy, cz + hz],
          [cx + hx, cy + hy, cz + hz],
          [cx - hx, cy + hy, cz + hz],
        ],
        uvSpanU: wx * 4,
        uvSpanV: wy * 2,
      },
      // -Z
      {
        n: [0, 0, -1],
        verts: [
          [cx + hx, cy - hy, cz - hz],
          [cx - hx, cy - hy, cz - hz],
          [cx - hx, cy + hy, cz - hz],
          [cx + hx, cy + hy, cz - hz],
        ],
        uvSpanU: wx * 4,
        uvSpanV: wy * 2,
      },
      // +X
      {
        n: [1, 0, 0],
        verts: [
          [cx + hx, cy - hy, cz + hz],
          [cx + hx, cy - hy, cz - hz],
          [cx + hx, cy + hy, cz - hz],
          [cx + hx, cy + hy, cz + hz],
        ],
        uvSpanU: wz * 4,
        uvSpanV: wy * 2,
      },
      // -X
      {
        n: [-1, 0, 0],
        verts: [
          [cx - hx, cy - hy, cz - hz],
          [cx - hx, cy - hy, cz + hz],
          [cx - hx, cy + hy, cz + hz],
          [cx - hx, cy + hy, cz - hz],
        ],
        uvSpanU: wz * 4,
        uvSpanV: wy * 2,
      },
      // +Y
      {
        n: [0, 1, 0],
        verts: [
          [cx - hx, cy + hy, cz + hz],
          [cx + hx, cy + hy, cz + hz],
          [cx + hx, cy + hy, cz - hz],
          [cx - hx, cy + hy, cz - hz],
        ],
        uvSpanU: wx * 2,
        uvSpanV: wz * 4,
      },
      // -Y
      {
        n: [0, -1, 0],
        verts: [
          [cx - hx, cy - hy, cz - hz],
          [cx + hx, cy - hy, cz - hz],
          [cx + hx, cy - hy, cz + hz],
          [cx - hx, cy - hy, cz + hz],
        ],
        uvSpanU: wx * 2,
        uvSpanV: wz * 4,
      },
    ];

    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      const base = positions.length / 3;
      for (let k = 0; k < 4; k++) {
        positions.push(face.verts[k][0], face.verts[k][1], face.verts[k][2]);
        normals.push(face.n[0], face.n[1], face.n[2]);
      }
      uvs.push(
        0,
        0,
        face.uvSpanU,
        0,
        face.uvSpanU,
        face.uvSpanV,
        0,
        face.uvSpanV,
      );
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  };

  const halfW = widthM * 0.5;
  const halfH = heightM * 0.5;
  const plateH = Math.min(studWidthM, heightM * 0.2);

  // Bottom sole plate & top header plate
  appendBox(0, -halfH + plateH * 0.5, 0, widthM, plateH, visualDepthM);
  appendBox(0, halfH - plateH * 0.5, 0, widthM, plateH, visualDepthM);

  // Vertical 2x4 studs between bottom & top plates
  const verticalStudH = Math.max(0.02, heightM - plateH * 2);
  for (let i = 0; i < studPositionsU.length; i++) {
    const cx = studPositionsU[i] - halfW;
    appendBox(cx, 0, 0, studWidthM, verticalStudH, visualDepthM);
  }

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES, true);
  mesh.incRefCount();
  return mesh;
}

/**
 * Computes a normalized quaternion rotating unit `+X` `(1, 0, 0)` onto unit vector `(dx, dy, dz)`.
 */
function quatAlignUnitXToVector(
  dx: number,
  dy: number,
  dz: number,
  out: QuatLike,
): void {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return;
  }
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;

  if (ux < -0.9999) {
    // 180 deg around +Y
    out.x = 0;
    out.y = 1;
    out.z = 0;
    out.w = 0;
    return;
  }

  const qx = 0;
  const qy = -uz;
  const qz = uy;
  const qw = 1 + ux;
  const qNorm = Math.hypot(qx, qy, qz, qw);
  out.x = qx / qNorm;
  out.y = qy / qNorm;
  out.z = qz / qNorm;
  out.w = qw / qNorm;
}

/**
 * Rainbow Six Siege-style dynamic boolean wood stud wall subsystem:
 * - Double-sided `BUFFER_DYNAMIC` `pc.Mesh` wood panels clipped in real time via `clipper2-js` + `earcut`
 * - Zero GPU buffer reallocations across 100+ shots per wall
 * - Static Rapier `WOOD_STUD` framing (`0.045m x height x 0.085m` every `0.60m` + top/bottom plates)
 * - Hardware-instanced flying wood splinters via `HardwareInstancedPool` (zero per-splinter `pc.Entity` objects!)
 */
export class WoodWallSystem implements IDestructibleSubsystem {
  public readonly id: string;
  public readonly app: pc.Application;
  public readonly physicsWorld: RapierPhysicsWorld;
  public readonly splinterPools: readonly HardwareInstancedPool[];

  private readonly maxPanelVertices: number;
  private readonly maxPanelIndices: number;

  private readonly panelMaterial: pc.Material;
  private readonly studMaterial: pc.Material;
  private readonly splinterMaterial: pc.Material;

  private readonly ownedTextures: pc.Texture[] = [];
  private readonly ownedMaterials: pc.Material[] = [];
  private readonly ownedSplinterMeshes: pc.Mesh[] = [];

  private readonly walls: WoodWallInstance[] = [];
  private readonly wallsById = new Map<string, WoodWallInstance>();

  private readonly scratchQuat: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  private readonly scratchPos: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly scratchVel: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly scratchAngVel: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly scratchScale: Vec3Like = { x: 0.1, y: 0.015, z: 0.015 };

  private splinterRngState = 0x51f2a7c3;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    physicsWorld: RapierPhysicsWorld,
    options: WoodWallSystemOptions = {},
  ) {
    this.id = options.id ?? 'wood-wall-system';
    this.app = app;
    this.physicsWorld = physicsWorld;
    this.maxPanelVertices = Math.max(
      1024,
      options.maxPanelVertices ?? DEFAULT_WOOD_WALL_MAX_VERTICES,
    );
    this.maxPanelIndices = Math.max(
      3072,
      options.maxPanelIndices ?? DEFAULT_WOOD_WALL_MAX_INDICES,
    );

    const device = app.graphicsDevice;

    if (options.panelMaterial) {
      this.panelMaterial = options.panelMaterial;
    } else {
      const panelTex = createProceduralWoodPanelTexture(device);
      this.ownedTextures.push(panelTex);

      const mat = new pc.StandardMaterial();
      mat.name = 'WoodWallPanelMat';
      mat.diffuse = new pc.Color(1, 1, 1);
      mat.diffuseMap = panelTex;
      mat.specular = new pc.Color(0.08, 0.07, 0.05);
      mat.gloss = 0.22;
      mat.update();
      this.panelMaterial = mat;
      this.ownedMaterials.push(mat);
    }

    if (options.studMaterial) {
      this.studMaterial = options.studMaterial;
    } else {
      const studTex = createProceduralPineStudTexture(device);
      this.ownedTextures.push(studTex);

      const mat = new pc.StandardMaterial();
      mat.name = 'WoodWallStudMat';
      mat.diffuse = new pc.Color(1, 1, 1);
      mat.diffuseMap = studTex;
      mat.specular = new pc.Color(0.06, 0.05, 0.04);
      mat.gloss = 0.16;
      mat.update();
      this.studMaterial = mat;
      this.ownedMaterials.push(mat);
    }

    if (options.splinterMaterial) {
      this.splinterMaterial = options.splinterMaterial;
    } else {
      const mat = new pc.StandardMaterial();
      mat.name = 'WoodSplinterMat';
      mat.diffuse = new pc.Color(0.84, 0.67, 0.43);
      mat.specular = new pc.Color(0.1, 0.08, 0.05);
      mat.gloss = 0.2;
      mat.update();
      this.splinterMaterial = mat;
      this.ownedMaterials.push(mat);
    }

    let meshesToUse: readonly pc.Mesh[];
    if (options.splinterMeshes && options.splinterMeshes.length > 0) {
      meshesToUse = options.splinterMeshes;
    } else {
      const procedural = createProceduralSplinterMeshes(device);
      this.ownedSplinterMeshes.push(...procedural);
      meshesToUse = procedural;
    }

    const totalCap = Math.max(64, options.maxSplinterInstances ?? 768);
    const perPoolCap = Math.max(32, Math.ceil(totalCap / meshesToUse.length));
    const pools: HardwareInstancedPool[] = [];
    for (let i = 0; i < meshesToUse.length; i++) {
      pools.push(
        new HardwareInstancedPool(
          app,
          meshesToUse[i],
          this.splinterMaterial,
          perPoolCap,
          `${this.id}_SplinterPool_${i}`,
          true,
        ),
      );
    }
    this.splinterPools = pools;
  }

  public get wallCount(): number {
    return this.walls.length;
  }

  public get activeSplinterCount(): number {
    let total = 0;
    for (let i = 0; i < this.splinterPools.length; i++) {
      total += this.splinterPools[i].activeCount;
    }
    return total;
  }

  public getWall(wallId: string): WoodWallInstance | undefined {
    return this.wallsById.get(wallId);
  }

  public getAllWalls(): readonly WoodWallInstance[] {
    return this.walls;
  }

  /**
   * Builds a destructible Rainbow Six Siege-style framed wood stud wall, registering static
   * Rapier `WOOD_STUD` + `WOOD_DRYWALL` colliders and initializing a dynamic `BUFFER_DYNAMIC` `pc.Mesh`.
   */
  public createWall(config: WoodWallConfig): WoodWallInstance {
    if (this.destroyed) {
      throw new Error('Cannot createWall on a destroyed WoodWallSystem.');
    }
    if (this.wallsById.has(config.id)) {
      throw new Error(`Wood wall with id "${config.id}" already exists.`);
    }

    const widthM = Math.max(0.2, config.widthM ?? 2.4);
    const heightM = Math.max(0.2, config.heightM ?? 2.4);
    const thicknessM = Math.max(0.02, config.thicknessM ?? 0.08);
    const yawRad = config.yawRad ?? 0;
    const studSpacingM = Math.max(
      0.2,
      config.studSpacingM ?? DEFAULT_WOOD_STUD_SPACING_M,
    );

    const cosYaw = Math.cos(yawRad);
    const sinYaw = Math.sin(yawRad);
    const halfYaw = yawRad * 0.5;
    const rotationQuat: QuatLike = {
      x: 0,
      y: Math.sin(halfYaw),
      z: 0,
      w: Math.cos(halfYaw),
    };

    const centerWorld: Vec3Like = {
      x: config.centerWorld.x,
      y: config.centerWorld.y,
      z: config.centerWorld.z,
    };

    const studPositionsU = computeWallStudPositionsU(
      widthM,
      studSpacingM,
      DEFAULT_WOOD_STUD_WIDTH_M,
    );

    // 1. Register static Rapier WOOD_STUD box colliders (vertical studs every 0.60m + top & bottom plates)
    const studColliderHandles: number[] = [];
    const halfW = widthM * 0.5;
    const halfH = heightM * 0.5;
    const studHalfW = DEFAULT_WOOD_STUD_WIDTH_M * 0.5;
    const studHalfD = DEFAULT_WOOD_STUD_DEPTH_M * 0.5;
    const plateH = Math.min(DEFAULT_WOOD_STUD_WIDTH_M, heightM * 0.2);
    const plateHalfH = plateH * 0.5;
    const verticalStudH = Math.max(0.02, heightM - plateH * 2);

    const localToWorld = (lx: number, ly: number, lz: number): Vec3Like => ({
      x: centerWorld.x + lx * cosYaw + lz * sinYaw,
      y: centerWorld.y + ly,
      z: centerWorld.z - lx * sinYaw + lz * cosYaw,
    });

    let studChunkIdx = 0;
    for (let i = 0; i < studPositionsU.length; i++) {
      const lx = studPositionsU[i] - halfW;
      const studCenter = localToWorld(lx, 0, 0);
      const studTag: ColliderSurfaceTag = {
        material: 'WOOD_STUD',
        objectId: config.id,
        chunkIndex: studChunkIdx++,
        thicknessM: DEFAULT_WOOD_STUD_DEPTH_M,
        penetrationResistanceJ: 650,
      };
      const handle = this.physicsWorld.createStaticBox(
        studCenter,
        { x: studHalfW, y: verticalStudH * 0.5, z: studHalfD },
        rotationQuat,
        studTag,
      );
      studColliderHandles.push(handle);
    }

    // Bottom sole plate & top header plate WOOD_STUD colliders
    const bottomPlateTag: ColliderSurfaceTag = {
      material: 'WOOD_STUD',
      objectId: config.id,
      chunkIndex: studChunkIdx++,
      thicknessM: DEFAULT_WOOD_STUD_DEPTH_M,
      penetrationResistanceJ: 650,
    };
    studColliderHandles.push(
      this.physicsWorld.createStaticBox(
        localToWorld(0, -halfH + plateHalfH, 0),
        { x: halfW, y: plateHalfH, z: studHalfD },
        rotationQuat,
        bottomPlateTag,
      ),
    );

    const topPlateTag: ColliderSurfaceTag = {
      material: 'WOOD_STUD',
      objectId: config.id,
      chunkIndex: studChunkIdx++,
      thicknessM: DEFAULT_WOOD_STUD_DEPTH_M,
      penetrationResistanceJ: 650,
    };
    studColliderHandles.push(
      this.physicsWorld.createStaticBox(
        localToWorld(0, halfH - plateHalfH, 0),
        { x: halfW, y: plateHalfH, z: studHalfD },
        rotationQuat,
        topPlateTag,
      ),
    );

    // 2. Thin WOOD_DRYWALL Rapier panel trigger/collider spanning the full panel [0, widthM] x [0, heightM]
    const drywallHalfZ = Math.max(0.012, thicknessM * 0.25);
    const drywallTag: ColliderSurfaceTag = {
      material: 'WOOD_DRYWALL',
      objectId: config.id,
      thicknessM,
      penetrationResistanceJ: 185,
    };
    const drywallColliderHandle = this.physicsWorld.createStaticBox(
      centerWorld,
      { x: halfW, y: halfH, z: drywallHalfZ },
      rotationQuat,
      drywallTag,
    );

    // 3. Pre-allocate scratch typed arrays & initialize BUFFER_DYNAMIC pc.Mesh
    const scratchBuffers: WoodMeshScratchBuffers = {
      positions: new Float32Array(this.maxPanelVertices * 3),
      normals: new Float32Array(this.maxPanelVertices * 3),
      uvs: new Float32Array(this.maxPanelVertices * 2),
      indices:
        this.maxPanelVertices <= 65535
          ? new Uint16Array(this.maxPanelIndices)
          : new Uint32Array(this.maxPanelIndices),
    };

    const panelState = createWoodPanelState(widthM, heightM, thicknessM);
    const initialStats = triangulateWoodPanelToBuffers(panelState, scratchBuffers);

    const panelMesh = new pc.Mesh(this.app.graphicsDevice);
    panelMesh.clear(true, true, this.maxPanelVertices, this.maxPanelIndices);
    panelMesh.setPositions(scratchBuffers.positions, 3, initialStats.vertexCount);
    panelMesh.setNormals(scratchBuffers.normals, 3, initialStats.vertexCount);
    panelMesh.setUvs(0, scratchBuffers.uvs, 2, initialStats.vertexCount);
    panelMesh.setIndices(scratchBuffers.indices, initialStats.indexCount);
    panelMesh.update(pc.PRIMITIVE_TRIANGLES, true);
    panelMesh.incRefCount();

    // Visibly rendered 2x4 pine studs recessed slightly inside [±thicknessM * 0.5] so intact panels
    // never z-fight while blown-open breaches expose the solid 3D studs between front & back skins!
    const visualStudDepthM = Math.max(0.014, thicknessM - 0.006);
    const studFrameMesh = buildWallStudFrameMesh(
      this.app.graphicsDevice,
      widthM,
      heightM,
      visualStudDepthM,
      studPositionsU,
      DEFAULT_WOOD_STUD_WIDTH_M,
    );

    const rootEntity = new pc.Entity(`WoodWall_${config.id}`);
    rootEntity.setPosition(centerWorld.x, centerWorld.y, centerWorld.z);
    rootEntity.setRotation(
      rotationQuat.x,
      rotationQuat.y,
      rotationQuat.z,
      rotationQuat.w,
    );

    const panelEntity = new pc.Entity(`WoodWallPanel_${config.id}`);
    const panelMi = new pc.MeshInstance(panelMesh, this.panelMaterial);
    panelEntity.addComponent('render', {
      meshInstances: [panelMi],
      castShadows: true,
      receiveShadows: true,
    });
    rootEntity.addChild(panelEntity);

    const studFrameEntity = new pc.Entity(`WoodWallStuds_${config.id}`);
    const studMi = new pc.MeshInstance(studFrameMesh, this.studMaterial);
    studFrameEntity.addComponent('render', {
      meshInstances: [studMi],
      castShadows: true,
      receiveShadows: true,
    });
    rootEntity.addChild(studFrameEntity);

    this.app.root.addChild(rootEntity);

    const instance: WoodWallInstance = {
      id: config.id,
      centerWorld,
      widthM,
      heightM,
      thicknessM,
      yawRad,
      studSpacingM,
      cosYaw,
      sinYaw,
      rotationQuat,
      studPositionsU,
      drywallColliderHandle,
      studColliderHandles,
      rootEntity,
      panelEntity,
      studFrameEntity,
      panelMesh,
      studFrameMesh,
      panelState,
      scratchBuffers,
      lastMeshStats: initialStats,
    };

    this.walls.push(instance);
    this.wallsById.set(config.id, instance);
    return instance;
  }

  public update(dt: number): void {
    if (this.destroyed) {
      return;
    }
    for (let i = 0; i < this.splinterPools.length; i++) {
      this.splinterPools[i].syncFromPhysics(this.physicsWorld, dt);
    }
  }

  /**
   * Stepped ballistic penetration & dynamic Clipper2 hole stamping across wood stud walls.
   * - Returns `null` if the ray segment does not intersect any wood wall in this subsystem.
   * - Passes bullets through ALREADY blown-open holes with `0 J` energy loss (`stopped: false`)!
   * - Stamps jagged holes + spawns 4–6 tangent instanced splinters on solid wood hits,
   *   subtracting `~140–240 J` on `WOOD_DRYWALL` or `~650 J` when clipping a `WOOD_STUD`.
   */
  public handleRaySegment(
    seg: BallisticSegmentImpact,
  ): BallisticPenetrationResult | null {
    if (this.destroyed || this.walls.length === 0 || seg.maxDistanceM <= 0) {
      return null;
    }

    const dirLen = Math.hypot(
      seg.directionWorld.x,
      seg.directionWorld.y,
      seg.directionWorld.z,
    );
    if (dirLen < 1e-8) {
      return null;
    }

    const dx = seg.directionWorld.x / dirLen;
    const dy = seg.directionWorld.y / dirLen;
    const dz = seg.directionWorld.z / dirLen;
    const unitDir: Vec3Like = { x: dx, y: dy, z: dz };

    const allHits = this.physicsWorld.castPenetrationRay(
      seg.originWorld,
      unitDir,
      seg.maxDistanceM,
    );
    if (allHits.length === 0) {
      return null;
    }

    // Group hits belonging to our wood walls in ascending distance order
    const orderedWallIds: string[] = [];
    const wallHitGroups = new Map<
      string,
      {
        wall: WoodWallInstance;
        primaryHit: PenetrationRayHit;
        hitStud: boolean;
      }
    >();

    for (let i = 0; i < allHits.length; i++) {
      const hit = allHits[i];
      const wall = this.wallsById.get(hit.surface.objectId);
      if (!wall) {
        continue;
      }

      let group = wallHitGroups.get(wall.id);
      if (!group) {
        group = {
          wall,
          primaryHit: hit,
          hitStud: hit.surface.material === 'WOOD_STUD',
        };
        wallHitGroups.set(wall.id, group);
        orderedWallIds.push(wall.id);
      } else if (hit.surface.material === 'WOOD_STUD') {
        group.hitStud = true;
      }
    }

    if (orderedWallIds.length === 0) {
      return null;
    }

    let currentEnergyJ = Math.max(0, seg.kineticEnergyJ);
    let currentSpeedMs = Math.max(0, seg.speedMs);
    let stopped = false;
    let firstImpactPoint: Vec3Like | undefined;
    let firstImpactNormal: Vec3Like | undefined;
    let effectiveMaterial: DestructibleMaterialKind = 'WOOD_DRYWALL';

    for (let wIdx = 0; wIdx < orderedWallIds.length; wIdx++) {
      const group = wallHitGroups.get(orderedWallIds[wIdx]);
      if (!group) {
        continue;
      }

      const { wall, primaryHit } = group;
      if (!firstImpactPoint) {
        firstImpactPoint = primaryHit.pointWorld;
        firstImpactNormal = primaryHit.normalWorld;
      }

      // Convert 3D ray into wall-local coordinates to find exact mid-plane (lz = 0) 2D (u, v)
      const relOx = seg.originWorld.x - wall.centerWorld.x;
      const relOy = seg.originWorld.y - wall.centerWorld.y;
      const relOz = seg.originWorld.z - wall.centerWorld.z;

      const localOx = relOx * wall.cosYaw - relOz * wall.sinYaw;
      const localOy = relOy;
      const localOz = relOx * wall.sinYaw + relOz * wall.cosYaw;

      const localDx = dx * wall.cosYaw - dz * wall.sinYaw;
      const localDy = dy;
      const localDz = dx * wall.sinYaw + dz * wall.cosYaw;

      let hitLocalX: number;
      let hitLocalY: number;

      if (Math.abs(localDz) > 1e-5) {
        const tMid = -localOz / localDz;
        if (tMid >= 0 && tMid <= seg.maxDistanceM + wall.thicknessM) {
          hitLocalX = localOx + localDx * tMid;
          hitLocalY = localOy + localDy * tMid;
        } else {
          const hp = primaryHit.pointWorld;
          const rx = hp.x - wall.centerWorld.x;
          const rz = hp.z - wall.centerWorld.z;
          hitLocalX = rx * wall.cosYaw - rz * wall.sinYaw;
          hitLocalY = hp.y - wall.centerWorld.y;
        }
      } else {
        const hp = primaryHit.pointWorld;
        const rx = hp.x - wall.centerWorld.x;
        const rz = hp.z - wall.centerWorld.z;
        hitLocalX = rx * wall.cosYaw - rz * wall.sinYaw;
        hitLocalY = hp.y - wall.centerWorld.y;
      }

      const u = hitLocalX + wall.widthM * 0.5;
      const v = hitLocalY + wall.heightM * 0.5;

      // Also verify geometric stud proximity at mid-plane in case ray only nicked drywall trigger
      const hitStud = group.hitStud || this.isPointOverStud(wall, u, v);
      const alreadyOpenHole = isPointInOpenHole(wall.panelState, u, v);

      // Clean shot straight through an ALREADY cut hole without touching any stud -> ZERO energy loss!
      if (alreadyOpenHole && !hitStud) {
        effectiveMaterial = 'WOOD_DRYWALL';
        continue;
      }

      const cosIncidence = Math.abs(localDz);
      const obliquity = Math.min(2.1, 1 / Math.max(0.48, cosIncidence));
      const thicknessRatio = wall.thicknessM / 0.08;

      if (!alreadyOpenHole && u >= 0 && u <= wall.widthM && v >= 0 && v <= wall.heightM) {
        const profile = inferWoodStampProfile(
          seg.caliberRadiusM,
          currentEnergyJ,
          seg.isArmorPiercing,
        );
        const stamp = createJaggedHoleStamp({
          u,
          v,
          caliberRadiusM: seg.caliberRadiusM,
          kineticEnergyJ: currentEnergyJ,
          profile,
          isArmorPiercing: seg.isArmorPiercing,
          seed: wall.panelState.shotCount + 1,
        });

        const splinterHint =
          profile === 'BUCKSHOT_PELLET'
            ? 4
            : profile === 'HEAVY_50AE_SLUG' || profile === 'BLAST_BREACH'
              ? 6
              : 5;

        const subResult = stampHoleInWoodPanel(
          wall.panelState,
          stamp,
          wall.scratchBuffers,
          splinterHint,
        );

        if (subResult.cutAnyWood) {
          this.uploadWallPanelMesh(wall, subResult.meshStats);
          this.spawnPerimeterSplinters(
            wall,
            subResult.splinters,
            unitDir,
            localDz >= 0 ? 1 : -1,
            currentEnergyJ,
          );
        }
      } else if (hitStud) {
        // Bullet struck an already-exposed 2x4 stud inside an open breach -> kick off small pine chips
        const studSplinters: SplinterSpawnDescriptor[] = [];
        const clampedU = Math.max(0, Math.min(wall.widthM, u));
        const clampedV = Math.max(0, Math.min(wall.heightM, v));
        for (let k = 0; k < 4; k++) {
          const ang = (k / 4) * Math.PI * 2;
          studSplinters.push({
            u: clampedU,
            v: clampedV,
            tangentU: -Math.sin(ang),
            tangentV: Math.cos(ang),
            radialU: Math.cos(ang),
            radialV: Math.sin(ang),
            lengthM: 0.065,
          });
        }
        this.spawnPerimeterSplinters(
          wall,
          studSplinters,
          unitDir,
          localDz >= 0 ? 1 : -1,
          currentEnergyJ,
        );
      }

      let energyLossJ: number;
      if (hitStud) {
        effectiveMaterial = 'WOOD_STUD';
        // ~650 J resistance when clipping a WOOD_STUD (stops buckshot & low-energy/JHP rounds,
        // while high-velocity rifle & AP rounds punch cleanly through!).
        const baseStudJ = alreadyOpenHole
          ? seg.isArmorPiercing
            ? 525
            : 615
          : seg.isArmorPiercing
            ? 595
            : 685;
        energyLossJ = baseStudJ * obliquity;
      } else {
        effectiveMaterial = 'WOOD_DRYWALL';
        // ~140-240 J loss through drywall/plywood sheathing
        const basePanelJ = seg.isArmorPiercing ? 155 : 195;
        energyLossJ = basePanelJ * thicknessRatio * obliquity;
      }

      if (currentEnergyJ <= energyLossJ || currentEnergyJ <= 1e-4) {
        currentEnergyJ = 0;
        currentSpeedMs = 0;
        stopped = true;
        break;
      }

      const nextEnergyJ = currentEnergyJ - energyLossJ;
      if (seg.kineticEnergyJ > 1e-6) {
        currentSpeedMs =
          seg.speedMs * Math.sqrt(Math.max(0, nextEnergyJ / seg.kineticEnergyJ));
      }
      currentEnergyJ = nextEnergyJ;
    }

    return {
      remainingEnergyJ: currentEnergyJ,
      remainingSpeedMs: currentSpeedMs,
      stopped,
      impactPointWorld: firstImpactPoint,
      impactNormalWorld: firstImpactNormal,
      hitMaterial: effectiveMaterial,
    };
  }

  /**
   * Punches large ragged shockwave breach holes in nearby wood panels within `blast.radiusM`
   * and blasts out 25+ hardware-instanced wood splinters radially away from the detonation!
   */
  public applyBlast(blast: BlastEvent): void {
    if (
      this.destroyed ||
      blast.radiusM <= 0 ||
      blast.peakEnergyJ <= 0 ||
      this.walls.length === 0
    ) {
      return;
    }

    for (let i = 0; i < this.walls.length; i++) {
      const wall = this.walls[i];

      const rx = blast.centerWorld.x - wall.centerWorld.x;
      const ry = blast.centerWorld.y - wall.centerWorld.y;
      const rz = blast.centerWorld.z - wall.centerWorld.z;

      const localX = rx * wall.cosYaw - rz * wall.sinYaw;
      const localY = ry;
      const localZ = rx * wall.sinYaw + rz * wall.cosYaw;

      const halfW = wall.widthM * 0.5;
      const halfH = wall.heightM * 0.5;

      const clampedX = Math.max(-halfW, Math.min(halfW, localX));
      const clampedY = Math.max(-halfH, Math.min(halfH, localY));

      const dx = localX - clampedX;
      const dy = localY - clampedY;
      const dz = localZ;
      const distToPanel = Math.hypot(dx, dy, dz);

      if (distToPanel > blast.radiusM) {
        continue;
      }

      const proximity = Math.max(0, 1 - distToPanel / blast.radiusM);
      const energyScale = Math.min(
        2.0,
        Math.max(0.55, Math.sqrt(blast.peakEnergyJ / 6000)),
      );
      const breachRadiusM = Math.max(
        0.24,
        Math.min(
          Math.max(wall.widthM, wall.heightM) * 0.65,
          (0.28 + 0.52 * proximity) * energyScale,
        ),
      );

      const hitU = clampedX + halfW;
      const hitV = clampedY + halfH;

      const stamp = createJaggedHoleStamp({
        u: hitU,
        v: hitV,
        caliberRadiusM: 0.04,
        kineticEnergyJ: blast.peakEnergyJ,
        profile: 'BLAST_BREACH',
        seed: wall.panelState.shotCount + 101,
        overrideRadiusM: breachRadiusM,
      });

      const subRes = stampHoleInWoodPanel(
        wall.panelState,
        stamp,
        wall.scratchBuffers,
        6,
      );

      if (subRes.cutAnyWood) {
        this.uploadWallPanelMesh(wall, subRes.meshStats);
      }

      // Always blast out 28-34 instanced wood splinters when a wall is caught in the blast wave
      // (even if partially pre-damaged, as remaining framing & rim splinters shatter outward)
      const awaySignZ = localZ >= 0 ? -1 : 1;
      const blastSplinterCount = 30;
      this.spawnBlastSplinterShower(
        wall,
        hitU,
        hitV,
        Math.min(breachRadiusM, 0.45),
        blast.centerWorld,
        awaySignZ,
        blastSplinterCount,
        proximity,
      );
    }
  }

  public reset(): void {
    if (this.destroyed) {
      return;
    }
    for (let i = 0; i < this.walls.length; i++) {
      const wall = this.walls[i];
      resetWoodPanelState(wall.panelState);
      const stats = triangulateWoodPanelToBuffers(
        wall.panelState,
        wall.scratchBuffers,
      );
      this.uploadWallPanelMesh(wall, stats);
    }
    for (let i = 0; i < this.splinterPools.length; i++) {
      this.splinterPools[i].clear();
    }
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    for (let i = 0; i < this.walls.length; i++) {
      const wall = this.walls[i];
      this.physicsWorld.removeCollider(wall.drywallColliderHandle);
      for (let s = 0; s < wall.studColliderHandles.length; s++) {
        this.physicsWorld.removeCollider(wall.studColliderHandles[s]);
      }
      wall.rootEntity.destroy();
      wall.panelMesh.destroy();
      wall.studFrameMesh.destroy();
    }
    this.walls.length = 0;
    this.wallsById.clear();

    for (let i = 0; i < this.splinterPools.length; i++) {
      this.splinterPools[i].destroy();
    }

    for (let i = 0; i < this.ownedSplinterMeshes.length; i++) {
      this.ownedSplinterMeshes[i].destroy();
    }
    this.ownedSplinterMeshes.length = 0;

    for (let i = 0; i < this.ownedMaterials.length; i++) {
      this.ownedMaterials[i].destroy();
    }
    this.ownedMaterials.length = 0;

    for (let i = 0; i < this.ownedTextures.length; i++) {
      this.ownedTextures[i].destroy();
    }
    this.ownedTextures.length = 0;
  }

  /**
   * Computes remaining intact wood surface area (`m^2`) for telemetry/inspection.
   */
  public getWallRemainingAreaM2(wallId: string): number {
    const wall = this.wallsById.get(wallId);
    if (!wall) {
      return 0;
    }
    return computePanelRemainingAreaM2(wall.panelState);
  }

  private uploadWallPanelMesh(
    wall: WoodWallInstance,
    stats: WoodMeshBuildStats,
  ): void {
    wall.lastMeshStats = stats;

    if (stats.vertexCount <= 0 || stats.indexCount <= 0) {
      wall.panelEntity.enabled = false;
      return;
    }

    wall.panelEntity.enabled = true;
    const mesh = wall.panelMesh;
    const buf = wall.scratchBuffers;

    // Updates pre-allocated BUFFER_DYNAMIC streams in-place (zero GPU buffer reallocations!)
    mesh.setPositions(buf.positions, 3, stats.vertexCount);
    mesh.setNormals(buf.normals, 3, stats.vertexCount);
    mesh.setUvs(0, buf.uvs, 2, stats.vertexCount);
    mesh.setIndices(buf.indices, stats.indexCount);
    mesh.update(pc.PRIMITIVE_TRIANGLES, true);
  }

  private isPointOverStud(
    wall: WoodWallInstance,
    u: number,
    v: number,
  ): boolean {
    if (u < 0 || u > wall.widthM || v < 0 || v > wall.heightM) {
      return false;
    }
    const halfStudW = DEFAULT_WOOD_STUD_WIDTH_M * 0.5;
    const plateH = Math.min(DEFAULT_WOOD_STUD_WIDTH_M, wall.heightM * 0.2);
    if (v <= plateH || v >= wall.heightM - plateH) {
      return true;
    }
    for (let i = 0; i < wall.studPositionsU.length; i++) {
      if (Math.abs(u - wall.studPositionsU[i]) <= halfStudW) {
        return true;
      }
    }
    return false;
  }

  private nextRand(): number {
    let z = (this.splinterRngState =
      (this.splinterRngState + 0x6d2b79f5) >>> 0);
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  private spawnPerimeterSplinters(
    wall: WoodWallInstance,
    descriptors: readonly SplinterSpawnDescriptor[],
    bulletDirWorld: Vec3Like,
    exitFaceSignZ: number,
    kineticEnergyJ: number,
  ): void {
    if (descriptors.length === 0 || this.splinterPools.length === 0) {
      return;
    }

    const halfW = wall.widthM * 0.5;
    const halfH = wall.heightM * 0.5;
    const exitZ = exitFaceSignZ * (wall.thicknessM * 0.5 + 0.012);
    const speedFactor = Math.min(
      2.0,
      Math.max(0.65, Math.sqrt(Math.max(80, kineticEnergyJ) / 900)),
    );

    for (let i = 0; i < descriptors.length; i++) {
      const desc = descriptors[i];
      const lx = desc.u - halfW;
      const ly = desc.v - halfH;
      // Spawn most splinters on the exit blowout cone, plus 1 back-spall chip on entry face
      const lz = i === descriptors.length - 1 ? -exitZ : exitZ;

      this.scratchPos.x =
        wall.centerWorld.x + lx * wall.cosYaw + lz * wall.sinYaw;
      this.scratchPos.y = wall.centerWorld.y + ly;
      this.scratchPos.z =
        wall.centerWorld.z - lx * wall.sinYaw + lz * wall.cosYaw;

      // World-space hole perimeter tangent ("Hiding the Clean Cut")
      const tanWx = desc.tangentU * wall.cosYaw;
      const tanWy = desc.tangentV;
      const tanWz = -desc.tangentU * wall.sinYaw;
      quatAlignUnitXToVector(tanWx, tanWy, tanWz, this.scratchQuat);

      // Outward radial direction in world space
      const radWx = desc.radialU * wall.cosYaw;
      const radWy = desc.radialV;
      const radWz = -desc.radialU * wall.sinYaw;

      const forwardBurst =
        (i === descriptors.length - 1 ? -2.2 : 4.8 + this.nextRand() * 4.5) *
        speedFactor;
      const radialBurst = (1.6 + this.nextRand() * 2.8) * speedFactor;

      this.scratchVel.x =
        bulletDirWorld.x * forwardBurst +
        radWx * radialBurst +
        (this.nextRand() - 0.5) * 1.2;
      this.scratchVel.y =
        bulletDirWorld.y * forwardBurst +
        radWy * radialBurst +
        0.85 +
        this.nextRand() * 1.6;
      this.scratchVel.z =
        bulletDirWorld.z * forwardBurst +
        radWz * radialBurst +
        (this.nextRand() - 0.5) * 1.2;

      this.scratchAngVel.x = (this.nextRand() - 0.5) * 26;
      this.scratchAngVel.y = (this.nextRand() - 0.5) * 26;
      this.scratchAngVel.z = (this.nextRand() - 0.5) * 26;

      const lenScale = Math.max(0.055, Math.min(0.2, desc.lengthM));
      const thickScale = 0.012 + this.nextRand() * 0.014;
      this.scratchScale.x = lenScale;
      this.scratchScale.y = thickScale;
      this.scratchScale.z = thickScale * (0.75 + this.nextRand() * 0.5);

      const pool = this.splinterPools[i % this.splinterPools.length];
      pool.spawnKinematicParticle(
        this.scratchPos,
        this.scratchVel,
        this.scratchAngVel,
        this.scratchScale,
        -9.81,
        0.28,
        2.2 + this.nextRand() * 1.1,
        this.scratchQuat,
      );
    }
  }

  private spawnBlastSplinterShower(
    wall: WoodWallInstance,
    centerU: number,
    centerV: number,
    breachRadiusM: number,
    blastCenterWorld: Vec3Like,
    awaySignZ: number,
    count: number,
    proximity: number,
  ): void {
    if (this.splinterPools.length === 0) {
      return;
    }

    const halfW = wall.widthM * 0.5;
    const halfH = wall.heightM * 0.5;
    const launchBoost = 6.5 + 8.5 * proximity;

    for (let i = 0; i < count; i++) {
      const theta =
        (i / count) * Math.PI * 2 + (this.nextRand() - 0.5) * 0.25;
      const r = breachRadiusM * (0.35 + 0.65 * Math.sqrt(this.nextRand()));
      const su = Math.max(
        0.02,
        Math.min(wall.widthM - 0.02, centerU + Math.cos(theta) * r),
      );
      const sv = Math.max(
        0.02,
        Math.min(wall.heightM - 0.02, centerV + Math.sin(theta) * r),
      );

      const lx = su - halfW;
      const ly = sv - halfH;
      const lz = awaySignZ * (wall.thicknessM * 0.5 + 0.02);

      const wx = wall.centerWorld.x + lx * wall.cosYaw + lz * wall.sinYaw;
      const wy = wall.centerWorld.y + ly;
      const wz = wall.centerWorld.z - lx * wall.sinYaw + lz * wall.cosYaw;

      this.scratchPos.x = wx;
      this.scratchPos.y = wy;
      this.scratchPos.z = wz;

      // Tangent orientation around blast breach perimeter
      const tanU = -Math.sin(theta);
      const tanV = Math.cos(theta);
      quatAlignUnitXToVector(
        tanU * wall.cosYaw,
        tanV,
        -tanU * wall.sinYaw,
        this.scratchQuat,
      );

      let dx = wx - blastCenterWorld.x;
      let dy = wy - blastCenterWorld.y;
      let dz = wz - blastCenterWorld.z;
      const dLen = Math.hypot(dx, dy, dz);
      if (dLen > 1e-4) {
        dx /= dLen;
        dy /= dLen;
        dz /= dLen;
      } else {
        dx = awaySignZ * wall.sinYaw;
        dy = 0.35;
        dz = awaySignZ * wall.cosYaw;
      }

      const speed = launchBoost * (0.65 + 0.7 * this.nextRand());
      this.scratchVel.x = dx * speed + (this.nextRand() - 0.5) * 2.5;
      this.scratchVel.y =
        Math.max(-1.5, dy * speed) + 1.8 + this.nextRand() * 2.8;
      this.scratchVel.z = dz * speed + (this.nextRand() - 0.5) * 2.5;

      this.scratchAngVel.x = (this.nextRand() - 0.5) * 32;
      this.scratchAngVel.y = (this.nextRand() - 0.5) * 32;
      this.scratchAngVel.z = (this.nextRand() - 0.5) * 32;

      this.scratchScale.x = 0.09 + this.nextRand() * 0.16;
      this.scratchScale.y = 0.016 + this.nextRand() * 0.022;
      this.scratchScale.z = 0.014 + this.nextRand() * 0.02;

      const pool = this.splinterPools[i % this.splinterPools.length];
      pool.spawnKinematicParticle(
        this.scratchPos,
        this.scratchVel,
        this.scratchAngVel,
        this.scratchScale,
        -9.81,
        0.3,
        2.6 + this.nextRand() * 1.4,
        this.scratchQuat,
      );
    }
  }
}
