import {
  ArmorPlateId,
  BleedVisualProfile,
  HemorrhagicShockStage,
  ImmediatePostureReaction,
  InternalBallisticsReport,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityConfig,
  PhysiologicalEntityState,
  VascularWoundRecord,
  VocalTraumaCue,
} from '../../contracts/physiology.ts';
import { TIER2_INTERNAL_ORGANS } from '../ghoul/bvhVolumes.ts';
import { copyVec3, vec3 } from '../ballistics/vec3.ts';

function createDefaultArmorIntegrity(
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

function createIdleBleedVisualProfile(): BleedVisualProfile {
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

function classifyShockStage(bloodVolumeMl: number): HemorrhagicShockStage {
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

function computeBleedVisualProfile(state: PhysiologicalEntityState): BleedVisualProfile {
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
    // Sharp systolic upstroke wave in [0.25, 1.0] synced to heartRateBpm
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

function recomputeMotorAndReadability(
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

  // Stage-4 Gameplay Reality Check: AI Accuracy Multiplier [0.08 .. 1.0]
  // Pierced heart, lung, or liver IMMEDIATELY drops AI accuracy <= 0.18 so crippled enemies spray wildly!
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

/**
 * Decoupled 4–10 Hz Physiological ECS State Machine + Stage-4 Fun/Real Readability Bridge.
 */
export class PhysiologyEcsSystem {
  public readonly tickHz: number;
  public readonly tickIntervalS: number;

  private accumulatorS = 0;
  private readonly entities = new Map<string, PhysiologicalEntityState>();
  private readonly denseList: PhysiologicalEntityState[] = [];

  constructor(tickHz: number = PHYSIOLOGY_CONSTANTS.DEFAULT_TICK_HZ) {
    const clampedHz = Math.max(1, Math.min(30, tickHz));
    this.tickHz = clampedHz;
    this.tickIntervalS = 1.0 / clampedHz;
  }

  public registerEntity(config: PhysiologicalEntityConfig): PhysiologicalEntityState {
    const existing = this.entities.get(config.entityId);
    if (existing) {
      return existing;
    }
    const state = createPhysiologicalEntityState(config);
    this.entities.set(config.entityId, state);
    this.denseList.push(state);
    return state;
  }

  public getEntity(entityId: string): PhysiologicalEntityState | undefined {
    return this.entities.get(entityId);
  }

  public getAllEntities(): readonly PhysiologicalEntityState[] {
    return this.denseList;
  }

  public removeEntity(entityId: string): boolean {
    const state = this.entities.get(entityId);
    if (!state) return false;
    this.entities.delete(entityId);
    const idx = this.denseList.indexOf(state);
    if (idx >= 0) {
      const last = this.denseList.pop()!;
      if (idx < this.denseList.length) {
        this.denseList[idx] = last;
      }
    }
    return true;
  }

  public reset(): void {
    this.accumulatorS = 0;
    this.entities.clear();
    this.denseList.length = 0;
  }

  /**
   * Vents trapped intrapleural air via needle decompression or occlusive chest seal,
   * arresting tension pneumothorax collapse and allowing SpO2 recovery!
   */
  public applyChestSealOrDecompression(entityId: string): boolean {
    const state = this.entities.get(entityId);
    if (!state || !state.alive) return false;
    if (
      state.pneumothoraxState === 'TENSION_PNEUMOTHORAX' ||
      state.pneumothoraxState === 'OPEN_PNEUMOTHORAX'
    ) {
      state.pneumothoraxState = 'DECOMPRESSED_SEALED';
      state.lungIntegrity = Math.max(state.lungIntegrity, 0.78);
      recomputeMotorAndReadability(state);
      return true;
    }
    return false;
  }

  /**
   * Applies an `InternalBallisticsReport` immediately upon projectile impact,
   * updating structural skeleton/nerves, vascular wounds, neurogenic vs adrenaline shock,
   * and Stage-4 immediate combat readability telemetry.
   */
  public applyBallisticTrauma(
    entityId: string,
    report: InternalBallisticsReport
  ): PhysiologicalEntityState {
    const state = this.entities.get(entityId);
    if (!state) {
      throw new Error(`PhysiologyEcsSystem: unknown entityId '${entityId}'`);
    }

    for (const plateId of Object.keys(report.plateIntegrityAfter) as ArmorPlateId[]) {
      state.plateIntegrity[plateId] = Math.min(
        state.plateIntegrity[plateId],
        report.plateIntegrityAfter[plateId]
      );
    }

    if (!report.hitOuterShell) {
      return state;
    }

    let reaction: ImmediatePostureReaction = 'NONE';
    let vocal: VocalTraumaCue = 'PAIN_GRUNT';
    let painSpike = 0;

    // 1. Backface Blunt Trauma from Stopped Ceramic/UHMWPE Armor Plate (only when stopped at outer strike face)
    if (report.stoppedByArmorPlate !== null && report.totalPenetrationDepthCm < 1.5) {
      painSpike += report.armorBackfaceBluntTraumaJ / 260;
      if (report.armorBackfaceBluntTraumaJ >= 65) {
        reaction = 'VIOLENT_CHEST_STAGGER';
        vocal = 'SHARP_GASP';
        state.diaphragmIntegrity = Math.max(0.76, state.diaphragmIntegrity - 0.15);
      }
    }

    // 2. Cortical Skeletal Fractures & Spinal Cord Transections
    for (const bt of report.boneTrauma) {
      if (!bt.fractured) continue;
      state.fracturedBones.add(bt.boneId);
      if (bt.shattered) {
        state.shatteredBones.add(bt.boneId);
      }
      painSpike += bt.shattered ? 0.62 : 0.45;

      switch (bt.boneId) {
        case 'FEMUR_LEFT':
          state.leftLegFunctional = false;
          state.canStand = false;
          reaction = 'LEG_COLLAPSE_PRONE';
          break;
        case 'FEMUR_RIGHT':
          state.rightLegFunctional = false;
          state.canStand = false;
          reaction = 'LEG_COLLAPSE_PRONE';
          break;
        case 'PELVIS':
          state.leftLegFunctional = false;
          state.rightLegFunctional = false;
          state.canStand = false;
          reaction = 'LEG_COLLAPSE_PRONE';
          break;
        case 'SPINE_THORACIC':
        case 'SPINE_LUMBAR':
          // Paraplegia: lower body collapses immediately, arms & trigger finger remain functional!
          state.leftLegFunctional = false;
          state.rightLegFunctional = false;
          state.canStand = false;
          reaction = 'LEG_COLLAPSE_PRONE';
          break;
        case 'SPINE_CERVICAL':
          state.leftLegFunctional = false;
          state.rightLegFunctional = false;
          state.canStand = false;
          if (bt.positionLocal.y >= 1.54 || bt.shattered) {
            // High C1–C4 phrenic + quadriplegic transection
            state.leftArmFunctional = false;
            state.rightArmFunctional = false;
            state.weaponDropped = true;
            state.canPullTrigger = false;
            state.diaphragmIntegrity = 0;
            state.locomotionMode = 'PARALYZED';
            state.conscious = false;
            state.alive = false;
            state.causeOfDeath = 'HIGH_CERVICAL_TRANSECTION';
            reaction = 'NEUROGENIC_DROP';
            vocal = 'NONE';
          } else {
            state.locomotionMode = 'PARALYZED';
            state.aimSwayMultiplier = Math.max(state.aimSwayMultiplier, 4.8);
            reaction = 'LEG_COLLAPSE_PRONE';
          }
          break;
        case 'HUMERUS_LEFT':
        case 'RADIUS_ULNA_LEFT':
          state.leftArmFunctional = false;
          state.aimSwayMultiplier = Math.min(6.0, Math.max(state.aimSwayMultiplier, 4.4));
          if (state.dominantHand === 'LEFT') {
            state.weaponDropped = true;
            state.canPullTrigger = false;
          }
          if (reaction === 'NONE') reaction = 'WEAPON_WRENCH_DROP';
          break;
        case 'HUMERUS_RIGHT':
        case 'RADIUS_ULNA_RIGHT':
          state.rightArmFunctional = false;
          state.aimSwayMultiplier = Math.min(6.0, Math.max(state.aimSwayMultiplier, 4.8));
          if (state.dominantHand === 'RIGHT') {
            state.weaponDropped = true;
            state.canPullTrigger = false;
          }
          if (reaction === 'NONE') reaction = 'WEAPON_WRENCH_DROP';
          break;
        default:
          break;
      }
    }

    // 3. Peripheral Neural Plexus Severing (Brachial Plexus Left/Right)
    for (const nv of report.nervesSevered) {
      state.severedNerves.add(nv);
      painSpike += 0.48;
      if (nv === 'BRACHIAL_PLEXUS_LEFT') {
        state.leftArmFunctional = false;
        state.aimSwayMultiplier = Math.min(6.0, Math.max(state.aimSwayMultiplier, 4.6));
        if (state.dominantHand === 'LEFT') {
          state.weaponDropped = true;
          state.canPullTrigger = false;
        }
      } else if (nv === 'BRACHIAL_PLEXUS_RIGHT') {
        state.rightArmFunctional = false;
        state.aimSwayMultiplier = Math.min(6.0, Math.max(state.aimSwayMultiplier, 5.2));
        if (state.dominantHand === 'RIGHT') {
          state.weaponDropped = true;
          state.canPullTrigger = false;
        }
      }
      if (reaction === 'NONE') {
        reaction = 'WEAPON_WRENCH_DROP';
      }
    }

    // 4. Internal Organ Trauma (Brain, Heart, Lungs, Diaphragm, Liver, GI)
    let organParenchymalBleedMlPerSec = 0;
    for (const ot of report.organTrauma) {
      const orgDef = TIER2_INTERNAL_ORGANS.find((o) => o.id === ot.organId);
      const organBleed = orgDef
        ? ot.stretchCavitationRuptured
          ? orgDef.ruptureBleedMlPerSec
          : orgDef.baseLacerationBleedMlPerSec * ot.severity
        : 0;
      organParenchymalBleedMlPerSec += organBleed;
      painSpike += 0.42 + ot.severity * 0.45;

      switch (ot.organId) {
        case 'BRAIN':
          state.brainIntegrity = Math.max(0, state.brainIntegrity - (0.65 + 0.5 * ot.severity));
          if (state.brainIntegrity <= 0.25 || ot.stretchCavitationRuptured) {
            state.brainIntegrity = 0;
            state.conscious = false;
            state.alive = false;
            state.causeOfDeath = 'CNS_BRAINSTEM_DESTRUCTION';
            reaction = 'NEUROGENIC_DROP';
            vocal = 'NONE';
          }
          break;

        case 'HEART':
          state.heartIntegrity = Math.max(0, state.heartIntegrity - (0.55 + 0.45 * ot.severity));
          reaction = 'VIOLENT_CHEST_STAGGER';
          vocal = 'SHARP_GASP';
          if (state.heartIntegrity <= 0.08 && ot.stretchCavitationRuptured) {
            state.cardiacOutputRatio = 0;
            state.meanArterialPressureMmHg = 0;
            state.conscious = false;
            state.alive = false;
            state.causeOfDeath = 'CARDIAC_DESTRUCTION';
          }
          // Register bright oxygenated cardiac hemorrhage source if not already hitting aorta
          this.mergeOrAddVascularWound(state, {
            vesselId: 'AORTA_THORACIC_ABDOMINAL',
            vesselKind: 'ARTERIAL',
            ghoulZone: 'TORSO_UPPER_THORAX',
            positionLocal: copyVec3(ot.positionLocal),
            positionWorld: copyVec3(ot.positionWorld),
            sprayDirectionWorld: vec3(0, 0.2, 1),
            severity: ot.severity,
            baseBleedMlPerSec: organBleed,
          });
          organParenchymalBleedMlPerSec -= organBleed;
          break;

        case 'LUNG_LEFT':
        case 'LUNG_RIGHT':
          state.lungIntegrity = Math.max(0.08, state.lungIntegrity - 0.32 * ot.severity);
          if (state.pneumothoraxState === 'NONE' || state.pneumothoraxState === 'OPEN_PNEUMOTHORAX') {
            state.pneumothoraxState =
              ot.severity >= 0.35 ? 'TENSION_PNEUMOTHORAX' : 'OPEN_PNEUMOTHORAX';
          }
          if (
            reaction === 'NONE' ||
            (reaction === 'WEAPON_WRENCH_DROP' && ot.directCrushLacerated)
          ) {
            reaction = 'VIOLENT_CHEST_STAGGER';
          }
          vocal = 'WET_HEMOTHORAX_COUGH';
          break;

        case 'DIAPHRAGM':
          state.diaphragmIntegrity = Math.max(0.15, state.diaphragmIntegrity - 0.55 * ot.severity);
          if (reaction !== 'LEG_COLLAPSE_PRONE' && reaction !== 'NEUROGENIC_DROP') {
            reaction = 'DIAPHRAGM_DROP_KNEEL';
          }
          vocal = 'SHARP_GASP';
          break;

        case 'LIVER':
          state.liverIntegrity = Math.max(0.05, state.liverIntegrity - (0.50 + 0.45 * ot.severity));
          if (reaction !== 'LEG_COLLAPSE_PRONE' && reaction !== 'NEUROGENIC_DROP') {
            reaction = 'DIAPHRAGM_DROP_KNEEL';
          }
          if (vocal !== 'WET_HEMOTHORAX_COUGH') {
            vocal = 'SHARP_GASP';
          }
          // Portal/hepatic venous dark-maroon hemorrhage
          this.mergeOrAddVascularWound(state, {
            vesselId: 'VENA_CAVA_JUGULAR_FEMORAL',
            vesselKind: 'VENOUS',
            ghoulZone: 'TORSO_LOWER_ABDOMEN',
            positionLocal: copyVec3(ot.positionLocal),
            positionWorld: copyVec3(ot.positionWorld),
            sprayDirectionWorld: vec3(0, -0.4, 0.9),
            severity: ot.severity,
            baseBleedMlPerSec: organBleed,
          });
          organParenchymalBleedMlPerSec -= organBleed;
          break;

        case 'GI_TRACT':
          state.giTractIntegrity = Math.max(0.1, state.giTractIntegrity - 0.45 * ot.severity);
          break;
      }
    }

    // 5. Major Vascular Spline Wounds (Arterial Jets vs Venous Ooze)
    for (const vw of report.vascularWounds) {
      this.mergeOrAddVascularWound(state, vw);
    }

    // If bullet traversed soft flesh without nicking a named major vessel, record microvascular venous muscle bleed
    if (
      state.vascularWounds.length === 0 &&
      report.woundTractMuscleBleedMlPerSec > 0 &&
      report.entryPointLocal &&
      report.entryPointWorld
    ) {
      this.mergeOrAddVascularWound(state, {
        vesselId: 'VENA_CAVA_JUGULAR_FEMORAL',
        vesselKind: 'VENOUS',
        ghoulZone: 'TORSO_UPPER_THORAX',
        positionLocal: copyVec3(report.entryPointLocal),
        positionWorld: copyVec3(report.entryPointWorld),
        sprayDirectionWorld: vec3(0, -0.5, 0.85),
        severity: 0.35,
        baseBleedMlPerSec: report.woundTractMuscleBleedMlPerSec,
      });
    }

    let totalVascularBleed = 0;
    for (const w of state.vascularWounds) {
      totalVascularBleed += w.baseBleedMlPerSec;
    }
    state.baseBleedRateMlPerSec =
      totalVascularBleed +
      Math.max(0, organParenchymalBleedMlPerSec) +
      (report.vascularWounds.length > 0 ? report.woundTractMuscleBleedMlPerSec * 0.4 : 0);

    const mapRatio = Math.max(
      0.08,
      state.meanArterialPressureMmHg / PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG
    );
    state.effectiveBleedRateMlPerSec = state.alive ? state.baseBleedRateMlPerSec * mapRatio : 0;

    // 6. Neurogenic Pain Shock vs Combat Adrenaline Buffer
    painSpike += Math.min(0.65, report.totalEnergyDepositedJ / 950);
    state.painShockLevel = Math.min(2.0, state.painShockLevel + painSpike);

    const isTorsoHit =
      report.entryPointLocal !== null &&
      report.entryPointLocal.y >= 0.92 &&
      report.entryPointLocal.y <= 1.54 &&
      Math.abs(report.entryPointLocal.x) <= 0.21;

    const isDefeatedAtOuterArmor =
      report.stoppedByArmorPlate !== null && report.totalPenetrationDepthCm < 1.5;
    const adrenalineBuffer = 0.14 + state.adrenalineLevel * 1.65;
    if (
      state.alive &&
      state.conscious &&
      state.alertnessState === 'UNSUSPECTING' &&
      isTorsoHit &&
      !isDefeatedAtOuterArmor &&
      painSpike > adrenalineBuffer
    ) {
      // Unsuspecting target suffers immediate neurogenic shock knockdown!
      state.neurogenicShockCollapsed = true;
      state.conscious = false;
      state.canStand = false;
      state.canPullTrigger = false;
      state.locomotionMode = 'PARALYZED';
      reaction = 'NEUROGENIC_DROP';
      vocal = 'SHARP_GASP';
    } else if (state.alive && state.conscious && isTorsoHit && reaction === 'NONE') {
      // High-adrenaline alerted target stays conscious via adrenaline buffer,
      // yet still exhibits unmistakable physical torso stagger!
      reaction = 'VIOLENT_CHEST_STAGGER';
    }

    recomputeMotorAndReadability(state, reaction, vocal);
    return state;
  }

  private mergeOrAddVascularWound(
    state: PhysiologicalEntityState,
    incoming: VascularWoundRecord
  ): void {
    const existingIdx = state.vascularWounds.findIndex(
      (w) => w.vesselId === incoming.vesselId && w.vesselKind === incoming.vesselKind
    );
    if (existingIdx >= 0) {
      const prev = state.vascularWounds[existingIdx];
      if (incoming.baseBleedMlPerSec > prev.baseBleedMlPerSec) {
        state.vascularWounds[existingIdx] = incoming;
      }
    } else {
      state.vascularWounds.push(incoming);
    }
  }

  /**
   * Advances high-frequency frame clock `dt` (e.g., 60–144 Hz), executing biological ODE ticks
   * strictly at the decoupled 4–10 Hz interval (`tickIntervalS`, default 0.125s = 8 Hz).
   * Returns the number of biological ticks executed during this call.
   */
  public update(dt: number): number {
    if (dt <= 0 || !Number.isFinite(dt)) return 0;

    for (let i = 0; i < this.denseList.length; i++) {
      const entity = this.denseList[i];
      entity.elapsedTimeS += dt;
    }

    this.accumulatorS += dt;
    let ticksExecuted = 0;

    while (this.accumulatorS + 1e-9 >= this.tickIntervalS) {
      this.accumulatorS -= this.tickIntervalS;
      ticksExecuted++;
      for (let i = 0; i < this.denseList.length; i++) {
        this.stepBiologicalTick(this.denseList[i], this.tickIntervalS);
      }
    }

    // Refresh systolic pulse wave phase on non-tick frames for smooth arterial spray visuals
    if (ticksExecuted === 0) {
      for (let i = 0; i < this.denseList.length; i++) {
        const st = this.denseList[i];
        if (st.vascularWounds.length > 0) {
          st.readability.bleedVisualProfile = computeBleedVisualProfile(st);
        }
      }
    }

    return ticksExecuted;
  }

  private stepBiologicalTick(state: PhysiologicalEntityState, tickDt: number): void {
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

    // 1. Adrenaline Buffer Decay over 30–90s envelope
    if (state.alertnessState === 'COMBAT_ALERT' && state.adrenalineLevel > 0.10) {
      const decayPerSec =
        (PHYSIOLOGY_CONSTANTS.COMBAT_ALERT_ADRENALINE - 0.10) /
        Math.max(15, state.adrenalineDecayDurationS);
      state.adrenalineLevel = Math.max(0.10, state.adrenalineLevel - decayPerSec * tickDt);
    }

    // 2. Pressure-Scaled Hemorrhage & Blood Volume Loss
    const currentPressureRatio = Math.max(
      0.10,
      state.meanArterialPressureMmHg / PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG
    );
    state.effectiveBleedRateMlPerSec = state.baseBleedRateMlPerSec * currentPressureRatio;
    state.bloodVolumeMl = Math.max(
      0,
      state.bloodVolumeMl - state.effectiveBleedRateMlPerSec * tickDt
    );

    // 3. Shock Stage, Baroreceptor Tachycardia & Mean Arterial Pressure (MAP)
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

    // Sympathetic Heart Rate Response (>125 BPM in Class III shock!)
    const lossFraction = 1.0 - volRatio;
    if (state.shockStage === 'CLASS_IV') {
      state.heartRateBpm = 38; // Agonal bradycardia prior to arrest
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

    // Class IV Exsanguination Arrest (>50% blood loss -> < 2,500 mL)
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

    // Severe Cerebral Hypotension Coma (MAP < 45 mmHg)
    if (state.meanArterialPressureMmHg < PHYSIOLOGY_CONSTANTS.HYPOTENSION_UNCONSCIOUS_MAP_MMHG) {
      state.conscious = false;
    }

    // 4. Pulmonary Collapse (Pneumothorax) & Sigmoidal Oxyhemoglobin (SpO2) Curve
    if (state.pneumothoraxState === 'TENSION_PNEUMOTHORAX') {
      // One-way pleural valve progressively collapses ipsilateral + mediastinal contralateral lung
      state.lungIntegrity = Math.max(0.04, state.lungIntegrity - 0.095 * tickDt);
    } else if (state.pneumothoraxState === 'OPEN_PNEUMOTHORAX') {
      state.lungIntegrity = Math.max(0.45, state.lungIntegrity - 0.03 * tickDt);
    } else if (state.pneumothoraxState === 'DECOMPRESSED_SEALED') {
      state.lungIntegrity = Math.min(0.92, state.lungIntegrity + 0.065 * tickDt);
    }

    const respiratoryDrive = 0.25 + 0.75 * state.diaphragmIntegrity;
    const perfusionMatch = Math.min(1.05, 0.52 + 0.48 * state.cardiacOutputRatio);
    const vq = Math.max(0, state.lungIntegrity * respiratoryDrive * perfusionMatch);

    // Hill-type sigmoidal hemoglobin saturation: single vented lung (vq ~ 0.7) holds ~93–96% SpO2,
    // while progressive tension pneumothorax collapse (vq < 0.25) plummets <65% -> <45%!
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
}
