import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { AlertedEngagementSubstate } from '../../core/ai/tacticalDoctrine.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';
import { hashCombatantTargetId } from './archetypeTuning.ts';

/** Each time a fighter loses this share of its health it breaks contact and moves to fresh cover. */
const FALLBACK_HP_STEP = 0.2;
/** How long it stays down behind the new cover before it starts peeking and shooting again. */
const FALLBACK_SHELTER_S = 1.8;
/** A dying fighter lying in ambush springs it when the player closes to this range... */
const AMBUSH_SPRING_RANGE_M = 7.0;
/** ...or once it has waited this long. */
const AMBUSH_MAX_WAIT_S = 10.0;

/**
 * How a wounded fighter on adrenaline behaves, layered over its normal doctrine:
 * - Hurt: every fresh 20% of health lost, it pulls back to other cover for a moment, then fights on.
 * - Mortally wounded: it commits once. Veterans (and some regulars) hole up behind cover and wait
 *   to ambush the player at close range; berserkers (and the other regulars) make a last stand,
 *   pushing at the player and firing with whatever they still hold, the sidearm if the gun is gone.
 * Returns the substate to force, or null to leave the doctrine's choice alone.
 */
export function stepWoundedBehaviour(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerDistM: number,
  ctx: TacticalFsmContext,
): AlertedEngagementSubstate | null {
  if (agent.triageStatus === 'MORTALLY_WOUNDED') {
    return stepMortalChoice(dt, hs, agent, playerDistM, ctx);
  }
  return stepHurtFallback(dt, hs, agent, ctx) ? 'COVER_SHELTER' : null;
}

function stepHurtFallback(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  ctx: TacticalFsmContext,
): boolean {
  if (agent.resolveProfile === 'FANATIC_BERSERKER') return false;

  const mark = agent.woundFallbackHpMark ?? hs.maxHp;
  if (hs.currentHp <= mark - hs.maxHp * FALLBACK_HP_STEP) {
    agent.woundFallbackHpMark = hs.currentHp;
    agent.woundFallbackTimerS = FALLBACK_SHELTER_S;
    relocate(hs, agent, ctx);
  }

  const remaining = agent.woundFallbackTimerS ?? 0;
  if (remaining <= 0) return false;
  agent.woundFallbackTimerS = Math.max(0, remaining - dt);
  return true;
}

function stepMortalChoice(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerDistM: number,
  ctx: TacticalFsmContext,
): AlertedEngagementSubstate | null {
  if (!agent.mortalWoundMode) {
    const prefersAmbush =
      agent.resolveProfile === 'HARDENED_VETERAN' ||
      (agent.resolveProfile === 'GRITTY_REGULAR' && hashCombatantTargetId(hs.targetId) % 2 === 0);
    agent.mortalWoundMode = prefersAmbush ? 'AMBUSH_HOLD' : 'LAST_STAND';
    agent.mortalHoldTimerS = 0;
    if (prefersAmbush) relocate(hs, agent, ctx);
  }

  switch (agent.mortalWoundMode) {
    case 'AMBUSH_HOLD': {
      agent.mortalHoldTimerS = (agent.mortalHoldTimerS ?? 0) + dt;
      if (playerDistM <= AMBUSH_SPRING_RANGE_M || agent.mortalHoldTimerS >= AMBUSH_MAX_WAIT_S) {
        agent.mortalWoundMode = 'AMBUSH_SPRUNG';
        return 'COVER_PEEK';
      }
      return 'COVER_SHELTER';
    }
    case 'AMBUSH_SPRUNG':
      return 'COVER_PEEK';
    case 'LAST_STAND':
      return 'BERSERKER_CHARGE';
  }
}

function relocate(hs: TargetHealthState, agent: EnemyAiAgentRuntime, ctx: TacticalFsmContext): void {
  if (ctx.hasCoverQueries && ctx.tryRelocateCoverAnchor?.(hs, agent)) {
    ctx.onAgentCoverRetreat?.(hs, agent);
  }
}
