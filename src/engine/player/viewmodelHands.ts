import * as pc from 'playcanvas';
import type { WeaponGlbInstance } from '../assets/glbLoader.ts';

export function mountViewmodelHands(weapon: WeaponGlbInstance, container: pc.ContainerResource | null): void {
  if (!container) return;

  const arms = container.instantiateRenderEntity({ castShadows: false, receiveShadows: true });
  const grenade = weapon.weaponId === 'frag_grenade';

  function attach(side: 'r' | 'l', boneName: string): void {
    const arm = arms.findByName(`${weapon.weaponId}_${side}`);
    if (!arm) return;

    const bone = weapon.boneNodes.get(boneName) ?? weapon.rootEntity;
    // The GLB poses are authored in weapon space. Preserve that alignment at the bone's bind pose.
    const relative = new pc.Mat4().invert(bone.getWorldTransform()).mul(weapon.rootEntity.getWorldTransform());
    arm.reparent(bone);
    arm.setLocalPosition(relative.getTranslation());
    arm.setLocalRotation(new pc.Quat().setFromMat4(relative));
    arm.setLocalScale(relative.getScale());
  }

  try {
    attach('r', grenade ? 'Bone_Body' : 'Bone_Root');
    if (!grenade) attach('l', weapon.weaponId === 'm590_shotgun' ? 'Bone_Pump' : 'Bone_Root');
  } finally {
    arms.destroy();
  }
}
