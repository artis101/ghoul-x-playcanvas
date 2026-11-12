import { describe, expect, it } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { evaluateCrawlCondition } from '../src/core/ghoul/anatomy/crawlCondition.ts';

function downed() {
  const state = createTargetHealthState('crawler', 'Crawler', { x: 0, y: 0, z: 0 }, 0, 'MILITIA_GUNNER');
  state.rightLegFunctional = false;
  return state;
}

/** Share of a long stretch of time spent moving, and the mean effort while moving. */
function sample(state: ReturnType<typeof downed>) {
  let moving = 0;
  let effort = 0;
  const steps = 2000;
  for (let i = 0; i < steps; i++) {
    const condition = evaluateCrawlCondition(state, i * 0.05);
    if (!condition.resting) {
      moving++;
      effort += condition.effort;
    }
  }
  return { movingShare: moving / steps, effort: moving ? effort / moving : 0 };
}

describe('wounded crawl', () => {
  it('drags only the crippled leg, and not one that has been severed', () => {
    const state = downed();
    expect(evaluateCrawlCondition(state, 0)).toMatchObject({ dragRightLeg: true, dragLeftLeg: false });
    state.severedZones.add('THIGH_RIGHT');
    expect(evaluateCrawlCondition(state, 0).dragRightLeg).toBe(false);
  });

  it('slows down, rests longer and lets the head hang as wounds mount', () => {
    const fresh = downed();
    const dying = downed();
    dying.currentHp = dying.maxHp * 0.15;
    dying.painShock = 0.8;
    dying.leftArmFunctional = false;
    const strong = sample(fresh);
    const weak = sample(dying);
    expect(weak.effort).toBeLessThan(strong.effort * 0.5);
    expect(weak.movingShare).toBeLessThan(strong.movingShare - 0.2);
    expect(evaluateCrawlCondition(dying, 1).headDroop).toBeGreaterThan(evaluateCrawlCondition(fresh, 1).headDroop + 0.3);
  });

  it('cannot move at all without a working arm', () => {
    const state = downed();
    state.rightArmFunctional = false;
    state.leftArmFunctional = false;
    expect(sample(state).effort).toBe(0);
    expect(evaluateCrawlCondition(state, 3).effort).toBe(0);
  });
});
