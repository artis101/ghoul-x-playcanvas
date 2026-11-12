import * as pc from 'playcanvas';
import type { GlbModelRegistry, WeaponGlbInstance } from '../assets/glbLoader.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import { createPropAttachmentState } from '../mannequin/propAttachmentState.ts';
import type { OffhandSidearmRig } from './offhandSidearmTypes.ts';

export function createOffhandSidearmRig(
  target: GhoulMannequinEntity,
  glbRegistry: GlbModelRegistry | null
): OffhandSidearmRig {
  const id = target.healthState.targetId;
  const holderEntity = new pc.Entity('OffhandBackupHandgun_M9');
  holderEntity.enabled = false;
  target.rootEntity.addChild(holderEntity);

  let glbInstance: WeaponGlbInstance | null = null;
  let isGlbModel = false;
  const clonedMaterials: pc.StandardMaterial[] = [];

  if (glbRegistry) {
    try {
      glbInstance = glbRegistry.instantiateWeapon('weapon_beretta_m9', {
        castShadows: true,
        receiveShadows: true,
      });
      if (glbInstance.animComponent) {
        glbInstance.animComponent.playing = false;
      }
      holderEntity.addChild(glbInstance.rootEntity);
      isGlbModel = true;
    } catch {
      glbInstance = null;
    }

    if (!glbInstance && glbRegistry.isLoaded('silver_talon_50ae')) {
      try {
        glbInstance = glbRegistry.instantiateWeapon('silver_talon_50ae', {
          castShadows: true,
          receiveShadows: true,
        });
        if (glbInstance.animComponent) {
          glbInstance.animComponent.playing = false;
        }
        glbInstance.rootEntity.setLocalScale(0.76, 0.78, 0.76);
        const renders = glbInstance.rootEntity.findComponents('render') as pc.RenderComponent[];
        for (const rc of renders) {
          for (const mi of rc.meshInstances) {
            if (mi.material instanceof pc.StandardMaterial) {
              const darkM9Mat = mi.material.clone();
              darkM9Mat.diffuse = new pc.Color(0.14, 0.15, 0.17);
              darkM9Mat.metalness = Math.min(0.86, darkM9Mat.metalness);
              darkM9Mat.gloss = 0.58;
              darkM9Mat.update();
              mi.material = darkM9Mat;
              clonedMaterials.push(darkM9Mat);
            }
          }
        }
        holderEntity.addChild(glbInstance.rootEntity);
        isGlbModel = true;
      } catch {
        glbInstance = null;
      }
    }
  }

  return {
    targetId: id,
    holderEntity,
    glbInstance,
    isGlbModel,
    attachmentState: createPropAttachmentState('HIDDEN_TEMP'),
    wasHeldLastFrame: false,
    lastHand: null,
    clonedMaterials,
    cachedBoneEntities: new Map(),
  };
}

export function destroyOffhandSidearmRig(rig: OffhandSidearmRig): void {
  for (const m of rig.clonedMaterials) m.destroy();
  rig.clonedMaterials.length = 0;
  if (rig.glbInstance) {
    rig.glbInstance.destroy();
    rig.glbInstance = null;
  }
  rig.holderEntity.destroy();
  rig.cachedBoneEntities.clear();
}
