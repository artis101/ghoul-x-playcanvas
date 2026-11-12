import type { AnimComponent, AnimComponentLayer } from 'playcanvas';

export class PreviewTimeline {
  private layer: AnimComponentLayer | null = null;
  private seconds = 0;

  public constructor(
    private readonly input: HTMLInputElement,
    private readonly time: HTMLOutputElement
  ) {}

  public select(anim: AnimComponent | null, clip: string): void {
    this.layer = anim?.baseLayer && clip ? anim.baseLayer : null;
    if (this.layer) {
      this.layer.reset();
      this.layer.play(clip);
      this.layer.pause();
    }
    this.input.disabled = this.duration <= 0;
    this.input.max = String(this.duration);
    this.seek(0);
  }

  public seek(seconds: number): void {
    this.seconds = Math.min(this.duration, Math.max(0, seconds));
    if (this.layer) this.layer.activeStateCurrentTime = this.seconds;
    this.input.value = String(this.seconds);
    this.time.value = `${this.seconds.toFixed(2)} / ${this.duration.toFixed(2)} s`;
  }

  public resample(): void {
    if (this.layer) this.layer.activeStateCurrentTime = this.seconds;
  }

  public advance(dt: number, loop: boolean): boolean {
    const duration = this.duration;
    if (!duration || (!loop && !this.canAdvance)) return false;
    const next = this.seconds + dt;
    this.seek(loop ? next % duration : next);
    return true;
  }

  public get canAdvance(): boolean {
    return this.seconds < this.duration;
  }

  private get duration(): number {
    return this.layer?.activeStateDuration ?? 0;
  }
}
