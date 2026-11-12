import type { AudioNodeLike, AudioParamLike } from '../../core/audio/contracts.ts';
import type { TrackedBufferSource, TrackedOscillator } from '../../core/audio/types.ts';
import { computeSlowMoAudioFactors } from '../../core/audio/audioMath.ts';

export interface TrackedTransientNodeGroup {
  readonly nodes: readonly AudioNodeLike[];
  readonly endTime: number;
}

function disconnectNodeGroup(nodes: readonly AudioNodeLike[]): void {
  for (let i = 0; i < nodes.length; i++) {
    try {
      nodes[i].disconnect();
    } catch {
      // Ignore already-disconnected or mock nodes
    }
  }
}

export class AudioSourceTracker {
  public readonly activeSources: TrackedBufferSource[] = [];
  public readonly activeOscillators: TrackedOscillator[] = [];
  public readonly activeNodeGroups: TrackedTransientNodeGroup[] = [];
  public lastTinnitusTriggerTime = -10;
  public activeTinnitusIntensity = 0;

  public triggerTinnitusSpike(now: number, intensity = 1.0): void {
    this.lastTinnitusTriggerTime = now;
    this.activeTinnitusIntensity = Math.min(1.5, Math.max(this.activeTinnitusIntensity, intensity));
  }

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

  public registerTransientNodes(nodes: readonly AudioNodeLike[], endTime: number): void {
    if (nodes.length === 0) return;
    this.activeNodeGroups.push({ nodes, endTime });
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

    let grpWriteIdx = 0;
    for (let i = 0; i < this.activeNodeGroups.length; i++) {
      const grp = this.activeNodeGroups[i];
      if (grp.endTime > now) {
        this.activeNodeGroups[grpWriteIdx++] = grp;
      } else {
        disconnectNodeGroup(grp.nodes);
      }
    }
    this.activeNodeGroups.length = grpWriteIdx;
  }

  public applyTimeScale(newScale: number, now?: number): void {
    const factors = computeSlowMoAudioFactors(newScale);
    for (let i = 0; i < this.activeSources.length; i++) {
      const item = this.activeSources[i];
      try {
        const targetRate = Math.max(0.04, item.baseRate * factors.playbackRate);
        if (now !== undefined) {
          item.source.playbackRate.cancelScheduledValues(now);
          item.source.playbackRate.setTargetAtTime(targetRate, now, 0.015);
        } else {
          item.source.playbackRate.value = targetRate;
        }
      } catch {
        // Ignored if node already stopped/disposed
      }
    }

    const currentPitchScale = factors.oscillatorPitchScale;
    for (let i = 0; i < this.activeOscillators.length; i++) {
      const item = this.activeOscillators[i];
      try {
        const ratio = currentPitchScale / Math.max(0.05, item.spawnPitchScale);
        const targetDetune = 1200 * Math.log2(Math.max(0.05, ratio));
        if (now !== undefined) {
          item.osc.detune.cancelScheduledValues(now);
          item.osc.detune.setTargetAtTime(targetDetune, now, 0.015);
        } else {
          item.osc.detune.value = targetDetune;
        }
      } catch {
        // Ignored if node already stopped/disposed
      }
    }
  }

  public clear(): void {
    for (let i = 0; i < this.activeNodeGroups.length; i++) {
      disconnectNodeGroup(this.activeNodeGroups[i].nodes);
    }
    this.activeNodeGroups.length = 0;
    this.activeSources.length = 0;
    this.activeOscillators.length = 0;
  }
}
