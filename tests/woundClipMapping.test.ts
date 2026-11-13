import type * as pc from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import type { PainReactionType } from '../src/contracts/ballistics.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import { isArmDeadButAttached } from '../src/core/ghoul/anatomy/deadArmVerlet.ts';
import {
  createProceduralTraumaTracker,
  stepHitJolt,
  type WoundClipOwner,
} from '../src/core/ghoul/anatomy/proceduralTraumaIk.ts';
import { COMBATANT_ANIMATION_CLIPS, COMBATANT_SIDED_CLIPS, isLoopingClip } from '../src/engine/assets/glbLoader.ts';
import { CombatantAnimController } from '../src/engine/mannequin/combatantAnimController.ts';
import { pistolAimClip, woundClipChain, woundClipChainAt } from '../src/engine/mannequin/combatantWoundClips.ts';
import { LEG_LOSS_PHASE_SECONDS, SIT_TO_CRAWL_S } from '../src/core/ballistics/trauma/woundReactionTimings.ts';
import { sidearmAimClip } from '../src/engine/mannequin/combatantWoundedPhaseClips.ts';

const ALL_CLIPS: ReadonlySet<string> = new Set([...COMBATANT_ANIMATION_CLIPS, ...COMBATANT_SIDED_CLIPS]);
const OLD_GLB_CLIPS: ReadonlySet<string> = new Set(COMBATANT_ANIMATION_CLIPS.filter(
  (c) => !c.startsWith('HitFlinch') && c !== 'PistolAimOneHand'
));

function makeGlb(availableClips?: ReadonlySet<string>, refuse: ReadonlySet<string> = new Set()) {
  const baseLayer = { activeStateProgress: 0 };
  const animComponent = { playing: true, speed: 1, baseLayer } as unknown as pc.AnimComponent;
  const playClip = vi.fn((clip: string) => !refuse.has(clip));
  return { glb: { animComponent, playClip, availableClips }, baseLayer, playClip };
}

function makeState() {
  const state = createTargetHealthState('npc', 'NPC', vec3());
  state.isLeftHanded = false;
  return state;
}

function startReaction(state: ReturnType<typeof makeState>, type: PainReactionType, durationS: number): void {
  state.activeReaction.type = type;
  state.activeReaction.durationS = durationS;
  state.activeReaction.timerS = 0;
  state.activeReaction.epoch += 1;
}

describe('wound reaction to clip mapping', () => {
  it('maps every reaction to its authored clip when the GLB has it', () => {
    const expected: Array<[PainReactionType, string]> = [
      ['CHEST_STAGGER', 'HitStaggerChest'], ['HEAD_SNAP', 'HitFlinchHead'], ['GUT_FOLD', 'HitFlinchGut'],
      ['THROAT_CLUTCH', 'HitFlinchThroat'], ['ARM_WRENCH_RIGHT', 'HitFlinchArmRight'],
      ['ARM_WRENCH_LEFT', 'HitFlinchArmLeft'], ['LEG_FLINCH_RIGHT', 'HitFlinchLegRight'],
      ['LEG_FLINCH_LEFT', 'HitFlinchLegLeft'], ['LEG_BUCKLE_RIGHT', 'LegShotFallRight'],
      ['LEG_BUCKLE_LEFT', 'LegShotFallLeft'], ['LEG_LOST_RIGHT', 'LegLossRight'], ['LEG_LOST_LEFT', 'LegLossLeft'],
      ['ARM_LOST_RIGHT', 'ArmLossRight'], ['ARM_LOST_LEFT', 'ArmLossLeft'], ['DOWNED_COLLAPSE', 'DownedCollapse'],
    ];
    const controller = new CombatantAnimController();
    const state = makeState();
    for (const [type, clip] of expected) {
      expect(woundClipChain(type)[0]).toBe(clip);
      startReaction(state, type, 1);
      expect(controller.resolveDesiredClip(state, false, ALL_CLIPS)).toBe(clip);
    }
  });

  it('falls back to the stagger or the sit-down collapse while the wound takes are not baked', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    const cases: Array<[PainReactionType, string]> = [
      ['HEAD_SNAP', 'HitStaggerChest'], ['LEG_FLINCH_LEFT', 'HitStaggerChest'], ['ARM_LOST_RIGHT', 'HitStaggerChest'],
      ['LEG_BUCKLE_RIGHT', 'DownedCollapse'], ['LEG_LOST_LEFT', 'DownedCollapse'],
      ['DOWNED_COLLAPSE', 'DownedCollapse'],
    ];
    for (const [type, clip] of cases) {
      startReaction(state, type, 1);
      expect(controller.resolveDesiredClip(state, false, OLD_GLB_CLIPS)).toBe(clip);
    }
  });

  it('falls back when playClip refuses a clip on a GLB that does not list its clips', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    const { glb, playClip } = makeGlb(undefined, new Set(['HitFlinchHead']));
    startReaction(state, 'HEAD_SNAP', 0.8);
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('HitFlinchHead', 0.12, 1, false);
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('HitStaggerChest', 0.12, 1, false);
  });

  it('plays no clip for a graze and keeps aiming', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    const { glb, playClip } = makeGlb(ALL_CLIPS);
    controller.syncAnimation(glb, state, false, undefined, { clip: 'LongGunAim' });
    startReaction(state, 'CHEST_STAGGER', 0.22);
    controller.syncAnimation(glb, state, false, undefined, { clip: 'LongGunAim' });
    expect(playClip).toHaveBeenCalledTimes(1);
    expect(controller.activeWoundClip).toBeNull();
  });
});

describe('leg loss phases', () => {
  it('lifts the stump, hops on the good leg, then falls, each clip in turn', () => {
    const { LIFT, HOP } = LEG_LOSS_PHASE_SECONDS;
    const at = (timerS: number) => woundClipChainAt({ type: 'LEG_LOST_LEFT', timerS })[0];
    expect(at(0)).toBe('LegLossLeft');
    expect(at(LIFT - 0.01)).toBe('LegLossLeft');
    expect(at(LIFT + 0.01)).toBe('OneLegHopLeft');
    expect(at(LIFT + HOP - 0.01)).toBe('OneLegHopLeft');
    expect(at(LIFT + HOP + 0.01)).toBe('LegLossFallLeft');
    expect(woundClipChainAt({ type: 'LEG_LOST_RIGHT', timerS: LIFT + 0.5 })).toEqual(['OneLegHopRight', 'DownedCollapse']);
    expect(woundClipChainAt({ type: 'GUT_FOLD', timerS: 0.3 })).toEqual(woundClipChain('GUT_FOLD'));
  });
});

describe('wound clip playback', () => {
  it('plays a flinch to its end after the reaction, and restarts it on a new hit', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    const { glb, playClip, baseLayer } = makeGlb(ALL_CLIPS);
    startReaction(state, 'HEAD_SNAP', 0.4);
    controller.syncAnimation(glb, state, false, undefined, { clip: 'LongGunAim' });
    expect(playClip).toHaveBeenLastCalledWith('HitFlinchHead', 0.12, 1.25, false);
    expect(controller.activeWoundClip).toBe('FLINCH');

    state.activeReaction.type = 'NONE';
    baseLayer.activeStateProgress = 0.6;
    controller.syncAnimation(glb, state, false, undefined, { clip: 'LongGunAim' });
    expect(playClip).toHaveBeenCalledTimes(1);
    expect(controller.activeWoundClip).toBe('FLINCH');

    startReaction(state, 'HEAD_SNAP', 0.9);
    controller.syncAnimation(glb, state, false, undefined, { clip: 'LongGunAim' });
    expect(playClip).toHaveBeenCalledTimes(2);
    expect(playClip).toHaveBeenLastCalledWith('HitFlinchHead', 0.12, 1, false);

    state.activeReaction.type = 'NONE';
    baseLayer.activeStateProgress = 0.99;
    controller.syncAnimation(glb, state, false, undefined, { clip: 'LongGunAim' });
    expect(playClip).toHaveBeenLastCalledWith('LongGunAim', 0.12, 1, false);
    expect(controller.activeWoundClip).toBeNull();
  });

  it('never restarts a fall or loss on a lesser hit, but a new limb loss starts its own clip', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    const { glb, playClip, baseLayer } = makeGlb(ALL_CLIPS);
    startReaction(state, 'ARM_LOST_RIGHT', 2.2);
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('ArmLossRight', 0.12, 1, false);
    expect(controller.activeWoundClip).toBe('COMMITTED');

    baseLayer.activeStateProgress = 0.4;
    state.activeReaction.epoch += 1;
    state.activeReaction.timerS = 0;
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenCalledTimes(1);

    startReaction(state, 'LEG_LOST_LEFT', 3.4);
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('LegLossLeft', 0.12, 1, false);
    expect(controller.activeWoundClip).toBe('COMMITTED');
  });

  it('clutches the stump after an arm loss with no gun, and aims one-handed with a sidearm', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    const { glb, playClip, baseLayer } = makeGlb(ALL_CLIPS);
    startReaction(state, 'ARM_LOST_RIGHT', 2.2);
    controller.syncAnimation(glb, state);

    state.activeReaction.type = 'NONE';
    state.severedZones.add('FOREARM_RIGHT');
    state.weaponDropped = true;
    baseLayer.activeStateProgress = 1;
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('StumpClutchRight', 0.12, 1, false);
    expect(controller.isStumpClutching).toBe(true);
    expect(controller.activeWoundClip).toBeNull();
    expect(isLoopingClip('StumpClutchRight')).toBe(true);

    expect(pistolAimClip(state, 'LEFT')).toBe('PistolAimOneHand');
    controller.syncAnimation(glb, state, false, undefined, { clip: 'PistolAimOneHand', hand: 'LEFT' });
    expect(playClip).toHaveBeenLastCalledWith('PistolAimOneHand', 0.12, 1, true);

    // Before the one-handed aim is baked, the two-handed pistol aim stands in for it.
    const old = makeGlb(OLD_GLB_CLIPS);
    new CombatantAnimController().syncAnimation(
      old.glb, state, false, undefined, { clip: 'PistolAimOneHand', hand: 'LEFT' }
    );
    expect(old.playClip).toHaveBeenLastCalledWith('PistolAim', 0.12, 1, true);
  });
});

describe('procedural overlays step back for wound clips', () => {
  it('treats a hand or forearm stump as animated, but keeps the pendulum for a shattered arm', () => {
    const state = makeState();
    state.rightArmFunctional = false;
    expect(isArmDeadButAttached(state, 'RIGHT')).toBe(true);
    state.severedZones.add('HAND_RIGHT');
    expect(isArmDeadButAttached(state, 'RIGHT')).toBe(false);
    expect(isArmDeadButAttached(state, 'RIGHT', false)).toBe(true);
  });

  it('plays the hit jolt in full with no wound clip and not at all under a wound, fall or seated clip', () => {
    const kick = (woundClip: WoundClipOwner, bodyClip = false): number => {
      // The counter is absent until the first hit, which must still jolt.
      const state = makeState();
      const tracker = createProceduralTraumaTracker();
      stepHitJolt(state, tracker, 0, { woundClip, bodyClip });
      state.joltEpoch = 1;
      state.activeReaction.hitDirectionWorld = vec3(0, 0, 1);
      state.activeReaction.intensity = 1;
      stepHitJolt(state, tracker, 0, { woundClip, bodyClip });
      return Math.abs(tracker.joltVelPitch);
    };
    expect(kick(null)).toBeGreaterThan(0);
    // The clip already shows the hit; a spring on top would only bend the authored pose.
    expect(kick('FLINCH')).toBe(0);
    expect(kick('COMMITTED')).toBe(0);
    expect(kick(null, true)).toBe(0);
  });
});

describe('wounded sequence phases to clips', () => {
  function armOff(state: ReturnType<typeof makeState>): void {
    state.severedZones.add('UPPER_ARM_LEFT');
    state.weaponDropped = true;
  }
  const without = (...clips: string[]): ReadonlySet<string> => new Set([...ALL_CLIPS].filter((c) => !clips.includes(c)));

  it('clutches the lost arm, then kneels, draws on one knee, then aims on one knee', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    armOff(state);
    const { glb, playClip } = makeGlb(ALL_CLIPS);
    state.woundedPhase = 'CLUTCH';
    controller.syncAnimation(glb, state);
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenCalledTimes(1);
    expect(playClip).toHaveBeenLastCalledWith('StumpClutchLeft', 0.2, 1, false);
    expect(controller.isStumpClutching).toBe(true);
    expect(controller.activeWoundClip).toBeNull();

    state.woundedPhase = 'KNEEL_DOWN';
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('StumpKneelLeft', 0.2, 1, false);
    expect(controller.activeWoundClip).toBe('COMMITTED');

    // Drawing: the kneeling stump draw, started once and never restarted.
    state.woundedPhase = 'KNEEL_FIRE';
    state.combatantStatusTag = 'SIDEARM_DRAWING';
    const aim = { clip: sidearmAimClip(state, 'RIGHT'), hand: 'RIGHT' as const };
    expect(aim.clip).toBe('KneelPistolAimOneHand');
    controller.syncAnimation(glb, state, false, undefined, aim);
    controller.syncAnimation(glb, state, false, undefined, aim);
    expect(playClip).toHaveBeenCalledTimes(3);
    expect(playClip).toHaveBeenLastCalledWith('KneelStumpDrawLeft', 0.2, 1, false);

    state.combatantStatusTag = 'SIDEARM_DRAWN';
    controller.syncAnimation(glb, state, false, undefined, aim);
    controller.syncAnimation(glb, state, false, undefined, aim);
    expect(playClip).toHaveBeenCalledTimes(4);
    expect(playClip).toHaveBeenLastCalledWith('KneelPistolAimOneHand', 0.2, 1, false);
    expect(controller.activeWoundClip).toBeNull();

    const southpaw = new CombatantAnimController();
    const lefty = makeGlb(ALL_CLIPS);
    southpaw.syncAnimation(lefty.glb, state, false, undefined, { clip: 'KneelPistolAimOneHand', hand: 'LEFT' });
    expect(lefty.playClip).toHaveBeenLastCalledWith('KneelPistolAimOneHand', 0.2, 1, true);
  });

  it('falls back to the standing aims while the kneeling aim is not baked', () => {
    const state = makeState();
    armOff(state);
    state.woundedPhase = 'KNEEL_DOWN';
    const old = makeGlb(without('KneelPistolAimOneHand'));
    const controller = new CombatantAnimController();
    controller.syncAnimation(old.glb, state);
    expect(old.playClip).toHaveBeenLastCalledWith('StumpKneelLeft', 0.2, 1, false);
    expect(controller.activeWoundClip).toBe('COMMITTED');
    state.woundedPhase = 'KNEEL_FIRE';
    state.combatantStatusTag = 'SIDEARM_DRAWN';
    controller.syncAnimation(old.glb, state, false, undefined, { clip: 'KneelPistolAimOneHand', hand: 'RIGHT' });
    expect(old.playClip).toHaveBeenLastCalledWith('PistolAimOneHand', 0.2, 1, false);
    const older = makeGlb(without('KneelPistolAimOneHand', 'PistolAimOneHand'));
    new CombatantAnimController().syncAnimation(older.glb, state, false, undefined, { clip: 'KneelPistolAimOneHand', hand: 'RIGHT' });
    expect(older.playClip).toHaveBeenLastCalledWith('PistolAim', 0.2, 1, false);
  });

  it('lets a loss win over a phase clip, but a flinch never pops a kneeling body up', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    armOff(state);
    const { glb, playClip } = makeGlb(ALL_CLIPS);
    state.woundedPhase = 'KNEEL_FIRE';
    controller.syncAnimation(glb, state);
    startReaction(state, 'HEAD_SNAP', 0.6);
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenCalledTimes(1);
    expect(playClip).toHaveBeenLastCalledWith('StumpKneelLeft', 0.2, 1, false);
    startReaction(state, 'LEG_LOST_RIGHT', 4.5);
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('LegLossRight', 0.12, 1, false);
  });

  it('blazes on its feet: one-handed aim standing still, the walk while it advances', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    armOff(state);
    state.woundedPhase = 'BLAZE';
    const { glb, playClip } = makeGlb(ALL_CLIPS);
    const aim = { clip: sidearmAimClip(state, 'RIGHT'), hand: 'RIGHT' as const };
    expect(aim.clip).toBe('PistolAimOneHand');
    controller.syncAnimation(glb, state, false, undefined, aim);
    expect(playClip).toHaveBeenLastCalledWith('PistolAimOneHand', 0.12, 1, false);
    controller.syncAnimation(glb, state, false, { clip: 'Walk', playbackSpeed: 0.8 }, aim);
    expect(playClip).toHaveBeenLastCalledWith('Walk', 0.12, 0.8, false);
  });

  it('a crawler rolls from the seat onto its belly after the fall, then crawls at the crawl rate', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    const { glb, playClip, baseLayer } = makeGlb(ALL_CLIPS);
    state.woundedPhase = 'DOWNED_CRAWL';
    state.posture = 'LEG_BUCKLED';
    startReaction(state, 'LEG_BUCKLE_RIGHT', 2.37);
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('LegShotFallRight', 0.12, 1, false);

    state.activeReaction.type = 'NONE';
    baseLayer.activeStateProgress = 1;
    controller.syncAnimation(glb, state, false, undefined, undefined, 0, 1 / 60);
    expect(playClip).toHaveBeenLastCalledWith('SitToCrawl', 0.2, 1, false);
    expect(controller.activeWoundClip).toBe('COMMITTED');
    expect(controller.isCrawling).toBe(false);

    baseLayer.activeStateProgress = 0.3;
    const frames = Math.ceil(SIT_TO_CRAWL_S * 60) - 2;
    for (let i = 0; i < frames; i++) controller.syncAnimation(glb, state, false, undefined, undefined, 0, 1 / 60);
    expect(playClip).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 4; i++) controller.syncAnimation(glb, state, false, undefined, undefined, 0.47, 1 / 60);
    expect(playClip).toHaveBeenCalledTimes(3);
    expect(playClip).toHaveBeenLastCalledWith('Crawl', 0.3, 1, false);
    expect(controller.isCrawling).toBe(true);
    expect(controller.activeWoundClip).toBeNull();
    expect(glb.animComponent.speed).toBeCloseTo(1);
  });

  it('crawls straight away when the roll onto the belly is not baked', () => {
    const controller = new CombatantAnimController();
    const state = makeState();
    const { glb, playClip } = makeGlb(without('SitToCrawl'));
    state.woundedPhase = 'DOWNED_CRAWL';
    controller.syncAnimation(glb, state);
    controller.syncAnimation(glb, state);
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenCalledTimes(1);
    expect(playClip).toHaveBeenLastCalledWith('Crawl', 0.2, 1, false);
    expect(controller.isCrawling).toBe(true);
  });
});
