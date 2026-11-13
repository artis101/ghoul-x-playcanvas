import type * as pc from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import { DEATH_CLIP_SECONDS, startDeathAnimation } from '../src/core/ballistics/lifecycle/deathAnimation.ts';
import { transitionTargetLifecycle } from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { stepRagdollPhysics } from '../src/core/ballistics/ragdoll/ragdollVerletStep.ts';
import { COMBATANT_SIDED_CLIPS } from '../src/engine/assets/glbLoader.ts';
import { CombatantAnimController } from '../src/engine/mannequin/combatantAnimController.ts';
import { DEATH_BLEND_S, deathPlaybackSpeed } from '../src/engine/mannequin/combatantDeathPlayback.ts';
import { resolveMannequinDriveState } from '../src/engine/mannequin/propAttachmentState.ts';
import { applySequenceHit, findWoundSequence } from '../src/engine/gm/woundSequences.ts';
import { LabActs } from '../src/engine/gm/labActs.ts';
import { LabCombatantBrain } from '../src/engine/gm/labCombatantBrain.ts';

const freshBody = (archetype: 'MILITIA_GUNNER' | 'SKINHEAD_PUNK' = 'MILITIA_GUNNER') =>
  createTargetHealthState('dying', 'Dying', vec3(), 0, archetype, false);

function killWith(clip: 'DeathFallBack' | 'DeathBleedOut') {
  const hs = freshBody();
  transitionTargetLifecycle(hs, { kind: 'LETHAL_DEATH' });
  startDeathAnimation(hs, clip);
  return hs;
}

/** A clip-player double: one base layer whose baked clip lengths are given. */
function clipGlb(bakedS: number) {
  const baseLayer = { activeStateDuration: bakedS } as unknown as pc.AnimComponentLayer;
  const animComponent = { playing: true, speed: 1, baseLayer } as unknown as pc.AnimComponent;
  const playClip = vi.fn(() => true);
  return { animComponent, playClip };
}

describe('death clip playback', () => {
  it('keeps a body that dies on its feet animated until the corpse ragdoll takes over', () => {
    const hs = killWith('DeathFallBack');
    expect(hs.alive).toBe(false);
    expect(resolveMannequinDriveState(hs).mode).toBe('ANIM_DYING');
    hs.isRagdollActive = true;
    expect(resolveMannequinDriveState(hs).mode).toBe('FULL_RAGDOLL');
    const corpse = freshBody();
    transitionTargetLifecycle(corpse, { kind: 'LETHAL_DEATH' });
    expect(resolveMannequinDriveState(corpse).mode).toBe('FULL_RAGDOLL');
  });

  it('plays the clip once, at the core length, and a later hit does not restart it', () => {
    const hs = killWith('DeathFallBack');
    const glb = clipGlb(1.45);
    const controller = new CombatantAnimController();
    controller.syncDying(glb, hs);
    expect(glb.playClip).toHaveBeenCalledWith('DeathFallBack', DEATH_BLEND_S, 1, false);
    expect(glb.animComponent.speed).toBeCloseTo(1.45 / DEATH_CLIP_SECONDS.DeathFallBack, 5);
    expect(controller.activeWoundClip).toBe('COMMITTED');
    expect(controller.isFlinchHolding).toBe(false);
    // A hit during the clip: the core only bumps the jolt; the clip carries on.
    hs.joltEpoch = (hs.joltEpoch ?? 0) + 1;
    hs.activeReaction.epoch = (hs.activeReaction.epoch ?? 0) + 1;
    for (let i = 0; i < 5; i++) controller.syncDying(glb, hs);
    expect(glb.playClip).toHaveBeenCalledTimes(1);
    expect(controller.clipState.kind === 'PLAYING' && controller.clipState.clip).toBe('DeathFallBack');
  });

  it('leaves the body as it was on a GLB without the death clip', () => {
    const hs = killWith('DeathBleedOut');
    const glb = { ...clipGlb(3), availableClips: new Set(['CombatReadyIdle']) };
    const controller = new CombatantAnimController();
    controller.syncDying(glb, hs);
    expect(glb.playClip).not.toHaveBeenCalled();
    expect(controller.clipState.kind).toBe('FROZEN');
  });

  it('times the clip by the core length, within sane bounds', () => {
    expect(deathPlaybackSpeed(3.15, 3.17)).toBeCloseTo(3.15 / 3.17, 5);
    expect(deathPlaybackSpeed(undefined, 1.5)).toBe(1);
    expect(deathPlaybackSpeed(1.5, 0)).toBe(1);
    expect(deathPlaybackSpeed(10, 1)).toBe(4);
  });

  it('lists every death clip as a one-shot with no twin', () => {
    for (const clip of Object.keys(DEATH_CLIP_SECONDS)) {
      expect(COMBATANT_SIDED_CLIPS).toContain(clip);
    }
  });
});

describe('Character Lab deaths', () => {
  const clipOf = (id: string) => {
    const def = findWoundSequence(id);
    if (!def) throw new Error(`no sequence ${id}`);
    const hs = freshBody();
    for (const step of def.steps) if (step.hit.kind !== 'ACT') applySequenceHit(hs, step.hit);
    return hs;
  };

  it.each([
    ['dead-front', 'DeathFallBack'],
    ['dead-behind', 'DeathFallForward'],
    ['dead-head', 'DeathCrumple'],
    ['dead-shoulder', 'DeathSpin'],
    ['dead-walking', 'DeathFallBack'],
  ])('%s plays %s through the core clip choice', (id, clip) => {
    const hs = clipOf(id);
    expect(hs.alive).toBe(false);
    expect(hs.isRagdollActive).toBe(false);
    expect(hs.dying?.clip).toBe(clip);
    expect(hs.weaponDropped).toBe(true);
  });

  it('bleeds out on its feet through the lifecycle, then the ragdoll takes the corpse', () => {
    const hs = clipOf('bleed-out');
    const dt = 1 / 60;
    let i = 0;
    for (; i < 600 && hs.alive; i++) stepRagdollPhysics(hs, dt, 0);
    expect(hs.alive).toBe(false);
    expect(hs.dying?.clip).toBe('DeathBleedOut');
    expect(resolveMannequinDriveState(hs).mode).toBe('ANIM_DYING');
    for (let j = 0; j < 60 * (DEATH_CLIP_SECONDS.DeathBleedOut + 0.1); j++) stepRagdollPhysics(hs, dt, 0);
    expect(hs.isRagdollActive).toBe(true);
    expect(resolveMannequinDriveState(hs).mode).toBe('FULL_RAGDOLL');
  });

  it('a dying body does nothing alive: no aim, no walk, no draw', () => {
    const hs = clipOf('dead-front');
    const acts = new LabActs();
    acts.start(hs, 'AIM');
    acts.start(hs, 'WALK');
    const z = hs.worldPosition.z;
    expect(acts.step(hs, 0.1)).toBe(false);
    expect(hs.worldPosition.z).toBe(z);
    expect(acts.aimPose(hs)).toBeUndefined();
    const brain = new LabCombatantBrain(hs, true, () => vec3(0, 1.6, 4));
    for (let i = 0; i < 30; i++) brain.step(1 / 60, false);
    expect(brain.sidearmState().visible).toBe(false);
    expect(brain.wouldFire).toBe(false);
  });

  it('the Desert Eagle sequences run on the punk and cripple the support arm', () => {
    const def = findWoundSequence('deagle-one-hand');
    expect(def?.preset?.archetype).toBe('SKINHEAD_PUNK');
    const hs = freshBody('SKINHEAD_PUNK');
    for (const step of def!.steps) if (step.hit.kind !== 'ACT') applySequenceHit(hs, step.hit);
    expect(hs.alive).toBe(true);
    expect(hs.leftArmFunctional).toBe(false);
    expect(hs.weaponDropped).toBe(false);
    expect(findWoundSequence('deagle-aim')).toBeDefined();
    expect(findWoundSequence('deagle-walk-aim')).toBeDefined();
  });
});
