import { AmmoSpec, GhoulZoneId, Vec3Like } from './ballistics.ts';

/**
 * Tier-1 Ballistic Armor & Helmet Strike-Face Identifiers.
 * Models exact swimmer/shooter-cut ESAPI thoracic plates and side SAPI cummerbund plates,
 * intentionally exposing axillary (armpit) and supraclavicular (collarbone) anatomical gaps.
 */
export type ArmorPlateId =
  | 'FRONT_ESAPI_PLATE'
  | 'BACK_ESAPI_PLATE'
  | 'SIDE_SAPI_LEFT'
  | 'SIDE_SAPI_RIGHT'
  | 'HELMET_BALLISTIC_SHELL';

export type ArmorMaterialKind =
  | 'CERAMIC_ESAPI_IV'
  | 'UHMWPE_III_PLUS'
  | 'ARAMID_HELMET_IIIA';

/**
 * Tier-1 Outer Shell Volume Identifiers (Clothing + Skin/Muscle Sub-Capsules/OBBs).
 */
export type OuterShellPartId =
  | 'TACTICAL_CLOTHING_TORSO'
  | 'HEAD_SCALP_SHELL'
  | 'NECK_SHELL'
  | 'THORAX_SKIN_MUSCLE'
  | 'AXILLARY_GAP_LEFT'
  | 'AXILLARY_GAP_RIGHT'
  | 'SUPRACLAVICULAR_COLLAR_SHELL'
  | 'ABDOMEN_SKIN_MUSCLE'
  | 'PELVIS_SKIN_MUSCLE'
  | 'UPPER_ARM_LEFT_SHELL'
  | 'UPPER_ARM_RIGHT_SHELL'
  | 'FOREARM_LEFT_SHELL'
  | 'FOREARM_RIGHT_SHELL'
  | 'THIGH_LEFT_SHELL'
  | 'THIGH_RIGHT_SHELL'
  | 'CALF_LEFT_SHELL'
  | 'CALF_RIGHT_SHELL';

export type BvhPrimitiveShape = 'AABB' | 'OBB' | 'CAPSULE' | 'SPHERE';

export interface Tier1ArmorPlateVolume {
  readonly id: ArmorPlateId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly material: ArmorMaterialKind;
  readonly shape: 'OBB' | 'SPHERE';
  readonly localCenter: Vec3Like;
  readonly halfExtents: Vec3Like;
  /** Orthonormal local orientation axes of the OBB in character local space */
  readonly basisRight: Vec3Like;
  readonly basisUp: Vec3Like;
  readonly basisForward: Vec3Like;
  /**
   * Optional swimmer-cut upper corner bevel fraction [0..0.5]:
   * trims top-outer corners of thoracic ESAPI plates to expose axillary/pectoral crease.
   */
  readonly swimmerCutCornerFraction?: number;
  readonly thicknessM: number;
  readonly densityKgM3: number;
  /** Maximum effective threat energy (Joules / armorPenetrationFactor) defeated at 100% integrity */
  readonly maxStopEnergyJ: number;
  /** Fraction of defeated kinetic energy coupled as blunt backface trauma into underlying thorax */
  readonly backfaceBluntTransferRatio: number;
  /** Integrity lost per 1,000 J of impact energy on ceramic/composite strike face */
  readonly degradationPerKilojoule: number;
}

export interface Tier1OuterShellVolume {
  readonly id: OuterShellPartId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly material: 'TACTICAL_CLOTHING' | 'SKIN_SUBCUTANEOUS' | 'SKELETAL_MUSCLE';
  readonly shape: BvhPrimitiveShape;
  readonly localCenter: Vec3Like;
  readonly halfExtents: Vec3Like;
  readonly capsuleStart?: Vec3Like;
  readonly capsuleEnd?: Vec3Like;
  readonly capsuleRadiusM?: number;
  readonly basisRight?: Vec3Like;
  readonly basisUp?: Vec3Like;
  readonly basisForward?: Vec3Like;
  readonly densityKgM3: number;
}

/**
 * Tier-2 Internal Organ Identifiers.
 * Note: `BRAIN` and `LIVER` are marked `isInelastic: true` (high vulnerability to temporary stretch cavitation).
 */
export type InternalOrganId =
  | 'BRAIN'
  | 'HEART'
  | 'LUNG_LEFT'
  | 'LUNG_RIGHT'
  | 'DIAPHRAGM'
  | 'LIVER'
  | 'GI_TRACT';

/**
 * Tier-2 Cortical Skeletal Identifiers.
 */
export type SkeletalStructureId =
  | 'SKULL'
  | 'SPINE_CERVICAL'
  | 'SPINE_THORACIC'
  | 'SPINE_LUMBAR'
  | 'RIB_CAGE'
  | 'PELVIS'
  | 'FEMUR_LEFT'
  | 'FEMUR_RIGHT'
  | 'HUMERUS_LEFT'
  | 'HUMERUS_RIGHT'
  | 'RADIUS_ULNA_LEFT'
  | 'RADIUS_ULNA_RIGHT';

/**
 * Tier-2 Major Peripheral Neural Plexus Identifiers.
 */
export type NeuralPlexusId =
  | 'BRACHIAL_PLEXUS_LEFT'
  | 'BRACHIAL_PLEXUS_RIGHT';

/**
 * Tier-2 Major Vascular 3D Spline Identifiers.
 */
export type VascularVesselId =
  | 'CAROTID_LEFT'
  | 'CAROTID_RIGHT'
  | 'SUBCLAVIAN_LEFT'
  | 'SUBCLAVIAN_RIGHT'
  | 'AORTA_THORACIC_ABDOMINAL'
  | 'FEMORAL_LEFT'
  | 'FEMORAL_RIGHT'
  | 'VENA_CAVA_JUGULAR_FEMORAL'
  | 'JUGULAR_VENOUS_LEFT'
  | 'JUGULAR_VENOUS_RIGHT'
  | 'FEMORAL_VENOUS_LEFT'
  | 'FEMORAL_VENOUS_RIGHT';

export type VesselKind = 'ARTERIAL' | 'VENOUS';

export interface InternalOrganVolume {
  readonly id: InternalOrganId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly shape: BvhPrimitiveShape;
  readonly localCenter: Vec3Like;
  readonly halfExtents: Vec3Like;
  readonly densityKgM3: number;
  /** Inelastic friable parenchyma (Brain, Liver) shatters/ruptures under hydrostatic temporary stretch */
  readonly isInelastic: boolean;
  /** Energy deposition per step or cumulative stretch threshold (J) causing parenchymal rupture */
  readonly parenchymaRuptureThresholdJ: number;
  readonly baseLacerationBleedMlPerSec: number;
  readonly ruptureBleedMlPerSec: number;
  readonly bleedVesselKind: VesselKind;
}

export interface SkeletalBoneVolume {
  readonly id: SkeletalStructureId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly shape: BvhPrimitiveShape;
  readonly localCenter: Vec3Like;
  readonly halfExtents: Vec3Like;
  readonly capsuleStart?: Vec3Like;
  readonly capsuleEnd?: Vec3Like;
  readonly capsuleRadiusM?: number;
  /** Optional hollow inner cavity half-extents (for cranial vault & thoracic ribcage shell) */
  readonly hollowInnerHalfExtents?: Vec3Like;
  readonly densityKgM3: number;
  readonly fractureThresholdJ: number;
  readonly shatterThresholdJ: number;
  readonly isLoadBearingLocomotion: boolean;
  readonly spinalSegment?: 'CERVICAL' | 'THORACIC' | 'LUMBAR';
}

export interface NeuralPlexusVolume {
  readonly id: NeuralPlexusId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly side: 'LEFT' | 'RIGHT';
  readonly capsuleStart: Vec3Like;
  readonly capsuleEnd: Vec3Like;
  readonly capsuleRadiusM: number;
}

export interface VascularSpline {
  readonly id: VascularVesselId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly vesselKind: VesselKind;
  /** 3D Catmull-Rom / piecewise control points in standing character local space */
  readonly controlPoints: readonly Vec3Like[];
  /** Vessel lumen radius in meters */
  readonly lumenRadiusM: number;
  /** Baseline hemorrhage rate (mL/sec) at normal Mean Arterial Pressure (93 mmHg) */
  readonly mlPerSec: number;
}

/**
 * Optional animated or ragdoll bone pose override for transforming local BVH primitives into posed space.
 */
export interface BonePoseFrame {
  readonly positionWorld: Vec3Like;
  readonly basisRight: Vec3Like;
  readonly basisUp: Vec3Like;
  readonly basisForward: Vec3Like;
}

export interface CharacterTransform {
  readonly positionWorld: Vec3Like;
  readonly yawRad: number;
  readonly bonePoseOverrides?: Partial<Record<GhoulZoneId, BonePoseFrame>>;
}

/**
 * Spatial distance match against a 3D vascular spline at a ray-march sample step.
 */
export interface VascularSplineProximityHit {
  readonly spline: VascularSpline;
  /** Minimum 3D Euclidean distance from sample segment/point to spline centerline (meters) */
  readonly centerDistanceM: number;
  /** Signed clearance to vessel wall (`centerDistanceM - spline.lumenRadiusM`) */
  readonly surfaceDistanceM: number;
  readonly closestPointLocal: Vec3Like;
  readonly tangentLocal: Vec3Like;
  readonly parameterT: number;
}

/**
 * Complete Tier-2 spatial query result at a 3D internal sample point + cavitation query radius.
 */
export interface Tier2SpatialQueryResult {
  readonly samplePointLocal: Vec3Like;
  readonly localTissueDensityKgM3: number;
  readonly directOrgans: InternalOrganVolume[];
  readonly crushOrgans: InternalOrganVolume[];
  readonly stretchOrgans: InternalOrganVolume[];
  readonly hitBones: SkeletalBoneVolume[];
  readonly crushNerves: NeuralPlexusVolume[];
  readonly stretchNerves: NeuralPlexusVolume[];
  readonly crushVessels: VascularSplineProximityHit[];
  readonly stretchVessels: VascularSplineProximityHit[];
}

/**
 * Stage 2: Sub-Stepped Internal Ballistics Raymarch Contracts.
 */
export interface RayMarchStepRecord {
  readonly stepIndex: number;
  readonly positionLocal: Vec3Like;
  readonly positionWorld: Vec3Like;
  readonly depthCm: number;
  readonly tissueDensityKgM3: number;
  readonly velocityMs: number;
  readonly kineticEnergyJ: number;
  readonly energyDepositedStepJ: number;
  readonly yawAngleDeg: number;
  readonly effectiveCaliberM: number;
  readonly crushRadiusM: number;
  readonly stretchRadiusM: number;
  readonly stretchCavitationActive: boolean;
  readonly armorPlateHit: ArmorPlateId | null;
  readonly organsCrushed: InternalOrganId[];
  readonly organsStretched: InternalOrganId[];
  readonly bonesHit: SkeletalStructureId[];
  readonly nervesHit: NeuralPlexusId[];
  readonly vesselsHit: VascularVesselId[];
  readonly fragmentSpawned: boolean;
}

export interface SecondaryFragmentTrajectory {
  readonly fragmentId: string;
  readonly kind: 'JACKET_FRAGMENT' | 'CORTICAL_BONE_SHARD';
  readonly sourceBoneId?: SkeletalStructureId;
  readonly originLocal: Vec3Like;
  readonly directionLocal: Vec3Like;
  readonly coneAngleDeg: number;
  readonly initialVelocityMs: number;
  readonly initialEnergyJ: number;
  readonly travelDistanceCm: number;
  readonly organsLacerated: InternalOrganId[];
  readonly vesselsLacerated: VascularVesselId[];
  readonly nervesLacerated: NeuralPlexusId[];
}

export interface VascularWoundRecord {
  readonly vesselId: VascularVesselId;
  readonly vesselKind: VesselKind;
  readonly ghoulZone: GhoulZoneId;
  readonly positionLocal: Vec3Like;
  readonly positionWorld: Vec3Like;
  readonly sprayDirectionWorld: Vec3Like;
  /** 1.0 = full direct crush transection, 0.35..0.75 = stretch avulsion or fragment nick */
  readonly severity: number;
  /** Baseline hemorrhage rate in mL/s at MAP = 93 mmHg */
  readonly baseBleedMlPerSec: number;
}

export interface OrganTraumaRecord {
  readonly organId: InternalOrganId;
  readonly isInelastic: boolean;
  readonly directCrushLacerated: boolean;
  readonly stretchCavitationRuptured: boolean;
  readonly energyDepositedJ: number;
  readonly severity: number;
  readonly positionLocal: Vec3Like;
  readonly positionWorld: Vec3Like;
}

export interface BoneTraumaRecord {
  readonly boneId: SkeletalStructureId;
  readonly fractured: boolean;
  readonly shattered: boolean;
  readonly energyDepositedJ: number;
  readonly deflectionAngleDeg: number;
  readonly spawnedShardCount: number;
  readonly positionLocal: Vec3Like;
}

export interface InternalBallisticsConfig {
  /** Sub-step march increment in meters (default 0.012 = 1.2 cm) */
  readonly stepSizeM?: number;
  /** Maximum internal path length marched in meters (default 0.90 m) */
  readonly maxMarchDistanceM?: number;
  /** Initial projectile incidence/yaw angle at outer shell entry in degrees (default 1.5 deg) */
  readonly initialYawAngleDeg?: number;
  /** Velocity threshold in m/s above which elastic soft tissue suffers destructive stretch cavitation (default 600 m/s) */
  readonly stretchVelocityThresholdMs?: number;
  /** Velocity threshold in m/s above which yawing 5.56/5.45 spitzer FMJ shears into jacket fragments (default 730 m/s) */
  readonly spitzerFragmentVelocityThresholdMs?: number;
  readonly enableArmorPlates?: boolean;
  readonly enableHelmet?: boolean;
  readonly initialPlateIntegrity?: Partial<Record<ArmorPlateId, number>>;
  readonly deterministicSeed?: number;
}

export interface InternalBallisticsInput {
  readonly ammo: AmmoSpec;
  readonly rayOriginWorld: Vec3Like;
  readonly rayDirectionWorld: Vec3Like;
  readonly impactVelocityMs: number;
  readonly characterTransform?: CharacterTransform;
  readonly config?: InternalBallisticsConfig;
}

export interface InternalBallisticsReport {
  readonly hitOuterShell: boolean;
  readonly entryPointLocal: Vec3Like | null;
  readonly exitPointLocal: Vec3Like | null;
  readonly entryPointWorld: Vec3Like | null;
  readonly exitPointWorld: Vec3Like | null;
  readonly entryVelocityMs: number;
  readonly exitVelocityMs: number;
  readonly entryEnergyJ: number;
  readonly exitEnergyJ: number;
  readonly totalEnergyDepositedJ: number;
  readonly totalPenetrationDepthCm: number;
  readonly overPenetrated: boolean;
  readonly stoppedByArmorPlate: ArmorPlateId | null;
  readonly armorPlatesIntersected: ArmorPlateId[];
  readonly armorBackfaceBluntTraumaJ: number;
  readonly plateIntegrityAfter: Record<ArmorPlateId, number>;
  readonly peakYawAngleDeg: number;
  /** Distance in cm traveled inside soft tissue before yaw angle exceeds 25 degrees ("narrow neck") */
  readonly narrowNeckDepthCm: number | null;
  readonly steps: RayMarchStepRecord[];
  readonly secondaryFragments: SecondaryFragmentTrajectory[];
  readonly organTrauma: OrganTraumaRecord[];
  readonly boneTrauma: BoneTraumaRecord[];
  readonly nervesSevered: NeuralPlexusId[];
  readonly vascularWounds: VascularWoundRecord[];
  readonly woundTractMuscleBleedMlPerSec: number;
}

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

/**
 * Tuned Scientific + Gameplay ("Fun vs Real") Baseline Constants.
 */
export const PHYSIOLOGY_CONSTANTS = {
  DEFAULT_TICK_HZ: 8,
  DEFAULT_TICK_INTERVAL_S: 0.125,
  DEFAULT_RAYMARCH_STEP_M: 0.012,
  STRETCH_CAVITY_VELOCITY_THRESHOLD_MS: 600,
  SPITZER_FRAGMENT_VELOCITY_THRESHOLD_MS: 730,

  BASELINE_BLOOD_VOLUME_ML: 5000,
  CLASS_I_BLOOD_VOLUME_ML: 4250,   // >15% loss
  CLASS_II_BLOOD_VOLUME_ML: 3750,  // >25% loss
  CLASS_III_BLOOD_VOLUME_ML: 3500, // >30% loss -> Class III Hemorrhagic Shock
  CLASS_IV_ARREST_VOLUME_ML: 2500, // >50% loss -> Class IV Coma / Exsanguination Arrest

  BASELINE_MAP_MMHG: 93,
  BASELINE_SYSTOLIC_MMHG: 120,
  BASELINE_DIASTOLIC_MMHG: 80,
  HYPOTENSION_UNCONSCIOUS_MAP_MMHG: 45,
  BASELINE_HEART_RATE_BPM: 72,
  CLASS_III_MIN_HEART_RATE_BPM: 128,

  BASELINE_SPO2_PCT: 99,
  HYPOXIA_COMA_SPO2_PCT: 65,
  HYPOXIC_ARREST_SPO2_PCT: 45,

  UNSUSPECTING_ADRENALINE: 0.05,
  COMBAT_ALERT_ADRENALINE: 0.85,
  DEFAULT_ADRENALINE_DECAY_S: 60,

  ARTERIAL_CRIMSON_RGB: [0.96, 0.04, 0.06] as const,
  VENOUS_MAROON_RGB: [0.32, 0.01, 0.03] as const,

  TISSUE_DENSITY_KG_M3: {
    TACTICAL_CLOTHING: 320,
    LUNG_PARENCHYMA: 450,
    FAT_GI_VISCERA: 950,
    SKELETAL_MUSCLE: 1060,
    HEART_DIAPHRAGM: 1060,
    BRAIN_LIVER_PAREN: 1080,
    CORTICAL_BONE: 1900,
  },
} as const;
