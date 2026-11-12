import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { createBeveledBrickMeshVariant } from './brickMaterial.ts';

/**
 * Zero-Rigid-Body Kinematic Debris & Mortar Chip Pool for `BrickWallSystem`.
 *
 * Uses `debris_pack.glb` `Brick_0..2` variants ONLY for transient flying broken-brick fragments
 * ejected when bricks shatter out of the solid wall, plus fine mortar/clay chips on bullet impacts.
 * Zero Rapier rigid bodies are ever spawned per brick.
 */
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
    rubbleMaterial: pc.Material,
    variantMeshes: readonly [pc.Mesh, pc.Mesh, pc.Mesh],
    maxBricksPerVariantPool = 256,
    maxMortarChips = 1024
  ) {
    const maxRubble = Math.max(32, maxBricksPerVariantPool);
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
        rubbleMaterial,
        maxRubble,
        'BrickRubblePool_0',
        false
      ),
      new HardwareInstancedPool(
        app,
        variantMeshes[1],
        rubbleMaterial,
        maxRubble,
        'BrickRubblePool_1',
        false
      ),
      new HardwareInstancedPool(
        app,
        variantMeshes[2],
        rubbleMaterial,
        maxRubble,
        'BrickRubblePool_2',
        false
      ),
    ];

    const device = app.graphicsDevice;
    this.chipMesh = createBeveledBrickMeshVariant(device, 0);
    this.chipMaterial = new pc.StandardMaterial();
    this.chipMaterial.name = 'MortarBrickChipMaterial';
    this.chipMaterial.diffuse = new pc.Color(0.72, 0.48, 0.38);
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

  public syncFromPhysics(rapierWorld: RapierPhysicsWorld, dt: number): void {
    this.variantPools[0].syncFromPhysics(rapierWorld, dt);
    this.variantPools[1].syncFromPhysics(rapierWorld, dt);
    this.variantPools[2].syncFromPhysics(rapierWorld, dt);
    this.mortarChipPool.syncFromPhysics(rapierWorld, dt);
  }

  public spawnBrokenBrickRubble(
    originWorld: Vec3Like,
    ejectDirWorld: Vec3Like,
    chunkCount: number,
    speedScale: number,
    nextRandom: () => number
  ): void {
    for (let i = 0; i < chunkCount; i++) {
      const variant = Math.floor(nextRandom() * 3) % 3;
      const norm = this.variantNormScales[variant];
      const speed = (1.6 + nextRandom() * 3.8) * speedScale;
      const vx = (ejectDirWorld.x + (nextRandom() - 0.5) * 0.95) * speed;
      const vy = 0.65 + nextRandom() * 2.1 * speedScale;
      const vz = (ejectDirWorld.z + (nextRandom() - 0.5) * 0.95) * speed;

      const sizeW = 0.055 + nextRandom() * 0.055;
      const sizeH = 0.036 + nextRandom() * 0.028;
      const sizeD = 0.048 + nextRandom() * 0.042;

      this.variantPools[variant].spawnKinematicParticle(
        {
          x: originWorld.x + (nextRandom() - 0.5) * 0.08,
          y: Math.max(0.04, originWorld.y + (nextRandom() - 0.5) * 0.05),
          z: originWorld.z + (nextRandom() - 0.5) * 0.08,
        },
        { x: vx, y: vy, z: vz },
        {
          x: (nextRandom() - 0.5) * 14,
          y: (nextRandom() - 0.5) * 14,
          z: (nextRandom() - 0.5) * 14,
        },
        {
          x: sizeW * norm.x,
          y: sizeH * norm.y,
          z: sizeD * norm.z,
        },
        -9.81,
        0.24,
        1.8 + nextRandom() * 1.1
      );
    }

    this.variantPools[0].upload();
    this.variantPools[1].upload();
    this.variantPools[2].upload();
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
      const s = 0.014 + nextRandom() * 0.020;

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
        1.1 + nextRandom() * 0.8
      );
    }
    this.mortarChipPool.upload();
  }

  public clear(): void {
    this.variantPools[0].clear();
    this.variantPools[1].clear();
    this.variantPools[2].clear();
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
