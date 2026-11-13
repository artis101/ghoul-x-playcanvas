/**
 * Work that an explosion sets off but that need not all land on the frame of the flash: tearing
 * walls apart, and wounding, dismembering and spawning gore for each body in range. Done at once
 * that is 50-150 ms in one frame; queued here it is spread over the next few, a body per frame.
 *
 * With no budget set the queue is a pass-through and every job runs where it is deferred, so
 * headless callers that expect a blast to be over when the call returns still get that.
 */
export class FrameSlicedWorkQueue {
  /** Milliseconds of queued work to start per frame, or null to run everything immediately. */
  public budgetMs: number | null = null;

  private readonly jobs: Array<() => void> = [];

  public get isDeferring(): boolean {
    return this.budgetMs !== null;
  }

  public get pendingCount(): number {
    return this.jobs.length;
  }

  public defer(job: () => void): void {
    if (this.budgetMs === null) job();
    else this.jobs.push(job);
  }

  /** Like `defer`, but ahead of anything already waiting. */
  public deferFirst(job: () => void): void {
    if (this.budgetMs === null) job();
    else this.jobs.unshift(job);
  }

  /** Runs queued jobs until the budget is spent. Always runs at least one, so the queue drains. */
  public drain(): void {
    if (this.jobs.length === 0) return;
    const budgetMs = this.budgetMs ?? Infinity;
    const startMs = performance.now();
    do {
      const job = this.jobs.shift()!;
      job();
    } while (this.jobs.length > 0 && performance.now() - startMs < budgetMs);
  }

  public clear(): void {
    this.jobs.length = 0;
  }
}
