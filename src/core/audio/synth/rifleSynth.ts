import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { computeSlowMoAudioFactors } from '../audioMath.ts';

export function synthesizeSniperFire(
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

  warehouseSend.gain.setValueAtTime(isAds ? 0.58 : 0.68, t0);
  shotBus.connect(warehouseSend);
  warehouseSend.connect(g.reverbSendBus);

  spawnPitchDropOsc(
    ctx,
    shotBus,
    'sawtooth',
    t0,
    0.042 * stretch,
    (isAp ? 4200 : 3650) * pScale,
    1050 * pScale,
    0.46,
    g.warmDriveCurve,
    0.0006,
  );
  spawnNoiseBurst(
    ctx,
    shotBus,
    'WHITE',
    t0,
    0.065 * stretch,
    0.76,
    'highpass',
    2100,
    950,
    1.3,
    1.25,
    0.0006,
  );

  spawnPitchDropOsc(
    ctx,
    shotBus,
    'sine',
    t0,
    0.18 * stretch,
    142 * pScale,
    48 * pScale,
    0.72,
    g.warmDriveCurve,
    0.0012,
  );
  spawnNoiseBurst(
    ctx,
    shotBus,
    'PINK',
    t0,
    0.32 * stretch,
    0.68,
    'lowpass',
    3400,
    310,
    1.0,
    0.95,
    0.0015,
  );

  const tBolt = t0 + 0.034 * stretch;
  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'sine',
    tBolt,
    0.20 * stretch,
    1440 * pScale,
    1390 * pScale,
    0.15,
  );
  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'triangle',
    tBolt + 0.012 * stretch,
    0.15 * stretch,
    3080 * pScale,
    2920 * pScale,
    0.11,
  );
}

export function synthesizeCarbineFire(
  ctx: SynthContext,
  shotBus: GainNodeLike,
  warehouseSend: GainNodeLike,
  t0: number,
  isAds: boolean,
  isJhp: boolean,
  jitter: number,
): void {
  const g = ctx.graph;
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const pScale = factors.oscillatorPitchScale;
  const stretch = factors.envelopeStretch;

  warehouseSend.gain.setValueAtTime(isAds ? 0.30 : 0.38, t0);
  shotBus.connect(warehouseSend);
  warehouseSend.connect(g.reverbSendBus);

  spawnPitchDropOsc(
    ctx,
    shotBus,
    'triangle',
    t0,
    0.095 * stretch,
    162 * pScale * jitter,
    60 * pScale * jitter,
    0.66,
    g.warmDriveCurve,
    0.001,
  );

  spawnNoiseBurst(
    ctx,
    shotBus,
    'WHITE',
    t0,
    0.115 * stretch,
    0.72,
    'lowpass',
    (isJhp ? 4400 : 5300) * jitter,
    780 * jitter,
    1.35,
    jitter,
    0.0008,
  );

  spawnPitchDropOsc(
    ctx,
    g.dryBus,
    'sine',
    t0 + 0.016 * stretch,
    0.052 * stretch,
    4850 * pScale * jitter,
    4420 * pScale * jitter,
    0.11,
  );
}
