import * as pc from 'playcanvas';
import { solveTwoBoneIk } from '../../core/ghoul/anatomy/twoBoneIk.ts';
import type { ActiveFiringHand } from '../ai/tacticalAiTypes.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';

export class CombatantSupportGrip {
  private readonly wristGoal = new pc.Vec3();
  private readonly elbowGoal = new pc.Vec3();
  private readonly fromDirection = new pc.Vec3();
  private readonly toDirection = new pc.Vec3();
  private readonly delta = new pc.Quat();
  private readonly rotation = new pc.Quat();

  public syncPalm(
    glb: CombatantGlbInstance, side: ActiveFiringHand, palm: pc.Vec3, handRotation: pc.Quat, palmOffset: number,
  ): void {
    const upper = glb.boneNodes.get(`UPPER_ARM_${side}`);
    const forearm = glb.boneNodes.get(`FOREARM_${side}`);
    const hand = glb.boneNodes.get(`HAND_${side}`);
    if (!upper || !forearm || !hand) return;
    handRotation.transformVector(pc.Vec3.UP, this.wristGoal);
    this.wristGoal.mulScalar(-palmOffset).add(palm);
    const pose = solveTwoBoneIk(upper.getPosition(), forearm.getPosition(), hand.getPosition(), this.wristGoal);
    if (!pose) return;

    this.elbowGoal.set(pose.elbow.x, pose.elbow.y, pose.elbow.z);
    this.wristGoal.set(pose.wrist.x, pose.wrist.y, pose.wrist.z);
    this.rotateToward(upper, forearm, this.elbowGoal);
    this.rotateToward(forearm, hand, this.wristGoal);
    hand.setRotation(handRotation);
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
