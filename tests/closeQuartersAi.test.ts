import { describe, expect, it } from 'vitest';
import { computeAimThreat } from '../src/core/ai/aimThreat.ts';
import { createAimDuckReflexState, stepAimDuckReflex } from '../src/core/ai/aimDuckReflex.ts';
import {
  type CloseQuartersJukeInput,
  closeQuartersStrafeWeight,
  createCloseQuartersJukeState,
  stepCloseQuartersJuke,
} from '../src/core/ai/closeQuartersStrafe.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { TacticalCombatAiSystem } from '../src/engine/ai/tacticalCombatAi.ts';
import { evaluateTacticalEngagementSubstate, type TacticalDoctrineInput } from '../src/core/ai/tacticalDoctrine.ts';
import { createPlantedFootworkState, holdFootworkGoal, recordFootworkMotion } from '../src/core/ai/plantedFootwork.ts';

const EYE = { x: 0, y: 1.65, z: 0 };

function jukeInput(overrides: Partial<CloseQuartersJukeInput> = {}): CloseQuartersJukeInput {
  return {
    dt: 1 / 60,
    playerDistanceM: 5,
    aimThreat: 0,
    wasHit: false,
    planted: true,
    lateralStalled: false,
    anchorX: 0,
    arenaHalfWidthM: 7.7,
    ...overrides,
  };
}

describe('aim threat', () => {
  it('is 1 with the crosshair on the body, 0 when looking away or behind', () => {
    const enemy = { x: 0, y: 0, z: -8 };
    const toChest = { x: 0, y: 1.3 - 1.65, z: -8 };
    expect(computeAimThreat(EYE, toChest, enemy)).toBe(1);
    expect(computeAimThreat(EYE, { x: 1, y: 0, z: -0.2 }, enemy)).toBe(0);
    expect(computeAimThreat(EYE, { x: 0, y: 0, z: 1 }, enemy)).toBe(0);
  });

  it('fades out as the aim drifts off the body', () => {
    const enemy = { x: 0, y: 0, z: -8 };
    const near = computeAimThreat(EYE, { x: 0.09, y: -0.04, z: -1 }, enemy);
    const far = computeAimThreat(EYE, { x: 0.15, y: -0.04, z: -1 }, enemy);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThan(1);
  });
});

describe('close-quarters juke', () => {
  it('only applies up close', () => {
    expect(closeQuartersStrafeWeight(20)).toBe(0);
    expect(closeQuartersStrafeWeight(3)).toBe(1);
    const state = createCloseQuartersJukeState(1, 1);
    expect(stepCloseQuartersJuke(state, jukeInput({ playerDistanceM: 20 }))).toBe(0);
  });

  it('crosses side to side, wide, at irregular intervals', () => {
    const state = createCloseQuartersJukeState(42, 1);
    let min = 0;
    let max = 0;
    let flips = 0;
    let side = state.side;
    const flipTimes: number[] = [];
    for (let i = 0; i < 60 * 12; i++) {
      const offset = stepCloseQuartersJuke(state, jukeInput());
      min = Math.min(min, offset);
      max = Math.max(max, offset);
      if (state.side !== side) {
        flips++;
        flipTimes.push(i);
        side = state.side;
      }
    }
    expect(max - min).toBeGreaterThan(2);
    expect(flips).toBeGreaterThanOrEqual(4);
    const gaps = flipTimes.slice(1).map((t, i) => t - flipTimes[i]);
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it('breaks to the other side when hit, once it has been planted long enough to shoot', () => {
    const state = createCloseQuartersJukeState(7, 1);
    for (let i = 0; i < 50; i++) stepCloseQuartersJuke(state, jukeInput());
    const before = state.side;
    stepCloseQuartersJuke(state, jukeInput({ wasHit: true }));
    expect(state.side).toBe(before === 1 ? -1 : 1);
  });

  it('never turns back mid-dash or straight after arriving, however often it is hit or aimed at', () => {
    const state = createCloseQuartersJukeState(11, 1);
    const side = state.side;
    for (let i = 0; i < 120; i++) {
      stepCloseQuartersJuke(state, jukeInput({ planted: false, wasHit: true, aimThreat: 1 }));
    }
    expect(state.side).toBe(side);
    for (let i = 0; i < 30; i++) stepCloseQuartersJuke(state, jukeInput({ wasHit: true, aimThreat: 1 }));
    expect(state.side).toBe(side);
  });

  it('turns away from a wall instead of pressing into it', () => {
    const state = createCloseQuartersJukeState(3, 1);
    const offset = stepCloseQuartersJuke(state, jukeInput({ anchorX: 7.2 }));
    expect(state.side).toBe(-1);
    expect(offset).toBeLessThan(0);
  });

  it('reverses after stalling against an obstacle', () => {
    const state = createCloseQuartersJukeState(5, 1);
    stepCloseQuartersJuke(state, jukeInput());
    const before = state.side;
    for (let i = 0; i < 20; i++) stepCloseQuartersJuke(state, jukeInput({ lateralStalled: true }));
    expect(state.side).not.toBe(before);
  });

  it('moves sooner when the player is aiming at it', () => {
    const calm = createCloseQuartersJukeState(9, 1);
    const pressed = createCloseQuartersJukeState(9, 1);
    let calmFlipAt = -1;
    let pressedFlipAt = -1;
    for (let i = 0; i < 300; i++) {
      stepCloseQuartersJuke(calm, jukeInput());
      stepCloseQuartersJuke(pressed, jukeInput({ aimThreat: 1 }));
      if (calmFlipAt < 0 && calm.elapsedS < 1 / 60 + 1e-9 && i > 0) calmFlipAt = i;
      if (pressedFlipAt < 0 && pressed.elapsedS < 1 / 60 + 1e-9 && i > 0) pressedFlipAt = i;
    }
    expect(pressedFlipAt).toBeGreaterThan(0);
    expect(pressedFlipAt).toBeLessThan(calmFlipAt);
  });
});

describe('aim duck reflex', () => {
  const input = {
    dt: 0.05,
    aimThreat: 1,
    resolveProfile: 'HARDENED_VETERAN' as const,
    hasCoverToDuckBehind: true,
    midBurst: false,
  };

  it('ducks a veteran after a short reaction, then cools down', () => {
    const state = createAimDuckReflexState();
    let ducked = false;
    for (let i = 0; i < 4 && !ducked; i++) ducked = stepAimDuckReflex(state, input);
    expect(ducked).toBe(true);
    for (let i = 0; i < 12; i++) stepAimDuckReflex(state, input);
    expect(state.cooldownS).toBeGreaterThan(0);
    expect(stepAimDuckReflex(state, input)).toBe(false);
  });

  it('never ducks a berserker, one in the open, or one mid-burst', () => {
    for (const override of [
      { resolveProfile: 'FANATIC_BERSERKER' as const },
      { hasCoverToDuckBehind: false },
      { midBurst: true },
    ]) {
      const state = createAimDuckReflexState();
      let ducked = false;
      for (let i = 0; i < 40; i++) ducked ||= stepAimDuckReflex(state, { ...input, ...override });
      expect(ducked).toBe(false);
    }
  });
});

describe('TacticalCombatAiSystem — close-quarters engagement', () => {
  it('a nearby enemy in the open strafes metres side to side', () => {
    const ai = new TacticalCombatAiSystem();
    const target = createTargetHealthState('cq_0', 'CQ', { x: 0, y: 0, z: -5 }, 0, 'MILITIA_GUNNER');
    ai.registerWaveTargets([target], false);
    ai.setPlayerDamageEnabled(false);
    let minX = target.worldPosition.x;
    let maxX = target.worldPosition.x;
    for (let i = 0; i < 60 * 8; i++) {
      ai.update(1 / 60, [target], EYE, undefined, { x: 0, y: 0, z: -1 });
      minX = Math.min(minX, target.worldPosition.x);
      maxX = Math.max(maxX, target.worldPosition.x);
    }
    expect(ai.getAgent('cq_0')!.state).toBe('ALERTED_ENGAGING');
    expect(maxX - minX).toBeGreaterThan(2);
  });

  it('a nearby enemy in the open stops dead between bounds and only shoots while planted', () => {
    const shots: { x: number; z: number }[] = [];
    const ai = new TacticalCombatAiSystem({
      onEnemyFireTracer: () => shots.push({ x: target.worldPosition.x, z: target.worldPosition.z }),
    });
    const target = createTargetHealthState('cq_1', 'CQ', { x: 0, y: 0, z: -4 }, 0, 'MILITIA_GUNNER');
    ai.registerWaveTargets([target], false);
    ai.setPlayerDamageEnabled(false);
    const dt = 1 / 60;
    let prevX = target.worldPosition.x;
    let prevZ = target.worldPosition.z;
    let moving = false;
    let moveStarts = 0;
    let shotsWhileMoving = 0;
    let shotCount = 0;
    for (let i = 0; i < 60 * 10; i++) {
      // Player aims straight at it the whole time.
      ai.update(dt, [target], EYE, undefined, { x: target.worldPosition.x, y: 1.3 - EYE.y, z: target.worldPosition.z });
      const speed = Math.hypot(target.worldPosition.x - prevX, target.worldPosition.z - prevZ) / dt;
      prevX = target.worldPosition.x;
      prevZ = target.worldPosition.z;
      const nowMoving = speed > 0.25;
      if (nowMoving && !moving) moveStarts++;
      moving = nowMoving;
      if (shots.length > shotCount && nowMoving) shotsWhileMoving += shots.length - shotCount;
      shotCount = shots.length;
    }
    expect(shots.length).toBeGreaterThan(0);
    expect(shotsWhileMoving).toBe(0);
    // Deliberate bounds a second or more apart, not a stream of micro-steps.
    expect(moveStarts).toBeGreaterThan(1);
    expect(moveStarts).toBeLessThan(10);
  });

  it('shooting on the move is less accurate than shooting planted', () => {
    const ai = new TacticalCombatAiSystem();
    const target = createTargetHealthState('mv_0', 'Mover', { x: 0, y: 0, z: -10 }, 0, 'MILITIA_GUNNER');
    ai.registerWaveTargets([target], false);
    const agent = ai.getAgent('mv_0')!;
    agent.moveSpeedMs = 0;
    const planted = ai.computeEnemyAimProfile(target, agent).spreadMultiplier;
    agent.moveSpeedMs = 2.4;
    const moving = ai.computeEnemyAimProfile(target, agent).spreadMultiplier;
    expect(moving).toBeGreaterThan(planted * 1.2);
  });
});

describe('planted footwork and range hysteresis', () => {
  it('holds a planted goal through small changes but follows a real move', () => {
    const fw = createPlantedFootworkState();
    expect(holdFootworkGoal(fw, 1, -5)).toEqual({ x: 1, z: -5 });
    recordFootworkMotion(fw, 0, 1 / 60);
    expect(holdFootworkGoal(fw, 1.2, -5.1)).toEqual({ x: 1, z: -5 });
    expect(holdFootworkGoal(fw, 2, -5)).toEqual({ x: 2, z: -5 });
    // While moving, the goal tracks the desire exactly so approaches stay smooth.
    recordFootworkMotion(fw, 0.04, 1 / 60);
    expect(holdFootworkGoal(fw, 2.1, -5)).toEqual({ x: 2.1, z: -5 });
  });

  it('a pressing heavy keeps pressing once it reaches its stand-off instead of walking back', () => {
    const base: TacticalDoctrineInput = {
      archetype: 'HEAVY_ENFORCER',
      resolveProfile: 'GRITTY_REGULAR',
      clutchingWound: false,
      isWounded: false,
      cyclePhase01: 0.5,
      playerDistanceM: 6,
      hasChestArmor: true,
      chestArmorIntegrity: 1,
      primaryWeaponIntact: true,
      suppression: 0,
      moraleShockTimerS: 0,
      berserkerFrenzyTimerS: 0,
      anchorBlockedByCover: false,
    };
    expect(evaluateTacticalEngagementSubstate(base)).toBe('JUGGERNAUT_PRESS');
    expect(evaluateTacticalEngagementSubstate({ ...base, playerDistanceM: 3.2 })).toBe('COVER_PEEK');
    expect(
      evaluateTacticalEngagementSubstate({ ...base, playerDistanceM: 3.2, previousSubstate: 'JUGGERNAUT_PRESS' })
    ).toBe('JUGGERNAUT_PRESS');
  });
});
