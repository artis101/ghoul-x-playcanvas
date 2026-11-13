import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';

export function synthesizeShotgunFire(
  ctx: SynthContext,
  shotBus: GainNodeLike,
  warehouseSend: GainNodeLike,
  t0: number,
  isAds: boolean,
  isAp: boolean,
): void {
  const g = ctx.graph;

  warehouseSend.gain.setValueAtTime(isAds ? 0.44 : 0.54, t0);
  shotBus.connect(warehouseSend);
  warehouseSend.connect(g.reverbSendBus);

  const subOsc = g.createOscillator();
  subOsc.type = 'sine';
  subOsc.frequency.setValueAtTime(92, t0);
  subOsc.frequency.exponentialRampToValueAtTime(55, t0 + 0.032);
  subOsc.frequency.exponentialRampToValueAtTime(33, t0 + 0.22);

  const subShaper = g.createWaveShaper();
  subShaper.curve = g.warmDriveCurve;
  subShaper.oversample = 'none';

  const subGain = g.createGain();
  subGain.gain.value = 0;
  subGain.gain.setValueAtTime(0.0001, t0);
  subGain.gain.linearRampToValueAtTime(0.84, t0 + 0.003);
  subGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
  subGain.gain.linearRampToValueAtTime(0, t0 + 0.246);

  const subStopAt = t0 + 0.255;
  subOsc.connect(subGain);
  subGain.connect(subShaper);
  subShaper.connect(shotBus);
  subOsc.start(t0);
  subOsc.stop(subStopAt);
  ctx.registerTransientNodes([subOsc, subGain, subShaper], subStopAt + 0.05);

  spawnNoiseBurst(
    ctx,
    shotBus,
    'WHITE',
    t0,
    0.25,
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
    0.34,
    0.62,
    'bandpass',
    420,
    150,
    0.85,
    0.92,
    0.002,
  );

  const tRackBack = t0 + 0.22;
  const tRackFwd = t0 + 0.305;

  spawnNoiseBurst(
    ctx,
    g.dryBus,
    'CRACKLE',
    tRackBack,
    0.068,
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
    0.045,
    1860,
    1320,
    0.14,
  );

  spawnNoiseBurst(
    ctx,
    g.dryBus,
    'WHITE',
    tRackFwd,
    0.055,
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
    tRackFwd + 0.012,
    0.042,
    3350,
    2850,
    0.19,
  );
  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'sine',
    tRackFwd + 0.016,
    0.036,
    4920,
    4400,
    0.13,
  );
}
