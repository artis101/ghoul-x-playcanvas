import type { GhoulZoneId } from '../../../contracts/ballistics.ts';

/** A whole limb, counted lost once any part of its chain has been cut off. */
export type LimbId = 'ARM_RIGHT' | 'ARM_LEFT' | 'LEG_RIGHT' | 'LEG_LEFT';

const LIMB_CHAINS: Readonly<Record<LimbId, readonly GhoulZoneId[]>> = {
  ARM_RIGHT: ['UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 'HAND_RIGHT'],
  ARM_LEFT: ['UPPER_ARM_LEFT', 'FOREARM_LEFT', 'HAND_LEFT'],
  LEG_RIGHT: ['THIGH_RIGHT', 'KNEE_RIGHT', 'SHIN_RIGHT', 'FOOT_RIGHT'],
  LEG_LEFT: ['THIGH_LEFT', 'KNEE_LEFT', 'SHIN_LEFT', 'FOOT_LEFT'],
};
const ALL_LIMBS = Object.keys(LIMB_CHAINS) as LimbId[];

/** The limbs a body has lost, from the zones cut off it. */
export function listLostLimbs(severed: ReadonlySet<GhoulZoneId>): LimbId[] {
  return ALL_LIMBS.filter((limb) => LIMB_CHAINS[limb].some((zone) => severed.has(zone)));
}

/**
 * Losing two limbs kills: both legs, both arms, or three or more. One arm and one leg is the
 * only pair a body survives, still able to fight on the ground with the arm it has left.
 */
export function isLimbLossFatal(severed: ReadonlySet<GhoulZoneId>): boolean {
  const lost = listLostLimbs(severed);
  if (lost.length < 2) return false;
  if (lost.length > 2) return true;
  const arms = lost.filter((limb) => limb.startsWith('ARM')).length;
  return arms !== 1;
}
