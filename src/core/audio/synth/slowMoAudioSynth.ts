import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';

export type SlowMoAudioPhase =
  | { readonly kind: 'NORMAL' }
  | {
      readonly kind: 'ACTIVE';
      readonly heartbeatBus: GainNodeLike;
      nextScheduleTime: number;
    };

export interface SlowMoSynthState {
  phase?: SlowMoAudioPhase;
  slowMoActive: boolean;
  heartbeatBus: GainNodeLike | null;
  heartbeatNextScheduleTime: number;
}

export function createSlowMoSynthState(): SlowMoSynthState {
  return {
    phase: { kind: 'NORMAL' },
    slowMoActive: false,
    heartbeatBus: null,
    heartbeatNextScheduleTime: 0,
  };
}

function resolvePhase(state: SlowMoSynthState): SlowMoAudioPhase {
  if (state.phase) {
    return state.phase;
  }
  if (state.slowMoActive && state.heartbeatBus) {
    const activePhase: SlowMoAudioPhase = {
      kind: 'ACTIVE',
      heartbeatBus: state.heartbeatBus,
      nextScheduleTime: state.heartbeatNextScheduleTime,
    };
    state.phase = activePhase;
    return activePhase;
  }
  const normalPhase: SlowMoAudioPhase = { kind: 'NORMAL' };
  state.phase = normalPhase;
  return normalPhase;
}

function applyPhase(state: SlowMoSynthState, phase: SlowMoAudioPhase): void {
  state.phase = phase;
  if (phase.kind === 'ACTIVE') {
    state.slowMoActive = true;
    state.heartbeatBus = phase.heartbeatBus;
    state.heartbeatNextScheduleTime = phase.nextScheduleTime;
  } else {
    state.slowMoActive = false;
    state.heartbeatBus = null;
    state.heartbeatNextScheduleTime = 0;
  }
}

export function enterSlowMo(ctx: SynthContext, state: SlowMoSynthState): void {
  const current = resolvePhase(state);
  if (current.kind === 'ACTIVE') {
    return;
  }

  const g = ctx.graph;
  const t0 = g.ctx.currentTime;

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

  stopHeartbeatBus(ctx, state, t0);
  const hbBus = g.createGain();
  hbBus.gain.setValueAtTime(0.85, t0);
  hbBus.connect(g.dryBus);

  const cyclesToPreSchedule = 6;
  for (let c = 0; c < cyclesToPreSchedule; c++) {
    scheduleHeartbeatPair(ctx, hbBus, t0 + 0.20 + c * 0.92);
  }
  const nextScheduleTime = t0 + 0.20 + cyclesToPreSchedule * 0.92;
  applyPhase(state, {
    kind: 'ACTIVE',
    heartbeatBus: hbBus,
    nextScheduleTime,
  });
}

export function exitSlowMo(ctx: SynthContext, state: SlowMoSynthState): void {
  const current = resolvePhase(state);
  if (current.kind === 'NORMAL' && !state.slowMoActive && !state.heartbeatBus) {
    return;
  }

  const g = ctx.graph;
  const t0 = g.ctx.currentTime;

  stopHeartbeatBus(ctx, state, t0);
  applyPhase(state, { kind: 'NORMAL' });

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

export function playSlowMoTransition(
  ctx: SynthContext,
  state: SlowMoSynthState,
  entering: boolean,
): void {
  if (entering) {
    enterSlowMo(ctx, state);
  } else {
    exitSlowMo(ctx, state);
  }
}

export function stepSlowMoHeartbeat(
  ctx: SynthContext,
  state: SlowMoSynthState,
  now: number,
): void {
  const current = resolvePhase(state);
  if (current.kind !== 'ACTIVE') {
    return;
  }
  if (now + 0.35 >= current.nextScheduleTime) {
    const beatTime = Math.max(now + 0.05, current.nextScheduleTime);
    scheduleHeartbeatPair(ctx, current.heartbeatBus, beatTime);
    current.nextScheduleTime = beatTime + 0.92;
    state.heartbeatNextScheduleTime = current.nextScheduleTime;
  }
}

export function resetSlowMoSynthState(
  ctx: SynthContext | null,
  state: SlowMoSynthState,
): void {
  if (ctx) {
    stopHeartbeatBus(ctx, state, ctx.graph.ctx.currentTime);
  }
  applyPhase(state, { kind: 'NORMAL' });
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

export function stopHeartbeatBus(ctx: SynthContext, state: SlowMoSynthState, now: number): void {
  const current = resolvePhase(state);
  const oldBus = current.kind === 'ACTIVE' ? current.heartbeatBus : state.heartbeatBus;
  applyPhase(state, { kind: 'NORMAL' });
  if (!oldBus) {
    return;
  }
  oldBus.gain.cancelScheduledValues(now);
  oldBus.gain.setValueAtTime(Math.max(0.0001, oldBus.gain.value), now);
  oldBus.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
  oldBus.gain.linearRampToValueAtTime(0, now + 0.065);
  ctx.registerTransientNodes([oldBus], now + 0.12);
}
