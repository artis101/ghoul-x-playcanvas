import { describe, expect, it } from 'vitest';
import type { EnemyArchetypeId, ShotSimulationReport, TargetHealthState } from '../src/contracts/ballistics.ts';
import { RED_HEALTH_HP_FRACTION } from '../src/contracts/combatantHealthBands.ts';
import { normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_12G_00_BUCK,
  AMMO_556_NATO_M855,
  DEFAULT_ENVIRONMENT,
  WEAPON_M4A1,
  WEAPON_M590,
} from '../src/core/ballistics/weapons.ts';
import { applyShotReportToTarget, simulateShot } from '../src/core/ballistics/solver.ts';
import { computeCombatantTriageStatus, createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import {
  STOPPING_POWER_DISARM,
  canLoseWeaponToHit,
  isInRedHealthBand,
  isStoppingPowerHit,
  resolveHitDisarm,
} from '../src/core/combatant/hitDisarmPolicy.ts';
import {
  stepEnemyArmamentState,
  type EnemyArmamentState,
  type EnemyArmamentTransitionInput,
} from '../src/core/ai/enemyArmamentFsm.ts';
import { createPhysiologicalEntityState } from '../src/core/physiology/initialState.ts';
import { applyBoneAndNerveTrauma } from '../src/core/physiology/traumaBonesNerves.ts';
import type { BoneTraumaRecord } from '../src/contracts/physiology.ts';

function target(id: string, archetype: EnemyArchetypeId, rangeM: number, hpFraction = 1, seed?: number): TargetHealthState {
  const t = createTargetHealthState(id, id, vec3(0, 0, -rangeM), 0, archetype);
  t.bloodLossRateMlPerSec = 0;
  t.currentHp = t.maxHp * hpFraction;
  if (seed !== undefined) t.shotVarianceSeed = seed;
  return t;
}

function shoot(t: TargetHealthState, rangeM: number, aimY: number, weapon = WEAPON_M590, ammo = AMMO_12G_00_BUCK): ShotSimulationReport {
  const shooter = vec3(0, 1.5, 0);
  const aim = normalize(sub(vec3(0, aimY, -rangeM), shooter));
  return simulateShot(weapon, ammo, shooter, aim, t, DEFAULT_ENVIRONMENT);
}

describe('the red health band is the HUD red', () => {
  it('turns red at the shared fraction, as the triage colour does', () => {
    const t = target('band', 'MILITIA_GUNNER', 5);
    expect(isInRedHealthBand(t)).toBe(false);
    t.currentHp = t.maxHp * (RED_HEALTH_HP_FRACTION + 0.01);
    expect(isInRedHealthBand(t)).toBe(false);
    t.currentHp = t.maxHp * RED_HEALTH_HP_FRACTION;
    expect(computeCombatantTriageStatus(t)).toBe('MORTALLY_WOUNDED');
    expect(isInRedHealthBand(t)).toBe(true);
    expect(canLoseWeaponToHit(t)).toBe(true);
    t.weaponDropped = true;
    expect(canLoseWeaponToHit(t)).toBe(false);
  });

  it('decides a hit disarm: nothing above red, certain with stopping power, otherwise on the roll', () => {
    expect(resolveHitDisarm({ canLoseWeapon: false, stoppingPower: true, roll: 0 })).toBeNull();
    expect(resolveHitDisarm({ canLoseWeapon: true, stoppingPower: true, roll: 0.99 })).toBe('STOPPING_POWER');
    expect(resolveHitDisarm({ canLoseWeapon: true, stoppingPower: false, roll: 0.05 })).toBe('CHANCE');
    expect(resolveHitDisarm({ canLoseWeapon: true, stoppingPower: false, roll: 0.5 })).toBeNull();
    // Headless (no seeded variance): no chance drop at all.
    expect(resolveHitDisarm({ canLoseWeapon: true, stoppingPower: false, roll: null })).toBeNull();
  });
});

describe('primary weapon: a hit only takes it in the red', () => {
  it('a healthy tough enemy hit in the body keeps its rifle, even point blank', () => {
    for (const seed of [undefined, 1, 7, 42, 99]) {
      for (const [rangeM, weapon, ammo] of [[3, WEAPON_M590, AMMO_12G_00_BUCK], [5, WEAPON_M4A1, AMMO_556_NATO_M855]] as const) {
        const t = target(`tough-${rangeM}-${seed}`, 'HEAVY_ENFORCER', rangeM, 1, seed);
        const rep = shoot(t, rangeM, 1.3, weapon, ammo);
        expect(rep.hitTarget).toBe(true);
        applyShotReportToTarget(t, rep);
        expect(t.alive).toBe(true);
        expect(isInRedHealthBand(t)).toBe(false);
        expect(t.weaponDropped).toBe(false);
      }
    }
  });

  it('a close shotgun blast that takes it into the red knocks the gun out of its hands', () => {
    const cases = [['HEAVY_ENFORCER', 3, 0.4], ['MILITIA_GUNNER', 5, 0.45]] as const;
    for (const [archetype, rangeM, hp] of cases) for (const seed of [undefined, 3, 17, 42]) {
      const t = target(`red-${archetype}-${seed}`, archetype, rangeM, hp, seed);
      expect(isInRedHealthBand(t)).toBe(false);
      const rep = shoot(t, rangeM, 1.3);
      expect(isStoppingPowerHit(rep)).toBe(true);
      applyShotReportToTarget(t, rep);
      expect(t.alive).toBe(true);
      expect(isInRedHealthBand(t)).toBe(true);
      expect(t.isRagdollActive).toBe(false);
      expect(t.weaponDropped).toBe(true);
    }
  });

  it('the same blast at 25 m has no stopping power and leaves the gun in hand', () => {
    const t = target('far', 'MILITIA_GUNNER', 25, 0.3);
    const rep = shoot(t, 25, 1.3);
    expect(rep.hitTarget).toBe(true);
    expect(rep.targetDistanceM).toBeGreaterThan(STOPPING_POWER_DISARM.MAX_RANGE_M);
    expect(isStoppingPowerHit(rep)).toBe(false);
    applyShotReportToTarget(t, rep);
    expect(t.alive).toBe(true);
    expect(isInRedHealthBand(t)).toBe(true);
    // No seeded variance: no chance drop, so it keeps the gun.
    expect(t.weaponDropped).toBe(false);
  });

  it('already in the red, a light hit only sometimes makes it let go, the same way for the same seed', () => {
    const outcome = (seed: number): boolean => {
      const t = target(`light-${seed}`, 'MILITIA_GUNNER', 25, 0.3, seed);
      const rep = shoot(t, 25, 1.3);
      applyShotReportToTarget(t, rep);
      expect(t.alive).toBe(true);
      expect(t.isRagdollActive).toBe(false);
      return t.weaponDropped;
    };
    const seeds = Array.from({ length: 80 }, (_, i) => i + 1);
    const drops = seeds.filter(outcome).length;
    expect(drops).toBeGreaterThan(0);
    expect(drops).toBeLessThan(seeds.length / 2);
    for (const seed of seeds.slice(0, 10)) expect(outcome(seed)).toBe(outcome(seed));
  });

  it('a severed gun arm drops the gun whatever the health', () => {
    const t = target('sever', 'MILITIA_GUNNER', 2);
    const handPt = t.ragdollBones.FOREARM_RIGHT.position;
    const origin = vec3(handPt.x, handPt.y, handPt.z + 1.5);
    const rep = simulateShot(WEAPON_M590, AMMO_12G_00_BUCK, origin, normalize(sub(handPt, origin)), t, DEFAULT_ENVIRONMENT);
    applyShotReportToTarget(t, rep);
    const armGone = ['HAND_RIGHT', 'FOREARM_RIGHT', 'UPPER_ARM_RIGHT'].some((z) => t.severedZones.has(z as never));
    expect(armGone).toBe(true);
    expect(t.weaponDropped).toBe(true);
    expect(t.primaryArmDisarmed).toBe(true);
  });

  it('a broken or nerve-cut arm gives out only when the shot path allows the roll', () => {
    const fracture: BoneTraumaRecord = {
      boneId: 'HUMERUS_RIGHT', fractured: true, shattered: false, energyDepositedJ: 300,
      deflectionAngleDeg: 0, spawnedShardCount: 0, positionLocal: vec3(0, 1.3, 0),
    };
    const held = createPhysiologicalEntityState({ entityId: 'held', dominantHand: 'RIGHT' });
    held.armOutRollsAllowed = false;
    applyBoneAndNerveTrauma(held, [fracture], ['BRACHIAL_PLEXUS_RIGHT'], 'NONE', 'NONE');
    expect(held.rightArmFunctional).toBe(true);
    expect(held.weaponDropped).toBe(false);

    // With the roll allowed and no variance seed, the old deterministic rule applies.
    const rolled = createPhysiologicalEntityState({ entityId: 'rolled', dominantHand: 'RIGHT' });
    rolled.armOutRollsAllowed = true;
    applyBoneAndNerveTrauma(rolled, [fracture], [], 'NONE', 'NONE');
    expect(rolled.rightArmFunctional).toBe(false);
    expect(rolled.weaponDropped).toBe(true);
  });
});

describe('a drawn sidearm cannot be shot or knocked out of the hand', () => {
  const standing: EnemyArmamentTransitionInput = {
    dt: 1 / 60,
    alive: true,
    rightArmIntact: true,
    leftArmIntact: true,
    preferredPrimaryHand: 'RIGHT',
    intactHand: 'RIGHT',
    weaponDropped: true,
    primaryArmDisarmed: false,
    isRagdollActive: false,
    isAirborneRagdoll: false,
    carriesBackupSidearm: true,
    isGuarding: false,
    isLastStandVital: true,
    sidearmDrawDurationS: 0.6,
  };
  const drawn: EnemyArmamentState = { kind: 'SIDEARM_ACTIVE', hand: 'RIGHT' };

  it('keeps it through flinches, fall clips, knockdowns, face-down and crawling', () => {
    const cases: Partial<EnemyArmamentTransitionInput>[] = [
      { woundClipPlaying: true },
      { sidearmRule: 'HOLSTER' },
      { sidearmRule: 'DROP' },
      { isRagdollActive: true, isAirborneRagdoll: true, sidearmRule: 'HOLSTER' },
      { isRagdollActive: true, isAirborneRagdoll: true, sidearmRule: 'DROP' },
      { isRagdollActive: true, sidearmRule: 'DROP' },
      { seatedOnFloor: true, sidearmRule: 'HOLSTER' },
      { primaryArmDisarmed: true },
    ];
    for (const extra of cases) {
      const r = stepEnemyArmamentState(drawn, { ...standing, ...extra });
      expect(r.state).toEqual(drawn);
    }
  });

  it('keeps it when a close stopping-power hit lands on a fighter holding only the sidearm', () => {
    const t = target('sidearm-hit', 'MILITIA_GUNNER', 3, 0.3);
    t.weaponDropped = true;
    t.combatantStatusTag = 'SIDEARM_DRAWN';
    expect(canLoseWeaponToHit(t)).toBe(false);
    const rep = shoot(t, 3, 1.3);
    applyShotReportToTarget(t, rep);
    if (t.alive) {
      expect(t.rightArmFunctional).toBe(true);
      expect(t.leftArmFunctional).toBe(true);
      const r = stepEnemyArmamentState(drawn, {
        ...standing,
        isRagdollActive: t.isRagdollActive,
        isAirborneRagdoll: t.isRagdollActive && t.posture === 'AIRBORNE_RAGDOLL',
        sidearmRule: 'HOLSTER',
      });
      expect(r.state).toEqual(drawn);
    }
  });

  it('loses it with the arm that holds it, and only then', () => {
    const leftDrawn: EnemyArmamentState = { kind: 'SIDEARM_ACTIVE', hand: 'LEFT' };
    // The other arm going does not cost it the pistol, and it does not jump hands.
    const otherArm = stepEnemyArmamentState(leftDrawn, { ...standing, rightArmIntact: false, intactHand: 'LEFT' });
    expect(otherArm.state).toEqual(leftDrawn);
    // Its own arm severed or put out of action: the pistol is gone for good.
    const ownArm = stepEnemyArmamentState(leftDrawn, { ...standing, leftArmIntact: false, intactHand: 'RIGHT' });
    expect(ownArm.state).toEqual({ kind: 'DISARMED', sidearmDropped: true });
    expect(stepEnemyArmamentState(ownArm.state, { ...standing, leftArmIntact: false }).state).toEqual({
      kind: 'DISARMED',
      sidearmDropped: true,
    });
    // Also while flying through the air.
    const airborne = stepEnemyArmamentState(leftDrawn, {
      ...standing, leftArmIntact: false, intactHand: 'RIGHT', isRagdollActive: true, isAirborneRagdoll: true,
    });
    expect(airborne.state).toEqual({ kind: 'DISARMED', sidearmDropped: true });
    // And on death.
    expect(stepEnemyArmamentState(leftDrawn, { ...standing, alive: false }).state).toEqual({
      kind: 'DISARMED',
      sidearmDropped: true,
    });
  });
});
