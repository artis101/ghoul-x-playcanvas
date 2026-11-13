import type { WeaponSpec } from '../../../contracts/ballistics.ts';

/**
 * How a gun runs, shared by the player's arsenal and the enemies that carry the same guns:
 * magazine size, spare rounds, the mechanical cycle between shots, whether holding the trigger
 * keeps it firing, and how long a reload takes.
 */
export interface WeaponMagazineCapacity {
  readonly magCap: number;
  readonly reserve: number;
}

export const WEAPON_CAPACITIES: Readonly<Record<string, WeaponMagazineCapacity>> = {
  m590_shotgun: { magCap: 8, reserve: 40 },
  silver_talon_50ae: { magCap: 7, reserve: 35 },
  msg90_sniper: { magCap: 5, reserve: 25 },
  m4a1_carbine: { magCap: 30, reserve: 120 },
  // The enemies' backup pistol; the player does not carry one.
  weapon_beretta_m9: { magCap: 15, reserve: 30 },
};

export const DEFAULT_WEAPON_CAPACITY: WeaponMagazineCapacity = { magCap: 12, reserve: 48 };

export function weaponCapacity(weaponId: string): WeaponMagazineCapacity {
  return WEAPON_CAPACITIES[weaponId] ?? DEFAULT_WEAPON_CAPACITY;
}

/** Reload clips play this much faster than authored. */
export const RELOAD_ANIM_SPEED = 1.15;
/** No reload is quicker than this, whatever the clip says. */
export const MIN_RELOAD_S = 0.65;
/** Used when no reload clip is available to time against. */
export const FALLBACK_RELOAD_S = 1.0;

/** Seconds a reload takes, from the length of the weapon's reload clip. */
export function reloadDurationS(reloadClipDurationS: number): number {
  return Math.max(MIN_RELOAD_S, reloadClipDurationS / RELOAD_ANIM_SPEED);
}

/** The shortest time between two shots the action allows. */
export function fireCycleS(spec: Pick<WeaponSpec, 'fireRateRpm'>): number {
  return 60 / Math.max(1, spec.fireRateRpm);
}

/** Only the rifle keeps firing while the trigger is held; everything else is one shot per pull. */
export function isFullAuto(spec: Pick<WeaponSpec, 'role'>): boolean {
  return spec.role === 'ASSAULT_RIFLE';
}
