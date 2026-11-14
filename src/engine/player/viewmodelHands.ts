import * as pc from 'playcanvas';
import type { WeaponGlbInstance } from '../assets/glbLoader.ts';

const armTemplates = new WeakMap<pc.ContainerResource, pc.Entity>();

function getArmTemplate(container: pc.ContainerResource): pc.Entity {
  let template = armTemplates.get(container);
  if (!template) {
    template = container.instantiateRenderEntity({ castShadows: false, receiveShadows: true });
    template.enabled = false;
    armTemplates.set(container, template);
  }
  return template;
}

// The template is never rendered; its meshes and materials are shared, and only the 1-2 arms a weapon uses get entities.
function createArmEntity(template: pc.Entity, nodeName: string): pc.Entity | null {
  const source = template.findByName(nodeName) as pc.Entity | null;
  const render = source?.render;
  if (!render) return null;
  const meshInstances: pc.MeshInstance[] = [];
  for (const mi of render.meshInstances) {
    if (mi.mesh && mi.material) meshInstances.push(new pc.MeshInstance(mi.mesh, mi.material));
  }
  if (meshInstances.length === 0) return null;
  const arm = new pc.Entity(nodeName);
  arm.addComponent('render', {
    meshInstances,
    castShadows: false,
    receiveShadows: true,
  });
  return arm;
}

export function mountViewmodelHands(weapon: WeaponGlbInstance, container: pc.ContainerResource | null): void {
  if (!container) return;

  const template = getArmTemplate(container);
  const grenade = weapon.weaponId === 'frag_grenade';

  function attach(side: 'r' | 'l', boneName: string): void {
    const arm = createArmEntity(template, `${weapon.weaponId}_${side}`);
    if (!arm) return;

    const bone = weapon.boneNodes.get(boneName) ?? weapon.rootEntity;
    // The GLB poses are authored in weapon space. Preserve that alignment at the bone's bind pose.
    const relative = new pc.Mat4().invert(bone.getWorldTransform()).mul(weapon.rootEntity.getWorldTransform());
    bone.addChild(arm);
    arm.setLocalPosition(relative.getTranslation());
    arm.setLocalRotation(new pc.Quat().setFromMat4(relative));
    arm.setLocalScale(relative.getScale());
  }

  attach('r', grenade ? 'Bone_Body' : 'Bone_Root');
  if (!grenade) attach('l', weapon.weaponId === 'm590_shotgun' ? 'Bone_Pump' : 'Bone_Root');
}
