import type { CauseOfDeath, PhysiologicalEntityState } from '../../contracts/physiology.ts';
import { NEUTRAL_CONSTITUTION, type CombatantConstitution } from '../../contracts/combatantConstitution.ts';
import { createSeededRng } from '../random/seededRng.ts';

export function constitutionOf(state: PhysiologicalEntityState): CombatantConstitution {
  return state.constitution ?? NEUTRAL_CONSTITUTION;
}

/**
 * Next uniform draw from the entity's own outcome stream, or null when variance is off
 * (headless defaults), so callers keep their deterministic behaviour.
 */
export function nextPhysiologyRoll(state: PhysiologicalEntityState): number | null {
  if (state.varianceRngState === undefined) return null;
  const rng = createSeededRng(state.varianceRngState);
  const value = rng();
  // Advance the stored state the same way the generator does, so the next call draws afresh.
  state.varianceRngState = (state.varianceRngState + 0x6d2b79f5) >>> 0;
  return value;
}

/** Starts (or shortens) the countdown to death for a fatal wound that does not kill at once. */
export function startTerminalCountdown(
  state: PhysiologicalEntityState,
  delayS: number,
  cause: Exclude<CauseOfDeath, 'NONE'>
): void {
  if (!state.alive) return;
  const current = state.terminalCountdownS;
  if (current === null || current === undefined || delayS < current) {
    state.terminalCountdownS = delayS;
    state.terminalCountdownCause = cause;
  }
}

/** Advances the countdown; true when it ran out this tick. */
export function tickTerminalCountdown(state: PhysiologicalEntityState, dt: number): boolean {
  if (state.terminalCountdownS === null || state.terminalCountdownS === undefined) return false;
  state.terminalCountdownS -= dt;
  return state.terminalCountdownS <= 0;
}

/**
 * Venous and tissue bleeding slows on its own as clots form; arterial jets do not.
 * Per-second decay fraction scales with the combatant's clotting.
 */
export function clotBleedRate(state: PhysiologicalEntityState, dt: number): void {
  if (state.constitution === undefined) return;
  if (state.vascularWounds.some((w) => w.vesselKind === 'ARTERIAL')) return;
  const k = 0.02 * state.constitution.clotting;
  state.baseBleedRateMlPerSec *= Math.exp(-k * dt);
}
