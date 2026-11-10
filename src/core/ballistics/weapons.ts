import { WeaponSpec, AmmoSpec, EnvironmentState } from '../../contracts/ballistics.ts';

export const AMMO_12G_00_BUCK: AmmoSpec = {
  id: '12G_00_BUCK',
  name: '12-Gauge 00 Buckshot (10 Pellets Heavy Magnum)',
  caliber: '12 Gauge (00 Buck)',
  type: 'BUCKSHOT_00',
  massKg: 0.0036,
  diameterM: 0.0084,
  muzzleVelocityMs: 405,
  dragCoefficient: 0.45,
  tissueExpansionFactor: 1.35,
  armorPenetrationFactor: 0.85,
  pelletCount: 10,
  spreadRadians: 0.032,
  ragdollImpulseMultiplier: 6.5,
  goreFactor: 3.2,
};

export const AMMO_12G_FLECHETTE_SLUG: AmmoSpec = {
  id: '12G_FLECHETTE_SLUG',
  name: '12-Gauge Heavy Penetrator Slug',
  caliber: '12 Gauge Slug',
  type: 'AP',
  massKg: 0.028,
  diameterM: 0.0185,
  muzzleVelocityMs: 490,
  dragCoefficient: 0.32,
  tissueExpansionFactor: 1.9,
  armorPenetrationFactor: 1.35,
  pelletCount: 1,
  spreadRadians: 0.004,
  ragdollImpulseMultiplier: 7.5,
  goreFactor: 4.0,
};

export const AMMO_50AE_JHP: AmmoSpec = {
  id: '50AE_JHP',
  name: '.50 Action Express Jacketed Hollow Point',
  caliber: '.50 AE',
  type: 'JHP',
  massKg: 0.0194,
  diameterM: 0.0127,
  muzzleVelocityMs: 440,
  dragCoefficient: 0.36,
  tissueExpansionFactor: 1.85,
  armorPenetrationFactor: 1.1,
  pelletCount: 1,
  spreadRadians: 0.002,
  ragdollImpulseMultiplier: 4.2,
  goreFactor: 2.8,
};

export const AMMO_762_NATO_M118LR: AmmoSpec = {
  id: '762_NATO_M118LR',
  name: '7.62x51mm NATO M118LR Match',
  caliber: '7.62x51mm NATO',
  type: 'FMJ',
  massKg: 0.01134,
  diameterM: 0.00782,
  muzzleVelocityMs: 805,
  dragCoefficient: 0.24,
  tissueExpansionFactor: 1.45,
  armorPenetrationFactor: 1.55,
  pelletCount: 1,
  spreadRadians: 0.0,
  ragdollImpulseMultiplier: 3.0,
  goreFactor: 2.2,
};

export const AMMO_762_NATO_AP_TUNGSTEN: AmmoSpec = {
  id: '762_NATO_AP_TUNGSTEN',
  name: '7.62x51mm NATO Armor Piercing (Tungsten Core)',
  caliber: '7.62x51mm NATO AP',
  type: 'AP',
  massKg: 0.0118,
  diameterM: 0.00782,
  muzzleVelocityMs: 830,
  dragCoefficient: 0.22,
  tissueExpansionFactor: 1.15,
  armorPenetrationFactor: 2.1,
  pelletCount: 1,
  spreadRadians: 0.0,
  ragdollImpulseMultiplier: 2.8,
  goreFactor: 1.9,
};

export const AMMO_556_NATO_M855: AmmoSpec = {
  id: '556_NATO_M855',
  name: '5.56x45mm NATO M855 Ball (Green Tip)',
  caliber: '5.56x45mm NATO',
  type: 'FMJ',
  massKg: 0.00402,
  diameterM: 0.0057,
  muzzleVelocityMs: 910,
  dragCoefficient: 0.27,
  tissueExpansionFactor: 1.5,
  armorPenetrationFactor: 1.25,
  pelletCount: 1,
  spreadRadians: 0.003,
  ragdollImpulseMultiplier: 1.8,
  goreFactor: 1.4,
};

export const WEAPON_M590: WeaponSpec = {
  id: 'm590_shotgun',
  name: 'Mossberg 590 Tactical 12-Gauge',
  codeName: 'BERSERKER 12G',
  role: 'SHOTGUN',
  description: 'Military 12-gauge pump-action shotgun. Massive close-range kinetic shock, limb amputation, and violent ragdoll displacement.',
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
  description: 'High-caliber gas-operated hand cannon. Devastating bone fracture energy and limb-shearing stopping power in close quarters.',
  defaultAmmo: AMMO_50AE_JHP,
  availableAmmo: [AMMO_50AE_JHP],
  fireRateRpm: 180,
  recoilKickDeg: 6.2,
  scopeZoomLevels: [1.0, 1.5],
  zeroDistanceM: 50,
};

export const WEAPON_MSG90: WeaponSpec = {
  id: 'msg90_sniper',
  name: 'MSG90A1 7.62x51mm Precision Marksman Rifle',
  codeName: 'MSG90A1 7.62',
  role: 'SNIPER',
  description: 'Military-grade semi-automatic sniper system. Extreme effective range, flat trajectory, and lethal internal organ cavitation triggering X-Ray Kill Cam.',
  defaultAmmo: AMMO_762_NATO_M118LR,
  availableAmmo: [AMMO_762_NATO_M118LR, AMMO_762_NATO_AP_TUNGSTEN],
  fireRateRpm: 120,
  recoilKickDeg: 3.5,
  scopeZoomLevels: [4.0, 8.0, 16.0],
  zeroDistanceM: 100,
};

export const WEAPON_M4A1: WeaponSpec = {
  id: 'm4a1_carbine',
  name: 'M4A1 5.56x45mm Tactical Carbine',
  codeName: 'M4A1 CARBINE',
  role: 'ASSAULT_RIFLE',
  description: 'Standard issue selective fire carbine. Rapid follow-up shots, high velocity, and consistent hydrostatic tissue damage.',
  defaultAmmo: AMMO_556_NATO_M855,
  availableAmmo: [AMMO_556_NATO_M855],
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
