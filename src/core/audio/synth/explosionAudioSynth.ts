import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { TINNITUS_PROXIMITY_RADIUS_M } from '../types.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { clampNumber } from '../audioMath.ts';

export interface ExplosionAudioResult {
  readonly triggersTinnitus: boolean;
}

export function playExplosion(
  ctx: SynthContext,
  worldPos: Vec3Like,
  listenerPos: Vec3Like,
  intensity: number,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
): ExplosionAudioResult {
  if (!Number.isFinite(intensity) || intensity <= 0) {
    return { triggersTinnitus: false };
  }

  const distM = Math.hypot(
    worldPos.x - listenerPos.x,
    worldPos.y - listenerPos.y,
    worldPos.z - listenerPos.z,
  );
  const triggersTinnitus = distM <= TINNITUS_PROXIMITY_RADIUS_M;

  const g = ctx.graph;
  const t0 = g.ctx.currentTime;
  const clampedIntensity = clampNumber(intensity, 0.15, 2.5);

  const chain = g.createSpatialChain(
    worldPos,
    listenerPos,
    listenerYawDeg,
    pannerModel,
    Math.min(1.0, reverbWetMix * 1.45),
    {
      refDistanceM: 3.2,
      maxDistanceM: 120.0,
      rolloffFactor: 0.9,
      baseReverbWet: 0.32,
      maxReverbWet: 0.78,
    },
  );

  // Layer 1: Massive 28Hz–90Hz saturating sub-bass shockwave boom
  const subStartHz = clampNumber(90, 24, 140);
  const subEndHz = clampNumber(28, 18, 80);
  spawnPitchDropOsc(
    ctx,
    chain.input,
    'sine',
    t0,
    0.88,
    subStartHz,
    subEndHz,
    0.95 * clampedIntensity,
    g.heavyDriveCurve,
    0.003,
  );
  spawnPitchDropOsc(
    ctx,
    chain.input,
    'triangle',
    t0,
    0.46,
    78,
    32,
    0.62 * clampedIntensity,
    g.warmDriveCurve,
    0.002,
  );

  // Layer 2: Supersonic detonation crack + roaring fireball lowpass sweep
  spawnNoiseBurst(
    ctx,
    chain.input,
    'WHITE',
    t0,
    0.14,
    0.88 * clampedIntensity,
    'lowpass',
    7500,
    900,
    1.4,
    1.0,
    0.0008,
  );
  spawnNoiseBurst(
    ctx,
    chain.input,
    'PINK',
    t0 + 0.01,
    1.05,
    0.82 * clampedIntensity,
    'lowpass',
    2400,
    130,
    0.9,
    0.78,
    0.008,
  );

  // Layer 3: Debris crackle & cascading shrapnel scatter
  spawnNoiseBurst(
    ctx,
    chain.input,
    'CRACKLE',
    t0 + 0.08,
    0.92,
    0.48 * clampedIntensity,
    'bandpass',
    1850,
    540,
    1.6,
    0.9,
    0.02,
  );

  // Layer 4: Short atmospheric high-pitched tinnitus ring when player is within 4.5m
  if (triggersTinnitus) {
    const proximityFactor = clampNumber(
      1.0 - distM / TINNITUS_PROXIMITY_RADIUS_M,
      0.18,
      1.0,
    );
    const ringOsc = g.createOscillator();
    ringOsc.type = 'sine';
    ringOsc.frequency.setValueAtTime(3960, t0 + 0.02);

    const ringGain = g.createGain();
    const peakRing = 0.075 * proximityFactor * Math.min(1.25, clampedIntensity);
    ringGain.gain.value = 0;
    ringGain.gain.setValueAtTime(0.0001, t0);
    ringGain.gain.setValueAtTime(0.0001, t0 + 0.02);
    ringGain.gain.linearRampToValueAtTime(peakRing, t0 + 0.08);
    ringGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.45);
    ringGain.gain.linearRampToValueAtTime(0, t0 + 1.47);

    const ringStopAt = t0 + 1.485;
    ringOsc.connect(ringGain);
    ringGain.connect(g.dryBus);
    ringOsc.start(t0 + 0.02);
    ringOsc.stop(ringStopAt);
    ctx.registerTransientNodes([ringOsc, ringGain], ringStopAt + 0.05);
  }

  return { triggersTinnitus };
}
