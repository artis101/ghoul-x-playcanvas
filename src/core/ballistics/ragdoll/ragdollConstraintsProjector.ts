import {
  GhoulZoneId,
  RagdollBoneState,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import {
  type MutableVec3,
  Vec3Like,
  addScaledInto,
  crossInto,
  dot,
  length,
  lengthSq,
  normalizeInto,
  scaleInto,
  subInto,
} from '../vec3.ts';
import {
  type RagdollSolverScratch,
  isResolvedParticleActive,
  resolveRagdollSolverScratch,
} from './ragdollSolverScratch.ts';

const RAGDOLL_WORLD_BOUND_XZ_M = 320.0;

// These hold values within one call of the guards and never leave this module.
const SH_RIGHT: MutableVec3 = { x: 0, y: 0, z: 0 };
const SP_UP: MutableVec3 = { x: 0, y: 0, z: 0 };
const BODY_FWD: MutableVec3 = { x: 0, y: 0, z: 0 };
const JAW_REL: MutableVec3 = { x: 0, y: 0, z: 0 };
const JAW_DIR: MutableVec3 = { x: 0, y: 0, z: 0 };
const JAW_TARGET: MutableVec3 = { x: 0, y: 0, z: 0 };
const GUARD_CORR: MutableVec3 = { x: 0, y: 0, z: 0 };
const ELBOW_OFF: MutableVec3 = { x: 0, y: 0, z: 0 };
const SPINE_SEG: MutableVec3 = { x: 0, y: 0, z: 0 };
const ARM_REL: MutableVec3 = { x: 0, y: 0, z: 0 };
const SPINE_POINT: MutableVec3 = { x: 0, y: 0, z: 0 };
const RADIAL: MutableVec3 = { x: 0, y: 0, z: 0 };
const PUSH_OUT: MutableVec3 = { x: 0, y: 0, z: 0 };
const GUARD_SIDES = ['RIGHT', 'LEFT'] as const;
const ARM_GUARD_ZONES: readonly GhoulZoneId[] = ['FOREARM_RIGHT', 'HAND_RIGHT', 'FOREARM_LEFT', 'HAND_LEFT'];

function clampParticleWorldBoundsXZ(pos: Vec3Like, prevPos: Vec3Like, radiusM: number): void {
  const minBound = -RAGDOLL_WORLD_BOUND_XZ_M + radiusM;
  const maxBound = RAGDOLL_WORLD_BOUND_XZ_M - radiusM;
  if (pos.x < minBound) {
    pos.x = minBound;
    if (prevPos.x < minBound) prevPos.x = minBound;
  } else if (pos.x > maxBound) {
    pos.x = maxBound;
    if (prevPos.x > maxBound) prevPos.x = maxBound;
  }
  if (pos.z < minBound) {
    pos.z = minBound;
    if (prevPos.z < minBound) prevPos.z = minBound;
  } else if (pos.z > maxBound) {
    pos.z = maxBound;
    if (prevPos.z > maxBound) prevPos.z = maxBound;
  }
}

/**
 * Keeps a particle on or above the floor. A guard or joint limit that presses a resting particle
 * downward also drags its previous position down; left below the floor, that would read as the
 * particle having shot upward this step.
 */
function clampParticleToFloor(pos: Vec3Like, prevPos: Vec3Like, minY: number): void {
  if (pos.y < minY) pos.y = minY;
  if (prevPos.y < minY) prevPos.y = minY;
}

function applyDampedGuardShift(bone: RagdollBoneState, dx: number, dy: number, dz: number, prevFollow = 0.78): void {
  bone.position.x += dx;
  bone.position.y += dy;
  bone.position.z += dz;
  const follow = bone.grounded ? Math.max(0.88, prevFollow) : prevFollow;
  bone.prevPosition.x += dx * follow;
  bone.prevPosition.y += dy * follow;
  bone.prevPosition.z += dz * follow;
}

export function projectConstraintsAndAnatomyOnce(
  target: TargetHealthState,
  floorY: number,
  scratch: RagdollSolverScratch = resolveRagdollSolverScratch(target)
): void {
  // This loop runs for every constraint, 14 times a sub-step, for every falling body. It works on
  // the particles in place: a vector or a lookup by name here is paid thousands of times a frame.
  const resolved = scratch.constraints;
  for (let i = 0; i < scratch.constraintCount; i++) {
    const r = resolved[i];
    const pA = r.a;
    const pB = r.b;
    const activeA = isResolvedParticleActive(target, pA, r.gateA);
    const activeB = isResolvedParticleActive(target, pB, r.gateB);
    if (!activeA && !activeB) continue;
    if (pA.componentId !== pB.componentId) continue;

    const c = r.constraint;
    const posA = pA.position;
    const posB = pB.position;
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const dz = posB.z - posA.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-6) continue;

    let targetDist = dist;
    if (dist < c.minLength) targetDist = c.minLength;
    else if (dist > c.maxLength) targetDist = c.maxLength;
    else continue;

    const wA = activeA ? 1 / pA.massKg : 0;
    const wB = activeB ? 1 / pB.massKg : 0;
    const wSum = wA + wB;
    if (wSum < 1e-8) continue;

    const diff = (dist - targetDist) / dist;
    const corrScale = (diff * c.stiffness) / wSum;
    const corrX = dx * corrScale;
    const corrY = dy * corrScale;
    const corrZ = dz * corrScale;

    if (activeA) {
      posA.x += corrX * wA;
      posA.y += corrY * wA;
      posA.z += corrZ * wA;
    }
    if (activeB) {
      posB.x -= corrX * wB;
      posB.y -= corrY * wB;
      posB.z -= corrZ * wB;
    }
  }

  if (target.isRagdollActive) {
    const pelvis = target.ragdollBones.PELVIS_GROIN;
    const abdomen = target.ragdollBones.TORSO_LOWER_ABDOMEN;
    const thorax = target.ragdollBones.TORSO_UPPER_THORAX;
    const shL = target.ragdollBones.SHOULDER_LEFT;
    const shR = target.ragdollBones.SHOULDER_RIGHT;

    // 1. Symmetric Head / Jaw Anti-Spin Guard
    const cranium = target.ragdollBones.HEAD_CRANIUM;
    const jaw = target.ragdollBones.HEAD_FACE_JAW;
    if (cranium.componentId === 'BODY' && jaw.componentId === 'BODY' && cranium.goreMode !== 'CRANIAL_POP' && shL.componentId === 'BODY' && shR.componentId === 'BODY') {
      subInto(SH_RIGHT, shL.position, shR.position);
      normalizeInto(SH_RIGHT, SH_RIGHT);
      subInto(SP_UP, thorax.position, abdomen.position);
      normalizeInto(SP_UP, SP_UP);
      crossInto(BODY_FWD, SH_RIGHT, SP_UP);
      normalizeInto(BODY_FWD, BODY_FWD);
      if (length(BODY_FWD) > 0.5) {
        subInto(JAW_REL, jaw.position, cranium.position);
        const jawLen = length(JAW_REL);
        if (jawLen > 0.04) {
          scaleInto(JAW_DIR, JAW_REL, 1 / jawLen);
          if (dot(JAW_DIR, BODY_FWD) < 0.25) {
            addScaledInto(JAW_TARGET, JAW_DIR, BODY_FWD, 0.65);
            normalizeInto(JAW_TARGET, JAW_TARGET);
            scaleInto(JAW_TARGET, JAW_TARGET, jawLen);
            subInto(GUARD_CORR, JAW_TARGET, JAW_REL);
            scaleInto(GUARD_CORR, GUARD_CORR, 0.35);
            const wCranium = 1 / cranium.massKg;
            const wJaw = 1 / jaw.massKg;
            const wSum = wCranium + wJaw;
            const jawShare = wJaw / wSum;
            const craniumShare = -wCranium / wSum;
            applyDampedGuardShift(jaw, GUARD_CORR.x * jawShare, GUARD_CORR.y * jawShare, GUARD_CORR.z * jawShare, 0.85);
            applyDampedGuardShift(cranium, GUARD_CORR.x * craniumShare, GUARD_CORR.y * craniumShare, GUARD_CORR.z * craniumShare, 0.85);
          }
        }
      }
    }

    // 2. Gentle Elbow Anti-Hyperextension + Forearm/Hand vs Torso Self-Collision Pushout
    if (pelvis.componentId === 'BODY' && thorax.componentId === 'BODY') {
      subInto(SH_RIGHT, shL.position, shR.position);
      normalizeInto(SH_RIGHT, SH_RIGHT);
      subInto(SP_UP, thorax.position, pelvis.position);
      normalizeInto(SP_UP, SP_UP);
      crossInto(BODY_FWD, SH_RIGHT, SP_UP);
      normalizeInto(BODY_FWD, BODY_FWD);
      if (length(BODY_FWD) > 0.5) {
        for (const side of GUARD_SIDES) {
          const upper = target.ragdollBones[side === 'RIGHT' ? 'UPPER_ARM_RIGHT' : 'UPPER_ARM_LEFT'];
          const forearm = target.ragdollBones[side === 'RIGHT' ? 'FOREARM_RIGHT' : 'FOREARM_LEFT'];
          const hand = target.ragdollBones[side === 'RIGHT' ? 'HAND_RIGHT' : 'HAND_LEFT'];
          if (upper.componentId === 'BODY' && forearm.componentId === 'BODY' && hand.componentId === 'BODY') {
            ELBOW_OFF.x = forearm.position.x - (upper.position.x + hand.position.x) * 0.5;
            ELBOW_OFF.y = forearm.position.y - (upper.position.y + hand.position.y) * 0.5;
            ELBOW_OFF.z = forearm.position.z - (upper.position.z + hand.position.z) * 0.5;
            // Elbows bend forward/inward; prevent extreme backward hyperextension behind the back plane
            const fwdDot = dot(ELBOW_OFF, BODY_FWD);
            if (fwdDot > 0.08) {
              scaleInto(GUARD_CORR, BODY_FWD, (0.08 - fwdDot) * 0.35);
              applyDampedGuardShift(forearm, GUARD_CORR.x * 0.5, GUARD_CORR.y * 0.5, GUARD_CORR.z * 0.5, 0.85);
              applyDampedGuardShift(hand, GUARD_CORR.x * -0.5, GUARD_CORR.y * -0.5, GUARD_CORR.z * -0.5, 0.85);
            }
          }
        }
      }

      subInto(SPINE_SEG, thorax.position, pelvis.position);
      const segLenSq = lengthSq(SPINE_SEG);
      if (segLenSq > 1e-4) {
        const minChestClearanceM = 0.145;
        for (const az of ARM_GUARD_ZONES) {
          const armBone = target.ragdollBones[az];
          if (armBone.componentId !== 'BODY') continue;
          subInto(ARM_REL, armBone.position, pelvis.position);
          const tProj = Math.max(0, Math.min(1, dot(ARM_REL, SPINE_SEG) / segLenSq));
          addScaledInto(SPINE_POINT, pelvis.position, SPINE_SEG, tProj);
          subInto(RADIAL, armBone.position, SPINE_POINT);
          const rDist = length(RADIAL);
          if (rDist > 1e-5 && rDist < minChestClearanceM) {
            scaleInto(PUSH_OUT, RADIAL, ((minChestClearanceM - rDist) / rDist) * 0.45);
            const wArm = 1 / armBone.massKg;
            const wTorso = 1 / (thorax.massKg + pelvis.massKg);
            const wSum = wArm + wTorso;
            const armShare = wArm / wSum;
            const thoraxShare = (-wTorso / wSum) * tProj;
            const pelvisShare = (-wTorso / wSum) * (1 - tProj);
            applyDampedGuardShift(armBone, PUSH_OUT.x * armShare, PUSH_OUT.y * armShare, PUSH_OUT.z * armShare, 0.85);
            applyDampedGuardShift(thorax, PUSH_OUT.x * thoraxShare, PUSH_OUT.y * thoraxShare, PUSH_OUT.z * thoraxShare, 0.85);
            applyDampedGuardShift(pelvis, PUSH_OUT.x * pelvisShare, PUSH_OUT.y * pelvisShare, PUSH_OUT.z * pelvisShare, 0.85);
          }
        }
      }
    }
  }

  // 3. Floor & World XZ Safety Boundary Projection
  for (const b of scratch.bones) {
    const active = (target.isRagdollActive || b.componentId !== 'BODY') && b.goreMode !== 'CRANIAL_POP';
    if (!active) continue;

    clampParticleToFloor(b.position, b.prevPosition, floorY + b.radiusM);
    clampParticleWorldBoundsXZ(b.position, b.prevPosition, b.radiusM);
  }

  for (const a of scratch.aux) {
    if (!target.isRagdollActive && a.componentId === 'BODY') continue;
    clampParticleToFloor(a.position, a.prevPosition, floorY + a.radiusM);
    clampParticleWorldBoundsXZ(a.position, a.prevPosition, a.radiusM);
  }
}
