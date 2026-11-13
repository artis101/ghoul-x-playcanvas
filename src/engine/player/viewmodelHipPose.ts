import * as pc from 'playcanvas';
import type { WeaponRole } from '../../contracts/ballistics.ts';

/**
 * Where the weapon rests in camera space when fired from the hip. Long guns sit close and low
 * on the right so the stock leaves the bottom of the screen and the barrel runs toward the
 * crosshair; the pistol is pushed out at arm's length in a two-handed hold.
 */
const LONG_GUN_HIP_POS = new pc.Vec3(0.14, -0.15, -0.26);
const HIP_POS_BY_ROLE: Partial<Record<WeaponRole, pc.Vec3>> = {
  HEAVY_PISTOL: new pc.Vec3(0.12, -0.15, -0.44),
  SNIPER: new pc.Vec3(0.15, -0.17, -0.3),
};

export const HIP_VM_ROT = new pc.Quat().setFromEulerAngles(0, 0, -1.75);

export function hipViewmodelPosition(role: WeaponRole): pc.Vec3 {
  return HIP_POS_BY_ROLE[role] ?? LONG_GUN_HIP_POS;
}
