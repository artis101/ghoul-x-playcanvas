import type { GhoulZoneId, TargetHealthState } from '../../../contracts/ballistics.ts';
import {
  ALL_AUX_PARTICLES,
  ALL_GHOUL_ZONES,
  recomputeRagdollBasisVectors,
} from '../../ghoul/anatomy.ts';
import {
  stepLivingTargetVitalsAndFall,
  syncTargetLifecycleDerivedState,
  transitionTargetLifecycle,
} from '../lifecycle/targetLifecycleFsm.ts';
import { stepDeathAnimation } from '../lifecycle/deathAnimationStep.ts';
import { buildLivingGroundedPoseTargets } from '../triage/groundedPoseTargets.ts';
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
import {
  jointLimitEffort,
  stepCorpseSettleAndSleep,
  stepRagdollPhasePreSolve,
} from './corpseSleepFsm.ts';
import { type SprawlProgress, applyCorpseSprawl } from './corpseSprawlDrive.ts';
import { projectConstraintsAndAnatomyOnce } from './ragdollConstraintsProjector.ts';
import { applyAnatomicalJointLimits } from './ragdollJointLimits.ts';
import { type MuscleDrive, SEAT_ZONES, computeMuscleDrive } from './ragdollMuscleDrive.ts';
import { isRagdollBoneParticleActive } from './ragdollParticles.ts';
import { isResolvedParticleActive, resolveRagdollSolverScratch } from './ragdollSolverScratch.ts';

const MAX_PARTICLE_SPEED_MS = 11.0;
const MAX_PARTICLE_SPEED_SQ = MAX_PARTICLE_SPEED_MS * MAX_PARTICLE_SPEED_MS;
const MAX_GROUNDED_UPWARD_POP_MS = 4.0;
const GROUND_FRICTION_COEFF = 0.6;
// A resting particle grips the floor until something moves it faster than this. The living brace
// themselves, so writhing in place never ratchets a downed body across the ground.
const CORPSE_GRIP_SPEED_MS = 0.1;
const LIVING_GRIP_SPEED_MS = 0.3;
const JOINT_LIMIT_PASSES = 3;
const POSE_HOLD_FLOOR = 0.55;

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

/**
 * Slows a particle resting on the floor. Dry friction takes a fixed bite out of the sliding
 * speed each step and holds the particle still once that bite is all that is left, so a weak
 * steady push can never creep a body across the ground.
 */
function applyGroundFriction(vel: Vec3Like, viscousDamp: number, h: number, gripSpeed: number): void {
  vel.x *= viscousDamp;
  vel.z *= viscousDamp;
  const speed = Math.hypot(vel.x, vel.z);
  const bite = GROUND_FRICTION_COEFF * 9.81 * h;
  if (speed <= Math.max(bite, gripSpeed)) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const keep = (speed - bite) / speed;
  vel.x *= keep;
  vel.z *= keep;
}

/**
 * How fast a resting particle must be moving before the floor lets it slide. A living body
 * braces its seat, so writhing never creeps it along the ground. The limbs it is posing are
 * pulled across the floor by their own muscles: a grip there would pin a leg or arm that
 * landed folded under the body, and the body would lie in a heap. Everything else rests like
 * a corpse.
 */
function floorGripSpeed(target: TargetHealthState, zone: GhoulZoneId, muscleDrive: MuscleDrive | null): number {
  if (!target.alive) return CORPSE_GRIP_SPEED_MS;
  if (SEAT_ZONES.includes(zone)) return LIVING_GRIP_SPEED_MS;
  return muscleDrive?.[zone] ? 0 : CORPSE_GRIP_SPEED_MS;
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

  // 1. Play out a death clip (the ragdoll takes over when it ends), then tick hemorrhage,
  // leg-disable falls and pain reactions on living combatants.
  stepDeathAnimation(target, dt, floorY);
  stepLivingTargetVitalsAndFall(target, dt, floorY);

  const hasSeveredLimbs = target.severedZones.size > 0;
  if (!target.isRagdollActive && !hasSeveredLimbs) {
    return;
  }

  // 2. Step Ragdoll Corpse-Sleep & Living-Agony FSM
  const { skipSolverForSleepingCorpse, agonyClockS } = stepRagdollPhasePreSolve(target, dt);
  if (skipSolverForSleepingCorpse) {
    syncTargetLifecycleDerivedState(target);
    return;
  }

  // 3. Sub-stepped Rigid-Skeleton PBD Ragdoll Solver
  const gravity = -9.81;
  const subSteps = Math.max(2, Math.min(8, Math.ceil(dt / 0.004)));
  const h = dt / subSteps;
  const constraintIterations = 14;
  const jointViscosityAlpha = 1 - Math.exp(-7.0 * h);

  const muscleTone = target.alive
    ? Math.max(0.22, target.consciousness * (1.0 - 0.55 * target.painShock))
    : 0.0;

  // Someone still fighting from the floor holds the pose with what strength is left: weakness
  // shows as sag and tremor, not as a body that cannot lift its own head.
  const poseHold = target.alive ? POSE_HOLD_FLOOR + (1 - POSE_HOLD_FLOOR) * muscleTone : 0.0;

  // Nothing below re-creates a bone or a constraint, so one lookup serves every sub-step.
  const scratch = resolveRagdollSolverScratch(target);

  let finalGroundedCount = 0;
  let sprawl: SprawlProgress = 'SETTLED';
  for (let step = 0; step < subSteps; step++) {
    const activePoseTargets =
      poseHold > 0.01 ? buildLivingGroundedPoseTargets(target, floorY, agonyClockS) : null;
    const muscleDrive = activePoseTargets
      ? computeMuscleDrive(target, activePoseTargets, poseHold)
      : null;

    // A. Symplectic Euler Prediction Step
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      if (!isRagdollBoneParticleActive(target, b)) continue;

      clampParticleVelocity(b.velocity, b.grounded);
      b.prevPosition = copyVec3(b.position);
      b.velocity.y += gravity * h;

      const pull = muscleDrive?.[z];
      if (pull) {
        b.velocity.x += pull.x * h;
        b.velocity.y += pull.y * h;
        b.velocity.z += pull.z * h;
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
        parentBone.attachmentState !== 'OBLITERATED_HIDDEN' &&
        parentBone.goreMode !== 'CRANIAL_POP' &&
        (target.isRagdollActive ||
          parentBone.attachmentState === 'DETACHED_LIMB' ||
          a.componentId !== 'BODY');
      if (!active) continue;

      const auxGrounded = a.position.y <= floorY + a.radiusM + 0.008;
      clampParticleVelocity(a.velocity, auxGrounded);
      a.prevPosition = copyVec3(a.position);
      a.velocity.y += gravity * h;

      if (activePoseTargets && a.componentId === 'BODY' && aId === 'HEAD_TOP') {
        a.velocity.y += -gravity * poseHold * h;
      }
      const airDamp = Math.exp(-0.45 * h);
      a.velocity.x *= airDamp;
      a.velocity.z *= airDamp;

      a.position = add(a.position, scale(a.velocity, h));
    }

    // B. Iterative PBD Constraints
    for (let iter = 0; iter < constraintIterations; iter++) {
      projectConstraintsAndAnatomyOnce(target, floorY, scratch);
    }

    // C. PBD Velocity Update + Ground Friction & Bounce Restitution
    let groundedCount = 0;
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      if (!isRagdollBoneParticleActive(target, b)) continue;

      const preImpactVy = b.velocity.y;
      const newVel = scale(sub(b.position, b.prevPosition), 1 / h);

      const minFloor = floorY + b.radiusM;
      if (b.position.y <= minFloor + 0.006) {
        b.grounded = true;
        if (b.componentId === 'BODY') groundedCount++;

        applyGroundFriction(newVel, Math.exp(-8.5 * h), h, floorGripSpeed(target, z, muscleDrive));
        if (newVel.x === 0 && newVel.z === 0) {
          b.position.x = b.prevPosition.x;
          b.position.z = b.prevPosition.z;
        }

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
        parentBone.attachmentState !== 'OBLITERATED_HIDDEN' &&
        parentBone.goreMode !== 'CRANIAL_POP' &&
        (target.isRagdollActive ||
          parentBone.attachmentState === 'DETACHED_LIMB' ||
          a.componentId !== 'BODY');
      if (!active) continue;

      const newVel = scale(sub(a.position, a.prevPosition), 1 / h);
      const auxGrounded = a.position.y <= floorY + a.radiusM + 0.006;
      if (auxGrounded) {
        // Fingertips and toes trail their limb: they never hold it in place.
        applyGroundFriction(newVel, Math.exp(-9.5 * h), h, CORPSE_GRIP_SPEED_MS);
        if (length(newVel) < 0.08) {
          newVel.x = 0;
          newVel.y = 0;
          newVel.z = 0;
        }
      }
      clampParticleVelocity(newVel, auxGrounded);
      a.velocity = newVel;
    }

    // D. Anatomical joint limits
    if (target.isRagdollActive) {
      const { recovery, accelMs2 } = jointLimitEffort(target);
      const effort = { recovery, maxKickMs: (accelMs2 * h) / JOINT_LIMIT_PASSES };
      for (let pass = 0; pass < JOINT_LIMIT_PASSES; pass++) applyAnatomicalJointLimits(target, effort);
      if (!target.alive) sprawl = applyCorpseSprawl(target, floorY, h);
    }

    // E. Momentum-Conserving Passive Joint Viscosity
    for (let i = 0; i < scratch.constraintCount; i++) {
      const r = scratch.constraints[i];
      const c = r.constraint;
      if (c.maxLength - c.minLength > 0.005) continue;
      const pA = r.a;
      const pB = r.b;
      if (!isResolvedParticleActive(target, pA, r.gateA) || !isResolvedParticleActive(target, pB, r.gateB)) continue;
      if (pA.componentId !== pB.componentId) continue;

      const totalM = pA.massKg + pB.massKg;
      if (totalM < 1e-6) continue;
      const invM = 1 / totalM;
      const vA = pA.velocity;
      const vB = pB.velocity;
      const vCmX = (vA.x * pA.massKg + vB.x * pB.massKg) * invM;
      const vCmY = (vA.y * pA.massKg + vB.y * pB.massKg) * invM;
      const vCmZ = (vA.z * pA.massKg + vB.z * pB.massKg) * invM;
      vA.x += (vCmX - vA.x) * jointViscosityAlpha;
      vA.y += (vCmY - vA.y) * jointViscosityAlpha;
      vA.z += (vCmZ - vA.z) * jointViscosityAlpha;
      vB.x += (vCmX - vB.x) * jointViscosityAlpha;
      vB.y += (vCmY - vB.y) * jointViscosityAlpha;
      vB.z += (vCmZ - vB.z) * jointViscosityAlpha;
    }

    finalGroundedCount = groundedCount;
    if (target.isRagdollActive) {
      transitionTargetLifecycle(target, {
        kind: 'UPDATE_RAGDOLL_GROUNDED',
        groundedBoneCount: groundedCount,
      });
    }
  }

  // 4. Progressive Corpse Settle Damping & Permanent Sleep Lock
  stepCorpseSettleAndSleep(target, dt, finalGroundedCount, floorY, sprawl);
  syncTargetLifecycleDerivedState(target);

  // 5. Sync Root Position/Velocity & Recompute Exact 3D Orthonormal Bone Bases
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
