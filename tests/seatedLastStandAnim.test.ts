import * as pc from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import type { TargetHealthState } from '../src/contracts/ballistics.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { stepRagdollPhysics } from '../src/core/ballistics/ragdoll/ragdollVerletStep.ts';
import { SEATED_DRAW_S } from '../src/core/ballistics/triage/seatedLastStand.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import {
  applyArmamentStateToRuntime, createPrimaryArmedState, reconcileEnemyArmamentState, stepEnemyArmamentState,
  type EnemyArmamentTransitionInput, type SyncedArmamentRuntimeFields,
} from '../src/core/ai/enemyArmamentFsm.ts';
import { sidearmDrawProgress, sidearmDrawSecondsFor } from '../src/engine/ai/agentArmamentController.ts';
import { PISTOL_DRAW_S } from '../src/engine/mannequin/combatantDrawClips.ts';
import { moveHorizontalClamped } from '../src/engine/ai/tacticalLocomotion.ts';
import { isFlinchHoldingBody, isPostureHeldByClip, markFlinchClipHeld } from '../src/engine/ai/woundClipHold.ts';
import { OffhandSidearmSync } from '../src/engine/combat/offhandSidearmSync.ts';
import type { OffhandSidearmRig } from '../src/engine/combat/offhandSidearmTypes.ts';
import { applySequenceHit, findWoundSequence, STEP_IN_AFTER_LANDING_S } from '../src/engine/gm/woundSequences.ts';
import { LabCombatantBrain } from '../src/engine/gm/labCombatantBrain.ts';
import { buildFragBlastReportForTarget } from '../src/engine/combat/fragBlastCalculator.ts';
import { fortitudeOverride, standInPosition, type PlayerStandIn } from '../src/engine/gm/woundedLabStandIn.ts';
import { WOUND_CLIP_SECONDS } from '../src/core/ballistics/trauma/woundReactionTimings.ts';
import { CombatantAnimController } from '../src/engine/mannequin/combatantAnimController.ts';
import {
  SEATED_PISTOL_VISIBLE_PROGRESS, seatedClipPlan, seatedDrawPlaybackSpeed, seatedPistolHolstered,
} from '../src/engine/mannequin/combatantSeatedClips.ts';
import { createPropAttachmentState } from '../src/engine/mannequin/propAttachmentState.ts';
import type { GhoulMannequinEntity } from '../src/engine/mannequin/ghoulMannequinEntity.ts';

/** A body sitting its animated last stand: alive, out of the ragdoll, in a seated phase. */
function seatedBody(phase: 'DOWNED_ENGAGE' | 'DOWNED_AGONY', southpaw = false): TargetHealthState {
  const hs = createTargetHealthState('seat', 'Seat', vec3(0, 0, 0), 0, 'MILITIA_GUNNER', southpaw);
  hs.woundedPhase = phase;
  hs.posture = 'LEG_BUCKLED';
  hs.weaponDropped = true;
  hs.rightLegFunctional = false;
  return hs;
}

describe('seated last stand: which clip plays', () => {
  it('lies in agony, draws from the hip, then holds the aim loop', () => {
    const hs = seatedBody('DOWNED_AGONY');
    expect(seatedClipPlan(hs)).toMatchObject({ stage: 'AGONY', clip: 'SeatedAgony', loop: true, southpaw: false });
    hs.woundedPhase = 'DOWNED_ENGAGE';
    hs.combatantStatusTag = 'SIDEARM_DRAWING';
    expect(seatedClipPlan(hs, 'RIGHT')).toMatchObject({ stage: 'DRAW', clip: 'SeatedPistolDraw', loop: false });
    hs.combatantStatusTag = 'LAST_STAND';
    expect(seatedClipPlan(hs, 'RIGHT')).toMatchObject({ stage: 'AIM', clip: 'SeatedPistolAim', loop: true });
  });

  it('uses the southpaw twin when the pistol is in the left hand', () => {
    const hs = seatedBody('DOWNED_ENGAGE');
    hs.combatantStatusTag = 'LAST_STAND';
    expect(seatedClipPlan(hs, 'LEFT')?.southpaw).toBe(true);
    expect(seatedClipPlan(hs, 'RIGHT')?.southpaw).toBe(false);
  });

  it('in agony clutches the thigh with the hand that still works', () => {
    const hs = seatedBody('DOWNED_AGONY');
    hs.severedZones.add('FOREARM_RIGHT');
    hs.severedZones.add('HAND_RIGHT');
    hs.rightArmFunctional = false;
    expect(seatedClipPlan(hs)?.southpaw).toBe(true);
    expect(seatedClipPlan(seatedBody('DOWNED_AGONY', true))?.southpaw).toBe(true);
  });

  it('is not seated while the fall still plays, in the ragdoll, or dead', () => {
    const hs = seatedBody('DOWNED_ENGAGE');
    hs.activeReaction.type = 'LEG_LOST_RIGHT';
    expect(seatedClipPlan(hs)).toBeNull();
    hs.activeReaction.type = 'NONE';
    hs.isRagdollActive = true;
    expect(seatedClipPlan(hs)).toBeNull();
    hs.isRagdollActive = false;
    hs.alive = false;
    expect(seatedClipPlan(hs)).toBeNull();
  });

  it('times the draw clip to the seated draw, whatever length it was baked at', () => {
    expect(SEATED_DRAW_S).toBe(2);
    expect(seatedDrawPlaybackSpeed(2)).toBeCloseTo(1);
    expect(seatedDrawPlaybackSpeed(3)).toBeCloseTo(1.5);
    expect(seatedDrawPlaybackSpeed(undefined)).toBe(1);
  });
});

describe('seated last stand: the animation controller', () => {
  function fakeGlb(clips?: string[]) {
    const playClip = vi.fn(() => true);
    const baseLayer = { activeStateProgress: 1, activeStateDuration: 2 };
    const glb = {
      animComponent: { playing: true, speed: 1, baseLayer } as unknown as pc.AnimComponent,
      playClip,
      ...(clips ? { availableClips: new Set(clips) } : {}),
    };
    return { glb, playClip };
  }

  it('plays the seated clips with the body committed to them (no prop-up, no clutch, quarter jolt)', () => {
    const hs = seatedBody('DOWNED_AGONY');
    const controller = new CombatantAnimController();
    const { glb, playClip } = fakeGlb();
    controller.syncAnimation(glb, hs);
    expect(playClip).toHaveBeenLastCalledWith('SeatedAgony', 0.2, 1, false);
    expect(controller.activeWoundClip).toBe('COMMITTED');
    hs.woundedPhase = 'DOWNED_ENGAGE';
    hs.combatantStatusTag = 'SIDEARM_DRAWING';
    controller.syncAnimation(glb, hs, false, undefined, { clip: 'PistolAimOneHand', hand: 'LEFT' });
    expect(playClip).toHaveBeenLastCalledWith('SeatedPistolDraw', 0.2, 1, true);
    hs.combatantStatusTag = 'LAST_STAND';
    controller.syncAnimation(glb, hs, false, undefined, { clip: 'PistolAimOneHand', hand: 'LEFT' });
    expect(playClip).toHaveBeenLastCalledWith('SeatedPistolAim', 0.2, 1, true);
    expect(controller.seatedClip?.stage).toBe('AIM');
  });

  it('a hit on a seated body plays no flinch clip, only the jolt', () => {
    const hs = seatedBody('DOWNED_AGONY');
    const controller = new CombatantAnimController();
    const { glb, playClip } = fakeGlb();
    controller.syncAnimation(glb, hs);
    hs.activeReaction = { ...hs.activeReaction, type: 'CHEST_STAGGER', timerS: 0, durationS: 0.5, epoch: 3 };
    controller.syncAnimation(glb, hs);
    expect(playClip).toHaveBeenCalledTimes(1);
    expect(controller.isFlinchHolding).toBe(false);
  });

  it('holds the last frame of the fall until the seated clips are baked', () => {
    const hs = seatedBody('DOWNED_AGONY');
    hs.woundedPhase = 'DOWNED_AGONY';
    hs.activeReaction = { ...hs.activeReaction, type: 'LEG_BUCKLE_RIGHT', timerS: 0, durationS: 2.37, epoch: 1 };
    const controller = new CombatantAnimController();
    const { glb, playClip } = fakeGlb(['CombatReadyIdle', 'LegShotFallRight', 'DownedCollapse', 'Crawl']);
    controller.syncAnimation(glb, hs);
    expect(playClip).toHaveBeenLastCalledWith('LegShotFallRight', 0.12, 1, false);
    hs.activeReaction = { ...hs.activeReaction, type: 'NONE', timerS: 0, durationS: 0 };
    for (let i = 0; i < 5; i++) controller.syncAnimation(glb, hs, false, undefined, undefined, 0, 1 / 60);
    expect(playClip).toHaveBeenCalledTimes(1);
    expect(controller.clipState.kind === 'PLAYING' && controller.clipState.clip).toBe('LegShotFallRight');
    expect(controller.seatedClip?.clip).toBe('SeatedAgony');
  });

  it('a flinch clip holds the body for the AI until it has played out', () => {
    const hs = createTargetHealthState('flinch', 'Flinch', vec3());
    const controller = new CombatantAnimController();
    const { glb } = fakeGlb();
    (glb.animComponent.baseLayer as unknown as { activeStateProgress: number }).activeStateProgress = 0.4;
    hs.activeReaction = { ...hs.activeReaction, type: 'CHEST_STAGGER', timerS: 0, durationS: 0.5, epoch: 1 };
    controller.syncAnimation(glb, hs);
    expect(controller.isFlinchHolding).toBe(true);
    hs.activeReaction = { ...hs.activeReaction, type: 'NONE', timerS: 0, durationS: 0 };
    controller.syncAnimation(glb, hs);
    expect(controller.isFlinchHolding).toBe(true);
    (glb.animComponent.baseLayer as unknown as { activeStateProgress: number }).activeStateProgress = 0.99;
    controller.syncAnimation(glb, hs);
    expect(controller.isFlinchHolding).toBe(false);
  });
});

describe('seated last stand: the draw', () => {
  const baseInput = (hs: TargetHealthState, dt: number): EnemyArmamentTransitionInput => ({
    dt, alive: true, rightArmIntact: true, leftArmIntact: true, preferredPrimaryHand: 'RIGHT', intactHand: 'RIGHT',
    weaponDropped: true, primaryArmDisarmed: false, isRagdollActive: false, isAirborneRagdoll: false,
    carriesBackupSidearm: true, isGuarding: false, isLastStandVital: false,
    sidearmDrawDurationS: sidearmDrawSecondsFor(hs), seatedOnFloor: true, sidearmRule: 'ALLOW',
  });

  it('takes SEATED_DRAW_S instead of the standing PistolDraw clip, and ends as a last stand', () => {
    const hs = seatedBody('DOWNED_ENGAGE');
    expect(sidearmDrawSecondsFor(hs)).toBe(SEATED_DRAW_S);
    expect(sidearmDrawSecondsFor(createTargetHealthState('up', 'Up', vec3()))).toBe(PISTOL_DRAW_S);
    const runtime: SyncedArmamentRuntimeFields = {
      activeFiringHand: 'RIGHT', sidearmDrawTimerS: 0, sidearmDrawing: false, sidearmActive: false,
      sidearmDropped: false, armamentState: createPrimaryArmedState('RIGHT'),
    };
    let elapsed = 0;
    let tag: string | null = null;
    let progressAtHalf = -1;
    for (let i = 0; i < 200; i++) {
      const result = stepEnemyArmamentState(reconcileEnemyArmamentState(runtime), baseInput(hs, 1 / 60));
      applyArmamentStateToRuntime(runtime, result.state);
      expect(result.forceDisarmedPosture).toBe(false);
      tag = result.statusTag;
      elapsed += 1 / 60;
      if (Math.abs(elapsed - 1) < 1e-6 + 1 / 120) progressAtHalf = sidearmDrawProgress(result.state);
      if (result.state.kind === 'SIDEARM_ACTIVE') break;
    }
    expect(elapsed).toBeGreaterThan(SEATED_DRAW_S - 0.05);
    expect(elapsed).toBeLessThan(SEATED_DRAW_S + 0.05);
    expect(tag).toBe('LAST_STAND');
    expect(progressAtHalf).toBeGreaterThan(0.45);
    expect(progressAtHalf).toBeLessThan(0.55);
  });

  it('keeps the pistol in the holster for the first 45 % of the draw', () => {
    expect(SEATED_PISTOL_VISIBLE_PROGRESS).toBeCloseTo(0.45);
    expect(seatedPistolHolstered(true, 0.3)).toBe(true);
    expect(seatedPistolHolstered(true, 0.5)).toBe(false);
    expect(seatedPistolHolstered(false, 0)).toBe(false);
    // Once out, the pistol is rigid in the fist: the draw clip turns it, not a blend in code.
  });
});

describe('seated last stand: the pistol rides the animated hand', () => {
  function rigAndTarget(hs: TargetHealthState) {
    const handNode = new pc.Entity('hand');
    handNode.setPosition(0.3, 0.6, 0.4);
    const combatantRoot = new pc.Entity('combatant');
    const holder = new pc.Entity('holder');
    holder.enabled = false;
    const weaponRoot = new pc.Entity('pistol');
    const rig = {
      targetId: hs.targetId,
      holderEntity: holder,
      glbInstance: { rootEntity: weaponRoot },
      isGlbModel: true,
      attachmentState: createPropAttachmentState<'RIGHT' | 'LEFT'>('HIDDEN_TEMP'),
      wasHeldLastFrame: false,
      lastHand: null,
      clonedMaterials: [],
      cachedBoneEntities: new Map(),
    } as unknown as OffhandSidearmRig;
    const target = {
      healthState: hs,
      rootEntity: combatantRoot,
      combatantGlb: { boneNodes: new Map([['HAND_RIGHT', handNode]]), rootEntity: combatantRoot },
    } as unknown as GhoulMannequinEntity;
    return { rig, target, handNode, holder };
  }

  it('stays holstered early in the draw, then shows in the fist without posing the arm', () => {
    const hs = seatedBody('DOWNED_ENGAGE');
    hs.combatantStatusTag = 'SIDEARM_DRAWING';
    const { rig, target, holder } = rigAndTarget(hs);
    const handBefore = { ...hs.ragdollBones.HAND_RIGHT.position };
    const fx = { spawnDroppedWeaponProp: vi.fn() };
    const sync = new OffhandSidearmSync();
    const state = (progress: number) => ({
      getSidearmVisualState: () => ({
        visible: true, drawing: progress < 1, drawProgress: progress, hand: 'RIGHT', dropped: false,
        aimTargetWorld: vec3(0, 1.2, 5), weaponId: 'silver_talon_50ae',
      }),
    }) as never;
    for (let i = 0; i < 3; i++) expect(sync.sync(target, vec3(0, 1.4, 5), rig, state(0.2 + i * 0.05), fx as never)).toBe(false);
    // (A detached test entity always reads enabled false, so the rig's own flag is checked.)
    expect(rig.wasHeldLastFrame).toBe(false);
    expect(rig.attachmentState).toMatchObject({ kind: 'HIDDEN_TEMP', hand: undefined });
    expect(sync.sync(target, vec3(0, 1.4, 5), rig, state(0.6), fx as never)).toBe(true);
    expect(rig.wasHeldLastFrame).toBe(true);
    expect(rig.attachmentState).toMatchObject({ kind: 'ATTACHED', hand: 'RIGHT' });
    expect(sync.sync(target, vec3(0, 1.4, 5), rig, state(1), fx as never)).toBe(true);
    // The pistol sits at the animated palm and the arm bones are left to the clip.
    expect(holder.getPosition().distance(new pc.Vec3(0.3, 0.6, 0.4))).toBeLessThan(0.15);
    expect(hs.ragdollBones.HAND_RIGHT.position).toEqual(handBefore);
    expect(fx.spawnDroppedWeaponProp).not.toHaveBeenCalled();
  });
});

describe('stand and take it: no sliding while hit', () => {
  it('does not walk or strafe a body while a reaction runs or its flinch clip is held', () => {
    const hs = createTargetHealthState('slide', 'Slide', vec3(0, 0, -10));
    hs.activeReaction = { ...hs.activeReaction, type: 'CHEST_STAGGER', timerS: 0, durationS: 0.4, epoch: 1 };
    expect(isFlinchHoldingBody(hs)).toBe(true);
    moveHorizontalClamped(hs, 3, -10, 0.5, null);
    expect(hs.worldPosition.x).toBe(0);
    hs.activeReaction = { ...hs.activeReaction, type: 'NONE', timerS: 0, durationS: 0 };
    markFlinchClipHeld(hs, true);
    moveHorizontalClamped(hs, 3, -10, 0.5, null);
    expect(hs.worldPosition.x).toBe(0);
    markFlinchClipHeld(hs, false);
    moveHorizontalClamped(hs, 3, -10, 0.5, null);
    expect(hs.worldPosition.x).toBeCloseTo(0.5);
  });

  it('never moves a seated last stand, and keeps its seated posture', () => {
    const hs = seatedBody('DOWNED_ENGAGE');
    hs.worldPosition = vec3(0, 0, -10);
    moveHorizontalClamped(hs, 3, -10, 0.5, null);
    expect(hs.worldPosition.x).toBe(0);
    expect(isPostureHeldByClip(hs)).toBe(true);
  });
});

describe('Character Lab: "Leg off, you step in front later"', () => {
  it('lies in agony, then draws for SEATED_DRAW_S and fires once you step in front; never ragdolled', () => {
    const def = findWoundSequence('leg-later');
    if (!def) throw new Error('missing leg-later sequence');
    expect(def.preset?.standIn).toBe('LEFT');
    const hs = createTargetHealthState('later', 'Later', vec3(0, 0, 0), 0, 'MILITIA_GUNNER', false);
    hs.fortitude = fortitudeOverride(def.preset?.fortitude ?? 'AUTO');
    let standIn: PlayerStandIn = def.preset?.standIn ?? 'LEFT';
    const brain = new LabCombatantBrain(hs, true, () => standInPosition(standIn));
    const dt = 1 / 60;
    let next = 0;
    const phases: string[] = [];
    let agonyBeforeStep = false;
    let firstFireS = -1;
    let engageAtS = -1;
    let everRagdolled = false;
    for (let i = 0; i < 14 * 60 && hs.alive; i++) {
      const t = i * dt;
      while (next < def.steps.length && t >= def.steps[next].atS) {
        const step = def.steps[next++].hit;
        if (step.kind === 'STAND_IN') standIn = step.to;
        applySequenceHit(hs, step);
      }
      brain.step(dt, false);
      stepRagdollPhysics(hs, dt, 0);
      everRagdolled ||= hs.isRagdollActive;
      const phase = hs.woundedPhase ?? 'NONE';
      if (phases[phases.length - 1] !== phase) phases.push(phase);
      if (standIn === 'LEFT' && phase === 'DOWNED_AGONY') agonyBeforeStep = true;
      if (phase === 'DOWNED_ENGAGE' && engageAtS < 0) engageAtS = t;
      if (brain.wouldFire && firstFireS < 0) firstFireS = t;
    }
    const stepInS = WOUND_CLIP_SECONDS.LEG_LOSS + STEP_IN_AFTER_LANDING_S;
    expect(agonyBeforeStep).toBe(true);
    expect(everRagdolled).toBe(false);
    expect(phases).toContain('DOWNED_ENGAGE');
    expect(engageAtS).toBeGreaterThanOrEqual(stepInS - dt);
    expect(firstFireS - engageAtS).toBeGreaterThanOrEqual(SEATED_DRAW_S - 0.05);
    expect(hs.posture).toBe('LEG_BUCKLED');
    expect(hs.combatantStatusTag).toBe('LAST_STAND');
  });
});

describe('grenade knockdowns follow the low-HP rule', () => {
  // 5 m from a 9 m frag: about 85 HP of damage, not lethal for these bodies.
  const blastAt5m = (hs: TargetHealthState) =>
    buildFragBlastReportForTarget(hs, vec3(5, 0, 0), 5, 9, 900, 4400).ragdollPlan.willEnableRagdoll;

  it('a fit body rocks and stays up, a spent one goes down, a seated one stays seated', () => {
    const fit = createTargetHealthState('fit', 'Fit', vec3(0, 0, 0), 0, 'MILITIA_GUNNER', false);
    fit.maxHp = 400;
    fit.currentHp = 400;
    expect(blastAt5m(fit)).toBe(false);

    const spent = createTargetHealthState('spent', 'Spent', vec3(0, 0, 0), 0, 'MILITIA_GUNNER', false);
    spent.maxHp = 400;
    spent.currentHp = 120;
    expect(blastAt5m(spent)).toBe(true);

    const seated = seatedBody('DOWNED_ENGAGE');
    seated.maxHp = 400;
    seated.currentHp = 120;
    expect(blastAt5m(seated)).toBe(false);
  });
});
