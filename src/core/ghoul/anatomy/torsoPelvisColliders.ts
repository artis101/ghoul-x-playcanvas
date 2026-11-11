import { AnatomicalColliderVolume } from '../../../contracts/ballistics.ts';
import { THORAX_COLLIDERS } from './thoraxColliders.ts';
import { ABDOMEN_PELVIS_COLLIDERS } from './abdomenPelvisColliders.ts';

export const TORSO_PELVIS_COLLIDERS: AnatomicalColliderVolume[] = [
  ...THORAX_COLLIDERS,
  ...ABDOMEN_PELVIS_COLLIDERS,
];
