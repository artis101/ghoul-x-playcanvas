import * as pc from 'playcanvas';
import type { ColliderSurfaceTag } from '../../contracts/destruction.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import {
  HALL_CENTER_Z,
  HALL_LENGTH_M,
  HALL_SHELL,
  PERIMETER_BARRIER_Z_OFFSETS_M,
  RANGE_MARKER_DISTANCES_M,
} from './arenaLayout.ts';
import { buildHallShell } from './hallShell.ts';

export function buildArenaGeometry(
  arenaRootEntity: pc.Entity,
  device: pc.GraphicsDevice,
  materials: EngineMaterialPalette,
  rapierWorld: RapierPhysicsWorld | null,
  colliderHandles: number[],
  customDetailMaterials: pc.StandardMaterial[]
): void {
  // 1. Checker-Tiled Hall Floor
  const floor = new pc.Entity('ArenaFloor');
  floor.addComponent('render', {
    type: 'box',
    material: materials.floorGridMat,
    receiveShadows: true,
  });
  floor.setLocalScale(HALL_SHELL.halfWidthM * 2, 0.2, HALL_LENGTH_M);
  floor.setPosition(0, -0.1, HALL_CENTER_Z);
  arenaRootEntity.addChild(floor);

  // 2. Concrete Bollards at the Range Distances (with Rapier static colliders)
  for (const d of RANGE_MARKER_DISTANCES_M) {
    for (const side of [-8.5, 8.5]) {
      const objectId = `MarkerPost_${d}m_${side}`;
      const post = new pc.Entity(objectId);
      post.addComponent('render', {
        type: 'box',
        material: materials.barrierConcreteMat,
        castShadows: true,
        receiveShadows: true,
      });
      post.setLocalScale(0.32, 1.1, 0.32);
      post.setPosition(side, 0.55, -d);
      arenaRootEntity.addChild(post);

      if (rapierWorld) {
        const postTag: ColliderSurfaceTag = {
          material: 'CONCRETE_INTACT',
          objectId,
          thicknessM: 0.32,
          penetrationResistanceJ: 12000,
        };
        colliderHandles.push(
          rapierWorld.createStaticBox(
            { x: side, y: 0.55, z: -d },
            { x: 0.16, y: 0.55, z: 0.16 },
            undefined,
            postTag
          )
        );
      }
    }
  }

  // 3. Perimeter Concrete Jersey Barriers
  for (const z of PERIMETER_BARRIER_Z_OFFSETS_M) {
    for (const side of [-9.5, 9.5]) {
      const objectId = `Barrier_${side}_${z}`;
      const barrier = new pc.Entity(objectId);
      barrier.addComponent('render', {
        type: 'box',
        material: materials.barrierConcreteMat,
        castShadows: true,
        receiveShadows: true,
      });
      barrier.setLocalScale(1.1, 1.35, 7.5);
      barrier.setPosition(side, 0.675, z);
      arenaRootEntity.addChild(barrier);

      const footing = new pc.Entity(`${objectId}_Footing`);
      footing.addComponent('render', {
        type: 'box',
        material: materials.barrierConcreteMat,
        castShadows: true,
        receiveShadows: true,
      });
      footing.setLocalScale(1.44, 0.24, 7.56);
      footing.setPosition(side, 0.12, z);
      arenaRootEntity.addChild(footing);

      if (rapierWorld) {
        const barrierTag: ColliderSurfaceTag = {
          material: 'CONCRETE_INTACT',
          objectId,
          thicknessM: 1.1,
          penetrationResistanceJ: 16000,
        };
        colliderHandles.push(
          rapierWorld.createStaticBox(
            { x: side, y: 0.675, z },
            { x: 0.55, y: 0.675, z: 3.75 },
            undefined,
            barrierTag
          )
        );
      }
    }
  }

  // 4. Tiled Walls, Ceiling, Beams & Fluorescent Fixtures
  buildHallShell(arenaRootEntity, device, materials, rapierWorld, colliderHandles, customDetailMaterials);
}
