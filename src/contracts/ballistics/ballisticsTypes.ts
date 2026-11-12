export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type AmmoType = 'FMJ' | 'JHP' | 'AP' | 'BUCKSHOT_00';

export type EnemyArchetypeId =
  | 'SKINHEAD_PUNK'
  | 'MILITIA_GUNNER'
  | 'HEAVY_ENFORCER'
  | 'SNIPER_OPERATIVE';

export type CombatantPostureState =
  | 'COMBAT_READY'
  | 'STAGGERED'
  | 'LEG_BUCKLED'
  | 'THROAT_CLUTCH'
  | 'GUT_HURT'
  | 'DISARMED'
  | 'AIRBORNE_RAGDOLL'
  | 'RAGDOLL_GROUNDED';

export type PainReactionType =
  | 'NONE'
  | 'HEAD_SNAP'
  | 'THROAT_CLUTCH'
  | 'CHEST_STAGGER'
  | 'GUT_FOLD'
  | 'ARM_WRENCH_RIGHT'
  | 'ARM_WRENCH_LEFT'
  | 'LEG_BUCKLE_RIGHT'
  | 'LEG_BUCKLE_LEFT';

export interface AmmoSpec {
  id: string;
  name: string;
  caliber: string;
  type: AmmoType;
  /** Mass of single projectile in kilograms (e.g. 0.01134 kg for 175gr 7.62 NATO, 0.0035 kg per 00 buck pellet) */
  massKg: number;
  /** Diameter in meters (e.g. 0.00782 m for 7.62mm, 0.00838 m for 00 buck) */
  diameterM: number;
  /** Muzzle velocity in m/s */
  muzzleVelocityMs: number;
  /** Ballistic drag coefficient (G1 model baseline) */
  dragCoefficient: number;
  /** Expansion factor in soft tissue (1.0 for AP, 1.8 for JHP) */
  tissueExpansionFactor: number;
  /** Armor/bone penetration multiplier (1.5 for AP, 0.65 for JHP) */
  armorPenetrationFactor: number;
  /** Number of pellets per shot (1 for rifle/pistol, 10 for 12-gauge shotgun) */
  pelletCount: number;
  /** Spread cone half-angle in radians */
  spreadRadians: number;
  /** Cinematic knockback amplification factor */
  ragdollImpulseMultiplier: number;
  /** Gore & dismemberment multiplier */
  goreFactor: number;
}

export type WeaponRole = 'RIFLE' | 'SHOTGUN' | 'HEAVY_PISTOL' | 'SNIPER' | 'ASSAULT_RIFLE';

export interface WeaponSpec {
  id: string;
  name: string;
  codeName: string;
  role: WeaponRole;
  description: string;
  defaultAmmo: AmmoSpec;
  availableAmmo: AmmoSpec[];
  fireRateRpm: number;
  recoilKickDeg: number;
  scopeZoomLevels: number[];
  zeroDistanceM: number;
}

export interface EnvironmentState {
  /** Gravity vector in m/s^2, default (0, -9.81, 0) */
  gravity: Vec3Like;
  /** Air density in kg/m^3, default 1.225 at sea level ISA */
  airDensityKgM3: number;
  /** Speed of sound in m/s, default 343.0 */
  speedOfSoundMs: number;
  /** Wind velocity vector in m/s */
  windVelocity: Vec3Like;
}

export interface ProjectileState {
  id: string;
  ammo: AmmoSpec;
  position: Vec3Like;
  velocity: Vec3Like;
  /** Spin rate in rad/s around forward axis */
  spinRadS: number;
  /** Current diameter (increases on mushrooming/expansion inside tissue) */
  currentDiameterM: number;
  /** Elapsed flight time in seconds */
  flightTimeS: number;
  /** Total distance traveled in meters */
  distanceTraveledM: number;
  /** Kinetic energy in Joules: 0.5 * m * |v|^2 */
  kineticEnergyJ: number;
  /** Number of anatomical layers penetrated */
  penetratedLayers: number;
  /** Whether projectile is still active in flight */
  alive: boolean;
}

export interface TrajectorySample {
  timeS: number;
  position: Vec3Like;
  velocity: Vec3Like;
  speedMs: number;
  mach: number;
  kineticEnergyJ: number;
  dropM: number;
  windDriftM: number;
}
