/**
 * Losing the gun is a rare, memorable moment, not the default result of an arm hit. Fighters grip
 * through pain, swap hands, or keep shooting one-handed with a bad arm. These odds decide when a
 * wound actually takes the weapon away. Severed arms are not rolled: an arm that is gone drops it.
 */
export const WEAPON_DROP_CHANCE = {
  /** A round straight into the hand on the grip. */
  GRIP_HAND_HIT: 0.25,
  /** Gun-arm bone shattered by the shot. */
  SHATTERED_GRIP_ARM: 0.2,
  /** Arm bone fractured (from the internal march). */
  ARM_FRACTURE: 0.12,
  /** Brachial plexus cut: the arm's nerves gone. */
  ARM_NERVE_SEVERED: 0.2,
} as const;

/**
 * True when this wound takes the arm (and the gun) out of the fight. With no random source the old
 * deterministic rule applies (every such wound disarms), which keeps headless tests stable.
 */
export function rollsWeaponDrop(roll: number | null, chance: number): boolean {
  return roll === null || roll < chance;
}
