import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';

export const SLOT_MODE_STATIC = 0;
export const SLOT_MODE_RAPIER = 1;
export const SLOT_MODE_KINEMATIC = 2;

export const KINEMATIC_FLOOR_Y = 0.015;
export const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };
export const UNIT_SCALE: Readonly<Vec3Like> = { x: 1, y: 1, z: 1 };
