import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { AudioContextLike, GainNodeLike } from './contracts.ts';
import type { SpatialAudioParams, SpatialCalcOptions } from './types.ts';
import { clampNumber } from './audioMath.ts';
import { computeSpatialAudioParams } from './spatialAudio.ts';

export interface SpatialChain {
  readonly input: GainNodeLike;
  readonly spatialParams: SpatialAudioParams;
}

export function setListenerCoordinates(
  ctx: Pick<AudioContextLike, 'currentTime' | 'listener'>,
  pos: Vec3Like,
  yawDeg: number,
  pitchDeg: number,
): void {
  const listener = ctx.listener;
  const t = ctx.currentTime;
  const yawRad = (yawDeg * Math.PI) / 180;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const cosPitch = Math.cos(pitchRad);

  const fx = -Math.sin(yawRad) * cosPitch;
  const fy = Math.sin(pitchRad);
  const fz = -Math.cos(yawRad) * cosPitch;

  if (listener.positionX && listener.positionY && listener.positionZ) {
    listener.positionX.setValueAtTime(pos.x, t);
    listener.positionY.setValueAtTime(pos.y, t);
    listener.positionZ.setValueAtTime(pos.z, t);
  } else if (listener.setPosition) {
    listener.setPosition(pos.x, pos.y, pos.z);
  }

  if (
    listener.forwardX &&
    listener.forwardY &&
    listener.forwardZ &&
    listener.upX &&
    listener.upY &&
    listener.upZ
  ) {
    listener.forwardX.setValueAtTime(fx, t);
    listener.forwardY.setValueAtTime(fy, t);
    listener.forwardZ.setValueAtTime(fz, t);
    listener.upX.setValueAtTime(0, t);
    listener.upY.setValueAtTime(1, t);
    listener.upZ.setValueAtTime(0, t);
  } else if (listener.setOrientation) {
    listener.setOrientation(fx, fy, fz, 0, 1, 0);
  }
}

export function buildSpatialChain(
  ctx: AudioContextLike,
  dryBus: GainNodeLike,
  reverbSendBus: GainNodeLike,
  worldPos: Vec3Like,
  listenerPos: Vec3Like,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
  options: SpatialCalcOptions = {},
): SpatialChain {
  const t = ctx.currentTime;
  setListenerCoordinates(ctx, listenerPos, listenerYawDeg, 0);

  const spatialParams = computeSpatialAudioParams(worldPos, listenerPos, {
    ...options,
    listenerYawDeg,
  });

  const input = ctx.createGain();
  input.gain.setValueAtTime(1.0, t);

  const airFilter = ctx.createBiquadFilter();
  airFilter.type = 'lowpass';
  airFilter.frequency.setValueAtTime(spatialParams.airAbsorptionCutoffHz, t);
  airFilter.Q.setValueAtTime(0.5, t);

  const panner = ctx.createPanner();
  try {
    panner.panningModel = pannerModel;
  } catch {
    panner.panningModel = 'equalpower';
  }
  panner.distanceModel = 'inverse';
  panner.refDistance = Math.max(0.1, options.refDistanceM ?? 1.5);
  panner.maxDistance = Math.max(panner.refDistance + 1.0, options.maxDistanceM ?? 85.0);
  panner.rolloffFactor = Math.max(0.05, options.rolloffFactor ?? 1.15);
  panner.coneInnerAngle = 360;
  panner.coneOuterAngle = 360;
  panner.coneOuterGain = 1.0;

  if (panner.positionX && panner.positionY && panner.positionZ) {
    panner.positionX.setValueAtTime(worldPos.x, t);
    panner.positionY.setValueAtTime(worldPos.y, t);
    panner.positionZ.setValueAtTime(worldPos.z, t);
  } else if (panner.setPosition) {
    panner.setPosition(worldPos.x, worldPos.y, worldPos.z);
  }

  const wetSend = ctx.createGain();
  wetSend.gain.setValueAtTime(
    spatialParams.reverbSendGain * clampNumber(reverbWetMix * 2.2, 0, 1.8),
    t,
  );

  input.connect(airFilter);
  airFilter.connect(panner);
  panner.connect(dryBus);

  airFilter.connect(wetSend);
  wetSend.connect(reverbSendBus);

  return { input, spatialParams };
}
