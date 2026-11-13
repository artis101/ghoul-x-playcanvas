import * as pc from 'playcanvas';
import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import {
  type ArmSide,
  createProceduralTraumaTracker,
  type ProceduralTraumaGating,
  type ProceduralTraumaTrackerState,
  stepHitJolt,
  stepPinnedDeadArmVerlet,
} from '../../core/ghoul/anatomy/proceduralTraumaIk.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { CombatantBoneSync } from './combatantBoneSync.ts';

/**
 * The procedural layer left on top of the body clip: the graze jolt (chest and head kick back and
 * spring home) and the pendulum of an arm that still hangs on but no longer works. Everything
 * else a living body does is in its clips.
 */
export class CombatantDeadLimbOverlay {
  private readonly tracker: ProceduralTraumaTrackerState = createProceduralTraumaTracker();
  private readonly tmpDeltaQuat = new pc.Quat();
  private readonly tmpRotQuat = new pc.Quat();
  private readonly shoulderPos: Record<ArmSide, Vec3Like> = {
    RIGHT: { x: 0, y: 0, z: 0 },
    LEFT: { x: 0, y: 0, z: 0 },
  };

  public sync(
    glb: CombatantGlbInstance,
    healthState: TargetHealthState,
    boneSync: CombatantBoneSync,
    dt: number,
    gating: ProceduralTraumaGating = {},
    distalStumpAnimated = true
  ): void {
    if (!healthState.alive || healthState.isRagdollActive) return;

    this.applyJolt(glb, healthState, dt, gating);

    // An arm disabled by a plexus hit or a shattered bone swings from the animated shoulder.
    let anyDeadLimbApplied = false;
    for (const side of ['RIGHT', 'LEFT'] as const) {
      const upperNode = glb.boneNodes.get(`UPPER_ARM_${side}`);
      if (upperNode) {
        const p = upperNode.getPosition();
        this.shoulderPos[side].x = p.x;
        this.shoulderPos[side].y = p.y;
        this.shoulderPos[side].z = p.z;
      } else {
        Object.assign(this.shoulderPos[side], healthState.ragdollBones[`UPPER_ARM_${side}`].position);
      }
      const stepped = stepPinnedDeadArmVerlet(
        healthState, this.tracker, side, this.shoulderPos[side], dt, distalStumpAnimated
      );
      if (stepped) {
        const armZones: GhoulZoneId[] = [`UPPER_ARM_${side}`, `FOREARM_${side}`, `HAND_${side}`];
        for (const zone of armZones) boneSync.applyRagdollBoneToGlbJoint(glb, zone, healthState);
        anyDeadLimbApplied = true;
      }
    }
    if (anyDeadLimbApplied) glb.rootEntity.syncHierarchy();
  }

  private applyJolt(
    glb: CombatantGlbInstance, healthState: TargetHealthState, dt: number, gating: ProceduralTraumaGating,
  ): void {
    const jolt = stepHitJolt(healthState, this.tracker, dt, gating);
    if (!jolt.hasJolt) return;
    const thorax = glb.boneNodes.get('TORSO_UPPER_THORAX');
    if (thorax) this.applyAdditiveLocalRotation(thorax, jolt.torsoPitchAddRad, jolt.torsoYawAddRad, jolt.torsoRollAddRad);
    const head = glb.boneNodes.get('HEAD_CRANIUM');
    if (head) this.applyAdditiveLocalRotation(head, jolt.headPitchAddRad, jolt.headYawAddRad, 0);
    glb.rootEntity.syncHierarchy();
  }

  /**
   * A body playing its death clip: a hit only kicks the chest and head (no restart of the clip),
   * and nothing else is layered on the fall.
   */
  public syncDyingJolt(glb: CombatantGlbInstance, healthState: TargetHealthState, dt: number): void {
    if (healthState.isRagdollActive) return;
    this.applyJolt(glb, healthState, dt, {});
  }

  private applyAdditiveLocalRotation(node: pc.GraphNode, pitchRad: number, yawRad: number, rollRad: number): void {
    this.tmpDeltaQuat.setFromEulerAngles(
      pitchRad * pc.math.RAD_TO_DEG,
      yawRad * pc.math.RAD_TO_DEG,
      rollRad * pc.math.RAD_TO_DEG
    );
    this.tmpRotQuat.mul2(node.getLocalRotation(), this.tmpDeltaQuat);
    node.setLocalRotation(this.tmpRotQuat);
  }
}
