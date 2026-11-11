import { AuxParticleId, GhoulZoneId, Vec3Like } from '../../../contracts/ballistics.ts';
import { vec3 } from '../../ballistics/vec3.ts';

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
