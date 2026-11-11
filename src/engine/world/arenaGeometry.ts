import * as pc from 'playcanvas';
import type { ColliderSurfaceTag } from '../../contracts/destruction.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { PERIMETER_BARRIER_Z_OFFSETS_M, RANGE_MARKER_DISTANCES_M } from './arenaLayout.ts';

export function buildArenaGeometry(
  arenaRootEntity: pc.Entity,
  materials: EngineMaterialPalette,
  rapierWorld: RapierPhysicsWorld | null,
  colliderHandles: number[],
  customDetailMaterials: pc.StandardMaterial[]
): void {
  // 1. Firing Range Slab Floor
  const floor = new pc.Entity('ArenaFloor');
  floor.addComponent('render', {
    type: 'box',
    material: materials.floorGridMat,
    receiveShadows: true,
  });
  floor.setLocalScale(40, 0.2, 160);
  floor.setPosition(0, -0.1, -50);
  arenaRootEntity.addChild(floor);

  // 2. Distance Markers & Posts (with Rapier static colliders)
  for (const d of RANGE_MARKER_DISTANCES_M) {
    const lineMarker = new pc.Entity(`DistanceMarker_${d}m`);
    lineMarker.addComponent('render', {
      type: 'box',
      material: materials.rangeDistanceMarkerMat,
      receiveShadows: true,
    });
    lineMarker.setLocalScale(17, 0.02, 0.08);
    lineMarker.setPosition(0, 0.01, -d);
    arenaRootEntity.addChild(lineMarker);

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

  // 4. Architectural Trusses, Baffles & Backstop
  buildArchitecturalDetails(arenaRootEntity, materials, customDetailMaterials);
}

function buildArchitecturalDetails(
  arenaRootEntity: pc.Entity,
  materials: EngineMaterialPalette,
  customDetailMaterials: pc.StandardMaterial[]
): void {
  const luminaireMat = new pc.StandardMaterial();
  luminaireMat.name = 'rangeLuminaireStripMat';
  luminaireMat.diffuse = new pc.Color(0.95, 0.97, 1.0);
  luminaireMat.emissive = new pc.Color(0.92, 0.96, 1.0);
  luminaireMat.emissiveIntensity = 2.2;
  luminaireMat.update();
  customDetailMaterials.push(luminaireMat);

  const archGroup = new pc.Entity('RangeArchitecture');
  arenaRootEntity.addChild(archGroup);

  const addBox = (
    name: string,
    mat: pc.StandardMaterial,
    sx: number,
    sy: number,
    sz: number,
    px: number,
    py: number,
    pz: number,
    rx = 0,
    castShadows = false
  ): void => {
    const ent = new pc.Entity(name);
    ent.addComponent('render', { type: 'box', material: mat, castShadows, receiveShadows: true });
    ent.setLocalScale(sx, sy, sz);
    ent.setPosition(px, py, pz);
    if (rx !== 0) ent.setEulerAngles(rx, 0, 0);
    archGroup.addChild(ent);
  };

  const trussZ = [-2, -14, -26, -38, -50];
  for (const z of trussZ) {
    for (const side of [-11.4, 11.4]) {
      addBox(`RangeColumn_${side}_${z}`, materials.targetStandMat, 0.36, 6.8, 0.36, side, 3.4, z, 0, true);
    }
    addBox(`OverheadTrussBeam_${z}`, materials.targetStandMat, 23.2, 0.32, 0.36, 0, 6.65, z, 0, true);
    addBox(`BallisticBaffle_${z}`, materials.tacticalArmorVest, 21.8, 0.85, 0.14, 0, 6.12, z - 0.35, 22, false);
    addBox(`LuminaireStripL_${z}`, luminaireMat, 5.2, 0.06, 0.14, -4.6, 6.42, z + 0.12);
    addBox(`LuminaireStripR_${z}`, luminaireMat, 5.2, 0.06, 0.14, 4.6, 6.42, z + 0.12);
  }

  for (const railX of [-7.8, 0, 7.8]) {
    addBox(`LongitudinalRail_${railX}`, materials.targetStandMat, 0.18, 0.18, 56.0, railX, 6.82, -26);
  }

  addBox('BulletTrapBermBase', materials.barrierConcreteMat, 24.0, 2.4, 2.6, 0, 1.2, -62.0, 0, true);
  addBox('BulletTrapSteelPlate', materials.tacticalArmorVest, 22.8, 3.4, 0.35, 0, 2.25, -60.6, -28, true);
  for (const wallSide of [-11.8, 11.8]) {
    addBox(`PerimeterContainmentWall_${wallSide}`, materials.barrierConcreteMat, 0.45, 2.2, 68.0, wallSide, 1.1, -30.0, 0, true);
  }
}
