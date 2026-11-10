import { GhoulZoneId, Vec3Like } from '../../contracts/ballistics.ts';
import {
  ArmorPlateId,
  BonePoseFrame,
  CharacterTransform,
  InternalOrganVolume,
  NeuralPlexusVolume,
  PHYSIOLOGY_CONSTANTS,
  SkeletalBoneVolume,
  Tier1ArmorPlateVolume,
  Tier1OuterShellVolume,
  Tier2SpatialQueryResult,
  VascularSpline,
  VascularSplineProximityHit,
} from '../../contracts/physiology.ts';
import {
  add,
  copyVec3,
  dot,
  length,
  lengthSq,
  lerp,
  normalize,
  scale,
  sub,
  vec3,
} from '../ballistics/vec3.ts';

export interface AxisAlignedBox {
  readonly min: Vec3Like;
  readonly max: Vec3Like;
}

export interface RayIntervalHit {
  readonly hit: boolean;
  readonly tMin: number;
  readonly tMax: number;
}

interface BakedSplineSegment {
  readonly p0: Vec3Like;
  readonly p1: Vec3Like;
  readonly t0: number;
  readonly t1: number;
  readonly tangent: Vec3Like;
}

interface BakedVascularSpline {
  readonly spline: VascularSpline;
  readonly aabb: AxisAlignedBox;
  readonly segments: readonly BakedSplineSegment[];
}

interface BvhGroupNode<T> {
  readonly aabb: AxisAlignedBox;
  readonly items: readonly { readonly aabb: AxisAlignedBox; readonly item: T }[];
}

export const DEFAULT_CHARACTER_TRANSFORM: CharacterTransform = {
  positionWorld: { x: 0, y: 0, z: 0 },
  yawRad: 0,
};

/**
 * Standing Rest Joint Origins (matching GHOUL_ZONE_HIERARCHY) for optional posed-bone space transforms.
 */
const STANDING_ZONE_PIVOTS: Partial<Record<GhoulZoneId, Vec3Like>> = {
  HEAD_CRANIUM: { x: 0, y: 1.66, z: 0 },
  NECK_CERVICAL: { x: 0, y: 1.55, z: 0 },
  TORSO_UPPER_THORAX: { x: 0, y: 1.30, z: 0 },
  TORSO_LOWER_ABDOMEN: { x: 0, y: 1.10, z: 0 },
  PELVIS_GROIN: { x: 0, y: 0.95, z: 0 },
  SHOULDER_LEFT: { x: -0.22, y: 1.48, z: 0 },
  SHOULDER_RIGHT: { x: 0.22, y: 1.48, z: 0 },
  UPPER_ARM_LEFT: { x: -0.28, y: 1.38, z: 0 },
  UPPER_ARM_RIGHT: { x: 0.28, y: 1.38, z: 0 },
  FOREARM_LEFT: { x: -0.30, y: 1.14, z: 0.02 },
  FOREARM_RIGHT: { x: 0.30, y: 1.14, z: 0.02 },
  THIGH_LEFT: { x: -0.115, y: 0.86, z: 0 },
  THIGH_RIGHT: { x: 0.115, y: 0.86, z: 0 },
  SHIN_LEFT: { x: -0.12, y: 0.2825, z: 0.01 },
  SHIN_RIGHT: { x: 0.12, y: 0.2825, z: 0.01 },
};

// ============================================================================
// TIER-1 EXACT ARMOR GEOMETRY (Swimmer/ESAPI Plates + Ops Helmet)
// Exposes Axillary/Armpit (|x| > 0.125, y in [1.31, 1.48]) and
// Supraclavicular/Collarbone (y in [1.465, 1.53]) anatomical gaps!
// ============================================================================
export const TIER1_ARMOR_PLATES: readonly Tier1ArmorPlateVolume[] = [
  {
    id: 'FRONT_ESAPI_PLATE',
    label: 'Front Thoracic Swimmer-Cut ESAPI Level IV Ceramic Plate',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'CERAMIC_ESAPI_IV',
    shape: 'OBB',
    localCenter: vec3(0, 1.32, 0.132),
    halfExtents: vec3(0.125, 0.14, 0.013), // x in [-0.125, 0.125], y in [1.18, 1.46]
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    swimmerCutCornerFraction: 0.22,
    thicknessM: 0.026,
    densityKgM3: 2850,
    maxStopEnergyJ: 4400,
    backfaceBluntTransferRatio: 0.095,
    degradationPerKilojoule: 0.22,
  },
  {
    id: 'BACK_ESAPI_PLATE',
    label: 'Rear Thoracic ESAPI Level IV Ceramic Plate',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'CERAMIC_ESAPI_IV',
    shape: 'OBB',
    localCenter: vec3(0, 1.32, -0.132),
    halfExtents: vec3(0.125, 0.14, 0.013), // x in [-0.125, 0.125], y in [1.18, 1.46]
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    swimmerCutCornerFraction: 0.16,
    thicknessM: 0.026,
    densityKgM3: 2850,
    maxStopEnergyJ: 4400,
    backfaceBluntTransferRatio: 0.095,
    degradationPerKilojoule: 0.22,
  },
  {
    id: 'SIDE_SAPI_LEFT',
    label: 'Left Cummerbund 6x6 Side SAPI Plate (Lower Flank)',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'UHMWPE_III_PLUS',
    shape: 'OBB',
    localCenter: vec3(-0.184, 1.22, 0.0),
    halfExtents: vec3(0.011, 0.070, 0.075), // y in [1.15, 1.29] — leaves upper armpit open!
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    thicknessM: 0.022,
    densityKgM3: 1850,
    maxStopEnergyJ: 2650,
    backfaceBluntTransferRatio: 0.12,
    degradationPerKilojoule: 0.28,
  },
  {
    id: 'SIDE_SAPI_RIGHT',
    label: 'Right Cummerbund 6x6 Side SAPI Plate (Lower Flank)',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'UHMWPE_III_PLUS',
    shape: 'OBB',
    localCenter: vec3(0.184, 1.22, 0.0),
    halfExtents: vec3(0.011, 0.070, 0.075), // y in [1.15, 1.29] — leaves upper armpit open!
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    thicknessM: 0.022,
    densityKgM3: 1850,
    maxStopEnergyJ: 2650,
    backfaceBluntTransferRatio: 0.12,
    degradationPerKilojoule: 0.28,
  },
  {
    id: 'HELMET_BALLISTIC_SHELL',
    label: 'High-Cut Aramid Ballistic Helmet Shell',
    ghoulZone: 'HEAD_CRANIUM',
    material: 'ARAMID_HELMET_IIIA',
    shape: 'SPHERE',
    localCenter: vec3(0, 1.735, -0.005),
    halfExtents: vec3(0.108, 0.082, 0.114),
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    thicknessM: 0.009,
    densityKgM3: 1440,
    maxStopEnergyJ: 950,
    backfaceBluntTransferRatio: 0.18,
    degradationPerKilojoule: 0.45,
  },
];

// ============================================================================
// TIER-1 OUTER SHELL VOLUMES (Clothing + Skin/Muscle Envelope)
// ============================================================================
export const TIER1_OUTER_SHELL_VOLUMES: readonly Tier1OuterShellVolume[] = [
  {
    id: 'HEAD_SCALP_SHELL',
    label: 'Cranial & Facial Soft Tissue Shell',
    ghoulZone: 'HEAD_CRANIUM',
    material: 'SKIN_SUBCUTANEOUS',
    shape: 'SPHERE',
    localCenter: vec3(0, 1.685, 0.005),
    halfExtents: vec3(0.102, 0.115, 0.112),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'NECK_SHELL',
    label: 'Cervical Neck Soft Tissue Cylinder',
    ghoulZone: 'NECK_CERVICAL',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(0, 1.55, 0),
    halfExtents: vec3(0.072, 0.065, 0.072),
    capsuleStart: vec3(0, 1.49, 0),
    capsuleEnd: vec3(0, 1.61, 0),
    capsuleRadiusM: 0.072,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'SUPRACLAVICULAR_COLLAR_SHELL',
    label: 'Supraclavicular / Collarbone Soft Tissue Bridge',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'SKELETAL_MUSCLE',
    shape: 'AABB',
    localCenter: vec3(0, 1.485, 0.005),
    halfExtents: vec3(0.175, 0.042, 0.095),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'TACTICAL_CLOTHING_TORSO',
    label: 'Tactical Combat Shirt & Carrier Fabric',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'TACTICAL_CLOTHING',
    shape: 'AABB',
    localCenter: vec3(0, 1.28, 0),
    halfExtents: vec3(0.192, 0.245, 0.132),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.TACTICAL_CLOTHING,
  },
  {
    id: 'THORAX_SKIN_MUSCLE',
    label: 'Thoracic Pectoral, Intercostal & Latissimus Muscle Shell',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'SKELETAL_MUSCLE',
    shape: 'AABB',
    localCenter: vec3(0, 1.35, 0),
    halfExtents: vec3(0.185, 0.155, 0.124),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'AXILLARY_GAP_LEFT',
    label: 'Left Axillary / Armpit Soft Tissue Pocket',
    ghoulZone: 'SHOULDER_LEFT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(-0.175, 1.41, 0.005),
    halfExtents: vec3(0.065, 0.075, 0.075),
    capsuleStart: vec3(-0.13, 1.43, 0.005),
    capsuleEnd: vec3(-0.22, 1.38, 0.005),
    capsuleRadiusM: 0.068,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'AXILLARY_GAP_RIGHT',
    label: 'Right Axillary / Armpit Soft Tissue Pocket',
    ghoulZone: 'SHOULDER_RIGHT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(0.175, 1.41, 0.005),
    halfExtents: vec3(0.065, 0.075, 0.075),
    capsuleStart: vec3(0.13, 1.43, 0.005),
    capsuleEnd: vec3(0.22, 1.38, 0.005),
    capsuleRadiusM: 0.068,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'ABDOMEN_SKIN_MUSCLE',
    label: 'Abdominal Wall & Oblique Muscle Shell',
    ghoulZone: 'TORSO_LOWER_ABDOMEN',
    material: 'SKELETAL_MUSCLE',
    shape: 'AABB',
    localCenter: vec3(0, 1.11, 0.005),
    halfExtents: vec3(0.165, 0.115, 0.118),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'PELVIS_SKIN_MUSCLE',
    label: 'Pelvic & Gluteal Musculature Shell',
    ghoulZone: 'PELVIS_GROIN',
    material: 'SKELETAL_MUSCLE',
    shape: 'AABB',
    localCenter: vec3(0, 0.94, 0),
    halfExtents: vec3(0.168, 0.085, 0.112),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'UPPER_ARM_LEFT_SHELL',
    label: 'Left Deltoid, Bicep & Tricep Capsule',
    ghoulZone: 'UPPER_ARM_LEFT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(-0.26, 1.30, 0.01),
    halfExtents: vec3(0.08, 0.19, 0.08),
    capsuleStart: vec3(-0.22, 1.46, 0),
    capsuleEnd: vec3(-0.30, 1.14, 0.02),
    capsuleRadiusM: 0.062,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'UPPER_ARM_RIGHT_SHELL',
    label: 'Right Deltoid, Bicep & Tricep Capsule',
    ghoulZone: 'UPPER_ARM_RIGHT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(0.26, 1.30, 0.01),
    halfExtents: vec3(0.08, 0.19, 0.08),
    capsuleStart: vec3(0.22, 1.46, 0),
    capsuleEnd: vec3(0.30, 1.14, 0.02),
    capsuleRadiusM: 0.062,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'FOREARM_LEFT_SHELL',
    label: 'Left Forearm Muscle Capsule',
    ghoulZone: 'FOREARM_LEFT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(-0.225, 1.145, 0.125),
    halfExtents: vec3(0.13, 0.06, 0.16),
    capsuleStart: vec3(-0.30, 1.14, 0.02),
    capsuleEnd: vec3(-0.14, 1.15, 0.24),
    capsuleRadiusM: 0.050,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'FOREARM_RIGHT_SHELL',
    label: 'Right Forearm Muscle Capsule',
    ghoulZone: 'FOREARM_RIGHT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(0.225, 1.15, 0.11),
    halfExtents: vec3(0.13, 0.06, 0.15),
    capsuleStart: vec3(0.30, 1.14, 0.02),
    capsuleEnd: vec3(0.14, 1.16, 0.20),
    capsuleRadiusM: 0.050,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'THIGH_LEFT_SHELL',
    label: 'Left Quadriceps & Hamstring Capsule',
    ghoulZone: 'THIGH_LEFT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(-0.118, 0.69, 0),
    halfExtents: vec3(0.092, 0.26, 0.092),
    capsuleStart: vec3(-0.115, 0.89, 0),
    capsuleEnd: vec3(-0.120, 0.50, 0.005),
    capsuleRadiusM: 0.086,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'THIGH_RIGHT_SHELL',
    label: 'Right Quadriceps & Hamstring Capsule',
    ghoulZone: 'THIGH_RIGHT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(0.118, 0.69, 0),
    halfExtents: vec3(0.092, 0.26, 0.092),
    capsuleStart: vec3(0.115, 0.89, 0),
    capsuleEnd: vec3(0.120, 0.50, 0.005),
    capsuleRadiusM: 0.086,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'CALF_LEFT_SHELL',
    label: 'Left Shin, Gastrocnemius & Boot Capsule',
    ghoulZone: 'SHIN_LEFT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(-0.12, 0.26, 0.01),
    halfExtents: vec3(0.068, 0.26, 0.085),
    capsuleStart: vec3(-0.12, 0.50, 0.005),
    capsuleEnd: vec3(-0.12, 0.04, 0.02),
    capsuleRadiusM: 0.062,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
  {
    id: 'CALF_RIGHT_SHELL',
    label: 'Right Shin, Gastrocnemius & Boot Capsule',
    ghoulZone: 'SHIN_RIGHT',
    material: 'SKELETAL_MUSCLE',
    shape: 'CAPSULE',
    localCenter: vec3(0.12, 0.26, 0.01),
    halfExtents: vec3(0.068, 0.26, 0.085),
    capsuleStart: vec3(0.12, 0.50, 0.005),
    capsuleEnd: vec3(0.12, 0.04, 0.02),
    capsuleRadiusM: 0.062,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.SKELETAL_MUSCLE,
  },
];

// ============================================================================
// TIER-2 INTERNAL ORGANS (Inelastic Brain/Liver vs Elastic Lungs)
// ============================================================================
export const TIER2_INTERNAL_ORGANS: readonly InternalOrganVolume[] = [
  {
    id: 'BRAIN',
    label: 'Cerebrum, Cerebellum & Brainstem',
    ghoulZone: 'HEAD_CRANIUM',
    shape: 'SPHERE',
    localCenter: vec3(0, 1.695, -0.005),
    halfExtents: vec3(0.072, 0.070, 0.082),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.BRAIN_LIVER_PAREN,
    isInelastic: true,
    parenchymaRuptureThresholdJ: 16,
    baseLacerationBleedMlPerSec: 30,
    ruptureBleedMlPerSec: 52,
    bleedVesselKind: 'ARTERIAL',
  },
  {
    id: 'HEART',
    label: 'Heart (Myocardium & Ventricles)',
    ghoulZone: 'TORSO_UPPER_THORAX',
    shape: 'SPHERE',
    localCenter: vec3(-0.018, 1.33, 0.015),
    halfExtents: vec3(0.048, 0.052, 0.048),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.HEART_DIAPHRAGM,
    isInelastic: false,
    parenchymaRuptureThresholdJ: 80,
    baseLacerationBleedMlPerSec: 82,
    ruptureBleedMlPerSec: 110,
    bleedVesselKind: 'ARTERIAL',
  },
  {
    id: 'LUNG_LEFT',
    label: 'Left Pulmonary Lobes & Pleural Cupola',
    ghoulZone: 'TORSO_UPPER_THORAX',
    shape: 'AABB',
    localCenter: vec3(-0.096, 1.36, 0.005),
    halfExtents: vec3(0.072, 0.138, 0.082), // x in [-0.168, -0.024], y in [1.222, 1.498]
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.LUNG_PARENCHYMA,
    isInelastic: false,
    parenchymaRuptureThresholdJ: 95,
    baseLacerationBleedMlPerSec: 6,
    ruptureBleedMlPerSec: 11,
    bleedVesselKind: 'VENOUS',
  },
  {
    id: 'LUNG_RIGHT',
    label: 'Right Pulmonary Lobes & Pleural Cupola',
    ghoulZone: 'TORSO_UPPER_THORAX',
    shape: 'AABB',
    localCenter: vec3(0.096, 1.36, 0.005),
    halfExtents: vec3(0.072, 0.138, 0.082), // x in [0.024, 0.168], y in [1.222, 1.498]
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.LUNG_PARENCHYMA,
    isInelastic: false,
    parenchymaRuptureThresholdJ: 95,
    baseLacerationBleedMlPerSec: 6,
    ruptureBleedMlPerSec: 11,
    bleedVesselKind: 'VENOUS',
  },
  {
    id: 'DIAPHRAGM',
    label: 'Thoracic Diaphragm Dome',
    ghoulZone: 'TORSO_LOWER_ABDOMEN',
    shape: 'AABB',
    localCenter: vec3(0, 1.215, 0.005),
    halfExtents: vec3(0.145, 0.024, 0.092),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.HEART_DIAPHRAGM,
    isInelastic: false,
    parenchymaRuptureThresholdJ: 65,
    baseLacerationBleedMlPerSec: 4,
    ruptureBleedMlPerSec: 7,
    bleedVesselKind: 'VENOUS',
  },
  {
    id: 'LIVER',
    label: 'Liver (Friable Inelastic Parenchyma)',
    ghoulZone: 'TORSO_LOWER_ABDOMEN',
    shape: 'SPHERE',
    localCenter: vec3(0.065, 1.155, 0.015),
    halfExtents: vec3(0.080, 0.062, 0.074),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.BRAIN_LIVER_PAREN,
    isInelastic: true,
    parenchymaRuptureThresholdJ: 22,
    baseLacerationBleedMlPerSec: 28,
    ruptureBleedMlPerSec: 58,
    bleedVesselKind: 'VENOUS',
  },
  {
    id: 'GI_TRACT',
    label: 'Stomach, Mesentery & Intestinal Tract',
    ghoulZone: 'TORSO_LOWER_ABDOMEN',
    shape: 'AABB',
    localCenter: vec3(-0.015, 1.065, 0.02),
    halfExtents: vec3(0.115, 0.085, 0.075),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.FAT_GI_VISCERA,
    isInelastic: false,
    parenchymaRuptureThresholdJ: 85,
    baseLacerationBleedMlPerSec: 8,
    ruptureBleedMlPerSec: 15,
    bleedVesselKind: 'VENOUS',
  },
];

// ============================================================================
// TIER-2 CORTICAL SKELETAL VOLUMES
// ============================================================================
export const TIER2_SKELETAL_BONES: readonly SkeletalBoneVolume[] = [
  {
    id: 'SKULL',
    label: 'Cranial Vault (Cortical Calvarium)',
    ghoulZone: 'HEAD_CRANIUM',
    shape: 'SPHERE',
    localCenter: vec3(0, 1.695, -0.005),
    halfExtents: vec3(0.086, 0.084, 0.096),
    hollowInnerHalfExtents: vec3(0.073, 0.071, 0.083),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 95,
    shatterThresholdJ: 340,
    isLoadBearingLocomotion: false,
  },
  {
    id: 'SPINE_CERVICAL',
    label: 'Cervical Vertebrae (C1–C7)',
    ghoulZone: 'NECK_CERVICAL',
    shape: 'CAPSULE',
    localCenter: vec3(0, 1.55, -0.025),
    halfExtents: vec3(0.026, 0.065, 0.026),
    capsuleStart: vec3(0, 1.49, -0.025),
    capsuleEnd: vec3(0, 1.61, -0.025),
    capsuleRadiusM: 0.025,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 85,
    shatterThresholdJ: 260,
    isLoadBearingLocomotion: true,
    spinalSegment: 'CERVICAL',
  },
  {
    id: 'SPINE_THORACIC',
    label: 'Thoracic Vertebrae (T1–T12)',
    ghoulZone: 'TORSO_UPPER_THORAX',
    shape: 'CAPSULE',
    localCenter: vec3(0, 1.345, -0.042),
    halfExtents: vec3(0.03, 0.14, 0.03),
    capsuleStart: vec3(0, 1.21, -0.045),
    capsuleEnd: vec3(0, 1.48, -0.035),
    capsuleRadiusM: 0.028,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 115,
    shatterThresholdJ: 360,
    isLoadBearingLocomotion: true,
    spinalSegment: 'THORACIC',
  },
  {
    id: 'SPINE_LUMBAR',
    label: 'Lumbar Vertebrae (L1–L5)',
    ghoulZone: 'TORSO_LOWER_ABDOMEN',
    shape: 'CAPSULE',
    localCenter: vec3(0, 1.105, -0.045),
    halfExtents: vec3(0.034, 0.10, 0.034),
    capsuleStart: vec3(0, 1.01, -0.045),
    capsuleEnd: vec3(0, 1.20, -0.045),
    capsuleRadiusM: 0.032,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 130,
    shatterThresholdJ: 400,
    isLoadBearingLocomotion: true,
    spinalSegment: 'LUMBAR',
  },
  {
    id: 'RIB_CAGE',
    label: 'Thoracic Rib Cage & Sternum Shell',
    ghoulZone: 'TORSO_UPPER_THORAX',
    shape: 'AABB',
    localCenter: vec3(0, 1.34, 0.005),
    halfExtents: vec3(0.168, 0.120, 0.102), // top y = 1.460 so supraclavicular y=1.49 clears top rib!
    hollowInnerHalfExtents: vec3(0.153, 0.108, 0.087),
    densityKgM3: 1750,
    fractureThresholdJ: 80,
    shatterThresholdJ: 290,
    isLoadBearingLocomotion: false,
  },
  {
    id: 'PELVIS',
    label: 'Pelvic Girdle (Ilium, Ischium & Sacrum)',
    ghoulZone: 'PELVIS_GROIN',
    shape: 'AABB',
    localCenter: vec3(0, 0.94, 0),
    halfExtents: vec3(0.138, 0.066, 0.085),
    hollowInnerHalfExtents: vec3(0.074, 0.055, 0.050),
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 155,
    shatterThresholdJ: 460,
    isLoadBearingLocomotion: true,
  },
  {
    id: 'FEMUR_LEFT',
    label: 'Left Cortical Femur Shaft & Neck',
    ghoulZone: 'THIGH_LEFT',
    shape: 'CAPSULE',
    localCenter: vec3(-0.119, 0.695, 0.002),
    halfExtents: vec3(0.032, 0.195, 0.032),
    capsuleStart: vec3(-0.118, 0.88, 0),
    capsuleEnd: vec3(-0.120, 0.51, 0.005),
    capsuleRadiusM: 0.027,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 130,
    shatterThresholdJ: 410,
    isLoadBearingLocomotion: true,
  },
  {
    id: 'FEMUR_RIGHT',
    label: 'Right Cortical Femur Shaft & Neck',
    ghoulZone: 'THIGH_RIGHT',
    shape: 'CAPSULE',
    localCenter: vec3(0.119, 0.695, 0.002),
    halfExtents: vec3(0.032, 0.195, 0.032),
    capsuleStart: vec3(0.118, 0.88, 0),
    capsuleEnd: vec3(0.120, 0.51, 0.005),
    capsuleRadiusM: 0.027,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 130,
    shatterThresholdJ: 410,
    isLoadBearingLocomotion: true,
  },
  {
    id: 'HUMERUS_LEFT',
    label: 'Left Humerus Shaft',
    ghoulZone: 'UPPER_ARM_LEFT',
    shape: 'CAPSULE',
    localCenter: vec3(-0.26, 1.30, 0.01),
    halfExtents: vec3(0.055, 0.165, 0.035),
    capsuleStart: vec3(-0.22, 1.46, 0),
    capsuleEnd: vec3(-0.30, 1.14, 0.02),
    capsuleRadiusM: 0.021,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 90,
    shatterThresholdJ: 300,
    isLoadBearingLocomotion: false,
  },
  {
    id: 'HUMERUS_RIGHT',
    label: 'Right Humerus Shaft',
    ghoulZone: 'UPPER_ARM_RIGHT',
    shape: 'CAPSULE',
    localCenter: vec3(0.26, 1.30, 0.01),
    halfExtents: vec3(0.055, 0.165, 0.035),
    capsuleStart: vec3(0.22, 1.46, 0),
    capsuleEnd: vec3(0.30, 1.14, 0.02),
    capsuleRadiusM: 0.021,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 90,
    shatterThresholdJ: 300,
    isLoadBearingLocomotion: false,
  },
  {
    id: 'RADIUS_ULNA_LEFT',
    label: 'Left Radius & Ulna Forearm Bones',
    ghoulZone: 'FOREARM_LEFT',
    shape: 'CAPSULE',
    localCenter: vec3(-0.22, 1.145, 0.13),
    halfExtents: vec3(0.095, 0.03, 0.125),
    capsuleStart: vec3(-0.30, 1.14, 0.02),
    capsuleEnd: vec3(-0.14, 1.15, 0.24),
    capsuleRadiusM: 0.019,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 70,
    shatterThresholdJ: 240,
    isLoadBearingLocomotion: false,
  },
  {
    id: 'RADIUS_ULNA_RIGHT',
    label: 'Right Radius & Ulna Forearm Bones',
    ghoulZone: 'FOREARM_RIGHT',
    shape: 'CAPSULE',
    localCenter: vec3(0.22, 1.15, 0.11),
    halfExtents: vec3(0.095, 0.03, 0.11),
    capsuleStart: vec3(0.30, 1.14, 0.02),
    capsuleEnd: vec3(0.14, 1.16, 0.20),
    capsuleRadiusM: 0.019,
    densityKgM3: PHYSIOLOGY_CONSTANTS.TISSUE_DENSITY_KG_M3.CORTICAL_BONE,
    fractureThresholdJ: 70,
    shatterThresholdJ: 240,
    isLoadBearingLocomotion: false,
  },
];

// ============================================================================
// TIER-2 NEURAL PLEXUSES (Brachial Plexus C5–T1 Roots to Axillary Cord)
// ============================================================================
export const TIER2_NEURAL_PLEXUSES: readonly NeuralPlexusVolume[] = [
  {
    id: 'BRACHIAL_PLEXUS_LEFT',
    label: 'Left Brachial Plexus Trunk (C5–T1)',
    ghoulZone: 'SHOULDER_LEFT',
    side: 'LEFT',
    capsuleStart: vec3(-0.045, 1.505, -0.005),
    capsuleEnd: vec3(-0.205, 1.415, 0.005),
    capsuleRadiusM: 0.020,
  },
  {
    id: 'BRACHIAL_PLEXUS_RIGHT',
    label: 'Right Brachial Plexus Trunk (C5–T1)',
    ghoulZone: 'SHOULDER_RIGHT',
    side: 'RIGHT',
    capsuleStart: vec3(0.045, 1.505, -0.005),
    capsuleEnd: vec3(0.205, 1.415, 0.005),
    capsuleRadiusM: 0.020,
  },
];

// ============================================================================
// TIER-2 MAJOR VASCULAR 3D CATMULL-ROM SPLINES (Arterial & Venous Trunks)
// ============================================================================
export const TIER2_VASCULAR_SPLINES: readonly VascularSpline[] = [
  {
    id: 'AORTA_THORACIC_ABDOMINAL',
    label: 'Ascending Arch, Descending Thoracic & Abdominal Aorta',
    ghoulZone: 'TORSO_UPPER_THORAX',
    vesselKind: 'ARTERIAL',
    controlPoints: [
      vec3(-0.015, 1.34, 0.012),
      vec3(0.0, 1.43, 0.005),
      vec3(-0.012, 1.38, -0.018),
      vec3(0.0, 1.24, -0.020),
      vec3(0.0, 1.09, -0.016),
      vec3(0.0, 0.97, -0.010),
    ],
    lumenRadiusM: 0.014,
    mlPerSec: 105,
  },
  {
    id: 'CAROTID_LEFT',
    label: 'Left Common & Internal Carotid Artery',
    ghoulZone: 'NECK_CERVICAL',
    vesselKind: 'ARTERIAL',
    controlPoints: [
      vec3(-0.016, 1.43, 0.005),
      vec3(-0.028, 1.49, 0.012),
      vec3(-0.032, 1.55, 0.014),
      vec3(-0.030, 1.63, 0.010),
    ],
    lumenRadiusM: 0.0055,
    mlPerSec: 65,
  },
  {
    id: 'CAROTID_RIGHT',
    label: 'Right Common & Internal Carotid Artery',
    ghoulZone: 'NECK_CERVICAL',
    vesselKind: 'ARTERIAL',
    controlPoints: [
      vec3(0.016, 1.43, 0.005),
      vec3(0.028, 1.49, 0.012),
      vec3(0.032, 1.55, 0.014),
      vec3(0.030, 1.63, 0.010),
    ],
    lumenRadiusM: 0.0055,
    mlPerSec: 65,
  },
  {
    id: 'SUBCLAVIAN_LEFT',
    label: 'Left Subclavian & Axillary Artery',
    ghoulZone: 'SHOULDER_LEFT',
    vesselKind: 'ARTERIAL',
    controlPoints: [
      vec3(-0.018, 1.43, 0.005),
      vec3(-0.065, 1.49, 0.010),
      vec3(-0.115, 1.48, 0.010),
      vec3(-0.160, 1.41, 0.010),
      vec3(-0.210, 1.37, 0.005),
    ],
    lumenRadiusM: 0.0065,
    mlPerSec: 54,
  },
  {
    id: 'SUBCLAVIAN_RIGHT',
    label: 'Right Subclavian & Axillary Artery',
    ghoulZone: 'SHOULDER_RIGHT',
    vesselKind: 'ARTERIAL',
    controlPoints: [
      vec3(0.018, 1.43, 0.005),
      vec3(0.065, 1.49, 0.010),
      vec3(0.115, 1.48, 0.010),
      vec3(0.160, 1.41, 0.010),
      vec3(0.210, 1.37, 0.005),
    ],
    lumenRadiusM: 0.0065,
    mlPerSec: 54,
  },
  {
    id: 'FEMORAL_LEFT',
    label: 'Left Iliac-Femoral Arterial Trunk',
    ghoulZone: 'THIGH_LEFT',
    vesselKind: 'ARTERIAL',
    controlPoints: [
      vec3(0.0, 0.97, -0.010),
      vec3(-0.078, 0.90, 0.008),
      vec3(-0.106, 0.78, 0.014),
      vec3(-0.114, 0.64, 0.010),
      vec3(-0.118, 0.51, -0.004),
    ],
    lumenRadiusM: 0.0065,
    mlPerSec: 52,
  },
  {
    id: 'FEMORAL_RIGHT',
    label: 'Right Iliac-Femoral Arterial Trunk',
    ghoulZone: 'THIGH_RIGHT',
    vesselKind: 'ARTERIAL',
    controlPoints: [
      vec3(0.0, 0.97, -0.010),
      vec3(0.078, 0.90, 0.008),
      vec3(0.106, 0.78, 0.014),
      vec3(0.114, 0.64, 0.010),
      vec3(0.118, 0.51, -0.004),
    ],
    lumenRadiusM: 0.0065,
    mlPerSec: 52,
  },
  {
    id: 'VENA_CAVA_JUGULAR_FEMORAL',
    label: 'Superior/Inferior Vena Cava — Right Jugular & Iliac Venous Trunk',
    ghoulZone: 'TORSO_UPPER_THORAX',
    vesselKind: 'VENOUS',
    controlPoints: [
      vec3(0.038, 1.60, 0.012),
      vec3(0.032, 1.46, 0.012),
      vec3(0.026, 1.34, 0.008),
      vec3(0.022, 1.18, -0.004),
      vec3(0.018, 0.98, -0.008),
      vec3(0.092, 0.80, 0.008),
    ],
    lumenRadiusM: 0.012,
    mlPerSec: 16,
  },
  {
    id: 'JUGULAR_VENOUS_LEFT',
    label: 'Left Internal Jugular Vein',
    ghoulZone: 'NECK_CERVICAL',
    vesselKind: 'VENOUS',
    controlPoints: [
      vec3(-0.038, 1.61, 0.012),
      vec3(-0.036, 1.53, 0.014),
      vec3(-0.026, 1.45, 0.010),
    ],
    lumenRadiusM: 0.007,
    mlPerSec: 12,
  },
  {
    id: 'JUGULAR_VENOUS_RIGHT',
    label: 'Right Internal Jugular Vein',
    ghoulZone: 'NECK_CERVICAL',
    vesselKind: 'VENOUS',
    controlPoints: [
      vec3(0.038, 1.61, 0.012),
      vec3(0.036, 1.53, 0.014),
      vec3(0.026, 1.45, 0.010),
    ],
    lumenRadiusM: 0.007,
    mlPerSec: 12,
  },
  {
    id: 'FEMORAL_VENOUS_LEFT',
    label: 'Left Femoral & Great Saphenous Vein',
    ghoulZone: 'THIGH_LEFT',
    vesselKind: 'VENOUS',
    controlPoints: [
      vec3(-0.070, 0.90, 0.004),
      vec3(-0.098, 0.76, 0.010),
      vec3(-0.106, 0.56, 0.004),
    ],
    lumenRadiusM: 0.007,
    mlPerSec: 11,
  },
  {
    id: 'FEMORAL_VENOUS_RIGHT',
    label: 'Right Femoral & Great Saphenous Vein',
    ghoulZone: 'THIGH_RIGHT',
    vesselKind: 'VENOUS',
    controlPoints: [
      vec3(0.070, 0.90, 0.004),
      vec3(0.098, 0.76, 0.010),
      vec3(0.106, 0.56, 0.004),
    ],
    lumenRadiusM: 0.007,
    mlPerSec: 11,
  },
];

// ============================================================================
// COORDINATE FRAME TRANSFORMS (World <-> Character Local / Posed Bone Space)
// ============================================================================

export function worldPointToCharacterLocal(
  pointWorld: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM
): Vec3Like {
  const dx = pointWorld.x - transform.positionWorld.x;
  const dy = pointWorld.y - transform.positionWorld.y;
  const dz = pointWorld.z - transform.positionWorld.z;
  const cosY = Math.cos(transform.yawRad);
  const sinY = Math.sin(transform.yawRad);
  return {
    x: dx * cosY - dz * sinY,
    y: dy,
    z: dx * sinY + dz * cosY,
  };
}

export function worldDirectionToCharacterLocal(
  dirWorld: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM
): Vec3Like {
  const n = normalize(dirWorld);
  const cosY = Math.cos(transform.yawRad);
  const sinY = Math.sin(transform.yawRad);
  return normalize({
    x: n.x * cosY - n.z * sinY,
    y: n.y,
    z: n.x * sinY + n.z * cosY,
  });
}

export function characterLocalPointToWorld(
  pointLocal: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM,
  ghoulZone?: GhoulZoneId
): Vec3Like {
  if (ghoulZone && transform.bonePoseOverrides) {
    const pose: BonePoseFrame | undefined = transform.bonePoseOverrides[ghoulZone];
    const pivot = STANDING_ZONE_PIVOTS[ghoulZone];
    if (pose && pivot) {
      const offset = sub(pointLocal, pivot);
      return add(
        pose.positionWorld,
        add(
          scale(pose.basisRight, offset.x),
          add(scale(pose.basisUp, offset.y), scale(pose.basisForward, offset.z))
        )
      );
    }
  }
  const cosY = Math.cos(transform.yawRad);
  const sinY = Math.sin(transform.yawRad);
  return {
    x: transform.positionWorld.x + (pointLocal.x * cosY + pointLocal.z * sinY),
    y: transform.positionWorld.y + pointLocal.y,
    z: transform.positionWorld.z + (-pointLocal.x * sinY + pointLocal.z * cosY),
  };
}

export function characterLocalDirectionToWorld(
  dirLocal: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM
): Vec3Like {
  const n = normalize(dirLocal);
  const cosY = Math.cos(transform.yawRad);
  const sinY = Math.sin(transform.yawRad);
  return normalize({
    x: n.x * cosY + n.z * sinY,
    y: n.y,
    z: -n.x * sinY + n.z * cosY,
  });
}

export function transformWorldRayToCharacterLocal(
  originWorld: Vec3Like,
  dirWorld: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM
): { originLocal: Vec3Like; directionLocal: Vec3Like } {
  return {
    originLocal: worldPointToCharacterLocal(originWorld, transform),
    directionLocal: worldDirectionToCharacterLocal(dirWorld, transform),
  };
}

// ============================================================================
// EXACT 3D GEOMETRIC DISTANCE & INTERSECTION PRIMITIVES
// ============================================================================

export function evaluateCatmullRomSpline(
  controlPoints: readonly Vec3Like[],
  tNorm: number
): Vec3Like {
  const n = controlPoints.length;
  if (n === 0) return vec3(0, 0, 0);
  if (n === 1) return copyVec3(controlPoints[0]);

  const clamped = Math.max(0, Math.min(1, tNorm));
  const scaled = clamped * (n - 1);
  const segIdx = Math.min(n - 2, Math.floor(scaled));
  const u = scaled - segIdx;

  const p0 = controlPoints[Math.max(0, segIdx - 1)];
  const p1 = controlPoints[segIdx];
  const p2 = controlPoints[segIdx + 1];
  const p3 = controlPoints[Math.min(n - 1, segIdx + 2)];

  const u2 = u * u;
  const u3 = u2 * u;

  // Standard Catmull-Rom tension = 0.5
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * u +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * u +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3),
    z:
      0.5 *
      (2 * p1.z +
        (-p0.z + p2.z) * u +
        (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * u2 +
        (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * u3),
  };
}

/**
 * Exact closest-point distance between two 3D line segments [a0, a1] and [b0, b1].
 */
export function closestDistanceBetweenSegments3D(
  a0: Vec3Like,
  a1: Vec3Like,
  b0: Vec3Like,
  b1: Vec3Like
): { distanceM: number; pointOnA: Vec3Like; pointOnB: Vec3Like; s: number; t: number } {
  const d1 = sub(a1, a0);
  const d2 = sub(b1, b0);
  const r = sub(a0, b0);
  const a = lengthSq(d1);
  const e = lengthSq(d2);
  const f = dot(d2, r);
  const eps = 1e-10;

  let s = 0;
  let t = 0;

  if (a <= eps && e <= eps) {
    return {
      distanceM: length(r),
      pointOnA: copyVec3(a0),
      pointOnB: copyVec3(b0),
      s: 0,
      t: 0,
    };
  }

  if (a <= eps) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= eps) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      if (denom !== 0) {
        s = Math.max(0, Math.min(1, (b * f - c * e) / denom));
      } else {
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }

  const pointOnA = add(a0, scale(d1, s));
  const pointOnB = add(b0, scale(d2, t));
  return {
    distanceM: length(sub(pointOnA, pointOnB)),
    pointOnA,
    pointOnB,
    s,
    t,
  };
}

export function pointToSegmentDistance3D(
  p: Vec3Like,
  a: Vec3Like,
  b: Vec3Like
): { distanceM: number; closestPoint: Vec3Like; t: number } {
  const ab = sub(b, a);
  const lenSq = lengthSq(ab);
  if (lenSq <= 1e-10) {
    return { distanceM: length(sub(p, a)), closestPoint: copyVec3(a), t: 0 };
  }
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / lenSq));
  const closestPoint = add(a, scale(ab, t));
  return { distanceM: length(sub(p, closestPoint)), closestPoint, t };
}

export function intersectRayAabb(
  origin: Vec3Like,
  dir: Vec3Like,
  aabb: AxisAlignedBox
): RayIntervalHit {
  let tMin = -Infinity;
  let tMax = Infinity;

  const axes: readonly ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  for (const axis of axes) {
    const o = origin[axis];
    const d = dir[axis];
    const bMin = aabb.min[axis];
    const bMax = aabb.max[axis];

    if (Math.abs(d) < 1e-9) {
      if (o < bMin || o > bMax) {
        return { hit: false, tMin: 0, tMax: 0 };
      }
    } else {
      const invD = 1 / d;
      let t1 = (bMin - o) * invD;
      let t2 = (bMax - o) * invD;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) {
        return { hit: false, tMin: 0, tMax: 0 };
      }
    }
  }

  if (tMax < 0) {
    return { hit: false, tMin: 0, tMax: 0 };
  }
  return { hit: true, tMin: Math.max(0, tMin), tMax };
}

function pointToAabbSignedDistance(p: Vec3Like, center: Vec3Like, half: Vec3Like): number {
  const qx = Math.abs(p.x - center.x) - half.x;
  const qy = Math.abs(p.y - center.y) - half.y;
  const qz = Math.abs(p.z - center.z) - half.z;
  const outX = Math.max(qx, 0);
  const outY = Math.max(qy, 0);
  const outZ = Math.max(qz, 0);
  const outsideDist = Math.sqrt(outX * outX + outY * outY + outZ * outZ);
  const insideDist = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outsideDist + insideDist;
}

function pointToEllipsoidSignedDistanceApprox(
  p: Vec3Like,
  center: Vec3Like,
  radii: Vec3Like
): number {
  const dx = (p.x - center.x) / radii.x;
  const dy = (p.y - center.y) / radii.y;
  const dz = (p.z - center.z) / radii.z;
  const rNorm = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (rNorm < 1e-8) {
    return -Math.min(radii.x, radii.y, radii.z);
  }
  const avgScale =
    1 /
    Math.sqrt(
      (dx * dx) / (radii.x * radii.x * rNorm * rNorm) +
        (dy * dy) / (radii.y * radii.y * rNorm * rNorm) +
        (dz * dz) / (radii.z * radii.z * rNorm * rNorm)
    );
  return (rNorm - 1) * avgScale;
}

function pointToObbSignedDistance(
  p: Vec3Like,
  center: Vec3Like,
  half: Vec3Like,
  basisRight: Vec3Like,
  basisUp: Vec3Like,
  basisForward: Vec3Like
): { signedDistanceM: number; localCoords: Vec3Like } {
  const rel = sub(p, center);
  const localCoords = {
    x: dot(rel, basisRight),
    y: dot(rel, basisUp),
    z: dot(rel, basisForward),
  };
  const signedDistanceM = pointToAabbSignedDistance(localCoords, vec3(0, 0, 0), half);
  return { signedDistanceM, localCoords };
}

function signedDistanceToShape(
  p: Vec3Like,
  shape: 'AABB' | 'OBB' | 'CAPSULE' | 'SPHERE',
  center: Vec3Like,
  halfExtents: Vec3Like,
  capsuleStart?: Vec3Like,
  capsuleEnd?: Vec3Like,
  capsuleRadiusM?: number,
  basisRight?: Vec3Like,
  basisUp?: Vec3Like,
  basisForward?: Vec3Like
): number {
  if (shape === 'CAPSULE' && capsuleStart && capsuleEnd && capsuleRadiusM !== undefined) {
    return pointToSegmentDistance3D(p, capsuleStart, capsuleEnd).distanceM - capsuleRadiusM;
  }
  if (shape === 'SPHERE') {
    return pointToEllipsoidSignedDistanceApprox(p, center, halfExtents);
  }
  if (shape === 'OBB' && basisRight && basisUp && basisForward) {
    return pointToObbSignedDistance(p, center, halfExtents, basisRight, basisUp, basisForward)
      .signedDistanceM;
  }
  return pointToAabbSignedDistance(p, center, halfExtents);
}

function segmentMinSignedDistanceToShape(
  segA: Vec3Like,
  segB: Vec3Like,
  shape: 'AABB' | 'OBB' | 'CAPSULE' | 'SPHERE',
  center: Vec3Like,
  halfExtents: Vec3Like,
  capsuleStart?: Vec3Like,
  capsuleEnd?: Vec3Like,
  capsuleRadiusM?: number,
  basisRight?: Vec3Like,
  basisUp?: Vec3Like,
  basisForward?: Vec3Like
): number {
  if (shape === 'CAPSULE' && capsuleStart && capsuleEnd && capsuleRadiusM !== undefined) {
    return (
      closestDistanceBetweenSegments3D(segA, segB, capsuleStart, capsuleEnd).distanceM -
      capsuleRadiusM
    );
  }
  // Sample 5 points along the ~1.2 cm sub-step segment (every ~3 mm) for exact convex primitive clearance
  let minD = Infinity;
  for (let i = 0; i <= 4; i++) {
    const pt = lerp(segA, segB, i * 0.25);
    const d = signedDistanceToShape(
      pt,
      shape,
      center,
      halfExtents,
      capsuleStart,
      capsuleEnd,
      capsuleRadiusM,
      basisRight,
      basisUp,
      basisForward
    );
    if (d < minD) minD = d;
  }
  return minD;
}

function computePrimitiveAabb(
  shape: 'AABB' | 'OBB' | 'CAPSULE' | 'SPHERE',
  center: Vec3Like,
  halfExtents: Vec3Like,
  capsuleStart?: Vec3Like,
  capsuleEnd?: Vec3Like,
  capsuleRadiusM?: number
): AxisAlignedBox {
  if (shape === 'CAPSULE' && capsuleStart && capsuleEnd && capsuleRadiusM !== undefined) {
    return {
      min: {
        x: Math.min(capsuleStart.x, capsuleEnd.x) - capsuleRadiusM,
        y: Math.min(capsuleStart.y, capsuleEnd.y) - capsuleRadiusM,
        z: Math.min(capsuleStart.z, capsuleEnd.z) - capsuleRadiusM,
      },
      max: {
        x: Math.max(capsuleStart.x, capsuleEnd.x) + capsuleRadiusM,
        y: Math.max(capsuleStart.y, capsuleEnd.y) + capsuleRadiusM,
        z: Math.max(capsuleStart.z, capsuleEnd.z) + capsuleRadiusM,
      },
    };
  }
  const pad = shape === 'OBB' ? length(halfExtents) : 0;
  if (shape === 'OBB') {
    return {
      min: { x: center.x - pad, y: center.y - pad, z: center.z - pad },
      max: { x: center.x + pad, y: center.y + pad, z: center.z + pad },
    };
  }
  return {
    min: sub(center, halfExtents),
    max: add(center, halfExtents),
  };
}

function mergeAabbs(boxes: readonly AxisAlignedBox[]): AxisAlignedBox {
  if (boxes.length === 0) {
    return { min: vec3(0, 0, 0), max: vec3(0, 0, 0) };
  }
  const min = copyVec3(boxes[0].min);
  const max = copyVec3(boxes[0].max);
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.min.x < min.x) min.x = b.min.x;
    if (b.min.y < min.y) min.y = b.min.y;
    if (b.min.z < min.z) min.z = b.min.z;
    if (b.max.x > max.x) max.x = b.max.x;
    if (b.max.y > max.y) max.y = b.max.y;
    if (b.max.z > max.z) max.z = b.max.z;
  }
  return { min, max };
}

function aabbIntersectsSphere(aabb: AxisAlignedBox, center: Vec3Like, radius: number): boolean {
  const dx = Math.max(aabb.min.x - center.x, 0, center.x - aabb.max.x);
  const dy = Math.max(aabb.min.y - center.y, 0, center.y - aabb.max.y);
  const dz = Math.max(aabb.min.z - center.z, 0, center.z - aabb.max.z);
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

function bakeVascularSpline(spline: VascularSpline, samplesPerSegment = 10): BakedVascularSpline {
  const totalSamples = Math.max(8, (spline.controlPoints.length - 1) * samplesPerSegment);
  const segments: BakedSplineSegment[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  let prevPt = evaluateCatmullRomSpline(spline.controlPoints, 0);
  for (let i = 1; i <= totalSamples; i++) {
    const t0 = (i - 1) / totalSamples;
    const t1 = i / totalSamples;
    const nextPt = evaluateCatmullRomSpline(spline.controlPoints, t1);
    const tangent = normalize(sub(nextPt, prevPt));
    segments.push({ p0: prevPt, p1: nextPt, t0, t1, tangent });

    for (const pt of [prevPt, nextPt]) {
      if (pt.x - spline.lumenRadiusM < minX) minX = pt.x - spline.lumenRadiusM;
      if (pt.y - spline.lumenRadiusM < minY) minY = pt.y - spline.lumenRadiusM;
      if (pt.z - spline.lumenRadiusM < minZ) minZ = pt.z - spline.lumenRadiusM;
      if (pt.x + spline.lumenRadiusM > maxX) maxX = pt.x + spline.lumenRadiusM;
      if (pt.y + spline.lumenRadiusM > maxY) maxY = pt.y + spline.lumenRadiusM;
      if (pt.z + spline.lumenRadiusM > maxZ) maxZ = pt.z + spline.lumenRadiusM;
    }
    prevPt = nextPt;
  }

  return {
    spline,
    aabb: { min: vec3(minX, minY, minZ), max: vec3(maxX, maxY, maxZ) },
    segments,
  };
}

// ============================================================================
// TWO-TIER ANATOMICAL BVH ACCELERATOR
// ============================================================================

export class AnatomicalBvh {
  public readonly rootAabb: AxisAlignedBox;
  public readonly outerShellTree: readonly BvhGroupNode<Tier1OuterShellVolume>[];
  public readonly armorPlates: readonly {
    readonly aabb: AxisAlignedBox;
    readonly plate: Tier1ArmorPlateVolume;
  }[];
  public readonly organs: readonly {
    readonly aabb: AxisAlignedBox;
    readonly organ: InternalOrganVolume;
  }[];
  public readonly bones: readonly {
    readonly aabb: AxisAlignedBox;
    readonly bone: SkeletalBoneVolume;
  }[];
  public readonly nerves: readonly {
    readonly aabb: AxisAlignedBox;
    readonly nerve: NeuralPlexusVolume;
  }[];
  public readonly vascularSplines: readonly BakedVascularSpline[];

  constructor() {
    const shellEntries = TIER1_OUTER_SHELL_VOLUMES.map((item) => ({
      item,
      aabb: computePrimitiveAabb(
        item.shape,
        item.localCenter,
        item.halfExtents,
        item.capsuleStart,
        item.capsuleEnd,
        item.capsuleRadiusM
      ),
    }));

    // Partition Tier-1 outer shell into 4 anatomical BVH child clusters (Upper Axial, Lower Axial, Left Arm, Right Arm)
    const upperAxial = shellEntries.filter((e) =>
      [
        'HEAD_SCALP_SHELL',
        'NECK_SHELL',
        'SUPRACLAVICULAR_COLLAR_SHELL',
        'TACTICAL_CLOTHING_TORSO',
        'THORAX_SKIN_MUSCLE',
      ].includes(e.item.id)
    );
    const lowerAxial = shellEntries.filter((e) =>
      [
        'ABDOMEN_SKIN_MUSCLE',
        'PELVIS_SKIN_MUSCLE',
        'THIGH_LEFT_SHELL',
        'THIGH_RIGHT_SHELL',
        'CALF_LEFT_SHELL',
        'CALF_RIGHT_SHELL',
      ].includes(e.item.id)
    );
    const leftArm = shellEntries.filter((e) =>
      ['AXILLARY_GAP_LEFT', 'UPPER_ARM_LEFT_SHELL', 'FOREARM_LEFT_SHELL'].includes(e.item.id)
    );
    const rightArm = shellEntries.filter((e) =>
      ['AXILLARY_GAP_RIGHT', 'UPPER_ARM_RIGHT_SHELL', 'FOREARM_RIGHT_SHELL'].includes(e.item.id)
    );

    this.outerShellTree = [upperAxial, lowerAxial, leftArm, rightArm]
      .filter((group) => group.length > 0)
      .map((group) => ({
        aabb: mergeAabbs(group.map((g) => g.aabb)),
        items: group,
      }));

    this.armorPlates = TIER1_ARMOR_PLATES.map((plate) => ({
      plate,
      aabb: computePrimitiveAabb(plate.shape, plate.localCenter, plate.halfExtents),
    }));

    this.organs = TIER2_INTERNAL_ORGANS.map((organ) => ({
      organ,
      aabb: computePrimitiveAabb(organ.shape, organ.localCenter, organ.halfExtents),
    }));

    this.bones = TIER2_SKELETAL_BONES.map((bone) => ({
      bone,
      aabb: computePrimitiveAabb(
        bone.shape,
        bone.localCenter,
        bone.halfExtents,
        bone.capsuleStart,
        bone.capsuleEnd,
        bone.capsuleRadiusM
      ),
    }));

    this.nerves = TIER2_NEURAL_PLEXUSES.map((nerve) => ({
      nerve,
      aabb: computePrimitiveAabb(
        'CAPSULE',
        lerp(nerve.capsuleStart, nerve.capsuleEnd, 0.5),
        vec3(0, 0, 0),
        nerve.capsuleStart,
        nerve.capsuleEnd,
        nerve.capsuleRadiusM
      ),
    }));

    this.vascularSplines = TIER2_VASCULAR_SPLINES.map((sp) => bakeVascularSpline(sp, 10));

    this.rootAabb = mergeAabbs([
      ...this.outerShellTree.map((n) => n.aabb),
      ...this.armorPlates.map((p) => p.aabb),
    ]);
  }

  /**
   * Tier-1 broadphase ray test in character local space:
   * Returns overall [tEntry, tExit] span across hit outer-shell/armor AABBs, or { hit: false } on miss.
   */
  public intersectTier1Broadphase(originLocal: Vec3Like, dirLocal: Vec3Like): RayIntervalHit {
    const rootHit = intersectRayAabb(originLocal, dirLocal, this.rootAabb);
    if (!rootHit.hit) {
      return rootHit;
    }

    let minT = Infinity;
    let maxT = -Infinity;
    let anyHit = false;

    for (const group of this.outerShellTree) {
      const gHit = intersectRayAabb(originLocal, dirLocal, group.aabb);
      if (!gHit.hit) continue;
      for (const entry of group.items) {
        const iHit = intersectRayAabb(originLocal, dirLocal, entry.aabb);
        if (iHit.hit) {
          anyHit = true;
          if (iHit.tMin < minT) minT = iHit.tMin;
          if (iHit.tMax > maxT) maxT = iHit.tMax;
        }
      }
    }

    for (const pEntry of this.armorPlates) {
      const pHit = intersectRayAabb(originLocal, dirLocal, pEntry.aabb);
      if (pHit.hit) {
        anyHit = true;
        if (pHit.tMin < minT) minT = pHit.tMin;
        if (pHit.tMax > maxT) maxT = pHit.tMax;
      }
    }

    if (!anyHit) {
      return { hit: false, tMin: 0, tMax: 0 };
    }
    return { hit: true, tMin: Math.max(0, minT), tMax: maxT };
  }

  /**
   * Checks whether a 3D point in character local space lies inside any Tier-1 outer shell volume.
   * Returns the highest outer-shell tissue density at that point (or 0 if outside the body).
   */
  public queryOuterShellAtPoint(pointLocal: Vec3Like): {
    insideBody: boolean;
    shellVolumes: Tier1OuterShellVolume[];
    baseDensityKgM3: number;
  } {
    const shellVolumes: Tier1OuterShellVolume[] = [];
    let baseDensityKgM3 = 0;

    for (const group of this.outerShellTree) {
      if (!aabbIntersectsSphere(group.aabb, pointLocal, 0.002)) continue;
      for (const entry of group.items) {
        if (!aabbIntersectsSphere(entry.aabb, pointLocal, 0.002)) continue;
        const sd = signedDistanceToShape(
          pointLocal,
          entry.item.shape,
          entry.item.localCenter,
          entry.item.halfExtents,
          entry.item.capsuleStart,
          entry.item.capsuleEnd,
          entry.item.capsuleRadiusM,
          entry.item.basisRight,
          entry.item.basisUp,
          entry.item.basisForward
        );
        if (sd <= 0) {
          shellVolumes.push(entry.item);
          if (entry.item.densityKgM3 > baseDensityKgM3) {
            baseDensityKgM3 = entry.item.densityKgM3;
          }
        }
      }
    }

    return {
      insideBody: shellVolumes.length > 0,
      shellVolumes,
      baseDensityKgM3,
    };
  }

  /**
   * Exact Tier-1 armor plate intersection along a 3D sub-step segment [segStartLocal, segEndLocal],
   * honoring exact ESAPI swimmer-cut corner bevels so armpit (`|x| > 0.125`) and collarbone (`y > 1.46`)
   * shots cleanly bypass the ceramic strike face!
   */
  public queryArmorPlatesAlongSegment(
    segStartLocal: Vec3Like,
    segEndLocal: Vec3Like,
    enableArmorPlates = true,
    enableHelmet = true
  ): Tier1ArmorPlateVolume[] {
    const hits: Tier1ArmorPlateVolume[] = [];
    const mid = lerp(segStartLocal, segEndLocal, 0.5);
    const halfSegLen = 0.5 * length(sub(segEndLocal, segStartLocal)) + 0.004;

    for (const entry of this.armorPlates) {
      const plate = entry.plate;
      if (plate.id === 'HELMET_BALLISTIC_SHELL' && !enableHelmet) continue;
      if (plate.id !== 'HELMET_BALLISTIC_SHELL' && !enableArmorPlates) continue;
      if (!aabbIntersectsSphere(entry.aabb, mid, halfSegLen)) continue;

      if (plate.shape === 'SPHERE') {
        // High-cut helmet dome only covers upper cranium (y >= 1.665)
        let hitHelmet = false;
        for (let i = 0; i <= 4; i++) {
          const pt = lerp(segStartLocal, segEndLocal, i * 0.25);
          if (pt.y < 1.665) continue;
          const outerSd = pointToEllipsoidSignedDistanceApprox(
            pt,
            plate.localCenter,
            plate.halfExtents
          );
          const innerRadii = vec3(
            plate.halfExtents.x - plate.thicknessM,
            plate.halfExtents.y - plate.thicknessM,
            plate.halfExtents.z - plate.thicknessM
          );
          const innerSd = pointToEllipsoidSignedDistanceApprox(pt, plate.localCenter, innerRadii);
          if (outerSd <= 0 && innerSd >= -0.003) {
            hitHelmet = true;
            break;
          }
        }
        if (hitHelmet) hits.push(plate);
        continue;
      }

      // Exact OBB + Swimmer-Cut Top-Corner Bevel check
      let hitPlate = false;
      for (let i = 0; i <= 4; i++) {
        const pt = lerp(segStartLocal, segEndLocal, i * 0.25);
        const { signedDistanceM, localCoords } = pointToObbSignedDistance(
          pt,
          plate.localCenter,
          plate.halfExtents,
          plate.basisRight,
          plate.basisUp,
          plate.basisForward
        );
        if (signedDistanceM <= 0) {
          if (plate.swimmerCutCornerFraction && plate.swimmerCutCornerFraction > 0) {
            // Swimmer-cut trims upper-lateral corner: normalized u = |x|/hx, v = y/hy (for top half y > 0)
            const u = Math.abs(localCoords.x) / plate.halfExtents.x;
            const v = localCoords.y / plate.halfExtents.y;
            if (v > 0.35 && u + v > 2.0 - plate.swimmerCutCornerFraction * 2.0) {
              continue; // Passes cleanly through swimmer-cut pectoral/axillary cutout!
            }
          }
          hitPlate = true;
          break;
        }
      }
      if (hitPlate) {
        hits.push(plate);
      }
    }

    return hits;
  }

  /**
   * Computes minimum 3D segment-to-spline distance from a sub-step segment [segStartLocal, segEndLocal]
   * to all baked Catmull-Rom vascular splines within `maxSearchRadiusM`.
   */
  public queryVascularSplinesAlongSegment(
    segStartLocal: Vec3Like,
    segEndLocal: Vec3Like,
    maxSearchRadiusM: number
  ): VascularSplineProximityHit[] {
    const mid = lerp(segStartLocal, segEndLocal, 0.5);
    const broadRadius = maxSearchRadiusM + 0.5 * length(sub(segEndLocal, segStartLocal)) + 0.02;
    const results: VascularSplineProximityHit[] = [];

    for (const baked of this.vascularSplines) {
      if (!aabbIntersectsSphere(baked.aabb, mid, broadRadius)) continue;

      let bestCenterDist = Infinity;
      let bestPoint = vec3(0, 0, 0);
      let bestTangent = vec3(0, 1, 0);
      let bestT = 0;

      for (const seg of baked.segments) {
        const match = closestDistanceBetweenSegments3D(segStartLocal, segEndLocal, seg.p0, seg.p1);
        if (match.distanceM < bestCenterDist) {
          bestCenterDist = match.distanceM;
          bestPoint = match.pointOnB;
          bestTangent = seg.tangent;
          bestT = seg.t0 + (seg.t1 - seg.t0) * match.t;
        }
      }

      const surfaceDist = bestCenterDist - baked.spline.lumenRadiusM;
      if (surfaceDist <= maxSearchRadiusM) {
        results.push({
          spline: baked.spline,
          centerDistanceM: bestCenterDist,
          surfaceDistanceM: surfaceDist,
          closestPointLocal: bestPoint,
          tangentLocal: bestTangent,
          parameterT: bestT,
        });
      }
    }

    results.sort((a, b) => a.surfaceDistanceM - b.surfaceDistanceM);
    return results;
  }

  /**
   * Full Tier-2 spatial query along a ray-march sub-step [segStartLocal, segEndLocal]
   * with permanent crush radius `crushRadiusM` and temporary cavitation stretch radius `stretchRadiusM`.
   */
  public queryTier2Step(
    segStartLocal: Vec3Like,
    segEndLocal: Vec3Like,
    crushRadiusM: number,
    stretchRadiusM: number,
    baseShellDensityKgM3: number
  ): Tier2SpatialQueryResult {
    const samplePointLocal = lerp(segStartLocal, segEndLocal, 0.5);
    const maxRadius = Math.max(crushRadiusM, stretchRadiusM);
    const segHalfLen = 0.5 * length(sub(segEndLocal, segStartLocal));
    const broadRadius = maxRadius + segHalfLen + 0.008;

    const directOrgans: InternalOrganVolume[] = [];
    const crushOrgans: InternalOrganVolume[] = [];
    const stretchOrgans: InternalOrganVolume[] = [];

    // 1. Internal Organs (Inelastic Brain/Liver + Elastic Lungs/Heart/Diaphragm/GI)
    let organDensityOverride: number | null = null;
    for (const entry of this.organs) {
      if (!aabbIntersectsSphere(entry.aabb, samplePointLocal, broadRadius)) continue;
      const sd = segmentMinSignedDistanceToShape(
        segStartLocal,
        segEndLocal,
        entry.organ.shape,
        entry.organ.localCenter,
        entry.organ.halfExtents
      );
      if (sd <= 0) {
        directOrgans.push(entry.organ);
        // Heart/Liver/Brain override lung density if overlapping mediastinum/diaphragm border
        if (organDensityOverride === null || entry.organ.densityKgM3 > organDensityOverride) {
          organDensityOverride = entry.organ.densityKgM3;
        }
      }
      if (sd <= crushRadiusM) {
        crushOrgans.push(entry.organ);
      }
      if (stretchRadiusM > 0 && sd <= stretchRadiusM) {
        stretchOrgans.push(entry.organ);
      }
    }

    // 2. Cortical Skeletal Bones (with hollow cavity support for Skull & Ribcage!)
    const hitBones: SkeletalBoneVolume[] = [];
    for (const entry of this.bones) {
      if (!aabbIntersectsSphere(entry.aabb, samplePointLocal, crushRadiusM + segHalfLen + 0.005)) {
        continue;
      }
      const bone = entry.bone;
      if (bone.hollowInnerHalfExtents) {
        // Hollow cortical shell (Skull vault, Ribcage wall, Pelvic ring): hits cortical wall when inside outer & outside inner
        let intersectsCorticalShell = false;
        for (let i = 0; i <= 4; i++) {
          const pt = lerp(segStartLocal, segEndLocal, i * 0.25);
          const outerSd = signedDistanceToShape(
            pt,
            bone.shape,
            bone.localCenter,
            bone.halfExtents
          );
          const innerSd = signedDistanceToShape(
            pt,
            bone.shape,
            bone.localCenter,
            bone.hollowInnerHalfExtents
          );
          if (outerSd <= crushRadiusM && innerSd >= -crushRadiusM) {
            intersectsCorticalShell = true;
            break;
          }
        }
        if (intersectsCorticalShell) {
          hitBones.push(bone);
        }
      } else {
        const sd = segmentMinSignedDistanceToShape(
          segStartLocal,
          segEndLocal,
          bone.shape,
          bone.localCenter,
          bone.halfExtents,
          bone.capsuleStart,
          bone.capsuleEnd,
          bone.capsuleRadiusM
        );
        if (sd <= crushRadiusM) {
          hitBones.push(bone);
        }
      }
    }

    // 3. Peripheral Neural Plexuses (Brachial Plexus Left/Right)
    const crushNerves: NeuralPlexusVolume[] = [];
    const stretchNerves: NeuralPlexusVolume[] = [];
    for (const entry of this.nerves) {
      if (!aabbIntersectsSphere(entry.aabb, samplePointLocal, broadRadius)) continue;
      const sd =
        closestDistanceBetweenSegments3D(
          segStartLocal,
          segEndLocal,
          entry.nerve.capsuleStart,
          entry.nerve.capsuleEnd
        ).distanceM - entry.nerve.capsuleRadiusM;
      if (sd <= crushRadiusM) {
        crushNerves.push(entry.nerve);
      }
      if (stretchRadiusM > 0 && sd <= stretchRadiusM) {
        stretchNerves.push(entry.nerve);
      }
    }

    // 4. 3D Catmull-Rom Vascular Splines (Arteries & Veins)
    const allVesselMatches = this.queryVascularSplinesAlongSegment(
      segStartLocal,
      segEndLocal,
      maxRadius
    );
    const crushVessels = allVesselMatches.filter((m) => m.surfaceDistanceM <= crushRadiusM);
    const stretchVessels =
      stretchRadiusM > 0
        ? allVesselMatches.filter((m) => m.surfaceDistanceM <= stretchRadiusM)
        : [];

    // Resolve local tissue density rho (kg/m^3): cortical bone (~1900) > organ density (lung 450, liver/brain 1080) > muscle (1060)
    let localTissueDensityKgM3 = baseShellDensityKgM3;
    if (organDensityOverride !== null) {
      localTissueDensityKgM3 = organDensityOverride;
    }
    for (const b of hitBones) {
      if (b.densityKgM3 > localTissueDensityKgM3) {
        localTissueDensityKgM3 = b.densityKgM3;
      }
    }

    return {
      samplePointLocal,
      localTissueDensityKgM3,
      directOrgans,
      crushOrgans,
      stretchOrgans,
      hitBones,
      crushNerves,
      stretchNerves,
      crushVessels,
      stretchVessels,
    };
  }
}

let defaultSingletonBvh: AnatomicalBvh | null = null;

export function getDefaultAnatomicalBvh(): AnatomicalBvh {
  if (!defaultSingletonBvh) {
    defaultSingletonBvh = new AnatomicalBvh();
  }
  return defaultSingletonBvh;
}
