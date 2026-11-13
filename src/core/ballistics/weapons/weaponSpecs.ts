import { EnvironmentState, WeaponSpec } from '../../../contracts/ballistics.ts';
import {
  AMMO_12G_00_BUCK,
  AMMO_50BMG_M33_BALL,
  AMMO_50BMG_M903_SLAP,
  AMMO_12G_FLECHETTE_SLUG,
  AMMO_50AE_FMJ_SOLID,
  AMMO_50AE_JHP,
  AMMO_556_NATO_M855,
  AMMO_556_NATO_SOST_JHP,
} from './ammoTypes.ts';

export const WEAPON_M590: WeaponSpec = {
  id: 'm590_shotgun',
  name: 'Mossberg 590 Tactical 12-Gauge',
  codeName: 'BERSERKER 12G',
  role: 'SHOTGUN',
  description:
    'Military 12-gauge pump-action shotgun. Brutal inside 5m with 00 Buckshot stopping power, or load Sabot Slugs to punch armor at medium range.',
  defaultAmmo: AMMO_12G_00_BUCK,
  availableAmmo: [AMMO_12G_00_BUCK, AMMO_12G_FLECHETTE_SLUG],
  fireRateRpm: 75,
  recoilKickDeg: 8.5,
  scopeZoomLevels: [1.0],
  zeroDistanceM: 25,
};

export const WEAPON_SILVER_TALON: WeaponSpec = {
  id: 'silver_talon_50ae',
  name: 'Silver Talon .50 Action Express Hand Cannon',
  codeName: 'SILVER TALON .50',
  role: 'HEAVY_PISTOL',
  description:
    'Gas-operated .50 AE hand cannon. Toggle between massive-expansion 300gr JHP stopping rounds and armor-punching Hard-Cast FMJ.',
  defaultAmmo: AMMO_50AE_JHP,
  availableAmmo: [AMMO_50AE_JHP, AMMO_50AE_FMJ_SOLID],
  fireRateRpm: 180,
  recoilKickDeg: 6.2,
  scopeZoomLevels: [1.0, 1.5],
  zeroDistanceM: 50,
};

export const WEAPON_MSG90: WeaponSpec = {
  id: 'msg90_sniper',
  name: 'MSG90-H .50 BMG Bolt-Action Heavy Rifle',
  codeName: 'MSG90-H .50 BMG',
  role: 'SNIPER',
  description:
    'Bolt-action 12.7x99mm anti-materiel rifle. M33 Ball tears limbs off and kills through plates; M903 SLAP tungsten goes through armour and several bodies in a row. Slow to cycle, five rounds a magazine.',
  defaultAmmo: AMMO_50BMG_M33_BALL,
  availableAmmo: [AMMO_50BMG_M33_BALL, AMMO_50BMG_M903_SLAP],
  // Bolt cycle: one round every two seconds.
  fireRateRpm: 30,
  recoilKickDeg: 9.0,
  scopeZoomLevels: [4.0, 8.0, 16.0],
  zeroDistanceM: 100,
};

export const WEAPON_M4A1: WeaponSpec = {
  id: 'm4a1_carbine',
  name: 'M4A1 5.56x45mm Tactical Carbine',
  codeName: 'M4A1 CARBINE',
  role: 'ASSAULT_RIFLE',
  description:
    'Selective-fire 5.56mm carbine. Toggle between armor-piercing M855 Green Tip penetrators and high-stopping-power 77gr Tactical JHP.',
  defaultAmmo: AMMO_556_NATO_M855,
  availableAmmo: [AMMO_556_NATO_M855, AMMO_556_NATO_SOST_JHP],
  fireRateRpm: 750,
  recoilKickDeg: 2.1,
  scopeZoomLevels: [1.0, 2.0],
  zeroDistanceM: 100,
};

export const WEAPONS: WeaponSpec[] = [
  WEAPON_M590,
  WEAPON_SILVER_TALON,
  WEAPON_MSG90,
  WEAPON_M4A1,
];

export const WEAPON_MAP: Record<string, WeaponSpec> = {
  [WEAPON_M590.id]: WEAPON_M590,
  [WEAPON_SILVER_TALON.id]: WEAPON_SILVER_TALON,
  [WEAPON_MSG90.id]: WEAPON_MSG90,
  [WEAPON_M4A1.id]: WEAPON_M4A1,
};

export const DEFAULT_ENVIRONMENT: EnvironmentState = {
  gravity: { x: 0, y: -9.81, z: 0 },
  airDensityKgM3: 1.225, // ISA sea level 15 deg C
  speedOfSoundMs: 343.0,
  windVelocity: { x: 0, y: 0, z: 0 },
};
