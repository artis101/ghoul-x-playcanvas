import type { PreloadPhaseId } from '../../contracts/preloader.ts';

export interface BootPhaseTiming {
  readonly phase: PreloadPhaseId;
  readonly ms: number;
}

export interface BootTimingReport {
  readonly totalMs: number;
  readonly phases: readonly BootPhaseTiming[];
  readonly fontWaitMs: number;
}

const defaultNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** Records wall time spent in each boot phase. */
export class BootPhaseClock {
  private readonly now: () => number;
  private readonly startMs: number;
  private readonly phases: BootPhaseTiming[] = [];
  private current: PreloadPhaseId | null = null;
  private currentStartMs = 0;

  constructor(now: () => number = defaultNow) {
    this.now = now;
    this.startMs = now();
  }

  mark(phase: PreloadPhaseId): void {
    if (phase === this.current) return;
    const t = this.now();
    this.closeCurrent(t);
    this.current = phase;
    this.currentStartMs = t;
  }

  finish(fontWaitMs = 0): BootTimingReport {
    const t = this.now();
    this.closeCurrent(t);
    this.current = null;
    return { totalMs: t - this.startMs, phases: [...this.phases], fontWaitMs };
  }

  private closeCurrent(t: number): void {
    if (this.current === null) return;
    this.phases.push({ phase: this.current, ms: t - this.currentStartMs });
  }
}

export function formatBootTimingReport(report: BootTimingReport): string {
  const parts = report.phases.map((p) => `${p.phase} ${Math.round(p.ms)}`);
  return [
    `[GHOUL-X boot] ${Math.round(report.totalMs)} ms`,
    ...parts,
    `font wait ${Math.round(report.fontWaitMs)}`,
  ].join(' | ');
}
