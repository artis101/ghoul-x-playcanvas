/**
 * Where a combatant's health bar turns red. The world plates and the target card colour the bar by
 * triage status (`computeCombatantTriageStatus`), and MORTALLY_WOUNDED, the red band, starts at or
 * below this fraction of max HP (heavy bleeding, a vital organ or a lost limb also turn it red).
 * The weapon-drop rules (`src/core/combatant/hitDisarmPolicy.ts`) use the same band, so a fighter
 * only loses its gun to a hit once the player can see its bar is red.
 */
export const RED_HEALTH_HP_FRACTION = 0.32;
