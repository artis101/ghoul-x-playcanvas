import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { computeSlowMoAudioFactors } from '../audioMath.ts';

export function synthesizeShotgunFire(
  ctx: SynthContext,
  shotBus: GainNodeLike,
  warehouseSend: GainNodeLike,
  t0: number,
  isAds: boolean,
  isAp: boolean,
): void {
  const g = ctx.graph;
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const pScale = factors.oscillatorPitchScale;
  const stretch = factors.envelopeStretch;

  warehouseSend.gain.setValueAtTime(isAds ? 0.44 : 0.54, t0);
  shotBus.connect(warehouseSend);
  warehouseSend.connect(g.reverbSendBus);

  const subOsc = g.createOscillator();
  subOsc.type = 'sine';
  subOsc.frequency.setValueAtTime(92 * pScale, t0);
  subOsc.frequency.exponentialRampToValueAtTime(55 * pScale, t0 + 0.032 * stretch);
  subOsc.frequency.exponentialRampToValueAtTime(33 * pScale, t0 + 0.22 * stretch);

  const subShaper = g.createWaveShaper();
  subShaper.curve = g.warmDriveCurve;
  subShaper.oversample = '2x';

  const subGain = g.createGain();
  subGain.gain.setValueAtTime(0.0001, t0);
  subGain.gain.linearRampToValueAtTime(0.88, t0 + 0.003);
  subGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24 * stretch);

  subOsc.connect(subShaper);
  subShaper.connect(subGain);
  subGain.connect(shotBus);
  subOsc.start(t0);
  subOsc.stop(t0 + 0.25 * stretch);

  spawnNoiseBurst(
    ctx,
    shotBus,
    'WHITE',
    t0,
    0.25 * stretch,
    isAp ? 0.78 : 0.85,
    'lowpass',
    isAp ? 6400 : 5200,
    520,
    1.2,
    1.0,
    0.001,
  );
  spawnNoiseBurst(
    ctx,
    shotBus,
    'PINK',
    t0,
    0.34 * stretch,
    0.62,
    'bandpass',
    420,
    150,
    0.85,
    0.92,
    0.002,
  );

  const tRackBack = t0 + 0.22 * stretch;
  const tRackFwd = t0 + 0.305 * stretch;

  spawnNoiseBurst(
    ctx,
    g.dryBus,
    'CRACKLE',
    tRackBack,
    0.068 * stretch,
    0.28,
    'bandpass',
    2150,
    1480,
    4.2,
    1.1,
    0.004,
  );
  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'triangle',
    tRackBack,
    0.045 * stretch,
    1860 * pScale,
    1320 * pScale,
    0.14,
  );

  spawnNoiseBurst(
    ctx,
    g.dryBus,
    'WHITE',
    tRackFwd,
    0.055 * stretch,
    0.32,
    'bandpass',
    1650,
    3100,
    5.0,
    1.18,
    0.002,
  );
  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'sine',
    tRackFwd + 0.012 * stretch,
    0.042 * stretch,
    3350 * pScale,
    2850 * pScale,
    0.19,
  );
  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'sine',
    tRackFwd + 0.016 * stretch,
    0.036 * stretch,
    4920 * pScale,
    4400 * pScale,
    0.13,
  );
}
