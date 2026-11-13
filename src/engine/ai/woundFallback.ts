import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';

/** Health fractions at which a hurt combatant breaks contact and moves to fresh cover. */
const FALLBACK_HP_TIERS = [0.7, 0.4] as const;
/** How long it stays down behind the new cover before it starts peeking and shooting again. */
const FALLBACK_SHELTER_S = 1.8;

/**
 * Hardened fighters do not fold when hit: each time a wound takes them past a health tier they
 * pull back to other cover, patch up for a moment, then get back in the fight. Berserkers never
 * fall back. Returns true while the combatant is sheltering after a fall-back.
 */
export function stepWoundFallback(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  ctx: TacticalFsmContext,
): boolean {
  if (agent.resolveProfile === 'FANATIC_BERSERKER') return false;

  const hpFrac = hs.maxHp > 0 ? hs.currentHp / hs.maxHp : 1;
  let tier = 0;
  for (const threshold of FALLBACK_HP_TIERS) if (hpFrac < threshold) tier++;

  if (tier > (agent.woundFallbackTier ?? 0)) {
    agent.woundFallbackTier = tier;
    agent.woundFallbackTimerS = FALLBACK_SHELTER_S;
    if (ctx.hasCoverQueries && ctx.tryRelocateCoverAnchor?.(hs, agent)) {
      ctx.onAgentCoverRetreat?.(hs, agent);
    }
  }

  const remaining = agent.woundFallbackTimerS ?? 0;
  if (remaining <= 0) return false;
  agent.woundFallbackTimerS = Math.max(0, remaining - dt);
  return true;
}
