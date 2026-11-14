import { describe, expect, it } from 'vitest';
import { SimClock } from '../src/engine/dev/simClock';

describe('SimClock', () => {
  it('passes dt through at normal speed with a 0.1 cap', () => {
    const clock = new SimClock();
    expect(clock.isNormalSpeed).toBe(true);
    expect(clock.advance(0.016)).toBe(Math.min(0.1, 0.016));
    expect(clock.advance(0.5)).toBe(0.1);
  });

  it('returns 0 while paused', () => {
    const clock = new SimClock();
    clock.togglePause();
    expect(clock.isNormalSpeed).toBe(false);
    expect(clock.advance(0.016)).toBe(0);
  });

  it('single steps exactly once while paused', () => {
    const clock = new SimClock();
    clock.togglePause();
    clock.requestStep();
    expect(clock.advance(0.016)).toBe(1 / 60);
    expect(clock.advance(0.016)).toBe(0);
  });

  it('ignores step requests while running', () => {
    const clock = new SimClock();
    clock.requestStep();
    clock.togglePause();
    expect(clock.advance(0.016)).toBe(0);
  });

  it('cycles time scale', () => {
    const clock = new SimClock();
    expect(clock.cycleTimeScale()).toBe(0.25);
    expect(clock.cycleTimeScale()).toBe(0.1);
    expect(clock.cycleTimeScale()).toBe(1);
  });

  it('scales dt by the time scale', () => {
    const clock = new SimClock();
    clock.cycleTimeScale();
    expect(clock.advance(0.05)).toBeCloseTo(0.0125, 6);
  });

  it('clears a pending step when pause toggles twice', () => {
    const clock = new SimClock();
    clock.togglePause();
    clock.requestStep();
    clock.togglePause();
    clock.togglePause();
    expect(clock.advance(0.016)).toBe(0);
  });
});
