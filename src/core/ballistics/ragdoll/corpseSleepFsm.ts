import type {
  CorpseSleepPhase,
  RagdollPhaseState,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import { copyVec3, lengthSq } from '../vec3.ts';
import type { SprawlProgress } from './corpseSprawlDrive.ts';
import { releaseMuscleTone } from './ragdollMuscleDrive.ts';

const RESTING_ON_FLOOR_SLACK_M = 0.008;
const LIMIT_SOFTEN_S = 0.15;
const LIMIT_RELEASE_S = 0.6;
const FALLING_LIMIT_ACCEL_MS2 = 5000;
// A little over gravity: enough to swing a limb back into range, not to hoist the body.
const SETTLED_LIMIT_ACCEL_MS2 = 14;
const LIVING_LIMIT_ACCEL_MS2 = 60;
const UNFOLD_PATIENCE_S = 2.2;
// A wedged limb uses the patience up several times faster than one that is getting somewhere.
const STALLED_CLOCK_RATE = 6;

export function freezeCorpseParticles(target: TargetHealthState): void {
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

export function deriveCorpseSleepPhase(phase: RagdollPhaseState): CorpseSleepPhase {
  if (phase.kind === 'CORPSE_SLEEPING') {
    return { kind: 'SLEEPING' };
  }
  if (phase.kind === 'CORPSE_DYNAMIC') {
    return {
      kind: 'DYNAMIC',
      settleAccumS: phase.settleAccumS,
      wokenWarmStart: phase.wokenWarmStart,
    };
  }
  return { kind: 'DYNAMIC', settleAccumS: 0, wokenWarmStart: false };
}

/**
 * How hard joint limits act on this body right now.
 *
 * A limit that could push without bound keeps a tumbling body in human shape, but once the body
 * is down it can lever against a planted foot and jack a corpse back up off the floor. So limits
 * are stiff while a body falls, drop to muscle strength as it starts to settle, and stop pushing
 * altogether once it has lain still for a moment. The living keep a firm but bounded push.
 */
export function jointLimitEffort(target: TargetHealthState): { recovery: number; accelMs2: number } {
  if (target.alive || target.ragdollPhase.kind !== 'CORPSE_DYNAMIC') {
    return { recovery: 1, accelMs2: LIVING_LIMIT_ACCEL_MS2 };
  }
  const settled = target.ragdollPhase.settleAccumS;
  const stiffness = Math.max(0, 1 - settled / LIMIT_SOFTEN_S);
  return {
    recovery: Math.max(0, 1 - settled / LIMIT_RELEASE_S),
    accelMs2: SETTLED_LIMIT_ACCEL_MS2 + (FALLING_LIMIT_ACCEL_MS2 - SETTLED_LIMIT_ACCEL_MS2) * stiffness,
  };
}

/**
 * Updates `target.ragdollPhase` before stepping PBD physics.
 * Returns `true` if the target is a sleeping corpse with no waking impulse (solver can return early).
 */
export function stepRagdollPhasePreSolve(
  target: TargetHealthState,
  dt: number
): { skipSolverForSleepingCorpse: boolean; agonyClockS: number } {
  if (target.alive) {
    if (target.isRagdollActive) {
      const prevAgony =
        target.ragdollPhase.kind === 'LIVING_AGONY' ? target.ragdollPhase.agonyClockS : 0;
      const nextAgony = prevAgony + dt;
      target.ragdollPhase = { kind: 'LIVING_AGONY', agonyClockS: nextAgony };
      return { skipSolverForSleepingCorpse: false, agonyClockS: nextAgony };
    }
    if (target.ragdollPhase.kind !== 'INACTIVE') {
      target.ragdollPhase = { kind: 'INACTIVE' };
    }
    return { skipSolverForSleepingCorpse: false, agonyClockS: 0 };
  }

  if (!target.isRagdollActive) {
    return { skipSolverForSleepingCorpse: false, agonyClockS: 0 };
  }

  if (
    target.ragdollPhase.kind === 'INACTIVE' ||
    target.ragdollPhase.kind === 'LIVING_AGONY'
  ) {
    if (target.ragdollPhase.kind === 'LIVING_AGONY') releaseMuscleTone(target);
    target.ragdollPhase = {
      kind: 'CORPSE_DYNAMIC',
      settleAccumS: 0,
      wokenWarmStart: false,
    };
  }

  if (target.ragdollPhase.kind === 'CORPSE_SLEEPING') {
    let wokenByImpulse = false;
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      if (b.attachmentState === 'OBLITERATED_HIDDEN' || b.goreMode === 'CRANIAL_POP') {
        continue;
      }
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
      return { skipSolverForSleepingCorpse: true, agonyClockS: 0 };
    }
    target.ragdollPhase = {
      kind: 'CORPSE_DYNAMIC',
      settleAccumS: 1.25,
      wokenWarmStart: true,
    };
  }

  return { skipSolverForSleepingCorpse: false, agonyClockS: 0 };
}

/**
 * Applies progressive settle damping to a grounded dead ragdoll and locks it into `CORPSE_SLEEPING`
 * once particle kinetic energy falls below rest thresholds.
 */
export function stepCorpseSettleAndSleep(
  target: TargetHealthState,
  dt: number,
  finalGroundedCount: number,
  floorY = 0,
  sprawl: SprawlProgress = 'SETTLED'
): void {
  if (target.alive || !target.isRagdollActive || finalGroundedCount < 4) {
    return;
  }

  const currentAccum =
    target.ragdollPhase.kind === 'CORPSE_DYNAMIC' ? target.ragdollPhase.settleAccumS : 0;
  const wokenWarmStart =
    target.ragdollPhase.kind === 'CORPSE_DYNAMIC' ? target.ragdollPhase.wokenWarmStart : false;

  // Only the parts already lying on the floor are slowed. A limb or torso still coming down
  // falls at full speed, so a corpse finishes collapsing instead of sinking in slow motion.
  const settleDamp = Math.exp(-4.2 * dt * (1.0 + currentAccum * 2.8));
  let maxSpeedSq = 0;
  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    if (b.attachmentState === 'OBLITERATED_HIDDEN' || b.goreMode === 'CRANIAL_POP') {
      continue;
    }
    if (b.grounded) {
      b.velocity.x *= settleDamp;
      b.velocity.y *= settleDamp;
      b.velocity.z *= settleDamp;
    }
    const spSq = lengthSq(b.velocity);
    if (spSq > maxSpeedSq) maxSpeedSq = spSq;
  }
  for (const aId of ALL_AUX_PARTICLES) {
    const a = target.auxParticles[aId];
    if (a.position.y > floorY + a.radiusM + RESTING_ON_FLOOR_SLACK_M) continue;
    a.velocity.x *= settleDamp;
    a.velocity.y *= settleDamp;
    a.velocity.z *= settleDamp;
  }

  const maxSpeed = Math.sqrt(maxSpeedSq);
  let nextAccum = currentAccum;
  if (maxSpeed < 0.75) {
    nextAccum += dt;
  } else {
    // Still lively, but on the floor: count it slowly, so nothing can keep a corpse awake for good.
    nextAccum += dt * 0.25;
  }

  // A corpse still spreading out is left awake, but only for so long: a limb wedged under the
  // body may never get there, and the corpse must sleep all the same.
  const priorUnfoldingS =
    target.ragdollPhase.kind === 'CORPSE_DYNAMIC' ? (target.ragdollPhase.unfoldingS ?? 0) : 0;
  const unfoldingS =
    priorUnfoldingS + (sprawl === 'MOVING' ? dt : sprawl === 'STALLED' ? dt * STALLED_CLOCK_RATE : 0);
  const atRest = sprawl !== 'SETTLED'
    ? unfoldingS >= UNFOLD_PATIENCE_S
    : (maxSpeed < 0.15 && nextAccum >= 0.3) || (maxSpeed < 0.6 && nextAccum >= 1.6) || nextAccum >= 2.1;
  if (atRest) {
    freezeCorpseParticles(target);
    target.posture = 'RAGDOLL_GROUNDED';
    target.ragdollPhase = { kind: 'CORPSE_SLEEPING' };
  } else {
    target.ragdollPhase = {
      kind: 'CORPSE_DYNAMIC',
      settleAccumS: nextAccum,
      wokenWarmStart,
      unfoldingS,
    };
  }
}
