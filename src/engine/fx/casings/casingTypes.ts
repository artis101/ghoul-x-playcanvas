import type { Vec3Like } from '../../../contracts/ballistics.ts';

export interface CasingBounceEvent {
  readonly position: Vec3Like;
  readonly impactSpeedMs: number;
  readonly isShotgunHull: boolean;
  readonly bounceIndex: number;
}

export const CASING_BOUNCE_FLOOR_Y = 0.012;
export const TRACKED_CASING_CAPACITY = 64;

export class TrackedCasingBuffer {
  public readonly trackActive = new Uint8Array(TRACKED_CASING_CAPACITY);
  public readonly trackIsHull = new Uint8Array(TRACKED_CASING_CAPACITY);
  public readonly trackBounces = new Uint8Array(TRACKED_CASING_CAPACITY);
  public readonly trackPosX = new Float32Array(TRACKED_CASING_CAPACITY);
  public readonly trackPosY = new Float32Array(TRACKED_CASING_CAPACITY);
  public readonly trackPosZ = new Float32Array(TRACKED_CASING_CAPACITY);
  public readonly trackVelX = new Float32Array(TRACKED_CASING_CAPACITY);
  public readonly trackVelY = new Float32Array(TRACKED_CASING_CAPACITY);
  public readonly trackVelZ = new Float32Array(TRACKED_CASING_CAPACITY);
  public readonly trackRestitution = new Float32Array(TRACKED_CASING_CAPACITY);
  public trackWriteCursor = 0;

  public reset(): void {
    this.trackActive.fill(0);
    this.trackWriteCursor = 0;
  }
}
