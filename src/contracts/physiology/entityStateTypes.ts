import { ArmorPlateId } from './armorShellTypes.ts';
import {
  NeuralPlexusId,
  SkeletalStructureId,
} from './internalAnatomyTypes.ts';
import { VascularWoundRecord } from './rayMarchRecords.ts';

/**
 * Stage 3 & Stage 4: Decoupled Physiological ECS State & Fun-vs-Real Readability Telemetry.
 */
export type HemorrhagicShockStage =
  | 'NONE'
  | 'CLASS_I'
  | 'CLASS_II'
  | 'CLASS_III'
  | 'CLASS_IV';

export type PneumothoraxState =
  | 'NONE'
  | 'OPEN_PNEUMOTHORAX'
  | 'TENSION_PNEUMOTHORAX'
  | 'DECOMPRESSED_SEALED';

export type LocomotionMode =
  | 'STANDING_MOBILE'
  | 'STAGGERED_LIMP'
  | 'KNEELING_WINDED'
  | 'PRONE_CRAWL'
  | 'PARALYZED';

export type CombatAlertnessState = 'UNSUSPECTING' | 'COMBAT_ALERT';

export type CauseOfDeath =
  | 'NONE'
  | 'CNS_BRAINSTEM_DESTRUCTION'
  | 'HIGH_CERVICAL_TRANSECTION'
  | 'CARDIAC_DESTRUCTION'
  | 'EXSANGUINATION_CLASS_IV_ARREST'
  | 'HYPOXIC_ASPHYXIA_ARREST';

export type ImmediatePostureReaction =
  | 'NONE'
  | 'DIAPHRAGM_DROP_KNEEL'
  | 'VIOLENT_CHEST_STAGGER'
  | 'LEG_COLLAPSE_PRONE'
  | 'WEAPON_WRENCH_DROP'
  | 'NEUROGENIC_DROP';

export type VocalTraumaCue =
  | 'NONE'
  | 'SHARP_GASP'
  | 'WET_HEMOTHORAX_COUGH'
  | 'AGUNAL_WHEEZE'
  | 'PAIN_GRUNT';

export type BleedVisualProfileKind =
  | 'NONE'
  | 'ARTERIAL_PULSING_JET'
  | 'VENOUS_DARK_OOZE';

export interface BleedVisualProfile {
  readonly kind: BleedVisualProfileKind;
  /** Linear RGB [r, g, b]: bright oxygenated crimson [0.96, 0.04, 0.06] vs dark maroon [0.32, 0.01, 0.03] */
  readonly rgbColor: readonly [number, number, number];
  readonly pulsatile: boolean;
  readonly pulseFrequencyHz: number;
  readonly systolicPulseWave: number;
  /** Spray velocity in m/s: 3.5–6.5 m/s for high-pressure arterial jets, 0.35–0.85 m/s for venous ooze */
  readonly sprayVelocityMs: number;
  readonly floorPoolGrowthRateMPerSec: number;
}

export interface ReadabilityFeedbackState {
  immediatePostureReaction: ImmediatePostureReaction;
  vocalCue: VocalTraumaCue;
  /** 0.08..1.0 — drops immediately <= 0.18 on heart/lung/liver shock so injured AI cannot laser-snipe */
  aiAccuracyMultiplier: number;
  staminaMultiplier: number;
  visionTunnelIntensity: number;
  bleedVisualProfile: BleedVisualProfile;
}

export interface PhysiologicalEntityConfig {
  readonly entityId: string;
  readonly alertnessState?: CombatAlertnessState;
  readonly dominantHand?: 'RIGHT' | 'LEFT';
  readonly enableArmorPlates?: boolean;
  readonly enableHelmet?: boolean;
  /** Time in seconds over which combat adrenaline decays (default 60s, within 30–90s envelope) */
  readonly adrenalineDecayDurationS?: number;
}

export interface PhysiologicalEntityState {
  readonly entityId: string;
  alive: boolean;
  conscious: boolean;
  causeOfDeath: CauseOfDeath;

  // Hemodynamics (5,000 mL baseline)
  bloodVolumeMl: number;
  readonly maxBloodVolumeMl: number;
  baseBleedRateMlPerSec: number;
  effectiveBleedRateMlPerSec: number;
  meanArterialPressureMmHg: number;
  systolicBpMmHg: number;
  diastolicBpMmHg: number;
  heartRateBpm: number;
  cardiacOutputRatio: number;
  shockStage: HemorrhagicShockStage;

  // Respiratory & Oxygenation (99% SpO2 baseline)
  oxygenSaturationPct: number;
  lungIntegrity: number;
  heartIntegrity: number;
  brainIntegrity: number;
  liverIntegrity: number;
  diaphragmIntegrity: number;
  giTractIntegrity: number;
  pneumothoraxState: PneumothoraxState;

  // Biomechanical & Motor Control
  canStand: boolean;
  canPullTrigger: boolean;
  leftLegFunctional: boolean;
  rightLegFunctional: boolean;
  leftArmFunctional: boolean;
  rightArmFunctional: boolean;
  weaponDropped: boolean;
  dominantHand: 'RIGHT' | 'LEFT';
  aimSwayMultiplier: number;
  locomotionMode: LocomotionMode;

  // Neurogenic Shock & Adrenaline Buffer
  alertnessState: CombatAlertnessState;
  adrenalineLevel: number;
  adrenalineDecayDurationS: number;
  painShockLevel: number;
  neurogenicShockCollapsed: boolean;

  // Accumulated Structural & Vascular State
  plateIntegrity: Record<ArmorPlateId, number>;
  fracturedBones: Set<SkeletalStructureId>;
  shatteredBones: Set<SkeletalStructureId>;
  severedNerves: Set<NeuralPlexusId>;
  vascularWounds: VascularWoundRecord[];

  // Timing & Stage-4 Readability Bridge
  elapsedTimeS: number;
  biologicalTicksExecuted: number;
  readability: ReadabilityFeedbackState;
}
