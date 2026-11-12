import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';

export enum SlotLifecyclePhase {
  FREE = 0,
  STATIC = 1,
  RAPIER_AWAKE = 2,
  RAPIER_SLEEPING_SYNCED = 3,
  RAPIER_SHRINKING = 4,
  KINEMATIC_ACTIVE = 5,
  KINEMATIC_RESTING = 6,
  KINEMATIC_SHRINKING = 7,
}

export type OnInstanceSlotExpired = (slotId: number, bodyHandle: number) => void;

export const SLOT_MODE_STATIC = SlotLifecyclePhase.STATIC;
export const SLOT_MODE_RAPIER = SlotLifecyclePhase.RAPIER_AWAKE;
export const SLOT_MODE_KINEMATIC = SlotLifecyclePhase.KINEMATIC_ACTIVE;

export const KINEMATIC_FLOOR_Y = 0.015;
export const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };
export const UNIT_SCALE: Readonly<Vec3Like> = { x: 1, y: 1, z: 1 };
