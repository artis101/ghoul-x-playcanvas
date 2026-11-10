import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  ChunkConnectivityGraphJson,
  ColliderSurfaceTag,
  IDestructibleSubsystem,
  QuatLike,
} from '../../contracts/destruction.ts';
import {
  createRuntimeConnectivityGraph,
  findDetachedChunkIndices,
  generateRunningBondBrickGraph,
  localToWorldPoint,
  rotateVec3ByQuat,
  severEdgesAtPoint,
  severEdgesFromBlast,
  worldToLocalPoint,
  type RuntimeConnectivityGraph,
  type WallTransformLike,
} from '../../core/destruction/connectivityGraph.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

export const BRICK_HEAVY_PENETRATOR_THRESHOLD_J = 1400;

export interface BrickWallConfig {
  wallId: string;
  position: Vec3Like;
  rotation?: QuatLike;
  cols?: number;
  rows?: number;
  brickW?: number;
  brickH?: number;
  brickD?: number;
  mortarBreakJ?: number;
  mortarGapM?: number;
  /** Optional pre-authored connectivity graph (e.g. exported from Blender). */
  connectivityGraph?: ChunkConnectivityGraphJson;
  /** Optional TTL in seconds for dislodged dynamic bricks (0 = persist indefinitely). */
  dynamicDebrisTtlS?: number;
}

export interface BrickWallInstanceState {
  readonly wallId: string;
  readonly transform: WallTransformLike;
  readonly initialGraphSnapshot: ChunkConnectivityGraphJson;
  graph: RuntimeConnectivityGraph;
  readonly brickW: number;
  readonly brickH: number;
  readonly brickD: number;
  readonly dynamicDebrisTtlS: number;
  readonly variantByBrick: Uint8Array;
  readonly poolSlotByBrick: Int32Array;
  readonly staticColliderHandles: Int32Array;
  readonly dynamicBodyHandles: Int32Array;
  intactBrickCount: number;
  detachedBrickCount: number;
}

export interface BrickWallSystemOptions {
  id?: string;
  maxBricksPerVariantPool?: number;
  maxMortarChips?: number;
  material?: pc.StandardMaterial;
  /** Optional external Blender `Brick_0..2` meshes. */
  variantMeshes?: readonly [pc.Mesh, pc.Mesh, pc.Mesh];
}

const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Generates a 24-vertex flat-normal chamfered/beveled unit brick `pc.Mesh` (`[-0.5, +0.5]^3`)
 * with subtle per-variant edge wear and UV jitter so all bricks render in 3 instanced draw calls.
 */
export function createBeveledBrickMeshVariant(
  device: pc.GraphicsDevice,
  variantIndex: number,
): pc.Mesh {
  const bevel = 0.055 + (variantIndex % 3) * 0.018;
  const skew = (variantIndex - 1) * 0.014;
  const uvShiftU = (variantIndex % 3) * 0.29;
  const uvShiftV = (variantIndex % 3) * 0.17;

  // 8 slightly chamfered corners of unit cube [-0.5, +0.5]^3
  const hx = 0.5;
  const hy = 0.5;
  const hz = 0.5;
  const bx = hx - bevel * 0.45;
  const by = hy - bevel * 0.7;
  const bz = hz - bevel * 0.55;

  // Build a 14-quad /chamfered-box style mesh via subdivided beveled faces (6 main faces + 4 horizontal chamfers)
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushQuad = (
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number],
  ): void => {
    const abx = p1[0] - p0[0];
    const aby = p1[1] - p0[1];
    const abz = p1[2] - p0[2];
    const acx = p2[0] - p0[0];
    const acy = p2[1] - p0[1];
    const acz = p2[2] - p0[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;

    const baseV = positions.length / 3;
    const verts = [p0, p1, p2, p3];
    const quadUvs: [number, number][] = [
      [0 + uvShiftU, 0 + uvShiftV],
      [1 + uvShiftU, 0 + uvShiftV],
      [1 + uvShiftU, 1 + uvShiftV],
      [0 + uvShiftU, 1 + uvShiftV],
    ];

    for (let i = 0; i < 4; i++) {
      positions.push(verts[i][0], verts[i][1], verts[i][2]);
      normals.push(nx, ny, nz);
      uvs.push(quadUvs[i][0], quadUvs[i][1]);
    }

    indices.push(baseV, baseV + 1, baseV + 2, baseV, baseV + 2, baseV + 3);
  };

  // Front (+Z) inset face
  pushQuad([-bx + skew, -by, hz], [bx, -by, hz], [bx - skew, by, hz], [-bx, by, hz]);
  // Back (-Z) inset face
  pushQuad([bx, -by, -hz], [-bx - skew, -by, -hz], [-bx, by, -hz], [bx + skew, by, -hz]);
  // Top (+Y) inset face
  pushQuad([-bx, hy, bz], [bx, hy, bz], [bx, hy, -bz], [-bx, hy, -bz]);
  // Bottom (-Y) inset face
  pushQuad([-bx, -hy, -bz], [bx, -hy, -bz], [bx, -hy, bz], [-bx, -hy, bz]);
  // Right (+X) full cap
  pushQuad([hx, -by, bz], [hx, -by, -bz], [hx, by, -bz], [hx, by, bz]);
  // Left (-X) full cap
  pushQuad([-hx, -by, -bz], [-hx, -by, bz], [-hx, by, bz], [-hx, by, -bz]);

  // 4 top/bottom Z-chamfer bevel strips for specular edge catchlights
  pushQuad([-bx, by, hz], [bx - skew, by, hz], [bx, hy, bz], [-bx, hy, bz]);
  pushQuad([bx + skew, by, -hz], [-bx, by, -hz], [-bx, hy, -bz], [bx, hy, -bz]);
  pushQuad([-bx, -hy, bz], [bx, -hy, bz], [bx, -by, hz], [-bx + skew, -by, hz]);
  pushQuad([bx, -hy, -bz], [-bx, -hy, -bz], [-bx - skew, -by, -hz], [bx, -by, -hz]);

  // 4 side X-chamfer bevel strips
  pushQuad([bx, -by, hz], [hx, -by, bz], [hx, by, bz], [bx - skew, by, hz]);
  pushQuad([hx, -by, -bz], [bx, -by, -hz], [bx + skew, by, -hz], [hx, by, -bz]);
  pushQuad([-hx, -by, bz], [-bx + skew, -by, hz], [-bx, by, hz], [-hx, by, bz]);
  pushQuad([-bx - skew, -by, -hz], [-hx, -by, -bz], [-hx, by, -bz], [-bx, by, -hz]);

  const mesh = new pc.Mesh(device);
  mesh.setPositions(new Float32Array(positions));
  mesh.setNormals(new Float32Array(normals));
  mesh.setUvs(0, new Float32Array(uvs));
  mesh.setIndices(new Uint16Array(indices));
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

function createProceduralBrickMaterial(device: pc.GraphicsDevice): {
  material: pc.StandardMaterial;
  diffuseTexture: pc.Texture;
} {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = (Math.imul(x + 11, 374761393) + Math.imul(y + 23, 668265263)) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      const noise = ((h ^ (h >>> 16)) >>> 0) / 4294967295;

      const edgeDist = Math.min(x, y, size - 1 - x, size - 1 - y) / 6;
      const mortarRim = Math.max(0, 1 - Math.min(1, edgeDist));

      // Terracotta clay base blended with pale lime-mortar dust at edges
      const r = Math.round((158 + (noise - 0.5) * 34) * (1 - mortarRim * 0.35) + mortarRim * 62);
      const g = Math.round((72 + (noise - 0.5) * 22) * (1 - mortarRim * 0.35) + mortarRim * 58);
      const b = Math.round((54 + (noise - 0.5) * 18) * (1 - mortarRim * 0.35) + mortarRim * 54);

      const p4 = (y * size + x) * 4;
      pixels[p4] = Math.max(0, Math.min(255, r));
      pixels[p4 + 1] = Math.max(0, Math.min(255, g));
      pixels[p4 + 2] = Math.max(0, Math.min(255, b));
      pixels[p4 + 3] = 255;
    }
  }

  const tex = new pc.Texture(device, {
    name: 'TerracottaBrickAlbedo',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  tex.lock().set(pixels);
  tex.unlock();

  const material = new pc.StandardMaterial();
  material.name = 'InstancedClayBrickMaterial';
  material.diffuse = new pc.Color(0.95, 0.92, 0.9);
  material.diffuseMap = tex;
  material.gloss = 0.24;
  material.update();

  return { material, diffuseTexture: tex };
}

/**
 * Hardware-instanced Masonry Brick Wall Destruction Subsystem (`IDestructibleSubsystem`).
 *
 * Renders all intact and dynamically collapsing bricks across the entire arena in **3 hardware-instanced
 * draw calls** (`HardwareInstancedPool` variants `0..2`), backed by Rapier static box colliders while
 * intact and on-demand Rapier dynamic rigid bodies triggered via Connectivity BFS (`findDetachedChunkIndices`).
 */
export class BrickWallSystem implements IDestructibleSubsystem {
  public readonly id: string;
  public readonly app: pc.Application;
  public readonly rapierWorld: RapierPhysicsWorld;
  public readonly variantPools: readonly [
    HardwareInstancedPool,
    HardwareInstancedPool,
    HardwareInstancedPool,
  ];
  public readonly mortarChipPool: HardwareInstancedPool;
  public readonly brickMaterial: pc.StandardMaterial;

  private readonly variantMeshes: readonly [pc.Mesh, pc.Mesh, pc.Mesh];
  private readonly variantNormScales: readonly [Vec3Like, Vec3Like, Vec3Like];
  private readonly chipMesh: pc.Mesh;
  private readonly chipMaterial: pc.StandardMaterial;
  private readonly ownedDiffuseTexture: pc.Texture | null;
  private readonly ownsVariantMeshes: boolean;
  private readonly ownsMaterial: boolean;

  private readonly wallsById = new Map<string, BrickWallInstanceState>();
  private rngState = 0x517cc1b7;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    rapierWorld: RapierPhysicsWorld,
    options: BrickWallSystemOptions = {},
  ) {
    this.id = options.id ?? 'brick-wall-system';
    this.app = app;
    this.rapierWorld = rapierWorld;

    const device = app.graphicsDevice;
    const maxBricksPerVariant = Math.max(64, options.maxBricksPerVariantPool ?? 1024);

    if (options.variantMeshes) {
      this.variantMeshes = options.variantMeshes;
      this.ownsVariantMeshes = false;
    } else {
      this.variantMeshes = [
        createBeveledBrickMeshVariant(device, 0),
        createBeveledBrickMeshVariant(device, 1),
        createBeveledBrickMeshVariant(device, 2),
      ];
      this.ownsVariantMeshes = true;
    }

    // Normalize against each variant mesh's local AABB so brickW/H/D scale exact physical meters
    this.variantNormScales = [0, 1, 2].map((i) => {
      const he = this.variantMeshes[i].aabb.halfExtents;
      return {
        x: he.x > 1e-4 ? 1 / (he.x * 2) : 1,
        y: he.y > 1e-4 ? 1 / (he.y * 2) : 1,
        z: he.z > 1e-4 ? 1 / (he.z * 2) : 1,
      };
    }) as unknown as [Vec3Like, Vec3Like, Vec3Like];

    if (options.material) {
      this.brickMaterial = options.material;
      this.ownedDiffuseTexture = null;
      this.ownsMaterial = false;
    } else {
      const created = createProceduralBrickMaterial(device);
      this.brickMaterial = created.material;
      this.ownedDiffuseTexture = created.diffuseTexture;
      this.ownsMaterial = true;
    }

    this.variantPools = [
      new HardwareInstancedPool(
        app,
        this.variantMeshes[0],
        this.brickMaterial,
        maxBricksPerVariant,
        'BrickVariantPool_0',
        true,
      ),
      new HardwareInstancedPool(
        app,
        this.variantMeshes[1],
        this.brickMaterial,
        maxBricksPerVariant,
        'BrickVariantPool_1',
        true,
      ),
      new HardwareInstancedPool(
        app,
        this.variantMeshes[2],
        this.brickMaterial,
        maxBricksPerVariant,
        'BrickVariantPool_2',
        true,
      ),
    ];

    this.chipMesh = createBeveledBrickMeshVariant(device, 0);
    this.chipMaterial = new pc.StandardMaterial();
    this.chipMaterial.name = 'MortarBrickChipMaterial';
    this.chipMaterial.diffuse = new pc.Color(0.68, 0.44, 0.36);
    this.chipMaterial.gloss = 0.16;
    this.chipMaterial.update();

    this.mortarChipPool = new HardwareInstancedPool(
      app,
      this.chipMesh,
      this.chipMaterial,
      Math.max(64, options.maxMortarChips ?? 384),
      'MortarBrickChipPool',
      false,
    );
  }

  public get wallCount(): number {
    return this.wallsById.size;
  }

  public get totalDrawCallPoolCount(): number {
    return this.variantPools.length;
  }

  public getWall(wallId: string): BrickWallInstanceState | undefined {
    return this.wallsById.get(wallId);
  }

  public addBrickWall(config: BrickWallConfig): BrickWallInstanceState {
    if (this.destroyed) {
      throw new Error('Cannot add brick wall to destroyed BrickWallSystem.');
    }
    if (this.wallsById.has(config.wallId)) {
      this.removeBrickWall(config.wallId);
    }

    const brickW = config.brickW ?? 0.215;
    const brickH = config.brickH ?? 0.065;
    const brickD = config.brickD ?? 0.1025;
    const cols = config.cols ?? 12;
    const rows = config.rows ?? 18;
    const mortarBreakJ = config.mortarBreakJ ?? 650;
    const mortarGapM = config.mortarGapM ?? 0.008;

    const baseJson =
      config.connectivityGraph ??
      generateRunningBondBrickGraph(
        config.wallId,
        cols,
        rows,
        brickW,
        brickH,
        brickD,
        mortarBreakJ,
        mortarGapM,
      );

    const runtimeGraph = createRuntimeConnectivityGraph(baseJson);
    const n = runtimeGraph.nodes.length;
    const transform: WallTransformLike = {
      position: { ...config.position },
      rotation: config.rotation ? { ...config.rotation } : { ...IDENTITY_QUAT },
    };

    const state: BrickWallInstanceState = {
      wallId: config.wallId,
      transform,
      initialGraphSnapshot: baseJson,
      graph: runtimeGraph,
      brickW,
      brickH,
      brickD,
      dynamicDebrisTtlS: config.dynamicDebrisTtlS ?? 0,
      variantByBrick: new Uint8Array(n),
      poolSlotByBrick: new Int32Array(n).fill(-1),
      staticColliderHandles: new Int32Array(n).fill(-1),
      dynamicBodyHandles: new Int32Array(n).fill(-1),
      intactBrickCount: 0,
      detachedBrickCount: 0,
    };

    this.populateIntactWallState(state);
    this.wallsById.set(config.wallId, state);
    return state;
  }

  public removeBrickWall(wallId: string): void {
    const wall = this.wallsById.get(wallId);
    if (!wall) {
      return;
    }
    this.releaseWallResources(wall);
    this.wallsById.delete(wallId);
  }

  public handleRaySegment(seg: BallisticSegmentImpact): BallisticPenetrationResult | null {
    if (this.destroyed || this.wallsById.size === 0) {
      return null;
    }

    const hits = this.rapierWorld.castPenetrationRay(
      seg.originWorld,
      seg.directionWorld,
      seg.maxDistanceM,
    );

    let matchedHit: (typeof hits)[number] | null = null;
    let matchedWall: BrickWallInstanceState | undefined;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.surface.material === 'BRICK_MASONRY') {
        const w = this.wallsById.get(h.surface.objectId);
        if (w) {
          matchedHit = h;
          matchedWall = w;
          break;
        }
      }
    }

    if (!matchedHit || !matchedWall) {
      return null;
    }

    this.spawnMortarChips(
      matchedHit.pointWorld,
      matchedHit.normalWorld,
      seg.kineticEnergyJ > BRICK_HEAVY_PENETRATOR_THRESHOLD_J ? 9 : 5,
      seg.kineticEnergyJ > BRICK_HEAVY_PENETRATOR_THRESHOLD_J ? 1.25 : 0.75,
    );

    // Heavy penetrator / slug (> 1,400 J) fractures mortar joints and runs BFS detachment!
    if (seg.kineticEnergyJ > BRICK_HEAVY_PENETRATOR_THRESHOLD_J) {
      const localImpact = worldToLocalPoint(matchedHit.pointWorld, matchedWall.transform);
      const severRadius = Math.max(matchedWall.brickW * 0.85, matchedWall.brickH * 1.75);

      severEdgesAtPoint(
        matchedWall.graph,
        localImpact,
        seg.kineticEnergyJ * 1.45,
        severRadius,
      );

      const newlyDetached = findDetachedChunkIndices(matchedWall.graph);
      const dirNorm = this.normalizeDir(seg.directionWorld);
      const hitChunkIdx = matchedHit.surface.chunkIndex ?? -1;

      for (let i = 0; i < newlyDetached.length; i++) {
        const brickIdx = newlyDetached[i];
        const isPrimaryHit = brickIdx === hitChunkIdx;
        const speedKick = isPrimaryHit
          ? Math.min(9.5, 2.2 + (seg.kineticEnergyJ - BRICK_HEAVY_PENETRATOR_THRESHOLD_J) * 0.0022)
          : 0.45;

        const linVel: Vec3Like = isPrimaryHit
          ? {
              x: dirNorm.x * speedKick + (this.nextRandom() - 0.5) * 1.2,
              y: dirNorm.y * speedKick + 1.15 + this.nextRandom() * 0.7,
              z: dirNorm.z * speedKick + (this.nextRandom() - 0.5) * 1.2,
            }
          : {
              x: dirNorm.x * speedKick + (this.nextRandom() - 0.5) * 0.35,
              y: -0.15,
              z: dirNorm.z * speedKick + (this.nextRandom() - 0.5) * 0.35,
            };

        const angVel: Vec3Like = isPrimaryHit
          ? {
              x: (this.nextRandom() - 0.5) * 11,
              y: (this.nextRandom() - 0.5) * 11,
              z: (this.nextRandom() - 0.5) * 11,
            }
          : {
              x: (this.nextRandom() - 0.5) * 2.2,
              y: (this.nextRandom() - 0.5) * 2.2,
              z: (this.nextRandom() - 0.5) * 2.2,
            };

        this.convertBrickToDynamicBody(matchedWall, brickIdx, linVel, angVel);
      }

      this.uploadAllVariantPools();

      const remainingEnergyJ = Math.max(
        0,
        seg.kineticEnergyJ - BRICK_HEAVY_PENETRATOR_THRESHOLD_J,
      );
      const energyRatio =
        seg.kineticEnergyJ > 1e-6 ? remainingEnergyJ / seg.kineticEnergyJ : 0;
      const remainingSpeedMs = seg.speedMs * Math.sqrt(Math.max(0, energyRatio));
      const stopped = remainingEnergyJ <= 25;

      return {
        remainingEnergyJ: stopped ? 0 : remainingEnergyJ,
        remainingSpeedMs: stopped ? 0 : remainingSpeedMs,
        stopped,
        impactPointWorld: matchedHit.pointWorld,
        impactNormalWorld: matchedHit.normalWorld,
        hitMaterial: 'BRICK_MASONRY',
      };
    }

    // Sub-threshold pistol/SMG hit stops cleanly in clay masonry
    return {
      remainingEnergyJ: 0,
      remainingSpeedMs: 0,
      stopped: true,
      impactPointWorld: matchedHit.pointWorld,
      impactNormalWorld: matchedHit.normalWorld,
      hitMaterial: 'BRICK_MASONRY',
    };
  }

  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed || blast.radiusM <= 0 || blast.peakEnergyJ <= 0) {
      return;
    }

    let anyBrickDetached = false;

    for (const wall of this.wallsById.values()) {
      const severedCount = severEdgesFromBlast(wall.graph, wall.transform, blast);
      if (severedCount <= 0) {
        // Still check in case foundation anchors were blown out inside blast radius
      }

      const newlyDetached = findDetachedChunkIndices(wall.graph);
      if (newlyDetached.length === 0) {
        continue;
      }

      anyBrickDetached = true;
      for (let i = 0; i < newlyDetached.length; i++) {
        const brickIdx = newlyDetached[i];
        const node = wall.graph.nodes[brickIdx];
        const worldPos = localToWorldPoint(node.localCenter, wall.transform);

        const dx = worldPos.x - blast.centerWorld.x;
        const dy = worldPos.y - blast.centerWorld.y;
        const dz = worldPos.z - blast.centerWorld.z;
        const dist = Math.hypot(dx, dy, dz);

        let linVel: Vec3Like;
        let angVel: Vec3Like;

        if (dist <= blast.radiusM * 1.15) {
          const falloff = Math.max(0.08, 1 - dist / (blast.radiusM * 1.15));
          const speed = Math.min(
            18,
            (blast.peakImpulseNs / Math.max(0.4, node.massKg)) * falloff,
          );
          const invD = dist > 1e-4 ? 1 / dist : 0;
          const rx = dist > 1e-4 ? dx * invD : 0;
          const ry = dist > 1e-4 ? dy * invD : 1;
          const rz = dist > 1e-4 ? dz * invD : 0;

          linVel = {
            x: rx * speed,
            y: Math.max(0.8, (ry + 0.45) * speed * 0.85),
            z: rz * speed,
          };
          angVel = {
            x: (-rz + (this.nextRandom() - 0.5)) * speed * 0.85,
            y: (this.nextRandom() - 0.5) * speed * 0.9,
            z: (rx + (this.nextRandom() - 0.5)) * speed * 0.85,
          };
        } else {
          // Upper floating arch brick outside direct blast sphere collapses under gravity!
          linVel = {
            x: (this.nextRandom() - 0.5) * 0.4,
            y: -0.2,
            z: (this.nextRandom() - 0.5) * 0.4,
          };
          angVel = {
            x: (this.nextRandom() - 0.5) * 1.6,
            y: (this.nextRandom() - 0.5) * 1.2,
            z: (this.nextRandom() - 0.5) * 1.6,
          };
        }

        this.convertBrickToDynamicBody(wall, brickIdx, linVel, angVel);
      }

      this.spawnMortarChips(
        blast.centerWorld,
        { x: 0, y: 1, z: 0 },
        Math.min(20, newlyDetached.length * 2),
        1.7,
      );
    }

    if (anyBrickDetached) {
      this.uploadAllVariantPools();
    }
  }

  public update(dt: number): void {
    if (this.destroyed) {
      return;
    }
    this.variantPools[0].syncFromPhysics(this.rapierWorld, dt);
    this.variantPools[1].syncFromPhysics(this.rapierWorld, dt);
    this.variantPools[2].syncFromPhysics(this.rapierWorld, dt);
    this.mortarChipPool.syncFromPhysics(this.rapierWorld, dt);
  }

  public reset(): void {
    if (this.destroyed) {
      return;
    }
    this.mortarChipPool.clear();
    for (const wall of this.wallsById.values()) {
      this.releaseWallResources(wall);
      wall.graph = createRuntimeConnectivityGraph(wall.initialGraphSnapshot);
      this.populateIntactWallState(wall);
    }
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const wall of this.wallsById.values()) {
      this.releaseWallResources(wall);
    }
    this.wallsById.clear();

    this.variantPools[0].destroy();
    this.variantPools[1].destroy();
    this.variantPools[2].destroy();
    this.mortarChipPool.destroy();

    this.chipMesh.destroy();
    this.chipMaterial.destroy();

    if (this.ownsVariantMeshes) {
      this.variantMeshes[0].destroy();
      this.variantMeshes[1].destroy();
      this.variantMeshes[2].destroy();
    }
    if (this.ownsMaterial) {
      this.brickMaterial.destroy();
    }
    if (this.ownedDiffuseTexture) {
      this.ownedDiffuseTexture.destroy();
    }
  }

  private populateIntactWallState(wall: BrickWallInstanceState): void {
    const nodes = wall.graph.nodes;
    const rot = wall.transform.rotation ?? IDENTITY_QUAT;
    wall.intactBrickCount = 0;
    wall.detachedBrickCount = 0;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const variant = (node.meshVariant ?? i) % 3;
      wall.variantByBrick[i] = variant;

      const he = node.halfExtents ?? {
        x: wall.brickW * 0.5,
        y: wall.brickH * 0.5,
        z: wall.brickD * 0.5,
      };
      const norm = this.variantNormScales[variant];
      const renderScale: Vec3Like = {
        x: he.x * 2 * norm.x,
        y: he.y * 2 * norm.y,
        z: he.z * 2 * norm.z,
      };

      const worldPos = localToWorldPoint(node.localCenter, wall.transform);
      const pool = this.variantPools[variant];
      const slotId = pool.allocSlot();
      wall.poolSlotByBrick[i] = slotId;

      if (slotId >= 0) {
        pool.setSlotTRS(slotId, worldPos, rot, renderScale);
      }

      const tag: ColliderSurfaceTag = {
        material: 'BRICK_MASONRY',
        objectId: wall.wallId,
        chunkIndex: i,
        thicknessM: he.z * 2,
        penetrationResistanceJ: BRICK_HEAVY_PENETRATOR_THRESHOLD_J,
      };

      const colHandle = this.rapierWorld.createStaticBox(worldPos, he, rot, tag);
      wall.staticColliderHandles[i] = colHandle;
      wall.dynamicBodyHandles[i] = -1;
      wall.intactBrickCount++;
    }

    this.uploadAllVariantPools();
  }

  private convertBrickToDynamicBody(
    wall: BrickWallInstanceState,
    brickIndex: number,
    linVel: Vec3Like,
    angVel: Vec3Like,
  ): void {
    const staticCol = wall.staticColliderHandles[brickIndex];
    if (staticCol >= 0) {
      this.rapierWorld.removeCollider(staticCol);
      wall.staticColliderHandles[brickIndex] = -1;
    }

    if (wall.dynamicBodyHandles[brickIndex] >= 0) {
      return;
    }

    const node = wall.graph.nodes[brickIndex];
    const he = node.halfExtents ?? {
      x: wall.brickW * 0.5,
      y: wall.brickH * 0.5,
      z: wall.brickD * 0.5,
    };
    const rot = wall.transform.rotation ?? IDENTITY_QUAT;
    const worldPos = localToWorldPoint(node.localCenter, wall.transform);

    const dynamicTag: ColliderSurfaceTag = {
      material: 'BRICK_MASONRY',
      objectId: wall.wallId,
      chunkIndex: brickIndex,
      thicknessM: he.z * 2,
      penetrationResistanceJ: BRICK_HEAVY_PENETRATOR_THRESHOLD_J,
    };

    // Slightly inset physics half-extents (96%) so adjacent detaching courses never bind
    const physicsHe: Vec3Like = {
      x: he.x * 0.96,
      y: he.y * 0.96,
      z: he.z * 0.96,
    };

    const { bodyHandle } = this.rapierWorld.spawnDynamicBox(
      worldPos,
      physicsHe,
      node.massKg,
      linVel,
      angVel,
      rot,
      dynamicTag,
    );

    wall.dynamicBodyHandles[brickIndex] = bodyHandle;
    wall.intactBrickCount = Math.max(0, wall.intactBrickCount - 1);
    wall.detachedBrickCount++;

    const variant = wall.variantByBrick[brickIndex];
    const slotId = wall.poolSlotByBrick[brickIndex];
    if (slotId >= 0) {
      const norm = this.variantNormScales[variant];
      const renderScale: Vec3Like = {
        x: he.x * 2 * norm.x,
        y: he.y * 2 * norm.y,
        z: he.z * 2 * norm.z,
      };
      this.variantPools[variant].bindSlotToRapierBody(
        slotId,
        bodyHandle,
        renderScale,
        wall.dynamicDebrisTtlS,
      );
    }
  }

  private releaseWallResources(wall: BrickWallInstanceState): void {
    const n = wall.graph.nodes.length;
    for (let i = 0; i < n; i++) {
      const staticCol = wall.staticColliderHandles[i];
      if (staticCol >= 0) {
        this.rapierWorld.removeCollider(staticCol);
        wall.staticColliderHandles[i] = -1;
      }

      const dynBody = wall.dynamicBodyHandles[i];
      if (dynBody >= 0) {
        this.rapierWorld.removeBody(dynBody);
        wall.dynamicBodyHandles[i] = -1;
      }

      const slotId = wall.poolSlotByBrick[i];
      if (slotId >= 0) {
        const variant = wall.variantByBrick[i];
        this.variantPools[variant].freeSlot(slotId);
        wall.poolSlotByBrick[i] = -1;
      }
    }

    wall.intactBrickCount = 0;
    wall.detachedBrickCount = 0;
    this.uploadAllVariantPools();
  }

  private uploadAllVariantPools(): void {
    this.variantPools[0].upload();
    this.variantPools[1].upload();
    this.variantPools[2].upload();
  }

  private spawnMortarChips(
    originWorld: Vec3Like,
    normalWorld: Vec3Like,
    count: number,
    speedScale: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const speed = (1.8 + this.nextRandom() * 4.4) * speedScale;
      const vx = (normalWorld.x + (this.nextRandom() - 0.5) * 1.4) * speed;
      const vy = (Math.abs(normalWorld.y) * 0.5 + 0.45 + this.nextRandom() * 0.7) * speed;
      const vz = (normalWorld.z + (this.nextRandom() - 0.5) * 1.4) * speed;
      const s = 0.016 + this.nextRandom() * 0.022;

      this.mortarChipPool.spawnKinematicParticle(
        {
          x: originWorld.x + normalWorld.x * 0.02,
          y: originWorld.y + normalWorld.y * 0.02,
          z: originWorld.z + normalWorld.z * 0.02,
        },
        { x: vx, y: vy, z: vz },
        {
          x: (this.nextRandom() - 0.5) * 18,
          y: (this.nextRandom() - 0.5) * 18,
          z: (this.nextRandom() - 0.5) * 18,
        },
        { x: s * 1.3, y: s * 0.7, z: s },
        -9.81,
        0.28,
        1.2 + this.nextRandom() * 0.8,
      );
    }
    this.mortarChipPool.upload();
  }

  private normalizeDir(dir: Vec3Like): Vec3Like {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len <= 1e-8) {
      return { x: 0, y: 0, z: -1 };
    }
    return { x: dir.x / len, y: dir.y / len, z: dir.z / len };
  }

  private nextRandom(): number {
    let x = this.rngState >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return (this.rngState >>> 0) / 4294967296;
  }

  // Re-export helper convenience for external callers transforming local brick coordinates
  public getBrickWorldCenter(wallId: string, brickIndex: number): Vec3Like | null {
    const wall = this.wallsById.get(wallId);
    if (!wall || brickIndex < 0 || brickIndex >= wall.graph.nodes.length) {
      return null;
    }
    const node = wall.graph.nodes[brickIndex];
    const rotated = rotateVec3ByQuat(
      node.localCenter,
      wall.transform.rotation ?? IDENTITY_QUAT,
    );
    return {
      x: wall.transform.position.x + rotated.x,
      y: wall.transform.position.y + rotated.y,
      z: wall.transform.position.z + rotated.z,
    };
  }
}
