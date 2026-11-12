import * as pc from 'playcanvas';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';

const EASE_RATE = 9;
const MAX_TURN_DEG = 80;

/** Turns the head to sight along an aimed weapon, however the body is angled behind it. */
export class CombatantAimHead {
  private readonly target = new pc.Quat();
  private readonly rotation = new pc.Quat();
  private readonly chestForward = new pc.Vec3();
  private weight = 0;

  public reset(): void {
    this.weight = 0;
  }

  /** @param barrel World direction of the aimed barrel, or null when nothing is being aimed. */
  public sync(glb: CombatantGlbInstance, barrel: pc.Vec3 | null, dt?: number): void {
    const goal = barrel ? 1 : 0;
    this.weight = dt === undefined ? goal : this.weight + (goal - this.weight) * (1 - Math.exp(-EASE_RATE * dt));
    const neck = glb.boneNodes.get('NECK_CERVICAL');
    const head = glb.boneNodes.get('HEAD_CRANIUM');
    const chest = glb.boneNodes.get('TORSO_UPPER_THORAX');
    if (!barrel || !neck || !head || !chest || this.weight < 0.01) return;

    // The head's rest pose faces +Z with +Y up.
    const yaw = Math.atan2(barrel.x, barrel.z) * pc.math.RAD_TO_DEG;
    const pitch = -Math.asin(pc.math.clamp(barrel.y, -1, 1)) * pc.math.RAD_TO_DEG;
    this.target.setFromEulerAngles(pitch, yaw, 0);

    // Never twist the neck further than it could really turn from the chest.
    chest.getRotation().transformVector(pc.Vec3.BACK, this.chestForward);
    const turn = Math.acos(pc.math.clamp(this.chestForward.dot(barrel), -1, 1)) * pc.math.RAD_TO_DEG;
    const weight = this.weight * Math.min(1, MAX_TURN_DEG / Math.max(turn, 1e-3));
    neck.setRotation(this.rotation.slerp(neck.getRotation(), this.target, weight * 0.5));
    head.setRotation(this.rotation.slerp(head.getRotation(), this.target, weight));
  }
}
