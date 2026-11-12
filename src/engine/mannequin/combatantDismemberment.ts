import type { GhoulZoneId, TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import { add, scale } from '../../core/ballistics/vec3.ts';
import {
  createPropAttachmentState,
  transitionPropAttachment,
  type PropAttachmentState,
} from './propAttachmentState.ts';
import type { ZoneMeshBundle } from './types.ts';

const PARENT_ZONE_MAP: Partial<Record<GhoulZoneId, GhoulZoneId>> = {
  HEAD_CRANIUM: 'NECK_CERVICAL',
  HEAD_FACE_JAW: 'HEAD_CRANIUM',
  NECK_CERVICAL: 'TORSO_UPPER_THORAX',
  TORSO_UPPER_THORAX: 'TORSO_LOWER_ABDOMEN',
  TORSO_LOWER_ABDOMEN: 'PELVIS_GROIN',
  SHOULDER_LEFT: 'TORSO_UPPER_THORAX',
  UPPER_ARM_LEFT: 'SHOULDER_LEFT',
  FOREARM_LEFT: 'UPPER_ARM_LEFT',
  HAND_LEFT: 'FOREARM_LEFT',
  SHOULDER_RIGHT: 'TORSO_UPPER_THORAX',
  UPPER_ARM_RIGHT: 'SHOULDER_RIGHT',
  FOREARM_RIGHT: 'UPPER_ARM_RIGHT',
  HAND_RIGHT: 'FOREARM_RIGHT',
  THIGH_LEFT: 'PELVIS_GROIN',
  KNEE_LEFT: 'THIGH_LEFT',
  SHIN_LEFT: 'KNEE_LEFT',
  FOOT_LEFT: 'SHIN_LEFT',
  THIGH_RIGHT: 'PELVIS_GROIN',
  KNEE_RIGHT: 'THIGH_RIGHT',
  SHIN_RIGHT: 'KNEE_RIGHT',
  FOOT_RIGHT: 'SHIN_RIGHT',
};

export function getParentZone(zone: GhoulZoneId): GhoulZoneId | undefined {
  return PARENT_ZONE_MAP[zone];
}

export class CombatantDismemberment {
  public headgearAttachment: PropAttachmentState = createPropAttachmentState('ATTACHED');

  public reset(): void {
    this.headgearAttachment = createPropAttachmentState('ATTACHED');
  }

  public syncHeadgear(
    healthState: TargetHealthState,
    fxManager?: GoreAndBallisticsFxManager
  ): boolean {
    const isCranialPopped = healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';
    const isHeadPoppedOrSevered = isCranialPopped || healthState.severedZones.has('HEAD_CRANIUM');
    const headgearNowAttached = healthState.headgearIntact && !isHeadPoppedOrSevered;

    const transition = transitionPropAttachment(this.headgearAttachment, {
      shouldBeAttached: headgearNowAttached,
      allowReattachAfterDrop: headgearNowAttached,
    });
    this.headgearAttachment = transition.state;

    if (transition.shouldSpawnDroppedProp && fxManager) {
      const headBone = healthState.ragdollBones.HEAD_CRANIUM;
      fxManager.spawnDetachedHeadgearProp(
        healthState.archetype,
        add(headBone.position, scale(headBone.basisUp, 0.11)),
        healthState.activeReaction.hitDirectionWorld
      );
    }
    return transition.isVisible;
  }

  public syncGlbSeverances(
    glb: CombatantGlbInstance,
    healthState: TargetHealthState,
    isXRayActive: boolean
  ): void {
    const isCranialPopped = healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';
    const isEviscerated = healthState.zoneGoreMode.TORSO_LOWER_ABDOMEN === 'EVISCERATED';

    glb.setZoneVisible('HEAD_CRANIUM', !isCranialPopped);
    glb.setZoneVisible('HEAD_FACE_JAW', !isCranialPopped);
    glb.setZoneVisible('TORSO_LOWER_ABDOMEN', !isEviscerated || isXRayActive);

    if (glb.evisceratedGut) {
      glb.evisceratedGut.enabled = isEviscerated && !isXRayActive;
    }

    if (glb.internalAnatomyEntities.skeletSkull) {
      glb.internalAnatomyEntities.skeletSkull.enabled = isCranialPopped;
    }
  }

  public syncGearVisibility(
    glb: CombatantGlbInstance,
    healthState: TargetHealthState,
    isXRayActive: boolean,
    headgearAttached: boolean
  ): void {
    const arch = healthState.archetype;
    const isCranialPopped = healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';
    // Only the enforcer wears armour over his painted clothes.
    const showPlate = !isXRayActive && arch === 'HEAVY_ENFORCER';
    const showHelmet = !isXRayActive && headgearAttached && arch === 'HEAVY_ENFORCER';
    const showVisor = !isXRayActive && headgearAttached && arch === 'HEAVY_ENFORCER';
    const showBoonie = !isXRayActive && headgearAttached && arch === 'SNIPER_OPERATIVE';
    const showMohawk = !isXRayActive && !isCranialPopped && arch === 'SKINHEAD_PUNK';

    glb.setArmorVisible(showPlate, showHelmet);
    if (glb.tacticalVisor) glb.tacticalVisor.enabled = showVisor;
    if (glb.boonieHat) glb.boonieHat.enabled = showBoonie;
    if (glb.punkMohawk) glb.punkMohawk.enabled = showMohawk;
  }

  public syncStumps(zoneBundles: Map<GhoulZoneId, ZoneMeshBundle>, healthState: TargetHealthState): void {
    const isCranialPopped = healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';

    for (const [zone, bundle] of zoneBundles) {
      const isSevered = healthState.severedZones.has(zone);
      const boneState = healthState.ragdollBones[zone];

      if (bundle.proximalStumpNode) {
        const parentZone = getParentZone(zone);
        const parentComp = parentZone ? healthState.ragdollBones[parentZone].componentId : 'BODY';
        const separatedFromParent = isSevered && boneState.componentId !== parentComp;
        bundle.proximalStumpNode.enabled = separatedFromParent;
      }

      for (const socketStump of bundle.distalChildStumps) {
        const childBone = healthState.ragdollBones[socketStump.childZone];
        const childPopped = socketStump.childZone === 'HEAD_CRANIUM' && isCranialPopped;
        socketStump.node.enabled = childPopped || childBone.componentId !== boneState.componentId;
      }
    }
  }
}
