import {
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityState,
} from '../../contracts/physiology.ts';
import { classifyShockStage } from './shockBleedProfiles.ts';
import { recomputeMotorAndReadability } from './motorReadability.ts';

export function stepBiologicalTick(state: PhysiologicalEntityState, tickDt: number): void {
  state.biologicalTicksExecuted++;
  if (!state.alive) {
    state.effectiveBleedRateMlPerSec = 0;
    state.meanArterialPressureMmHg = 0;
    state.systolicBpMmHg = 0;
    state.diastolicBpMmHg = 0;
    state.heartRateBpm = 0;
    state.cardiacOutputRatio = 0;
    recomputeMotorAndReadability(state);
    return;
  }

  // 1. Adrenaline Buffer Decay
  if (state.alertnessState === 'COMBAT_ALERT' && state.adrenalineLevel > 0.10) {
    const decayPerSec =
      (PHYSIOLOGY_CONSTANTS.COMBAT_ALERT_ADRENALINE - 0.10) /
      Math.max(15, state.adrenalineDecayDurationS);
    state.adrenalineLevel = Math.max(0.10, state.adrenalineLevel - decayPerSec * tickDt);
  }

  // 2. Pressure-Scaled Hemorrhage
  const currentPressureRatio = Math.max(
    0.10,
    state.meanArterialPressureMmHg / PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG
  );
  state.effectiveBleedRateMlPerSec = state.baseBleedRateMlPerSec * currentPressureRatio;
  state.bloodVolumeMl = Math.max(
    0,
    state.bloodVolumeMl - state.effectiveBleedRateMlPerSec * tickDt
  );

  // 3. Shock Stage, MAP & Cardiac Output
  state.shockStage = classifyShockStage(state.bloodVolumeMl);
  const volRatio = state.bloodVolumeMl / state.maxBloodVolumeMl;
  const preloadFactor = Math.max(0, Math.min(1, (volRatio - 0.28) / 0.72));
  const tensionVenousReturnPenalty =
    state.pneumothoraxState === 'TENSION_PNEUMOTHORAX'
      ? 0.55 + 0.45 * state.lungIntegrity
      : 1.0;

  state.cardiacOutputRatio = Math.max(
    0,
    preloadFactor * (0.20 + 0.80 * state.heartIntegrity) * tensionVenousReturnPenalty
  );

  const vasoconstrictionBoost = 1.0 + 0.32 * (1.0 - preloadFactor);
  state.meanArterialPressureMmHg = Math.max(
    0,
    PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG * state.cardiacOutputRatio * vasoconstrictionBoost
  );
  state.systolicBpMmHg = Math.round(state.meanArterialPressureMmHg * 1.29);
  state.diastolicBpMmHg = Math.round(state.meanArterialPressureMmHg * 0.86);

  // Heart Rate Response
  const lossFraction = 1.0 - volRatio;
  if (state.shockStage === 'CLASS_IV') {
    state.heartRateBpm = 38;
  } else if (state.shockStage === 'CLASS_III') {
    state.heartRateBpm = Math.round(130 + Math.min(35, (lossFraction - 0.30) * 160));
  } else if (state.shockStage === 'CLASS_II') {
    state.heartRateBpm = Math.round(108 + (lossFraction - 0.25) * 320);
  } else {
    state.heartRateBpm = Math.round(
      PHYSIOLOGY_CONSTANTS.BASELINE_HEART_RATE_BPM +
        state.adrenalineLevel * 22 +
        lossFraction * 120
    );
  }

  // Class IV Exsanguination Arrest
  if (state.bloodVolumeMl <= PHYSIOLOGY_CONSTANTS.CLASS_IV_ARREST_VOLUME_ML) {
    state.shockStage = 'CLASS_IV';
    state.conscious = false;
    state.alive = false;
    state.causeOfDeath = 'EXSANGUINATION_CLASS_IV_ARREST';
    state.heartRateBpm = 0;
    state.meanArterialPressureMmHg = 0;
    recomputeMotorAndReadability(state, 'NEUROGENIC_DROP', 'AGUNAL_WHEEZE');
    return;
  }

  if (state.meanArterialPressureMmHg < PHYSIOLOGY_CONSTANTS.HYPOTENSION_UNCONSCIOUS_MAP_MMHG) {
    state.conscious = false;
  }

  // 4. Pulmonary Collapse & SpO2
  if (state.pneumothoraxState === 'TENSION_PNEUMOTHORAX') {
    state.lungIntegrity = Math.max(0.04, state.lungIntegrity - 0.095 * tickDt);
  } else if (state.pneumothoraxState === 'OPEN_PNEUMOTHORAX') {
    state.lungIntegrity = Math.max(0.45, state.lungIntegrity - 0.03 * tickDt);
  } else if (state.pneumothoraxState === 'DECOMPRESSED_SEALED') {
    state.lungIntegrity = Math.min(0.92, state.lungIntegrity + 0.065 * tickDt);
  }

  const respiratoryDrive = 0.25 + 0.75 * state.diaphragmIntegrity;
  const perfusionMatch = Math.min(1.05, 0.52 + 0.48 * state.cardiacOutputRatio);
  const vq = Math.max(0, state.lungIntegrity * respiratoryDrive * perfusionMatch);

  const vqPow = Math.pow(vq, 2.6);
  const halfSatPow = Math.pow(0.21, 2.6);
  const hillSaturation = vqPow / (vqPow + halfSatPow);
  const targetSpO2 = Math.min(99, Math.max(15, 16 + 84 * hillSaturation));
  const spo2Rate = targetSpO2 < state.oxygenSaturationPct ? 0.30 : 0.42;
  state.oxygenSaturationPct += (targetSpO2 - state.oxygenSaturationPct) * spo2Rate * tickDt;

  if (state.oxygenSaturationPct < PHYSIOLOGY_CONSTANTS.HYPOXIA_COMA_SPO2_PCT) {
    state.conscious = false;
  }
  if (state.oxygenSaturationPct < PHYSIOLOGY_CONSTANTS.HYPOXIC_ARREST_SPO2_PCT) {
    state.conscious = false;
    state.alive = false;
    state.causeOfDeath = 'HYPOXIC_ASPHYXIA_ARREST';
    state.heartRateBpm = 0;
    state.meanArterialPressureMmHg = 0;
    recomputeMotorAndReadability(state, 'NEUROGENIC_DROP', 'AGUNAL_WHEEZE');
    return;
  }

  recomputeMotorAndReadability(state);
}
