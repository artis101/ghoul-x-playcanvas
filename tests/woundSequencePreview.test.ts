import { describe, expect, it } from 'vitest';
import type { PainReactionType } from '../src/contracts/ballistics.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import {
  applySequenceHit, findWoundSequence, resolveSequenceZone, WOUND_SEQUENCES,
} from '../src/engine/gm/woundSequences.ts';
import { stepRagdollPhysics } from '../src/core/ballistics/ragdoll/ragdollVerletStep.ts';
import { senseWoundedPlayer } from '../src/engine/ai/woundedSequenceDriver.ts';
import { LabCombatantBrain } from '../src/engine/gm/labCombatantBrain.ts';
import { fortitudeOverride, standInPosition, type PlayerStandIn } from '../src/engine/gm/woundedLabStandIn.ts';

function freshTarget(southpaw = false) {
  return createTargetHealthState('seq', 'Seq', { x: 0, y: 0, z: 0 }, 0, 'MILITIA_GUNNER', southpaw);
}

/** Lands every step of a sequence at once, in order, and returns the target. */
function runAllSteps(id: string, southpaw = false) {
  const def = findWoundSequence(id);
  if (!def) throw new Error(`no sequence ${id}`);
  const hs = freshTarget(southpaw);
  for (const step of def.steps) applySequenceHit(hs, step.hit);
  return hs;
}

describe('Character Lab wound sequences', () => {
  it('have unique ids and steps in time order', () => {
    const ids = WOUND_SEQUENCES.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of WOUND_SEQUENCES) {
      const times = def.steps.map((step) => step.atS);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it('puts the gun arm on the trigger side', () => {
    expect(resolveSequenceZone('GUN_ARM', false)).toBe('UPPER_ARM_RIGHT');
    expect(resolveSequenceZone('GUN_ARM', true)).toBe('UPPER_ARM_LEFT');
    expect(resolveSequenceZone('SUPPORT_ARM', false)).toBe('UPPER_ARM_LEFT');
  });

  const firstReaction: ReadonlyArray<[string, PainReactionType]> = [
    ['chest', 'CHEST_STAGGER'],
    ['head', 'HEAD_SNAP'],
    ['gut', 'GUT_FOLD'],
    ['throat', 'THROAT_CLUTCH'],
    ['gun-arm', 'ARM_WRENCH_RIGHT'],
    ['support-arm', 'ARM_WRENCH_LEFT'],
    ['leg-r', 'LEG_FLINCH_RIGHT'],
    ['leg-l', 'LEG_FLINCH_LEFT'],
    ['cripple-r', 'LEG_BUCKLE_RIGHT'],
    ['cripple-l', 'LEG_BUCKLE_LEFT'],
    ['leg-off-r', 'LEG_LOST_RIGHT'],
    ['leg-off-l', 'LEG_LOST_LEFT'],
    ['hand-off-r', 'ARM_LOST_RIGHT'],
    ['hand-off-l', 'ARM_LOST_LEFT'],
    ['forearm-off-r', 'ARM_LOST_RIGHT'],
    ['arm-off-l', 'ARM_LOST_LEFT'],
  ];
  it.each(firstReaction)('%s starts %s through the core wound path', (id, type) => {
    const hs = runAllSteps(id);
    expect(hs.alive).toBe(true);
    expect(hs.activeReaction.type).toBe(type);
  });

  it('a graze is only a short twitch', () => {
    const hs = runAllSteps('graze');
    expect(hs.activeReaction.durationS).toBeLessThan(0.3);
  });

  it('cuts limbs off and keeps the body from bleeding out during the preview', () => {
    const hs = runAllSteps('hand-off-r');
    expect(hs.severedZones.has('HAND_RIGHT')).toBe(true);
    expect(hs.rightArmFunctional).toBe(false);
    expect(hs.bloodLossRateMlPerSec).toBe(0);
  });

  it('a chest hit during the leg-loss fall does not restart the fall', () => {
    const hs = runAllSteps('hit-during-fall');
    expect(hs.activeReaction.type).toBe('LEG_LOST_RIGHT');
  });

  it('the last stand drains HP below the collapse line after the arm is gone', () => {
    const hs = runAllSteps('last-stand');
    expect(hs.severedZones.has('FOREARM_LEFT')).toBe(true);
    expect(hs.currentHp).toBeLessThanOrEqual(hs.maxHp * 0.32);
  });
});

describe('Character Lab wounded-sequence branches (headless brain)', () => {
  interface Trace {
    readonly hs: ReturnType<typeof freshTarget>;
    readonly brain: LabCombatantBrain;
    /** Each phase in the order it was first entered. */
    readonly phases: string[];
    /** Phases in which a sidearm was out (drawing or drawn). */
    readonly drawnIn: Set<string>;
    /** Phases in which the brain said it would fire. */
    readonly firedIn: Set<string>;
    standIn: PlayerStandIn;
  }

  /** Runs a branch sequence at 60 Hz through the lab brain and the ragdoll, as the lab does. */
  function simulate(id: string, seconds: number, standIn?: PlayerStandIn, until?: (t: Trace) => boolean): Trace {
    const def = findWoundSequence(id);
    if (!def) throw new Error(`no sequence ${id}`);
    const hs = freshTarget();
    hs.fortitude = fortitudeOverride(def.preset?.fortitude ?? 'AUTO');
    const trace: Trace = {
      hs, phases: [], drawnIn: new Set(), firedIn: new Set(), standIn: standIn ?? def.preset?.standIn ?? 'FRONT',
      brain: undefined as unknown as LabCombatantBrain,
    };
    const brain = new LabCombatantBrain(hs, def.preset?.sidearm ?? true, () => standInPosition(trace.standIn));
    (trace as { brain: LabCombatantBrain }).brain = brain;
    for (const step of def.steps) applySequenceHit(hs, step.hit);
    const dt = 1 / 60;
    for (let i = 0; i < seconds * 60 && hs.alive; i++) {
      const crawling = hs.woundedPhase === 'DOWNED_CRAWL' && hs.activeReaction.type === 'NONE';
      brain.step(dt, crawling);
      stepRagdollPhysics(hs, dt, 0);
      const phase = hs.woundedPhase ?? 'NONE';
      if (trace.phases[trace.phases.length - 1] !== phase) trace.phases.push(phase);
      if (brain.armamentKind.startsWith('SIDEARM')) trace.drawnIn.add(phase);
      if (brain.wouldFire) trace.firedIn.add(phase);
      if (until?.(trace)) break;
    }
    return trace;
  }

  const SHOOTING = new Set(['NONE', 'BLAZE', 'KNEEL_FIRE', 'DOWNED_ENGAGE']);
  const onlyShootingPhases = (phases: Set<string>) => [...phases].every((p) => SHOOTING.has(p));

  it('measures the stand-in bearing from the way the body faces', () => {
    const hs = freshTarget();
    const bearing = (s: PlayerStandIn) => (senseWoundedPlayer(hs, standInPosition(s), () => false).playerBearingRad ?? -1) * 180 / Math.PI;
    expect(bearing('FRONT')).toBeCloseTo(0);
    expect(bearing('LEFT')).toBeCloseTo(90);
    expect(bearing('BEHIND')).toBeCloseTo(180);
    expect(fortitudeOverride('AUTO')).toBeUndefined();
  });

  it('arm off, high fortitude: clutches, then draws and blazes on its feet', () => {
    const t = simulate('arm-blaze', 8, undefined, (tr) => tr.brain.armamentKind === 'SIDEARM_ACTIVE');
    expect(t.phases).toEqual(['NONE', 'CLUTCH', 'BLAZE']);
    expect([...t.drawnIn]).toEqual(['BLAZE']);
    expect(t.brain.wouldFire).toBe(true);
  });

  it('arm off, middling: kneels, draws only once down, fires inside the kneel cone only', () => {
    const t = simulate('arm-kneel', 10, undefined, (tr) => tr.brain.armamentKind === 'SIDEARM_ACTIVE');
    expect(t.phases).toEqual(['NONE', 'CLUTCH', 'KNEEL_DOWN', 'KNEEL_FIRE']);
    expect([...t.drawnIn]).toEqual(['KNEEL_FIRE']);
    expect(t.brain.wouldFire).toBe(true);
    t.standIn = 'LEFT';
    t.brain.step(1 / 60, false);
    expect(t.brain.wouldFire).toBe(false);
  });

  it('arm off, low: sits down and is downed, never drawing on the way', () => {
    const t = simulate('arm-sit', 10);
    expect(t.phases.slice(0, 3)).toEqual(['NONE', 'CLUTCH', 'SIT_DOWN']);
    expect(t.phases.some((p) => p.startsWith('DOWNED_'))).toBe(true);
    expect(onlyShootingPhases(t.drawnIn)).toBe(true);
    expect(onlyShootingPhases(t.firedIn)).toBe(true);
  });

  it('arm off with no sidearm: keeps clutching and never fires', () => {
    const t = simulate('arm-no-sidearm', 8);
    expect(t.phases).toEqual(['NONE', 'CLUTCH']);
    expect(t.drawnIn.size).toBe(0);
    expect(t.brain.wouldFire).toBe(false);
  });

  // Headless, nothing seats the body with the fall clip (poseFromAnimation is off), so the
  // ragdoll tips from a standing pose onto its face. It plans to engage through the fall, but
  // once the face-down shape shows it holds fire and, settled, is face down for good.
  it('leg off with you in front: plans to engage, but a face-down landing never shoots', () => {
    const t = simulate('leg-front', 10);
    expect(t.phases).toContain('DOWNED_ENGAGE');
    expect(t.hs.woundedPhase).toBe('FACE_DOWN');
    expect(t.firedIn.size).toBe(0);
    expect(onlyShootingPhases(t.drawnIn)).toBe(true);
  });

  it('leg off with you to the side: crawls away or lies in agony, and never shoots', () => {
    const t = simulate('leg-side', 10);
    expect(['DOWNED_CRAWL', 'DOWNED_AGONY']).toContain(t.hs.woundedPhase);
    expect(t.firedIn.has('DOWNED_CRAWL') || t.firedIn.has('DOWNED_AGONY')).toBe(false);
    expect(t.drawnIn.has('DOWNED_CRAWL') || t.drawnIn.has('DOWNED_AGONY')).toBe(false);
  });

  it('a forward knockdown lands face down: no gun, no damage', () => {
    const t = simulate('face-down', 6);
    expect(t.hs.alive).toBe(true);
    expect(t.hs.woundedPhase).toBe('FACE_DOWN');
    expect(t.brain.wouldFire).toBe(false);
    expect(t.drawnIn.has('FACE_DOWN')).toBe(false);
  });
});
