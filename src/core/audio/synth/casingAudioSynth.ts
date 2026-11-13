import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ShellCasingCaliber } from '../types.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { clampNumber } from '../audioMath.ts';

export function playShellCasingBounce(
  ctx: SynthContext,
  caliber: ShellCasingCaliber,
  worldPos: Vec3Like,
  listenerPos: Vec3Like,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
): void {
  const g = ctx.graph;
  const t0 = g.ctx.currentTime;

  const chain = g.createSpatialChain(
    worldPos,
    listenerPos,
    listenerYawDeg,
    pannerModel,
    reverbWetMix * 0.55,
    { refDistanceM: 1.0, maxDistanceM: 22.0, rolloffFactor: 1.35 },
  );

  const microVar = 0.975 + ctx.rng() * 0.05;

  if (caliber === 'BRASS') {
    const bounceOffsets = [0, 0.062, 0.118];
    const bounceGains = [0.22, 0.13, 0.075];
    const spinSettlePitch = [1.0, 1.035, 1.075];
    const partialsHz = [3800, 6200, 9100];
    const partialWeights = [1.0, 0.68, 0.42];

    for (let b = 0; b < bounceOffsets.length; b++) {
      const tb = t0 + bounceOffsets[b];
      const bGain = bounceGains[b];
      const bPitch = spinSettlePitch[b] * microVar;
      const dur = (0.058 - b * 0.011);

      for (let p = 0; p < partialsHz.length; p++) {
        const freq = clampNumber(partialsHz[p] * bPitch, 120, 19500);
        spawnPitchDropOsc(
          ctx,
          chain.input,
          'sine',
          tb,
          dur,
          freq,
          freq * 0.992,
          bGain * partialWeights[p],
          undefined,
          0.0006,
        );
      }
    }
    return;
  }

  const hullOffsets = [0, 0.082];
  const hullGains = [0.26, 0.14];
  for (let b = 0; b < hullOffsets.length; b++) {
    const tb = t0 + hullOffsets[b];
    const amp = hullGains[b];
    spawnNoiseBurst(
      ctx,
      chain.input,
      'WHITE',
      tb,
      0.044,
      amp,
      'bandpass',
      710 * microVar,
      590 * microVar,
      6.2,
      1.0,
      0.001,
    );
    spawnPitchDropOsc(
      ctx,
      chain.input,
      'triangle',
      tb,
      0.038,
      1160 * microVar,
      920 * microVar,
      amp * 0.48,
    );
    spawnPitchDropOsc(
      ctx,
      chain.input,
      'sine',
      tb + 0.003,
      0.032,
      4450 * microVar,
      4380 * microVar,
      amp * 0.25,
    );
  }
}
