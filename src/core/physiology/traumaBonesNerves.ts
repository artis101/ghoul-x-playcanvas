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
import { WEAPON_DROP_CHANCE, rollsWeaponDrop } from '../combatant/weaponDropRoll.ts';
import { nextPhysiologyRoll } from './physiologyVariance.ts';

/**
 * A wounded arm usually keeps working, badly: heavy sway, but the gun stays up. Only on a rare roll
 * does the arm go out, and with it the weapon if it is the trigger hand.
 */
function woundArm(
  state: PhysiologicalEntityState,
  side: 'RIGHT' | 'LEFT',
  sway: number,
  dropChance: number
): boolean {
  state.aimSwayMultiplier = Math.min(6.0, Math.max(state.aimSwayMultiplier, sway));
  // Above the red band, or with only the sidearm left in hand, the arm is fought through.
  if (state.armOutRollsAllowed === false) return false;
  if (!rollsWeaponDrop(nextPhysiologyRoll(state), dropChance)) return false;
  if (side === 'RIGHT') state.rightArmFunctional = false;
  else state.leftArmFunctional = false;
  if (state.dominantHand === side) {
    state.weaponDropped = true;
    state.canPullTrigger = false;
  }
  return true;
}

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
      case 'FEMUR_RIGHT':
        state.rightLegFunctional = false;
        state.canStand = false;
        reaction = escalatePostureReaction(reaction, 'LEG_COLLAPSE_PRONE');
        break;
      case 'FEMUR_LEFT':
        state.leftLegFunctional = false;
        state.canStand = false;
        reaction = escalatePostureReaction(reaction, 'LEG_COLLAPSE_PRONE');
        break;
      case 'PELVIS':
      case 'SPINE_THORACIC':
      case 'SPINE_LUMBAR':
        state.rightLegFunctional = false;
        state.leftLegFunctional = false;
        state.canStand = false;
        reaction = escalatePostureReaction(reaction, 'LEG_COLLAPSE_PRONE');
        break;
      case 'SPINE_CERVICAL':
        state.rightLegFunctional = false;
        state.leftLegFunctional = false;
        state.canStand = false;
        if (bt.positionLocal.y >= 1.54 || bt.shattered) {
          state.rightArmFunctional = false;
          state.leftArmFunctional = false;
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
      case 'HUMERUS_RIGHT':
      case 'RADIUS_ULNA_RIGHT':
        if (woundArm(state, 'RIGHT', 4.4, WEAPON_DROP_CHANCE.ARM_FRACTURE)) {
          reaction = escalatePostureReaction(reaction, 'WEAPON_WRENCH_DROP');
        }
        break;
      case 'HUMERUS_LEFT':
      case 'RADIUS_ULNA_LEFT':
        if (woundArm(state, 'LEFT', 4.8, WEAPON_DROP_CHANCE.ARM_FRACTURE)) {
          reaction = escalatePostureReaction(reaction, 'WEAPON_WRENCH_DROP');
        }
        break;
      default:
        break;
    }
  }

  for (const nv of nervesSevered) {
    state.severedNerves.add(nv);
    painSpike += 0.48;
    // Other nerve cuts flinch the body as before; arm nerves only when the arm actually goes out.
    let armOut = nv !== 'BRACHIAL_PLEXUS_RIGHT' && nv !== 'BRACHIAL_PLEXUS_LEFT';
    if (nv === 'BRACHIAL_PLEXUS_RIGHT') {
      armOut = woundArm(state, 'RIGHT', 4.6, WEAPON_DROP_CHANCE.ARM_NERVE_SEVERED);
    } else if (nv === 'BRACHIAL_PLEXUS_LEFT') {
      armOut = woundArm(state, 'LEFT', 5.2, WEAPON_DROP_CHANCE.ARM_NERVE_SEVERED);
    }
    if (armOut) {
      reaction = escalatePostureReaction(reaction, 'WEAPON_WRENCH_DROP');
    }
  }

  return { reaction, vocal, painSpike };
}
