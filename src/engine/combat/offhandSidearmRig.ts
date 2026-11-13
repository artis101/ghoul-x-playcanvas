import * as pc from 'playcanvas';
import type { GlbModelRegistry, WeaponGlbInstance } from '../assets/glbLoader.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import { createPropAttachmentState } from '../mannequin/propAttachmentState.ts';
import { CombatantWeaponHands } from '../mannequin/combatantWeaponHands.ts';
import type { OffhandSidearmRig } from './offhandSidearmTypes.ts';
import { BACKUP_SIDEARM_WEAPON_ID } from '../ai/archetypeTuning.ts';

export function createOffhandSidearmRig(
  target: GhoulMannequinEntity,
  glbRegistry: GlbModelRegistry | null
): OffhandSidearmRig {
  const id = target.healthState.targetId;
  const holderEntity = new pc.Entity('OffhandBackupHandgun');
  holderEntity.enabled = false;
  target.rootEntity.addChild(holderEntity);

  let glbInstance: WeaponGlbInstance | null = null;
  let isGlbModel = false;
  const clonedMaterials: pc.StandardMaterial[] = [];

  // The backup handgun is a Silver Talon .50 AE, the same model the punks carry as their primary.
  if (glbRegistry) {
    try {
      glbInstance = glbRegistry.instantiateWeapon(BACKUP_SIDEARM_WEAPON_ID, {
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
  }

  return {
    targetId: id,
    holderEntity,
    glbInstance,
    hands: glbInstance ? new CombatantWeaponHands(glbInstance) : undefined,
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
    rig.hands = undefined;
  }
  rig.holderEntity.destroy();
  rig.cachedBoneEntities.clear();
}
