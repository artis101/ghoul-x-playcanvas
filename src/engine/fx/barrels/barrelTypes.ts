import type * as pc from 'playcanvas';
import type { AmmoType, Vec3Like } from '../../../contracts/ballistics.ts';
import type { BlastEvent } from '../../../contracts/destruction.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';

export type HazardBarrelState = 'INTACT' | 'IGNITED_HISSING' | 'DETONATED';

export interface HazardBarrelInstance {
  readonly index: number;
  readonly objectId: string;
  readonly basePosition: Vec3Like;
  state: HazardBarrelState;
  colliderHandle: number;
  /** Accumulated ignition damage where >= 1.0 ignites the 0.18s hissing fuse */
  ignitionDamage: number;
  hitCount: number;
  fuseRemainingS: number;
  leakOffsetLocal: Vec3Like;
  leakNormalWorld: Vec3Like;
  rootEntity: pc.Entity | null;
  intactDrumEntity: pc.Entity | null;
  flameJetEntity: pc.Entity | null;
  crumpledBaseEntity: pc.Entity | null;
  scorchDecalEntity: pc.Entity | null;
}

export const BARREL_FUSE_DURATION_S = 0.18;
export const BARREL_BLAST_RADIUS_M = 2.55;
export const BARREL_BLAST_PEAK_IMPULSE_NS = 210;
export const BARREL_BLAST_PEAK_ENERGY_J = 3200;
export const BARREL_SYMPATHETIC_CHAIN_RADIUS_M = 2.2;
export const BARREL_SYMPATHETIC_IGNITION_J = 950;

export const DEFAULT_HAZARD_BARREL_POSITIONS: readonly Vec3Like[] = [
  { x: -0.95, y: 0, z: -7.0 },  // Next to Wood Shoot-House Wall (z = -7.2)
  { x: -2.35, y: 0, z: -12.2 }, // Next to Instanced Brick Wall (z = -12.5)
  { x: 0.95, y: 0, z: -13.3 },  // Next to Voronoi Concrete Wall (z = -13.5)
  { x: 4.35, y: 0, z: -6.6 },   // Next to Runtime Voronoi Glass Window (z = -6.5)
];

export interface ExplosiveBarrelHitInput {
  ammoType?: AmmoType;
  pelletCount?: number;
  kineticEnergyJ?: number;
  isArmorPiercing?: boolean;
  hitPointWorld?: Vec3Like;
  hitNormalWorld?: Vec3Like;
}

export interface ExplosiveBarrelManagerOptions {
  app?: pc.Application | null;
  rapierWorld: RapierPhysicsWorld;
  shrapnelPool?: HardwareInstancedPool | null;
  barrelPositions?: readonly Vec3Like[];
  /** Delay in seconds when an adjacent barrel's blast sympathetically ignites a neighbor (default 0.08s; 0 = immediate) */
  sympatheticChainFuseS?: number;
  onBarrelIgnited?: (barrel: HazardBarrelInstance) => void;
  onBarrelDetonated?: (barrel: HazardBarrelInstance, blast: BlastEvent) => void;
}

export const INTACT_DRUM_RINGS: ReadonlyArray<{ y: number; r: number; v: number }> = [
  { y: 0.0, r: 0.275, v: 0.0 },
  { y: 0.025, r: 0.295, v: 0.03 },
  { y: 0.05, r: 0.282, v: 0.06 },
  { y: 0.28, r: 0.282, v: 0.31 },
  { y: 0.30, r: 0.298, v: 0.33 },
  { y: 0.32, r: 0.282, v: 0.35 },
  { y: 0.58, r: 0.282, v: 0.65 },
  { y: 0.60, r: 0.298, v: 0.67 },
  { y: 0.62, r: 0.282, v: 0.69 },
  { y: 0.85, r: 0.282, v: 0.94 },
  { y: 0.875, r: 0.295, v: 0.97 },
  { y: 0.90, r: 0.275, v: 1.0 },
];

export const CRUMPLED_BASE_RINGS: ReadonlyArray<{ y: number; r: number; v: number }> = [
  { y: 0.0, r: 0.29, v: 0.0 },
  { y: 0.04, r: 0.32, v: 0.15 },
  { y: 0.14, r: 0.27, v: 0.55 },
  { y: 0.26, r: 0.33, v: 1.0 },
];
