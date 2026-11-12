import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag, QuatLike } from '../../../contracts/destruction.ts';
import { MarchingGlassPane, createDeterministicPrng } from '../../../core/destruction/glassMarchingTiles.ts';
import {
  ArmoredVoronoiGlassPane,
  GLASS_SHARD_STYLE_ARMORED,
  type GlassShardPool,
} from '../../../core/destruction/glassVoronoiShatter.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  DEFAULT_ARMORED_VORONOI_CELL_COUNT,
  INSTANCED_SHARDS_PER_MARCHING_HIT,
  INSTANCED_SHARD_TTL_S,
  MIN_GLASS_ENERGY_LOSS_J,
  MAX_GLASS_ENERGY_LOSS_J,
  type GlassWindowCreateOptions,
  hashStringSeed,
  inverseRotateVec3ByQuat,
  normalizeQuat,
  rotateVec3ByQuat,
} from './glassSystemTypes.ts';

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

    const maxVerts = Math.min(16384, this.armoredPane.totalChunks * 80);
    const maxIndices = this.armoredPane.totalChunks * 160;
    this.meshPositions = new Float32Array(maxVerts * 3);
    this.meshNormals = new Float32Array(maxVerts * 3);
    this.meshUvs = new Float32Array(maxVerts * 2);
    this.meshColors = new Float32Array(maxVerts * 4);
    this.meshIndices = new Uint16Array(maxIndices);

    this.entity = new pc.Entity(this.id);
    this.entity.setPosition(this.centerWorld.x, this.centerWorld.y, this.centerWorld.z);
    this.entity.setRotation(this.rotationQuat.x, this.rotationQuat.y, this.rotationQuat.z, this.rotationQuat.w);

    this.mesh = new pc.Mesh(app.graphicsDevice);
    this.mesh.clear(true, true, maxVerts, maxIndices);
    this.rebuildDynamicMesh();

    this.meshInstance = new pc.MeshInstance(this.mesh, material);
    this.meshInstance.castShadows = false;
    this.meshInstance.cull = false;

    this.entity.addComponent('render', {
      meshInstances: [this.meshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    if (this.entity.render) {
      const horizSpan = this.widthM * 0.5 + this.thicknessM + 0.2;
      this.entity.render.customAabb = new pc.BoundingBox(
        new pc.Vec3(0, 0, 0),
        new pc.Vec3(horizSpan, this.heightM * 0.5 + 0.2, horizSpan),
      );
    }
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
    if (x2d < 0 || x2d > this.widthM || y2d < 0 || y2d > this.heightM) return true;
    return this.armoredPane.isDetachedAt(x2d, y2d);
  }

  public isPlayerPassable(pointWorld?: Vec3Like): boolean {
    if (this.armoredPane.survivingChunkCount === 0) {
      return true;
    }
    if (pointWorld && !this.isBrokenAtWorldPoint(pointWorld)) {
      return false;
    }
    const total = Math.max(1, this.armoredPane.totalChunks);
    const detachedFraction = this.armoredPane.detachedChunkCount / total;
    return detachedFraction >= 0.55 && this.isBrokenAtWorldPoint(this.centerWorld);
  }

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
    const wasAlreadyCrazed = hitChunkIdx >= 0 && this.armoredPane.stage[hitChunkIdx] > 0;

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
      return { alreadyBroken: true, energyAbsorbedJ: 0, spawnedTriangles: 0, spawnedVoronoiChunks: 0 };
    }

    this.pane.syncFromUvSampler((su, sv) => this.armoredPane.sampleCellStateAtUv(su, sv));
    this.rebuildDynamicMesh();

    if (this.armoredPane.survivingChunkCount === 0 && this.colliderHandleValue >= 0) {
      this.physics.removeCollider(this.colliderHandleValue);
      this.colliderHandleValue = -1;
    }

    const spallCount = report.newlyDetachedIndices.length > 0 ? instancedCount : Math.max(6, Math.round(instancedCount * 0.7));
    const spawnedTriangles = this.emitInstancedTriangles(pointWorld, directionWorld, kineticEnergyJ, spallCount);

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

    return { alreadyBroken: false, energyAbsorbedJ, spawnedTriangles, spawnedVoronoiChunks };
  }

  public reset(): void {
    this.armoredPane.reset();
    this.pane.reset();
    this.hitSeedCounter = 0;
    this.rebuildDynamicMesh();
    if (this.colliderHandleValue < 0) this.createCollider();
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
    this.mesh.update(pc.PRIMITIVE_TRIANGLES, false);
  }

  private emitInstancedTriangles(
    originWorld: Vec3Like,
    directionWorld: Vec3Like,
    kineticEnergyJ: number,
    count: number,
  ): number {
    const rand = createDeterministicPrng((this.hitSeedCounter * 73856093) ^ Math.round(kineticEnergyJ * 17));
    const dirLen = Math.hypot(directionWorld.x, directionWorld.y, directionWorld.z);
    const dx = dirLen > 1e-6 ? directionWorld.x / dirLen : 0;
    const dy = dirLen > 1e-6 ? directionWorld.y / dirLen : 0;
    const dz = dirLen > 1e-6 ? directionWorld.z / dirLen : -1;
    const speedBase = Math.min(6.2, 1.6 + Math.sqrt(Math.max(20, kineticEnergyJ)) * 0.052);

    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const radialLocal: Vec3Like = { x: Math.cos(angle), y: Math.sin(angle), z: 0 };
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
      if (slot >= 0) spawned++;
    }

    return spawned;
  }
}
