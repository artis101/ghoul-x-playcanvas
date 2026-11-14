import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { PenetrationRayHit } from '../../../contracts/destruction.ts';
import { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld, SphereRegion } from '../../physics/rapierWorld.ts';
import {
  MAX_SHADER_WORLD_CRATERS,
  type CraterImpactRecord,
  type ProceduralCraterTextures,
  createProceduralCraterTextures,
} from './craterTextures.ts';
import { applyPomCraterShaderChunks } from './pomShaderChunks.ts';
import { applyConcreteSurfaceCraterChunks } from './concreteCraterChunks.ts';
import {
  createConcreteChipMesh,
  createTangentDecalQuadMesh,
} from './craterMeshes.ts';
import {
  CraterDecalSlotState,
  type CraterSpawnerContext,
  executeCraterImpact,
} from './craterImpactSpawner.ts';
import { spawnSpallChipBurst } from './spallChipEmitter.ts';

export class PomCraterDecalSystem {
  public readonly app: pc.Application;
  public readonly maxDecals: number;
  public readonly textures: ProceduralCraterTextures;
  public readonly decalMaterial: pc.StandardMaterial;
  public readonly chipMaterial: pc.StandardMaterial;
  public readonly decalPool: HardwareInstancedPool;
  public readonly chipPool: HardwareInstancedPool;

  private readonly decalMesh: pc.Mesh;
  private readonly chipMesh: pc.Mesh;
  private readonly ringSlots: Int32Array;
  private readonly slotState: Uint8Array;
  private readonly slotPointX: Float32Array;
  private readonly slotPointY: Float32Array;
  private readonly slotPointZ: Float32Array;
  private readonly slotNormalX: Float32Array;
  private readonly slotNormalY: Float32Array;
  private readonly slotNormalZ: Float32Array;
  private readonly slotUniformIdx: Int32Array;
  private readonly uniformOwnerDecalSlot: Int16Array;
  private readonly recentImpacts: CraterImpactRecord[] = [];
  private readonly shaderCraterUniformData = new Float32Array(MAX_SHADER_WORLD_CRATERS * 4);
  private readonly trackedConcreteMaterials = new Set<pc.StandardMaterial>();

  private ringCursor = 0;
  private totalSpawnedCraters = 0;
  private shaderCraterWriteCursor = 0;
  private shaderCraterActiveCount = 0;
  private rngState = 0x9e3779b9;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    maxDecals = 128,
    maxChipParticles = 1024,
    textureResolution = 256,
  ) {
    this.app = app;
    this.maxDecals = Math.max(4, Math.floor(maxDecals));
    this.ringSlots = new Int32Array(this.maxDecals).fill(-1);
    this.slotState = new Uint8Array(this.maxDecals).fill(CraterDecalSlotState.INACTIVE);
    this.slotPointX = new Float32Array(this.maxDecals);
    this.slotPointY = new Float32Array(this.maxDecals);
    this.slotPointZ = new Float32Array(this.maxDecals);
    this.slotNormalX = new Float32Array(this.maxDecals);
    this.slotNormalY = new Float32Array(this.maxDecals);
    this.slotNormalZ = new Float32Array(this.maxDecals);
    this.slotUniformIdx = new Int32Array(this.maxDecals).fill(-1);
    this.uniformOwnerDecalSlot = new Int16Array(MAX_SHADER_WORLD_CRATERS).fill(-1);

    const device = app.graphicsDevice;
    this.textures = createProceduralCraterTextures(device, textureResolution);

    this.decalMaterial = new pc.StandardMaterial();
    this.decalMaterial.name = 'ConcretePomCraterDecalMat';
    applyPomCraterShaderChunks(this.decalMaterial, this.textures);

    this.chipMaterial = new pc.StandardMaterial();
    this.chipMaterial.name = 'ConcreteSpallChipMat';
    this.chipMaterial.diffuse = new pc.Color(0.68, 0.66, 0.63);
    this.chipMaterial.useMetalness = true;
    this.chipMaterial.metalness = 0.04;
    this.chipMaterial.gloss = 0.24;
    this.chipMaterial.fresnelModel = pc.FRESNEL_SCHLICK;
    this.chipMaterial.update();

    this.decalMesh = createTangentDecalQuadMesh(device);
    this.chipMesh = createConcreteChipMesh(device);

    this.decalPool = new HardwareInstancedPool(
      app,
      this.decalMesh,
      this.decalMaterial,
      this.maxDecals,
      'ConcretePomCraterDecalPool',
      false,
    );

    this.chipPool = new HardwareInstancedPool(
      app,
      this.chipMesh,
      this.chipMaterial,
      Math.max(32, Math.floor(maxChipParticles)),
      'ConcreteSpallChipPool',
      false,
    );
  }

  public get activeDecalCount(): number {
    return this.decalPool.activeCount;
  }

  public get activeChipCount(): number {
    return this.chipPool.activeCount;
  }

  public get totalCraterCount(): number {
    return this.totalSpawnedCraters;
  }

  public getImpacts(): readonly CraterImpactRecord[] {
    return this.recentImpacts;
  }

  public registerConcreteMaterial(material: pc.StandardMaterial): void {
    if (this.destroyed || this.trackedConcreteMaterials.has(material)) return;
    applyConcreteSurfaceCraterChunks(material, this.shaderCraterUniformData);
    this.trackedConcreteMaterials.add(material);
  }

  public getSlotState(slotId: number): CraterDecalSlotState {
    if (slotId < 0 || slotId >= this.maxDecals) return CraterDecalSlotState.INACTIVE;
    return this.slotState[slotId] as CraterDecalSlotState;
  }

  public spawnCraterImpact(
    pointWorld: Vec3Like,
    normalWorld: Vec3Like,
    bulletDirWorld: Vec3Like,
    kineticEnergyJ: number,
    caliberRadiusM = 0.004,
  ): CraterImpactRecord {
    const spawnerCtx: CraterSpawnerContext = {
      maxDecals: this.maxDecals,
      ringSlots: this.ringSlots,
      ringCursor: this.ringCursor,
      slotState: this.slotState,
      slotPointX: this.slotPointX,
      slotPointY: this.slotPointY,
      slotPointZ: this.slotPointZ,
      slotNormalX: this.slotNormalX,
      slotNormalY: this.slotNormalY,
      slotNormalZ: this.slotNormalZ,
      slotUniformIdx: this.slotUniformIdx,
      uniformOwnerDecalSlot: this.uniformOwnerDecalSlot,
      decalPool: this.decalPool,
      shaderCraterUniformData: this.shaderCraterUniformData,
      shaderCraterWriteCursor: this.shaderCraterWriteCursor,
      shaderCraterActiveCount: this.shaderCraterActiveCount,
      trackedConcreteMaterials: this.trackedConcreteMaterials,
      recentImpacts: this.recentImpacts,
      nextRandom: () => this.nextRandom(),
      spawnSpallChips: (pt, norm, dir, factor) => {
        this.spawnSpallChipBurst(pt, norm, dir, factor);
      },
    };

    const record = executeCraterImpact(
      spawnerCtx,
      pointWorld,
      normalWorld,
      bulletDirWorld,
      kineticEnergyJ,
      caliberRadiusM,
      this.destroyed,
    );

    this.ringCursor = spawnerCtx.ringCursor;
    this.shaderCraterWriteCursor = spawnerCtx.shaderCraterWriteCursor;
    this.shaderCraterActiveCount = spawnerCtx.shaderCraterActiveCount;
    this.totalSpawnedCraters++;
    return record;
  }

  public spawnSpallChipBurst(
    pointWorld: Vec3Like,
    normalWorld: Vec3Like,
    incidentDirWorld: Vec3Like,
    intensityScale = 1.0,
    chipCountOverride?: number,
  ): number {
    if (this.destroyed) return 0;
    return spawnSpallChipBurst(
      this.chipPool,
      () => this.nextRandom(),
      pointWorld,
      normalWorld,
      incidentDirWorld,
      intensityScale,
      chipCountOverride,
    );
  }

  public pruneUnsupportedCraters(
    rapierWorld: RapierPhysicsWorld,
    isSurfaceOpen?: (
      hit: PenetrationRayHit,
      origin: Vec3Like,
      dir: Vec3Like,
      maxDistM: number,
    ) => boolean,
    regions?: readonly SphereRegion[],
  ): number {
    if (this.destroyed) return 0;
    let prunedCount = 0;

    for (let s = 0; s < this.maxDecals; s++) {
      const prevState = this.slotState[s] as CraterDecalSlotState;
      if (prevState === CraterDecalSlotState.INACTIVE || !this.decalPool.isSlotActive(s)) {
        this.slotState[s] = CraterDecalSlotState.INACTIVE;
        continue;
      }

      const px = this.slotPointX[s];
      const py = this.slotPointY[s];
      const pz = this.slotPointZ[s];
      if (regions && !isPointInAnyRegion(px, py, pz, regions)) continue;
      const nx = this.slotNormalX[s];
      const ny = this.slotNormalY[s];
      const nz = this.slotNormalZ[s];

      const origin: Vec3Like = {
        x: px + nx * 0.05,
        y: py + ny * 0.05,
        z: pz + nz * 0.05,
      };
      const dir: Vec3Like = { x: -nx, y: -ny, z: -nz };
      const maxDistM = 0.12;
      const hits = rapierWorld.castPenetrationRay(origin, dir, maxDistM);

      let hasIntactStaticSupport = false;
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        const col = rapierWorld.world.getCollider(h.colliderHandle);
        const isStatic = Boolean(col && (!col.parent() || col.parent()!.isFixed()));
        if (!isStatic || h.surface.material === 'CONCRETE_CHUNKS') continue;
        if (isSurfaceOpen && isSurfaceOpen(h, origin, dir, maxDistM)) continue;
        hasIntactStaticSupport = true;
        break;
      }

      if (!hasIntactStaticSupport) {
        this.decalPool.freeSlot(s);
        this.slotState[s] = CraterDecalSlotState.INACTIVE;
        for (let r = 0; r < this.ringSlots.length; r++) {
          if (this.ringSlots[r] === s) {
            this.ringSlots[r] = -1;
          }
        }
        if (prevState === CraterDecalSlotState.ACTIVE_WITH_SHADER_UNIFORM) {
          const uIdx = this.slotUniformIdx[s];
          const uSlot = Math.floor(uIdx / 4);
          if (
            uIdx >= 0 &&
            uIdx + 3 < this.shaderCraterUniformData.length &&
            uSlot >= 0 &&
            uSlot < MAX_SHADER_WORLD_CRATERS &&
            this.uniformOwnerDecalSlot[uSlot] === s
          ) {
            this.shaderCraterUniformData[uIdx + 3] = 0;
            this.uniformOwnerDecalSlot[uSlot] = -1;
          }
        }
        this.slotUniformIdx[s] = -1;
        prunedCount++;
      }
    }

    if (prunedCount > 0) {
      this.decalPool.upload();
      for (const mat of this.trackedConcreteMaterials) {
        mat.setParameter('uCraterSpheres[0]', this.shaderCraterUniformData);
        mat.setParameter('uCraterCount', this.shaderCraterActiveCount);
      }
    }

    return prunedCount;
  }

  public update(rapierWorld: RapierPhysicsWorld | null, dt: number): void {
    if (this.destroyed) return;
    this.decalPool.syncFromPhysics(rapierWorld, dt);
    this.chipPool.syncFromPhysics(rapierWorld, dt);
  }

  public clear(): void {
    if (this.destroyed) return;
    this.ringSlots.fill(-1);
    this.slotState.fill(CraterDecalSlotState.INACTIVE);
    this.slotUniformIdx.fill(-1);
    this.uniformOwnerDecalSlot.fill(-1);
    this.ringCursor = 0;
    this.totalSpawnedCraters = 0;
    this.recentImpacts.length = 0;
    this.shaderCraterUniformData.fill(0);
    this.shaderCraterWriteCursor = 0;
    this.shaderCraterActiveCount = 0;
    for (const mat of this.trackedConcreteMaterials) {
      mat.setParameter('uCraterSpheres[0]', this.shaderCraterUniformData);
      mat.setParameter('uCraterCount', 0);
    }
    this.decalPool.clear();
    this.chipPool.clear();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.trackedConcreteMaterials.clear();
    this.decalPool.destroy();
    this.chipPool.destroy();
    this.decalMesh.destroy();
    this.chipMesh.destroy();
    this.decalMaterial.destroy();
    this.chipMaterial.destroy();
    this.textures.heightMap.destroy();
    this.textures.normalMap.destroy();
    this.textures.scorchDiffuseMap.destroy();
  }

  private nextRandom(): number {
    let x = this.rngState >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return (this.rngState >>> 0) / 4294967296;
  }
}

function isPointInAnyRegion(x: number, y: number, z: number, regions: readonly SphereRegion[]): boolean {
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const dx = x - r.x;
    const dy = y - r.y;
    const dz = z - r.z;
    if (dx * dx + dy * dy + dz * dz <= r.radiusM * r.radiusM) return true;
  }
  return false;
}
