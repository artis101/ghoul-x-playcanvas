import { describe, expect, it } from 'vitest';
import {
  FrameProfiler,
  PROFILE_SECTION,
  PROFILE_SECTION_LABELS,
} from '../src/engine/dev/frameProfiler';

function makeProfiler(windowFrames = 120) {
  const state = { t: 0 };
  const profiler = new FrameProfiler(PROFILE_SECTION_LABELS.length, windowFrames, () => state.t);
  return { state, profiler };
}

describe('FrameProfiler', () => {
  it('records a single section span', () => {
    const { state, profiler } = makeProfiler();
    profiler.beginFrame();
    profiler.begin(0);
    state.t = 5;
    profiler.end(0);
    profiler.endFrame();
    expect(profiler.frameCount).toBe(1);
    expect(profiler.average(0)).toBe(5);
    expect(profiler.max(0)).toBe(5);
  });

  it('accumulates repeated spans of one section in a frame', () => {
    const { state, profiler } = makeProfiler();
    profiler.beginFrame();
    profiler.begin(1);
    state.t = 2;
    profiler.end(1);
    profiler.begin(1);
    state.t = 5;
    profiler.end(1);
    profiler.endFrame();
    expect(profiler.average(1)).toBe(5);
  });

  it('keeps only the most recent window of frames', () => {
    const { state, profiler } = makeProfiler(3);
    for (let v = 1; v <= 5; v++) {
      profiler.beginFrame();
      profiler.begin(0);
      state.t += v;
      profiler.end(0);
      profiler.endFrame();
    }
    expect(profiler.frameCount).toBe(3);
    expect(profiler.average(0)).toBe(4);
    expect(profiler.max(0)).toBe(5);
  });

  it('ignores end without begin and endFrame without beginFrame', () => {
    const { state, profiler } = makeProfiler();
    profiler.beginFrame();
    state.t = 9;
    profiler.end(0);
    profiler.endFrame();
    expect(profiler.average(0)).toBe(0);
    const fresh = makeProfiler().profiler;
    fresh.endFrame();
    expect(fresh.frameCount).toBe(0);
  });

  it('ignores out-of-range sections', () => {
    const { profiler } = makeProfiler();
    profiler.beginFrame();
    expect(() => {
      profiler.begin(-1);
      profiler.end(-1);
      profiler.begin(99);
      profiler.end(99);
    }).not.toThrow();
    profiler.endFrame();
    expect(profiler.average(99)).toBe(0);
    expect(profiler.max(-1)).toBe(0);
  });

  it('exposes consistent section labels', () => {
    expect(PROFILE_SECTION_LABELS[PROFILE_SECTION.fx]).toBe('fx');
    expect(PROFILE_SECTION_LABELS.length).toBe(8);
  });
});
