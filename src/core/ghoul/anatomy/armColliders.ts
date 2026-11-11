import { AnatomicalColliderVolume } from '../../../contracts/ballistics.ts';
import { LEFT_ARM_COLLIDERS } from './leftArmColliders.ts';
import { RIGHT_ARM_COLLIDERS } from './rightArmColliders.ts';

export const ARM_COLLIDERS: AnatomicalColliderVolume[] = [
  ...LEFT_ARM_COLLIDERS,
  ...RIGHT_ARM_COLLIDERS,
];
