import type { TargetHealthState } from '../../../contracts/ballistics.ts';
import {
  DelayedLethality,
  NEUTRAL_CONSTITUTION,
} from '../../../contracts/combatantConstitution.ts';
import { createSeededRng, mixSeed, rollRange } from '../../random/seededRng.ts';

/** Salt so the lethality roll does not reuse a pellet's draws. */
const LETHALITY_SALT = 0x1e7a1;

/** Ceiling on the chance to fight on, however tough: some wounds just drop people. */
const MAX_DELAY_CHANCE = 0.8;

export interface LethalityRollInput {
  readonly target: TargetHealthState;
  /** 1 plus the damage beyond what was needed to kill, in units of max HP; 1 is a bare kill, 2 a ruinous one. */
  readonly overkillRatio: number;
  readonly heartRuptured: boolean;
}

/**
 * Decides whether a fatal hit kills now or leaves the combatant fighting on for a few seconds:
 * a heart shot that lets them empty a magazine, a liver shot that takes ten seconds to fold them.
 * Only for hits that kill through accumulated trauma; destroyed brains, severed necks and the like
 * never reach this. Returns null (kill now) when the target has no variance seed.
 */
export function rollDelayedLethality(input: LethalityRollInput): DelayedLethality | null {
  const { target, overkillRatio, heartRuptured } = input;
  if (target.shotVarianceSeed === undefined) return null;
  if (target.currentHp < 2) return null;

  const constitution = target.constitution ?? NEUTRAL_CONSTITUTION;
  const rng = createSeededRng(mixSeed(target.shotVarianceSeed, LETHALITY_SALT));

  const overkillPenalty = Math.max(0, overkillRatio - 1) * 0.45;
  const base = heartRuptured ? 0.6 : 0.5;
  const chance = Math.min(MAX_DELAY_CHANCE, Math.max(0, base * constitution.willToLive - overkillPenalty));
  if (rng() >= chance) return null;

  const window = heartRuptured ? rollRange(rng, 3, 9) : rollRange(rng, 4, 12);
  const delayS = Math.min(16, Math.max(2, window * constitution.willToLive));
  return {
    delayS,
    cause: heartRuptured ? 'CARDIAC_DESTRUCTION' : 'EXSANGUINATION_CLASS_IV_ARREST',
  };
}

/** HP a combatant keeps while living on borrowed time: enough to read as dying, never zero. */
export function borrowedTimeHp(target: TargetHealthState): number {
  return Math.max(1, Math.min(target.currentHp - 1, target.maxHp * 0.08));
}
