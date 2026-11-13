import type { TargetHealthState } from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import { stabilizeRagdollPoseForTransition } from '../ragdoll/ragdollPoseStabilizer.ts';
import { vec3 } from '../vec3.ts';
import { isDyingAnimated } from './deathAnimation.ts';
import { transitionTargetLifecycle } from './targetLifecycleFsm.ts';

/** Downward speed the corpse gets as the ragdoll takes it over from the death clip's last pose. */
const DEATH_SETTLE_SPEED_MS = 0.15;

/**
 * Advances a body's death clip. When the clip has played out the body is already lying where the
 * clip left it (the mannequin copies the animated pose into `ragdollBones` every frame), so the
 * corpse ragdoll takes over from there with only a small settling nudge.
 */
export function stepDeathAnimation(target: TargetHealthState, dt: number, floorY: number): void {
  if (!isDyingAnimated(target)) {
    // A ragdoll that took over early (a blast mid-clip) leaves no clip behind.
    if (target.dying && target.isRagdollActive) target.dying = null;
    return;
  }
  const dying = target.dying!;
  dying.timerS += dt;
  if (dying.timerS >= dying.durationS) handDeathClipToRagdoll(target, floorY);
}

/** Hands a body whose death clip has ended to the corpse ragdoll. */
export function handDeathClipToRagdoll(target: TargetHealthState, floorY: number): void {
  transitionTargetLifecycle(target, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
  stabilizeRagdollPoseForTransition(target, floorY);
  const settle = vec3(0, -DEATH_SETTLE_SPEED_MS, 0);
  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    if (b.componentId === 'BODY') b.velocity = { ...settle };
  }
  for (const aId of ALL_AUX_PARTICLES) {
    const a = target.auxParticles[aId];
    if (a.componentId === 'BODY') a.velocity = { ...settle };
  }
}
