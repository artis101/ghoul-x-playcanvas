import type { GainNodeLike } from '../contracts.ts';
import type { InternalAudioGraph } from '../audioGraph.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';

export interface SlowMoSynthState {
  slowMoActive: boolean;
  heartbeatBus: GainNodeLike | null;
  heartbeatNextScheduleTime: number;
}

export function playSlowMoTransition(
  ctx: SynthContext,
  state: SlowMoSynthState,
  entering: boolean,
): void {
  state.slowMoActive = entering;
  const g = ctx.graph;
  const t0 = g.ctx.currentTime;

  if (entering) {
    spawnPitchDropOsc(
      ctx,
      g.dryBus,
      'sine',
      t0,
      0.52,
      160,
      29,
      0.72,
      g.warmDriveCurve,
      0.008,
    );
    spawnNoiseBurst(
      ctx,
      g.dryBus,
      'PINK',
      t0,
      0.48,
      0.44,
      'bandpass',
      2450,
      165,
      3.8,
      0.85,
      0.015,
    );

    stopHeartbeatBus(state, t0);
    const hbBus = g.createGain();
    hbBus.gain.setValueAtTime(0.85, t0);
    hbBus.connect(g.dryBus);
    state.heartbeatBus = hbBus;

    const cyclesToPreSchedule = 6;
    for (let c = 0; c < cyclesToPreSchedule; c++) {
      scheduleHeartbeatPair(ctx, hbBus, t0 + 0.20 + c * 0.92);
    }
    state.heartbeatNextScheduleTime = t0 + 0.20 + cyclesToPreSchedule * 0.92;
    return;
  }

  stopHeartbeatBus(state, t0);

  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'sine',
    t0,
    0.34,
    32,
    178,
    0.58,
    g.warmDriveCurve,
    0.006,
  );
  spawnNoiseBurst(
    ctx,
    g.dryBus,
    'PINK',
    t0,
    0.32,
    0.38,
    'bandpass',
    210,
    2950,
    3.4,
    1.1,
    0.01,
  );
}

export function scheduleHeartbeatPair(
  ctx: SynthContext,
  hbBus: GainNodeLike,
  beatTime: number,
): void {
  const g = ctx.graph;
  spawnPitchDropOsc(
    ctx,
    hbBus,
    'sine',
    beatTime,
    0.13,
    54,
    33,
    0.42,
    g.warmDriveCurve,
    0.008,
  );
  spawnPitchDropOsc(
    ctx,
    hbBus,
    'sine',
    beatTime + 0.21,
    0.11,
    48,
    29,
    0.30,
    g.warmDriveCurve,
    0.006,
  );
}

export function stopHeartbeatBus(state: SlowMoSynthState, now: number): void {
  if (!state.heartbeatBus) {
    return;
  }
  const oldBus = state.heartbeatBus;
  state.heartbeatBus = null;
  oldBus.gain.cancelScheduledValues(now);
  oldBus.gain.setValueAtTime(Math.max(0.0001, oldBus.gain.value), now);
  oldBus.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
}
