import * as pc from 'playcanvas';
import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import {
  type ArmSide,
  createProceduralTraumaTracker,
  type ProceduralTraumaTrackerState,
  stepPinnedDeadArmVerlet,
  stepProceduralTraumaIk,
} from '../../core/ghoul/anatomy/proceduralTraumaIk.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { CombatantBoneSync } from './combatantBoneSync.ts';

export class CombatantDeadLimbOverlay {
  private readonly tracker: ProceduralTraumaTrackerState = createProceduralTraumaTracker();
  private readonly tmpFromDir = new pc.Vec3();
  private readonly tmpToDir = new pc.Vec3();
  private readonly tmpDeltaQuat = new pc.Quat();
  private readonly tmpRotQuat = new pc.Quat();
  private readonly tmpHandQuat = new pc.Quat();
  private readonly tmpElbowGoal = new pc.Vec3();
  private readonly tmpWristGoal = new pc.Vec3();

  private readonly shoulderPos: Record<ArmSide, Vec3Like> = {
    LEFT: { x: 0, y: 0, z: 0 },
    RIGHT: { x: 0, y: 0, z: 0 },
  };
  private readonly elbowPos: Record<ArmSide, Vec3Like> = {
    LEFT: { x: 0, y: 0, z: 0 },
    RIGHT: { x: 0, y: 0, z: 0 },
  };
  private readonly wristPos: Record<ArmSide, Vec3Like> = {
    LEFT: { x: 0, y: 0, z: 0 },
    RIGHT: { x: 0, y: 0, z: 0 },
  };

  public sync(
    glb: CombatantGlbInstance,
    healthState: TargetHealthState,
    boneSync: CombatantBoneSync,
    dt: number
  ): void {
    if (!healthState.alive || healthState.isRagdollActive) return;

    // 1. Sample current animated arm joint world positions before applying overlays
    for (const side of ['LEFT', 'RIGHT'] as const) {
      const upper = glb.boneNodes.get(`UPPER_ARM_${side}`);
      const forearm = glb.boneNodes.get(`FOREARM_${side}`);
      const hand = glb.boneNodes.get(`HAND_${side}`);
      if (upper) {
        const p = upper.getPosition();
        this.shoulderPos[side].x = p.x;
        this.shoulderPos[side].y = p.y;
        this.shoulderPos[side].z = p.z;
      } else {
        Object.assign(this.shoulderPos[side], healthState.ragdollBones[`UPPER_ARM_${side}`].position);
      }
      if (forearm) {
        const p = forearm.getPosition();
        this.elbowPos[side].x = p.x;
        this.elbowPos[side].y = p.y;
        this.elbowPos[side].z = p.z;
      } else {
        Object.assign(this.elbowPos[side], healthState.ragdollBones[`FOREARM_${side}`].position);
      }
      if (hand) {
        const p = hand.getPosition();
        this.wristPos[side].x = p.x;
        this.wristPos[side].y = p.y;
        this.wristPos[side].z = p.z;
      } else {
        Object.assign(this.wristPos[side], healthState.ragdollBones[`HAND_${side}`].position);
      }
    }

    // 2. Step spring-damped kinetic hit-jolt, downed pelvic/femur prop-up, and wound-clutching IK
    const traumaPose = stepProceduralTraumaIk(
      healthState,
      this.tracker,
      dt,
      this.shoulderPos,
      this.elbowPos,
      this.wristPos
    );

    let modifiedHierarchy = false;

    if (traumaPose.hasJoltOrPropUp) {
      const thorax = glb.boneNodes.get('TORSO_UPPER_THORAX');
      if (thorax) {
        this.applyAdditiveLocalRotation(
          thorax,
          traumaPose.torsoPitchAddRad,
          traumaPose.torsoYawAddRad,
          traumaPose.torsoRollAddRad
        );
        modifiedHierarchy = true;
      }
      const head = glb.boneNodes.get('HEAD_CRANIUM');
      if (head) {
        this.applyAdditiveLocalRotation(head, traumaPose.headPitchAddRad, traumaPose.headYawAddRad, 0);
        modifiedHierarchy = true;
      }
    }

    // 3. Apply wound-clutching Two-Bone IK on free functional arm
    if (traumaPose.clutchSide && traumaPose.clutchElbowWorld && traumaPose.clutchWristWorld) {
      const side = traumaPose.clutchSide;
      const upper = glb.boneNodes.get(`UPPER_ARM_${side}`);
      const forearm = glb.boneNodes.get(`FOREARM_${side}`);
      const hand = glb.boneNodes.get(`HAND_${side}`);
      if (upper && forearm && hand) {
        this.tmpHandQuat.copy(hand.getRotation());
        this.tmpElbowGoal.set(
          traumaPose.clutchElbowWorld.x,
          traumaPose.clutchElbowWorld.y,
          traumaPose.clutchElbowWorld.z
        );
        this.tmpWristGoal.set(
          traumaPose.clutchWristWorld.x,
          traumaPose.clutchWristWorld.y,
          traumaPose.clutchWristWorld.z
        );
        this.rotateToward(upper, forearm, this.tmpElbowGoal);
        this.rotateToward(forearm, hand, this.tmpWristGoal);
        hand.setRotation(this.tmpHandQuat);
        modifiedHierarchy = true;
      }
    }

    if (modifiedHierarchy) {
      glb.rootEntity.syncHierarchy();
    }

    // 4. Step pinned dead-limb Verlet pendulum on any arm disabled by brachial plexus or bone shatter
    let anyDeadLimbApplied = false;
    for (const side of ['LEFT', 'RIGHT'] as const) {
      const upperNode = glb.boneNodes.get(`UPPER_ARM_${side}`);
      if (upperNode) {
        const p = upperNode.getPosition();
        this.shoulderPos[side].x = p.x;
        this.shoulderPos[side].y = p.y;
        this.shoulderPos[side].z = p.z;
      }
      const stepped = stepPinnedDeadArmVerlet(
        healthState,
        this.tracker,
        side,
        this.shoulderPos[side],
        dt
      );
      if (stepped) {
        const armZones: GhoulZoneId[] = [
          `UPPER_ARM_${side}`,
          `FOREARM_${side}`,
          `HAND_${side}`,
        ];
        for (const zone of armZones) {
          boneSync.applyRagdollBoneToGlbJoint(glb, zone, healthState);
        }
        anyDeadLimbApplied = true;
      }
    }

    if (anyDeadLimbApplied) {
      glb.rootEntity.syncHierarchy();
    }
  }

  private applyAdditiveLocalRotation(
    node: pc.GraphNode,
    pitchRad: number,
    yawRad: number,
    rollRad: number
  ): void {
    this.tmpDeltaQuat.setFromEulerAngles(
      pitchRad * pc.math.RAD_TO_DEG,
      yawRad * pc.math.RAD_TO_DEG,
      rollRad * pc.math.RAD_TO_DEG
    );
    this.tmpRotQuat.mul2(node.getLocalRotation(), this.tmpDeltaQuat);
    node.setLocalRotation(this.tmpRotQuat);
  }

  private rotateToward(joint: pc.GraphNode, child: pc.GraphNode, goal: pc.Vec3): void {
    const origin = joint.getPosition();
    this.tmpFromDir.sub2(child.getPosition(), origin).normalize();
    this.tmpToDir.sub2(goal, origin).normalize();
    this.tmpDeltaQuat.setFromDirections(this.tmpFromDir, this.tmpToDir);
    this.tmpRotQuat.mul2(this.tmpDeltaQuat, joint.getRotation());
    joint.setRotation(this.tmpRotQuat);
  }
}
