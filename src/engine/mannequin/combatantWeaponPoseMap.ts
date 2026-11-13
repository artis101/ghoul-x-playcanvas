import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import { getArchetypeWeaponAssetId, type CombatantAnimationClipName, type WeaponAssetId } from '../assets/glbTypes.ts';
import { getPreferredPrimaryHand, isArmChainIntactAndFunctional } from '../ai/combatantArmEvaluation.ts';
import type { CombatantAimPose } from './combatantClipRules.ts';

/**
 * Which clips hold which gun. The same map serves a body standing still (the base layer) and a
 * body walking (the upper-body layer over the gait).
 *
 * | Gun | Arms | Carry | Aim |
 * | --- | --- | --- | --- |
 * | rifle, shotgun, sniper rifle | both | `CombatReadyIdle` | `LongGunAim` |
 * | Desert Eagle, backup pistol | both | `CombatReadyIdle` | `PistolAim` (two hands) |
 * | Desert Eagle, backup pistol | support arm gone or dead | `PistolOneHandHold` | `PistolAimOneHand` (arm out) |
 *
 * The long guns keep the support palm on the rail (combatantWeaponHands.ts). A pistol is never
 * treated as a long gun, and a one-handed pistol never sends a hand to a forend.
 */

export type HeldGunKind = 'LONG_GUN' | 'PISTOL';

export interface WeaponPose {
  readonly carry: CombatantAnimationClipName;
  readonly aim: CombatantAnimationClipName;
  /** True when both hands hold the gun. */
  readonly twoHanded: boolean;
}

const LONG_GUN_POSE: WeaponPose = { carry: 'CombatReadyIdle', aim: 'LongGunAim', twoHanded: true };
const PISTOL_TWO_HANDS: WeaponPose = { carry: 'CombatReadyIdle', aim: 'PistolAim', twoHanded: true };
const PISTOL_ONE_HAND: WeaponPose = { carry: 'PistolOneHandHold', aim: 'PistolAimOneHand', twoHanded: false };

/** Clips that hold a pistol in one hand, the other arm tucked in: no support hand, ever. */
const ONE_HAND_PISTOL_CLIPS: ReadonlySet<string> = new Set([
  'PistolOneHandHold', 'PistolAimOneHand', 'KneelPistolAimOneHand',
]);

export function gunKindOf(weaponId: WeaponAssetId): HeldGunKind {
  return weaponId === 'silver_talon_50ae' ? 'PISTOL' : 'LONG_GUN';
}

/** The carry and aim clips for a gun of `kind`, held with or without a working support arm. */
export function weaponPoseFor(kind: HeldGunKind, supportArmWorks: boolean): WeaponPose {
  if (kind === 'LONG_GUN') return LONG_GUN_POSE;
  return supportArmWorks ? PISTOL_TWO_HANDS : PISTOL_ONE_HAND;
}

/** Whether the arm opposite `gunHand` can still hold the gun. */
export function supportArmWorks(hs: TargetHealthState, gunHand: 'RIGHT' | 'LEFT'): boolean {
  return isArmChainIntactAndFunctional(hs, oppositeSide(gunHand));
}

/**
 * The pose for the gun in the hands now: a drawn backup pistol in `pistolHand`, else the primary
 * while it is still held. Null with nothing in the hands.
 */
export function heldWeaponPose(hs: TargetHealthState, pistolHand?: 'RIGHT' | 'LEFT'): WeaponPose | null {
  if (pistolHand) return weaponPoseFor('PISTOL', supportArmWorks(hs, pistolHand));
  if (hs.weaponDropped) return null;
  const kind = gunKindOf(getArchetypeWeaponAssetId(hs.archetype));
  return weaponPoseFor(kind, supportArmWorks(hs, getPreferredPrimaryHand(hs)));
}

/** True for a clip that holds a pistol in one hand only. */
export function isOneHandPistolClip(clip: string | undefined): boolean {
  return clip !== undefined && ONE_HAND_PISTOL_CLIPS.has(clip.replace(/_Southpaw$/, ''));
}

/** The aim pose for the primary gun while it is still in the hands, or undefined once dropped. */
export function primaryAimPose(hs: TargetHealthState): CombatantAimPose | undefined {
  const pose = heldWeaponPose(hs);
  if (!pose) return undefined;
  if (pose.aim === 'LongGunAim') return { clip: 'LongGunAim' };
  return { clip: pose.aim === 'PistolAimOneHand' ? 'PistolAimOneHand' : 'PistolAim' };
}
