import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { computeSlowMoAudioFactors } from '../audioMath.ts';

export function synthesizePistolFire(
  ctx: SynthContext,
  shotBus: GainNodeLike,
  warehouseSend: GainNodeLike,
  t0: number,
  isAds: boolean,
  isJhp: boolean,
): void {
  const g = ctx.graph;
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const pScale = factors.oscillatorPitchScale;
  const stretch = factors.envelopeStretch;

  warehouseSend.gain.setValueAtTime(isAds ? 0.62 : 0.74, t0);
  shotBus.connect(warehouseSend);
  warehouseSend.connect(g.reverbSendBus);

  spawnPitchDropOsc(
    ctx,
    shotBus,
    'triangle',
    t0,
    0.21 * stretch,
    185 * pScale,
    46 * pScale,
    0.84,
    g.heavyDriveCurve,
    0.001,
  );
  spawnNoiseBurst(
    ctx,
    shotBus,
    'WHITE',
    t0,
    0.22 * stretch,
    0.82,
    'lowpass',
    isJhp ? 5800 : 7200,
    680,
    1.5,
    1.05,
    0.0008,
  );
  spawnNoiseBurst(
    ctx,
    warehouseSend,
    'PINK',
    t0 + 0.008,
    0.44 * stretch,
    0.55,
    'lowpass',
    1800,
    260,
    0.8,
    0.85,
    0.005,
  );

  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'sine',
    t0 + 0.018 * stretch,
    0.16 * stretch,
    2780 * pScale,
    2690 * pScale,
    0.18,
  );
  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'sine',
    t0 + 0.024 * stretch,
    0.13 * stretch,
    4380 * pScale,
    4240 * pScale,
    0.12,
  );
}
