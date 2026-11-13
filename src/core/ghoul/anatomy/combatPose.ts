import { sideSignX, supportSide } from './handedness.ts';
import { GhoulZoneId } from '../../../contracts/ballistics/ghoulZoneContracts';
import { ALL_GHOUL_ZONES } from './ghoulHierarchyTypes';
import { TargetHealthState } from '../../../contracts/ballistics/targetHealthContracts';
import { Vec3Like, add, copyVec3, scale, sub } from '../../ballistics/vec3';
import { ALL_AUX_PARTICLES, AUX_PARTICLE_REST_LOCAL } from './ghoulAuxParticles';
import { GHOUL_ZONE_HIERARCHY } from './ghoulHierarchy';
import { recomputeRagdollBasisVectors } from './ragdollBasis';
import { isFallingReaction } from '../../ballistics/trauma/woundReactionTimings.ts';

/**
 * Updates standing / injured procedural combat pose for living, non-ragdolled combatant.
 */
export function updateStandingCombatPose(target: TargetHealthState, elapsedTimeS: number): void {
  if (target.isRagdollActive || !target.alive || target.poseFromAnimation) return;

  const cosY = Math.cos(target.yawRad);
  const sinY = Math.sin(target.yawRad);
  const toWorld = (lx: number, ly: number, lz: number): Vec3Like => ({
    x: target.worldPosition.x + (lx * cosY + lz * sinY),
    y: target.worldPosition.y + ly,
    z: target.worldPosition.z + (-lx * sinY + lz * cosY),
  });

  const breath = Math.sin(elapsedTimeS * 2.6) * 0.008;
  const swayX = Math.cos(elapsedTimeS * 1.35) * 0.007;

  const rx = target.activeReaction;
  const rxWeight =
    rx.type !== 'NONE' && rx.durationS > 0
      ? Math.sin(Math.min(1, rx.timerS / rx.durationS) * Math.PI) * rx.intensity
      : 0;

  const rightLegSevered =
    target.severedZones.has('THIGH_RIGHT') ||
    target.severedZones.has('KNEE_RIGHT') ||
    target.severedZones.has('SHIN_RIGHT') ||
    target.severedZones.has('FOOT_RIGHT');
  const leftLegSevered =
    target.severedZones.has('THIGH_LEFT') ||
    target.severedZones.has('KNEE_LEFT') ||
    target.severedZones.has('SHIN_LEFT') ||
    target.severedZones.has('FOOT_LEFT');
  const hasSeveredLeg = rightLegSevered || leftLegSevered;

  const rxProg = rx.type !== 'NONE' && rx.durationS > 0 ? Math.min(1, rx.timerS / rx.durationS) : 0;
  const staggerProg =
    hasSeveredLeg && rx.durationS > 0 ? Math.min(1, rx.timerS / rx.durationS) : 0;
  // Fall, loss and collapse sink the hips over the clip so the ragdoll takes over low. The
  // animated GLB pose replaces this whenever it is present; this is only the proxy skeleton.
  const fallSink = isFallingReaction(rx.type) ? rxProg * rxProg * 0.35 : 0;
  // The collapse starts with the knees giving way, before the hips sink.
  const collapseDrop = rx.type === 'DOWNED_COLLAPSE' ? 0.12 * Math.min(1, rxProg * 4) : 0;
  const legFlinchDrop = rx.type === 'LEG_FLINCH_RIGHT' || rx.type === 'LEG_FLINCH_LEFT' ? 0.06 * rxWeight : 0;
  const kneeBuckleDrop =
    (hasSeveredLeg
      ? 0.10 + staggerProg * 0.24
      : !target.rightLegFunctional || !target.leftLegFunctional
        ? 0.28
        : 0) +
    fallSink +
    collapseDrop +
    legFlinchDrop;
  const legStaggerX = rightLegSevered
    ? -(0.08 + staggerProg * 0.16)
    : leftLegSevered
      ? 0.08 + staggerProg * 0.16
      : rx.type === 'LEG_BUCKLE_RIGHT'
        ? -0.09 * rxWeight
        : rx.type === 'LEG_BUCKLE_LEFT'
          ? 0.09 * rxWeight
          : rx.type === 'LEG_FLINCH_RIGHT'
            ? -0.04 * rxWeight
            : rx.type === 'LEG_FLINCH_LEFT'
              ? 0.04 * rxWeight
              : 0;
  const gutFoldZ = rx.type === 'GUT_FOLD' ? 0.14 * rxWeight : 0;
  const gutFoldY = rx.type === 'GUT_FOLD' ? -0.09 * rxWeight : 0;
  const chestBackZ = rx.type === 'CHEST_STAGGER' ? -0.11 * rxWeight : 0;
  const headSnapZ = rx.type === 'HEAD_SNAP' ? -0.10 * rxWeight : 0;

  for (const zone of ALL_GHOUL_ZONES) {
    const bone = target.ragdollBones[zone];
    if (bone.severed) continue;

    const base = GHOUL_ZONE_HIERARCHY[zone].jointLocalPos;
    let lx = base.x;
    let ly = base.y;
    let lz = base.z;

    if (
      zone !== 'SHIN_RIGHT' &&
      zone !== 'FOOT_RIGHT' &&
      zone !== 'SHIN_LEFT' &&
      zone !== 'FOOT_LEFT'
    ) {
      ly -= kneeBuckleDrop;
      lx += legStaggerX * Math.max(0.35, (base.y - 0.45) / 1.1);
    }

    if (zone === 'KNEE_RIGHT' && !target.rightLegFunctional && !rightLegSevered) {
      ly = 0.22;
      lz = 0.16;
    }
    if (zone === 'KNEE_LEFT' && !target.leftLegFunctional && !leftLegSevered) {
      ly = 0.22;
      lz = 0.16;
    }

    if (
      zone === 'TORSO_UPPER_THORAX' ||
      zone === 'NECK_CERVICAL' ||
      zone === 'HEAD_CRANIUM' ||
      zone === 'HEAD_FACE_JAW' ||
      zone === 'SHOULDER_RIGHT' ||
      zone === 'SHOULDER_LEFT'
    ) {
      ly += breath + gutFoldY;
      lx += swayX;
      lz += gutFoldZ + chestBackZ;
    }

    if (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW') {
      lz += headSnapZ;
    }

    const wrenchRight = rx.type === 'ARM_WRENCH_RIGHT' || rx.type === 'ARM_LOST_RIGHT';
    const wrenchLeft = rx.type === 'ARM_WRENCH_LEFT' || rx.type === 'ARM_LOST_LEFT';
    if (wrenchRight && (zone === 'SHOULDER_RIGHT' || zone === 'UPPER_ARM_RIGHT')) {
      lz -= 0.10 * rxWeight;
    }
    if (wrenchLeft && (zone === 'SHOULDER_LEFT' || zone === 'UPPER_ARM_LEFT')) {
      lz -= 0.10 * rxWeight;
    }

    if ((!target.leftArmFunctional || target.weaponDropped) && zone === 'HAND_LEFT') {
      lx = 0.33;
      ly = 0.88 - kneeBuckleDrop;
      lz = 0.04;
    }
    if ((!target.rightArmFunctional || target.weaponDropped) && zone === 'HAND_RIGHT') {
      lx = -0.33;
      ly = 0.88 - kneeBuckleDrop;
      lz = 0.04;
    }

    const clutchSide = supportSide(target.isLeftHanded);
    const clutchHandZone: GhoulZoneId = `HAND_${clutchSide}`;
    const clutchForearmZone: GhoulZoneId = `FOREARM_${clutchSide}`;
    const clutchArmFunctional = clutchSide === 'LEFT' ? target.leftArmFunctional : target.rightArmFunctional;
    const clutchSign = sideSignX(clutchSide);

    if (target.posture === 'THROAT_CLUTCH' || rx.type === 'THROAT_CLUTCH') {
      if (zone === clutchHandZone && clutchArmFunctional) {
        lx = clutchSign * 0.04;
        ly = 1.50 - kneeBuckleDrop;
        lz = 0.10;
      }
      if (zone === clutchForearmZone && clutchArmFunctional) {
        lx = clutchSign * 0.22;
        ly = 1.28 - kneeBuckleDrop;
        lz = 0.14;
      }
    }

    if (target.posture === 'GUT_HURT' || rx.type === 'GUT_FOLD') {
      if (zone === clutchHandZone && clutchArmFunctional) {
        lx = clutchSign * 0.04;
        ly = 1.08 - kneeBuckleDrop;
        lz = 0.16;
      }
    }

    const wp = toWorld(lx, ly, lz);
    bone.position = wp;
    bone.prevPosition = copyVec3(wp);
  }

  for (const side of ['RIGHT', 'LEFT'] as const) {
    const shin = target.ragdollBones[side === 'RIGHT' ? 'SHIN_RIGHT' : 'SHIN_LEFT'];
    const knee = target.ragdollBones[side === 'RIGHT' ? 'KNEE_RIGHT' : 'KNEE_LEFT'];
    const foot = target.ragdollBones[side === 'RIGHT' ? 'FOOT_RIGHT' : 'FOOT_LEFT'];
    if (!shin.severed && !knee.severed && !foot.severed) {
      const mid = scale(add(knee.position, foot.position), 0.5);
      shin.position = mid;
      shin.prevPosition = copyVec3(mid);
    }
  }

  for (const auxId of ALL_AUX_PARTICLES) {
    const aux = target.auxParticles[auxId];
    const parentBone = target.ragdollBones[aux.parentZone];
    if (parentBone.severed) continue;

    const restParent = GHOUL_ZONE_HIERARCHY[aux.parentZone].jointLocalPos;
    const restAux = AUX_PARTICLE_REST_LOCAL[auxId].localPos;
    const dLocal = sub(restAux, restParent);
    const dWorld = {
      x: dLocal.x * cosY + dLocal.z * sinY,
      y: dLocal.y,
      z: -dLocal.x * sinY + dLocal.z * cosY,
    };
    aux.position = add(parentBone.position, dWorld);
    aux.prevPosition = copyVec3(aux.position);
  }

  recomputeRagdollBasisVectors(target);
}
