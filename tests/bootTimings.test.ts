import { describe, expect, it } from 'vitest';
import { BootPhaseClock, formatBootTimingReport } from '../src/engine/preloader/bootTimings.ts';

describe('BootPhaseClock', () => {
  it('records per-phase durations and ignores repeated marks', () => {
    let t = 0;
    const clock = new BootPhaseClock(() => t);
    clock.mark('FONTS_AND_DOM');
    t = 10;
    clock.mark('WASM_PHYSICS');
    t = 15;
    clock.mark('WASM_PHYSICS');
    t = 40;
    clock.mark('MODELS_AND_GRAPHS');
    t = 100;
    const report = clock.finish(7);

    expect(report.phases).toEqual([
      { phase: 'FONTS_AND_DOM', ms: 10 },
      { phase: 'WASM_PHYSICS', ms: 30 },
      { phase: 'MODELS_AND_GRAPHS', ms: 60 },
    ]);
    expect(report.totalMs).toBe(100);
    expect(report.fontWaitMs).toBe(7);

    const line = formatBootTimingReport(report);
    expect(line).toContain('WASM_PHYSICS 30');
    expect(line).toContain('100 ms');
  });
});
