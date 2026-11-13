import type { WeaponHoldStance } from '../../core/ghoul/anatomy/weaponHold.ts';
import type { WeaponAssetId } from '../assets/glbLoader.ts';

/** Picks the two-handed hold that suits the weapon and the body animation being played. */
export function resolveWeaponHoldStance(
  weaponId: WeaponAssetId,
  clip: string | undefined,
  guarding: boolean,
): WeaponHoldStance | null {
  if (weaponId === 'frag_grenade') return null;
  const motion = clip?.replace('_Southpaw', '');
  // The one-handed pistol aim points the gun the same way; it simply has no support hand to place.
  const aiming = motion === 'LongGunAim' || motion === 'PistolAim' || motion === 'PistolAimOneHand';
  const relaxed = guarding || motion === 'UnsuspectingIdle';
  if (weaponId === 'silver_talon_50ae') return aiming ? 'PISTOL_AIM' : relaxed ? 'PISTOL_CARRY' : 'PISTOL_READY';
  if (aiming) return 'SHOULDERED';
  return relaxed ? 'PATROL' : 'LOW_READY';
}
