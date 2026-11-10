import { WeaponSpec, AmmoSpec, EnvironmentState } from '../../contracts/ballistics.ts';

/**
 * 12-Gauge 00 Buckshot (Stopping Power):
 * 9 soft-lead spherical pellets (3.5g each, 31.5g total payload).
 * Devastating close-quarters stopping power at 1-6m; high spherical aerodynamic drag (Cd 0.52)
 * and 0.035 rad pattern spread cause rapid velocity/energy falloff by 15-25m. Defeated by NIJ IIIA Kevlar.
 */
export const AMMO_12G_00_BUCK: AmmoSpec = {
  id: '12G_00_BUCK',
  name: '12-Gauge 00 Buckshot (9 Pellets Stopping)',
  caliber: '12G 00 BUCK',
  type: 'BUCKSHOT_00',
  massKg: 0.0035,
  diameterM: 0.0084,
  muzzleVelocityMs: 405,
  dragCoefficient: 0.52,
  tissueExpansionFactor: 1.38,
  armorPenetrationFactor: 0.65,
  pelletCount: 9,
  spreadRadians: 0.034,
  ragdollImpulseMultiplier: 1.35,
  goreFactor: 1.55,
};

/**
 * 12-Gauge Sabot Penetrator Slug (Penetration Power):
 * Single 28g hardened sabot slug. Retains energy further downrange, punches through
 * NIJ IIIA Kevlar vests, and shatters heavy cortical bone.
 */
export const AMMO_12G_FLECHETTE_SLUG: AmmoSpec = {
  id: '12G_FLECHETTE_SLUG',
  name: '12-Gauge Sabot Penetrator Slug',
  caliber: '12G SABOT SLUG',
  type: 'AP',
  massKg: 0.028,
  diameterM: 0.0165,
  muzzleVelocityMs: 475,
  dragCoefficient: 0.30,
  tissueExpansionFactor: 1.28,
  armorPenetrationFactor: 1.48,
  pelletCount: 1,
  spreadRadians: 0.003,
  ragdollImpulseMultiplier: 1.25,
  goreFactor: 1.65,
};

/**
 * .50 AE 300gr Jacketed Hollow Point (Stopping Power):
 * Massive expansion (1.88x diameter) dumps nearly 100% of its ~1,880 J kinetic energy
 * inside unarmored soft tissue for extreme stopping power, but is stopped by IIIA Kevlar.
 */
export const AMMO_50AE_JHP: AmmoSpec = {
  id: '50AE_JHP',
  name: '.50 AE 300gr Jacketed Hollow Point',
  caliber: '.50 AE JHP',
  type: 'JHP',
  massKg: 0.0194,
  diameterM: 0.0127,
  muzzleVelocityMs: 440,
  dragCoefficient: 0.36,
  tissueExpansionFactor: 1.88,
  armorPenetrationFactor: 0.76,
  pelletCount: 1,
  spreadRadians: 0.002,
  ragdollImpulseMultiplier: 1.15,
  goreFactor: 1.70,
};

/**
 * .50 AE 300gr Hard-Cast Flat-Nose FMJ (Penetration Power):
 * Non-expanding solid penetrator that defeats soft body armor and punches deep through bone,
 * trading wide hollow-point cavitation for straight-line penetration.
 */
export const AMMO_50AE_FMJ_SOLID: AmmoSpec = {
  id: '50AE_FMJ_SOLID',
  name: '.50 AE 300gr Hard-Cast FMJ Penetrator',
  caliber: '.50 AE FMJ',
  type: 'FMJ',
  massKg: 0.0194,
  diameterM: 0.0127,
  muzzleVelocityMs: 455,
  dragCoefficient: 0.33,
  tissueExpansionFactor: 1.08,
  armorPenetrationFactor: 1.42,
  pelletCount: 1,
  spreadRadians: 0.002,
  ragdollImpulseMultiplier: 1.05,
  goreFactor: 1.15,
};

/**
 * 7.62x51mm NATO M118LR 175gr Match OTM (Stopping + Range):
 * Yawing open-tip match rifle round producing large hydrostatic stretch cavities and
 * defeating soft Kevlar armor.
 */
export const AMMO_762_NATO_M118LR: AmmoSpec = {
  id: '762_NATO_M118LR',
  name: '7.62x51mm NATO M118LR 175gr Match OTM',
  caliber: '7.62 NATO MATCH',
  type: 'FMJ',
  massKg: 0.01134,
  diameterM: 0.00782,
  muzzleVelocityMs: 805,
  dragCoefficient: 0.24,
  tissueExpansionFactor: 1.62,
  armorPenetrationFactor: 1.55,
  pelletCount: 1,
  spreadRadians: 0.0,
  ragdollImpulseMultiplier: 1.0,
  goreFactor: 1.40,
};

/**
 * 7.62x51mm NATO M993 Tungsten-Carbide AP (Extreme Penetration):
 * Non-deforming sub-caliber tungsten penetrator. Effortlessly perforates helmets, vests, bone,
 * and multiple lined-up combatants, but over-penetrates thin unarmored flesh with narrow wound channels.
 */
export const AMMO_762_NATO_AP_TUNGSTEN: AmmoSpec = {
  id: '762_NATO_AP_TUNGSTEN',
  name: '7.62x51mm NATO M993 Tungsten AP',
  caliber: '7.62 NATO AP',
  type: 'AP',
  massKg: 0.0118,
  diameterM: 0.00782,
  muzzleVelocityMs: 830,
  dragCoefficient: 0.22,
  tissueExpansionFactor: 1.02,
  armorPenetrationFactor: 2.35,
  pelletCount: 1,
  spreadRadians: 0.0,
  ragdollImpulseMultiplier: 0.90,
  goreFactor: 1.05,
};

/**
 * 5.56x45mm NATO M855 62gr Green Tip (Penetration Power):
 * Mild-steel penetrator tip punches through PASGT helmets and IIIA vests at high velocity,
 * but punches narrow ice-pick channels in unarmored peripheral flesh.
 */
export const AMMO_556_NATO_M855: AmmoSpec = {
  id: '556_NATO_M855',
  name: '5.56x45mm NATO M855 Green Tip Penetrator',
  caliber: '5.56 M855 PEN',
  type: 'FMJ',
  massKg: 0.00402,
  diameterM: 0.0057,
  muzzleVelocityMs: 910,
  dragCoefficient: 0.27,
  tissueExpansionFactor: 1.15,
  armorPenetrationFactor: 1.52,
  pelletCount: 1,
  spreadRadians: 0.0025,
  ragdollImpulseMultiplier: 0.85,
  goreFactor: 0.95,
};

/**
 * 5.56x45mm 77gr Tactical JHP/OTM (Stopping Power):
 * Heavy-for-caliber hollow-point load that expands rapidly in unarmored flesh for high
 * close-to-mid range stopping power, but is stopped by Heavy Enforcer IIIA Kevlar.
 */
export const AMMO_556_NATO_SOST_JHP: AmmoSpec = {
  id: '556_NATO_SOST_JHP',
  name: '5.56x45mm 77gr Tactical JHP (Stopping)',
  caliber: '5.56 77GR JHP',
  type: 'JHP',
  massKg: 0.00499,
  diameterM: 0.0057,
  muzzleVelocityMs: 840,
  dragCoefficient: 0.28,
  tissueExpansionFactor: 1.82,
  armorPenetrationFactor: 0.62,
  pelletCount: 1,
  spreadRadians: 0.002,
  ragdollImpulseMultiplier: 0.95,
  goreFactor: 1.25,
};

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
  name: 'MSG90A1 7.62x51mm Precision Marksman Rifle',
  codeName: 'MSG90A1 7.62',
  role: 'SNIPER',
  description:
    'Semi-automatic 7.62x51mm NATO marksman rifle. Pairs M118LR OTM tissue cavitation with M993 Tungsten-Carbide AP over-penetrators.',
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
