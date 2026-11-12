import * as pc from 'playcanvas';
import type { ActiveFiringHand } from '../ai/tacticalAiTypes.ts';
import type { CombatantGlbInstance, WeaponAssetId, WeaponGlbInstance } from '../assets/glbLoader.ts';
import { CombatantSupportGrip } from './combatantSupportGrip.ts';
import { TRIGGER_GRIPS } from './combatantWeaponGrip.ts';

const SUPPORT_GRIPS: Partial<Record<WeaponAssetId, pc.Vec3>> = {
  m4a1_carbine: new pc.Vec3(0, -0.035, -0.23),
  m590_shotgun: new pc.Vec3(0, -0.037, -0.25),
  msg90_sniper: new pc.Vec3(0, -0.036, -0.25),
  silver_talon_50ae: new pc.Vec3(0, -0.038, -0.016),
};

interface GripBinding {
  readonly node: pc.GraphNode;
  readonly weaponToBind: pc.Mat4;
}

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

  public constructor(private readonly weapon: WeaponGlbInstance) {
    this.trigger = bindGrip(weapon, 'Bone_Root');
    this.support = weapon.weaponId === 'm590_shotgun' ? bindGrip(weapon, 'Bone_Pump') : this.trigger;
  }

  public sync(glb: CombatantGlbInstance, triggerHand: ActiveFiringHand, useSupport: boolean): void {
    const weaponId = this.weapon.weaponId;
    const fire = this.weapon.animComponent?.baseLayer?.activeState === this.weapon.fireClipName;
    if (fire) this.syncHand(glb, triggerHand, this.trigger, TRIGGER_GRIPS[weaponId], 0.052);
    const supportGrip = SUPPORT_GRIPS[weaponId];
    if (useSupport && supportGrip) {
      const hand = triggerHand === 'LEFT' ? 'RIGHT' : 'LEFT';
      const lateralOffset = weaponId === 'silver_talon_50ae' ? (hand === 'LEFT' ? 0.022 : -0.022) : 0;
      this.syncHand(glb, hand, this.support, supportGrip, 0.05, lateralOffset);
    }
  }

  private syncHand(
    glb: CombatantGlbInstance, side: ActiveFiringHand, binding: GripBinding, grip: pc.Vec3, offset: number,
    lateralOffset = 0,
  ): void {
    const hand = glb.boneNodes.get(`HAND_${side}`);
    if (!hand) return;

    this.frame.mul2(binding.node.getWorldTransform(), binding.weaponToBind);
    this.palm.copy(grip);
    this.palm.x += lateralOffset;
    this.frame.transformPoint(this.palm, this.palm);
    this.baseInverse.copy(this.weapon.rootEntity.getRotation()).invert();
    this.targetRotation.setFromMat4(this.frame).mul(this.baseInverse).mul(hand.getRotation()).normalize();
    this.arm.syncPalm(glb, side, this.palm, this.targetRotation, offset);
  }
}
