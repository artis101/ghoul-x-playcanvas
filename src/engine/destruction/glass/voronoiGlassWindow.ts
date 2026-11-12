import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag, QuatLike } from '../../../contracts/destruction.ts';
import {
  DEFAULT_VORONOI_SHARD_THICKNESS_M,
  GLASS_SHARD_STYLE_CLEAR,
  type GlassShardPool,
  ProgressiveVoronoiPane,
  shatterWindowVoronoi2D,
} from '../../../core/destruction/glassVoronoiShatter.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  DEFAULT_REGULAR_VORONOI_PLATE_COUNT,
  type GlassWindowCreateOptions,
  MIN_GLASS_ENERGY_LOSS_J,
  MAX_GLASS_ENERGY_LOSS_J,
  inverseRotateVec3ByQuat,
  normalizeQuat,
} from './glassSystemTypes.ts';
import { createIntactWindowPanePrismMesh } from './glassShardMeshes.ts';

export type VoronoiPaneState =
  | { readonly kind: 'INTACT'; readonly colliderHandle: number }
  | {
      readonly kind: 'CLINGING_FANGS';
      readonly pane: ProgressiveVoronoiPane;
      readonly colliderHandle: number;
    }
  | { readonly kind: 'CLEARED' }
  | { readonly kind: 'DESTROYED' };

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

  private paneState: VoronoiPaneState = { kind: 'CLEARED' };
  private shatterCounter = 0;

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
    const horizSpan = this.widthM * 0.5 + this.thicknessM + 0.2;
    const localWindowAabb = new pc.BoundingBox(
      new pc.Vec3(0, 0, 0),
      new pc.Vec3(horizSpan, this.heightM * 0.5 + 0.2, horizSpan),
    );

    this.intactMeshInstance = new pc.MeshInstance(this.intactMesh, intactMaterial);
    this.intactMeshInstance.castShadows = false;
    this.intactMeshInstance.cull = false;

    this.intactEntity = new pc.Entity(this.id);
    this.intactEntity.setPosition(this.centerWorld.x, this.centerWorld.y, this.centerWorld.z);
    this.intactEntity.setRotation(this.rotationQuat.x, this.rotationQuat.y, this.rotationQuat.z, this.rotationQuat.w);
    this.intactEntity.addComponent('render', {
      meshInstances: [this.intactMeshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    if (this.intactEntity.render) {
      this.intactEntity.render.customAabb = localWindowAabb;
    }
    app.root.addChild(this.intactEntity);

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
    this.fangMeshInstance.cull = false;

    this.fangEntity = new pc.Entity(`${this.id}_fangs`);
    this.fangEntity.setPosition(this.centerWorld.x, this.centerWorld.y, this.centerWorld.z);
    this.fangEntity.setRotation(this.rotationQuat.x, this.rotationQuat.y, this.rotationQuat.z, this.rotationQuat.w);
    this.fangEntity.addComponent('render', {
      meshInstances: [this.fangMeshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    if (this.fangEntity.render) {
      this.fangEntity.render.customAabb = localWindowAabb;
    }
    this.fangEntity.enabled = false;
    app.root.addChild(this.fangEntity);

    this.paneState = { kind: 'INTACT', colliderHandle: this.createCollider() };
  }

  public get state(): VoronoiPaneState {
    return this.paneState;
  }

  public get colliderHandle(): number {
    return this.paneState.kind === 'INTACT' || this.paneState.kind === 'CLINGING_FANGS'
      ? this.paneState.colliderHandle
      : -1;
  }

  public get shattered(): boolean {
    return this.paneState.kind === 'CLINGING_FANGS' || this.paneState.kind === 'CLEARED';
  }

  public get survivingFangCount(): number {
    if (this.paneState.kind === 'INTACT') return this.voronoiShardCount;
    if (this.paneState.kind === 'CLINGING_FANGS') return this.paneState.pane.survivingFangCount;
    return 0;
  }

  public isPlayerPassable(pointWorld?: Vec3Like): boolean {
    if (this.paneState.kind === 'CLEARED' || this.paneState.kind === 'DESTROYED') {
      return true;
    }
    if (this.paneState.kind === 'INTACT') {
      return false;
    }
    const pane = this.paneState.pane;
    if (pane.survivingFangCount === 0) {
      return true;
    }
    if (pointWorld && !this.isOpenAtWorldPoint(pointWorld)) {
      return false;
    }
    let survivingAreaM2 = 0;
    const shards = pane.shatter.shards;
    for (let i = 0; i < shards.length; i++) {
      if (pane.attached[i] !== 0) {
        survivingAreaM2 += shards[i].areaM2;
      }
    }
    const totalAreaM2 = Math.max(1e-4, pane.shatter.totalAreaM2);
    return survivingAreaM2 / totalAreaM2 <= 0.35 && this.isOpenAtWorldPoint(this.centerWorld);
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
    if (this.paneState.kind === 'INTACT') return false;
    if (this.paneState.kind === 'CLEARED' || this.paneState.kind === 'DESTROYED') return true;
    const pane = this.paneState.pane;
    if (pane.survivingFangCount === 0) return true;
    const { hitX, hitY } = this.worldPointToWindowCoords(pointWorld);
    const shards = pane.shatter.shards;
    for (let i = 0; i < shards.length; i++) {
      if (pane.attached[i] === 0) continue;
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

  public shatterAtWorldPoint(
    pointWorld: Vec3Like,
    directionWorld: Vec3Like,
    kineticEnergyJ: number,
    impactRadiusM = 0.035,
  ): { alreadyShattered: boolean; energyAbsorbedJ: number; spawnedShards: number } {
    if (this.paneState.kind === 'DESTROYED') {
      return { alreadyShattered: true, energyAbsorbedJ: 0, spawnedShards: 0 };
    }
    const { hitX, hitY } = this.worldPointToWindowCoords(pointWorld);

    if (this.paneState.kind === 'INTACT') {
      const activeCollider = this.paneState.colliderHandle;
      this.intactEntity.enabled = false;

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

      const pane = new ProgressiveVoronoiPane(voronoiResult);
      const detachedIndices = pane.triggerInitialBreach(kineticEnergyJ);

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

      this.syncFangStateAndMesh(pane, activeCollider);
      return { alreadyShattered: false, energyAbsorbedJ: this.penetrationResistanceJ, spawnedShards };
    }

    if (this.paneState.kind === 'CLEARED') {
      return { alreadyShattered: true, energyAbsorbedJ: 0, spawnedShards: 0 };
    }

    const { pane, colliderHandle: activeCollider } = this.paneState;
    if (pane.survivingFangCount === 0) {
      this.transitionToCleared(activeCollider);
      return { alreadyShattered: true, energyAbsorbedJ: 0, spawnedShards: 0 };
    }

    const fangHit = pane.strikeClingingFangs(hitX, hitY, kineticEnergyJ, impactRadiusM);
    if (fangHit.hitOpenBreach || fangHit.newlyDetachedIndices.length === 0) {
      return { alreadyShattered: true, energyAbsorbedJ: 0, spawnedShards: 0 };
    }

    const seed = ++this.shatterCounter * 15485863 + Math.round(hitX * 997 + hitY * 991);
    const spawnedShards = this.shardPool.spawnShardsSubset(
      pane.shatter,
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

    this.syncFangStateAndMesh(pane, activeCollider);
    return {
      alreadyShattered: false,
      energyAbsorbedJ: Math.max(MIN_GLASS_ENERGY_LOSS_J, this.penetrationResistanceJ * 0.78),
      spawnedShards,
    };
  }

  public reset(): void {
    if (this.paneState.kind === 'DESTROYED') return;
    this.shatterCounter = 0;
    this.intactEntity.enabled = true;
    this.fangEntity.enabled = false;
    const existingCol = this.colliderHandle;
    const colHandle = existingCol >= 0 ? existingCol : this.createCollider();
    this.paneState = { kind: 'INTACT', colliderHandle: colHandle };
  }

  public destroy(): void {
    if (this.paneState.kind === 'DESTROYED') return;
    const colHandle = this.colliderHandle;
    if (colHandle >= 0) {
      this.physics.removeCollider(colHandle);
    }
    this.paneState = { kind: 'DESTROYED' };
    this.fangEntity.destroy();
    this.fangMesh.destroy();
    this.intactEntity.destroy();
    this.intactMesh.destroy();
  }

  private transitionToCleared(activeCollider: number): void {
    this.fangEntity.enabled = false;
    if (activeCollider >= 0) {
      this.physics.removeCollider(activeCollider);
    }
    this.paneState = { kind: 'CLEARED' };
  }

  private syncFangStateAndMesh(pane: ProgressiveVoronoiPane, activeCollider: number): void {
    if (pane.survivingFangCount === 0) {
      this.transitionToCleared(activeCollider);
      return;
    }

    const stats = pane.writeClingingFangsMeshBuffers(
      this.fangPositions,
      this.fangNormals,
      this.fangUvs,
      this.fangColors,
      this.fangIndices,
    );

    if (stats.vertexCount === 0 || stats.indexCount === 0) {
      this.transitionToCleared(activeCollider);
      return;
    }

    this.paneState = { kind: 'CLINGING_FANGS', pane, colliderHandle: activeCollider };
    this.fangEntity.enabled = true;
    this.fangMesh.setPositions(this.fangPositions, 3, stats.vertexCount);
    this.fangMesh.setNormals(this.fangNormals, 3, stats.vertexCount);
    this.fangMesh.setUvs(0, this.fangUvs, 2, stats.vertexCount);
    this.fangMesh.setColors(this.fangColors, 4, stats.vertexCount);
    this.fangMesh.setIndices(this.fangIndices, stats.indexCount);
    this.fangMesh.update(pc.PRIMITIVE_TRIANGLES, true);
  }

  private createCollider(): number {
    const tag: ColliderSurfaceTag = {
      material: 'GLASS_VORONOI',
      objectId: this.id,
      thicknessM: this.thicknessM,
      penetrationResistanceJ: this.penetrationResistanceJ,
    };
    return this.physics.createStaticBox(
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
