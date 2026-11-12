import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { GrenadeSweepStepResult } from '../../contracts/destruction.ts';
import type { WeaponGlbInstance } from '../assets/glbLoader.ts';

export type GrenadeFlightState = 'BALLISTIC' | 'GROUND_ROLLING' | 'RESTING';
export type GrenadeFuseState = 'ARMED' | 'CRITICAL_WARNING' | 'DETONATED';

export type GrenadeSweepInterceptor = (
  prevPos: Vec3Like,
  desiredPos: Vec3Like,
  velocity: Vec3Like,
  grenadeRadiusM: number,
  crossedGlassIds?: Set<string>
) => GrenadeSweepStepResult;

export interface ActiveFragGrenade {
  entity: pc.Entity;
  fusePinLed: pc.Entity;
  glbInstance: WeaponGlbInstance | null;
  position: pc.Vec3;
  velocity: pc.Vec3;
  angularVelocity: pc.Vec3;
  fuseRemainingS: number;
  blinkTimerS: number;
  flightState: GrenadeFlightState;
  fuseState: GrenadeFuseState;
  crossedGlassIds?: Set<string>;
}

export const GRENADE_RADIUS_M = 0.045;
export const GRENADE_FUSE_S = 1.6;
export const GRENADE_CRITICAL_FUSE_WARNING_S = 0.45;
export const GRENADE_BLAST_RADIUS_M = 7.5;
export const GRENADE_PEAK_IMPULSE_NS = 260;
export const GRENADE_PEAK_ENERGY_J = 6200;
