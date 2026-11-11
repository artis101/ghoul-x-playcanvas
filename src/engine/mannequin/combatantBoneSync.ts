import * as pc from 'playcanvas';
import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import { basisToQuat, REST_RAGDOLL_FRAMES } from './combatantPoseConstants.ts';

export class CombatantBoneSync {
  private readonly tmpMat4 = new pc.Mat4();
  private readonly tmpQuat = new pc.Quat();
  private readonly tmpRagQuat = new pc.Quat();
  private readonly tmpDeltaQuat = new pc.Quat();
  private readonly tmpWorldQuat = new pc.Quat();
  private readonly tmpBindInvQuat = new pc.Quat();
  private readonly tmpOffsetVec = new pc.Vec3();
  private readonly tmpRotOffsetVec = new pc.Vec3();

  public setEntityBasisRotation(
    entity: pc.Entity,
    right: Vec3Like,
    up: Vec3Like,
    forward: Vec3Like
  ): void {
    basisToQuat(right, up, forward, this.tmpMat4, this.tmpQuat);
    entity.setLocalRotation(this.tmpQuat);
  }

  public applyRagdollBoneToGlbJoint(
    glb: CombatantGlbInstance,
    zone: GhoulZoneId,
    healthState: TargetHealthState
  ): void {
    const boneNode = glb.boneNodes.get(zone);
    const bind = glb.boneBindPoses.get(zone);
    const rest = REST_RAGDOLL_FRAMES.get(zone);
    if (!boneNode || !bind || !rest) return;

    const boneState = healthState.ragdollBones[zone];

    if (zone === 'HEAD_FACE_JAW') {
      const headState = healthState.ragdollBones.HEAD_CRANIUM;
      const headRest = REST_RAGDOLL_FRAMES.get('HEAD_CRANIUM');
      if (boneState.componentId === headState.componentId && headRest) {
        basisToQuat(
          headState.basisRight,
          headState.basisUp,
          headState.basisForward,
          this.tmpMat4,
          this.tmpRagQuat
        );
        this.tmpDeltaQuat.mul2(this.tmpRagQuat, headRest.restRotInv);
        this.tmpWorldQuat.mul2(this.tmpDeltaQuat, bind.modelRot);

        this.tmpOffsetVec.sub2(bind.modelPos, headRest.restPos);
        this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);

        boneNode.setPosition(
          headState.position.x + this.tmpRotOffsetVec.x,
          headState.position.y + this.tmpRotOffsetVec.y,
          headState.position.z + this.tmpRotOffsetVec.z
        );
        boneNode.setRotation(this.tmpWorldQuat);
        return;
      }
    }

    basisToQuat(
      boneState.basisRight,
      boneState.basisUp,
      boneState.basisForward,
      this.tmpMat4,
      this.tmpRagQuat
    );

    this.tmpDeltaQuat.mul2(this.tmpRagQuat, rest.restRotInv);
    this.tmpWorldQuat.mul2(this.tmpDeltaQuat, bind.modelRot);

    this.tmpOffsetVec.sub2(bind.modelPos, rest.restPos);
    this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);

    boneNode.setPosition(
      boneState.position.x + this.tmpRotOffsetVec.x,
      boneState.position.y + this.tmpRotOffsetVec.y,
      boneState.position.z + this.tmpRotOffsetVec.z
    );
    boneNode.setRotation(this.tmpWorldQuat);
  }

  public alignZoneNodeFromAnimatedGlbJoint(
    glb: CombatantGlbInstance,
    zone: GhoulZoneId,
    zoneNode: pc.Entity
  ): boolean {
    const boneNode = glb.boneNodes.get(zone);
    const bind = glb.boneBindPoses.get(zone);
    const rest = REST_RAGDOLL_FRAMES.get(zone);
    if (!boneNode || !bind || !rest) return false;

    const pAnim = boneNode.getPosition();
    const qAnim = boneNode.getRotation();

    this.tmpBindInvQuat.copy(bind.modelRot).invert();
    this.tmpDeltaQuat.mul2(qAnim, this.tmpBindInvQuat);
    this.tmpWorldQuat.mul2(this.tmpDeltaQuat, rest.restRot);

    this.tmpOffsetVec.sub2(bind.modelPos, rest.restPos);
    this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);

    zoneNode.setLocalPosition(
      pAnim.x - this.tmpRotOffsetVec.x,
      pAnim.y - this.tmpRotOffsetVec.y,
      pAnim.z - this.tmpRotOffsetVec.z
    );
    zoneNode.setLocalRotation(this.tmpWorldQuat);
    return true;
  }
}
