import * as pc from 'playcanvas';
import { solveTwoBoneIk } from '../../core/ghoul/anatomy/twoBoneIk.ts';
import type { ActiveFiringHand } from '../ai/tacticalAiTypes.ts';
import type { CombatantGlbInstance, WeaponAssetId } from '../assets/glbLoader.ts';

const SUPPORT_GRIPS: Partial<Record<WeaponAssetId, pc.Vec3>> = {
  m4a1_carbine: new pc.Vec3(0, -0.035, -0.23),
  m590_shotgun: new pc.Vec3(0, -0.037, -0.25),
  msg90_sniper: new pc.Vec3(0, -0.036, -0.25),
  silver_talon_50ae: new pc.Vec3(0, -0.038, -0.016),
};

export class CombatantSupportGrip {
  private readonly palm = new pc.Vec3();
  private readonly wristGoal = new pc.Vec3();
  private readonly elbowGoal = new pc.Vec3();
  private readonly fromDirection = new pc.Vec3();
  private readonly toDirection = new pc.Vec3();
  private readonly delta = new pc.Quat();
  private readonly rotation = new pc.Quat();
  private readonly handRotation = new pc.Quat();

  public sync(glb: CombatantGlbInstance, side: ActiveFiringHand, weapon: pc.Entity, weaponId: WeaponAssetId): void {
    const upper = glb.boneNodes.get(`UPPER_ARM_${side}`);
    const forearm = glb.boneNodes.get(`FOREARM_${side}`);
    const hand = glb.boneNodes.get(`HAND_${side}`);
    const grip = SUPPORT_GRIPS[weaponId];
    if (!upper || !forearm || !hand || !grip) return;

    this.palm.copy(grip);
    if (weaponId === 'silver_talon_50ae') this.palm.x = side === 'LEFT' ? 0.022 : -0.022;
    weapon.getWorldTransform().transformPoint(this.palm, this.palm);
    this.wristGoal.copy(hand.up).mulScalar(-0.05).add(this.palm);
    const pose = solveTwoBoneIk(upper.getPosition(), forearm.getPosition(), hand.getPosition(), this.wristGoal);
    if (!pose) return;

    this.handRotation.copy(hand.getRotation());
    this.elbowGoal.set(pose.elbow.x, pose.elbow.y, pose.elbow.z);
    this.wristGoal.set(pose.wrist.x, pose.wrist.y, pose.wrist.z);
    this.rotateToward(upper, forearm, this.elbowGoal);
    this.rotateToward(forearm, hand, this.wristGoal);
    hand.setRotation(this.handRotation);
  }

  private rotateToward(joint: pc.GraphNode, child: pc.GraphNode, goal: pc.Vec3): void {
    const origin = joint.getPosition();
    this.fromDirection.sub2(child.getPosition(), origin).normalize();
    this.toDirection.sub2(goal, origin).normalize();
    this.delta.setFromDirections(this.fromDirection, this.toDirection);
    this.rotation.mul2(this.delta, joint.getRotation());
    joint.setRotation(this.rotation);
  }
}
