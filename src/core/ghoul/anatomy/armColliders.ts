import { AnatomicalColliderVolume } from '../../../contracts/ballistics.ts';
import { RIGHT_ARM_COLLIDERS } from './rightArmColliders.ts';
import { LEFT_ARM_COLLIDERS } from './leftArmColliders.ts';

export const ARM_COLLIDERS: AnatomicalColliderVolume[] = [
  ...RIGHT_ARM_COLLIDERS,
  ...LEFT_ARM_COLLIDERS,
];
