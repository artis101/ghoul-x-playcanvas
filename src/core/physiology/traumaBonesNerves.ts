import {
  BoneTraumaRecord,
  ImmediatePostureReaction,
  NerveSegmentId,
  PhysiologicalEntityState,
  VocalTraumaCue,
} from '../../contracts/physiology.ts';
import {
  escalatePostureReaction,
  transitionVitalState,
} from './physiologyLifecycleFsm.ts';

export function applyBoneAndNerveTrauma(
  state: PhysiologicalEntityState,
  boneTrauma: readonly BoneTraumaRecord[],
  nervesSevered: readonly NerveSegmentId[],
  currentReaction: ImmediatePostureReaction,
  currentVocal: VocalTraumaCue
): { reaction: ImmediatePostureReaction; vocal: VocalTraumaCue; painSpike: number } {
  let reaction = currentReaction;
  let vocal = currentVocal;
  let painSpike = 0;

  for (const bt of boneTrauma) {
    if (!bt.fractured) continue;
    state.fracturedBones.add(bt.boneId);
    if (bt.shattered) {
      state.shatteredBones.add(bt.boneId);
    }
    painSpike += bt.shattered ? 0.62 : 0.45;

    switch (bt.boneId) {
      case 'FEMUR_LEFT':
        state.leftLegFunctional = false;
        state.canStand = false;
        reaction = escalatePostureReaction(reaction, 'LEG_COLLAPSE_PRONE');
        break;
      case 'FEMUR_RIGHT':
        state.rightLegFunctional = false;
        state.canStand = false;
        reaction = escalatePostureReaction(reaction, 'LEG_COLLAPSE_PRONE');
        break;
      case 'PELVIS':
      case 'SPINE_THORACIC':
      case 'SPINE_LUMBAR':
        state.leftLegFunctional = false;
        state.rightLegFunctional = false;
        state.canStand = false;
        reaction = escalatePostureReaction(reaction, 'LEG_COLLAPSE_PRONE');
        break;
      case 'SPINE_CERVICAL':
        state.leftLegFunctional = false;
        state.rightLegFunctional = false;
        state.canStand = false;
        if (bt.positionLocal.y >= 1.54 || bt.shattered) {
          state.leftArmFunctional = false;
          state.rightArmFunctional = false;
          state.weaponDropped = true;
          state.canPullTrigger = false;
          state.diaphragmIntegrity = 0;
          transitionVitalState(state, {
            kind: 'LETHAL_ARREST',
            cause: 'HIGH_CERVICAL_TRANSECTION',
          });
          reaction = escalatePostureReaction(reaction, 'NEUROGENIC_DROP');
          vocal = 'NONE';
        } else {
          state.locomotionMode = 'PARALYZED';
          state.aimSwayMultiplier = Math.max(state.aimSwayMultiplier, 4.8);
          reaction = escalatePostureReaction(reaction, 'LEG_COLLAPSE_PRONE');
        }
        break;
      case 'HUMERUS_LEFT':
      case 'RADIUS_ULNA_LEFT':
        state.leftArmFunctional = false;
        state.aimSwayMultiplier = Math.min(6.0, Math.max(state.aimSwayMultiplier, 4.4));
        if (state.dominantHand === 'LEFT') {
          state.weaponDropped = true;
          state.canPullTrigger = false;
        }
        reaction = escalatePostureReaction(reaction, 'WEAPON_WRENCH_DROP');
        break;
      case 'HUMERUS_RIGHT':
      case 'RADIUS_ULNA_RIGHT':
        state.rightArmFunctional = false;
        state.aimSwayMultiplier = Math.min(6.0, Math.max(state.aimSwayMultiplier, 4.8));
        if (state.dominantHand === 'RIGHT') {
          state.weaponDropped = true;
          state.canPullTrigger = false;
        }
        reaction = escalatePostureReaction(reaction, 'WEAPON_WRENCH_DROP');
        break;
      default:
        break;
    }
  }

  for (const nv of nervesSevered) {
    state.severedNerves.add(nv);
    painSpike += 0.48;
    if (nv === 'BRACHIAL_PLEXUS_LEFT') {
      state.leftArmFunctional = false;
      state.aimSwayMultiplier = Math.min(6.0, Math.max(state.aimSwayMultiplier, 4.6));
      if (state.dominantHand === 'LEFT') {
        state.weaponDropped = true;
        state.canPullTrigger = false;
      }
    } else if (nv === 'BRACHIAL_PLEXUS_RIGHT') {
      state.rightArmFunctional = false;
      state.aimSwayMultiplier = Math.min(6.0, Math.max(state.aimSwayMultiplier, 5.2));
      if (state.dominantHand === 'RIGHT') {
        state.weaponDropped = true;
        state.canPullTrigger = false;
      }
    }
    reaction = escalatePostureReaction(reaction, 'WEAPON_WRENCH_DROP');
  }

  return { reaction, vocal, painSpike };
}
