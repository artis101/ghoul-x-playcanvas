import type { Vec3Like } from './ballisticsTypes.ts';

/** IRON: notch/ring and front blade. HOLO: collimated reticle window. SCOPE: magnified tube with a full-screen optic. */
export type WeaponSightKind = 'IRON' | 'HOLO' | 'SCOPE';

/**
 * How one weapon is brought up to the eye. Sight points are in the weapon model's own space
 * (+Y up, -Z toward the muzzle), measured from the sculpted GLB.
 */
export interface WeaponAdsProfile {
  sightKind: WeaponSightKind;
  /** The point the eye looks through: rear notch, ghost ring, holo reticle or scope ocular. */
  rearSightLocal: Vec3Like;
  /** The point the rear sight is lined up with: front blade tip, post tip or objective lens. */
  frontSightLocal: Vec3Like;
  /** Distance from the eye to the rear sight point when fully aimed. */
  eyeReliefM: number;
  /** Magnification when fully aimed (hip field of view divided by this). */
  zoom: number;
  aimInTimeS: number;
  aimOutTimeS: number;
  /** Walking speed while aimed, as a fraction of hip speed. */
  moveSpeedScale: number;
  /** Half-angle of the aim-error cone when standing still and firing from the hip. */
  hipSpreadRad: number;
  /** Extra hip cone half-angle at full walking speed. */
  hipMoveSpreadRad: number;
  /** Fraction of the camera recoil kick that remains when aimed. */
  adsRecoilScale: number;
}
