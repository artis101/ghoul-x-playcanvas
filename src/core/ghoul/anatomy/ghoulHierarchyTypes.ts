import { AuxParticleId, GhoulZoneId, Vec3Like } from '../../../contracts/ballistics.ts';

export const ALL_GHOUL_ZONES: GhoulZoneId[] = [
  'HEAD_CRANIUM',
  'HEAD_FACE_JAW',
  'NECK_CERVICAL',
  'TORSO_UPPER_THORAX',
  'TORSO_LOWER_ABDOMEN',
  'PELVIS_GROIN',
  'SHOULDER_RIGHT',
  'UPPER_ARM_RIGHT',
  'FOREARM_RIGHT',
  'HAND_RIGHT',
  'SHOULDER_LEFT',
  'UPPER_ARM_LEFT',
  'FOREARM_LEFT',
  'HAND_LEFT',
  'THIGH_RIGHT',
  'KNEE_RIGHT',
  'SHIN_RIGHT',
  'FOOT_RIGHT',
  'THIGH_LEFT',
  'KNEE_LEFT',
  'SHIN_LEFT',
  'FOOT_LEFT',
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
