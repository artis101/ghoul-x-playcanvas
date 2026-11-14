import type { GhoulZoneId } from '../../contracts/ballistics.ts';

type Side = 'RIGHT' | 'LEFT';

/** Zone ids of each arm segment by side, so per-frame code looks the key up instead of building it. */
export const SHOULDER_ZONE: Readonly<Record<Side, GhoulZoneId>> = { RIGHT: 'SHOULDER_RIGHT', LEFT: 'SHOULDER_LEFT' };
export const UPPER_ARM_ZONE: Readonly<Record<Side, GhoulZoneId>> = { RIGHT: 'UPPER_ARM_RIGHT', LEFT: 'UPPER_ARM_LEFT' };
export const FOREARM_ZONE: Readonly<Record<Side, GhoulZoneId>> = { RIGHT: 'FOREARM_RIGHT', LEFT: 'FOREARM_LEFT' };
export const HAND_ZONE: Readonly<Record<Side, GhoulZoneId>> = { RIGHT: 'HAND_RIGHT', LEFT: 'HAND_LEFT' };

/** Upper arm, forearm and hand of each side, from the shoulder out. */
export const ARM_CHAIN_ZONES: Readonly<Record<Side, readonly GhoulZoneId[]>> = {
  RIGHT: ['UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 'HAND_RIGHT'],
  LEFT: ['UPPER_ARM_LEFT', 'FOREARM_LEFT', 'HAND_LEFT'],
};
