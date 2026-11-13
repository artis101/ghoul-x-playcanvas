import { describe, expect, it } from 'vitest';
import type { GhoulZoneId, ShotSimulationReport, TargetHealthState } from '../src/contracts/ballistics.ts';
import { stepLivingTargetVitalsAndFall } from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { applyDismembermentTree } from '../src/core/ballistics/trauma/dismembermentTreeApplicator.ts';
import {
  type WoundReactionInput,
  buckleOnLateLegCripple,
  startWoundReaction,
} from '../src/core/ballistics/trauma/woundReactionSelector.ts';
import { WOUND_CLIP_SECONDS } from '../src/core/ballistics/trauma/woundReactionTimings.ts';
import { stepEnemyArmamentState } from '../src/core/ai/enemyArmamentFsm.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { getSubtreeZones } from '../src/core/ghoul/anatomy/ghoulHierarchy.ts';
import { TacticalCombatAiSystem } from '../src/engine/ai/tacticalCombatAi.ts';
import { moveHorizontalClamped } from '../src/engine/ai/tacticalLocomotion.ts';

const DT = 1 / 60;

function fresh(id = 'w'): TargetHealthState {
  const t = createTargetHealthState(id, 'Militia', vec3(0, 0, -10), 0);
  t.bloodLossRateMlPerSec = 0;
  return t;
}

function hit(overrides: Partial<WoundReactionInput>): WoundReactionInput {
  return {
    hitZone: 'TORSO_UPPER_THORAX',
    severity: 'PENETRATING',
    newlySeveredLegSide: null,
    newlySeveredArmSide: null,
    energyJ: 300,
    hitDirectionWorld: vec3(0, 0, -1),
    ...overrides,
  };
}

/** Cuts zones off the way a shot would and returns which limbs went. */
function sever(target: TargetHealthState, ...zones: GhoulZoneId[]) {
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
  return applyDismembermentTree(target, { dismembermentEvents } as unknown as ShotSimulationReport);
}

function stepFor(target: TargetHealthState, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) stepLivingTargetVitalsAndFall(target, DT, 0);
}

function maxBodySpeed(target: TargetHealthState): number {
  let max = 0;
  for (const b of Object.values(target.ragdollBones)) {
    if (b.componentId !== 'BODY') continue;
    max = Math.max(max, Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z));
  }
  return max;
}

describe('the dismemberment tree reports which limbs it newly took', () => {
  it('flags a hand, forearm or upper arm as a lost arm on its side', () => {
    expect(sever(fresh(), 'HAND_LEFT')).toMatchObject({ newlySeveredLeftArm: true, newlySeveredRightArm: false });
    expect(sever(fresh(), 'FOREARM_RIGHT')).toMatchObject({ newlySeveredRightArm: true, newlySeveredLeftArm: false });
    expect(sever(fresh(), 'SHIN_RIGHT')).toMatchObject({ newlySeveredRightLeg: true, newlySeveredRightArm: false });
  });
});

describe('each wound picks its own reaction', () => {
  it('a leg blown off hops and falls, and the gun goes', () => {
    const t = fresh();
    t.rightLegFunctional = false;
    startWoundReaction(t, hit({ hitZone: 'THIGH_RIGHT', newlySeveredLegSide: 'RIGHT' }));
    expect(t.activeReaction.type).toBe('LEG_LOST_RIGHT');
    expect(t.activeReaction.durationS).toBe(WOUND_CLIP_SECONDS.LEG_LOSS);
    expect(t.posture).toBe('LEG_BUCKLED');
    expect(t.weaponDropped).toBe(true);
  });

  it('an arm blown off recoils and clutches, disarmed', () => {
    const t = fresh();
    sever(t, 'FOREARM_LEFT');
    startWoundReaction(t, hit({ hitZone: 'FOREARM_LEFT', newlySeveredArmSide: 'LEFT' }));
    expect(t.activeReaction.type).toBe('ARM_LOST_LEFT');
    expect(t.activeReaction.durationS).toBe(WOUND_CLIP_SECONDS.ARM_LOSS);
    expect(t.posture).toBe('DISARMED');
    expect(t.weaponDropped).toBe(true);
  });

  it('a crippled leg buckles and falls on the bad side', () => {
    const t = fresh();
    t.leftLegFunctional = false;
    startWoundReaction(t, hit({ hitZone: 'KNEE_LEFT' }));
    expect(t.activeReaction.type).toBe('LEG_BUCKLE_LEFT');
    expect(t.activeReaction.durationS).toBe(WOUND_CLIP_SECONDS.LEG_SHOT_FALL);
    expect(t.posture).toBe('LEG_BUCKLED');
    expect(t.weaponDropped).toBe(true);
  });

  it('a leg that still works only flinches, and a graze does not stagger', () => {
    const t = fresh();
    startWoundReaction(t, hit({ hitZone: 'SHIN_RIGHT' }));
    expect(t.activeReaction.type).toBe('LEG_FLINCH_RIGHT');
    expect(t.posture).toBe('STAGGERED');
    expect(t.weaponDropped).toBe(false);

    const g = fresh();
    startWoundReaction(g, hit({ hitZone: 'FOOT_LEFT', severity: 'GRAZE' }));
    expect(g.activeReaction.type).toBe('LEG_FLINCH_LEFT');
    expect(g.activeReaction.durationS).toBe(0.22);
    expect(g.posture).toBe('COMBAT_READY');
  });

  it('keeps the torso, head and arm flinches as they were', () => {
    const cases: [Partial<WoundReactionInput>, string, number][] = [
      [{ hitZone: 'NECK_CERVICAL', severity: 'CRITICAL' }, 'THROAT_CLUTCH', 1.1],
      [{ hitZone: 'TORSO_LOWER_ABDOMEN', severity: 'CRITICAL' }, 'GUT_FOLD', 1.1],
      [{ hitZone: 'HEAD_CRANIUM' }, 'HEAD_SNAP', 0.65],
      [{ hitZone: 'UPPER_ARM_RIGHT', severity: 'CRITICAL' }, 'ARM_WRENCH_RIGHT', 0.8],
      [{ hitZone: 'TORSO_UPPER_THORAX', severity: 'GRAZE' }, 'CHEST_STAGGER', 0.22],
    ];
    for (const [input, type, durationS] of cases) {
      const t = fresh();
      startWoundReaction(t, hit(input));
      expect(t.activeReaction.type).toBe(type);
      expect(t.activeReaction.durationS).toBeCloseTo(durationS, 5);
    }
  });
});

describe('a fall, loss or collapse plays out once started', () => {
  it('is not restarted by a lesser hit, which only jolts', () => {
    const t = fresh();
    t.rightLegFunctional = false;
    startWoundReaction(t, hit({ hitZone: 'THIGH_RIGHT', newlySeveredLegSide: 'RIGHT' }));
    stepFor(t, 0.5);
    const { epoch, timerS } = t.activeReaction;
    const jolts = t.joltEpoch ?? 0;

    startWoundReaction(t, hit({ hitZone: 'HEAD_CRANIUM', hitDirectionWorld: vec3(1, 0, 0), energyJ: 600 }));
    expect(t.activeReaction.type).toBe('LEG_LOST_RIGHT');
    expect(t.activeReaction.epoch).toBe(epoch);
    expect(t.activeReaction.timerS).toBe(timerS);
    expect(t.joltEpoch).toBe(jolts + 1);
    expect(t.lastJoltDirectionWorld).toEqual(vec3(1, 0, 0));
    expect(t.lastJoltIntensity).toBeGreaterThan(0);
  });

  it('jolts on every surviving hit, flinches included', () => {
    const t = fresh();
    startWoundReaction(t, hit({}));
    startWoundReaction(t, hit({}));
    expect(t.joltEpoch).toBe(2);
  });

  it('gives way to a leg lost while clutching an arm stump', () => {
    const t = fresh();
    sever(t, 'HAND_RIGHT');
    startWoundReaction(t, hit({ hitZone: 'HAND_RIGHT', newlySeveredArmSide: 'RIGHT' }));
    stepFor(t, 0.4);
    expect(t.activeReaction.type).toBe('ARM_LOST_RIGHT');

    sever(t, 'SHIN_LEFT');
    expect(t.alive).toBe(true);
    startWoundReaction(t, hit({ hitZone: 'SHIN_LEFT', newlySeveredLegSide: 'LEFT' }));
    expect(t.activeReaction.type).toBe('LEG_LOST_LEFT');
    expect(t.activeReaction.timerS).toBe(0);
  });

  it('keeps a fall going when a late leg cripple comes through the physiology', () => {
    const t = fresh();
    t.rightLegFunctional = false;
    startWoundReaction(t, hit({ hitZone: 'THIGH_RIGHT', newlySeveredLegSide: 'RIGHT' }));
    const epoch = t.activeReaction.epoch;
    buckleOnLateLegCripple(t);
    expect(t.activeReaction.epoch).toBe(epoch);

    const f = fresh();
    startWoundReaction(f, hit({ hitZone: 'THIGH_LEFT' }));
    expect(f.activeReaction.type).toBe('LEG_FLINCH_LEFT');
    f.leftLegFunctional = false;
    buckleOnLateLegCripple(f);
    expect(f.activeReaction.type).toBe('LEG_BUCKLE_LEFT');
    expect(f.weaponDropped).toBe(true);
  });
});

describe('the ragdoll takes the body when the clip has put it down', () => {
  it('a lost leg goes ragdoll only once its clip ends, with a small settle', () => {
    const t = fresh();
    sever(t, 'THIGH_RIGHT');
    startWoundReaction(t, hit({ hitZone: 'THIGH_RIGHT', newlySeveredLegSide: 'RIGHT' }));
    stepFor(t, WOUND_CLIP_SECONDS.LEG_LOSS - 0.1);
    expect(t.isRagdollActive).toBe(false);
    expect(t.activeReaction.type).toBe('LEG_LOST_RIGHT');

    stepFor(t, 0.15);
    expect(t.isRagdollActive).toBe(true);
    expect(t.alive).toBe(true);
    expect(maxBodySpeed(t)).toBeLessThan(0.2);
  });

  it('an arm lost while strong stays standing after the stump clutch', () => {
    const t = fresh();
    sever(t, 'UPPER_ARM_LEFT');
    startWoundReaction(t, hit({ hitZone: 'UPPER_ARM_LEFT', newlySeveredArmSide: 'LEFT' }));
    t.currentHp = t.maxHp * 0.6;
    stepFor(t, WOUND_CLIP_SECONDS.ARM_LOSS + 1);
    expect(t.activeReaction.type).toBe('NONE');
    expect(t.isRagdollActive).toBe(false);
    expect(t.posture).toBe('DISARMED');
  });

  it('a leg crippled during the stump clutch plays the leg fall before the ragdoll', () => {
    const t = fresh();
    sever(t, 'HAND_RIGHT');
    startWoundReaction(t, hit({ hitZone: 'HAND_RIGHT', newlySeveredArmSide: 'RIGHT' }));
    t.currentHp = t.maxHp * 0.6;
    stepFor(t, 0.5);
    // The leg goes out but is not severed, so the committed clutch only jolts.
    t.leftLegFunctional = false;
    startWoundReaction(t, hit({ hitZone: 'KNEE_LEFT' }));
    expect(t.activeReaction.type).toBe('ARM_LOST_RIGHT');

    stepFor(t, WOUND_CLIP_SECONDS.ARM_LOSS);
    expect(t.activeReaction.type).toBe('LEG_BUCKLE_LEFT');
    expect(t.isRagdollActive).toBe(false);
    stepFor(t, WOUND_CLIP_SECONDS.LEG_SHOT_FALL + 0.1);
    expect(t.isRagdollActive).toBe(true);
    expect(maxBodySpeed(t)).toBeLessThan(0.2);
  });

  it('an arm lost with little health left collapses, then goes ragdoll after the collapse', () => {
    const t = fresh();
    sever(t, 'FOREARM_RIGHT');
    t.currentHp = t.maxHp * 0.3;
    stepLivingTargetVitalsAndFall(t, DT, 0);
    expect(t.activeReaction.type).toBe('DOWNED_COLLAPSE');
    expect(t.activeReaction.durationS).toBe(WOUND_CLIP_SECONDS.DOWNED_COLLAPSE);
    expect(t.weaponDropped).toBe(true);
    expect(t.isRagdollActive).toBe(false);

    stepFor(t, WOUND_CLIP_SECONDS.DOWNED_COLLAPSE - 0.1);
    expect(t.isRagdollActive).toBe(false);
    stepFor(t, 0.15);
    expect(t.isRagdollActive).toBe(true);
    expect(t.ragdollPhase.kind).toBe('LIVING_AGONY');
    expect(maxBodySpeed(t)).toBeLessThan(0.2);
  });
});

describe('the AI leaves a body alone while its wound clip plays', () => {
  it('locomotion does not slide the root during a committed reaction', () => {
    const t = fresh();
    t.rightLegFunctional = false;
    startWoundReaction(t, hit({ hitZone: 'THIGH_RIGHT', newlySeveredLegSide: 'RIGHT' }));
    const before = { ...t.worldPosition };
    moveHorizontalClamped(t, before.x + 2, before.z, 1, null);
    expect(t.worldPosition).toEqual(before);
  });

  it('an agent stepping through a leg loss neither moves, turns nor fires', () => {
    const fired: unknown[] = [];
    const ai = new TacticalCombatAiSystem({
      sightDetectionRangeM: 30,
      initialPlayerHealth: 100,
      initialPlayerArmor: 0,
      onEnemyFireTracer: (ev) => fired.push(ev),
    });
    const t = createTargetHealthState('rx_ai', 'Militia', vec3(-1.5, 0, -14), 0, 'MILITIA_GUNNER');
    t.bloodLossRateMlPerSec = 0;
    ai.registerWaveTargets([t], false);
    ai.notifyGunshotOrExplosion(vec3(0, 1.6, 0), 35);

    sever(t, 'SHIN_RIGHT');
    startWoundReaction(t, hit({ hitZone: 'SHIN_RIGHT', newlySeveredLegSide: 'RIGHT' }));
    const pos = { ...t.worldPosition };
    const yaw = t.yawRad;
    const firedBefore = fired.length;
    for (let s = 0; s < WOUND_CLIP_SECONDS.LEG_LOSS - 0.2; s += 0.05) {
      ai.update(0.05, [t], vec3(3, 1.62, 0));
      stepLivingTargetVitalsAndFall(t, 0.05, 0);
    }
    expect(t.activeReaction.type).toBe('LEG_LOST_RIGHT');
    expect(t.worldPosition).toEqual(pos);
    expect(t.yawRad).toBe(yaw);
    expect(t.posture).toBe('LEG_BUCKLED');
    expect(fired.length).toBe(firedBefore);
    ai.destroy();
  });

  it('holds the sidearm draw until the arm-loss clip is over', () => {
    const base = {
      dt: DT,
      alive: true,
      rightArmIntact: false,
      leftArmIntact: true,
      preferredPrimaryHand: 'RIGHT' as const,
      intactHand: 'LEFT' as const,
      weaponDropped: true,
      primaryArmDisarmed: true,
      isRagdollActive: false,
      isAirborneRagdoll: false,
      carriesBackupSidearm: true,
      isGuarding: false,
      isLastStandVital: false,
      sidearmDrawDurationS: 0.8,
    };
    const held = stepEnemyArmamentState({ kind: 'PRIMARY_ARMED', hand: 'RIGHT' }, { ...base, woundClipPlaying: true });
    expect(held.state.kind).toBe('DISARMED');
    expect(held.events).not.toContain('SIDEARM_DRAW_START');
    expect(held.forceDisarmedPosture).toBe(false);

    const after = stepEnemyArmamentState(held.state, { ...base, woundClipPlaying: false });
    expect(after.state.kind).toBe('SIDEARM_DRAWING');
    expect(after.events).toContain('SIDEARM_DRAW_START');
  });
});
