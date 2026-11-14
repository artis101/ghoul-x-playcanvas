export const PROFILE_SECTION_LABELS = ['update', 'player', 'mayhem', 'audio', 'combat', 'destruction', 'hud', 'fx'] as const;
export type ProfileSectionLabel = (typeof PROFILE_SECTION_LABELS)[number];
export const PROFILE_SECTION = { update: 0, player: 1, mayhem: 2, audio: 3, combat: 4, destruction: 5, hud: 6, fx: 7 } as const;
export const DEFAULT_PROFILE_WINDOW_FRAMES = 120;
export type ProfilerClock = () => number;

const defaultClock: ProfilerClock =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/** Rolling per-section frame timings in clock units (milliseconds). Allocates only in the constructor. */
export class FrameProfiler {
  public readonly sectionCount: number;
  public readonly windowFrames: number;
  private readonly clock: ProfilerClock;
  private readonly samples: Float32Array;
  private readonly accum: Float64Array;
  private readonly startedAt: Float64Array;
  private cursor = 0;
  private filled = 0;
  private inFrame = false;

  constructor(
    sectionCount: number = PROFILE_SECTION_LABELS.length,
    windowFrames: number = DEFAULT_PROFILE_WINDOW_FRAMES,
    clock: ProfilerClock = defaultClock,
  ) {
    this.sectionCount = sectionCount;
    this.windowFrames = windowFrames;
    this.clock = clock;
    this.samples = new Float32Array(sectionCount * windowFrames);
    this.accum = new Float64Array(sectionCount);
    this.startedAt = new Float64Array(sectionCount).fill(-1);
  }

  public get frameCount(): number {
    return this.filled;
  }

  public beginFrame(): void {
    this.accum.fill(0);
    this.startedAt.fill(-1);
    this.inFrame = true;
  }

  public begin(section: number): void {
    if (section < 0 || section >= this.sectionCount) return;
    this.startedAt[section] = this.clock();
  }

  public end(section: number): void {
    if (section < 0 || section >= this.sectionCount) return;
    const start = this.startedAt[section];
    if (start < 0) return;
    this.accum[section] += this.clock() - start;
    this.startedAt[section] = -1;
  }

  public endFrame(): void {
    if (!this.inFrame) return;
    const row = this.cursor * this.sectionCount;
    for (let s = 0; s < this.sectionCount; s++) this.samples[row + s] = this.accum[s];
    this.cursor = (this.cursor + 1) % this.windowFrames;
    this.filled = Math.min(this.filled + 1, this.windowFrames);
    this.inFrame = false;
  }

  public average(section: number): number {
    if (this.filled === 0 || section < 0 || section >= this.sectionCount) return 0;
    let sum = 0;
    for (let f = 0; f < this.filled; f++) sum += this.samples[f * this.sectionCount + section];
    return sum / this.filled;
  }

  public max(section: number): number {
    if (this.filled === 0 || section < 0 || section >= this.sectionCount) return 0;
    let best = 0;
    for (let f = 0; f < this.filled; f++) {
      const v = this.samples[f * this.sectionCount + section];
      if (v > best) best = v;
    }
    return best;
  }

  public reset(): void {
    this.samples.fill(0);
    this.accum.fill(0);
    this.startedAt.fill(-1);
    this.cursor = 0;
    this.filled = 0;
    this.inFrame = false;
  }
}
