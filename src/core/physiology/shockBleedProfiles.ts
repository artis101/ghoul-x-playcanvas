import {
  BleedVisualProfile,
  HemorrhagicShockStage,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityState,
} from '../../contracts/physiology.ts';
import { createIdleBleedVisualProfile } from './initialState.ts';

export function classifyShockStage(bloodVolumeMl: number): HemorrhagicShockStage {
  if (bloodVolumeMl < PHYSIOLOGY_CONSTANTS.CLASS_IV_ARREST_VOLUME_ML) {
    return 'CLASS_IV';
  }
  if (bloodVolumeMl < PHYSIOLOGY_CONSTANTS.CLASS_III_BLOOD_VOLUME_ML) {
    return 'CLASS_III';
  }
  if (bloodVolumeMl < PHYSIOLOGY_CONSTANTS.CLASS_II_BLOOD_VOLUME_ML) {
    return 'CLASS_II';
  }
  if (bloodVolumeMl < PHYSIOLOGY_CONSTANTS.CLASS_I_BLOOD_VOLUME_ML) {
    return 'CLASS_I';
  }
  return 'NONE';
}

export function computeBleedVisualProfile(state: PhysiologicalEntityState): BleedVisualProfile {
  if (state.vascularWounds.length === 0 || state.baseBleedRateMlPerSec <= 0.1) {
    return createIdleBleedVisualProfile();
  }

  let arterialRate = 0;
  let venousRate = 0;
  for (const w of state.vascularWounds) {
    if (w.vesselKind === 'ARTERIAL') {
      arterialRate += w.baseBleedMlPerSec;
    } else {
      venousRate += w.baseBleedMlPerSec;
    }
  }

  const mapRatio = Math.max(
    0,
    state.meanArterialPressureMmHg / PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG
  );

  if (arterialRate >= 12 && state.alive && mapRatio > 0.12) {
    const freqHz = Math.max(0.4, state.heartRateBpm / 60);
    const phase = (state.elapsedTimeS * freqHz) % 1.0;
    const systolicWave =
      phase < 0.28
        ? 0.25 + 0.75 * Math.sin((phase / 0.28) * Math.PI * 0.5)
        : 0.25 + 0.75 * Math.exp(-(phase - 0.28) * 4.2);
    const baseSprayVel = Math.min(6.5, Math.max(3.5, 3.5 + (arterialRate / 95) * 2.8));
    const sprayVelocityMs = Math.max(1.8, baseSprayVel * (0.45 + 0.55 * mapRatio));

    return {
      kind: 'ARTERIAL_PULSING_JET',
      rgbColor: PHYSIOLOGY_CONSTANTS.ARTERIAL_CRIMSON_RGB,
      pulsatile: true,
      pulseFrequencyHz: freqHz,
      systolicPulseWave: systolicWave,
      sprayVelocityMs,
      floorPoolGrowthRateMPerSec: 0.16 * mapRatio,
    };
  }

  const totalVenous = Math.max(venousRate, arterialRate * 0.25);
  return {
    kind: 'VENOUS_DARK_OOZE',
    rgbColor: PHYSIOLOGY_CONSTANTS.VENOUS_MAROON_RGB,
    pulsatile: false,
    pulseFrequencyHz: 0,
    systolicPulseWave: 0,
    sprayVelocityMs: Math.min(0.85, Math.max(0.32, 0.28 + totalVenous * 0.015)),
    floorPoolGrowthRateMPerSec: Math.min(0.22, 0.045 + totalVenous * 0.004),
  };
}
