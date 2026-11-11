import {
  ArmorPlateId,
  BleedVisualProfile,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityConfig,
  PhysiologicalEntityState,
} from '../../contracts/physiology.ts';

export function createDefaultArmorIntegrity(
  enableArmorPlates: boolean,
  enableHelmet: boolean
): Record<ArmorPlateId, number> {
  return {
    FRONT_ESAPI_PLATE: enableArmorPlates ? 1.0 : 0.0,
    BACK_ESAPI_PLATE: enableArmorPlates ? 1.0 : 0.0,
    SIDE_SAPI_LEFT: enableArmorPlates ? 1.0 : 0.0,
    SIDE_SAPI_RIGHT: enableArmorPlates ? 1.0 : 0.0,
    HELMET_BALLISTIC_SHELL: enableHelmet ? 1.0 : 0.0,
  };
}

export function createIdleBleedVisualProfile(): BleedVisualProfile {
  return {
    kind: 'NONE',
    rgbColor: [0, 0, 0],
    pulsatile: false,
    pulseFrequencyHz: 0,
    systolicPulseWave: 0,
    sprayVelocityMs: 0,
    floorPoolGrowthRateMPerSec: 0,
  };
}

export function createPhysiologicalEntityState(
  config: PhysiologicalEntityConfig
): PhysiologicalEntityState {
  const alertness = config.alertnessState ?? 'COMBAT_ALERT';
  const enableArmor = config.enableArmorPlates ?? true;
  const enableHelmet = config.enableHelmet ?? true;
  const initialAdrenaline =
    alertness === 'COMBAT_ALERT'
      ? PHYSIOLOGY_CONSTANTS.COMBAT_ALERT_ADRENALINE
      : PHYSIOLOGY_CONSTANTS.UNSUSPECTING_ADRENALINE;

  return {
    entityId: config.entityId,
    alive: true,
    conscious: true,
    causeOfDeath: 'NONE',

    bloodVolumeMl: PHYSIOLOGY_CONSTANTS.BASELINE_BLOOD_VOLUME_ML,
    maxBloodVolumeMl: PHYSIOLOGY_CONSTANTS.BASELINE_BLOOD_VOLUME_ML,
    baseBleedRateMlPerSec: 0,
    effectiveBleedRateMlPerSec: 0,
    meanArterialPressureMmHg: PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG,
    systolicBpMmHg: PHYSIOLOGY_CONSTANTS.BASELINE_SYSTOLIC_MMHG,
    diastolicBpMmHg: PHYSIOLOGY_CONSTANTS.BASELINE_DIASTOLIC_MMHG,
    heartRateBpm:
      PHYSIOLOGY_CONSTANTS.BASELINE_HEART_RATE_BPM + Math.round(initialAdrenaline * 18),
    cardiacOutputRatio: 1.0,
    shockStage: 'NONE',

    oxygenSaturationPct: PHYSIOLOGY_CONSTANTS.BASELINE_SPO2_PCT,
    lungIntegrity: 1.0,
    heartIntegrity: 1.0,
    brainIntegrity: 1.0,
    liverIntegrity: 1.0,
    diaphragmIntegrity: 1.0,
    giTractIntegrity: 1.0,
    pneumothoraxState: 'NONE',

    canStand: true,
    canPullTrigger: true,
    leftLegFunctional: true,
    rightLegFunctional: true,
    leftArmFunctional: true,
    rightArmFunctional: true,
    weaponDropped: false,
    dominantHand: config.dominantHand ?? 'RIGHT',
    aimSwayMultiplier: 1.0,
    locomotionMode: 'STANDING_MOBILE',

    alertnessState: alertness,
    adrenalineLevel: initialAdrenaline,
    adrenalineDecayDurationS:
      config.adrenalineDecayDurationS ?? PHYSIOLOGY_CONSTANTS.DEFAULT_ADRENALINE_DECAY_S,
    painShockLevel: 0,
    neurogenicShockCollapsed: false,

    plateIntegrity: createDefaultArmorIntegrity(enableArmor, enableHelmet),
    fracturedBones: new Set(),
    shatteredBones: new Set(),
    severedNerves: new Set(),
    vascularWounds: [],

    elapsedTimeS: 0,
    biologicalTicksExecuted: 0,
    readability: {
      immediatePostureReaction: 'NONE',
      vocalCue: 'NONE',
      aiAccuracyMultiplier: 1.0,
      staminaMultiplier: 1.0,
      visionTunnelIntensity: 0.0,
      bleedVisualProfile: createIdleBleedVisualProfile(),
    },
  };
}
