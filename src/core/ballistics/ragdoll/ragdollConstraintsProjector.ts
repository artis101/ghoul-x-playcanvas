import {
  GhoulZoneId,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import {
  add,
  dot,
  length,
  lengthSq,
  normalize,
  scale,
  sub,
  cross,
} from '../vec3.ts';
import { getRagdollParticleRef } from './ragdollParticles.ts';

export function projectConstraintsAndAnatomyOnce(target: TargetHealthState, floorY: number): void {
  for (const c of target.ragdollConstraints) {
    const pA = getRagdollParticleRef(target, c.nodeA);
    const pB = getRagdollParticleRef(target, c.nodeB);
    if (!pA.active && !pB.active) continue;
    if (pA.componentId !== pB.componentId) continue;

    const delta = sub(pB.position, pA.position);
    const dist = length(delta);
    if (dist < 1e-6) continue;

    let targetDist = dist;
    if (dist < c.minLength) targetDist = c.minLength;
    else if (dist > c.maxLength) targetDist = c.maxLength;
    else continue;

    const wA = pA.active ? 1 / pA.massKg : 0;
    const wB = pB.active ? 1 / pB.massKg : 0;
    const wSum = wA + wB;
    if (wSum < 1e-8) continue;

    const diff = (dist - targetDist) / dist;
    const corr = scale(delta, (diff * c.stiffness) / wSum);

    if (pA.active) {
      pA.position.x += corr.x * wA;
      pA.position.y += corr.y * wA;
      pA.position.z += corr.z * wA;
    }
    if (pB.active) {
      pB.position.x -= corr.x * wB;
      pB.position.y -= corr.y * wB;
      pB.position.z -= corr.z * wB;
    }
  }

  if (target.isRagdollActive) {
    const pelvis = target.ragdollBones.PELVIS_GROIN;
    const abdomen = target.ragdollBones.TORSO_LOWER_ABDOMEN;
    const thorax = target.ragdollBones.TORSO_UPPER_THORAX;
    const shL = target.ragdollBones.SHOULDER_LEFT;
    const shR = target.ragdollBones.SHOULDER_RIGHT;
    const tL = target.ragdollBones.THIGH_LEFT;
    const tR = target.ragdollBones.THIGH_RIGHT;

    // 1. Torso Axial Anti-Twist Guard
    if (
      pelvis.componentId === 'BODY' && abdomen.componentId === 'BODY' && thorax.componentId === 'BODY' &&
      shL.componentId === 'BODY' && shR.componentId === 'BODY' && tL.componentId === 'BODY' && tR.componentId === 'BODY'
    ) {
      const spineAxis = normalize(sub(thorax.position, pelvis.position));
      const hipVec = sub(tR.position, tL.position);
      const hipOrtho = sub(hipVec, scale(spineAxis, dot(hipVec, spineAxis)));
      const shVec = sub(shR.position, shL.position);
      const shOrtho = sub(shVec, scale(spineAxis, dot(shVec, spineAxis)));

      const hipLen = length(hipOrtho);
      const shLen = length(shOrtho);
      if (hipLen > 0.08 && shLen > 0.12) {
        const hipDir = scale(hipOrtho, 1 / hipLen);
        const shDir = scale(shOrtho, 1 / shLen);
        if (dot(hipDir, shDir) < 0.72) {
          const targetDir = normalize(add(shDir, scale(hipDir, 0.85)));
          const halfSpan = shLen * 0.5;
          const midSh = scale(add(shL.position, shR.position), 0.5);
          const desL = add(midSh, scale(targetDir, -halfSpan));
          const desR = add(midSh, scale(targetDir, halfSpan));
          shL.position = add(scale(shL.position, 0.55), scale(desL, 0.45));
          shR.position = add(scale(shR.position, 0.55), scale(desR, 0.45));
        }
      }
    }

    // 2. Head / Jaw Anti-Spin Guard
    const cranium = target.ragdollBones.HEAD_CRANIUM;
    const jaw = target.ragdollBones.HEAD_FACE_JAW;
    if (cranium.componentId === 'BODY' && jaw.componentId === 'BODY' && cranium.goreMode !== 'CRANIAL_POP' && shL.componentId === 'BODY' && shR.componentId === 'BODY') {
      const shRight = normalize(sub(shR.position, shL.position));
      const spUp = normalize(sub(thorax.position, abdomen.position));
      const thoraxFwd = normalize(cross(shRight, spUp));
      if (length(thoraxFwd) > 0.5) {
        const jawRel = sub(jaw.position, cranium.position);
        const jawLen = length(jawRel);
        if (jawLen > 0.04) {
          const jawDir = scale(jawRel, 1 / jawLen);
          if (dot(jawDir, thoraxFwd) < 0.35) {
            const clampedDir = normalize(add(jawDir, scale(thoraxFwd, 0.75)));
            const desJaw = add(cranium.position, scale(clampedDir, jawLen));
            jaw.position = add(scale(jaw.position, 0.5), scale(desJaw, 0.5));
          }
        }
      }
    }

    // 3. Anatomical Knee Anti-Hyperextension Check
    if (tL.componentId === pelvis.componentId && tR.componentId === pelvis.componentId && abdomen.componentId === pelvis.componentId) {
      const pUp = normalize(sub(abdomen.position, pelvis.position));
      const pRight = sub(tR.position, tL.position);
      const pFwd = normalize(cross(pRight, pUp));

      if (length(pFwd) > 0.5) {
        for (const side of ['LEFT', 'RIGHT'] as const) {
          const thigh = target.ragdollBones[side === 'LEFT' ? 'THIGH_LEFT' : 'THIGH_RIGHT'];
          const knee = target.ragdollBones[side === 'LEFT' ? 'KNEE_LEFT' : 'KNEE_RIGHT'];
          const shin = target.ragdollBones[side === 'LEFT' ? 'SHIN_LEFT' : 'SHIN_RIGHT'];
          if (knee.componentId === thigh.componentId && shin.componentId === knee.componentId) {
            const mid = scale(add(thigh.position, shin.position), 0.5);
            const kneeOffset = sub(knee.position, mid);
            const fwdProj = dot(kneeOffset, pFwd);
            if (fwdProj < -0.01) {
              const push = scale(pFwd, (-0.01 - fwdProj) * 0.70);
              knee.position.x += push.x;
              knee.position.y += push.y;
              knee.position.z += push.z;
            }
          }
        }
      }
    }

    // 4. Forearm & Hand vs Torso Self-Collision Pushout
    if (pelvis.componentId === 'BODY' && thorax.componentId === 'BODY') {
      const seg = sub(thorax.position, pelvis.position);
      const segLenSq = lengthSq(seg);
      if (segLenSq > 1e-4) {
        const armZones: GhoulZoneId[] = ['FOREARM_LEFT', 'HAND_LEFT', 'FOREARM_RIGHT', 'HAND_RIGHT'];
        const minChestClearanceM = 0.155;
        for (const az of armZones) {
          const armBone = target.ragdollBones[az];
          if (armBone.componentId !== 'BODY') continue;
          const tProj = Math.max(0, Math.min(1, dot(sub(armBone.position, pelvis.position), seg) / segLenSq));
          const closestOnSpine = add(pelvis.position, scale(seg, tProj));
          const radial = sub(armBone.position, closestOnSpine);
          const rDist = length(radial);
          if (rDist > 1e-5 && rDist < minChestClearanceM) {
            const pushOut = scale(radial, ((minChestClearanceM - rDist) / rDist) * 0.65);
            armBone.position = add(armBone.position, pushOut);
          }
        }
      }
    }
  }

  // 5. Floor & Range Barrier Collision Projection
  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    const active = (target.isRagdollActive || b.componentId !== 'BODY') && b.goreMode !== 'CRANIAL_POP';
    if (!active) continue;

    const minFloor = floorY + b.radiusM;
    if (b.position.y < minFloor) b.position.y = minFloor;
    if (b.position.x < -9.7) b.position.x = -9.7;
    if (b.position.x > 9.7) b.position.x = 9.7;
  }

  for (const aId of ALL_AUX_PARTICLES) {
    const a = target.auxParticles[aId];
    if (!target.isRagdollActive && a.componentId === 'BODY') continue;
    const minFloor = floorY + a.radiusM;
    if (a.position.y < minFloor) a.position.y = minFloor;
  }
}
