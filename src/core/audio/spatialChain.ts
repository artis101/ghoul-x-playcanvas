import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { AudioContextLike, AudioListenerLike, AudioNodeLike, GainNodeLike } from './contracts.ts';
import type { SpatialAudioParams, SpatialCalcOptions } from './types.ts';
import { clampNumber } from './audioMath.ts';
import { computeSpatialAudioParams } from './spatialAudio.ts';

export interface SpatialChain {
  readonly input: GainNodeLike;
  readonly spatialParams: SpatialAudioParams;
  readonly nodes: readonly AudioNodeLike[];
}

interface ListenerPoseSnapshot {
  x: number;
  y: number;
  z: number;
  yawDeg: number;
  pitchDeg: number;
}

const listenerPoseCache = new WeakMap<AudioListenerLike, ListenerPoseSnapshot>();

const LISTENER_POS_EPSILON_M = 1e-3;
const LISTENER_ANGLE_EPSILON_DEG = 0.05;

function writeListenerParam(param: { value: number }, value: number): void {
  param.value = value;
}

export function setListenerCoordinates(
  ctx: Pick<AudioContextLike, 'currentTime' | 'listener'>,
  pos: Vec3Like,
  yawDeg: number,
  pitchDeg: number,
): void {
  const listener = ctx.listener;
  const clampedPitch = clampNumber(pitchDeg, -89, 89);
  const prev = listenerPoseCache.get(listener);

  if (
    prev &&
    Math.abs(pos.x - prev.x) < LISTENER_POS_EPSILON_M &&
    Math.abs(pos.y - prev.y) < LISTENER_POS_EPSILON_M &&
    Math.abs(pos.z - prev.z) < LISTENER_POS_EPSILON_M &&
    Math.abs(yawDeg - prev.yawDeg) < LISTENER_ANGLE_EPSILON_DEG &&
    Math.abs(clampedPitch - prev.pitchDeg) < LISTENER_ANGLE_EPSILON_DEG
  ) {
    return;
  }

  if (prev) {
    prev.x = pos.x;
    prev.y = pos.y;
    prev.z = pos.z;
    prev.yawDeg = yawDeg;
    prev.pitchDeg = clampedPitch;
  } else {
    listenerPoseCache.set(listener, { x: pos.x, y: pos.y, z: pos.z, yawDeg, pitchDeg: clampedPitch });
  }

  const yawRad = (yawDeg * Math.PI) / 180;
  const pitchRad = (clampedPitch * Math.PI) / 180;
  const cosPitch = Math.cos(pitchRad);
  const sinPitch = Math.sin(pitchRad);
  const sinYaw = Math.sin(yawRad);
  const cosYaw = Math.cos(yawRad);

  // Orthonormal right-handed camera basis: forward = F, right = R, up = R x F
  const fx = -sinYaw * cosPitch;
  const fy = sinPitch;
  const fz = -cosYaw * cosPitch;

  const ux = sinYaw * sinPitch;
  const uy = cosPitch;
  const uz = cosYaw * sinPitch;

  if (listener.positionX && listener.positionY && listener.positionZ) {
    writeListenerParam(listener.positionX, pos.x);
    writeListenerParam(listener.positionY, pos.y);
    writeListenerParam(listener.positionZ, pos.z);
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
    writeListenerParam(listener.forwardX, fx);
    writeListenerParam(listener.forwardY, fy);
    writeListenerParam(listener.forwardZ, fz);
    writeListenerParam(listener.upX, ux);
    writeListenerParam(listener.upY, uy);
    writeListenerParam(listener.upZ, uz);
  } else if (listener.setOrientation) {
    listener.setOrientation(fx, fy, fz, ux, uy, uz);
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
  listenerPitchDeg = 0,
): SpatialChain {
  const t = ctx.currentTime;
  setListenerCoordinates(ctx, listenerPos, listenerYawDeg, listenerPitchDeg);

  const spatialParams = computeSpatialAudioParams(worldPos, listenerPos, {
    ...options,
    listenerYawDeg,
  });

  const refDist = Math.max(0.1, options.refDistanceM ?? 1.5);
  const maxDist = Math.max(refDist + 1.0, options.maxDistanceM ?? 85.0);
  const horizonRatio =
    spatialParams.distanceM > refDist
      ? clampNumber((spatialParams.distanceM - refDist) / (maxDist - refDist), 0, 1)
      : 0;
  const horizonFade = clampNumber(1.0 - horizonRatio * horizonRatio * 0.85, 0.02, 1.0);

  const input = ctx.createGain();
  input.gain.setValueAtTime(horizonFade, t);

  const maxCutoffHz = Math.max(2000, Math.min(20000, (ctx.sampleRate || 44100) * 0.46));
  const airFilter = ctx.createBiquadFilter();
  airFilter.type = 'lowpass';
  airFilter.frequency.setValueAtTime(
    clampNumber(spatialParams.airAbsorptionCutoffHz, 400, maxCutoffHz),
    t,
  );
  airFilter.Q.setValueAtTime(0.5, t);

  const panner = ctx.createPanner();
  try {
    panner.panningModel = pannerModel;
  } catch {
    panner.panningModel = 'equalpower';
  }
  panner.distanceModel = 'inverse';
  panner.refDistance = refDist;
  panner.maxDistance = maxDist;
  panner.rolloffFactor = Math.max(0.05, options.rolloffFactor ?? 1.15);
  panner.coneInnerAngle = 360;
  panner.coneOuterAngle = 360;
  panner.coneOuterGain = 1.0;

  // Stabilize near-field horizontal placement (<0.35m from head/feet) so 1cm offsets
  // never snap 100% between Left and Right channels
  let panX = worldPos.x;
  const panY = worldPos.y;
  let panZ = worldPos.z;
  const dx = worldPos.x - listenerPos.x;
  const dz = worldPos.z - listenerPos.z;
  const horizDist = Math.hypot(dx, dz);
  if (horizDist < 0.35) {
    const yawRad = (listenerYawDeg * Math.PI) / 180;
    const fwdBias = 0.38 - horizDist;
    panX -= Math.sin(yawRad) * fwdBias;
    panZ -= Math.cos(yawRad) * fwdBias;
  }

  if (panner.positionX && panner.positionY && panner.positionZ) {
    panner.positionX.setValueAtTime(panX, t);
    panner.positionY.setValueAtTime(panY, t);
    panner.positionZ.setValueAtTime(panZ, t);
  } else if (panner.setPosition) {
    panner.setPosition(panX, panY, panZ);
  }

  // Tap stereo-panned signal post-panner with distance compensation so warehouse
  // reverberation preserves accurate Left/Right stereo placement
  const postPannerComp = 1.0 / Math.max(0.14, spatialParams.gainAttenuation);
  const wetGain = clampNumber(
    spatialParams.reverbSendGain * clampNumber(reverbWetMix * 1.6, 0, 1.35) * postPannerComp,
    0,
    2.2,
  );
  const wetSend = ctx.createGain();
  wetSend.gain.setValueAtTime(wetGain, t);

  input.connect(airFilter);
  airFilter.connect(panner);
  panner.connect(dryBus);

  panner.connect(wetSend);
  wetSend.connect(reverbSendBus);

  return {
    input,
    spatialParams,
    nodes: [input, airFilter, panner, wetSend],
  };
}
