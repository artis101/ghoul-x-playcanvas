import * as pc from 'playcanvas';
import type { WeaponGlbInstance } from '../assets/glbLoader.ts';

export interface ActiveFragGrenade {
  entity: pc.Entity;
  fusePinLed: pc.Entity;
  glbInstance: WeaponGlbInstance | null;
  position: pc.Vec3;
  velocity: pc.Vec3;
  angularVelocity: pc.Vec3;
  fuseRemainingS: number;
  blinkTimerS: number;
}

export const GRENADE_FUSE_S = 1.6;
export const GRENADE_BLAST_RADIUS_M = 7.5;
export const GRENADE_PEAK_IMPULSE_NS = 260;
export const GRENADE_PEAK_ENERGY_J = 6200;
