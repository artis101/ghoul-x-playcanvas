import { AnatomicalColliderVolume } from '../../../contracts/ballistics.ts';
import { HEAD_NECK_COLLIDERS } from './headNeckColliders';
import { TORSO_PELVIS_COLLIDERS } from './torsoPelvisColliders';
import { ARM_COLLIDERS } from './armColliders';
import { LEG_COLLIDERS } from './legColliders';

/**
 * Builds the complete set of anatomical volume colliders covering all 22 GHOUL hitzones.
 */
export function buildAnatomicalColliders(): AnatomicalColliderVolume[] {
  return [
    ...HEAD_NECK_COLLIDERS,
    ...TORSO_PELVIS_COLLIDERS,
    ...ARM_COLLIDERS,
    ...LEG_COLLIDERS,
  ];
}
