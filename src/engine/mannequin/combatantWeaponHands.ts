import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import * as pc from 'playcanvas';
import type { ActiveFiringHand } from '../ai/tacticalAiTypes.ts';
import type { CombatantGlbInstance, WeaponAssetId, WeaponGlbInstance } from '../assets/glbLoader.ts';
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
  silver_talon_50ae: [new pc.Vec3(0, -0.038, -0.016), new pc.Vec3(0, -0.038, -0.016)],
};

// The support palm only snaps onto the gun when the clip already has it nearly there. Kimodo's
// support hand lands a few centimetres off the forend; anything further means the clip has let
// go on purpose (a flinch, a clutch, a wave), and pulling it back would undo the animation.
export const SUPPORT_CONTACT_FULL_M = 0.12;
export const SUPPORT_CONTACT_NONE_M = 0.2;

// The rebaked two-handed carry and aim clips leave the support palm well off the forend (35-58 cm
// in CombatReadyIdle, up to 67 cm in LongGunAim, 81 cm in Walk, 88 cm in Strafe): Kimodo had no
// prop to hold. In those clips the hand is meant to be on the gun, so it reaches much further
// before letting go; the narrow band above still guards every other clip, where a hand off the
// gun is on purpose. Re-taking these clips with the hands on the prop would let this go.
export const LOOSE_SUPPORT_FULL_M = 0.95;
export const LOOSE_SUPPORT_NONE_M = 1.1;
const LOOSE_SUPPORT_CLIPS: ReadonlySet<string> = new Set([
  'CombatReadyIdle', 'LongGunAim', 'Walk', 'WalkBackward', 'StrafeLeft', 'StrafeRight',
]);
const LONG_GUNS: ReadonlySet<WeaponAssetId> = new Set(['m4a1_carbine', 'm590_shotgun', 'msg90_sniper']);
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
export function supportContactWeight(distanceM: number, loose = false): number {
  const full = loose ? LOOSE_SUPPORT_FULL_M : SUPPORT_CONTACT_FULL_M;
  const none = loose ? LOOSE_SUPPORT_NONE_M : SUPPORT_CONTACT_NONE_M;
  const c = Math.min(1, Math.max(0, (none - distanceM) / (none - full)));
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

/** True while a long gun is held in a clip whose authored support palm is not on the gun. */
export function isLooseSupportClip(glb: CombatantGlbInstance, weaponId: WeaponAssetId): boolean {
  const clip = armsClipName(glb);
  return LONG_GUNS.has(weaponId) && clip !== undefined && LOOSE_SUPPORT_CLIPS.has(clip);
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
  private readonly shoulderLocal = new pc.Vec3();
  private readonly targetRotation = new pc.Quat();
  private readonly baseInverse = new pc.Quat();
  /** 0..1: how far the support palm's reach has eased toward the loose clips' wide band. */
  private looseBlend = 0;
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
    supportArmIntact = true,
  ): void {
    const weaponId = this.weapon.weaponId;
    const useM4Grips = weaponId === 'm4a1_carbine' && useSupport;
    const fire = this.weapon.animComponent?.baseLayer?.activeState === this.weapon.fireClipName;
    if (useM4Grips) {
      const offset = triggerHand === 'RIGHT' ? M4A1_PALM_OFFSET_X : -M4A1_PALM_OFFSET_X;
      this.syncHand(glb, triggerHand, this.trigger, TRIGGER_GRIPS[weaponId], 0.052, offset, TRIGGER_ROTATION);
    } else if (fire) {
      // The fire clip moves the grip bone; the trigger hand rides it for the length of the clip.
      this.syncHand(glb, triggerHand, this.trigger, TRIGGER_GRIPS[weaponId], 0.052);
    }
    const rail = SUPPORT_RAILS[weaponId];
    const loose = useSupport && isLooseSupportClip(glb, weaponId);
    const step = dt === undefined ? 1 : Math.min(1, Math.max(0, dt) * SUPPORT_BLEND_PER_S);
    this.looseBlend += ((loose ? 1 : 0) - this.looseBlend) * step;
    this.supportBlend += ((useSupport ? 1 : 0) - this.supportBlend) * step;
    if (!supportArmIntact) this.supportBlend = 0;
    if (this.supportBlend < 1e-3 || !rail) return;
    const hand = oppositeSide(triggerHand);
    const palmOffset = useM4Grips ? M4A1_PALM_OFFSET_X : weaponId === 'silver_talon_50ae' ? 0.022 : 0;
    const lateral = hand === 'RIGHT' ? palmOffset : -palmOffset;
    this.syncSupport(glb, hand, rail, lateral, useM4Grips ? SUPPORT_ROTATION : undefined);
  }

  private syncSupport(
    glb: CombatantGlbInstance, side: ActiveFiringHand, rail: readonly [pc.Vec3, pc.Vec3], lateral: number,
    gripRotation?: pc.Quat,
  ): void {
    const hand = glb.boneNodes.get(`HAND_${side}`);
    if (!hand) return;
    this.frame.mul2(this.support.node.getWorldTransform(), this.support.weaponToBind);
    // Where the clip put the support palm, in the gun's frame, and the nearest point on the rail.
    this.current.copy(hand.up).mulScalar(0.05).add(hand.getPosition());
    this.inverse.copy(this.frame).invert().transformPoint(this.current, this.local);
    const [near, far] = rail;
    const span = far.z - near.z;
    const railT = (z: number) => (Math.abs(span) < 1e-6 ? 0 : Math.min(1, Math.max(0, (z - near.z) / span)));
    let t = railT(this.local.z);
    const shoulder = glb.boneNodes.get(`UPPER_ARM_${side}`);
    if (this.looseBlend > 0 && shoulder) {
      // A loose clip's palm says nothing about where on the forend it belongs; the stretch of rail
      // nearest the shoulder is the one the arm can best reach.
      this.inverse.transformPoint(shoulder.getPosition(), this.shoulderLocal);
      t += (railT(this.shoulderLocal.z) - t) * this.looseBlend;
    }
    this.palm.lerp(near, far, t);
    this.palm.x += lateral;
    const distance = this.local.distance(this.palm);
    const narrow = supportContactWeight(distance);
    const wide = supportContactWeight(distance, true);
    const weight = (narrow + (wide - narrow) * this.looseBlend) * this.supportBlend;
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
    const hand = glb.boneNodes.get(`HAND_${side}`);
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
