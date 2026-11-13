// MayhemDirector Root Facade & Re-export Barrel

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
  type HazardBarrelPhase,
  type HazardBarrelState,
  BARREL_BLAST_PEAK_ENERGY_J,
  BARREL_BLAST_PEAK_IMPULSE_NS,
  BARREL_BLAST_RADIUS_M,
  BARREL_FUSE_DURATION_S,
  BARREL_SYMPATHETIC_CHAIN_RADIUS_M,
  BARREL_SYMPATHETIC_IGNITION_J,
  DEFAULT_HAZARD_BARREL_POSITIONS,
} from './barrels/barrelTypes.ts';

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
export { LingeringGunsmokePool } from './smoke/lingeringGunsmokePool.ts';
