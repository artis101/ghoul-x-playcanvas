/**
 * Planted footwork: soldiers move, stop, then shoot.
 *
 * A combatant's movement goal is recomputed every frame from cover probes, the juke, the player's
 * position and so on. Small changes in those inputs used to keep a standing combatant shuffling
 * a few centimetres at a time, which restarted the walk clip over and over. This module holds the
 * goal still once the combatant has planted its feet, and only lets it go when the new goal is a
 * real move (beyond a dead band). It also tracks how long the combatant has stood still, so the
 * engagement step can hold fire until the weapon has settled on target.
 */

import type { AlertedEngagementSubstate, TacticalResolveKind } from './tacticalDoctrine.ts';

/** Once planted, a new goal closer than this to the held one is ignored. */
export const FOOTWORK_DEADBAND_M = 0.32;
/** Below this ground speed a combatant counts as standing still. */
const STATIONARY_SPEED_MS = 0.25;

export interface PlantedFootworkState {
  goalX: number;
  goalZ: number;
  hasGoal: boolean;
  /** Time the combatant has stood still, in seconds; 0 while it is moving. */
  plantedS: number;
}

export function createPlantedFootworkState(): PlantedFootworkState {
  return { goalX: 0, goalZ: 0, hasGoal: false, plantedS: 0 };
}

/**
 * Returns the goal to walk to this frame. While moving, the goal follows the desired spot
 * exactly so approaches stay smooth; once planted, it only moves for a change bigger than the
 * dead band.
 */
export function holdFootworkGoal(
  state: PlantedFootworkState,
  desiredX: number,
  desiredZ: number,
  deadbandM: number = FOOTWORK_DEADBAND_M
): { readonly x: number; readonly z: number } {
  const drift = state.hasGoal ? Math.hypot(desiredX - state.goalX, desiredZ - state.goalZ) : Infinity;
  if (state.plantedS <= 0 || drift > deadbandM) {
    state.goalX = desiredX;
    state.goalZ = desiredZ;
    state.hasGoal = true;
  }
  return { x: state.goalX, z: state.goalZ };
}

/** Records how far the combatant actually moved this frame. */
export function recordFootworkMotion(state: PlantedFootworkState, movedM: number, dt: number): void {
  if (dt <= 0) return;
  state.plantedS = movedM / dt < STATIONARY_SPEED_MS ? state.plantedS + dt : 0;
}

/**
 * How long a combatant must stand still before it opens fire: the time to shoulder the weapon
 * and settle the sights. Panicked shooters barely aim; snipers take their time.
 */
export function aimSettleTimeS(resolveProfile: TacticalResolveKind, isSniper: boolean): number {
  if (isSniper) return 0.45;
  switch (resolveProfile) {
    case 'HARDENED_VETERAN':
      return 0.26;
    case 'GRITTY_REGULAR':
      return 0.36;
    case 'PANICKED_SCRAPPER':
      return 0.14;
    case 'FANATIC_BERSERKER':
      return 0.1;
  }
}

/** Assaulting substates shoot while moving; everyone else plants first. */
export function firesOnTheMove(substate: AlertedEngagementSubstate): boolean {
  return (
    substate === 'BERSERKER_CHARGE' ||
    substate === 'FLANKING_RUSH' ||
    substate === 'JUGGERNAUT_PRESS' ||
    substate === 'PANIC_SCRAMBLE' ||
    substate === 'EVASIVE_BACKPEDAL'
  );
}
