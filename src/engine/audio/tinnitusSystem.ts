import type { AudioParamLike } from '../../core/audio/contracts.ts';
import type { TrackedBufferSource, TrackedOscillator } from '../../core/audio/types.ts';
import { computeSlowMoAudioFactors } from '../../core/audio/audioMath.ts';

export class AudioSourceTracker {
  public readonly activeSources: TrackedBufferSource[] = [];
  public readonly activeOscillators: TrackedOscillator[] = [];

  public registerSource(
    source: { readonly playbackRate: AudioParamLike },
    baseRate: number,
    endTime: number,
  ): void {
    this.activeSources.push({ source, baseRate, endTime });
  }

  public registerOscillator(
    osc: { readonly detune: AudioParamLike },
    spawnPitchScale: number,
    endTime: number,
  ): void {
    this.activeOscillators.push({ osc, spawnPitchScale, endTime });
  }

  public pruneFinished(now: number): void {
    let writeIdx = 0;
    for (let i = 0; i < this.activeSources.length; i++) {
      const item = this.activeSources[i];
      if (item.endTime > now) {
        this.activeSources[writeIdx++] = item;
      }
    }
    this.activeSources.length = writeIdx;

    let oscWriteIdx = 0;
    for (let i = 0; i < this.activeOscillators.length; i++) {
      const item = this.activeOscillators[i];
      if (item.endTime > now) {
        this.activeOscillators[oscWriteIdx++] = item;
      }
    }
    this.activeOscillators.length = oscWriteIdx;
  }

  public applyTimeScale(newScale: number): void {
    const factors = computeSlowMoAudioFactors(newScale);
    for (let i = 0; i < this.activeSources.length; i++) {
      const item = this.activeSources[i];
      try {
        item.source.playbackRate.value = Math.max(0.04, item.baseRate * factors.playbackRate);
      } catch {
        // Ignored if node already stopped/disposed
      }
    }

    const currentPitchScale = factors.oscillatorPitchScale;
    for (let i = 0; i < this.activeOscillators.length; i++) {
      const item = this.activeOscillators[i];
      try {
        const ratio = currentPitchScale / Math.max(0.05, item.spawnPitchScale);
        item.osc.detune.value = 1200 * Math.log2(Math.max(0.05, ratio));
      } catch {
        // Ignored if node already stopped/disposed
      }
    }
  }

  public clear(): void {
    this.activeSources.length = 0;
    this.activeOscillators.length = 0;
  }
}
