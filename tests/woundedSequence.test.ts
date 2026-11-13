import { describe, expect, it } from 'vitest';
import type { GhoulZoneId, ShotSimulationReport, TargetHealthState, Vec3Like } from '../src/contracts/ballistics.ts';
import {
  DOWNED_FIRE_CONE_RAD,
  KNEEL_FIRE_CONE_RAD,
  type WoundedSequenceInput,
  effectiveFortitude,
  rollFortitude,
  stepWoundedSequence,
  woundedPhaseAllowsDraw,
  woundedPhaseAllowsFire,
  woundedPhaseKeepsBodyStill,
} from '../src/core/ai/woundedSequenceFsm.ts';
import {
  stepLivingTargetVitalsAndFall,
  transitionTargetLifecycle,
} from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { FACE_DOWN_SETTLE_S, isFaceDownLanding } from '../src/core/ballistics/triage/faceDownLanding.ts';
import { applyDismembermentTree } from '../src/core/ballistics/trauma/dismembermentTreeApplicator.ts';
import { startWoundReaction } from '../src/core/ballistics/trauma/woundReactionSelector.ts';
import {
  STUMP_KNEEL_S,
  WOUND_CLIP_SECONDS,
  clutchSeconds,
} from '../src/core/ballistics/trauma/woundReactionTimings.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { getSubtreeZones } from '../src/core/ghoul/anatomy/ghoulHierarchy.ts';
import type { WoundedPhase } from '../src/contracts/ballistics/targetHealthContracts.ts';

const DT = 1 / 60;
const DEG = Math.PI / 180;

/** Player straight in front, in sight, and the body has a pistol and a hand for it. */
const FRONT: WoundedSequenceInput = {
  dt: DT,
  hasSidearm: true,
  freeArmWorks: true,
  playerBearingRad: 0,
  playerVisible: true,
};
const ASIDE: WoundedSequenceInput = { ...FRONT, playerBearingRad: 90 * DEG };

function fresh(id = 'seq', fortitude?: number): TargetHealthState {
  const t = createTargetHealthState(id, 'Militia', vec3(0, 0, -10), 0);
  t.bloodLossRateMlPerSec = 0;
  t.consciousness = 1;
  if (fortitude !== undefined) t.fortitude = fortitude;
  return t;
}

function sever(target: TargetHealthState, ...zones: GhoulZoneId[]): void {
  const dismembermentEvents = zones.map((zone) => ({
    zone,
    goreMode: 'CLEAN_SEVER' as const,
    detachedSubtree: getSubtreeZones(zone),
    stumpWorldPosition: target.ragdollBones[zone].position,
    arterialSprayDirection: vec3(0, 1, 0),
    severedLimbVelocity: vec3(0, 1, 0),
    severedLimbAngularVelocity: vec3(0, 0, 0),
    gibCount: 0,
  }));
  applyDismembermentTree(target, { dismembermentEvents } as unknown as ShotSimulationReport);
}

/** One game frame: the wounded sequence, then the lifecycle (reaction clock and downed gate). */
function run(t: TargetHealthState, input: WoundedSequenceInput, seconds: number): void {
  for (let s = 0; s < seconds - 1e-9; s += DT) {
    stepWoundedSequence(t, input);
    stepLivingTargetVitalsAndFall(t, DT, 0);
  }
}

/** Blows the left arm off a healthy body and plays the arm-loss clip to its end. */
function armOff(fortitude: number, id = 'arm'): TargetHealthState {
  const t = fresh(id, fortitude);
  sever(t, 'UPPER_ARM_LEFT');
  // Keep health steady so effective fortitude equals the rolled value through the test.
  t.currentHp = t.maxHp;
  t.bloodLossRateMlPerSec = 0;
  startWoundReaction(t, {
    hitZone: 'UPPER_ARM_LEFT',
    severity: 'PENETRATING',
    newlySeveredLegSide: null,
    newlySeveredArmSide: 'LEFT',
    energyJ: 300,
    hitDirectionWorld: vec3(0, 0, -1),
  });
  return t;
}

/** Shoots the right leg off a healthy body: it lifts, hops and falls. */
function legOff(fortitude: number, id = 'leg'): TargetHealthState {
  const t = fresh(id, fortitude);
  sever(t, 'THIGH_RIGHT');
  t.currentHp = t.maxHp;
  t.bloodLossRateMlPerSec = 0;
  startWoundReaction(t, {
    hitZone: 'THIGH_RIGHT',
    severity: 'PENETRATING',
    newlySeveredLegSide: 'RIGHT',
    newlySeveredArmSide: null,
    energyJ: 300,
    hitDirectionWorld: vec3(0, 0, -1),
  });
  return t;
}

// A body lying with its head toward +z on a floor at y = 0.
function lying(faceDown: boolean, id = faceDown ? 'prone' : 'supine'): TargetHealthState {
  const t = fresh(id, 0.5);
  const place = (zone: GhoulZoneId, p: Vec3Like): void => {
    t.ragdollBones[zone].position = p;
    t.ragdollBones[zone].prevPosition = p;
  };
  const left = faceDown ? 1 : -1;
  place('PELVIS_GROIN', vec3(0, 0.12, 0));
  place('TORSO_UPPER_THORAX', vec3(0, 0.15, 0.35));
  place('NECK_CERVICAL', vec3(0, 0.17, 0.55));
  place('SHOULDER_LEFT', vec3(0.2 * left, 0.17, 0.5));
  place('SHOULDER_RIGHT', vec3(-0.2 * left, 0.17, 0.5));
  transitionTargetLifecycle(t, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
  transitionTargetLifecycle(t, { kind: 'UPDATE_RAGDOLL_GROUNDED', groundedBoneCount: 8 });
  return t;
}

/** A body in the given phase; floor phases lie on their back in the ragdoll, as in the game. */
function withPhase(phase: WoundedPhase): TargetHealthState {
  const t = phase.startsWith('DOWNED') || phase === 'FACE_DOWN' ? lying(false, `phase-${phase}`) : fresh(`phase-${phase}`, 0.5);
  t.woundedPhase = phase;
  return t;
}

describe('fortitude', () => {
  it('is rolled once per combatant from its resolve profile, with a steady per-id nudge', () => {
    const bases = {
      FANATIC_BERSERKER: 0.9,
      HARDENED_VETERAN: 0.75,
      GRITTY_REGULAR: 0.5,
      PANICKED_SCRAPPER: 0.25,
    } as const;
    for (const [profile, base] of Object.entries(bases)) {
      const t = createTargetHealthState(`p-${profile}`, 'Militia', vec3(), 0);
      t.resolveProfile = profile as keyof typeof bases;
      const f = rollFortitude(t);
      expect(Math.abs(f - base)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(t.fortitude).toBe(f);
      t.resolveProfile = 'PANICKED_SCRAPPER';
      expect(rollFortitude(t)).toBe(f);
    }
    const a = createTargetHealthState('same-id', 'Militia', vec3(), 0);
    const b = createTargetHealthState('same-id', 'Militia', vec3(), 0);
    expect(rollFortitude(a)).toBe(rollFortitude(b));
    const plain = rollFortitude(createTargetHealthState('no-profile', 'Militia', vec3(), 0));
    expect(Math.abs(plain - 0.5)).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('keeps a value already set, and weighs it down by lost health and consciousness', () => {
    const t = fresh('eff', 0.8);
    expect(rollFortitude(t)).toBe(0.8);
    expect(effectiveFortitude(t)).toBeCloseTo(0.8);
    t.currentHp = t.maxHp * 0.5;
    expect(effectiveFortitude(t)).toBeCloseTo(0.8 * 0.75);
    t.consciousness = 0.5;
    expect(effectiveFortitude(t)).toBeCloseTo(0.8 * 0.75 * 0.5);
  });

  it('shortens the stump clutch for the gritty', () => {
    expect(clutchSeconds(0)).toBeCloseTo(2.5);
    expect(clutchSeconds(1)).toBeCloseTo(0.8);
    expect(clutchSeconds(0.5)).toBeCloseTo(1.65);
  });
});

describe('after an arm comes off, one thing at a time', () => {
  it('does nothing while the arm-loss clip plays, then clutches the stump', () => {
    const t = armOff(1);
    run(t, FRONT, WOUND_CLIP_SECONDS.ARM_LOSS - 0.1);
    expect(t.activeReaction.type).toBe('ARM_LOST_LEFT');
    expect(t.woundedPhase ?? 'NONE').toBe('NONE');
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
    run(t, FRONT, 0.2);
    expect(t.woundedPhase).toBe('CLUTCH');
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });

  it('high fortitude lets go after a short clutch and blazes away on its feet', () => {
    const t = armOff(1);
    run(t, FRONT, WOUND_CLIP_SECONDS.ARM_LOSS + 0.05);
    expect(t.woundedPhase).toBe('CLUTCH');
    run(t, FRONT, clutchSeconds(1) - 0.1);
    expect(t.woundedPhase).toBe('CLUTCH');
    run(t, FRONT, 0.15);
    expect(t.woundedPhase).toBe('BLAZE');
    expect(t.isRagdollActive).toBe(false);
    expect(woundedPhaseAllowsDraw(t)).toBe(true);
    expect(woundedPhaseAllowsFire(t, ASIDE)).toBe(true);
    expect(woundedPhaseKeepsBodyStill(t)).toBe(false);
  });

  it('a low-fortitude body clutches longer before it acts', () => {
    const t = armOff(0.45);
    run(t, FRONT, WOUND_CLIP_SECONDS.ARM_LOSS + 0.05);
    run(t, FRONT, clutchSeconds(0.45) - 0.1);
    expect(t.woundedPhase).toBe('CLUTCH');
    expect(clutchSeconds(0.45)).toBeGreaterThan(clutchSeconds(1));
  });

  it('middling fortitude kneels down first, and only then shoots, inside its cone', () => {
    const t = armOff(0.45);
    run(t, FRONT, WOUND_CLIP_SECONDS.ARM_LOSS + 0.05 + clutchSeconds(0.45) + 0.05);
    expect(t.woundedPhase).toBe('KNEEL_DOWN');
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
    run(t, FRONT, STUMP_KNEEL_S - 0.1);
    expect(t.woundedPhase).toBe('KNEEL_DOWN');
    run(t, FRONT, 0.15);
    expect(t.woundedPhase).toBe('KNEEL_FIRE');
    expect(woundedPhaseAllowsDraw(t)).toBe(true);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(true);
    expect(woundedPhaseAllowsFire(t, { playerBearingRad: KNEEL_FIRE_CONE_RAD + 0.05, playerVisible: true })).toBe(false);
    expect(woundedPhaseKeepsBodyStill(t)).toBe(true);
  });

  it('low fortitude sits down: the collapse plays, then the downed plan applies', () => {
    const t = armOff(0.2);
    run(t, FRONT, WOUND_CLIP_SECONDS.ARM_LOSS + 0.05 + clutchSeconds(0.2) - 0.05);
    expect(t.woundedPhase).toBe('CLUTCH');
    for (let i = 0; i < 30 && t.activeReaction.type !== 'DOWNED_COLLAPSE'; i++) stepWoundedSequence(t, FRONT);
    expect(t.activeReaction.type).toBe('DOWNED_COLLAPSE');
    expect(t.activeReaction.durationS).toBe(WOUND_CLIP_SECONDS.DOWNED_COLLAPSE);
    expect(t.weaponDropped).toBe(true);
    // It shows SIT_DOWN for the whole collapse while it plans the floor: player in front, so engage.
    run(t, FRONT, WOUND_CLIP_SECONDS.DOWNED_COLLAPSE - 0.1);
    expect(t.activeReaction.type).toBe('DOWNED_COLLAPSE');
    expect(t.woundedPhase).toBe('SIT_DOWN');
    expect(t.plannedDownedPhase).toBe('DOWNED_ENGAGE');
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
    // When the collapse ends it takes the plan and lies in the ragdoll, even at full health.
    run(t, FRONT, 0.2);
    expect(t.currentHp).toBe(t.maxHp);
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    expect(t.isRagdollActive).toBe(true);
    // Not on the floor yet (no solver runs here), so it holds its fire.
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });

  it('a sit-down that plans agony also ends in the ragdoll and never stands back up', () => {
    const t = armOff(0.2, 'sit-agony');
    const still = { ...ASIDE, hasSidearm: true };
    run(t, FRONT, WOUND_CLIP_SECONDS.ARM_LOSS + clutchSeconds(0.2) + 0.1);
    expect(t.activeReaction.type).toBe('DOWNED_COLLAPSE');
    t.consciousness = 0.3;
    run(t, still, WOUND_CLIP_SECONDS.DOWNED_COLLAPSE + 0.2);
    expect(t.woundedPhase).toBe('DOWNED_AGONY');
    expect(t.isRagdollActive).toBe(true);
    expect(t.posture).not.toBe('DISARMED');
  });

  it('a downed phase never stands on an animated body: the gate drops it', () => {
    const t = fresh('stray-engage', 0.5);
    t.woundedPhase = 'DOWNED_ENGAGE';
    stepLivingTargetVitalsAndFall(t, DT, 0);
    expect(t.isRagdollActive).toBe(true);
  });

  it('sits down with SIT_DOWN on the frame it decides', () => {
    const t = armOff(0.2);
    run(t, FRONT, WOUND_CLIP_SECONDS.ARM_LOSS + 0.05);
    let saw: WoundedPhase | undefined;
    for (let i = 0; i < 400 && t.activeReaction.type !== 'DOWNED_COLLAPSE'; i++) {
      stepWoundedSequence(t, FRONT);
      saw = t.woundedPhase;
    }
    expect(saw).toBe('SIT_DOWN');
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });

  it('with no sidearm, or no hand to hold one, it keeps clutching, harmless', () => {
    for (const input of [{ ...FRONT, hasSidearm: false }, { ...FRONT, freeArmWorks: false }]) {
      const t = armOff(1, `harmless-${input.hasSidearm}`);
      run(t, input, WOUND_CLIP_SECONDS.ARM_LOSS + 5);
      expect(t.woundedPhase).toBe('CLUTCH');
      expect(woundedPhaseAllowsDraw(t)).toBe(false);
      expect(woundedPhaseAllowsFire(t, input)).toBe(false);
    }
  });

  it('a blazing body that loses its pistol goes back to clutching', () => {
    const t = armOff(1);
    run(t, FRONT, WOUND_CLIP_SECONDS.ARM_LOSS + 1.2);
    expect(t.woundedPhase).toBe('BLAZE');
    run(t, { ...FRONT, hasSidearm: false }, DT);
    expect(t.woundedPhase).toBe('CLUTCH');
  });
});

describe('a falling body plans what it will do on the floor', () => {
  const plan = (input: WoundedSequenceInput, fortitude = 0.5, consciousness = 1): WoundedPhase | undefined => {
    const t = legOff(fortitude);
    t.consciousness = consciousness;
    stepWoundedSequence(t, input);
    return t.woundedPhase;
  };

  it('engages only a visible player straight in front, with a pistol and an arm', () => {
    expect(plan({ ...FRONT, playerBearingRad: DOWNED_FIRE_CONE_RAD - 0.01 })).toBe('DOWNED_ENGAGE');
    expect(plan({ ...FRONT, playerBearingRad: DOWNED_FIRE_CONE_RAD + 0.05 })).toBe('DOWNED_CRAWL');
    expect(plan({ ...FRONT, playerBearingRad: null })).toBe('DOWNED_CRAWL');
    expect(plan({ ...FRONT, playerVisible: false })).toBe('DOWNED_CRAWL');
    expect(plan({ ...FRONT, hasSidearm: false })).toBe('DOWNED_CRAWL');
  });

  it('crawls only when awake and not too gritty; otherwise lies in agony', () => {
    expect(plan(ASIDE, 0.5, 0.4)).toBe('DOWNED_AGONY');
    expect(plan(ASIDE, 0.95)).toBe('DOWNED_AGONY');
    expect(plan({ ...ASIDE, freeArmWorks: false })).toBe('DOWNED_AGONY');
    expect(plan({ ...FRONT, freeArmWorks: false })).toBe('DOWNED_AGONY');
  });

  it('follows the player during the fall but fires at nothing until it lands', () => {
    const t = legOff(0.5);
    run(t, ASIDE, 1);
    expect(t.woundedPhase).toBe('DOWNED_CRAWL');
    run(t, FRONT, 1);
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });
});

describe('the downed gate', () => {
  it('keeps a crawler animated and on the floor after its fall', () => {
    const t = legOff(0.5);
    run(t, ASIDE, WOUND_CLIP_SECONDS.LEG_LOSS + 0.1);
    expect(t.activeReaction.type).toBe('NONE');
    expect(t.woundedPhase).toBe('DOWNED_CRAWL');
    expect(t.isRagdollActive).toBe(false);
    expect(t.posture).toBe('LEG_BUCKLED');
    run(t, FRONT, 3);
    expect(t.isRagdollActive).toBe(false);
    expect(t.woundedPhase).toBe('DOWNED_CRAWL');
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
    expect(woundedPhaseKeepsBodyStill(t)).toBe(true);
  });

  it('does not collapse a crawling arm-loser again', () => {
    const t = armOff(0.2);
    run(t, ASIDE, WOUND_CLIP_SECONDS.ARM_LOSS + clutchSeconds(0.2) + WOUND_CLIP_SECONDS.DOWNED_COLLAPSE + 0.3);
    expect(t.woundedPhase).toBe('DOWNED_CRAWL');
    t.currentHp = t.maxHp * 0.2;
    run(t, ASIDE, 1);
    expect(t.activeReaction.type).toBe('NONE');
    expect(t.isRagdollActive).toBe(false);
  });

  it('a hit on a crawler only jolts it: no new fall, no replanning into a shooter', () => {
    const t = legOff(0.5, 'crawl-hit');
    run(t, ASIDE, WOUND_CLIP_SECONDS.LEG_LOSS + 0.5);
    expect(t.woundedPhase).toBe('DOWNED_CRAWL');
    const jolts = t.joltEpoch ?? 0;
    startWoundReaction(t, {
      hitZone: 'THIGH_LEFT',
      severity: 'PENETRATING',
      newlySeveredLegSide: null,
      newlySeveredArmSide: null,
      energyJ: 300,
      hitDirectionWorld: vec3(0, 0, -1),
    });
    expect(t.joltEpoch).toBe(jolts + 1);
    expect(t.activeReaction.type).toBe('NONE');
    run(t, FRONT, WOUND_CLIP_SECONDS.LEG_SHOT_FALL + 0.5);
    expect(t.woundedPhase).toBe('DOWNED_CRAWL');
    expect(t.isRagdollActive).toBe(false);
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });

  it('a fall forced onto a landed crawler keeps it crawling, even with the player in front', () => {
    const t = legOff(0.5, 'crawl-fall');
    run(t, ASIDE, WOUND_CLIP_SECONDS.LEG_LOSS + 0.5);
    expect(t.woundedPhase).toBe('DOWNED_CRAWL');
    transitionTargetLifecycle(t, {
      kind: 'START_PAIN_REACTION',
      reactionType: 'LEG_BUCKLE_LEFT',
      durationS: WOUND_CLIP_SECONDS.LEG_SHOT_FALL,
      intensity: 0.8,
      hitDirectionWorld: vec3(0, 0, -1),
      postureOverride: 'LEG_BUCKLED',
    });
    run(t, FRONT, WOUND_CLIP_SECONDS.LEG_SHOT_FALL + 0.5);
    expect(t.woundedPhase).toBe('DOWNED_CRAWL');
    expect(t.isRagdollActive).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });

  it('ragdolls every other plan, facing the way it stood', () => {
    for (const [input, phase] of [
      [FRONT, 'DOWNED_ENGAGE'],
      [{ ...ASIDE, freeArmWorks: false }, 'DOWNED_AGONY'],
    ] as const) {
      const t = legOff(0.5, `gate-${phase}`);
      t.yawRad = Math.PI / 2;
      run(t, input, WOUND_CLIP_SECONDS.LEG_LOSS + 0.1);
      expect(t.isRagdollActive).toBe(true);
      expect(t.woundedPhase).toBe(phase);
      expect(t.downedFacingWorld?.x).toBeCloseTo(1);
      expect(t.downedFacingWorld?.z).toBeCloseTo(0);
    }
  });
});

describe('on the floor', () => {
  it('a body lying in agony engages once the player steps in front of it', () => {
    const t = lying(false);
    stepWoundedSequence(t, ASIDE);
    expect(t.woundedPhase).toBe('DOWNED_AGONY');
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
    stepWoundedSequence(t, FRONT);
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    expect(woundedPhaseAllowsDraw(t)).toBe(true);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(true);
  });

  it('an engaged body holds fire when the player steps aside or out of sight, but stays engaged', () => {
    const t = lying(false);
    t.woundedPhase = 'DOWNED_ENGAGE';
    stepWoundedSequence(t, ASIDE);
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    expect(woundedPhaseAllowsFire(t, ASIDE)).toBe(false);
    expect(woundedPhaseAllowsFire(t, { playerBearingRad: 0, playerVisible: false })).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(true);
  });

  it('a ragdoll knocked down without a wound clip gets a downed phase, never NONE', () => {
    const t = lying(false);
    t.woundedPhase = 'BLAZE';
    stepWoundedSequence(t, { ...ASIDE, hasSidearm: false });
    expect(t.woundedPhase).toBe('DOWNED_AGONY');
    expect(t.downedFacingWorld).toBeDefined();
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });

  it('a body down on its face never draws or fires again', () => {
    const t = lying(true);
    t.woundedPhase = 'DOWNED_ENGAGE';
    expect(isFaceDownLanding(t, 0)).toBe(true);
    run(t, FRONT, FACE_DOWN_SETTLE_S + 0.05);
    expect(t.woundedPhase).toBe('FACE_DOWN');
    // Even rolled over afterwards, with the player straight in front.
    const sup = lying(false);
    t.ragdollBones.SHOULDER_LEFT.position = sup.ragdollBones.SHOULDER_LEFT.position;
    t.ragdollBones.SHOULDER_RIGHT.position = sup.ragdollBones.SHOULDER_RIGHT.position;
    for (let i = 0; i < 120; i++) stepWoundedSequence(t, FRONT);
    expect(t.woundedPhase).toBe('FACE_DOWN');
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });

  it('the lifecycle commits face down only after it settles; meanwhile it holds fire', () => {
    const t = lying(true);
    t.woundedPhase = 'DOWNED_ENGAGE';
    stepLivingTargetVitalsAndFall(t, DT, 0);
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
    for (let s = 0; s < FACE_DOWN_SETTLE_S; s += DT) stepLivingTargetVitalsAndFall(t, DT, 0);
    expect(t.woundedPhase).toBe('FACE_DOWN');
    const sup = lying(false);
    expect(isFaceDownLanding(sup, 0)).toBe(false);
    stepLivingTargetVitalsAndFall(sup, DT, 0);
    expect(sup.woundedPhase).toBeUndefined();
  });

  it('a body that only tips onto its face while still tumbling is not locked face down', () => {
    const t = lying(true);
    t.woundedPhase = 'DOWNED_ENGAGE';
    // Still moving: the face-down clock does not run, however long it shows the shape.
    t.ragdollBones.PELVIS_GROIN.velocity = vec3(0, 0, 1.5);
    for (let s = 0; s < FACE_DOWN_SETTLE_S + 0.3; s += DT) stepLivingTargetVitalsAndFall(t, DT, 0);
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    // It rolls back onto its back: the pending mark clears and it may engage again.
    const sup = lying(false);
    t.ragdollBones.SHOULDER_LEFT.position = sup.ragdollBones.SHOULDER_LEFT.position;
    t.ragdollBones.SHOULDER_RIGHT.position = sup.ragdollBones.SHOULDER_RIGHT.position;
    t.ragdollBones.PELVIS_GROIN.velocity = vec3(0, 0, 0);
    stepLivingTargetVitalsAndFall(t, DT, 0);
    expect(t.faceDownSettleS).toBeUndefined();
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(true);
  });

  it('a body lying in agony on its face does not engage while the shape is pending', () => {
    const t = lying(true);
    t.woundedPhase = 'DOWNED_AGONY';
    stepLivingTargetVitalsAndFall(t, DT, 0);
    stepWoundedSequence(t, FRONT);
    expect(t.woundedPhase).toBe('DOWNED_AGONY');
  });

  it('a crawler knocked into the ragdoll lies harmless', () => {
    const t = lying(false);
    t.woundedPhase = 'DOWNED_CRAWL';
    stepWoundedSequence(t, FRONT);
    expect(t.woundedPhase).toBe('FACE_DOWN');
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });
});

describe('what each phase allows', () => {
  const ALL: WoundedPhase[] = [
    'NONE', 'CLUTCH', 'BLAZE', 'KNEEL_DOWN', 'KNEEL_FIRE', 'SIT_DOWN',
    'DOWNED_ENGAGE', 'DOWNED_CRAWL', 'DOWNED_AGONY', 'FACE_DOWN',
  ];
  const view = { playerBearingRad: 0, playerVisible: true };

  it('draws only in BLAZE, KNEEL_FIRE and DOWNED_ENGAGE', () => {
    const drawing = ALL.filter((p) => woundedPhaseAllowsDraw(withPhase(p)));
    expect(drawing).toEqual(['BLAZE', 'KNEEL_FIRE', 'DOWNED_ENGAGE']);
  });

  it('fires only when fighting normally or in a shooting phase', () => {
    const firing = ALL.filter((p) => woundedPhaseAllowsFire(withPhase(p), view));
    expect(firing).toEqual(['NONE', 'BLAZE', 'KNEEL_FIRE', 'DOWNED_ENGAGE']);
    const engage = withPhase('DOWNED_ENGAGE');
    expect(woundedPhaseAllowsFire(engage, { playerBearingRad: DOWNED_FIRE_CONE_RAD + 0.01, playerVisible: true })).toBe(false);
    expect(woundedPhaseAllowsFire(engage, { playerBearingRad: null, playerVisible: true })).toBe(false);
  });

  it('a downed engager holds its gun until it lies on the floor', () => {
    const airborne = withPhase('DOWNED_ENGAGE');
    transitionTargetLifecycle(airborne, { kind: 'UPDATE_RAGDOLL_GROUNDED', groundedBoneCount: 0 });
    expect(woundedPhaseAllowsDraw(airborne)).toBe(false);
    expect(woundedPhaseAllowsFire(airborne, view)).toBe(false);
    const standing = fresh('engage-standing', 0.5);
    standing.woundedPhase = 'DOWNED_ENGAGE';
    expect(woundedPhaseAllowsDraw(standing)).toBe(false);
    expect(woundedPhaseAllowsFire(standing, view)).toBe(false);
  });

  it('never draws or fires while a committed wound clip plays, or once dead', () => {
    for (const p of ['NONE', 'BLAZE', 'KNEEL_FIRE', 'DOWNED_ENGAGE'] as const) {
      const t = withPhase(p);
      t.activeReaction.type = 'DOWNED_COLLAPSE';
      expect(woundedPhaseAllowsDraw(t)).toBe(false);
      expect(woundedPhaseAllowsFire(t, view)).toBe(false);
      const dead = withPhase(p);
      dead.alive = false;
      expect(woundedPhaseAllowsFire(dead, view)).toBe(false);
    }
  });

  it('keeps the body still in every phase but NONE and BLAZE', () => {
    const moving = ALL.filter((p) => !woundedPhaseKeepsBodyStill(withPhase(p)));
    expect(moving).toEqual(['NONE', 'BLAZE']);
  });
});
