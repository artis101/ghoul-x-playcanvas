import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { createBeveledBrickMeshVariant } from './brickMaterial.ts';

export class BrickDynamicPool {
  public readonly variantPools: readonly [
    HardwareInstancedPool,
    HardwareInstancedPool,
    HardwareInstancedPool,
  ];
  public readonly mortarChipPool: HardwareInstancedPool;
  public readonly variantNormScales: readonly [Vec3Like, Vec3Like, Vec3Like];
  private readonly chipMesh: pc.Mesh;
  private readonly chipMaterial: pc.StandardMaterial;

  constructor(
    app: pc.Application,
    brickMaterial: pc.StandardMaterial,
    variantMeshes: readonly [pc.Mesh, pc.Mesh, pc.Mesh],
    maxBricksPerVariantPool = 1024,
    maxMortarChips = 1024
  ) {
    const maxBricks = Math.max(64, maxBricksPerVariantPool);
    this.variantNormScales = [0, 1, 2].map((i) => {
      const he = variantMeshes[i].aabb.halfExtents;
      return {
        x: he.x > 1e-4 ? 1 / (he.x * 2) : 1,
        y: he.y > 1e-4 ? 1 / (he.y * 2) : 1,
        z: he.z > 1e-4 ? 1 / (he.z * 2) : 1,
      };
    }) as unknown as [Vec3Like, Vec3Like, Vec3Like];

    this.variantPools = [
      new HardwareInstancedPool(
        app,
        variantMeshes[0],
        brickMaterial,
        maxBricks,
        'BrickVariantPool_0',
        true
      ),
      new HardwareInstancedPool(
        app,
        variantMeshes[1],
        brickMaterial,
        maxBricks,
        'BrickVariantPool_1',
        true
      ),
      new HardwareInstancedPool(
        app,
        variantMeshes[2],
        brickMaterial,
        maxBricks,
        'BrickVariantPool_2',
        true
      ),
    ];

    const device = app.graphicsDevice;
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
      Math.max(64, maxMortarChips),
      'MortarBrickChipPool',
      false
    );
  }

  public uploadAllVariantPools(): void {
    this.variantPools[0].upload();
    this.variantPools[1].upload();
    this.variantPools[2].upload();
  }

  public syncFromPhysics(
    rapierWorld: RapierPhysicsWorld,
    dt: number,
    onVariantSlotExpired?: (variant: number, slotId: number, bodyHandle: number) => void
  ): void {
    this.variantPools[0].syncFromPhysics(
      rapierWorld,
      dt,
      onVariantSlotExpired ? (s, b) => onVariantSlotExpired(0, s, b) : undefined
    );
    this.variantPools[1].syncFromPhysics(
      rapierWorld,
      dt,
      onVariantSlotExpired ? (s, b) => onVariantSlotExpired(1, s, b) : undefined
    );
    this.variantPools[2].syncFromPhysics(
      rapierWorld,
      dt,
      onVariantSlotExpired ? (s, b) => onVariantSlotExpired(2, s, b) : undefined
    );
    this.mortarChipPool.syncFromPhysics(rapierWorld, dt);
  }

  public spawnMortarChips(
    originWorld: Vec3Like,
    normalWorld: Vec3Like,
    count: number,
    speedScale: number,
    nextRandom: () => number
  ): void {
    for (let i = 0; i < count; i++) {
      const speed = (1.8 + nextRandom() * 4.4) * speedScale;
      const vx = (normalWorld.x + (nextRandom() - 0.5) * 1.4) * speed;
      const vy = (Math.abs(normalWorld.y) * 0.5 + 0.45 + nextRandom() * 0.7) * speed;
      const vz = (normalWorld.z + (nextRandom() - 0.5) * 1.4) * speed;
      const s = 0.016 + nextRandom() * 0.022;

      this.mortarChipPool.spawnKinematicParticle(
        {
          x: originWorld.x + normalWorld.x * 0.02,
          y: originWorld.y + normalWorld.y * 0.02,
          z: originWorld.z + normalWorld.z * 0.02,
        },
        { x: vx, y: vy, z: vz },
        {
          x: (nextRandom() - 0.5) * 18,
          y: (nextRandom() - 0.5) * 18,
          z: (nextRandom() - 0.5) * 18,
        },
        { x: s * 1.3, y: s * 0.7, z: s },
        -9.81,
        0.28,
        1.2 + nextRandom() * 0.8
      );
    }
    this.mortarChipPool.upload();
  }

  public clear(): void {
    this.mortarChipPool.clear();
  }

  public destroy(): void {
    this.variantPools[0].destroy();
    this.variantPools[1].destroy();
    this.variantPools[2].destroy();
    this.mortarChipPool.destroy();
    this.chipMesh.destroy();
    this.chipMaterial.destroy();
  }
}
