import { describe, expect, it } from 'vitest';
import { NEUTRAL_CONSTITUTION, type CombatantConstitution } from '../src/contracts/combatantConstitution.ts';
import type { EnemyArchetypeId } from '../src/contracts/ballistics.ts';
import type { BoneTraumaRecord, OrganTraumaRecord } from '../src/contracts/physiology.ts';
import { normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_556_NATO_M855,
  AMMO_50AE_JHP,
  DEFAULT_ENVIRONMENT,
  WEAPON_M4A1,
  WEAPON_SILVER_TALON,
} from '../src/core/ballistics/weapons.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import {
  applyShotReportToTarget,
  computeCombatantTriageStatus,
  simulateShot,
} from '../src/core/ballistics/solver.ts';
import { rollPelletVariance } from '../src/core/ballistics/shot/terminalVariance.ts';
import { rollConstitution } from '../src/core/combatant/constitutionRoll.ts';
import { createSeededRng } from '../src/core/random/seededRng.ts';
import { PhysiologyEcsSystem } from '../src/core/physiology/physiologySystem.ts';
import { applyOrganTrauma } from '../src/core/physiology/traumaOrgans.ts';
import { startTerminalCountdown } from '../src/core/physiology/physiologyVariance.ts';

function torsoTarget(id: string, seed?: number, archetype: EnemyArchetypeId = 'MILITIA_GUNNER') {
  const t = createTargetHealthState(id, 'Rifleman', vec3(0, 0, -12), 0, archetype);
  if (seed !== undefined) t.shotVarianceSeed = seed;
  return t;
}

function shootChest(
  target: ReturnType<typeof torsoTarget>,
  weapon = WEAPON_M4A1,
  ammo = AMMO_556_NATO_M855,
  heightM = 1.3
) {
  const origin = vec3(0, heightM, 0);
  const aim = normalize(sub(vec3(-0.03, heightM, -12), origin));
  return simulateShot(weapon, ammo, origin, aim, target, DEFAULT_ENVIRONMENT);
}

function heartRecord(): OrganTraumaRecord {
  return {
    organId: 'HEART',
    isInelastic: false,
    directCrushLacerated: true,
    stretchCavitationRuptured: true,
    energyDepositedJ: 900,
    severity: 1,
    positionLocal: vec3(0, 1.3, 0),
    positionWorld: vec3(0, 1.3, 0),
  };
}

describe('Combat variance', () => {
  it('rolls ordinary constitutions near 1.0 and rare standout traits', () => {
    const rng = createSeededRng(42);
    const rolls = Array.from({ length: 2000 }, () => rollConstitution(rng));
    const share = (trait: string) => rolls.filter((c) => c.trait === trait).length / rolls.length;
    expect(share('NONE')).toBeGreaterThan(0.6);
    for (const trait of ['STIM_HEAD', 'GLASS_JAW', 'TANK']) {
      expect(share(trait)).toBeGreaterThan(0.04);
      expect(share(trait)).toBeLessThan(0.15);
    }
    const ordinary = rolls.filter((c) => c.trait === 'NONE');
    expect(Math.min(...ordinary.map((c) => c.toughness))).toBeGreaterThanOrEqual(0.85);
    expect(Math.max(...ordinary.map((c) => c.toughness))).toBeLessThanOrEqual(1.2);
    expect(rollConstitution(createSeededRng(7))).toEqual(rollConstitution(createSeededRng(7)));
  });

  it('gives a rifle round every terminal behaviour across seeds, and the same one for the same seed', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 400; seed++) {
      seen.add(rollPelletVariance(seed, 0, WEAPON_M4A1, AMMO_556_NATO_M855).behavior);
    }
    expect([...seen].sort()).toEqual(['FRAGMENT', 'ICEPICK', 'NOMINAL', 'TUMBLE']);
    const a = rollPelletVariance(99, 0, WEAPON_M4A1, AMMO_556_NATO_M855);
    const b = rollPelletVariance(99, 0, WEAPON_M4A1, AMMO_556_NATO_M855);
    expect(a.behavior).toBe(b.behavior);
    expect(a.depositScale).toBe(b.depositScale);
  });

  it('keeps shots deterministic without a seed, and varies them with one', () => {
    const plainA = shootChest(torsoTarget('plain_a'));
    const plainB = shootChest(torsoTarget('plain_b'));
    expect(plainA.hitTarget).toBe(true);
    expect(plainA.totalDamageHp).toBe(plainB.totalDamageHp);
    expect(plainA.terminalVariance ?? null).toBeNull();
    expect(plainA.delayedLethality ?? null).toBeNull();

    const damages = new Set<number>();
    for (let seed = 1; seed <= 30; seed++) {
      damages.add(Math.round(shootChest(torsoTarget(`v${seed}`, seed)).totalDamageHp));
    }
    expect(damages.size).toBeGreaterThan(5);

    // Re-simulating one trigger pull agrees with itself.
    const t = torsoTarget('same', 1234);
    expect(shootChest(t).totalDamageHp).toBe(shootChest(t).totalDamageHp);
  });

  it('advances the variance seed after each hit so follow-up shots roll afresh', () => {
    const t = torsoTarget('bump', 555);
    const rep = shootChest(t);
    applyShotReportToTarget(t, rep);
    expect(t.shotVarianceSeed).not.toBe(555);
  });

  it('lets some fatal trauma hits fight on for a few seconds instead of dropping at once', () => {
    let instant = 0;
    let delayed = 0;
    for (let seed = 1; seed <= 120; seed++) {
      // A .50 AE through the belly is fatal through trauma at nominal behaviour, on an ordinary
      // build: a tough one (archetypeToughness.ts) usually survives it.
      const t = torsoTarget(`lethal${seed}`, seed, 'SKINHEAD_PUNK');
      const rep = shootChest(t, WEAPON_SILVER_TALON, AMMO_50AE_JHP, 1.05);
      if (!rep.hitTarget) continue;
      if (rep.delayedLethality) {
        delayed++;
        expect(rep.isLethalKill).toBe(false);
        expect(rep.delayedLethality.delayS).toBeGreaterThanOrEqual(2);
        expect(rep.delayedLethality.delayS).toBeLessThanOrEqual(16);
        applyShotReportToTarget(t, rep);
        expect(t.alive).toBe(true);
        expect(t.currentHp).toBeGreaterThanOrEqual(1);
        expect(computeCombatantTriageStatus(t)).toBe('MORTALLY_WOUNDED');
      } else if (rep.isLethalKill) {
        instant++;
      }
    }
    expect(delayed).toBeGreaterThan(10);
    expect(instant).toBeGreaterThan(10);
  });

  it('kills when the borrowed-time countdown runs out', () => {
    const ecs = new PhysiologyEcsSystem(10);
    const s = ecs.registerEntity({ entityId: 'dmw', constitution: NEUTRAL_CONSTITUTION, varianceSeed: 3 });
    startTerminalCountdown(s, 2.0, 'CARDIAC_DESTRUCTION');
    ecs.update(1.5);
    expect(s.alive).toBe(true);
    ecs.update(0.7);
    expect(s.alive).toBe(false);
    expect(s.causeOfDeath).toBe('CARDIAC_DESTRUCTION');
  });

  it('stops a destroyed heart at once without variance, and only sometimes with it', () => {
    const ecs = new PhysiologyEcsSystem(10);
    const plain = ecs.registerEntity({ entityId: 'plain_heart' });
    applyOrganTrauma(plain, [heartRecord()], 'NONE', 'NONE');
    expect(plain.alive).toBe(false);

    let survivedHit = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = ecs.registerEntity({ entityId: `heart${seed}`, constitution: NEUTRAL_CONSTITUTION, varianceSeed: seed });
      applyOrganTrauma(s, [heartRecord()], 'NONE', 'NONE');
      if (s.alive) {
        survivedHit++;
        expect(s.terminalCountdownS).toBeGreaterThan(2.9);
      }
    }
    expect(survivedHit).toBeGreaterThan(20);
    expect(survivedHit).toBeLessThan(55);
  });

  it('slows venous bleeding faster for good clotters', () => {
    const clot = (clotting: number) => {
      const ecs = new PhysiologyEcsSystem(10);
      const constitution: CombatantConstitution = { ...NEUTRAL_CONSTITUTION, clotting };
      const s = ecs.registerEntity({ entityId: 'c', constitution });
      s.baseBleedRateMlPerSec = 10;
      ecs.update(10);
      return s.baseBleedRateMlPerSec;
    };
    expect(clot(1.4)).toBeLessThan(clot(0.6));
    expect(clot(0.6)).toBeLessThan(10);
  });

  it('reads a punctured lung as wounded and a ruptured heart as mortal', () => {
    const t = torsoTarget('triage');
    t.currentHp = t.maxHp * 0.8;
    t.rupturedOrgans.add('Right Lung');
    expect(computeCombatantTriageStatus(t)).toBe('WOUNDED');
    t.rupturedOrgans.add('Heart (Myocardium & Ventricles)');
    expect(computeCombatantTriageStatus(t)).toBe('MORTALLY_WOUNDED');
  });
});

describe('Weapon drops are rare', () => {
  function armFracture(): BoneTraumaRecord {
    return {
      boneId: 'HUMERUS_RIGHT',
      fractured: true,
      shattered: false,
      energyDepositedJ: 300,
      deflectionAngleDeg: 0,
      spawnedShardCount: 0,
      positionLocal: vec3(-0.25, 1.3, 0),
    };
  }

  it('disarms on every gun-arm fracture without variance, and only rarely with it', async () => {
    const { applyBoneAndNerveTrauma } = await import('../src/core/physiology/traumaBonesNerves.ts');
    const ecs = new PhysiologyEcsSystem(10);
    const plain = ecs.registerEntity({ entityId: 'plain_arm', dominantHand: 'RIGHT' });
    applyBoneAndNerveTrauma(plain, [armFracture()], [], 'NONE', 'NONE');
    expect(plain.weaponDropped).toBe(true);

    let dropped = 0;
    const n = 400;
    for (let seed = 1; seed <= n; seed++) {
      const s = ecs.registerEntity({ entityId: `arm${seed}`, dominantHand: 'RIGHT', varianceSeed: seed * 31 });
      applyBoneAndNerveTrauma(s, [armFracture()], [], 'NONE', 'NONE');
      if (s.weaponDropped) {
        dropped++;
        expect(s.rightArmFunctional).toBe(false);
      } else {
        // Fought through: the arm still works, just shakily.
        expect(s.rightArmFunctional).toBe(true);
        expect(s.aimSwayMultiplier).toBeGreaterThanOrEqual(4.4);
      }
    }
    expect(dropped / n).toBeGreaterThan(0.05);
    expect(dropped / n).toBeLessThan(0.2);
  });

  it('rarely knocks the gun out of a hand hit by a pistol round', () => {
    let disarmed = 0;
    let hits = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const t = torsoTarget(`hand${seed}`, seed * 977);
      const hand = t.ragdollBones[t.isLeftHanded ? 'HAND_LEFT' : 'HAND_RIGHT'].position;
      const origin = vec3(hand.x, hand.y, 0);
      const rep = simulateShot(
        WEAPON_SILVER_TALON, AMMO_50AE_JHP, origin, normalize(sub(hand, origin)), t, DEFAULT_ENVIRONMENT
      );
      if (!rep.woundEvents.some((w) => w.ghoulZone.startsWith('HAND_'))) continue;
      hits++;
      if (rep.weaponDisarmed) disarmed++;
    }
    expect(hits).toBeGreaterThan(50);
    expect(disarmed / hits).toBeLessThan(0.4);
  });
});
