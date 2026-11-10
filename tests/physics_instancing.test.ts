import { describe, it, expect, beforeAll } from 'vitest';
import * as pc from 'playcanvas';
import {
  initRapierPhysics,
  RapierPhysicsWorld,
  writeColumnMajorTrsMatrix4,
} from '../src/engine/physics/rapierWorld.ts';
import {
  DenseInstancePacker,
  HardwareInstancedPool,
} from '../src/engine/physics/instancedPool.ts';
import type {
  ColliderSurfaceTag,
  ChunkConnectivityGraphJson,
} from '../src/contracts/destruction.ts';

describe('Phase 1 Physics & Hardware Instancing Foundation', () => {
  beforeAll(async () => {
    const r1 = await initRapierPhysics();
    const r2 = await initRapierPhysics();
    expect(r1).toBe(r2);
    expect(typeof r1.version()).toBe('string');
  });

  describe('1. Column-Major TRS Matrix Math & Rapier writeBodyMatrix4', () => {
    it('matches PlayCanvas pc.Mat4.setTRS bit-for-bit across 90-deg rotations and non-uniform scaling', () => {
      const halfPi = Math.PI * 0.5;
      const sinHalf = Math.sin(halfPi * 0.5);
      const cosHalf = Math.cos(halfPi * 0.5);

      // 90 deg rotation around +Y axis: +X -> -Z, +Z -> +X
      const pos = new pc.Vec3(3.25, 1.75, -8.5);
      const quat = new pc.Quat(0, sinHalf, 0, cosHalf);
      const scale = new pc.Vec3(0.24, 0.08, 0.12);

      const expectedMat = new pc.Mat4().setTRS(pos, quat, scale);
      const out = new Float32Array(32);
      const offset16 = 16;

      writeColumnMajorTrsMatrix4(
        out,
        offset16,
        pos.x,
        pos.y,
        pos.z,
        quat.x,
        quat.y,
        quat.z,
        quat.w,
        scale.x,
        scale.y,
        scale.z,
      );

      for (let i = 0; i < 16; i++) {
        expect(out[offset16 + i]).toBeCloseTo(expectedMat.data[i], 6);
      }

      // Verify specific column-major basis entries for 90 deg Y rotation:
      // Column 0 (scaled X basis -> (0, 0, -sx, 0))
      expect(out[offset16 + 0]).toBeCloseTo(0, 6);
      expect(out[offset16 + 1]).toBeCloseTo(0, 6);
      expect(out[offset16 + 2]).toBeCloseTo(-scale.x, 6);
      expect(out[offset16 + 3]).toBe(0);

      // Column 1 (scaled Y basis -> (0, sy, 0, 0))
      expect(out[offset16 + 4]).toBeCloseTo(0, 6);
      expect(out[offset16 + 5]).toBeCloseTo(scale.y, 6);
      expect(out[offset16 + 6]).toBeCloseTo(0, 6);
      expect(out[offset16 + 7]).toBe(0);

      // Column 2 (scaled Z basis -> (sz, 0, 0, 0))
      expect(out[offset16 + 8]).toBeCloseTo(scale.z, 6);
      expect(out[offset16 + 9]).toBeCloseTo(0, 6);
      expect(out[offset16 + 10]).toBeCloseTo(0, 6);
      expect(out[offset16 + 11]).toBe(0);

      // Column 3 (translation -> (tx, ty, tz, 1))
      expect(out[offset16 + 12]).toBeCloseTo(pos.x, 6);
      expect(out[offset16 + 13]).toBeCloseTo(pos.y, 6);
      expect(out[offset16 + 14]).toBeCloseTo(pos.z, 6);
      expect(out[offset16 + 15]).toBe(1);
    });

    it('extracts Rapier rigid-body pose via writeBodyMatrix4 with exact 90-deg rotation and scaling', () => {
      const world = new RapierPhysicsWorld();
      try {
        const s = Math.SQRT1_2;
        // 90-degree rotation around Z axis: +X -> +Y, +Y -> -X
        const { bodyHandle } = world.spawnDynamicBox(
          { x: -2.5, y: 4.0, z: -11.0 },
          { x: 0.2, y: 0.1, z: 0.1 },
          2.4,
          undefined,
          undefined,
          { x: 0, y: 0, z: s, w: s },
        );

        const buf = new Float32Array(16);
        const ok = world.writeBodyMatrix4(bodyHandle, buf, 0, 2.0, 3.0, 4.0);
        expect(ok).toBe(true);

        // Column 0: rotated X = (0, 1, 0) * 2.0 = (0, 2, 0, 0)
        expect(buf[0]).toBeCloseTo(0, 5);
        expect(buf[1]).toBeCloseTo(2.0, 5);
        expect(buf[2]).toBeCloseTo(0, 5);
        expect(buf[3]).toBe(0);

        // Column 1: rotated Y = (-1, 0, 0) * 3.0 = (-3, 0, 0, 0)
        expect(buf[4]).toBeCloseTo(-3.0, 5);
        expect(buf[5]).toBeCloseTo(0, 5);
        expect(buf[6]).toBeCloseTo(0, 5);
        expect(buf[7]).toBe(0);

        // Column 2: rotated Z = (0, 0, 1) * 4.0 = (0, 0, 4, 0)
        expect(buf[8]).toBeCloseTo(0, 5);
        expect(buf[9]).toBeCloseTo(0, 5);
        expect(buf[10]).toBeCloseTo(4.0, 5);
        expect(buf[11]).toBe(0);

        // Column 3: translation
        expect(buf[12]).toBeCloseTo(-2.5, 5);
        expect(buf[13]).toBeCloseTo(4.0, 5);
        expect(buf[14]).toBeCloseTo(-11.0, 5);
        expect(buf[15]).toBe(1);
      } finally {
        world.destroy();
      }
    });
  });

  describe('2. RapierPhysicsWorld Simulation, Convex Hulls, Penetration Raycast & Radial Blast', () => {
    it('simulates dynamic box falling onto the y=0 arena ground collider and settling to sleep', () => {
      const world = new RapierPhysicsWorld();
      try {
        const halfY = 0.12;
        const { bodyHandle } = world.spawnDynamicBox(
          { x: 0, y: 1.5, z: -5 },
          { x: 0.15, y: halfY, z: 0.15 },
          3.2,
        );

        expect(world.isBodySleeping(bodyHandle)).toBe(false);

        for (let i = 0; i < 210; i++) {
          world.step(1 / 60);
        }

        const settledPose = world.getBodyPose(bodyHandle);
        expect(settledPose).not.toBeNull();
        expect(settledPose!.position.y).toBeGreaterThan(halfY - 0.02);
        expect(settledPose!.position.y).toBeLessThan(halfY + 0.03);
        expect(world.isBodySleeping(bodyHandle)).toBe(true);
      } finally {
        world.destroy();
      }
    });

    it('creates both valid 3D convex hulls and fallback cuboids for coplanar vertex sets', () => {
      const world = new RapierPhysicsWorld();
      try {
        // Non-degenerate tetrahedron concrete chunk
        const tetraVerts = new Float32Array([
          -0.15, -0.1, -0.12,
          0.15, -0.1, -0.12,
          0.0, 0.18, -0.12,
          0.0, 0.0, 0.16,
        ]);
        const hullTag: ColliderSurfaceTag = {
          material: 'CONCRETE_CHUNKS',
          objectId: 'concrete_wall_01',
          chunkIndex: 7,
          thicknessM: 0.24,
          penetrationResistanceJ: 1800,
        };
        const hullRes = world.spawnDynamicConvexHull(
          { x: 1.0, y: 2.0, z: -10.0 },
          tetraVerts,
          6.5,
          { x: 0, y: 1, z: 2 },
          { x: 2, y: -1, z: 0.5 },
          hullTag,
        );
        expect(hullRes).not.toBeNull();
        expect(world.getSurfaceTag(hullRes!.colliderHandle)?.material).toBe(
          'CONCRETE_CHUNKS',
        );

        // Coplanar flat triangle (degenerate 3D volume -> triggers cuboid fallback cleanly)
        const flatShardVerts = new Float32Array([
          -0.08, -0.06, 0,
          0.08, -0.06, 0,
          0.0, 0.09, 0,
        ]);
        const fallbackRes = world.spawnDynamicConvexHull(
          { x: -1.0, y: 1.5, z: -6.5 },
          flatShardVerts,
          0.35,
        );
        expect(fallbackRes).not.toBeNull();

        world.step(1 / 60);
        expect(world.activeDynamicBodyCount).toBe(2);

        world.removeBody(hullRes!.bodyHandle);
        expect(world.activeDynamicBodyCount).toBe(1);
        expect(world.getSurfaceTag(hullRes!.colliderHandle)).toBeUndefined();
      } finally {
        world.destroy();
      }
    });

    it('casts sorted multi-wall penetration rays across tagged surfaces while ignoring untagged colliders', () => {
      const world = new RapierPhysicsWorld();
      try {
        // Place walls out of order in Z to verify distance sorting
        const concreteHandle = world.createStaticBox(
          { x: 0, y: 1.5, z: -13.5 },
          { x: 2.5, y: 1.5, z: 0.15 },
          undefined,
          {
            material: 'CONCRETE_INTACT',
            objectId: 'wall_concrete',
            thicknessM: 0.3,
            penetrationResistanceJ: 2600,
          },
        );

        const glassHandle = world.createStaticBox(
          { x: 0, y: 1.5, z: -6.5 },
          { x: 1.2, y: 1.2, z: 0.01 },
          undefined,
          {
            material: 'GLASS_MARCHING_256',
            objectId: 'window_front',
            thicknessM: 0.012,
            penetrationResistanceJ: 45,
          },
        );

        const drywallHandle = world.createStaticBox(
          { x: 0, y: 1.5, z: -9.0 },
          { x: 2.0, y: 1.5, z: 0.06 },
          undefined,
          {
            material: 'WOOD_DRYWALL',
            objectId: 'shoothouse_wall',
            thicknessM: 0.12,
            penetrationResistanceJ: 190,
          },
        );

        // Untagged prop collider along the same line — must be ignored
        world.createStaticBox(
          { x: 0, y: 1.5, z: -4.0 },
          { x: 0.5, y: 0.5, z: 0.1 },
        );

        // Step once so Rapier updates query pipeline broadphase/narrowphase structures
        world.step(1 / 60);

        const hits = world.castPenetrationRay(
          { x: 0, y: 1.5, z: 0 },
          { x: 0, y: 0, z: -1 },
          25.0,
        );

        expect(hits).toHaveLength(3);
        expect(hits[0].colliderHandle).toBe(glassHandle);
        expect(hits[0].surface.material).toBe('GLASS_MARCHING_256');
        expect(hits[0].distanceM).toBeCloseTo(6.49, 2);
        expect(hits[0].normalWorld.z).toBeCloseTo(1, 3);

        expect(hits[1].colliderHandle).toBe(drywallHandle);
        expect(hits[1].surface.material).toBe('WOOD_DRYWALL');
        expect(hits[1].distanceM).toBeCloseTo(8.94, 2);

        expect(hits[2].colliderHandle).toBe(concreteHandle);
        expect(hits[2].surface.material).toBe('CONCRETE_INTACT');
        expect(hits[2].distanceM).toBeCloseTo(13.35, 2);

        // Removing the drywall collider removes it from subsequent penetration rays
        world.removeCollider(drywallHandle);
        const hitsAfterRemoval = world.castPenetrationRay(
          { x: 0, y: 1.5, z: 0 },
          { x: 0, y: 0, z: -1 },
          25.0,
        );
        expect(hitsAfterRemoval.map((h) => h.colliderHandle)).toEqual([
          glassHandle,
          concreteHandle,
        ]);
      } finally {
        world.destroy();
      }
    });

    it('wakes sleeping dynamic bodies and applies distance-attenuated radial + upward blast impulse', () => {
      const world = new RapierPhysicsWorld();
      try {
        const nearBrick = world.spawnDynamicBox(
          { x: 1.0, y: 0.1, z: -10.0 },
          { x: 0.12, y: 0.06, z: 0.06 },
          1.8,
        );
        const midBrick = world.spawnDynamicBox(
          { x: 3.0, y: 0.1, z: -10.0 },
          { x: 0.12, y: 0.06, z: 0.06 },
          1.8,
        );
        const farBrick = world.spawnDynamicBox(
          { x: 12.0, y: 0.1, z: -10.0 },
          { x: 0.12, y: 0.06, z: 0.06 },
          1.8,
        );

        // Settle all three bricks to sleep
        for (let i = 0; i < 60; i++) {
          world.step(1 / 60);
        }
        expect(world.isBodySleeping(nearBrick.bodyHandle)).toBe(true);
        expect(world.isBodySleeping(midBrick.bodyHandle)).toBe(true);
        expect(world.isBodySleeping(farBrick.bodyHandle)).toBe(true);
        const farPoseBeforeBlast = world.getBodyPose(farBrick.bodyHandle)!;

        const affected = world.applyRadialBlastImpulse({
          centerWorld: { x: 0, y: 0.1, z: -10.0 },
          radiusM: 5.0,
          peakImpulseNs: 35.0,
          peakEnergyJ: 12000,
        });

        expect(affected).toBe(2);
        expect(world.isBodySleeping(nearBrick.bodyHandle)).toBe(false);
        expect(world.isBodySleeping(midBrick.bodyHandle)).toBe(false);
        expect(world.isBodySleeping(farBrick.bodyHandle)).toBe(true);

        world.step(1 / 60);
        const nearPose = world.getBodyPose(nearBrick.bodyHandle)!;
        const midPose = world.getBodyPose(midBrick.bodyHandle)!;
        const farPose = world.getBodyPose(farBrick.bodyHandle)!;

        // Near brick launched further +X and higher +Y than mid brick; far brick untouched
        expect(nearPose.position.x - 1.0).toBeGreaterThan(
          midPose.position.x - 3.0,
        );
        expect(nearPose.position.y).toBeGreaterThan(0.15);
        expect(farPose.position.x).toBe(farPoseBeforeBlast.position.x);
        expect(farPose.position.y).toBe(farPoseBeforeBlast.position.y);
      } finally {
        world.destroy();
      }
    });
  });

  describe('3. Dense Swap-Remove Packing, Ballistic Particles & HardwareInstancedPool', () => {
    it('maintains tightly packed [0 .. activeCount * 16) matrices across O(1) swap-remove slot frees', () => {
      const packer = new DenseInstancePacker(8);

      const s0 = packer.allocSlot();
      const s1 = packer.allocSlot();
      const s2 = packer.allocSlot();
      expect([s0, s1, s2]).toEqual([0, 1, 2]);
      expect(packer.activeCount).toBe(3);

      packer.setSlotTRS(s0, { x: 10, y: 1, z: -1 });
      packer.setSlotTRS(s1, { x: 20, y: 2, z: -2 });
      packer.setSlotTRS(s2, { x: 30, y: 3, z: -3 });

      // Free middle slot s1 -> s2 should swap into dense index 1!
      expect(packer.freeSlot(s1)).toBe(true);
      expect(packer.freeSlot(s1)).toBe(false); // idempotent
      expect(packer.activeCount).toBe(2);
      expect(packer.getDenseIndex(s0)).toBe(0);
      expect(packer.getDenseIndex(s1)).toBe(-1);
      expect(packer.getDenseIndex(s2)).toBe(1);

      // Dense slot 0 has s0's translation (10, 1, -1); dense slot 1 now has s2's translation (30, 3, -3)
      expect(packer.matrixData[0 * 16 + 12]).toBe(10);
      expect(packer.matrixData[1 * 16 + 12]).toBe(30);
      expect(packer.matrixData[1 * 16 + 13]).toBe(3);
      expect(packer.matrixData[1 * 16 + 14]).toBe(-3);

      // Re-allocating reuses freed slot handle cleanly
      const sReused = packer.allocSlot();
      expect(sReused).toBe(s1);
      expect(packer.activeCount).toBe(3);
      expect(packer.getDenseIndex(sReused)).toBe(2);
    });

    it('steps ballistic/kinematic debris particles with floor bounce at y=0.015, shrink-out, and TTL expiry', () => {
      const packer = new DenseInstancePacker(4);
      const pSlot = packer.spawnKinematicParticle(
        { x: 0, y: 0.12, z: -7.2 },
        { x: 1.5, y: -3.0, z: 0.5 },
        { x: 4.0, y: -6.0, z: 2.0 },
        { x: 0.08, y: 0.02, z: 0.02 },
        -9.81,
        0.45,
        1.0,
      );
      expect(pSlot).toBe(0);
      expect(packer.activeCount).toBe(1);

      // Step enough to strike y = 0.015 floor and bounce upward
      let sawFloorClamp = false;
      let yAtBounce = 0;
      let yAfterBounce = 0;
      for (let i = 0; i < 12; i++) {
        packer.syncFromPhysics(null, 1 / 60);
        const py = packer.matrixData[13];
        expect(py).toBeGreaterThanOrEqual(0.015 - 1e-6);
        if (Math.abs(py - 0.015) < 1e-5 && !sawFloorClamp) {
          sawFloorClamp = true;
          yAtBounce = py;
        } else if (sawFloorClamp && yAfterBounce === 0) {
          yAfterBounce = py;
        }
      }
      expect(sawFloorClamp).toBe(true);
      expect(yAfterBounce).toBeGreaterThan(yAtBounce);

      // Step into shrink-out window (age = 0.9s of 1.0s TTL -> scale < initial 0.08)
      while (packer.activeCount > 0) {
        packer.syncFromPhysics(null, 0.05);
        if (packer.activeCount > 0) {
          const col0Len = Math.hypot(
            packer.matrixData[0],
            packer.matrixData[1],
            packer.matrixData[2],
          );
          expect(col0Len).toBeLessThanOrEqual(0.08001);
        }
      }
      expect(packer.activeCount).toBe(0);
    });

    it('drives PlayCanvas HardwareInstancedPool via NullGraphicsDevice and syncs Rapier rigid bodies', () => {
      const canvasStub = { width: 640, height: 480 };
      const device = new pc.NullGraphicsDevice(canvasStub);
      const app = new pc.Application(
        canvasStub as unknown as HTMLCanvasElement,
        {
          graphicsDevice: device,
        },
      );
      const world = new RapierPhysicsWorld();

      try {
        const mesh = pc.Mesh.fromGeometry(device, new pc.BoxGeometry());
        const material = new pc.StandardMaterial();
        const pool = new HardwareInstancedPool(
          app,
          mesh,
          material,
          16,
          'TestBrickPool',
          true,
        );

        expect(pool.entity.enabled).toBe(false);
        expect(pool.meshInstance.instancingCount).toBe(0);
        expect(pool.meshInstance.cull).toBe(false);

        // Allocate 1 static brick + 1 dynamic Rapier-bound brick
        const staticSlot = pool.allocSlot();
        pool.setSlotTRS(staticSlot, { x: -1.0, y: 1.2, z: -12.5 });

        const dynSlot = pool.allocSlot();
        const { bodyHandle } = world.spawnDynamicBox(
          { x: 1.0, y: 2.0, z: -12.5 },
          { x: 0.1, y: 0.05, z: 0.05 },
          2.0,
          undefined,
          undefined,
          undefined,
        );
        pool.bindSlotToRapierBody(
          dynSlot,
          bodyHandle,
          { x: 0.2, y: 0.1, z: 0.1 },
          0.5,
        );

        world.step(1 / 60);
        pool.syncFromPhysics(world, 1 / 60);

        expect(pool.entity.enabled).toBe(true);
        expect(pool.meshInstance.instancingCount).toBe(2);
        expect(pool.dirty).toBe(false);
        expect(pool.matrixData[1 * 16 + 13]).toBeLessThan(2.0);

        // Advance past the dynamic slot's 0.5s TTL -> auto-removes Rapier body and compacts pool to 1
        for (let i = 0; i < 35; i++) {
          world.step(1 / 60);
          pool.syncFromPhysics(world, 1 / 60);
        }
        expect(pool.activeCount).toBe(1);
        expect(pool.meshInstance.instancingCount).toBe(1);
        expect(world.activeDynamicBodyCount).toBe(0);

        // Validate ChunkConnectivityGraphJson contract typing
        const sampleGraph: ChunkConnectivityGraphJson = {
          version: 1,
          wallId: 'concrete_cover_01',
          nodes: [
            {
              index: 0,
              isAnchored: true,
              localCenter: { x: 0, y: 0.2, z: 0 },
              massKg: 14,
              edges: [{ neighborIndex: 1, breakThresholdJ: 900, severed: false }],
            },
          ],
        };
        expect(sampleGraph.version).toBe(1);

        pool.destroy();
      } finally {
        world.destroy();
        app.destroy();
      }
    });
  });
});
