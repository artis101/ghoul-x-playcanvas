import {
  ImmediatePostureReaction,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityState,
  VocalTraumaCue,
} from '../../contracts/physiology.ts';
import { computeBleedVisualProfile } from './shockBleedProfiles.ts';

export function recomputeMotorAndReadability(
  state: PhysiologicalEntityState,
  latestReaction?: ImmediatePostureReaction,
  latestVocal?: VocalTraumaCue
): void {
  if (!state.alive || !state.conscious) {
    state.canStand = false;
    state.canPullTrigger = false;
    state.locomotionMode = 'PARALYZED';
    state.readability.aiAccuracyMultiplier = 0.0;
    state.readability.staminaMultiplier = 0.0;
    state.readability.visionTunnelIntensity = 1.0;
    if (latestReaction && latestReaction !== 'NONE') {
      state.readability.immediatePostureReaction = latestReaction;
    } else if (state.readability.immediatePostureReaction === 'NONE') {
      state.readability.immediatePostureReaction = 'NEUROGENIC_DROP';
    }
    if (latestVocal !== undefined) {
      state.readability.vocalCue = latestVocal;
    }
    state.readability.bleedVisualProfile = computeBleedVisualProfile(state);
    return;
  }

  // Structural standing capability
  if (!state.leftLegFunctional || !state.rightLegFunctional) {
    state.canStand = false;
  }

  if (!state.canStand) {
    if (state.locomotionMode !== 'PARALYZED') {
      state.locomotionMode = 'PRONE_CRAWL';
    }
  } else if (state.diaphragmIntegrity < 0.72 || state.liverIntegrity < 0.68) {
    state.locomotionMode = 'KNEELING_WINDED';
  } else if (
    state.shockStage === 'CLASS_III' ||
    state.lungIntegrity < 0.75 ||
    state.heartIntegrity < 0.85
  ) {
    state.locomotionMode = 'STAGGERED_LIMP';
  }

  // Dominant arm trigger capability
  const domArmFunctional =
    state.dominantHand === 'RIGHT' ? state.rightArmFunctional : state.leftArmFunctional;
  state.canPullTrigger =
    state.alive && state.conscious && !state.weaponDropped && domArmFunctional;

  // AI Accuracy Multiplier [0.08 .. 1.0]
  let aiAcc = 1.0;
  if (state.heartIntegrity < 0.85) {
    aiAcc = Math.min(aiAcc, 0.10);
  }
  if (state.liverIntegrity < 0.80 || state.diaphragmIntegrity < 0.75) {
    aiAcc = Math.min(aiAcc, 0.14);
  }
  if (state.lungIntegrity < 0.82 || state.pneumothoraxState === 'TENSION_PNEUMOTHORAX') {
    aiAcc = Math.min(aiAcc, 0.16);
  }
  if (!state.canStand) {
    aiAcc = Math.min(aiAcc, 0.24);
  }
  if (state.aimSwayMultiplier > 1.5) {
    aiAcc = Math.min(aiAcc, Math.max(0.08, 1.0 / state.aimSwayMultiplier));
  }
  if (state.shockStage === 'CLASS_III') {
    aiAcc = Math.min(aiAcc, 0.20);
  } else if (state.shockStage === 'CLASS_II') {
    aiAcc = Math.min(aiAcc, 0.48);
  }

  const hypoxiaPenalty = Math.max(
    0,
    (94 - state.oxygenSaturationPct) / (94 - PHYSIOLOGY_CONSTANTS.HYPOXIA_COMA_SPO2_PCT)
  );
  aiAcc = Math.max(0.08, aiAcc * (1.0 - 0.55 * Math.min(1, hypoxiaPenalty)));

  // Stamina & Vision Degradation
  let stamina = 1.0;
  if (state.shockStage === 'CLASS_III') stamina = Math.min(stamina, 0.18);
  else if (state.shockStage === 'CLASS_II') stamina = Math.min(stamina, 0.52);
  stamina = Math.min(stamina, state.lungIntegrity * state.diaphragmIntegrity);

  const bloodLossFraction = 1.0 - state.bloodVolumeMl / state.maxBloodVolumeMl;
  const visionTunnel = Math.min(
    1.0,
    Math.max(0, (bloodLossFraction - 0.18) * 1.9 + hypoxiaPenalty * 0.65)
  );

  if (latestReaction && latestReaction !== 'NONE') {
    state.readability.immediatePostureReaction = latestReaction;
  }
  if (latestVocal && latestVocal !== 'NONE') {
    state.readability.vocalCue = latestVocal;
  } else if (
    state.oxygenSaturationPct < 74 &&
    state.readability.vocalCue !== 'WET_HEMOTHORAX_COUGH'
  ) {
    state.readability.vocalCue = 'AGUNAL_WHEEZE';
  }

  state.readability.aiAccuracyMultiplier = aiAcc;
  state.readability.staminaMultiplier = Math.max(0, stamina);
  state.readability.visionTunnelIntensity = visionTunnel;
  state.readability.bleedVisualProfile = computeBleedVisualProfile(state);
}
