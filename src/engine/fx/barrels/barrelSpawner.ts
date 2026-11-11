import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag } from '../../../contracts/destruction.ts';
import { copyVec3 } from '../../../core/ballistics/vec3.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { HazardBarrelInstance } from './barrelTypes.ts';
import type { BarrelResources } from './barrelResources.ts';

export interface BarrelSpawnContext {
  app: pc.Application | null;
  rootContainer: pc.Entity | null;
  rapierWorld: RapierPhysicsWorld;
  resources: BarrelResources | null;
}

export function createBarrelStaticCollider(
  rapierWorld: RapierPhysicsWorld,
  index: number,
  basePos: Vec3Like,
): number {
  const objectId = `hazard_barrel_${index}`;
  const tag: ColliderSurfaceTag = {
    material: 'STEEL',
    objectId,
    thicknessM: 0.006,
    penetrationResistanceJ: 950,
  };
  return rapierWorld.createStaticBox(
    { x: basePos.x, y: basePos.y + 0.45, z: basePos.z },
    { x: 0.29, y: 0.45, z: 0.29 },
    undefined,
    tag,
  );
}

export function createHazardBarrelEntity(
  ctx: BarrelSpawnContext,
  index: number,
  pos: Vec3Like,
): HazardBarrelInstance {
  const basePos = copyVec3(pos);
  const objectId = `hazard_barrel_${index}`;
  const colliderHandle = createBarrelStaticCollider(ctx.rapierWorld, index, basePos);

  let rootEntity: pc.Entity | null = null;
  let intactDrumEntity: pc.Entity | null = null;
  let flameJetEntity: pc.Entity | null = null;
  let crumpledBaseEntity: pc.Entity | null = null;
  let scorchDecalEntity: pc.Entity | null = null;

  if (ctx.app && ctx.rootContainer && ctx.resources) {
    const res = ctx.resources;
    rootEntity = new pc.Entity(`HazardBarrel_${index}`);
    rootEntity.setPosition(basePos.x, basePos.y, basePos.z);
    ctx.rootContainer.addChild(rootEntity);

    intactDrumEntity = new pc.Entity(`HazardBarrelIntact_${index}`);
    intactDrumEntity.addComponent('render', {
      meshInstances: [new pc.MeshInstance(res.intactMesh, res.intactMat)],
      castShadows: true,
      receiveShadows: true,
    });
    rootEntity.addChild(intactDrumEntity);

    flameJetEntity = new pc.Entity(`HazardBarrelFlameJet_${index}`);
    flameJetEntity.addComponent('render', {
      type: 'cone',
      material: res.flameJetMat,
      castShadows: false,
    });
    flameJetEntity.setLocalPosition(0, 0.62, 0.28);
    flameJetEntity.setLocalScale(0.11, 0.42, 0.11);
    flameJetEntity.setLocalEulerAngles(55, 0, 0);
    flameJetEntity.enabled = false;
    rootEntity.addChild(flameJetEntity);

    crumpledBaseEntity = new pc.Entity(`HazardBarrelCrumpled_${index}`);
    crumpledBaseEntity.addComponent('render', {
      meshInstances: [new pc.MeshInstance(res.crumpledMesh, res.charredMat)],
      castShadows: true,
      receiveShadows: true,
    });
    crumpledBaseEntity.enabled = false;
    rootEntity.addChild(crumpledBaseEntity);

    scorchDecalEntity = new pc.Entity(`HazardBarrelScorch_${index}`);
    scorchDecalEntity.addComponent('render', {
      meshInstances: [new pc.MeshInstance(res.scorchQuadMesh, res.scorchMat)],
      castShadows: false,
      receiveShadows: true,
    });
    scorchDecalEntity.setLocalPosition(0, 0.006, 0);
    scorchDecalEntity.setLocalEulerAngles(-90, index * 37, 0);
    scorchDecalEntity.setLocalScale(2.9, 2.9, 1);
    scorchDecalEntity.enabled = false;
    rootEntity.addChild(scorchDecalEntity);
  }

  return {
    index,
    objectId,
    basePosition: basePos,
    state: 'INTACT',
    colliderHandle,
    ignitionDamage: 0,
    hitCount: 0,
    fuseRemainingS: 0,
    leakOffsetLocal: { x: 0, y: 0.62, z: 0.28 },
    leakNormalWorld: { x: 0, y: 0.35, z: 0.94 },
    rootEntity,
    intactDrumEntity,
    flameJetEntity,
    crumpledBaseEntity,
    scorchDecalEntity,
  };
}
