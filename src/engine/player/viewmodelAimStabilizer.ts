import * as pc from 'playcanvas';
import type { WeaponGlbInstance } from '../assets/glbLoader.ts';

/**
 * Holds the sights steady while aimed. The weapon's clips move its root bone (idle bob, recoil),
 * which would carry the sights off screen centre; this cancels a chosen share of that motion by
 * moving the viewmodel parent the opposite way.
 */
export class ViewmodelAimStabilizer {
  private readonly counterRot = new pc.Quat();
  private readonly counterPos = new pc.Vec3();
  private readonly scratchRot = new pc.Quat();
  private readonly scratchPos = new pc.Vec3();

  /** `weight` 0 leaves the clip untouched, 1 pins the weapon to its rest pose. */
  public apply(vmEntity: pc.Entity, weapon: WeaponGlbInstance | null, weight: number): void {
    const rest = weapon?.rootBoneRest;
    const bone = weapon?.boneNodes.get('Bone_Root');
    if (!rest || !bone || weight <= 0) return;

    // Clip displacement of the weapon in its own space is A * inverse(B), with A the animated
    // and B the rest bone transform. The counter-move is its inverse: B * inverse(A).
    const invAnimRot = this.scratchRot.copy(bone.getLocalRotation()).invert();
    this.counterRot.copy(rest.rotation).mul(invAnimRot);
    this.counterRot.transformVector(bone.getLocalPosition(), this.counterPos);
    this.counterPos.sub2(rest.position, this.counterPos);

    this.counterRot.slerp(pc.Quat.IDENTITY, this.counterRot, weight);
    this.counterPos.mulScalar(weight);

    const vmRot = vmEntity.getLocalRotation();
    vmRot.transformVector(this.counterPos, this.scratchPos);
    vmEntity.setLocalPosition(this.scratchPos.add(vmEntity.getLocalPosition()));
    vmEntity.setLocalRotation(this.scratchRot.copy(vmRot).mul(this.counterRot));
  }
}
