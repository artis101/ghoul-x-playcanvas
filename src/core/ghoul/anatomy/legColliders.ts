import { AnatomicalColliderVolume } from '../../../contracts/ballistics.ts';
import { LEFT_LEG_COLLIDERS } from './leftLegColliders';
import { RIGHT_LEG_COLLIDERS } from './rightLegColliders';

export const LEG_COLLIDERS: AnatomicalColliderVolume[] = [
  ...LEFT_LEG_COLLIDERS,
  ...RIGHT_LEG_COLLIDERS,
];
