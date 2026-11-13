import type { TargetHealthState } from '../../../contracts/ballistics.ts';
import { createSeededRng, hashStringSeed } from '../../random/seededRng.ts';

/** Chance a hard-hit (not severed) leg buckles under the fighter. */
const LEG_GIVES_WAY_CHANCE = 0.55;

/** Seeded per combatant and wound, so a replayed shot agrees. */
export function legGivesWay(target: TargetHealthState, side: 'R' | 'L'): boolean {
  const roll = createSeededRng(hashStringSeed(`${target.targetId}:${side}:${target.currentHp.toFixed(2)}`))();
  return roll < LEG_GIVES_WAY_CHANCE;
}
