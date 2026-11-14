import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import * as pc from 'playcanvas';
import type { ActiveFiringHand } from '../ai/tacticalAiTypes.ts';
import type { CombatantGlbInstance, WeaponAssetId, WeaponGlbInstance } from '../assets/glbLoader.ts';
import { HAND_ZONE } from './armZoneKeys.ts';
import { CombatantSupportGrip } from './combatantSupportGrip.ts';
import { M4A1_PALM_OFFSET_X, TRIGGER_GRIPS } from './combatantWeaponGrip.ts';

/**
 * The stretch of each gun the support palm may hold, in the weapon model's coordinates (barrel
 * along -Z). The palm settles at the point on it nearest to where the clip put the hand.
 */
const SUPPORT_RAILS: Partial<Record<WeaponAssetId, readonly [pc.Vec3, pc.Vec3]>> = {
  m4a1_carbine: [new pc.Vec3(0, -0.054, -0.21), new pc.Vec3(0, -0.054, -0.35)],
  m590_shotgun: [new pc.Vec3(0, -0.037, -0.25), new pc.Vec3(0, -0.037, -0.25)],
  msg90_sniper: [new pc.Vec3(0, -0.036, -0.2), new pc.Vec3(0, -0.036, -0.36)],
  // The grip's own side, where the grip pass bakes the thumbs-forward support palm.
  silver_talon_50ae: [new pc.Vec3(0, -0.05, 0.01), new pc.Vec3(0, -0.05, 0.01)],
};

// The support palm only snaps onto the gun when the clip already has it nearly there. The Blender
// grip pass bakes it onto the M4's handguard in every clip that holds a long gun, so on the other
// guns it moves a few centimetres to their own forend or pump; anything further means the clip
// has let go on purpose (a flinch, a clutch, a wave), and pulling it back would undo that.
export const SUPPORT_CONTACT_FULL_M = 0.12;
export const SUPPORT_CONTACT_NONE_M = 0.2;
/** How fast the support palm takes hold of, or lets go of, the gun when the clip changes. */
const SUPPORT_BLEND_PER_S = 1 / 0.15;

interface GripBinding {
  readonly node: pc.GraphNode;
  readonly weaponToBind: pc.Mat4;
}

// The gloves curl about local Z. Match the thumb axis to each modeled grip.
const TRIGGER_ROTATION = new pc.Quat().setFromEulerAngles(-110, 0, 0);
const SUPPORT_ROTATION = new pc.Quat().setFromEulerAngles(-90, 0, 0);

function bindGrip(weapon: WeaponGlbInstance, bone: string): GripBinding {
  const node = weapon.boneNodes.get(bone) ?? weapon.rootEntity;
  const weaponToBind = new pc.Mat4().invert(node.getWorldTransform()).mul(weapon.rootEntity.getWorldTransform());
  return { node, weaponToBind };
}

/** How much of the support-palm correction to apply for a palm this far from the gun. */
export function supportContactWeight(distanceM: number): number {
  const c = Math.min(1, Math.max(0, (SUPPORT_CONTACT_NONE_M - distanceM) / (SUPPORT_CONTACT_NONE_M - SUPPORT_CONTACT_FULL_M)));
  return c * c * (3 - 2 * c);
}

/**
 * The clip that owns the arms: the upper-body layer while it is mostly blended in, else the base
 * layer. Without the `_Southpaw` suffix.
 */
export function armsClipName(glb: CombatantGlbInstance): string | undefined {
  const anim = glb.animComponent;
  const upper = anim?.layers?.find((layer) => layer !== anim.baseLayer && (layer.weight ?? 0) > 0.5);
  return (upper ?? anim?.baseLayer)?.activeState?.replace('_Southpaw', '');
}

/** Seats the hands on a gun that is already glued to the animated trigger hand. */
export class CombatantWeaponHands {
  private readonly trigger: GripBinding;
  private readonly support: GripBinding;
  private readonly arm = new CombatantSupportGrip();
  private readonly frame = new pc.Mat4();
  private readonly inverse = new pc.Mat4();
  private readonly palm = new pc.Vec3();
  private readonly current = new pc.Vec3();
  private readonly local = new pc.Vec3();
  private readonly targetRotation = new pc.Quat();
  private readonly baseInverse = new pc.Quat();
  /** 0..1: how firmly the support palm is on the gun at all, eased so a new clip does not pop it. */
  private supportBlend = 0;

  public constructor(private readonly weapon: WeaponGlbInstance) {
    this.trigger = bindGrip(weapon, 'Bone_Root');
    this.support = weapon.weaponId === 'm590_shotgun' ? bindGrip(weapon, 'Bone_Pump') : this.trigger;
  }

  /**
   * Turns the trigger wrist onto the grip (the palm is already there, since the gun follows it),
   * and lays the support palm on the forend only when the clip has it within reach. With `dt`
   * the reach eases in and out over a few frames; without it (tests, the sidearm) it snaps.
   * `supportArmIntact` false drops the hand at once: there is no arm left to ease.
   */
  public sync(
    glb: CombatantGlbInstance, triggerHand: ActiveFiringHand, useSupport: boolean, dt?: number,
    supportArmIntact = true, triggerGlued = false,
  ): void {
    const weaponId = this.weapon.weaponId;
    const useM4Grips = weaponId === 'm4a1_carbine' && useSupport;
    const fire = this.weapon.animComponent?.baseLayer?.activeState === this.weapon.fireClipName;
    if (triggerGlued && !fire) {
      // The gun is glued to the baked trigger fist (CombatantWeaponGrip.seatInFist): already seated.
    } else if (useM4Grips) {
      const offset = triggerHand === 'RIGHT' ? M4A1_PALM_OFFSET_X : -M4A1_PALM_OFFSET_X;
      this.syncHand(glb, triggerHand, this.trigger, TRIGGER_GRIPS[weaponId], 0.052, offset, TRIGGER_ROTATION);
    } else if (fire) {
      // The fire clip moves the grip bone; the trigger hand rides it for the length of the clip.
      this.syncHand(glb, triggerHand, this.trigger, TRIGGER_GRIPS[weaponId], 0.052);
    }
    const rail = SUPPORT_RAILS[weaponId];
    const step = dt === undefined ? 1 : Math.min(1, Math.max(0, dt) * SUPPORT_BLEND_PER_S);
    this.supportBlend += ((useSupport ? 1 : 0) - this.supportBlend) * step;
    if (!supportArmIntact) this.supportBlend = 0;
    if (this.supportBlend < 1e-3 || !rail) return;
    const hand = oppositeSide(triggerHand);
    const palmOffset = useM4Grips ? M4A1_PALM_OFFSET_X : weaponId === 'silver_talon_50ae' ? 0.035 : 0;
    const lateral = hand === 'RIGHT' ? palmOffset : -palmOffset;
    this.syncSupport(glb, hand, rail, lateral, useM4Grips ? SUPPORT_ROTATION : undefined);
  }

  private syncSupport(
    glb: CombatantGlbInstance, side: ActiveFiringHand, rail: readonly [pc.Vec3, pc.Vec3], lateral: number,
    gripRotation?: pc.Quat,
  ): void {
    const hand = glb.boneNodes.get(HAND_ZONE[side]);
    if (!hand) return;
    this.frame.mul2(this.support.node.getWorldTransform(), this.support.weaponToBind);
    // Where the clip put the support palm, in the gun's frame, and the nearest point on the rail.
    this.current.copy(hand.up).mulScalar(0.05).add(hand.getPosition());
    this.inverse.copy(this.frame).invert().transformPoint(this.current, this.local);
    const [near, far] = rail;
    const span = far.z - near.z;
    const railT = (z: number) => (Math.abs(span) < 1e-6 ? 0 : Math.min(1, Math.max(0, (z - near.z) / span)));
    this.palm.lerp(near, far, railT(this.local.z));
    this.palm.x += lateral;
    const weight = supportContactWeight(this.local.distance(this.palm)) * this.supportBlend;
    if (weight <= 1e-3) return;
    this.frame.transformPoint(this.palm, this.palm);
    this.palm.lerp(this.current, this.palm, weight);
    this.gripRotation(hand, this.frame, gripRotation);
    if (weight < 1) this.targetRotation.slerp(hand.getRotation(), this.targetRotation, weight);
    this.arm.syncPalm(glb, side, this.palm, this.targetRotation, 0.05);
  }

  private syncHand(
    glb: CombatantGlbInstance, side: ActiveFiringHand, binding: GripBinding, grip: pc.Vec3, offset: number,
    lateralOffset = 0,
    gripRotation?: pc.Quat,
  ): void {
    const hand = glb.boneNodes.get(HAND_ZONE[side]);
    if (!hand) return;
    this.frame.mul2(binding.node.getWorldTransform(), binding.weaponToBind);
    this.palm.copy(grip);
    this.palm.x += lateralOffset;
    this.frame.transformPoint(this.palm, this.palm);
    this.gripRotation(hand, this.frame, gripRotation);
    this.arm.syncPalm(glb, side, this.palm, this.targetRotation, offset);
  }

  /** The hand rotation that seats it on the grip, or keeps its current one relative to the gun. */
  private gripRotation(hand: pc.GraphNode, frame: pc.Mat4, gripRotation?: pc.Quat): void {
    this.targetRotation.setFromMat4(frame);
    if (gripRotation) {
      this.targetRotation.mul(gripRotation);
    } else {
      this.baseInverse.copy(this.weapon.rootEntity.getRotation()).invert();
      this.targetRotation.mul(this.baseInverse).mul(hand.getRotation());
    }
    this.targetRotation.normalize();
  }
}
