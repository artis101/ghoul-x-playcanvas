import * as pc from 'playcanvas';
import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';

export class CombatantLocomotion {
  private readonly previousPosition = new pc.Vec3();
  private readonly travel = new pc.Vec3();
  private readonly travelDirection = new pc.Vec3();
  private readonly axis = new pc.Vec3();
  private readonly swing = new pc.Quat();
  private readonly rotation = new pc.Quat();
  private hasPreviousPosition = false;
  private phase = 0;
  private strideWeight = 0;

  public sync(glb: CombatantGlbInstance, state: TargetHealthState, dt: number, standing: boolean): void {
    const { x, y, z } = state.worldPosition;
    this.travel.set(x - this.previousPosition.x, 0, z - this.previousPosition.z);
    this.previousPosition.set(x, y, z);
    const distance = this.hasPreviousPosition ? this.travel.length() : 0;
    this.hasPreviousPosition = true;

    if (!standing || dt <= 0 || distance > 0.8) {
      this.strideWeight = 0;
      this.phase = 0;
      return;
    }

    const weight = Math.min(1, distance / dt / 1.6);
    const blend = 1 - Math.exp(-12 * dt);
    this.strideWeight += (weight - this.strideWeight) * blend;
    if (distance > 1e-4) {
      this.travelDirection.copy(this.travel).mulScalar(1 / distance);
      this.phase = (this.phase + distance * (2 * Math.PI / 0.82)) % (2 * Math.PI);
    }
    if (this.strideWeight < 0.002) return;

    // Layer a stride over the sampled idle while the root moves, including strafes.
    this.axis.cross(this.travelDirection, pc.Vec3.UP);
    const stride = Math.sin(this.phase);
    for (const side of ['LEFT', 'RIGHT'] as const) {
      const swing = side === 'LEFT' ? stride : -stride;
      const thigh = glb.boneNodes.get(`THIGH_${side}`);
      if (thigh) {
        this.swing.setFromAxisAngle(this.axis, swing * this.strideWeight * 22);
        this.rotation.mul2(this.swing, thigh.getRotation());
        thigh.setRotation(this.rotation);
      }
      const knee = glb.boneNodes.get(`KNEE_${side}`);
      if (knee) {
        this.swing.setFromAxisAngle(glb.rootEntity.right, Math.max(0, swing) * this.strideWeight * 16);
        this.rotation.mul2(this.swing, knee.getRotation());
        knee.setRotation(this.rotation);
      }
    }
  }
}
