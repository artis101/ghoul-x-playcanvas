import type { Vec3Like } from '../../contracts/ballistics.ts';
import { clampNumber } from './audioMath.ts';
import type { SpatialCalcOptions, SpatialAudioParams } from './types.ts';

export function computeSpatialAudioParams(
  worldPos: Vec3Like,
  listenerPos: Vec3Like,
  options: SpatialCalcOptions = {},
): SpatialAudioParams {
  const refDistanceM = Math.max(0.1, options.refDistanceM ?? 1.5);
  const maxDistanceM = Math.max(refDistanceM + 1.0, options.maxDistanceM ?? 85.0);
  const rolloffFactor = Math.max(0.05, options.rolloffFactor ?? 1.15);
  const listenerYawDeg = options.listenerYawDeg ?? 0;
  const baseReverbWet = clampNumber(options.baseReverbWet ?? 0.14, 0, 1);
  const maxReverbWet = clampNumber(options.maxReverbWet ?? 0.58, baseReverbWet, 1);

  const dx = worldPos.x - listenerPos.x;
  const dy = worldPos.y - listenerPos.y;
  const dz = worldPos.z - listenerPos.z;
  const distanceM = Math.hypot(dx, dy, dz);

  let gainAttenuation = 1.0;
  if (distanceM > refDistanceM) {
    const inverseTerm =
      refDistanceM / (refDistanceM + rolloffFactor * (distanceM - refDistanceM));
    const horizonRatio = clampNumber(
      (distanceM - refDistanceM) / (maxDistanceM - refDistanceM),
      0,
      1,
    );
    const horizonFade = 1.0 - horizonRatio * horizonRatio * 0.85;
    gainAttenuation = clampNumber(inverseTerm * horizonFade, 0, 1);
  }

  // PlayCanvas camera convention: yaw = 0 faces -Z, right vector is (+cos(yaw), 0, -sin(yaw))
  const yawRad = (listenerYawDeg * Math.PI) / 180;
  const rightX = Math.cos(yawRad);
  const rightZ = -Math.sin(yawRad);
  const horizDist = Math.hypot(dx, dz);
  let stereoPan = 0;
  if (horizDist > 1e-4) {
    const rightProj = dx * rightX + dz * rightZ;
    // Soft near-field width normalization so very close sounds don't hard-snap +/-1 on 1cm offsets
    const normDenom = Math.max(0.65, horizDist);
    stereoPan = clampNumber(rightProj / normDenom, -1, 1);
  }

  const airAbsorptionCutoffHz = clampNumber(
    2200 + 17800 * Math.exp(-distanceM / 28.0),
    1800,
    20000,
  );

  const distanceWetFactor = 1.0 - Math.exp(-distanceM / 10.0);
  const rawWet = baseReverbWet + (maxReverbWet - baseReverbWet) * distanceWetFactor;
  const horizonRatio =
    distanceM > refDistanceM
      ? clampNumber((distanceM - refDistanceM) / (maxDistanceM - refDistanceM), 0, 1)
      : 0;
  const roomHorizonFade = 1.0 - horizonRatio * horizonRatio * 0.75;
  const roomEnvelope = (1.0 / (1.0 + distanceM / 48.0)) * roomHorizonFade;
  const reverbSendGain = clampNumber(rawWet * roomEnvelope, 0, 1);

  return {
    distanceM,
    gainAttenuation,
    stereoPan,
    airAbsorptionCutoffHz,
    reverbSendGain,
    deltaWorld: { x: dx, y: dy, z: dz },
  };
}
