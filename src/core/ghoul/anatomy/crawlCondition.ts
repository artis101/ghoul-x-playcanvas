import type { TargetHealthState } from '../../../contracts/ballistics.ts';

/** How a downed combatant's wounds shape its crawl. */
export interface CrawlCondition {
  /** Share of full crawl speed the body can manage, 0 while it rests. */
  readonly effort: number;
  /** True while the combatant has stopped to gather strength. */
  readonly resting: boolean;
  readonly dragLeftLeg: boolean;
  readonly dragRightLeg: boolean;
  /** 0 with the head held up, 1 with it hanging. */
  readonly headDroop: number;
}

function phaseOffset(targetId: string): number {
  let sum = 0;
  for (let i = 0; i < targetId.length; i++) sum = (sum * 31 + targetId.charCodeAt(i)) % 997;
  return sum / 997;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * A useless leg is dragged. Lost limbs, blood loss and pain slow the pull and lengthen the
 * pauses between bursts of movement.
 */
export function evaluateCrawlCondition(state: TargetHealthState, clockS: number): CrawlCondition {
  const dragLeftLeg = !state.leftLegFunctional && !state.severedZones.has('THIGH_LEFT');
  const dragRightLeg = !state.rightLegFunctional && !state.severedZones.has('THIGH_RIGHT');
  const health = clamp01(state.maxHp > 0 ? state.currentHp / state.maxHp : 0);
  const pain = clamp01(state.painShock);
  const workingArms = Number(state.leftArmFunctional) + Number(state.rightArmFunctional);
  const bothLegsLost = !state.leftLegFunctional && !state.rightLegFunctional;

  let strength = 0.45 + 0.55 * health;
  strength *= 1 - 0.4 * pain;
  if (bothLegsLost) strength *= 0.75;
  if (workingArms === 1) strength *= 0.6;
  if (workingArms === 0) strength = 0;

  // Pull for a few seconds, then stop. The weaker the body, the longer the stop.
  const seed = phaseOffset(state.targetId);
  const period = 3.2 + 2 * seed;
  const restShare = Math.min(0.6, 0.08 + 0.5 * (1 - health) + 0.15 * pain + (workingArms === 1 ? 0.1 : 0));
  const resting = strength > 0 && ((clockS + seed * period) % period) / period < restShare;

  return {
    effort: resting ? 0 : strength,
    resting,
    dragLeftLeg,
    dragRightLeg,
    headDroop: clamp01(0.15 + 0.75 * (1 - health) + 0.3 * pain + (resting ? 0.35 : 0)),
  };
}
