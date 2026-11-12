import { vec3 } from '../../ballistics/vec3.ts';
import { GhoulZoneNode } from './ghoulHierarchyTypes.ts';

export const GHOUL_LIMB_HIERARCHY: Record<
  | 'SHOULDER_RIGHT'
  | 'UPPER_ARM_RIGHT'
  | 'FOREARM_RIGHT'
  | 'HAND_RIGHT'
  | 'SHOULDER_LEFT'
  | 'UPPER_ARM_LEFT'
  | 'FOREARM_LEFT'
  | 'HAND_LEFT'
  | 'THIGH_RIGHT'
  | 'KNEE_RIGHT'
  | 'SHIN_RIGHT'
  | 'FOOT_RIGHT'
  | 'THIGH_LEFT'
  | 'KNEE_LEFT'
  | 'SHIN_LEFT'
  | 'FOOT_LEFT',
  GhoulZoneNode
> = {
  SHOULDER_RIGHT: {
    parent: 'TORSO_UPPER_THORAX',
    children: ['UPPER_ARM_RIGHT'],
    distalTarget: 'UPPER_ARM_RIGHT',
    jointLocalPos: vec3(-0.22, 1.48, 0),
    defaultMassKg: 2.8,
    collisionRadiusM: 0.075,
    label: 'Right Clavicle / Shoulder',
  },
  UPPER_ARM_RIGHT: {
    parent: 'SHOULDER_RIGHT',
    children: ['FOREARM_RIGHT'],
    distalTarget: 'FOREARM_RIGHT',
    jointLocalPos: vec3(-0.28, 1.38, 0),
    defaultMassKg: 3.2,
    collisionRadiusM: 0.06,
    label: 'Right Upper Arm / Bicep',
  },
  FOREARM_RIGHT: {
    parent: 'UPPER_ARM_RIGHT',
    children: ['HAND_RIGHT'],
    distalTarget: 'HAND_RIGHT',
    jointLocalPos: vec3(-0.31, 1.13, 0.03),
    defaultMassKg: 2.0,
    collisionRadiusM: 0.05,
    label: 'Right Forearm',
  },
  HAND_RIGHT: {
    parent: 'FOREARM_RIGHT',
    children: [],
    distalTarget: 'HAND_TIP_RIGHT',
    jointLocalPos: vec3(-0.14, 1.15, 0.24),
    defaultMassKg: 0.9,
    collisionRadiusM: 0.045,
    label: 'Right Hand',
  },
  SHOULDER_LEFT: {
    parent: 'TORSO_UPPER_THORAX',
    children: ['UPPER_ARM_LEFT'],
    distalTarget: 'UPPER_ARM_LEFT',
    jointLocalPos: vec3(0.22, 1.48, 0),
    defaultMassKg: 2.8,
    collisionRadiusM: 0.075,
    label: 'Left Clavicle / Shoulder',
  },
  UPPER_ARM_LEFT: {
    parent: 'SHOULDER_LEFT',
    children: ['FOREARM_LEFT'],
    distalTarget: 'FOREARM_LEFT',
    jointLocalPos: vec3(0.28, 1.38, 0),
    defaultMassKg: 3.2,
    collisionRadiusM: 0.06,
    label: 'Left Upper Arm / Bicep',
  },
  FOREARM_LEFT: {
    parent: 'UPPER_ARM_LEFT',
    children: ['HAND_LEFT'],
    distalTarget: 'HAND_LEFT',
    jointLocalPos: vec3(0.30, 1.13, 0.03),
    defaultMassKg: 2.0,
    collisionRadiusM: 0.05,
    label: 'Left Forearm',
  },
  HAND_LEFT: {
    parent: 'FOREARM_LEFT',
    children: [],
    distalTarget: 'HAND_TIP_LEFT',
    jointLocalPos: vec3(0.14, 1.16, 0.20),
    defaultMassKg: 0.9,
    collisionRadiusM: 0.045,
    label: 'Left Hand',
  },
  THIGH_RIGHT: {
    parent: 'PELVIS_GROIN',
    children: ['KNEE_RIGHT'],
    distalTarget: 'KNEE_RIGHT',
    jointLocalPos: vec3(-0.115, 0.86, 0),
    defaultMassKg: 8.0,
    collisionRadiusM: 0.08,
    label: 'Right Thigh / Femur',
  },
  KNEE_RIGHT: {
    parent: 'THIGH_RIGHT',
    children: ['SHIN_RIGHT'],
    distalTarget: 'SHIN_RIGHT',
    jointLocalPos: vec3(-0.12, 0.50, 0.01),
    defaultMassKg: 2.2,
    collisionRadiusM: 0.06,
    label: 'Right Knee / Patella',
  },
  SHIN_RIGHT: {
    parent: 'KNEE_RIGHT',
    children: ['FOOT_RIGHT'],
    distalTarget: 'FOOT_RIGHT',
    jointLocalPos: vec3(-0.12, 0.2825, 0.01),
    defaultMassKg: 3.5,
    collisionRadiusM: 0.055,
    label: 'Right Shin / Calf',
  },
  FOOT_RIGHT: {
    parent: 'SHIN_RIGHT',
    children: [],
    distalTarget: 'FOOT_TOE_RIGHT',
    jointLocalPos: vec3(-0.12, 0.065, 0.01),
    defaultMassKg: 1.5,
    collisionRadiusM: 0.06,
    label: 'Right Combat Boot',
  },
  THIGH_LEFT: {
    parent: 'PELVIS_GROIN',
    children: ['KNEE_LEFT'],
    distalTarget: 'KNEE_LEFT',
    jointLocalPos: vec3(0.115, 0.86, 0),
    defaultMassKg: 8.0,
    collisionRadiusM: 0.08,
    label: 'Left Thigh / Femur',
  },
  KNEE_LEFT: {
    parent: 'THIGH_LEFT',
    children: ['SHIN_LEFT'],
    distalTarget: 'SHIN_LEFT',
    jointLocalPos: vec3(0.12, 0.50, 0.01),
    defaultMassKg: 2.2,
    collisionRadiusM: 0.06,
    label: 'Left Knee / Patella',
  },
  SHIN_LEFT: {
    parent: 'KNEE_LEFT',
    children: ['FOOT_LEFT'],
    distalTarget: 'FOOT_LEFT',
    jointLocalPos: vec3(0.12, 0.2825, 0.01),
    defaultMassKg: 3.5,
    collisionRadiusM: 0.055,
    label: 'Left Shin / Calf',
  },
  FOOT_LEFT: {
    parent: 'SHIN_LEFT',
    children: [],
    distalTarget: 'FOOT_TOE_LEFT',
    jointLocalPos: vec3(0.12, 0.065, 0.01),
    defaultMassKg: 1.5,
    collisionRadiusM: 0.06,
    label: 'Left Combat Boot',
  },
};
