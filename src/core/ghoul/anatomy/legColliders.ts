import { AnatomicalColliderVolume } from '../../../contracts/ballistics.ts';
import { RIGHT_LEG_COLLIDERS } from './rightLegColliders';
import { LEFT_LEG_COLLIDERS } from './leftLegColliders';

export const LEG_COLLIDERS: AnatomicalColliderVolume[] = [
  ...RIGHT_LEG_COLLIDERS,
  ...LEFT_LEG_COLLIDERS,
];
