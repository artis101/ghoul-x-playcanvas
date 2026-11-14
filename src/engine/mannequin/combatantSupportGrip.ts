import * as pc from 'playcanvas';
import { solveTwoBoneIk } from '../../core/ghoul/anatomy/twoBoneIk.ts';
import type { ActiveFiringHand } from '../ai/tacticalAiTypes.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import { FOREARM_ZONE, HAND_ZONE, UPPER_ARM_ZONE } from './armZoneKeys.ts';

/**
 * Contact IK for a palm on a grip. It is only ever asked to move a hand a few centimetres (the
 * callers gate it by distance), so the elbow keeps the plane the clip gave it.
 */
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
    handRotation.transformVector(pc.Vec3.UP, this.wristGoal);
    this.wristGoal.mulScalar(-palmOffset).add(palm);
    if (this.reach(glb, side, this.wristGoal)) {
      glb.boneNodes.get(HAND_ZONE[side])?.setRotation(handRotation);
    }
  }

  /** Bends the arm so the wrist lands on the goal. Leaves the hand's own rotation alone. */
  public reach(glb: CombatantGlbInstance, side: ActiveFiringHand, wrist: pc.Vec3): boolean {
    const upper = glb.boneNodes.get(UPPER_ARM_ZONE[side]);
    const forearm = glb.boneNodes.get(FOREARM_ZONE[side]);
    const hand = glb.boneNodes.get(HAND_ZONE[side]);
    if (!upper || !forearm || !hand) return false;
    const pose = solveTwoBoneIk(upper.getPosition(), forearm.getPosition(), hand.getPosition(), wrist);
    if (!pose) return false;

    this.elbowGoal.set(pose.elbow.x, pose.elbow.y, pose.elbow.z);
    this.wristGoal.set(pose.wrist.x, pose.wrist.y, pose.wrist.z);
    this.rotateToward(upper, forearm, this.elbowGoal);
    this.rotateToward(forearm, hand, this.wristGoal);
    return true;
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
