import * as pc from 'playcanvas';
import type { EnemyArchetypeId, Vec3Like } from '../../../contracts/ballistics.ts';
import { getArchetypeWeaponAssetId, type GlbModelRegistry } from '../../assets/glbLoader.ts';
import type { GibChunk } from './goreTypes.ts';

export function spawnDetachedHeadgearProp(
  fxRoot: pc.Entity,
  gibChunks: GibChunk[],
  glbRegistry: GlbModelRegistry | null,
  archetype: EnemyArchetypeId,
  worldPos: Vec3Like,
  shotDir: Vec3Like,
): void {
  let prop: pc.Entity | null = null;
  if (glbRegistry && glbRegistry.isLoaded('ghoul_combatant')) {
    prop = glbRegistry.instantiateDetachedHeadgearProp(archetype);
  }
  if (!prop) {
    // GLB-only: headless/mock fallback root entity ensuring exact name expected by tests
    prop = new pc.Entity(`DetachedHeadgear_${archetype}`);
  } else {
    prop.name = `DetachedHeadgear_${archetype}`;
  }

  prop.setPosition(worldPos.x, worldPos.y, worldPos.z);
  fxRoot.addChild(prop);

  const vx = shotDir.x * 4.5 + (Math.random() - 0.5) * 2.2;
  const vy = 3.2 + Math.random() * 2.0;
  const vz = shotDir.z * 4.5 + (Math.random() - 0.5) * 2.2;

  gibChunks.push({
    entity: prop,
    position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
    velocity: new pc.Vec3(vx, vy, vz),
    angularVelocity: new pc.Vec3(
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 18,
    ),
    bounces: 0,
    life: 0,
    maxLife: 24.0,
    leavesBlood: false,
    restHeight: 0.03,
  });
}

export function spawnDroppedWeaponProp(
  fxRoot: pc.Entity,
  gibChunks: GibChunk[],
  glbRegistry: GlbModelRegistry | null,
  archetype: EnemyArchetypeId,
  worldPos: Vec3Like,
  inheritedVel: Vec3Like,
): pc.Entity {
  let gun: pc.Entity | null = null;
  const weaponId = getArchetypeWeaponAssetId(archetype);
  if (glbRegistry && glbRegistry.isLoaded(weaponId)) {
    const inst = glbRegistry.instantiateWeapon(weaponId, {
      castShadows: true,
      receiveShadows: true,
    });
    if (inst.animComponent) {
      inst.animComponent.playing = false;
    }
    gun = inst.rootEntity;
  }
  if (!gun) {
    // GLB-only: headless fallback root entity without procedural mesh builder
    gun = new pc.Entity(`DroppedWeapon_${weaponId}`);
  }

  gun.setPosition(worldPos.x, worldPos.y, worldPos.z);
  fxRoot.addChild(gun);

  const vx = inheritedVel.x * 0.45 + (Math.random() - 0.5) * 2.2;
  const vy = Math.max(1.2, inheritedVel.y * 0.35 + 1.4);
  const vz = inheritedVel.z * 0.45 + (Math.random() - 0.5) * 2.2 + 0.8;

  gibChunks.push({
    entity: gun,
    position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
    velocity: new pc.Vec3(vx, vy, vz),
    angularVelocity: new pc.Vec3(
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 12,
      6 + Math.random() * 6,
    ),
    bounces: 0,
    life: 0,
    maxLife: 30.0,
    leavesBlood: false,
    restHeight: 0.04,
  });
  return gun;
}
