import * as pc from 'playcanvas';
import type { WeaponGlbInstance } from '../assets/glbLoader.ts';

export type GrenadeFlightState = 'BALLISTIC' | 'GROUND_ROLLING' | 'RESTING';
export type GrenadeFuseState = 'ARMED' | 'CRITICAL_WARNING' | 'DETONATED';

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
}

export const GRENADE_FUSE_S = 1.6;
export const GRENADE_CRITICAL_FUSE_WARNING_S = 0.45;
export const GRENADE_BLAST_RADIUS_M = 7.5;
export const GRENADE_PEAK_IMPULSE_NS = 260;
export const GRENADE_PEAK_ENERGY_J = 6200;
