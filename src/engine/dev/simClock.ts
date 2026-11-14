export const SIM_MAX_DT_S = 0.1;
export const SIM_SINGLE_STEP_DT_S = 1 / 60;
export const SIM_TIME_SCALE_STEPS: readonly number[] = [1, 0.25, 0.1];

/** Turns raw frame time into simulation time, with pause, single step and slow motion. */
export class SimClock {
  public paused = false;
  public timeScale = 1;
  private stepRequested = false;

  public get isNormalSpeed(): boolean {
    return !this.paused && this.timeScale === 1;
  }

  public togglePause(): void {
    this.paused = !this.paused;
    this.stepRequested = false;
  }

  public requestStep(): void {
    if (this.paused) this.stepRequested = true;
  }

  public cycleTimeScale(): number {
    const i = SIM_TIME_SCALE_STEPS.indexOf(this.timeScale);
    this.timeScale = SIM_TIME_SCALE_STEPS[(i + 1) % SIM_TIME_SCALE_STEPS.length];
    return this.timeScale;
  }

  public advance(rawDt: number): number {
    if (this.paused) {
      if (!this.stepRequested) return 0;
      this.stepRequested = false;
      return SIM_SINGLE_STEP_DT_S;
    }
    return Math.min(SIM_MAX_DT_S, rawDt) * this.timeScale;
  }
}
