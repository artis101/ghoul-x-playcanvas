import type { WeaponAdsProfile } from '../../../contracts/ballistics.ts';

/** Ghost-ring aperture lined up with the tritium front blade. */
const ADS_M590: WeaponAdsProfile = {
  sightKind: 'IRON',
  rearSightLocal: { x: 0, y: 0.058, z: 0.005 },
  frontSightLocal: { x: 0, y: 0.0585, z: -0.608 },
  eyeReliefM: 0.15,
  zoom: 1.2,
  aimInTimeS: 0.27,
  aimOutTimeS: 0.22,
  moveSpeedScale: 0.72,
  hipSpreadRad: 0.004,
  hipMoveSpreadRad: 0.006,
  adsRecoilScale: 0.75,
};

/** Rear notch shoulders level with the top of the front blade, held at arm's length. */
const ADS_SILVER_TALON: WeaponAdsProfile = {
  sightKind: 'IRON',
  rearSightLocal: { x: 0, y: 0.0592, z: 0.046 },
  frontSightLocal: { x: 0, y: 0.0625, z: -0.272 },
  eyeReliefM: 0.36,
  zoom: 1.25,
  aimInTimeS: 0.17,
  aimOutTimeS: 0.15,
  moveSpeedScale: 0.86,
  hipSpreadRad: 0.012,
  hipMoveSpreadRad: 0.01,
  adsRecoilScale: 0.7,
};

/** Scope axis from the ocular lens to the objective lens. */
const ADS_MSG90: WeaponAdsProfile = {
  sightKind: 'SCOPE',
  rearSightLocal: { x: 0, y: 0.078, z: 0.088 },
  frontSightLocal: { x: 0, y: 0.078, z: -0.268 },
  eyeReliefM: 0.075,
  zoom: 4.0,
  aimInTimeS: 0.36,
  aimOutTimeS: 0.26,
  moveSpeedScale: 0.5,
  hipSpreadRad: 0.04,
  hipMoveSpreadRad: 0.03,
  adsRecoilScale: 0.6,
};

/** Holographic reticle sitting on the tip of the front sight post (co-witness). */
const ADS_M4A1: WeaponAdsProfile = {
  sightKind: 'HOLO',
  rearSightLocal: { x: 0, y: 0.067, z: -0.0495 },
  frontSightLocal: { x: 0, y: 0.0752, z: -0.422 },
  eyeReliefM: 0.19,
  zoom: 1.35,
  aimInTimeS: 0.22,
  aimOutTimeS: 0.18,
  moveSpeedScale: 0.78,
  hipSpreadRad: 0.016,
  hipMoveSpreadRad: 0.012,
  adsRecoilScale: 0.62,
};

export const WEAPON_ADS_PROFILES: Readonly<Record<string, WeaponAdsProfile>> = {
  m590_shotgun: ADS_M590,
  silver_talon_50ae: ADS_SILVER_TALON,
  msg90_sniper: ADS_MSG90,
  m4a1_carbine: ADS_M4A1,
};

export function getWeaponAdsProfile(weaponId: string): WeaponAdsProfile {
  return WEAPON_ADS_PROFILES[weaponId] ?? ADS_M4A1;
}
