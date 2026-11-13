import * as pc from 'playcanvas';
import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { BoneBindPose, CombatantGlbInstance } from '../assets/glbLoader.ts';
import { ALL_AUX_PARTICLES, AUX_PARTICLE_REST_LOCAL } from '../../core/ghoul/anatomy.ts';
import { basisToQuat, REST_RAGDOLL_FRAMES } from './combatantPoseConstants.ts';

const RETARGETED_ARM_BINDS = new WeakMap<BoneBindPose, BoneBindPose>();

function getColliderBind(glb: CombatantGlbInstance, zone: GhoulZoneId): BoneBindPose | undefined {
  const bind = glb.boneBindPoses.get(zone);
  const isArm = zone.startsWith('UPPER_ARM_') || zone.startsWith('FOREARM_') || zone.startsWith('HAND_');
  if (!bind || !isArm) return bind;

  const cached = RETARGETED_ARM_BINDS.get(bind);
  if (cached) return cached;
  const rest = REST_RAGDOLL_FRAMES.get(zone);
  if (!rest || bind.modelPos.distance(rest.restPos) < 0.001) return bind;

  // The mesh binds in an A-pose and the collider rig rests with arms forward.
  // Match arm joints by pivot and align their longitudinal axes.
  const limbAxis = new pc.Vec3().sub2(rest.restDistalPos, rest.restPos).normalize();
  const modelAxis = bind.modelRot.transformVector(pc.Vec3.UP);
  const modelRot = new pc.Quat().setFromDirections(modelAxis, limbAxis).mul(bind.modelRot);
  const colliderBind = { modelPos: rest.restPos, modelRot };
  RETARGETED_ARM_BINDS.set(bind, colliderBind);
  return colliderBind;
}

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
    entity.setRotation(this.tmpQuat);
  }

  public applyRagdollBoneToGlbJoint(
    glb: CombatantGlbInstance,
    zone: GhoulZoneId,
    healthState: TargetHealthState
  ): void {
    const boneNode = glb.boneNodes.get(zone);
    const bind = getColliderBind(glb, zone);
    const rest = REST_RAGDOLL_FRAMES.get(zone);
    if (!boneNode || !bind || !rest) return;

    const boneState = healthState.ragdollBones[zone];

    // A burst head is hidden, but its bones still ride the neck so the stump cap and anything
    // skinned to them stay on the body instead of hanging where the head was hit.
    if (healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP' && (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW')) {
      const neckState = healthState.ragdollBones.NECK_CERVICAL;
      const neckRest = REST_RAGDOLL_FRAMES.get('NECK_CERVICAL');
      if (neckRest) {
        this.placeRigidlyOn(boneNode, bind, neckState, neckRest);
        return;
      }
    }

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

  /** Carries a joint along with another bone, keeping the offset the two have at rest. */
  private placeRigidlyOn(
    boneNode: pc.GraphNode,
    bind: BoneBindPose,
    carrier: TargetHealthState['ragdollBones'][GhoulZoneId],
    carrierRest: { restPos: pc.Vec3; restRotInv: pc.Quat }
  ): void {
    basisToQuat(carrier.basisRight, carrier.basisUp, carrier.basisForward, this.tmpMat4, this.tmpRagQuat);
    this.tmpDeltaQuat.mul2(this.tmpRagQuat, carrierRest.restRotInv);
    this.tmpWorldQuat.mul2(this.tmpDeltaQuat, bind.modelRot);
    this.tmpOffsetVec.sub2(bind.modelPos, carrierRest.restPos);
    this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);
    boneNode.setPosition(
      carrier.position.x + this.tmpRotOffsetVec.x,
      carrier.position.y + this.tmpRotOffsetVec.y,
      carrier.position.z + this.tmpRotOffsetVec.z
    );
    boneNode.setRotation(this.tmpWorldQuat);
  }

  public readAnimatedBone(
    glb: CombatantGlbInstance,
    zone: GhoulZoneId,
    state: TargetHealthState
  ): void {
    const boneNode = glb.boneNodes.get(zone);
    const bind = getColliderBind(glb, zone);
    const rest = REST_RAGDOLL_FRAMES.get(zone);
    const bone = state.ragdollBones[zone];
    if (!boneNode || !bind || !rest || bone.componentId !== 'BODY') return;

    const pAnim = boneNode.getPosition();
    this.tmpBindInvQuat.copy(bind.modelRot).invert();
    this.tmpDeltaQuat.mul2(boneNode.getRotation(), this.tmpBindInvQuat);
    this.tmpWorldQuat.mul2(this.tmpDeltaQuat, rest.restRot);

    this.tmpOffsetVec.sub2(bind.modelPos, rest.restPos);
    this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);
    const position = {
      x: pAnim.x - this.tmpRotOffsetVec.x,
      y: pAnim.y - this.tmpRotOffsetVec.y,
      z: pAnim.z - this.tmpRotOffsetVec.z,
    };
    Object.assign(bone.position, position);
    Object.assign(bone.prevPosition, position);
    this.tmpOffsetVec.sub2(rest.restDistalPos, bind.modelPos);
    this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);
    this.tmpRotOffsetVec.add(pAnim);
    Object.assign(bone.distalPosition, this.tmpRotOffsetVec);
    this.readAxis(pc.Vec3.RIGHT, bone.basisRight);
    this.readAxis(pc.Vec3.UP, bone.basisUp);
    this.readAxis(pc.Vec3.BACK, bone.basisForward);
  }

  public readAnimatedAuxParticles(glb: CombatantGlbInstance, state: TargetHealthState): void {
    for (const id of ALL_AUX_PARTICLES) {
      const aux = state.auxParticles[id];
      const node = glb.boneNodes.get(aux.parentZone);
      const bind = getColliderBind(glb, aux.parentZone);
      if (!node || !bind || aux.componentId !== 'BODY') continue;

      this.tmpBindInvQuat.copy(bind.modelRot).invert();
      this.tmpDeltaQuat.mul2(node.getRotation(), this.tmpBindInvQuat);
      const rest = AUX_PARTICLE_REST_LOCAL[id].localPos;
      this.tmpOffsetVec.set(rest.x, rest.y, rest.z).sub(bind.modelPos);
      this.tmpDeltaQuat.transformVector(this.tmpOffsetVec, this.tmpRotOffsetVec);
      this.tmpRotOffsetVec.add(node.getPosition());
      Object.assign(aux.position, this.tmpRotOffsetVec);
      Object.assign(aux.prevPosition, this.tmpRotOffsetVec);
    }
  }

  private readAxis(axis: pc.Vec3, out: Vec3Like): void {
    this.tmpWorldQuat.transformVector(axis, this.tmpOffsetVec);
    out.x = this.tmpOffsetVec.x;
    out.y = this.tmpOffsetVec.y;
    out.z = this.tmpOffsetVec.z;
  }
}
