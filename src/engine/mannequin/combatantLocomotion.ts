import type { Vec3Like } from '../../contracts/ballistics.ts';

export interface CombatantMovementClip {
  readonly clip: 'Walk' | 'Run' | 'WalkBackward' | 'StrafeLeft' | 'StrafeRight';
  readonly playbackSpeed: number;
}

export class CombatantLocomotion {
  private previousX = 0;
  private previousZ = 0;
  private sampled = false;
  private speed = 0;
  private movement: CombatantMovementClip | undefined;

  public sample(position: Vec3Like, yaw: number, dt: number, standing: boolean): CombatantMovementClip | undefined {
    const dx = position.x - this.previousX;
    const dz = position.z - this.previousZ;
    this.previousX = position.x;
    this.previousZ = position.z;
    const distance = this.sampled ? Math.hypot(dx, dz) : 0;
    this.sampled = true;

    if (!standing || distance > 0.8) {
      this.speed = 0;
      this.movement = undefined;
      return;
    }
    if (dt <= 0) return this.movement;

    this.speed += (distance / dt - this.speed) * (1 - Math.exp(-16 * dt));
    if (this.speed < (this.movement ? 0.22 : 0.42)) {
      this.movement = undefined;
      return;
    }
    if (distance < 1e-4) return this.movement;

    const side = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const forward = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    let clip: CombatantMovementClip['clip'];
    let nominalSpeed = 1.7;
    if (Math.abs(side) > Math.abs(forward) * 1.1) {
      clip = side < 0 ? 'StrafeRight' : 'StrafeLeft';
      nominalSpeed = 2.6;
    } else if (forward < 0) {
      clip = 'WalkBackward';
    } else if (this.speed > (this.movement?.clip === 'Run' ? 2.05 : 2.35)) {
      clip = 'Run';
      nominalSpeed = 2.7;
    } else {
      clip = 'Walk';
    }
    this.movement = { clip, playbackSpeed: Math.max(0.45, Math.min(1.5, this.speed / nominalSpeed)) };
    return this.movement;
  }
}
