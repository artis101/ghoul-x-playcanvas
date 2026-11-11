import { TargetHealthState } from '../../../contracts/ballistics.ts';
import {
  ALL_AUX_PARTICLES,
  ALL_GHOUL_ZONES,
  recomputeRagdollBasisVectors,
} from '../../ghoul/anatomy.ts';
import {
  add,
  copyVec3,
  length,
  lengthSq,
  scale,
  sub,
  vec3,
  Vec3Like,
} from '../vec3.ts';
import { getRagdollParticleRef } from './ragdollParticles.ts';
import { projectConstraintsAndAnatomyOnce } from './ragdollConstraintsProjector.ts';
import { stabilizeRagdollPoseForTransition } from './ragdollPoseStabilizer.ts';
import {
  buildLivingGroundedPoseTargets,
  livingGroundAgonyClock,
} from '../triage/groundedPoseTargets.ts';

const MAX_PARTICLE_SPEED_MS = 11.0;
const MAX_PARTICLE_SPEED_SQ = MAX_PARTICLE_SPEED_MS * MAX_PARTICLE_SPEED_MS;
const MAX_GROUNDED_UPWARD_POP_MS = 4.0;

interface CorpseSleepState {
  settleTimerS: number;
  sleeping: boolean;
}

const corpseSleepRegistry = new WeakMap<TargetHealthState, CorpseSleepState>();

function clampParticleVelocity(vel: Vec3Like, grounded: boolean): void {
  if (grounded && vel.y > MAX_GROUNDED_UPWARD_POP_MS) {
    vel.y = MAX_GROUNDED_UPWARD_POP_MS;
  }
  const spSq = lengthSq(vel);
  if (spSq > MAX_PARTICLE_SPEED_SQ) {
    const s = MAX_PARTICLE_SPEED_MS / Math.sqrt(spSq);
    vel.x *= s;
    vel.y *= s;
    vel.z *= s;
  }
}

function freezeCorpseParticles(target: TargetHealthState): void {
  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    b.velocity.x = 0;
    b.velocity.y = 0;
    b.velocity.z = 0;
    b.prevPosition = copyVec3(b.position);
  }
  for (const aId of ALL_AUX_PARTICLES) {
    const a = target.auxParticles[aId];
    a.velocity.x = 0;
    a.velocity.y = 0;
    a.velocity.z = 0;
    a.prevPosition = copyVec3(a.position);
  }
}

/**
 * Steps ongoing physiological bleedout, leg-shot stumble-to-ground transitions, active-ragdoll
 * living ground muscle tone, AND the rigid-skeleton 27-particle PBD 3D Ragdoll Physics solver.
 */
export function stepRagdollPhysics(
  target: TargetHealthState,
  dt: number,
  floorY = 0.0
): void {
  if (dt <= 0) return;

  // 1. Tick Physiological Hemorrhage, Leg-Disable Fall & Pain Reactions on living combatants
  if (target.alive) {
    const prevSleep = corpseSleepRegistry.get(target);
    if (prevSleep) {
      prevSleep.settleTimerS = 0;
      prevSleep.sleeping = false;
    }

    if (target.bloodLossRateMlPerSec > 0) {
      target.bloodVolumeMl = Math.max(0, target.bloodVolumeMl - target.bloodLossRateMlPerSec * dt);
      const bloodRatio = target.bloodVolumeMl / 5000;
      target.systolicBpMmHg = Math.max(0, Math.round(120 * Math.pow(bloodRatio, 1.35)));
      target.consciousness = Math.max(0.2, Math.min(1.0, (target.bloodVolumeMl - 2500) / 2200));
      target.currentHp = Math.max(0, target.currentHp - (target.bloodLossRateMlPerSec * 0.16) * dt);

      if (target.bloodVolumeMl <= 2500 || target.currentHp <= 0) {
        target.alive = false;
        target.consciousness = 0;
        target.heartRateBpm = 0;
        target.systolicBpMmHg = 0;
        target.weaponDropped = true;
        if (!target.isRagdollActive) {
          target.isRagdollActive = true;
          target.posture = 'AIRBORNE_RAGDOLL';
          stabilizeRagdollPoseForTransition(target, floorY);
          const slump = vec3(
            (Math.random() - 0.5) * 0.5,
            0,
            Math.cos(target.yawRad) * 0.75
          );
          target.ragdollBones.TORSO_UPPER_THORAX.velocity = slump;
          target.ragdollBones.HEAD_CRANIUM.velocity = scale(slump, 1.2);
        }
      }
    }

    if (target.alive && target.activeReaction.type !== 'NONE') {
      target.activeReaction.timerS += dt;
      if (target.activeReaction.timerS >= target.activeReaction.durationS) {
        target.activeReaction.type = 'NONE';
      }
    }

    if (
      target.alive &&
      (!target.leftLegFunctional || !target.rightLegFunctional) &&
      !target.isRagdollActive &&
      target.activeReaction.type === 'NONE'
    ) {
      target.isRagdollActive = true;
      target.weaponDropped = true;
      target.posture = 'AIRBORNE_RAGDOLL';
      stabilizeRagdollPoseForTransition(target, floorY);

      const cosY = Math.cos(target.yawRad);
      const sinY = Math.sin(target.yawRad);
      const sideSign = !target.leftLegFunctional ? -1.0 : 1.0;
      const sideWorld = vec3(cosY * sideSign, 0, -sinY * sideSign);
      const fwdWorld = vec3(sinY, 0, cosY);
      const dropVel = add(scale(sideWorld, 0.55), add(scale(fwdWorld, -0.35), vec3(0, -1.1, 0)));

      for (const z of ALL_GHOUL_ZONES) {
        const b = target.ragdollBones[z];
        if (b.componentId === 'BODY') {
          b.velocity = copyVec3(dropVel);
        }
      }
      for (const aId of ALL_AUX_PARTICLES) {
        const a = target.auxParticles[aId];
        if (a.componentId === 'BODY') {
          a.velocity = copyVec3(dropVel);
        }
      }
    }

    target.painShock = Math.max(0, target.painShock - dt * 0.55);
  }

  const hasSeveredLimbs = target.severedZones.size > 0;
  if (!target.isRagdollActive && !hasSeveredLimbs) {
    return;
  }

  // Permanent Corpse Sleep Check: once a dead ragdoll has settled on the floor, stay 100% still
  let sleepState = corpseSleepRegistry.get(target);
  if (!sleepState) {
    sleepState = { settleTimerS: 0, sleeping: false };
    corpseSleepRegistry.set(target, sleepState);
  }

  if (!target.alive && target.isRagdollActive && sleepState.sleeping) {
    let wokenByImpulse = false;
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      if (b.goreMode === 'CRANIAL_POP') continue;
      const vSq = lengthSq(b.velocity);
      if (vSq > 0.25) {
        wokenByImpulse = true;
        if (vSq > 20.25) {
          const s = 4.5 / Math.sqrt(vSq);
          b.velocity.x *= s;
          b.velocity.y *= s;
          b.velocity.z *= s;
        }
      }
    }
    if (!wokenByImpulse) {
      return;
    }
    sleepState.sleeping = false;
    sleepState.settleTimerS = 1.25;
  }

  let agonyClock = livingGroundAgonyClock.get(target) || 0;
  if (target.alive && target.isRagdollActive) {
    agonyClock += dt;
    livingGroundAgonyClock.set(target, agonyClock);
  }

  // 2. Sub-stepped Rigid-Skeleton PBD Ragdoll Solver
  const gravity = -9.81;
  const subSteps = Math.max(2, Math.min(8, Math.ceil(dt / 0.004)));
  const h = dt / subSteps;
  const constraintIterations = 14;
  const jointViscosityAlpha = 1 - Math.exp(-7.0 * h);

  const muscleTone = target.alive
    ? Math.max(0.22, target.consciousness * (1.0 - 0.55 * target.painShock))
    : 0.0;

  let finalGroundedCount = 0;
  for (let step = 0; step < subSteps; step++) {
    const activePoseTargets =
      muscleTone > 0.01 ? buildLivingGroundedPoseTargets(target, floorY, agonyClock) : null;

    // A. Symplectic Euler Prediction Step
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      const active =
        (target.isRagdollActive || b.componentId !== 'BODY') && b.goreMode !== 'CRANIAL_POP';
      if (!active) continue;

      clampParticleVelocity(b.velocity, b.grounded);
      b.prevPosition = copyVec3(b.position);
      b.velocity.y += gravity * h;

      if (activePoseTargets && b.componentId === 'BODY') {
        const desiredPos = activePoseTargets[z];
        if (desiredPos) {
          b.velocity.y += -gravity * muscleTone * h;
          const posErr = sub(desiredPos, b.position);
          let pdAx = posErr.x * 42.0 * muscleTone - b.velocity.x * 8.5 * muscleTone;
          let pdAy = posErr.y * 42.0 * muscleTone - b.velocity.y * 8.5 * muscleTone;
          let pdAz = posErr.z * 42.0 * muscleTone - b.velocity.z * 8.5 * muscleTone;
          const aMag = Math.sqrt(pdAx * pdAx + pdAy * pdAy + pdAz * pdAz);
          if (aMag > 28.0) {
            const s = 28.0 / aMag;
            pdAx *= s;
            pdAy *= s;
            pdAz *= s;
          }
          b.velocity.x += pdAx * h;
          b.velocity.y += pdAy * h;
          b.velocity.z += pdAz * h;
        }
      }

      const airDamp = Math.exp(-0.45 * h);
      b.velocity.x *= airDamp;
      b.velocity.z *= airDamp;

      b.position = add(b.position, scale(b.velocity, h));
    }

    for (const aId of ALL_AUX_PARTICLES) {
      const a = target.auxParticles[aId];
      const parentBone = target.ragdollBones[a.parentZone];
      const active =
        (target.isRagdollActive || a.componentId !== 'BODY') &&
        parentBone.goreMode !== 'CRANIAL_POP';
      if (!active) continue;

      const auxGrounded = a.position.y <= floorY + a.radiusM + 0.008;
      clampParticleVelocity(a.velocity, auxGrounded);
      a.prevPosition = copyVec3(a.position);
      a.velocity.y += gravity * h;

      if (activePoseTargets && a.componentId === 'BODY' && aId === 'HEAD_TOP') {
        a.velocity.y += -gravity * muscleTone * h;
      }
      const airDamp = Math.exp(-0.45 * h);
      a.velocity.x *= airDamp;
      a.velocity.z *= airDamp;

      a.position = add(a.position, scale(a.velocity, h));
    }

    // B. Iterative PBD Constraints
    for (let iter = 0; iter < constraintIterations; iter++) {
      projectConstraintsAndAnatomyOnce(target, floorY);
    }

    // C. PBD Velocity Update + Ground Friction & Bounce Restitution
    let groundedCount = 0;
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      const active =
        (target.isRagdollActive || b.componentId !== 'BODY') && b.goreMode !== 'CRANIAL_POP';
      if (!active) continue;

      const preImpactVy = b.velocity.y;
      const newVel = scale(sub(b.position, b.prevPosition), 1 / h);

      const minFloor = floorY + b.radiusM;
      if (b.position.y <= minFloor + 0.006) {
        b.grounded = true;
        if (b.componentId === 'BODY') groundedCount++;

        const slideFriction = Math.exp(-8.5 * h);
        newVel.x *= slideFriction;
        newVel.z *= slideFriction;

        if (preImpactVy < -1.8) {
          newVel.y = Math.max(newVel.y, -preImpactVy * 0.14);
        }

        if (!target.alive && length(newVel) < 0.08) {
          newVel.x = 0;
          newVel.y = 0;
          newVel.z = 0;
          b.position.x = b.prevPosition.x;
          b.position.z = b.prevPosition.z;
        }
      } else {
        b.grounded = false;
      }

      clampParticleVelocity(newVel, b.grounded);
      b.velocity = newVel;
    }

    for (const aId of ALL_AUX_PARTICLES) {
      const a = target.auxParticles[aId];
      const parentBone = target.ragdollBones[a.parentZone];
      const active =
        (target.isRagdollActive || a.componentId !== 'BODY') &&
        parentBone.goreMode !== 'CRANIAL_POP';
      if (!active) continue;

      const newVel = scale(sub(a.position, a.prevPosition), 1 / h);
      const auxGrounded = a.position.y <= floorY + a.radiusM + 0.006;
      if (auxGrounded) {
        const slideFriction = Math.exp(-9.5 * h);
        newVel.x *= slideFriction;
        newVel.z *= slideFriction;
        if (length(newVel) < 0.08) {
          newVel.x = 0;
          newVel.y = 0;
          newVel.z = 0;
        }
      }
      clampParticleVelocity(newVel, auxGrounded);
      a.velocity = newVel;
    }

    // D. Momentum-Conserving Passive Joint Viscosity
    for (const c of target.ragdollConstraints) {
      if (c.maxLength - c.minLength > 0.005) continue;
      const pA = getRagdollParticleRef(target, c.nodeA);
      const pB = getRagdollParticleRef(target, c.nodeB);
      if (!pA.active || !pB.active || pA.componentId !== pB.componentId) continue;

      const totalM = pA.massKg + pB.massKg;
      if (totalM < 1e-6) continue;
      const vCm = scale(
        add(scale(pA.velocity, pA.massKg), scale(pB.velocity, pB.massKg)),
        1 / totalM
      );
      pA.velocity.x += (vCm.x - pA.velocity.x) * jointViscosityAlpha;
      pA.velocity.y += (vCm.y - pA.velocity.y) * jointViscosityAlpha;
      pA.velocity.z += (vCm.z - pA.velocity.z) * jointViscosityAlpha;
      pB.velocity.x += (vCm.x - pB.velocity.x) * jointViscosityAlpha;
      pB.velocity.y += (vCm.y - pB.velocity.y) * jointViscosityAlpha;
      pB.velocity.z += (vCm.z - pB.velocity.z) * jointViscosityAlpha;
    }

    finalGroundedCount = groundedCount;
    if (target.isRagdollActive) {
      target.posture = groundedCount >= 3 ? 'RAGDOLL_GROUNDED' : 'AIRBORNE_RAGDOLL';
    }
  }

  // Progressive Corpse Settle Damping & Permanent Sleep Lock
  if (!target.alive && target.isRagdollActive && finalGroundedCount >= 4) {
    const settleDamp = Math.exp(-4.2 * dt * (1.0 + sleepState.settleTimerS * 2.8));
    let maxSpeedSq = 0;
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      if (b.goreMode === 'CRANIAL_POP') continue;
      b.velocity.x *= settleDamp;
      b.velocity.y *= settleDamp;
      b.velocity.z *= settleDamp;
      const spSq = lengthSq(b.velocity);
      if (spSq > maxSpeedSq) maxSpeedSq = spSq;
    }
    for (const aId of ALL_AUX_PARTICLES) {
      const a = target.auxParticles[aId];
      a.velocity.x *= settleDamp;
      a.velocity.y *= settleDamp;
      a.velocity.z *= settleDamp;
    }

    const maxSpeed = Math.sqrt(maxSpeedSq);
    if (maxSpeed < 0.15) {
      sleepState.settleTimerS += dt * 2.2;
    } else if (maxSpeed < 0.75) {
      sleepState.settleTimerS += dt;
    } else {
      sleepState.settleTimerS = Math.max(0, sleepState.settleTimerS - dt * 0.5);
    }

    if (
      (maxSpeed < 0.15 && sleepState.settleTimerS >= 0.30) ||
      (maxSpeed < 0.60 && sleepState.settleTimerS >= 1.60) ||
      sleepState.settleTimerS >= 2.10
    ) {
      freezeCorpseParticles(target);
      target.posture = 'RAGDOLL_GROUNDED';
      sleepState.sleeping = true;
    }
  }

  // 3. Sync Root Position/Velocity & Recompute Exact 3D Orthonormal Bone Bases
  if (target.isRagdollActive) {
    const pelvis = target.ragdollBones.PELVIS_GROIN;
    target.ragdollRootPosition = copyVec3(pelvis.position);
    target.ragdollRootVelocity = copyVec3(pelvis.velocity);
    target.worldPosition = vec3(
      pelvis.position.x,
      Math.max(floorY, pelvis.position.y - 0.95),
      pelvis.position.z
    );
  }

  recomputeRagdollBasisVectors(target);
}
