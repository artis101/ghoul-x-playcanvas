import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { PenetrationRayHit } from '../../../contracts/destruction.ts';
import { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
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
  quatFromPlusZToNormalWithRoll,
} from './craterMeshes.ts';
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
  private readonly slotActive: Uint8Array;
  private readonly slotPointX: Float32Array;
  private readonly slotPointY: Float32Array;
  private readonly slotPointZ: Float32Array;
  private readonly slotNormalX: Float32Array;
  private readonly slotNormalY: Float32Array;
  private readonly slotNormalZ: Float32Array;
  private readonly slotUniformIdx: Int32Array;
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
    this.slotActive = new Uint8Array(this.maxDecals);
    this.slotPointX = new Float32Array(this.maxDecals);
    this.slotPointY = new Float32Array(this.maxDecals);
    this.slotPointZ = new Float32Array(this.maxDecals);
    this.slotNormalX = new Float32Array(this.maxDecals);
    this.slotNormalY = new Float32Array(this.maxDecals);
    this.slotNormalZ = new Float32Array(this.maxDecals);
    this.slotUniformIdx = new Int32Array(this.maxDecals).fill(-1);

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

  public spawnCraterImpact(
    pointWorld: Vec3Like,
    normalWorld: Vec3Like,
    bulletDirWorld: Vec3Like,
    kineticEnergyJ: number,
    caliberRadiusM = 0.004,
  ): CraterImpactRecord {
    const energyClamped = Math.max(80, Math.min(18000, kineticEnergyJ));
    const energyFactor = Math.cbrt(energyClamped / 1800);
    const craterDiameterM = Math.max(0.095, Math.min(0.38, (caliberRadiusM * 19 + 0.072) * energyFactor));
    const craterRadiusM = craterDiameterM * 0.5;
    const craterDepthM = craterRadiusM * 0.36;

    if (!this.destroyed) {
      let slotId = this.ringSlots[this.ringCursor];
      if (slotId < 0 || !this.decalPool.isSlotActive(slotId)) {
        slotId = this.decalPool.allocSlot();
        this.ringSlots[this.ringCursor] = slotId;
      }
      this.ringCursor = (this.ringCursor + 1) % this.maxDecals;

      const quat = quatFromPlusZToNormalWithRoll(normalWorld, this.nextRandom() * Math.PI * 2);
      const surfaceLiftM = 0.0028 + (slotId % 8) * 0.0001;

      if (slotId >= 0) {
        this.decalPool.setSlotTRS(
          slotId,
          {
            x: pointWorld.x + normalWorld.x * surfaceLiftM,
            y: pointWorld.y + normalWorld.y * surfaceLiftM,
            z: pointWorld.z + normalWorld.z * surfaceLiftM,
          },
          quat,
          { x: craterDiameterM, y: craterDiameterM, z: 1 },
        );
        this.decalPool.upload();
      }

      const uIdx = this.shaderCraterWriteCursor * 4;
      this.shaderCraterUniformData[uIdx] = pointWorld.x;
      this.shaderCraterUniformData[uIdx + 1] = pointWorld.y;
      this.shaderCraterUniformData[uIdx + 2] = pointWorld.z;
      this.shaderCraterUniformData[uIdx + 3] = craterRadiusM;

      if (slotId >= 0 && slotId < this.maxDecals) {
        this.slotActive[slotId] = 1;
        this.slotPointX[slotId] = pointWorld.x;
        this.slotPointY[slotId] = pointWorld.y;
        this.slotPointZ[slotId] = pointWorld.z;
        this.slotNormalX[slotId] = normalWorld.x;
        this.slotNormalY[slotId] = normalWorld.y;
        this.slotNormalZ[slotId] = normalWorld.z;
        this.slotUniformIdx[slotId] = uIdx;
      }

      this.shaderCraterWriteCursor = (this.shaderCraterWriteCursor + 1) % MAX_SHADER_WORLD_CRATERS;
      this.shaderCraterActiveCount = Math.min(MAX_SHADER_WORLD_CRATERS, this.shaderCraterActiveCount + 1);

      for (const mat of this.trackedConcreteMaterials) {
        mat.setParameter('uCraterSpheres[0]', this.shaderCraterUniformData);
        mat.setParameter('uCraterCount', this.shaderCraterActiveCount);
      }

      this.spawnSpallChipBurst(pointWorld, normalWorld, bulletDirWorld, energyFactor);
    }

    this.totalSpawnedCraters++;
    const record: CraterImpactRecord = {
      pointWorld: { x: pointWorld.x, y: pointWorld.y, z: pointWorld.z },
      normalWorld: { x: normalWorld.x, y: normalWorld.y, z: normalWorld.z },
      radiusM: craterRadiusM,
      depthM: craterDepthM,
    };
    this.recentImpacts.push(record);
    if (this.recentImpacts.length > this.maxDecals) this.recentImpacts.shift();
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
  ): number {
    if (this.destroyed) return 0;
    let prunedCount = 0;

    for (let s = 0; s < this.maxDecals; s++) {
      if (this.slotActive[s] === 0 || !this.decalPool.isSlotActive(s)) {
        this.slotActive[s] = 0;
        continue;
      }

      const px = this.slotPointX[s];
      const py = this.slotPointY[s];
      const pz = this.slotPointZ[s];
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
        this.slotActive[s] = 0;
        for (let r = 0; r < this.ringSlots.length; r++) {
          if (this.ringSlots[r] === s) {
            this.ringSlots[r] = -1;
          }
        }
        const uIdx = this.slotUniformIdx[s];
        if (uIdx >= 0 && uIdx + 3 < this.shaderCraterUniformData.length) {
          this.shaderCraterUniformData[uIdx + 3] = 0;
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
    this.slotActive.fill(0);
    this.slotUniformIdx.fill(-1);
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
