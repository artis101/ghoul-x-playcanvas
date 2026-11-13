import {
  GhoulZoneId,
  RagdollBoneState,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import {
  add,
  cross,
  dot,
  length,
  lengthSq,
  normalize,
  scale,
  sub,
  Vec3Like,
} from '../vec3.ts';
import {
  type RagdollSolverScratch,
  isResolvedParticleActive,
  resolveRagdollSolverScratch,
} from './ragdollSolverScratch.ts';

const RAGDOLL_WORLD_BOUND_XZ_M = 320.0;

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

function applyDampedGuardShift(bone: RagdollBoneState, delta: Vec3Like, prevFollow = 0.78): void {
  bone.position.x += delta.x;
  bone.position.y += delta.y;
  bone.position.z += delta.z;
  const follow = bone.grounded ? Math.max(0.88, prevFollow) : prevFollow;
  bone.prevPosition.x += delta.x * follow;
  bone.prevPosition.y += delta.y * follow;
  bone.prevPosition.z += delta.z * follow;
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
      const shRight = normalize(sub(shL.position, shR.position));
      const spUp = normalize(sub(thorax.position, abdomen.position));
      const thoraxFwd = normalize(cross(shRight, spUp));
      if (length(thoraxFwd) > 0.5) {
        const jawRel = sub(jaw.position, cranium.position);
        const jawLen = length(jawRel);
        if (jawLen > 0.04) {
          const jawDir = scale(jawRel, 1 / jawLen);
          if (dot(jawDir, thoraxFwd) < 0.25) {
            const clampedDir = normalize(add(jawDir, scale(thoraxFwd, 0.65)));
            const desJawRel = scale(clampedDir, jawLen);
            const corr = scale(sub(desJawRel, jawRel), 0.35);
            const wCranium = 1 / cranium.massKg;
            const wJaw = 1 / jaw.massKg;
            const wSum = wCranium + wJaw;
            applyDampedGuardShift(jaw, scale(corr, wJaw / wSum), 0.85);
            applyDampedGuardShift(cranium, scale(corr, -wCranium / wSum), 0.85);
          }
        }
      }
    }

    // 2. Gentle Elbow Anti-Hyperextension + Forearm/Hand vs Torso Self-Collision Pushout
    if (pelvis.componentId === 'BODY' && thorax.componentId === 'BODY') {
      const shRight = normalize(sub(shL.position, shR.position));
      const spUp = normalize(sub(thorax.position, pelvis.position));
      const chestFwd = normalize(cross(shRight, spUp));
      if (length(chestFwd) > 0.5) {
        for (const side of ['RIGHT', 'LEFT'] as const) {
          const upper = target.ragdollBones[side === 'RIGHT' ? 'UPPER_ARM_RIGHT' : 'UPPER_ARM_LEFT'];
          const forearm = target.ragdollBones[side === 'RIGHT' ? 'FOREARM_RIGHT' : 'FOREARM_LEFT'];
          const hand = target.ragdollBones[side === 'RIGHT' ? 'HAND_RIGHT' : 'HAND_LEFT'];
          if (upper.componentId === 'BODY' && forearm.componentId === 'BODY' && hand.componentId === 'BODY') {
            const midArm = scale(add(upper.position, hand.position), 0.5);
            const elbowOff = sub(forearm.position, midArm);
            // Elbows bend forward/inward; prevent extreme backward hyperextension behind the back plane
            const fwdDot = dot(elbowOff, chestFwd);
            if (fwdDot > 0.08) {
              const corr = scale(chestFwd, (0.08 - fwdDot) * 0.35);
              applyDampedGuardShift(forearm, scale(corr, 0.5), 0.85);
              applyDampedGuardShift(hand, scale(corr, -0.5), 0.85);
            }
          }
        }
      }

      const seg = sub(thorax.position, pelvis.position);
      const segLenSq = lengthSq(seg);
      if (segLenSq > 1e-4) {
        const armZones: GhoulZoneId[] = ['FOREARM_RIGHT', 'HAND_RIGHT', 'FOREARM_LEFT', 'HAND_LEFT'];
        const minChestClearanceM = 0.145;
        for (const az of armZones) {
          const armBone = target.ragdollBones[az];
          if (armBone.componentId !== 'BODY') continue;
          const tProj = Math.max(0, Math.min(1, dot(sub(armBone.position, pelvis.position), seg) / segLenSq));
          const closestOnSpine = add(pelvis.position, scale(seg, tProj));
          const radial = sub(armBone.position, closestOnSpine);
          const rDist = length(radial);
          if (rDist > 1e-5 && rDist < minChestClearanceM) {
            const pushOut = scale(radial, ((minChestClearanceM - rDist) / rDist) * 0.45);
            const wArm = 1 / armBone.massKg;
            const wTorso = 1 / (thorax.massKg + pelvis.massKg);
            const wSum = wArm + wTorso;
            applyDampedGuardShift(armBone, scale(pushOut, wArm / wSum), 0.85);
            applyDampedGuardShift(thorax, scale(pushOut, (-wTorso / wSum) * tProj), 0.85);
            applyDampedGuardShift(pelvis, scale(pushOut, (-wTorso / wSum) * (1 - tProj)), 0.85);
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
