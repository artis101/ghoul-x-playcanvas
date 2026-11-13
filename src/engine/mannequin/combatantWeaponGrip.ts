import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { WeaponAssetId } from '../assets/glbLoader.ts';

// Palm centers in the weapon model's authored coordinates.
export const TRIGGER_GRIPS: Readonly<Record<WeaponAssetId, pc.Vec3>> = {
  m4a1_carbine: new pc.Vec3(0, -0.05, 0.023),
  m590_shotgun: new pc.Vec3(0, -0.016, 0.068),
  msg90_sniper: new pc.Vec3(0, -0.06, 0.027),
  silver_talon_50ae: new pc.Vec3(0, -0.045, 0.02),
  frag_grenade: new pc.Vec3(),
};

export const M4A1_PALM_OFFSET_X = 0.027;

/** The palm centre sits this far along the trigger hand bone from the wrist joint. */
export const TRIGGER_PALM_ALONG_HAND_M = 0.052;

/**
 * The trigger hand's rotation in a long gun's frame (barrel -Z, top +Y): the right hand round the
 * pistol grip. The Blender grip pass bakes every gripped clip with the hand held exactly so
 * (`scripts/blender/weapon_grips.json`, `trigger_hand_euler_x`), so the gun can be glued to it.
 */
export const LONG_GUN_TRIGGER_HAND_EULER_X = -110;

/**
 * Clips whose arms were baked holding a long gun (the grip pass's shouldered placements): the
 * gun is glued rigidly to the trigger hand. Every other clip (flinches, the pickup) still leads
 * the gun by the chest heading (combatantGunHeading.ts).
 */
export const GRIPPED_LONG_GUN_CLIPS: ReadonlySet<string> = new Set([
  'CombatReadyIdle', 'UnsuspectingIdle', 'LongGunAim', 'Walk', 'WalkBackward', 'Run', 'StrafeLeft', 'StrafeRight',
  'HurtIdle', 'HurtWalk',
]);

const TRIGGER_HAND = new pc.Quat().setFromEulerAngles(LONG_GUN_TRIGGER_HAND_EULER_X, 0, 0);
const GUN_IN_RIGHT_HAND = TRIGGER_HAND.clone().invert();
/** The left hand is the right one's mirror image across the body's X = 0 plane. */
const GUN_IN_LEFT_HAND = new pc.Quat(GUN_IN_RIGHT_HAND.x, -GUN_IN_RIGHT_HAND.y, -GUN_IN_RIGHT_HAND.z, GUN_IN_RIGHT_HAND.w);

/** The palm offset a long gun is held with: the M4's grip sits off the palm centre. */
export function longGunPalmOffsetX(weaponId: WeaponAssetId): number {
  return weaponId === 'm4a1_carbine' ? M4A1_PALM_OFFSET_X : 0;
}

export class CombatantWeaponGrip {
  private readonly rotation = new pc.Quat();
  private readonly offset = new pc.Vec3();

  public align(
    holder: pc.GraphNode,
    weapon: pc.GraphNode,
    weaponId: WeaponAssetId,
    palm: Vec3Like,
    barrelDirection: Vec3Like,
    palmOffsetX = 0,
  ): void {
    // PlayCanvas forward and the GLB barrel both use local -Z.
    const yaw = Math.atan2(-barrelDirection.x, -barrelDirection.z) * pc.math.RAD_TO_DEG;
    const pitch = Math.atan2(barrelDirection.y, Math.hypot(barrelDirection.x, barrelDirection.z)) * pc.math.RAD_TO_DEG;
    this.rotation.setFromEulerAngles(pitch, yaw, 0);
    this.place(holder, weapon, weaponId, palm, palmOffsetX);
  }

  /**
   * Glues a long gun rigidly to the trigger hand of a gripped clip: its rotation is the hand's
   * times the fixed grip, its trigger point on the palm. What the clip does with the wrist, the
   * gun does too, so the barrel seen is the barrel the grip pass baked.
   */
  public seatInFist(
    holder: pc.GraphNode, weapon: pc.GraphNode, weaponId: WeaponAssetId, hand: pc.GraphNode, side: 'RIGHT' | 'LEFT',
  ): void {
    this.rotation.mul2(hand.getRotation(), side === 'RIGHT' ? GUN_IN_RIGHT_HAND : GUN_IN_LEFT_HAND);
    const p = hand.getPosition();
    const up = hand.up;
    const palm = {
      x: p.x + up.x * TRIGGER_PALM_ALONG_HAND_M,
      y: p.y + up.y * TRIGGER_PALM_ALONG_HAND_M,
      z: p.z + up.z * TRIGGER_PALM_ALONG_HAND_M,
    };
    const lateral = longGunPalmOffsetX(weaponId);
    this.place(holder, weapon, weaponId, palm, side === 'RIGHT' ? lateral : -lateral);
  }

  private place(holder: pc.GraphNode, weapon: pc.GraphNode, weaponId: WeaponAssetId, palm: Vec3Like, palmOffsetX: number): void {
    this.offset.copy(TRIGGER_GRIPS[weaponId]);
    this.offset.x += palmOffsetX;
    this.offset.mul(weapon.getLocalScale());
    this.rotation.transformVector(this.offset, this.offset);
    holder.setRotation(this.rotation);
    holder.setPosition(palm.x - this.offset.x, palm.y - this.offset.y, palm.z - this.offset.z);
  }
}
