import { GhoulZoneId } from '../../../contracts/ballistics.ts';
import { vec3 } from '../../ballistics/vec3.ts';
import { GhoulZoneNode } from './ghoulHierarchyTypes.ts';

export const GHOUL_HEAD_TORSO_HIERARCHY: Record<
  | 'PELVIS_GROIN'
  | 'TORSO_LOWER_ABDOMEN'
  | 'TORSO_UPPER_THORAX'
  | 'NECK_CERVICAL'
  | 'HEAD_CRANIUM'
  | 'HEAD_FACE_JAW',
  GhoulZoneNode
> = {
  PELVIS_GROIN: {
    children: ['TORSO_LOWER_ABDOMEN', 'THIGH_RIGHT', 'THIGH_LEFT'],
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
    children: ['NECK_CERVICAL', 'SHOULDER_RIGHT', 'SHOULDER_LEFT'],
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
};
