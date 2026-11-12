import type {
  CorpseSleepPhase,
  RagdollPhaseState,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import { copyVec3, lengthSq } from '../vec3.ts';

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
  finalGroundedCount: number
): void {
  if (target.alive || !target.isRagdollActive || finalGroundedCount < 4) {
    return;
  }

  const currentAccum =
    target.ragdollPhase.kind === 'CORPSE_DYNAMIC' ? target.ragdollPhase.settleAccumS : 0;
  const wokenWarmStart =
    target.ragdollPhase.kind === 'CORPSE_DYNAMIC' ? target.ragdollPhase.wokenWarmStart : false;

  const settleDamp = Math.exp(-4.2 * dt * (1.0 + currentAccum * 2.8));
  let maxSpeedSq = 0;
  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    if (b.attachmentState === 'OBLITERATED_HIDDEN' || b.goreMode === 'CRANIAL_POP') {
      continue;
    }
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
  let nextAccum = currentAccum;
  if (maxSpeed < 0.15) {
    nextAccum += dt * 2.2;
  } else if (maxSpeed < 0.75) {
    nextAccum += dt;
  } else {
    nextAccum = Math.max(0, nextAccum - dt * 0.5);
  }

  if (
    (maxSpeed < 0.15 && nextAccum >= 0.3) ||
    (maxSpeed < 0.6 && nextAccum >= 1.6) ||
    nextAccum >= 2.1
  ) {
    freezeCorpseParticles(target);
    target.posture = 'RAGDOLL_GROUNDED';
    target.ragdollPhase = { kind: 'CORPSE_SLEEPING' };
  } else {
    target.ragdollPhase = {
      kind: 'CORPSE_DYNAMIC',
      settleAccumS: nextAccum,
      wokenWarmStart,
    };
  }
}
