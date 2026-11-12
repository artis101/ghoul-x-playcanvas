import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import * as pc from 'playcanvas';
import type { ActiveFiringHand } from '../ai/tacticalAiTypes.ts';
import type { CombatantGlbInstance, WeaponAssetId, WeaponGlbInstance } from '../assets/glbLoader.ts';
import { CombatantSupportGrip } from './combatantSupportGrip.ts';
import { M4A1_PALM_OFFSET_X, TRIGGER_GRIPS } from './combatantWeaponGrip.ts';

const SUPPORT_GRIPS: Partial<Record<WeaponAssetId, pc.Vec3>> = {
  m4a1_carbine: new pc.Vec3(0, -0.054, -0.272),
  m590_shotgun: new pc.Vec3(0, -0.037, -0.25),
  msg90_sniper: new pc.Vec3(0, -0.036, -0.25),
  silver_talon_50ae: new pc.Vec3(0, -0.038, -0.016),
};

interface GripBinding {
  readonly node: pc.GraphNode;
  readonly weaponToBind: pc.Mat4;
}

// The gloves curl about local Z. Match the thumb axis to each modeled grip.
const TRIGGER_ROTATION = new pc.Quat().setFromEulerAngles(-110, 0, 0);
const SUPPORT_ROTATION = new pc.Quat().setFromEulerAngles(-90, 0, 0);
const M4A1_TRIGGER_ROTATION = TRIGGER_ROTATION;
const M4A1_SUPPORT_ROTATION = SUPPORT_ROTATION;
const HANDGUN_PALM_OFFSET_X = 0.022;
// The support hand cups the trigger hand from the far side, angled in toward the grip.
const HANDGUN_SUPPORT_OFFSET_X = 0.04;
const HANDGUN_SUPPORT_ROTATION = new pc.Quat().setFromEulerAngles(-105, 0, 0);

function bindGrip(weapon: WeaponGlbInstance, bone: string): GripBinding {
  const node = weapon.boneNodes.get(bone) ?? weapon.rootEntity;
  const weaponToBind = new pc.Mat4().invert(node.getWorldTransform()).mul(weapon.rootEntity.getWorldTransform());
  return { node, weaponToBind };
}

export class CombatantWeaponHands {
  private readonly trigger: GripBinding;
  private readonly support: GripBinding;
  private readonly arm = new CombatantSupportGrip();
  private readonly frame = new pc.Mat4();
  private readonly palm = new pc.Vec3();
  private readonly targetRotation = new pc.Quat();
  private readonly baseInverse = new pc.Quat();
  private readonly supportBend = new pc.Vec3();
  private readonly triggerBend = new pc.Vec3();

  public constructor(private readonly weapon: WeaponGlbInstance) {
    this.trigger = bindGrip(weapon, 'Bone_Root');
    this.support = weapon.weaponId === 'm590_shotgun' ? bindGrip(weapon, 'Bone_Pump') : this.trigger;
  }

  public sync(
    glb: CombatantGlbInstance, triggerHand: ActiveFiringHand, useSupport: boolean, twoHandReadyIdle = false,
  ): void {
    const weaponId = this.weapon.weaponId;
    const useM4Grips = weaponId === 'm4a1_carbine' && useSupport;
    const fire = this.weapon.animComponent?.baseLayer?.activeState === this.weapon.fireClipName;
    if (useM4Grips) {
      const offset = triggerHand === 'RIGHT' ? M4A1_PALM_OFFSET_X : -M4A1_PALM_OFFSET_X;
      this.syncHand(glb, triggerHand, this.trigger, TRIGGER_GRIPS[weaponId], 0.052, offset, undefined, M4A1_TRIGGER_ROTATION);
    } else if (fire) {
      this.syncHand(glb, triggerHand, this.trigger, TRIGGER_GRIPS[weaponId], 0.052);
    }
    const supportGrip = SUPPORT_GRIPS[weaponId];
    if (useSupport && supportGrip) {
      const hand = oppositeSide(triggerHand);
      const palmOffset = useM4Grips ? M4A1_PALM_OFFSET_X : weaponId === 'silver_talon_50ae' ? 0.022 : 0;
      const lateralOffset = hand === 'RIGHT' ? palmOffset : -palmOffset;
      if (twoHandReadyIdle) {
        // Keep the support elbow down and in front of the vest when reaching across the chest.
        this.supportBend.set(hand === 'RIGHT' ? -0.4 : 0.4, -1, 1.6);
        glb.rootEntity.getRotation().transformVector(this.supportBend, this.supportBend);
      }
      this.syncHand(
        glb, hand, this.support, supportGrip, 0.05, lateralOffset,
        twoHandReadyIdle ? this.supportBend : undefined, useM4Grips ? M4A1_SUPPORT_ROTATION : undefined,
      );
    }
  }

  /** Solves both arms onto a weapon that is already posed in a two-handed hold. */
  public syncHold(
    glb: CombatantGlbInstance, triggerHand: ActiveFiringHand, supportGrip: pc.Vec3, oneHanded = false,
  ): void {
    const weaponId = this.weapon.weaponId;
    const side = triggerHand === 'RIGHT' ? -1 : 1;
    const palm = weaponId === 'silver_talon_50ae' ? HANDGUN_PALM_OFFSET_X : M4A1_PALM_OFFSET_X;
    const yaw = glb.rootEntity.getRotation();
    // Trigger elbow hangs down and out. Support elbow hangs under the forend.
    const handgun = weaponId === 'silver_talon_50ae';
    yaw.transformVector(this.triggerBend.set(side * 0.75, -1, -0.45), this.triggerBend);
    // A handgun is held with both elbows dropped outside the ribs, never across the body.
    yaw.transformVector(this.supportBend.set(-side * (handgun ? 0.75 : 0.45), -1, handgun ? -0.45 : 0.25), this.supportBend);
    this.syncHand(
      glb, triggerHand, this.trigger, TRIGGER_GRIPS[weaponId], 0.052, -side * palm,
      this.triggerBend, TRIGGER_ROTATION,
    );
    if (oneHanded) return;
    this.syncHand(
      glb, oppositeSide(triggerHand), this.support, supportGrip, 0.05,
      side * (handgun ? HANDGUN_SUPPORT_OFFSET_X : palm),
      this.supportBend, handgun ? HANDGUN_SUPPORT_ROTATION : SUPPORT_ROTATION,
    );
  }

  private syncHand(
    glb: CombatantGlbInstance, side: ActiveFiringHand, binding: GripBinding, grip: pc.Vec3, offset: number,
    lateralOffset = 0,
    bendDirection?: pc.Vec3,
    gripRotation?: pc.Quat,
  ): void {
    const hand = glb.boneNodes.get(`HAND_${side}`);
    if (!hand) return;

    this.frame.mul2(binding.node.getWorldTransform(), binding.weaponToBind);
    this.palm.copy(grip);
    this.palm.x += lateralOffset;
    this.frame.transformPoint(this.palm, this.palm);
    this.targetRotation.setFromMat4(this.frame);
    if (gripRotation) {
      this.targetRotation.mul(gripRotation);
    } else {
      this.baseInverse.copy(this.weapon.rootEntity.getRotation()).invert();
      this.targetRotation.mul(this.baseInverse).mul(hand.getRotation());
    }
    this.targetRotation.normalize();
    this.arm.syncPalm(glb, side, this.palm, this.targetRotation, offset, bendDirection);
  }
}
