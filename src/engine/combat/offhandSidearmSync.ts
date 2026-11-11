import * as pc from 'playcanvas';
import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { add, copyVec3, cross, dot, length, normalize, scale, sub, vec3 } from '../../core/ballistics/vec3.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import { isArmChainIntactAndFunctional, type ActiveFiringHand, type TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import type { OffhandSidearmRig } from './offhandSidearmTypes.ts';
import { basisVectorsToQuat, REST_ARM_BONE_FRAMES } from './offhandSidearmTypes.ts';

export class OffhandSidearmSync {
  private readonly scratchMat4 = new pc.Mat4();
  private readonly scratchQuat = new pc.Quat();
  private readonly scratchRagQuat = new pc.Quat();
  private readonly scratchDeltaQuat = new pc.Quat();
  private readonly scratchWorldQuat = new pc.Quat();
  private readonly scratchBindInvQuat = new pc.Quat();
  private readonly scratchOffsetVec = new pc.Vec3();
  private readonly scratchRotOffsetVec = new pc.Vec3();

  public sync(
    target: GhoulMannequinEntity,
    viewerWorldPos: Vec3Like,
    rig: OffhandSidearmRig,
    tacticalAi: TacticalCombatAiSystem | null,
    fxManager: GoreAndBallisticsFxManager
  ): void {
    const hs = target.healthState;
    const sidearmState = tacticalAi?.getSidearmVisualState(hs.targetId);
    const hand: ActiveFiringHand | null = sidearmState?.hand ?? null;
    const armIntact = hand !== null && isArmChainIntactAndFunctional(hs, hand);
    const notAirborne = !(hs.isRagdollActive && hs.posture === 'AIRBORNE_RAGDOLL');

    const shouldShow = Boolean(sidearmState?.visible) && hs.alive && hs.currentHp > 0 && armIntact && notAirborne;
    if (!shouldShow) {
      if (rig.wasHeldLastFrame) {
        rig.wasHeldLastFrame = false;
        const dropZone: GhoulZoneId = rig.lastHand === 'LEFT' ? 'HAND_LEFT' : 'HAND_RIGHT';
        const handBone = hs.ragdollBones[dropZone];
        const glbHandNode = target.combatantGlb?.boneNodes.get(dropZone);
        const dropPos = glbHandNode
          ? vec3(glbHandNode.getPosition().x, glbHandNode.getPosition().y, glbHandNode.getPosition().z)
          : handBone.position;
        fxManager.spawnDroppedWeaponProp('SKINHEAD_PUNK', dropPos, handBone.velocity);
      }
      rig.holderEntity.enabled = false;
      return;
    }

    const activeHand = hand!;
    rig.holderEntity.enabled = true;
    rig.wasHeldLastFrame = true;
    rig.lastHand = activeHand;

    const upperArmZone: GhoulZoneId = activeHand === 'LEFT' ? 'UPPER_ARM_LEFT' : 'UPPER_ARM_RIGHT';
    const forearmZone: GhoulZoneId = activeHand === 'LEFT' ? 'FOREARM_LEFT' : 'FOREARM_RIGHT';
    const handZone: GhoulZoneId = activeHand === 'LEFT' ? 'HAND_LEFT' : 'HAND_RIGHT';
    const handTipAuxId = activeHand === 'LEFT' ? 'HAND_TIP_LEFT' : 'HAND_TIP_RIGHT';
    const sideSign = activeHand === 'LEFT' ? -1 : 1;

    let pUpper = copyVec3(hs.ragdollBones[upperArmZone].position);
    if (target.combatantGlb && !hs.isRagdollActive) {
      const glbUpper = target.combatantGlb.boneNodes.get(upperArmZone);
      const bindUpper = target.combatantGlb.boneBindPoses.get(upperArmZone);
      const restUpper = REST_ARM_BONE_FRAMES.get(upperArmZone);
      if (glbUpper && bindUpper && restUpper) {
        const pAnim = glbUpper.getPosition();
        const qAnim = glbUpper.getRotation();
        this.scratchBindInvQuat.copy(bindUpper.modelRot).invert();
        this.scratchDeltaQuat.mul2(qAnim, this.scratchBindInvQuat);
        this.scratchOffsetVec.sub2(bindUpper.modelPos, restUpper.restPos);
        this.scratchDeltaQuat.transformVector(this.scratchOffsetVec, this.scratchRotOffsetVec);
        pUpper = vec3(pAnim.x - this.scratchRotOffsetVec.x, pAnim.y - this.scratchRotOffsetVec.y, pAnim.z - this.scratchRotOffsetVec.z);
      }
    }

    const charFwd = vec3(Math.sin(hs.yawRad), 0, Math.cos(hs.yawRad));
    const charRight = vec3(-Math.cos(hs.yawRad), 0, Math.sin(hs.yawRad));
    const aimTarget = sidearmState?.aimTargetWorld ?? vec3(viewerWorldPos.x, viewerWorldPos.y - 0.16, viewerWorldPos.z);
    let rawAimDir = normalize(sub(aimTarget, pUpper));
    if (length(rawAimDir) < 1e-4) rawAimDir = charFwd;

    const clampedY = Math.max(-0.52, Math.min(0.52, rawAimDir.y));
    let horizDir = vec3(rawAimDir.x, 0, rawAimDir.z);
    if (length(horizDir) < 1e-4) horizDir = charFwd;
    else {
      horizDir = normalize(horizDir);
      if (dot(horizDir, charFwd) < 0.25) horizDir = normalize(add(scale(charFwd, 0.72), scale(horizDir, 0.28)));
    }
    const aimDir = normalize(vec3(horizDir.x * Math.sqrt(1 - clampedY * clampedY), clampedY, horizDir.z * Math.sqrt(1 - clampedY * clampedY)));

    const drawProgress = Math.max(0, Math.min(1, sidearmState?.drawProgress ?? 1.0));
    const smoothDraw = drawProgress * drawProgress * (3 - 2 * drawProgress);
    const holsterDir = normalize(add(scale(charFwd, 0.26), vec3(charRight.x * sideSign * 0.22, -0.86, charRight.z * sideSign * 0.22)));
    const armAimDir = normalize(add(scale(holsterDir, 1 - smoothDraw), scale(aimDir, smoothDraw)));

    const elbowDir = normalize(add(armAimDir, vec3(charRight.x * sideSign * 0.12, -0.14, charRight.z * sideSign * 0.12)));
    const pForearm = add(pUpper, scale(elbowDir, 0.26));
    const wristGoal = add(pUpper, scale(armAimDir, 0.495));
    const forearmDir = normalize(sub(wristGoal, pForearm));
    const pHand = add(pForearm, scale(forearmDir, 0.25));

    const worldUp = vec3(0, 1, 0);
    const computeBasis = (segFwd: Vec3Like) => {
      let r = cross(worldUp, segFwd);
      if (length(r) < 1e-4) r = vec3(1, 0, 0);
      r = normalize(r);
      return { right: r, up: normalize(cross(segFwd, r)), forward: segFwd };
    };

    const applyBone = (zone: GhoulZoneId, pos: Vec3Like, basis: { right: Vec3Like; up: Vec3Like; forward: Vec3Like }) => {
      const b = hs.ragdollBones[zone];
      b.position = copyVec3(pos);
      b.prevPosition = copyVec3(pos);
      b.basisRight = basis.right;
      b.basisUp = basis.up;
      b.basisForward = basis.forward;
    };
    applyBone(upperArmZone, pUpper, computeBasis(elbowDir));
    applyBone(forearmZone, pForearm, computeBasis(forearmDir));
    applyBone(handZone, pHand, computeBasis(armAimDir));

    const tipAux = hs.auxParticles[handTipAuxId];
    if (tipAux && tipAux.componentId === 'BODY') {
      tipAux.position = add(pHand, scale(armAimDir, 0.09));
      tipAux.prevPosition = copyVec3(tipAux.position);
    }

    if (target.combatantGlb) {
      this.applyPosedJoint(target.combatantGlb, hs, upperArmZone);
      this.applyPosedJoint(target.combatantGlb, hs, forearmZone);
      this.applyPosedJoint(target.combatantGlb, hs, handZone);
      target.combatantGlb.rootEntity.syncHierarchy();
    } else {
      for (const z of [upperArmZone, forearmZone, handZone] as const) {
        let customBone = rig.cachedBoneEntities.get(z);
        if (customBone === undefined) {
          const found = target.rootEntity.findByName(`Bone_${z}`);
          customBone = found instanceof pc.Entity ? found : null;
          rig.cachedBoneEntities.set(z, customBone);
        }
        if (customBone) {
          const b = hs.ragdollBones[z];
          customBone.setPosition(b.position.x, b.position.y, b.position.z);
          basisVectorsToQuat(b.basisRight, b.basisUp, b.basisForward, this.scratchMat4, this.scratchQuat);
          customBone.setRotation(this.scratchQuat);
        }
      }
    }

    let gripPos = pHand;
    if (target.combatantGlb) {
      const glbHand = target.combatantGlb.boneNodes.get(handZone);
      if (glbHand) {
        const gp = glbHand.getPosition();
        gripPos = vec3(gp.x, gp.y, gp.z);
      }
    }

    const zBack = scale(armAimDir, -1);
    let xRight = cross(worldUp, zBack);
    if (length(xRight) < 1e-4) xRight = vec3(1, 0, 0);
    xRight = normalize(xRight);
    const yUp = normalize(cross(zBack, xRight));

    rig.holderEntity.setLocalPosition(gripPos.x + armAimDir.x * 0.042, gripPos.y + 0.012, gripPos.z + armAimDir.z * 0.042);
    basisVectorsToQuat(xRight, yUp, zBack, this.scratchMat4, this.scratchQuat);
    rig.holderEntity.setLocalRotation(this.scratchQuat);
  }

  private applyPosedJoint(glb: CombatantGlbInstance, hs: TargetHealthState, zone: GhoulZoneId): void {
    const boneNode = glb.boneNodes.get(zone);
    const bind = glb.boneBindPoses.get(zone);
    const rest = REST_ARM_BONE_FRAMES.get(zone);
    if (!boneNode || !bind || !rest) return;

    const boneState = hs.ragdollBones[zone];
    if (!boneState) return;

    basisVectorsToQuat(boneState.basisRight, boneState.basisUp, boneState.basisForward, this.scratchMat4, this.scratchRagQuat);
    this.scratchDeltaQuat.mul2(this.scratchRagQuat, rest.restRotInv);
    this.scratchWorldQuat.mul2(this.scratchDeltaQuat, bind.modelRot);
    this.scratchOffsetVec.sub2(bind.modelPos, rest.restPos);
    this.scratchDeltaQuat.transformVector(this.scratchOffsetVec, this.scratchRotOffsetVec);

    boneNode.setPosition(boneState.position.x + this.scratchRotOffsetVec.x, boneState.position.y + this.scratchRotOffsetVec.y, boneState.position.z + this.scratchRotOffsetVec.z);
    boneNode.setRotation(this.scratchWorldQuat);
  }
}
