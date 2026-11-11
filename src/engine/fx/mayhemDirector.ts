// MayhemDirector Root Facade & Re-export Barrel
export {
  BulletTimeController,
} from './bulletTime/bulletTimeController.ts';
export {
  type BulletTimeOptions,
  type BulletTimeVignetteState,
  type BulletTimeVignetteTint,
  type KillPunchReason,
} from './bulletTime/bulletTimeTypes.ts';
export { BulletTimeScript } from './bulletTime/bulletTimeScript.ts';

export {
  basisColumnsToQuaternion,
  computeSurfaceAlignedQuadQuaternion,
  directionToStreakQuaternion,
} from './math/surfaceAlignment.ts';
export {
  clampByte,
  hash2d,
  valueNoise2d,
} from './math/noiseHelpers.ts';

export {
  ExplosiveBarrelManager,
} from './barrels/explosiveBarrelManager.ts';
export {
  type ExplosiveBarrelHitInput,
  type ExplosiveBarrelManagerOptions,
  type HazardBarrelInstance,
  type HazardBarrelState,
  BARREL_BLAST_PEAK_ENERGY_J,
  BARREL_BLAST_PEAK_IMPULSE_NS,
  BARREL_BLAST_RADIUS_M,
  BARREL_FUSE_DURATION_S,
  DEFAULT_HAZARD_BARREL_POSITIONS,
} from './barrels/barrelTypes.ts';
export { HazardBarrelsScript } from './barrels/hazardBarrelScript.ts';

export {
  type CasingBounceEvent,
  CASING_BOUNCE_FLOOR_Y,
  TRACKED_CASING_CAPACITY,
} from './casings/casingTypes.ts';

export {
  type BloodSplatterProjectionParams,
} from './decals/bloodSplatterSystem.ts';

export {
  MayhemDirector,
  type MayhemDirectorOptions,
} from './mayhemDirectorCore.ts';
export { MayhemDirectorScript } from './mayhemDirectorScript.ts';
