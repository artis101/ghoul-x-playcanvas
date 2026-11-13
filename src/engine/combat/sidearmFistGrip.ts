import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import { TRIGGER_GRIPS } from '../mannequin/combatantWeaponGrip.ts';

/**
 * The pistol held rigidly in the animated fist: its rotation is the hand bone's rotation times a
 * fixed grip offset, so wherever the clip (and the small aim delta) moves the hand, the gun goes
 * with it and the barrel the player sees is the one the bullets leave along.
 *
 * The grip offsets were measured on the baked GLB (PistolAim, PistolDraw, PistolAimOneHand,
 * KneelPistolAimOneHand, SeatedPistolAim, StumpDraw*): in the right hand bone's frame
 * - a one-handed aim points the barrel down the forearm, about (0, 0.92, -0.38);
 * - the two-handed PistolAim bends the wrist in toward the centre line, so the barrel there
 *   lies about 20 degrees off the forearm, about (0.35, 0.92, -0.15);
 * - the top of the slide faces about (-0.5, 0.4, 0.75).
 * The left hand is the mirror image: the X component flips.
 */
const ONE_HAND_BARREL = new pc.Vec3(0, 0.92, -0.38).normalize();
const TWO_HAND_BARREL = new pc.Vec3(0.35, 0.92, -0.15).normalize();
const SLIDE_UP_HINT = new pc.Vec3(-0.5, 0.4, 0.75).normalize();
// The palm centre sits this far along the hand bone from the wrist joint.
const PALM_ALONG_HAND_M = 0.052;

export type FistHand = 'RIGHT' | 'LEFT';

export class SidearmFistGrip {
  private readonly barrelLocal = new pc.Vec3();
  private readonly upLocal = new pc.Vec3();
  private readonly axisX = new pc.Vec3();
  private readonly axisY = new pc.Vec3();
  private readonly axisZ = new pc.Vec3();
  private readonly gripMat = new pc.Mat4();
  private readonly gripQuat = new pc.Quat();
  private readonly gunQuat = new pc.Quat();
  private readonly offset = new pc.Vec3();
  private readonly scratch = new pc.Vec3();

  /**
   * The barrel direction the fist gives right now, in world space. `twoHanded` 0..1 blends from
   * the one-handed grip to the two-handed wrist bend.
   */
  public barrelWorld(hand: pc.GraphNode, side: FistHand, twoHanded: number): Vec3Like {
    this.buildGrip(side, twoHanded);
    hand.getRotation().transformVector(this.barrelLocal, this.scratch).normalize();
    return { x: this.scratch.x, y: this.scratch.y, z: this.scratch.z };
  }

  /** Puts the pistol in the fist: grip on the palm, rotation fixed to the hand. */
  public seat(holder: pc.GraphNode, weapon: pc.GraphNode, hand: pc.GraphNode, side: FistHand, twoHanded: number): void {
    this.buildGrip(side, twoHanded);
    this.gunQuat.mul2(hand.getRotation(), this.gripQuat);
    holder.setRotation(this.gunQuat);
    const handPos = hand.getPosition();
    const up = hand.up;
    this.offset.copy(TRIGGER_GRIPS.silver_talon_50ae).mul(weapon.getLocalScale());
    this.gunQuat.transformVector(this.offset, this.offset);
    holder.setPosition(
      handPos.x + up.x * PALM_ALONG_HAND_M - this.offset.x,
      handPos.y + up.y * PALM_ALONG_HAND_M - this.offset.y,
      handPos.z + up.z * PALM_ALONG_HAND_M - this.offset.z,
    );
  }

  /** The gun's rotation in the hand's frame: barrel on the gun's -Z, slide top on its +Y. */
  private buildGrip(side: FistHand, twoHanded: number): void {
    const t = Math.max(0, Math.min(1, twoHanded));
    this.barrelLocal.lerp(ONE_HAND_BARREL, TWO_HAND_BARREL, t).normalize();
    this.upLocal.copy(SLIDE_UP_HINT);
    if (side === 'LEFT') {
      this.barrelLocal.x = -this.barrelLocal.x;
      this.upLocal.x = -this.upLocal.x;
    }
    this.axisZ.copy(this.barrelLocal).mulScalar(-1);
    this.axisX.cross(this.upLocal, this.axisZ).normalize();
    this.axisY.cross(this.axisZ, this.axisX).normalize();
    const m = this.gripMat.data;
    m[0] = this.axisX.x; m[1] = this.axisX.y; m[2] = this.axisX.z; m[3] = 0;
    m[4] = this.axisY.x; m[5] = this.axisY.y; m[6] = this.axisY.z; m[7] = 0;
    m[8] = this.axisZ.x; m[9] = this.axisZ.y; m[10] = this.axisZ.z; m[11] = 0;
    m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
    this.gripQuat.setFromMat4(this.gripMat);
  }
}
