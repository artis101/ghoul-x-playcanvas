import {
  GhoulZoneId,
  AnatomicalColliderVolume,
  TargetHealthState,
  RagdollBoneState,
  AuxParticleId,
  AuxRagdollParticle,
  RagdollDistanceConstraint,
  EnemyArchetypeId,
  GoreMode,
  Vec3Like,
} from '../../contracts/ballistics.ts';
import {
  vec3,
  copyVec3,
  add,
  sub,
  scale,
  cross,
  dot,
  length,
  normalize,
  distance,
} from '../ballistics/vec3.ts';

export const ALL_GHOUL_ZONES: GhoulZoneId[] = [
  'HEAD_CRANIUM',
  'HEAD_FACE_JAW',
  'NECK_CERVICAL',
  'TORSO_UPPER_THORAX',
  'TORSO_LOWER_ABDOMEN',
  'PELVIS_GROIN',
  'SHOULDER_LEFT',
  'UPPER_ARM_LEFT',
  'FOREARM_LEFT',
  'HAND_LEFT',
  'SHOULDER_RIGHT',
  'UPPER_ARM_RIGHT',
  'FOREARM_RIGHT',
  'HAND_RIGHT',
  'THIGH_LEFT',
  'KNEE_LEFT',
  'SHIN_LEFT',
  'FOOT_LEFT',
  'THIGH_RIGHT',
  'KNEE_RIGHT',
  'SHIN_RIGHT',
  'FOOT_RIGHT',
];

export interface GhoulZoneNode {
  parent?: GhoulZoneId;
  children: GhoulZoneId[];
  /** Primary child or aux particle used to orient the bone's longitudinal axis */
  distalTarget: GhoulZoneId | AuxParticleId;
  jointLocalPos: Vec3Like;
  defaultMassKg: number;
  collisionRadiusM: number;
  label: string;
}

/**
 * Kinematic & PBD ragdoll tree for Soldier of Fortune GHOUL dismemberment.
 * Standing height ~1.80m, feet grounded at y = 0, facing +Z.
 */
export const GHOUL_ZONE_HIERARCHY: Record<GhoulZoneId, GhoulZoneNode> = {
  PELVIS_GROIN: {
    children: ['TORSO_LOWER_ABDOMEN', 'THIGH_LEFT', 'THIGH_RIGHT'],
    distalTarget: 'TORSO_LOWER_ABDOMEN',
    jointLocalPos: vec3(0, 0.95, 0),
    defaultMassKg: 14.0,
    collisionRadiusM: 0.12,
    label: 'Pelvis / Groin',
  },
  TORSO_LOWER_ABDOMEN: {
    parent: 'PELVIS_GROIN',
    children: ['TORSO_UPPER_THORAX'],
    distalTarget: 'TORSO_UPPER_THORAX',
    jointLocalPos: vec3(0, 1.10, 0),
    defaultMassKg: 15.0,
    collisionRadiusM: 0.12,
    label: 'Abdomen / Stomach',
  },
  TORSO_UPPER_THORAX: {
    parent: 'TORSO_LOWER_ABDOMEN',
    children: ['NECK_CERVICAL', 'SHOULDER_LEFT', 'SHOULDER_RIGHT'],
    distalTarget: 'NECK_CERVICAL',
    jointLocalPos: vec3(0, 1.30, 0),
    defaultMassKg: 19.0,
    collisionRadiusM: 0.14,
    label: 'Thorax / Chest',
  },
  NECK_CERVICAL: {
    parent: 'TORSO_UPPER_THORAX',
    children: ['HEAD_CRANIUM'],
    distalTarget: 'HEAD_CRANIUM',
    jointLocalPos: vec3(0, 1.55, 0),
    defaultMassKg: 2.5,
    collisionRadiusM: 0.06,
    label: 'Cervical Neck',
  },
  HEAD_CRANIUM: {
    parent: 'NECK_CERVICAL',
    children: ['HEAD_FACE_JAW'],
    distalTarget: 'HEAD_TOP',
    jointLocalPos: vec3(0, 1.66, 0),
    defaultMassKg: 4.5,
    collisionRadiusM: 0.10,
    label: 'Cranium / Braincase',
  },
  HEAD_FACE_JAW: {
    parent: 'HEAD_CRANIUM',
    children: [],
    distalTarget: 'HEAD_TOP',
    jointLocalPos: vec3(0, 1.61, 0.08),
    defaultMassKg: 1.5,
    collisionRadiusM: 0.06,
    label: 'Face / Mandible',
  },
  SHOULDER_LEFT: {
    parent: 'TORSO_UPPER_THORAX',
    children: ['UPPER_ARM_LEFT'],
    distalTarget: 'UPPER_ARM_LEFT',
    jointLocalPos: vec3(-0.22, 1.48, 0),
    defaultMassKg: 2.8,
    collisionRadiusM: 0.075,
    label: 'Left Clavicle / Shoulder',
  },
  UPPER_ARM_LEFT: {
    parent: 'SHOULDER_LEFT',
    children: ['FOREARM_LEFT'],
    distalTarget: 'FOREARM_LEFT',
    jointLocalPos: vec3(-0.28, 1.38, 0),
    defaultMassKg: 3.2,
    collisionRadiusM: 0.06,
    label: 'Left Upper Arm / Bicep',
  },
  FOREARM_LEFT: {
    parent: 'UPPER_ARM_LEFT',
    children: ['HAND_LEFT'],
    distalTarget: 'HAND_LEFT',
    jointLocalPos: vec3(-0.31, 1.13, 0.03),
    defaultMassKg: 2.0,
    collisionRadiusM: 0.05,
    label: 'Left Forearm',
  },
  HAND_LEFT: {
    parent: 'FOREARM_LEFT',
    children: [],
    distalTarget: 'HAND_TIP_LEFT',
    jointLocalPos: vec3(-0.14, 1.15, 0.24),
    defaultMassKg: 0.9,
    collisionRadiusM: 0.045,
    label: 'Left Hand',
  },
  SHOULDER_RIGHT: {
    parent: 'TORSO_UPPER_THORAX',
    children: ['UPPER_ARM_RIGHT'],
    distalTarget: 'UPPER_ARM_RIGHT',
    jointLocalPos: vec3(0.22, 1.48, 0),
    defaultMassKg: 2.8,
    collisionRadiusM: 0.075,
    label: 'Right Clavicle / Shoulder',
  },
  UPPER_ARM_RIGHT: {
    parent: 'SHOULDER_RIGHT',
    children: ['FOREARM_RIGHT'],
    distalTarget: 'FOREARM_RIGHT',
    jointLocalPos: vec3(0.28, 1.38, 0),
    defaultMassKg: 3.2,
    collisionRadiusM: 0.06,
    label: 'Right Upper Arm / Bicep',
  },
  FOREARM_RIGHT: {
    parent: 'UPPER_ARM_RIGHT',
    children: ['HAND_RIGHT'],
    distalTarget: 'HAND_RIGHT',
    jointLocalPos: vec3(0.30, 1.13, 0.03),
    defaultMassKg: 2.0,
    collisionRadiusM: 0.05,
    label: 'Right Forearm',
  },
  HAND_RIGHT: {
    parent: 'FOREARM_RIGHT',
    children: [],
    distalTarget: 'HAND_TIP_RIGHT',
    jointLocalPos: vec3(0.14, 1.16, 0.20),
    defaultMassKg: 0.9,
    collisionRadiusM: 0.045,
    label: 'Right Hand',
  },
  THIGH_LEFT: {
    parent: 'PELVIS_GROIN',
    children: ['KNEE_LEFT'],
    distalTarget: 'KNEE_LEFT',
    jointLocalPos: vec3(-0.115, 0.86, 0),
    defaultMassKg: 8.0,
    collisionRadiusM: 0.08,
    label: 'Left Thigh / Femur',
  },
  KNEE_LEFT: {
    parent: 'THIGH_LEFT',
    children: ['SHIN_LEFT'],
    distalTarget: 'SHIN_LEFT',
    jointLocalPos: vec3(-0.12, 0.50, 0.01),
    defaultMassKg: 1.8,
    collisionRadiusM: 0.06,
    label: 'Left Knee / Patella',
  },
  SHIN_LEFT: {
    parent: 'KNEE_LEFT',
    children: ['FOOT_LEFT'],
    distalTarget: 'FOOT_LEFT',
    jointLocalPos: vec3(-0.12, 0.28, 0),
    defaultMassKg: 3.5,
    collisionRadiusM: 0.055,
    label: 'Left Shin / Calf',
  },
  FOOT_LEFT: {
    parent: 'SHIN_LEFT',
    children: [],
    distalTarget: 'FOOT_TOE_LEFT',
    jointLocalPos: vec3(-0.12, 0.065, 0.02),
    defaultMassKg: 1.4,
    collisionRadiusM: 0.06,
    label: 'Left Combat Boot',
  },
  THIGH_RIGHT: {
    parent: 'PELVIS_GROIN',
    children: ['KNEE_RIGHT'],
    distalTarget: 'KNEE_RIGHT',
    jointLocalPos: vec3(0.115, 0.86, 0),
    defaultMassKg: 8.0,
    collisionRadiusM: 0.08,
    label: 'Right Thigh / Femur',
  },
  KNEE_RIGHT: {
    parent: 'THIGH_RIGHT',
    children: ['SHIN_RIGHT'],
    distalTarget: 'SHIN_RIGHT',
    jointLocalPos: vec3(0.12, 0.50, 0.01),
    defaultMassKg: 1.8,
    collisionRadiusM: 0.06,
    label: 'Right Knee / Patella',
  },
  SHIN_RIGHT: {
    parent: 'KNEE_RIGHT',
    children: ['FOOT_RIGHT'],
    distalTarget: 'FOOT_RIGHT',
    jointLocalPos: vec3(0.12, 0.28, 0),
    defaultMassKg: 3.5,
    collisionRadiusM: 0.055,
    label: 'Right Shin / Calf',
  },
  FOOT_RIGHT: {
    parent: 'SHIN_RIGHT',
    children: [],
    distalTarget: 'FOOT_TOE_RIGHT',
    jointLocalPos: vec3(0.12, 0.065, 0.02),
    defaultMassKg: 1.4,
    collisionRadiusM: 0.06,
    label: 'Right Combat Boot',
  },
};

export const AUX_PARTICLE_REST_LOCAL: Record<
  AuxParticleId,
  { parentZone: GhoulZoneId; localPos: Vec3Like; massKg: number; radiusM: number }
> = {
  HEAD_TOP: {
    parentZone: 'HEAD_CRANIUM',
    localPos: vec3(0, 1.81, 0),
    massKg: 1.2,
    radiusM: 0.09,
  },
  HAND_TIP_LEFT: {
    parentZone: 'HAND_LEFT',
    localPos: vec3(-0.08, 1.15, 0.32),
    massKg: 0.4,
    radiusM: 0.035,
  },
  HAND_TIP_RIGHT: {
    parentZone: 'HAND_RIGHT',
    localPos: vec3(0.10, 1.16, 0.29),
    massKg: 0.4,
    radiusM: 0.035,
  },
  FOOT_TOE_LEFT: {
    parentZone: 'FOOT_LEFT',
    localPos: vec3(-0.12, 0.045, 0.18),
    massKg: 0.6,
    radiusM: 0.045,
  },
  FOOT_TOE_RIGHT: {
    parentZone: 'FOOT_RIGHT',
    localPos: vec3(0.12, 0.045, 0.18),
    massKg: 0.6,
    radiusM: 0.045,
  },
};

export const ALL_AUX_PARTICLES: AuxParticleId[] = [
  'HEAD_TOP',
  'HAND_TIP_LEFT',
  'HAND_TIP_RIGHT',
  'FOOT_TOE_LEFT',
  'FOOT_TOE_RIGHT',
];

/**
 * Returns all zones in the kinematic subtree rooted at `zone`, including `zone` itself.
 */
export function getSubtreeZones(zone: GhoulZoneId): GhoulZoneId[] {
  const result: GhoulZoneId[] = [];
  const queue: GhoulZoneId[] = [zone];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    const node = GHOUL_ZONE_HIERARCHY[current];
    if (node && node.children) {
      for (const child of node.children) {
        queue.push(child);
      }
    }
  }
  return result;
}

/**
 * Builds the comprehensive multi-layered anatomical collision volumes for GHOUL & Terminal Ballistics.
 * Local coordinate system: Feet at y=0, Model height ~1.82m, Facing +Z.
 */
export function buildAnatomicalColliders(): AnatomicalColliderVolume[] {
  return [
    // -------------------------------------------------------------------------
    // BALLISTIC ARMOR LAYERS (Evaluated only when target has active helmet/vest armor)
    // -------------------------------------------------------------------------
    {
      id: 'vol_helmet_kevlar',
      label: 'PASGT Kevlar Ballistic Helmet',
      ghoulZone: 'HEAD_CRANIUM',
      layerType: 'ARMOR_KEVLAR',
      localCenter: vec3(0, 1.72, -0.005),
      halfExtents: vec3(0.112, 0.095, 0.118),
      shape: 'SPHERE',
      densityKgM3: 1440,
      stoppingPowerFactor: 8.5,
      fractureThresholdJ: 450,
      severThresholdJ: 9999,
      vitalityMultiplier: 0.0,
      limbMassKg: 1.5,
      parentZone: 'NECK_CERVICAL',
    },
    {
      id: 'vol_thorax_kevlar_vest',
      label: 'NIJ IIIA Tactical Flak Vest',
      ghoulZone: 'TORSO_UPPER_THORAX',
      layerType: 'ARMOR_KEVLAR',
      localCenter: vec3(0, 1.33, 0),
      halfExtents: vec3(0.19, 0.15, 0.14),
      shape: 'BOX',
      densityKgM3: 1440,
      stoppingPowerFactor: 7.2,
      fractureThresholdJ: 550,
      severThresholdJ: 9999,
      vitalityMultiplier: 0.0,
      limbMassKg: 3.2,
      parentZone: 'TORSO_LOWER_ABDOMEN',
    },

    // -------------------------------------------------------------------------
    // HEAD & NECK
    // -------------------------------------------------------------------------
    {
      id: 'vol_head_cranium_flesh',
      label: 'Cranium Scalp & Soft Flesh',
      ghoulZone: 'HEAD_CRANIUM',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0, 1.70, 0),
      halfExtents: vec3(0.10, 0.10, 0.11),
      shape: 'SPHERE',
      densityKgM3: 1060,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 60,
      severThresholdJ: 920,
      vitalityMultiplier: 2.0,
      limbMassKg: 4.5,
      parentZone: 'NECK_CERVICAL',
      childZones: ['HEAD_FACE_JAW'],
    },
    {
      id: 'vol_head_cranium_bone',
      label: 'Cranial Calvarium Bone (Skull)',
      ghoulZone: 'HEAD_CRANIUM',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0, 1.70, 0),
      halfExtents: vec3(0.085, 0.085, 0.095),
      shape: 'SPHERE',
      densityKgM3: 1900,
      stoppingPowerFactor: 4.5,
      fractureThresholdJ: 120,
      severThresholdJ: 920,
      vitalityMultiplier: 2.5,
      limbMassKg: 1.8,
      parentZone: 'NECK_CERVICAL',
    },
    {
      id: 'vol_head_brain',
      label: 'Brain (Cerebrum & Brainstem)',
      ghoulZone: 'HEAD_CRANIUM',
      layerType: 'ORGAN_BRAIN',
      localCenter: vec3(0, 1.69, -0.01),
      halfExtents: vec3(0.07, 0.07, 0.08),
      shape: 'SPHERE',
      densityKgM3: 1040,
      stoppingPowerFactor: 1.2,
      fractureThresholdJ: 30,
      severThresholdJ: 920,
      vitalityMultiplier: 5.0,
      limbMassKg: 1.4,
      parentZone: 'NECK_CERVICAL',
    },
    {
      id: 'vol_head_face_flesh',
      label: 'Facial Soft Tissue & Cheeks',
      ghoulZone: 'HEAD_FACE_JAW',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0, 1.62, 0.07),
      halfExtents: vec3(0.08, 0.065, 0.06),
      shape: 'BOX',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 50,
      severThresholdJ: 920,
      vitalityMultiplier: 2.2,
      limbMassKg: 1.5,
      parentZone: 'HEAD_CRANIUM',
    },
    {
      id: 'vol_head_jaw_bone',
      label: 'Mandible & Maxilla Bones',
      ghoulZone: 'HEAD_FACE_JAW',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0, 1.60, 0.06),
      halfExtents: vec3(0.065, 0.045, 0.045),
      shape: 'BOX',
      densityKgM3: 1850,
      stoppingPowerFactor: 3.8,
      fractureThresholdJ: 95,
      severThresholdJ: 920,
      vitalityMultiplier: 2.0,
      limbMassKg: 0.6,
      parentZone: 'HEAD_CRANIUM',
    },
    {
      id: 'vol_neck_flesh',
      label: 'Neck Musculature & Throat',
      ghoulZone: 'NECK_CERVICAL',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0, 1.54, 0),
      halfExtents: vec3(0.07, 0.06, 0.07),
      shape: 'CAPSULE',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.1,
      fractureThresholdJ: 60,
      severThresholdJ: 1050,
      vitalityMultiplier: 2.5,
      limbMassKg: 2.5,
      parentZone: 'TORSO_UPPER_THORAX',
      childZones: ['HEAD_CRANIUM', 'HEAD_FACE_JAW'],
    },
    {
      id: 'vol_neck_spine',
      label: 'Cervical Spine (C1-C7)',
      ghoulZone: 'NECK_CERVICAL',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0, 1.54, -0.02),
      halfExtents: vec3(0.03, 0.055, 0.03),
      shape: 'CAPSULE',
      densityKgM3: 1900,
      stoppingPowerFactor: 4.8,
      fractureThresholdJ: 110,
      severThresholdJ: 520,
      vitalityMultiplier: 4.8,
      limbMassKg: 0.7,
      parentZone: 'TORSO_UPPER_THORAX',
    },
    {
      id: 'vol_neck_carotid',
      label: 'Carotid Artery & Jugular',
      ghoulZone: 'NECK_CERVICAL',
      layerType: 'ARTERY_CAROTID_AORTA',
      localCenter: vec3(0.03, 1.54, 0.02),
      halfExtents: vec3(0.028, 0.05, 0.028),
      shape: 'CAPSULE',
      densityKgM3: 1030,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 20,
      severThresholdJ: 520,
      vitalityMultiplier: 3.5,
      limbMassKg: 0.3,
      parentZone: 'TORSO_UPPER_THORAX',
    },

    // -------------------------------------------------------------------------
    // THORAX & VITAL ORGANS
    // -------------------------------------------------------------------------
    {
      id: 'vol_thorax_flesh',
      label: 'Thoracic Pectorals & Back Flesh',
      ghoulZone: 'TORSO_UPPER_THORAX',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0, 1.34, 0),
      halfExtents: vec3(0.18, 0.14, 0.13),
      shape: 'BOX',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 70,
      severThresholdJ: 9999, // Thorax never detaches into floating cubes
      vitalityMultiplier: 1.2,
      limbMassKg: 19.0,
      parentZone: 'TORSO_LOWER_ABDOMEN',
    },
    {
      id: 'vol_thorax_ribcage',
      label: 'Sternum & Thoracic Ribcage Bone',
      ghoulZone: 'TORSO_UPPER_THORAX',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0, 1.34, 0),
      halfExtents: vec3(0.16, 0.13, 0.11),
      shape: 'BOX',
      densityKgM3: 1850,
      stoppingPowerFactor: 3.5,
      fractureThresholdJ: 130,
      severThresholdJ: 9999,
      vitalityMultiplier: 1.8,
      limbMassKg: 4.5,
      parentZone: 'TORSO_LOWER_ABDOMEN',
    },
    {
      id: 'vol_thorax_heart',
      label: 'Heart (Myocardium & Ventricles)',
      ghoulZone: 'TORSO_UPPER_THORAX',
      layerType: 'ORGAN_HEART',
      localCenter: vec3(-0.02, 1.33, 0.01),
      halfExtents: vec3(0.075, 0.075, 0.075),
      shape: 'SPHERE',
      densityKgM3: 1060,
      stoppingPowerFactor: 1.3,
      fractureThresholdJ: 40,
      severThresholdJ: 9999,
      vitalityMultiplier: 4.5,
      limbMassKg: 0.8,
      parentZone: 'TORSO_UPPER_THORAX',
    },
    {
      id: 'vol_thorax_lung_left',
      label: 'Left Lung',
      ghoulZone: 'TORSO_UPPER_THORAX',
      layerType: 'ORGAN_LUNG_LEFT',
      localCenter: vec3(-0.08, 1.35, 0.01),
      halfExtents: vec3(0.065, 0.095, 0.07),
      shape: 'BOX',
      densityKgM3: 450,
      stoppingPowerFactor: 0.8,
      fractureThresholdJ: 35,
      severThresholdJ: 9999,
      vitalityMultiplier: 2.5,
      limbMassKg: 0.6,
      parentZone: 'TORSO_UPPER_THORAX',
    },
    {
      id: 'vol_thorax_lung_right',
      label: 'Right Lung',
      ghoulZone: 'TORSO_UPPER_THORAX',
      layerType: 'ORGAN_LUNG_RIGHT',
      localCenter: vec3(0.08, 1.35, 0.01),
      halfExtents: vec3(0.065, 0.095, 0.07),
      shape: 'BOX',
      densityKgM3: 450,
      stoppingPowerFactor: 0.8,
      fractureThresholdJ: 35,
      severThresholdJ: 9999,
      vitalityMultiplier: 2.5,
      limbMassKg: 0.7,
      parentZone: 'TORSO_UPPER_THORAX',
    },
    {
      id: 'vol_thorax_aorta',
      label: 'Ascending / Descending Aorta',
      ghoulZone: 'TORSO_UPPER_THORAX',
      layerType: 'ARTERY_CAROTID_AORTA',
      localCenter: vec3(0.0, 1.33, -0.02),
      halfExtents: vec3(0.025, 0.08, 0.025),
      shape: 'CAPSULE',
      densityKgM3: 1040,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 25,
      severThresholdJ: 9999,
      vitalityMultiplier: 4.0,
      limbMassKg: 0.3,
      parentZone: 'TORSO_UPPER_THORAX',
    },

    // -------------------------------------------------------------------------
    // ABDOMEN & VISCERAL ORGANS (EVISCERATES WITHOUT DETACHING SPINE!)
    // -------------------------------------------------------------------------
    {
      id: 'vol_abdomen_flesh',
      label: 'Abdominal Wall & Obliques',
      ghoulZone: 'TORSO_LOWER_ABDOMEN',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0, 1.13, 0),
      halfExtents: vec3(0.16, 0.11, 0.12),
      shape: 'BOX',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 55,
      severThresholdJ: 1250, // Triggers SoF EVISCERATED open gut wound on heavy close blast (spine remains joined!)
      vitalityMultiplier: 1.4,
      limbMassKg: 15.0,
      parentZone: 'PELVIS_GROIN',
    },
    {
      id: 'vol_abdomen_spine',
      label: 'Lumbar Spine (L1-L5)',
      ghoulZone: 'TORSO_LOWER_ABDOMEN',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0, 1.13, -0.05),
      halfExtents: vec3(0.035, 0.09, 0.035),
      shape: 'CAPSULE',
      densityKgM3: 1900,
      stoppingPowerFactor: 4.6,
      fractureThresholdJ: 125,
      severThresholdJ: 9999,
      vitalityMultiplier: 3.5,
      limbMassKg: 1.2,
      parentZone: 'PELVIS_GROIN',
    },
    {
      id: 'vol_abdomen_liver',
      label: 'Liver (Right Hypochondrium)',
      ghoulZone: 'TORSO_LOWER_ABDOMEN',
      layerType: 'ORGAN_LIVER',
      localCenter: vec3(0.06, 1.16, 0.02),
      halfExtents: vec3(0.07, 0.06, 0.07),
      shape: 'SPHERE',
      densityKgM3: 1060,
      stoppingPowerFactor: 1.2,
      fractureThresholdJ: 40,
      severThresholdJ: 9999,
      vitalityMultiplier: 2.4,
      limbMassKg: 1.5,
      parentZone: 'TORSO_LOWER_ABDOMEN',
    },
    {
      id: 'vol_abdomen_gut',
      label: 'Stomach & Intestines (Gastrointestinal)',
      ghoulZone: 'TORSO_LOWER_ABDOMEN',
      layerType: 'ORGAN_STOMACH_GUT',
      localCenter: vec3(-0.02, 1.11, 0.03),
      halfExtents: vec3(0.095, 0.075, 0.085),
      shape: 'BOX',
      densityKgM3: 1020,
      stoppingPowerFactor: 0.95,
      fractureThresholdJ: 35,
      severThresholdJ: 9999,
      vitalityMultiplier: 2.0,
      limbMassKg: 2.5,
      parentZone: 'TORSO_LOWER_ABDOMEN',
    },

    // -------------------------------------------------------------------------
    // PELVIS & GROIN
    // -------------------------------------------------------------------------
    {
      id: 'vol_pelvis_flesh',
      label: 'Pelvic Girdle & Gluteal Muscle',
      ghoulZone: 'PELVIS_GROIN',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0, 0.95, 0),
      halfExtents: vec3(0.17, 0.09, 0.12),
      shape: 'BOX',
      densityKgM3: 1060,
      stoppingPowerFactor: 1.1,
      fractureThresholdJ: 80,
      severThresholdJ: 9999,
      vitalityMultiplier: 1.6,
      limbMassKg: 14.0,
    },
    {
      id: 'vol_pelvis_bone',
      label: 'Pelvis (Ilium, Ischium & Sacrum)',
      ghoulZone: 'PELVIS_GROIN',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0, 0.95, 0),
      halfExtents: vec3(0.15, 0.08, 0.09),
      shape: 'BOX',
      densityKgM3: 1920,
      stoppingPowerFactor: 4.8,
      fractureThresholdJ: 150,
      severThresholdJ: 9999,
      vitalityMultiplier: 2.2,
      limbMassKg: 3.5,
    },

    // -------------------------------------------------------------------------
    // LEFT UPPER LIMB
    // -------------------------------------------------------------------------
    {
      id: 'vol_shoulder_left_flesh',
      label: 'Left Deltoid Soft Tissue',
      ghoulZone: 'SHOULDER_LEFT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(-0.23, 1.45, 0),
      halfExtents: vec3(0.075, 0.075, 0.075),
      shape: 'SPHERE',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 60,
      severThresholdJ: 9999, // Shoulder socket stays on thorax; upper arm severs cleanly below it
      vitalityMultiplier: 0.9,
      limbMassKg: 2.8,
      parentZone: 'TORSO_UPPER_THORAX',
      childZones: ['UPPER_ARM_LEFT', 'FOREARM_LEFT', 'HAND_LEFT'],
    },
    {
      id: 'vol_upper_arm_left_flesh',
      label: 'Left Bicep/Tricep Flesh',
      ghoulZone: 'UPPER_ARM_LEFT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(-0.29, 1.26, 0.01),
      halfExtents: vec3(0.06, 0.13, 0.06),
      shape: 'CAPSULE',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 55,
      severThresholdJ: 620,
      vitalityMultiplier: 0.8,
      limbMassKg: 3.2,
      parentZone: 'SHOULDER_LEFT',
      childZones: ['FOREARM_LEFT', 'HAND_LEFT'],
    },
    {
      id: 'vol_upper_arm_left_bone',
      label: 'Left Humerus Bone',
      ghoulZone: 'UPPER_ARM_LEFT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(-0.29, 1.26, 0.01),
      halfExtents: vec3(0.024, 0.12, 0.024),
      shape: 'CAPSULE',
      densityKgM3: 1900,
      stoppingPowerFactor: 4.2,
      fractureThresholdJ: 105,
      severThresholdJ: 620,
      vitalityMultiplier: 1.2,
      limbMassKg: 0.9,
      parentZone: 'SHOULDER_LEFT',
    },
    {
      id: 'vol_forearm_left_flesh',
      label: 'Left Forearm Musculature',
      ghoulZone: 'FOREARM_LEFT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(-0.23, 1.14, 0.13),
      halfExtents: vec3(0.05, 0.11, 0.09),
      shape: 'BOX',
      densityKgM3: 1050,
      stoppingPowerFactor: 0.95,
      fractureThresholdJ: 45,
      severThresholdJ: 520,
      vitalityMultiplier: 0.6,
      limbMassKg: 2.0,
      parentZone: 'UPPER_ARM_LEFT',
      childZones: ['HAND_LEFT'],
    },
    {
      id: 'vol_forearm_left_bone',
      label: 'Left Radius / Ulna Bone',
      ghoulZone: 'FOREARM_LEFT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(-0.23, 1.14, 0.13),
      halfExtents: vec3(0.022, 0.05, 0.08),
      shape: 'BOX',
      densityKgM3: 1900,
      stoppingPowerFactor: 4.0,
      fractureThresholdJ: 85,
      severThresholdJ: 520,
      vitalityMultiplier: 0.8,
      limbMassKg: 0.5,
      parentZone: 'UPPER_ARM_LEFT',
    },
    {
      id: 'vol_hand_left_flesh',
      label: 'Left Hand & Metacarpals',
      ghoulZone: 'HAND_LEFT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(-0.11, 1.15, 0.27),
      halfExtents: vec3(0.045, 0.05, 0.055),
      shape: 'BOX',
      densityKgM3: 1080,
      stoppingPowerFactor: 0.9,
      fractureThresholdJ: 35,
      severThresholdJ: 380,
      vitalityMultiplier: 0.4,
      limbMassKg: 0.9,
      parentZone: 'FOREARM_LEFT',
    },

    // -------------------------------------------------------------------------
    // RIGHT UPPER LIMB (WEAPON ARM)
    // -------------------------------------------------------------------------
    {
      id: 'vol_shoulder_right_flesh',
      label: 'Right Deltoid Soft Tissue',
      ghoulZone: 'SHOULDER_RIGHT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0.23, 1.45, 0),
      halfExtents: vec3(0.075, 0.075, 0.075),
      shape: 'SPHERE',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 60,
      severThresholdJ: 9999,
      vitalityMultiplier: 0.9,
      limbMassKg: 2.8,
      parentZone: 'TORSO_UPPER_THORAX',
      childZones: ['UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 'HAND_RIGHT'],
    },
    {
      id: 'vol_upper_arm_right_flesh',
      label: 'Right Bicep/Tricep Flesh',
      ghoulZone: 'UPPER_ARM_RIGHT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0.29, 1.26, 0.01),
      halfExtents: vec3(0.06, 0.13, 0.06),
      shape: 'CAPSULE',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 55,
      severThresholdJ: 620,
      vitalityMultiplier: 0.8,
      limbMassKg: 3.2,
      parentZone: 'SHOULDER_RIGHT',
      childZones: ['FOREARM_RIGHT', 'HAND_RIGHT'],
    },
    {
      id: 'vol_upper_arm_right_bone',
      label: 'Right Humerus Bone',
      ghoulZone: 'UPPER_ARM_RIGHT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0.29, 1.26, 0.01),
      halfExtents: vec3(0.024, 0.12, 0.024),
      shape: 'CAPSULE',
      densityKgM3: 1900,
      stoppingPowerFactor: 4.2,
      fractureThresholdJ: 105,
      severThresholdJ: 620,
      vitalityMultiplier: 1.2,
      limbMassKg: 0.9,
      parentZone: 'SHOULDER_RIGHT',
    },
    {
      id: 'vol_forearm_right_flesh',
      label: 'Right Forearm Musculature',
      ghoulZone: 'FOREARM_RIGHT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0.22, 1.14, 0.11),
      halfExtents: vec3(0.05, 0.07, 0.09),
      shape: 'BOX',
      densityKgM3: 1050,
      stoppingPowerFactor: 0.95,
      fractureThresholdJ: 45,
      severThresholdJ: 520,
      vitalityMultiplier: 0.6,
      limbMassKg: 2.0,
      parentZone: 'UPPER_ARM_RIGHT',
      childZones: ['HAND_RIGHT'],
    },
    {
      id: 'vol_forearm_right_bone',
      label: 'Right Radius / Ulna Bone',
      ghoulZone: 'FOREARM_RIGHT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0.22, 1.14, 0.11),
      halfExtents: vec3(0.022, 0.04, 0.08),
      shape: 'BOX',
      densityKgM3: 1900,
      stoppingPowerFactor: 4.0,
      fractureThresholdJ: 85,
      severThresholdJ: 520,
      vitalityMultiplier: 0.8,
      limbMassKg: 0.5,
      parentZone: 'UPPER_ARM_RIGHT',
    },
    {
      id: 'vol_hand_right_flesh',
      label: 'Right Weapon Hand & Metacarpals',
      ghoulZone: 'HAND_RIGHT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0.12, 1.16, 0.24),
      halfExtents: vec3(0.045, 0.05, 0.055),
      shape: 'BOX',
      densityKgM3: 1080,
      stoppingPowerFactor: 0.9,
      fractureThresholdJ: 35,
      severThresholdJ: 380,
      vitalityMultiplier: 0.4,
      limbMassKg: 0.9,
      parentZone: 'FOREARM_RIGHT',
    },

    // -------------------------------------------------------------------------
    // LEFT LOWER LIMB
    // -------------------------------------------------------------------------
    {
      id: 'vol_thigh_left_flesh',
      label: 'Left Quadriceps & Femoral Flesh',
      ghoulZone: 'THIGH_LEFT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(-0.12, 0.69, 0),
      halfExtents: vec3(0.082, 0.16, 0.082),
      shape: 'CAPSULE',
      densityKgM3: 1060,
      stoppingPowerFactor: 1.05,
      fractureThresholdJ: 80,
      severThresholdJ: 820,
      vitalityMultiplier: 1.1,
      limbMassKg: 8.0,
      parentZone: 'PELVIS_GROIN',
      childZones: ['KNEE_LEFT', 'SHIN_LEFT', 'FOOT_LEFT'],
    },
    {
      id: 'vol_thigh_left_bone',
      label: 'Left Femur Bone',
      ghoulZone: 'THIGH_LEFT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(-0.12, 0.69, 0),
      halfExtents: vec3(0.028, 0.14, 0.028),
      shape: 'CAPSULE',
      densityKgM3: 1950,
      stoppingPowerFactor: 4.5,
      fractureThresholdJ: 135,
      severThresholdJ: 820,
      vitalityMultiplier: 1.5,
      limbMassKg: 2.2,
      parentZone: 'PELVIS_GROIN',
    },
    {
      id: 'vol_thigh_left_artery',
      label: 'Left Femoral Artery',
      ghoulZone: 'THIGH_LEFT',
      layerType: 'ARTERY_CAROTID_AORTA',
      localCenter: vec3(-0.09, 0.72, 0.02),
      halfExtents: vec3(0.022, 0.12, 0.022),
      shape: 'CAPSULE',
      densityKgM3: 1040,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 25,
      severThresholdJ: 820,
      vitalityMultiplier: 2.6,
      limbMassKg: 0.2,
      parentZone: 'PELVIS_GROIN',
    },
    {
      id: 'vol_knee_left',
      label: 'Left Knee Patella & Joint',
      ghoulZone: 'KNEE_LEFT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(-0.12, 0.50, 0.01),
      halfExtents: vec3(0.055, 0.055, 0.055),
      shape: 'SPHERE',
      densityKgM3: 1850,
      stoppingPowerFactor: 3.8,
      fractureThresholdJ: 90,
      severThresholdJ: 620,
      vitalityMultiplier: 0.9,
      limbMassKg: 1.8,
      parentZone: 'THIGH_LEFT',
      childZones: ['SHIN_LEFT', 'FOOT_LEFT'],
    },
    {
      id: 'vol_shin_left_flesh',
      label: 'Left Gastrocnemius / Shin Flesh',
      ghoulZone: 'SHIN_LEFT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(-0.12, 0.28, 0),
      halfExtents: vec3(0.06, 0.14, 0.06),
      shape: 'CAPSULE',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 60,
      severThresholdJ: 580,
      vitalityMultiplier: 0.6,
      limbMassKg: 3.5,
      parentZone: 'KNEE_LEFT',
      childZones: ['FOOT_LEFT'],
    },
    {
      id: 'vol_shin_left_bone',
      label: 'Left Tibia / Fibula Bone',
      ghoulZone: 'SHIN_LEFT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(-0.12, 0.28, 0),
      halfExtents: vec3(0.024, 0.13, 0.024),
      shape: 'CAPSULE',
      densityKgM3: 1920,
      stoppingPowerFactor: 4.2,
      fractureThresholdJ: 110,
      severThresholdJ: 580,
      vitalityMultiplier: 0.9,
      limbMassKg: 1.1,
      parentZone: 'KNEE_LEFT',
    },
    {
      id: 'vol_foot_left_flesh',
      label: 'Left Combat Boot & Tarsals',
      ghoulZone: 'FOOT_LEFT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(-0.12, 0.06, 0.06),
      halfExtents: vec3(0.05, 0.055, 0.11),
      shape: 'BOX',
      densityKgM3: 1070,
      stoppingPowerFactor: 0.95,
      fractureThresholdJ: 40,
      severThresholdJ: 450,
      vitalityMultiplier: 0.3,
      limbMassKg: 1.4,
      parentZone: 'SHIN_LEFT',
    },

    // -------------------------------------------------------------------------
    // RIGHT LOWER LIMB
    // -------------------------------------------------------------------------
    {
      id: 'vol_thigh_right_flesh',
      label: 'Right Quadriceps & Femoral Flesh',
      ghoulZone: 'THIGH_RIGHT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0.12, 0.69, 0),
      halfExtents: vec3(0.082, 0.16, 0.082),
      shape: 'CAPSULE',
      densityKgM3: 1060,
      stoppingPowerFactor: 1.05,
      fractureThresholdJ: 80,
      severThresholdJ: 820,
      vitalityMultiplier: 1.1,
      limbMassKg: 8.0,
      parentZone: 'PELVIS_GROIN',
      childZones: ['KNEE_RIGHT', 'SHIN_RIGHT', 'FOOT_RIGHT'],
    },
    {
      id: 'vol_thigh_right_bone',
      label: 'Right Femur Bone',
      ghoulZone: 'THIGH_RIGHT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0.12, 0.69, 0),
      halfExtents: vec3(0.028, 0.14, 0.028),
      shape: 'CAPSULE',
      densityKgM3: 1950,
      stoppingPowerFactor: 4.5,
      fractureThresholdJ: 135,
      severThresholdJ: 820,
      vitalityMultiplier: 1.5,
      limbMassKg: 2.2,
      parentZone: 'PELVIS_GROIN',
    },
    {
      id: 'vol_thigh_right_artery',
      label: 'Right Femoral Artery',
      ghoulZone: 'THIGH_RIGHT',
      layerType: 'ARTERY_CAROTID_AORTA',
      localCenter: vec3(0.09, 0.72, 0.02),
      halfExtents: vec3(0.022, 0.12, 0.022),
      shape: 'CAPSULE',
      densityKgM3: 1040,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 25,
      severThresholdJ: 820,
      vitalityMultiplier: 2.6,
      limbMassKg: 0.2,
      parentZone: 'PELVIS_GROIN',
    },
    {
      id: 'vol_knee_right',
      label: 'Right Knee Patella & Joint',
      ghoulZone: 'KNEE_RIGHT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0.12, 0.50, 0.01),
      halfExtents: vec3(0.055, 0.055, 0.055),
      shape: 'SPHERE',
      densityKgM3: 1850,
      stoppingPowerFactor: 3.8,
      fractureThresholdJ: 90,
      severThresholdJ: 620,
      vitalityMultiplier: 0.9,
      limbMassKg: 1.8,
      parentZone: 'THIGH_RIGHT',
      childZones: ['SHIN_RIGHT', 'FOOT_RIGHT'],
    },
    {
      id: 'vol_shin_right_flesh',
      label: 'Right Gastrocnemius / Shin Flesh',
      ghoulZone: 'SHIN_RIGHT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0.12, 0.28, 0),
      halfExtents: vec3(0.06, 0.14, 0.06),
      shape: 'CAPSULE',
      densityKgM3: 1050,
      stoppingPowerFactor: 1.0,
      fractureThresholdJ: 60,
      severThresholdJ: 580,
      vitalityMultiplier: 0.6,
      limbMassKg: 3.5,
      parentZone: 'KNEE_RIGHT',
      childZones: ['FOOT_RIGHT'],
    },
    {
      id: 'vol_shin_right_bone',
      label: 'Right Tibia / Fibula Bone',
      ghoulZone: 'SHIN_RIGHT',
      layerType: 'CORTICAL_BONE',
      localCenter: vec3(0.12, 0.28, 0),
      halfExtents: vec3(0.024, 0.13, 0.024),
      shape: 'CAPSULE',
      densityKgM3: 1920,
      stoppingPowerFactor: 4.2,
      fractureThresholdJ: 110,
      severThresholdJ: 580,
      vitalityMultiplier: 0.9,
      limbMassKg: 1.1,
      parentZone: 'KNEE_RIGHT',
    },
    {
      id: 'vol_foot_right_flesh',
      label: 'Right Combat Boot & Tarsals',
      ghoulZone: 'FOOT_RIGHT',
      layerType: 'SOFT_FLESH',
      localCenter: vec3(0.12, 0.06, 0.06),
      halfExtents: vec3(0.05, 0.055, 0.11),
      shape: 'BOX',
      densityKgM3: 1070,
      stoppingPowerFactor: 0.95,
      fractureThresholdJ: 40,
      severThresholdJ: 450,
      vitalityMultiplier: 0.3,
      limbMassKg: 1.4,
      parentZone: 'SHIN_RIGHT',
    },
  ];
}

function getRestLocalPosition(id: GhoulZoneId | AuxParticleId): Vec3Like {
  if (id in GHOUL_ZONE_HIERARCHY) {
    return GHOUL_ZONE_HIERARCHY[id as GhoulZoneId].jointLocalPos;
  }
  return AUX_PARTICLE_REST_LOCAL[id as AuxParticleId].localPos;
}

/**
 * Builds the Position-Based Dynamics (PBD) structural + angular range constraints for the 27-point ragdoll.
 */
export function buildRagdollConstraints(): RagdollDistanceConstraint[] {
  const constraints: RagdollDistanceConstraint[] = [];

  const addExactLink = (
    a: GhoulZoneId | AuxParticleId,
    b: GhoulZoneId | AuxParticleId,
    stiffness = 1.0
  ) => {
    const rest = distance(getRestLocalPosition(a), getRestLocalPosition(b));
    constraints.push({
      id: `link_${a}_${b}`,
      nodeA: a,
      nodeB: b,
      restLength: rest,
      minLength: rest,
      maxLength: rest,
      stiffness,
    });
  };

  const addRangeLimit = (
    a: GhoulZoneId | AuxParticleId,
    b: GhoulZoneId | AuxParticleId,
    minScale: number,
    maxScale: number,
    stiffness = 0.55
  ) => {
    const rest = distance(getRestLocalPosition(a), getRestLocalPosition(b));
    constraints.push({
      id: `limit_${a}_${b}`,
      nodeA: a,
      nodeB: b,
      restLength: rest,
      minLength: rest * minScale,
      maxLength: rest * maxScale,
      stiffness,
    });
  };

  // 1. Primary Skeleton Bone Segments (100% rigid length -> limbs NEVER stretch or separate!)
  addExactLink('PELVIS_GROIN', 'TORSO_LOWER_ABDOMEN', 1.0);
  addExactLink('TORSO_LOWER_ABDOMEN', 'TORSO_UPPER_THORAX', 1.0);
  addExactLink('TORSO_UPPER_THORAX', 'NECK_CERVICAL', 1.0);
  addExactLink('NECK_CERVICAL', 'HEAD_CRANIUM', 1.0);
  addExactLink('HEAD_CRANIUM', 'HEAD_TOP', 1.0);
  addExactLink('HEAD_CRANIUM', 'HEAD_FACE_JAW', 1.0);
  addExactLink('NECK_CERVICAL', 'HEAD_FACE_JAW', 0.95);
  addExactLink('HEAD_TOP', 'HEAD_FACE_JAW', 0.95);

  // Thoracic / Clavicle Structural Cage
  addExactLink('TORSO_UPPER_THORAX', 'SHOULDER_LEFT', 1.0);
  addExactLink('TORSO_UPPER_THORAX', 'SHOULDER_RIGHT', 1.0);
  addExactLink('NECK_CERVICAL', 'SHOULDER_LEFT', 1.0);
  addExactLink('NECK_CERVICAL', 'SHOULDER_RIGHT', 1.0);
  addExactLink('SHOULDER_LEFT', 'SHOULDER_RIGHT', 1.0);

  // Pelvic / Hip Structural Cage
  addExactLink('PELVIS_GROIN', 'THIGH_LEFT', 1.0);
  addExactLink('PELVIS_GROIN', 'THIGH_RIGHT', 1.0);
  addExactLink('THIGH_LEFT', 'THIGH_RIGHT', 1.0);

  // Left Arm Chain
  addExactLink('SHOULDER_LEFT', 'UPPER_ARM_LEFT', 1.0);
  addExactLink('UPPER_ARM_LEFT', 'FOREARM_LEFT', 1.0);
  addExactLink('FOREARM_LEFT', 'HAND_LEFT', 1.0);
  addExactLink('HAND_LEFT', 'HAND_TIP_LEFT', 1.0);

  // Right Arm Chain
  addExactLink('SHOULDER_RIGHT', 'UPPER_ARM_RIGHT', 1.0);
  addExactLink('UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 1.0);
  addExactLink('FOREARM_RIGHT', 'HAND_RIGHT', 1.0);
  addExactLink('HAND_RIGHT', 'HAND_TIP_RIGHT', 1.0);

  // Left Leg Chain
  addExactLink('THIGH_LEFT', 'KNEE_LEFT', 1.0);
  addExactLink('KNEE_LEFT', 'SHIN_LEFT', 1.0);
  addExactLink('SHIN_LEFT', 'FOOT_LEFT', 1.0);
  addExactLink('FOOT_LEFT', 'FOOT_TOE_LEFT', 1.0);
  addExactLink('SHIN_LEFT', 'FOOT_TOE_LEFT', 0.85); // keeps boot ankle near 90 deg

  // Right Leg Chain
  addExactLink('THIGH_RIGHT', 'KNEE_RIGHT', 1.0);
  addExactLink('KNEE_RIGHT', 'SHIN_RIGHT', 1.0);
  addExactLink('SHIN_RIGHT', 'FOOT_RIGHT', 1.0);
  addExactLink('FOOT_RIGHT', 'FOOT_TOE_RIGHT', 1.0);
  addExactLink('SHIN_RIGHT', 'FOOT_TOE_RIGHT', 0.85);

  // 2. Anatomical Joint Flexion & Twist Limits (Allows realistic stomach jackknife & limb swing, prevents inside-out folding)
  // Spine & Waist Flexion / Twist
  addRangeLimit('PELVIS_GROIN', 'TORSO_UPPER_THORAX', 0.72, 1.02, 0.65);
  addRangeLimit('TORSO_LOWER_ABDOMEN', 'NECK_CERVICAL', 0.84, 1.02, 0.7);
  addRangeLimit('THIGH_LEFT', 'SHOULDER_LEFT', 0.68, 1.12, 0.5);
  addRangeLimit('THIGH_RIGHT', 'SHOULDER_RIGHT', 0.68, 1.12, 0.5);
  addRangeLimit('THIGH_LEFT', 'SHOULDER_RIGHT', 0.72, 1.15, 0.45);
  addRangeLimit('THIGH_RIGHT', 'SHOULDER_LEFT', 0.72, 1.15, 0.45);

  // Neck Flexion
  addRangeLimit('TORSO_UPPER_THORAX', 'HEAD_CRANIUM', 0.80, 1.04, 0.65);
  addRangeLimit('SHOULDER_LEFT', 'HEAD_CRANIUM', 0.78, 1.22, 0.55);
  addRangeLimit('SHOULDER_RIGHT', 'HEAD_CRANIUM', 0.78, 1.22, 0.55);

  // Knee & Hip Limits
  addRangeLimit('THIGH_LEFT', 'SHIN_LEFT', 0.52, 1.01, 0.5);
  addRangeLimit('THIGH_RIGHT', 'SHIN_RIGHT', 0.52, 1.01, 0.5);
  addRangeLimit('PELVIS_GROIN', 'KNEE_LEFT', 0.68, 1.06, 0.45);
  addRangeLimit('PELVIS_GROIN', 'KNEE_RIGHT', 0.68, 1.06, 0.45);
  addRangeLimit('KNEE_LEFT', 'KNEE_RIGHT', 0.45, 2.6, 0.35);

  // Elbow & Shoulder Limits
  addRangeLimit('UPPER_ARM_LEFT', 'HAND_LEFT', 0.48, 1.38, 0.35);
  addRangeLimit('UPPER_ARM_RIGHT', 'HAND_RIGHT', 0.48, 1.38, 0.35);

  return constraints;
}

function getParticlePos(target: TargetHealthState, id: GhoulZoneId | AuxParticleId): Vec3Like {
  if (id in target.ragdollBones) {
    return target.ragdollBones[id as GhoulZoneId].position;
  }
  return target.auxParticles[id as AuxParticleId].position;
}

function getParticleComp(target: TargetHealthState, id: GhoulZoneId | AuxParticleId): string {
  if (id in target.ragdollBones) {
    return target.ragdollBones[id as GhoulZoneId].componentId;
  }
  return target.auxParticles[id as AuxParticleId].componentId;
}

function safeOrthonormalBasis(
  upDir: Vec3Like,
  forwardHint: Vec3Like,
  fallbackRight: Vec3Like
): { right: Vec3Like; up: Vec3Like; forward: Vec3Like } {
  let up = normalize(upDir);
  if (length(up) < 1e-4) up = vec3(0, 1, 0);

  let right = cross(up, forwardHint);
  if (length(right) < 1e-4) {
    right = cross(up, fallbackRight);
    if (length(right) < 1e-4) {
      right = Math.abs(up.x) < 0.9 ? cross(up, vec3(1, 0, 0)) : cross(up, vec3(0, 0, 1));
    }
  }
  right = normalize(right);
  const forward = normalize(cross(right, up));
  return { right, up, forward };
}

function basisFromRightAndUp(
  rightHint: Vec3Like,
  upDir: Vec3Like,
  fallbackForward: Vec3Like
): { right: Vec3Like; up: Vec3Like; forward: Vec3Like } {
  let up = normalize(upDir);
  if (length(up) < 1e-4) up = vec3(0, 1, 0);

  let forward = cross(rightHint, up);
  if (length(forward) < 1e-4) {
    return safeOrthonormalBasis(up, fallbackForward, vec3(1, 0, 0));
  }
  forward = normalize(forward);
  const right = normalize(cross(up, forward));
  return { right, up, forward };
}

/**
 * Recomputes exact 3D orthonormal bases (Right, Up, Forward) and distal endpoints for all 22 bones
 * directly from the current particle positions so 3D character meshes align with zero joint gaps or gimbal lock.
 */
export function recomputeRagdollBasisVectors(target: TargetHealthState): void {
  const cosY = Math.cos(target.yawRad);
  const sinY = Math.sin(target.yawRad);
  const defaultRight = vec3(cosY, 0, -sinY);
  const defaultForward = vec3(sinY, 0, cosY);

  // 1. Pelvis Basis
  const pelvis = target.ragdollBones.PELVIS_GROIN;
  const abdomen = target.ragdollBones.TORSO_LOWER_ABDOMEN;
  const thighL = target.ragdollBones.THIGH_LEFT;
  const thighR = target.ragdollBones.THIGH_RIGHT;

  const pelvisUp =
    abdomen.componentId === pelvis.componentId
      ? sub(abdomen.position, pelvis.position)
      : pelvis.basisUp;
  const hipRight =
    thighL.componentId === pelvis.componentId && thighR.componentId === pelvis.componentId
      ? sub(thighR.position, thighL.position)
      : pelvis.basisRight;
  const pBasis = basisFromRightAndUp(hipRight, pelvisUp, pelvis.basisForward || defaultForward);
  pelvis.basisRight = pBasis.right;
  pelvis.basisUp = pBasis.up;
  pelvis.basisForward = pBasis.forward;
  pelvis.distalPosition = copyVec3(abdomen.position);

  // 2. Thorax Basis
  const thorax = target.ragdollBones.TORSO_UPPER_THORAX;
  const neck = target.ragdollBones.NECK_CERVICAL;
  const shL = target.ragdollBones.SHOULDER_LEFT;
  const shR = target.ragdollBones.SHOULDER_RIGHT;

  const thoraxUp =
    neck.componentId === thorax.componentId
      ? sub(neck.position, thorax.position)
      : sub(thorax.position, abdomen.position);
  const shRight =
    shL.componentId === thorax.componentId && shR.componentId === thorax.componentId
      ? sub(shR.position, shL.position)
      : pelvis.basisRight;
  const tBasis = basisFromRightAndUp(shRight, thoraxUp, pelvis.basisForward);
  thorax.basisRight = tBasis.right;
  thorax.basisUp = tBasis.up;
  thorax.basisForward = tBasis.forward;
  thorax.distalPosition = copyVec3(neck.position);

  // 3. Abdomen Basis (bridges pelvis & thorax smoothly)
  const abdUp =
    thorax.componentId === abdomen.componentId
      ? sub(thorax.position, abdomen.position)
      : pelvis.basisUp;
  const abdRightHint = add(pelvis.basisRight, thorax.basisRight);
  const aBasis = basisFromRightAndUp(abdRightHint, abdUp, thorax.basisForward);
  abdomen.basisRight = aBasis.right;
  abdomen.basisUp = aBasis.up;
  abdomen.basisForward = aBasis.forward;
  abdomen.distalPosition = copyVec3(thorax.position);

  // 4. Neck, Cranium & Jaw
  const head = target.ragdollBones.HEAD_CRANIUM;
  const jaw = target.ragdollBones.HEAD_FACE_JAW;
  const headTop = target.auxParticles.HEAD_TOP;

  const neckUp =
    head.componentId === neck.componentId ? sub(head.position, neck.position) : thorax.basisUp;
  const nBasis = safeOrthonormalBasis(neckUp, thorax.basisForward, thorax.basisRight);
  neck.basisRight = nBasis.right;
  neck.basisUp = nBasis.up;
  neck.basisForward = nBasis.forward;
  neck.distalPosition = copyVec3(head.position);

  const headUp =
    headTop.componentId === head.componentId
      ? sub(headTop.position, head.position)
      : neck.basisUp;
  const jawFwdHint =
    jaw.componentId === head.componentId
      ? add(scale(normalize(sub(jaw.position, head.position)), 0.65), scale(thorax.basisForward, 0.35))
      : thorax.basisForward;
  const hBasis = safeOrthonormalBasis(headUp, jawFwdHint, thorax.basisRight);
  head.basisRight = hBasis.right;
  head.basisUp = hBasis.up;
  head.basisForward = hBasis.forward;
  head.distalPosition = copyVec3(headTop.position);

  jaw.basisRight = copyVec3(head.basisRight);
  jaw.basisUp = copyVec3(head.basisUp);
  jaw.basisForward = copyVec3(head.basisForward);
  jaw.distalPosition = copyVec3(head.position);

  // 5. Shoulders
  for (const side of ['LEFT', 'RIGHT'] as const) {
    const shZone: GhoulZoneId = side === 'LEFT' ? 'SHOULDER_LEFT' : 'SHOULDER_RIGHT';
    const uaZone: GhoulZoneId = side === 'LEFT' ? 'UPPER_ARM_LEFT' : 'UPPER_ARM_RIGHT';
    const sh = target.ragdollBones[shZone];
    const ua = target.ragdollBones[uaZone];
    sh.basisRight = copyVec3(thorax.basisRight);
    sh.basisUp = copyVec3(thorax.basisUp);
    sh.basisForward = copyVec3(thorax.basisForward);
    sh.distalPosition = copyVec3(ua.position);
  }

  // 6. Upper & Lower Limb Segments (Longitudinal -Y axis aligns from proximal joint -> distal joint!)
  const limbPairs: Array<{
    zone: GhoulZoneId;
    distal: GhoulZoneId | AuxParticleId;
    refZone: GhoulZoneId;
  }> = [
    { zone: 'UPPER_ARM_LEFT', distal: 'FOREARM_LEFT', refZone: 'TORSO_UPPER_THORAX' },
    { zone: 'FOREARM_LEFT', distal: 'HAND_LEFT', refZone: 'UPPER_ARM_LEFT' },
    { zone: 'HAND_LEFT', distal: 'HAND_TIP_LEFT', refZone: 'FOREARM_LEFT' },
    { zone: 'UPPER_ARM_RIGHT', distal: 'FOREARM_RIGHT', refZone: 'TORSO_UPPER_THORAX' },
    { zone: 'FOREARM_RIGHT', distal: 'HAND_RIGHT', refZone: 'UPPER_ARM_RIGHT' },
    { zone: 'HAND_RIGHT', distal: 'HAND_TIP_RIGHT', refZone: 'FOREARM_RIGHT' },
    { zone: 'THIGH_LEFT', distal: 'KNEE_LEFT', refZone: 'PELVIS_GROIN' },
    { zone: 'KNEE_LEFT', distal: 'SHIN_LEFT', refZone: 'THIGH_LEFT' },
    { zone: 'SHIN_LEFT', distal: 'FOOT_LEFT', refZone: 'KNEE_LEFT' },
    { zone: 'THIGH_RIGHT', distal: 'KNEE_RIGHT', refZone: 'PELVIS_GROIN' },
    { zone: 'KNEE_RIGHT', distal: 'SHIN_RIGHT', refZone: 'THIGH_RIGHT' },
    { zone: 'SHIN_RIGHT', distal: 'FOOT_RIGHT', refZone: 'KNEE_RIGHT' },
  ];

  for (const item of limbPairs) {
    const bone = target.ragdollBones[item.zone];
    const refBone = target.ragdollBones[item.refZone];
    const distalComp = getParticleComp(target, item.distal);
    const distalPos = getParticlePos(target, item.distal);

    let segUp: Vec3Like;
    if (distalComp === bone.componentId) {
      // Segment hangs along -Y from bone.position to distalPos, so +Up is (bone.position - distalPos)
      segUp = sub(bone.position, distalPos);
      bone.distalPosition = copyVec3(distalPos);
    } else {
      // Distal child was severed off! Orient along parent's up/rest axis
      segUp = refBone.basisUp;
      const defaultLen = distance(
        getRestLocalPosition(item.zone),
        getRestLocalPosition(item.distal)
      );
      bone.distalPosition = sub(bone.position, scale(normalize(segUp), defaultLen));
    }

    const lBasis = safeOrthonormalBasis(segUp, refBone.basisForward, refBone.basisRight);
    bone.basisRight = lBasis.right;
    bone.basisUp = lBasis.up;
    bone.basisForward = lBasis.forward;
  }

  // 7. Combat Boots (FOOT_LEFT / FOOT_RIGHT): +Forward points from ankle toward toe!
  for (const side of ['LEFT', 'RIGHT'] as const) {
    const footZone: GhoulZoneId = side === 'LEFT' ? 'FOOT_LEFT' : 'FOOT_RIGHT';
    const shinZone: GhoulZoneId = side === 'LEFT' ? 'SHIN_LEFT' : 'SHIN_RIGHT';
    const toeId: AuxParticleId = side === 'LEFT' ? 'FOOT_TOE_LEFT' : 'FOOT_TOE_RIGHT';

    const foot = target.ragdollBones[footZone];
    const shin = target.ragdollBones[shinZone];
    const toe = target.auxParticles[toeId];

    let fwd = sub(toe.position, foot.position);
    if (length(fwd) < 1e-4) fwd = shin.basisForward;
    fwd = normalize(fwd);

    let upHint = shin.componentId === foot.componentId ? shin.basisUp : vec3(0, 1, 0);
    let right = cross(upHint, fwd);
    if (length(right) < 1e-4) right = shin.basisRight;
    right = normalize(right);
    const up = normalize(cross(fwd, right));

    foot.basisRight = right;
    foot.basisUp = up;
    foot.basisForward = fwd;
    foot.distalPosition = copyVec3(toe.position);
  }
}

/**
 * Updates the standing / injured procedural combat pose for a living, non-ragdolled combatant
 * (breathing, scanning, SoF throat-clutch / gut-hurt / arm-disarm / knee-buckle reactions).
 */
export function updateStandingCombatPose(target: TargetHealthState, elapsedTimeS: number): void {
  if (target.isRagdollActive || !target.alive) return;

  const cosY = Math.cos(target.yawRad);
  const sinY = Math.sin(target.yawRad);
  const toWorld = (lx: number, ly: number, lz: number): Vec3Like => ({
    x: target.worldPosition.x + (lx * cosY + lz * sinY),
    y: target.worldPosition.y + ly,
    z: target.worldPosition.z + (-lx * sinY + lz * cosY),
  });

  // Subtle combat breathing & idle weight shift
  const breath = Math.sin(elapsedTimeS * 2.6) * 0.008;
  const swayX = Math.cos(elapsedTimeS * 1.35) * 0.007;

  // Pain reaction offsets in target-local space
  const rx = target.activeReaction;
  const rxWeight =
    rx.type !== 'NONE' && rx.durationS > 0
      ? Math.sin(Math.min(1, rx.timerS / rx.durationS) * Math.PI) * rx.intensity
      : 0;

  // Leg injured crouch / buckle drop
  const kneeBuckleDrop = !target.leftLegFunctional || !target.rightLegFunctional ? 0.28 : 0;
  const gutFoldZ = rx.type === 'GUT_FOLD' ? 0.14 * rxWeight : 0;
  const gutFoldY = rx.type === 'GUT_FOLD' ? -0.09 * rxWeight : 0;
  const chestBackZ = rx.type === 'CHEST_STAGGER' ? -0.11 * rxWeight : 0;
  const headSnapZ = rx.type === 'HEAD_SNAP' ? -0.10 * rxWeight : 0;

  for (const zone of ALL_GHOUL_ZONES) {
    const bone = target.ragdollBones[zone];
    if (bone.severed) continue; // Severed limbs are simulated by PBD physics!

    const base = GHOUL_ZONE_HIERARCHY[zone].jointLocalPos;
    let lx = base.x;
    let ly = base.y;
    let lz = base.z;

    // Apply knee-buckle crouch to pelvis & upper body
    if (
      zone !== 'SHIN_LEFT' &&
      zone !== 'FOOT_LEFT' &&
      zone !== 'SHIN_RIGHT' &&
      zone !== 'FOOT_RIGHT'
    ) {
      ly -= kneeBuckleDrop;
    }

    if (zone === 'KNEE_LEFT' && !target.leftLegFunctional) {
      ly = 0.22;
      lz = 0.16;
    }
    if (zone === 'KNEE_RIGHT' && !target.rightLegFunctional) {
      ly = 0.22;
      lz = 0.16;
    }

    // Upper body breathing & flinch
    if (
      zone === 'TORSO_UPPER_THORAX' ||
      zone === 'NECK_CERVICAL' ||
      zone === 'HEAD_CRANIUM' ||
      zone === 'HEAD_FACE_JAW' ||
      zone === 'SHOULDER_LEFT' ||
      zone === 'SHOULDER_RIGHT'
    ) {
      ly += breath + gutFoldY;
      lx += swayX;
      lz += gutFoldZ + chestBackZ;
    }

    if (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW') {
      lz += headSnapZ;
    }

    // Shoulder wrench flinch
    if (rx.type === 'ARM_WRENCH_LEFT' && (zone === 'SHOULDER_LEFT' || zone === 'UPPER_ARM_LEFT')) {
      lz -= 0.10 * rxWeight;
    }
    if (rx.type === 'ARM_WRENCH_RIGHT' && (zone === 'SHOULDER_RIGHT' || zone === 'UPPER_ARM_RIGHT')) {
      lz -= 0.10 * rxWeight;
    }

    // Disarmed / crippled arm dangles at side instead of aiming weapon
    if ((!target.rightArmFunctional || target.weaponDropped) && zone === 'HAND_RIGHT') {
      lx = 0.33;
      ly = 0.88 - kneeBuckleDrop;
      lz = 0.04;
    }
    if ((!target.leftArmFunctional || target.weaponDropped) && zone === 'HAND_LEFT') {
      lx = -0.33;
      ly = 0.88 - kneeBuckleDrop;
      lz = 0.04;
    }

    // Classic Soldier of Fortune THROAT_CLUTCH agony pose: hand reaches up to bleeding neck!
    if (target.posture === 'THROAT_CLUTCH' || rx.type === 'THROAT_CLUTCH') {
      if (zone === 'HAND_LEFT' && target.leftArmFunctional) {
        lx = -0.04;
        ly = 1.50 - kneeBuckleDrop;
        lz = 0.10;
      }
      if (zone === 'FOREARM_LEFT' && target.leftArmFunctional) {
        lx = -0.22;
        ly = 1.28 - kneeBuckleDrop;
        lz = 0.14;
      }
    }

    // Classic GUT_HURT clutch pose
    if (target.posture === 'GUT_HURT' || rx.type === 'GUT_FOLD') {
      if (zone === 'HAND_LEFT' && target.leftArmFunctional) {
        lx = -0.04;
        ly = 1.08 - kneeBuckleDrop;
        lz = 0.16;
      }
    }

    const wp = toWorld(lx, ly, lz);
    bone.position = wp;
    bone.prevPosition = copyVec3(wp);
  }

  // Update auxiliary tip particles for non-severed parent bones
  for (const auxId of ALL_AUX_PARTICLES) {
    const aux = target.auxParticles[auxId];
    const parentBone = target.ragdollBones[aux.parentZone];
    if (parentBone.severed) continue;

    const restParent = GHOUL_ZONE_HIERARCHY[aux.parentZone].jointLocalPos;
    const restAux = AUX_PARTICLE_REST_LOCAL[auxId].localPos;
    const dLocal = sub(restAux, restParent);
    const dWorld = {
      x: dLocal.x * cosY + dLocal.z * sinY,
      y: dLocal.y,
      z: -dLocal.x * sinY + dLocal.z * cosY,
    };
    aux.position = add(parentBone.position, dWorld);
    aux.prevPosition = copyVec3(aux.position);
  }

  recomputeRagdollBasisVectors(target);
}

/**
 * Creates an initialized TargetHealthState with full integrity, PBD ragdoll particles, and archetype gear.
 */
export function createTargetHealthState(
  targetId: string,
  name: string,
  worldPosition: Vec3Like,
  yawRad = 0,
  archetype: EnemyArchetypeId = 'MILITIA_GUNNER'
): TargetHealthState {
  const zoneIntegrity: Record<GhoulZoneId, number> = {} as Record<GhoulZoneId, number>;
  const zoneCumulativeDamageJ: Record<GhoulZoneId, number> = {} as Record<GhoulZoneId, number>;
  const zoneGoreMode: Record<GhoulZoneId, GoreMode> = {} as Record<GhoulZoneId, GoreMode>;
  const ragdollBones: Record<GhoulZoneId, RagdollBoneState> = {} as Record<GhoulZoneId, RagdollBoneState>;
  const auxParticles: Record<AuxParticleId, AuxRagdollParticle> = {} as Record<AuxParticleId, AuxRagdollParticle>;

  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  const defaultRight = vec3(cosY, 0, -sinY);
  const defaultForward = vec3(sinY, 0, cosY);

  for (const zone of ALL_GHOUL_ZONES) {
    zoneIntegrity[zone] = 100.0;
    zoneCumulativeDamageJ[zone] = 0.0;
    zoneGoreMode[zone] = 'INTACT';

    const node = GHOUL_ZONE_HIERARCHY[zone];
    const lx = node.jointLocalPos.x;
    const lz = node.jointLocalPos.z;
    const wx = worldPosition.x + (lx * cosY + lz * sinY);
    const wy = worldPosition.y + node.jointLocalPos.y;
    const wz = worldPosition.z + (-lx * sinY + lz * cosY);
    const pos = vec3(wx, wy, wz);

    ragdollBones[zone] = {
      zone,
      position: pos,
      prevPosition: copyVec3(pos),
      velocity: vec3(0, 0, 0),
      angularVelocity: vec3(0, 0, 0),
      rotationEuler: vec3(0, yawRad, 0),
      basisRight: copyVec3(defaultRight),
      basisUp: vec3(0, 1, 0),
      basisForward: copyVec3(defaultForward),
      distalPosition: copyVec3(pos),
      massKg: node.defaultMassKg,
      radiusM: node.collisionRadiusM,
      componentId: 'BODY',
      severed: false,
      goreMode: 'INTACT',
      grounded: false,
    };
  }

  for (const auxId of ALL_AUX_PARTICLES) {
    const spec = AUX_PARTICLE_REST_LOCAL[auxId];
    const lx = spec.localPos.x;
    const lz = spec.localPos.z;
    const wx = worldPosition.x + (lx * cosY + lz * sinY);
    const wy = worldPosition.y + spec.localPos.y;
    const wz = worldPosition.z + (-lx * sinY + lz * cosY);
    const pos = vec3(wx, wy, wz);

    auxParticles[auxId] = {
      id: auxId,
      parentZone: spec.parentZone,
      position: pos,
      prevPosition: copyVec3(pos),
      velocity: vec3(0, 0, 0),
      massKg: spec.massKg,
      radiusM: spec.radiusM,
      componentId: 'BODY',
    };
  }

  const hasChestArmor = archetype === 'HEAVY_ENFORCER';
  const hasHelmetArmor = archetype === 'HEAVY_ENFORCER';

  const state: TargetHealthState = {
    targetId,
    name,
    archetype,
    worldPosition: copyVec3(worldPosition),
    yawRad,
    maxHp: archetype === 'HEAVY_ENFORCER' ? 125.0 : 100.0,
    currentHp: archetype === 'HEAVY_ENFORCER' ? 125.0 : 100.0,
    bleedRateHpPerSec: 0,
    bloodVolumeMl: 5000,
    bloodLossRateMlPerSec: 0,
    systolicBpMmHg: 120,
    heartRateBpm: 78,
    oxygenSaturationPct: 99,
    consciousness: 1.0,
    painShock: 0.0,
    posture: 'COMBAT_READY',
    leftLegFunctional: true,
    rightLegFunctional: true,
    leftArmFunctional: true,
    rightArmFunctional: true,
    headgearIntact: true,
    weaponDropped: false,
    hasChestArmor,
    chestArmorIntegrity: hasChestArmor ? 100.0 : 0.0,
    hasHelmetArmor,
    helmetArmorIntegrity: hasHelmetArmor ? 100.0 : 0.0,
    activeReaction: {
      type: 'NONE',
      timerS: 0,
      durationS: 0,
      intensity: 0,
      hitDirectionWorld: vec3(0, 0, -1),
    },
    alive: true,
    isRagdollActive: false,
    ragdollRootPosition: copyVec3(worldPosition),
    ragdollRootVelocity: vec3(0, 0, 0),
    ragdollAngularVelocity: vec3(0, 0, 0),
    ragdollBones,
    auxParticles,
    ragdollConstraints: buildRagdollConstraints(),
    zoneIntegrity,
    zoneCumulativeDamageJ,
    zoneGoreMode,
    severedZones: new Set<GhoulZoneId>(),
    fracturedBones: new Set<string>(),
    rupturedOrgans: new Set<string>(),
    surfaceWounds: [],
  };

  recomputeRagdollBasisVectors(state);
  return state;
}
