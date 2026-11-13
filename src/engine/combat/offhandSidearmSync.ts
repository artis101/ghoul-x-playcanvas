import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import * as pc from 'playcanvas';
import type { GhoulZoneId, Vec3Like } from '../../contracts/ballistics.ts';
import { add, copyVec3, dot, length, normalize, scale, sub, vec3 } from '../../core/ballistics/vec3.ts';
import { clampDownedAimDirection } from '../../core/ballistics/triage/downedAimReach.ts';
import { safeOrthonormalBasis } from '../../core/ghoul/anatomy/ragdollBasisMath.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import { isArmChainIntactAndFunctional, type ActiveFiringHand, type TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import type { OffhandSidearmRig } from './offhandSidearmTypes.ts';
import { basisToQuat } from '../mannequin/combatantPoseConstants.ts';
import { CombatantWeaponGrip } from '../mannequin/combatantWeaponGrip.ts';
import { CombatantBoneSync } from '../mannequin/combatantBoneSync.ts';
import { transitionPropAttachment } from '../mannequin/propAttachmentState.ts';

const NO_SUPPORT_GRIP = new pc.Vec3();
const UPPER_ARM_M = 0.26;
const STANDING_ELBOW_BEND = { out: 0.12, down: 0.14, reach: 0.495 } as const;
// Upper arm plus forearm is 0.51 m: reaching 0.508 leaves the elbow only just unlocked.
const DOWNED_ELBOW_BEND = { out: 0.015, down: 0.02, reach: 0.508 } as const;

export class OffhandSidearmSync {
  private readonly scratchMat4 = new pc.Mat4();
  private readonly scratchQuat = new pc.Quat();
  private readonly grip = new CombatantWeaponGrip();
  private readonly boneSync = new CombatantBoneSync();

  public sync(
    target: GhoulMannequinEntity,
    viewerWorldPos: Vec3Like,
    rig: OffhandSidearmRig,
    tacticalAi: Pick<TacticalCombatAiSystem, 'getSidearmVisualState'> | null,
    fxManager?: GoreAndBallisticsFxManager
  ): boolean {
    const hs = target.healthState;
    const alive = hs.alive && hs.currentHp > 0;
    if (!alive) {
      hs.weaponDropped = true;
    }

    const sidearmState = tacticalAi?.getSidearmVisualState(hs.targetId);
    const hand: ActiveFiringHand | null = sidearmState?.hand ?? null;
    const armIntact = hand !== null && isArmChainIntactAndFunctional(hs, hand);
    const isAirborneRagdoll = hs.isRagdollActive && hs.posture === 'AIRBORNE_RAGDOLL';

    const wantsSidearm = Boolean(sidearmState?.visible) && alive && armIntact;
    const shouldBeAttached = wantsSidearm && !isAirborneRagdoll;
    const temporarilyHidden =
      (wantsSidearm && isAirborneRagdoll) ||
      (!wantsSidearm &&
        alive &&
        rig.attachmentState.kind === 'HIDDEN_TEMP' &&
        rig.attachmentState.hand === undefined);

    const transition = transitionPropAttachment(rig.attachmentState, {
      shouldBeAttached,
      temporarilyHidden,
      hand: hand ?? rig.lastHand ?? undefined,
    });
    rig.attachmentState = transition.state;
    rig.wasHeldLastFrame = transition.isVisible;
    if (transition.state.kind === 'ATTACHED' || transition.state.kind === 'HIDDEN_TEMP') {
      if (transition.state.hand) {
        rig.lastHand = transition.state.hand;
      }
    }

    if (transition.shouldSpawnDroppedProp) {
      const dropHand = transition.dropHand ?? rig.lastHand;
      const dropZone: GhoulZoneId = dropHand === 'RIGHT' ? 'HAND_RIGHT' : 'HAND_LEFT';
      const handBone = hs.ragdollBones[dropZone];
      if (rig.glbInstance && fxManager) {
        fxManager.spawnDroppedWeaponProp(
          'SKINHEAD_PUNK',
          rig.holderEntity.getPosition(),
          handBone.velocity
        );
      }
    }

    if (!transition.isVisible || !hand) {
      hs.downedAimDirWorld = null;
      rig.holderEntity.enabled = false;
      return false;
    }

    const activeHand = hand;
    rig.holderEntity.enabled = true;

    const upperArmZone: GhoulZoneId = activeHand === 'RIGHT' ? 'UPPER_ARM_RIGHT' : 'UPPER_ARM_LEFT';
    const forearmZone: GhoulZoneId = activeHand === 'RIGHT' ? 'FOREARM_RIGHT' : 'FOREARM_LEFT';
    const handZone: GhoulZoneId = activeHand === 'RIGHT' ? 'HAND_RIGHT' : 'HAND_LEFT';
    const handTipAuxId = activeHand === 'RIGHT' ? 'HAND_TIP_RIGHT' : 'HAND_TIP_LEFT';
    const sideSign = activeHand === 'RIGHT' ? -1 : 1;

    const pUpper = copyVec3(hs.ragdollBones[upperArmZone].position);
    const charFwd = vec3(Math.sin(hs.yawRad), 0, Math.cos(hs.yawRad));
    const charRight = vec3(-Math.cos(hs.yawRad), 0, Math.sin(hs.yawRad));
    const aimTarget = sidearmState?.aimTargetWorld ?? vec3(viewerWorldPos.x, viewerWorldPos.y - 0.16, viewerWorldPos.z);
    let rawAimDir = normalize(sub(aimTarget, pUpper));
    if (length(rawAimDir) < 1e-4) rawAimDir = charFwd;

    // A combatant lying on the ground points the pistol at a threat standing over it or past
    // its feet, but only as far round as its shoulder can really turn.
    const downed = hs.isRagdollActive;
    if (downed) rawAimDir = clampDownedAimDirection(hs, rawAimDir);
    const clampedY = downed
      ? Math.max(-0.1, Math.min(0.96, rawAimDir.y))
      : Math.max(-0.52, Math.min(0.52, rawAimDir.y));
    let horizDir = vec3(rawAimDir.x, 0, rawAimDir.z);
    if (length(horizDir) < 1e-4) horizDir = charFwd;
    else {
      horizDir = normalize(horizDir);
      if (!downed && dot(horizDir, charFwd) < 0.25) {
        horizDir = normalize(add(scale(charFwd, 0.72), scale(horizDir, 0.28)));
      }
    }
    const aimDir = normalize(vec3(horizDir.x * Math.sqrt(1 - clampedY * clampedY), clampedY, horizDir.z * Math.sqrt(1 - clampedY * clampedY)));
    // A downed shooter's head turns to look along the gun (see groundedPoseTargets).
    hs.downedAimDirWorld = downed && (sidearmState?.drawProgress ?? 1) >= 1 ? aimDir : null;

    const glb = target.combatantGlb;
    const animatedHand = glb?.boneNodes.get(handZone);
    // The aim clip is a two-handed stance: the gun arm reaches across to meet a support hand.
    // With that hand gone, or while the pistol is still coming out of the holster, the arm is
    // posed here instead, straight out from its own shoulder.
    const supportHand: ActiveFiringHand = oppositeSide(activeHand);
    // On the ground the other arm props the body up, so the pistol is always held one-handed.
    const twoHanded =
      !downed && isArmChainIntactAndFunctional(hs, supportHand) && (sidearmState?.drawProgress ?? 1) >= 1;
    if (twoHanded && target.isPlayingPistolAim && glb && animatedHand && rig.glbInstance) {
      const palm = add(animatedHand.getPosition(), scale(animatedHand.up, 0.052));
      this.grip.align(rig.holderEntity, rig.glbInstance.rootEntity, 'silver_talon_50ae', palm, aimDir);
      rig.hands?.sync(glb, activeHand, false);
      return true;
    }

    const drawProgress = Math.max(0, Math.min(1, sidearmState?.drawProgress ?? 1.0));
    const smoothDraw = drawProgress * drawProgress * (3 - 2 * drawProgress);
    const holsterDir = normalize(add(scale(charFwd, 0.26), vec3(charRight.x * sideSign * 0.22, -0.86, charRight.z * sideSign * 0.22)));
    const armAimDir = normalize(add(scale(holsterDir, 1 - smoothDraw), scale(aimDir, smoothDraw)));

    // Standing, the elbow stays soft and tucked a little out and down. Lying on the ground, the
    // pistol is pushed out at the end of a straight arm, elbow locked, and points where it can.
    const elbowBend = downed ? DOWNED_ELBOW_BEND : STANDING_ELBOW_BEND;
    const elbowDir = normalize(
      add(armAimDir, vec3(charRight.x * sideSign * elbowBend.out, -elbowBend.down, charRight.z * sideSign * elbowBend.out))
    );
    const pForearm = add(pUpper, scale(elbowDir, UPPER_ARM_M));
    const wristGoal = add(pUpper, scale(armAimDir, elbowBend.reach));
    const forearmDir = normalize(sub(wristGoal, pForearm));
    const pHand = add(pForearm, scale(forearmDir, 0.25));

    const worldUp = vec3(0, 1, 0);
    const computeBasis = (dir: Vec3Like) => safeOrthonormalBasis(scale(dir, -1), worldUp, charRight);
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
      this.boneSync.applyRagdollBoneToGlbJoint(target.combatantGlb, upperArmZone, hs);
      this.boneSync.applyRagdollBoneToGlbJoint(target.combatantGlb, forearmZone, hs);
      this.boneSync.applyRagdollBoneToGlbJoint(target.combatantGlb, handZone, hs);
      target.combatantGlb.rootEntity.syncHierarchy();
    } else {
      for (const z of [upperArmZone, forearmZone, handZone] as const) {
        let customBone = rig.cachedBoneEntities.get(z);
        if (customBone === undefined) {
          const found = target.rootEntity.children.find((node) => node.name === `Bone_${z}`);
          customBone = found instanceof pc.Entity ? found : null;
          rig.cachedBoneEntities.set(z, customBone);
        }
        if (customBone) {
          const b = hs.ragdollBones[z];
          customBone.setPosition(b.position.x, b.position.y, b.position.z);
          basisToQuat(b.basisRight, b.basisUp, b.basisForward, this.scratchMat4, this.scratchQuat);
          customBone.setRotation(this.scratchQuat);
        }
      }
    }

    if (rig.glbInstance) {
      const glbHand = target.combatantGlb?.boneNodes.get(handZone);
      const palm = glbHand
        ? add(glbHand.getPosition(), scale(glbHand.up, 0.052))
        : add(pHand, scale(armAimDir, 0.052));
      this.grip.align(rig.holderEntity, rig.glbInstance.rootEntity, 'silver_talon_50ae', palm, armAimDir);
      // Wrap the fist round the grip, wrist behind it, instead of leaving the hand flat.
      if (glb) rig.hands?.syncHold(glb, activeHand, NO_SUPPORT_GRIP, true);
    }
    return true;
  }

}
