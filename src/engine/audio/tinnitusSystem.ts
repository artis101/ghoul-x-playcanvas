import type { AudioNodeLike } from '../../core/audio/contracts.ts';

export interface TrackedTransientNodeGroup {
  readonly nodes: readonly AudioNodeLike[];
  readonly endTime: number;
}

export type TinnitusState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'RINGING';
      readonly startTime: number;
      readonly endTime: number;
      readonly peakIntensity: number;
      readonly currentIntensity: number;
    };

export const DEFAULT_TINNITUS_DECAY_DURATION_S = 2.4;

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
  public readonly activeNodeGroups: TrackedTransientNodeGroup[] = [];
  public tinnitusState: TinnitusState = { kind: 'IDLE' };

  public get lastTinnitusTriggerTime(): number {
    return this.tinnitusState.kind === 'RINGING' ? this.tinnitusState.startTime : -10;
  }

  public get activeTinnitusIntensity(): number {
    return this.tinnitusState.kind === 'RINGING' ? this.tinnitusState.currentIntensity : 0;
  }

  public getTinnitusIntensityAt(now: number): number {
    if (this.tinnitusState.kind !== 'RINGING') {
      return 0;
    }
    if (now >= this.tinnitusState.endTime) {
      return 0;
    }
    const duration = Math.max(1e-4, this.tinnitusState.endTime - this.tinnitusState.startTime);
    const elapsed = Math.max(0, now - this.tinnitusState.startTime);
    const remainingFrac = Math.max(0, 1 - elapsed / duration);
    return this.tinnitusState.peakIntensity * remainingFrac;
  }

  public triggerTinnitusSpike(
    now: number,
    intensity = 1.0,
    durationS = DEFAULT_TINNITUS_DECAY_DURATION_S,
  ): void {
    if (!Number.isFinite(intensity) || intensity <= 0) {
      return;
    }
    const current = this.getTinnitusIntensityAt(now);
    const peak = Math.min(1.5, Math.max(current, intensity));
    const clampedDuration = Math.max(0.1, durationS);
    this.tinnitusState = {
      kind: 'RINGING',
      startTime: now,
      endTime: now + clampedDuration,
      peakIntensity: peak,
      currentIntensity: peak,
    };
  }

  public registerTransientNodes(nodes: readonly AudioNodeLike[], endTime: number): void {
    if (nodes.length === 0) return;
    this.activeNodeGroups.push({ nodes, endTime });
  }

  public pruneFinished(now: number): void {
    if (this.tinnitusState.kind === 'RINGING') {
      const decayed = this.getTinnitusIntensityAt(now);
      if (now >= this.tinnitusState.endTime || decayed <= 1e-4) {
        this.tinnitusState = { kind: 'IDLE' };
      } else {
        this.tinnitusState = {
          ...this.tinnitusState,
          currentIntensity: decayed,
        };
      }
    }

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

  public clear(): void {
    for (let i = 0; i < this.activeNodeGroups.length; i++) {
      disconnectNodeGroup(this.activeNodeGroups[i].nodes);
    }
    this.activeNodeGroups.length = 0;
    this.tinnitusState = { kind: 'IDLE' };
  }
}
