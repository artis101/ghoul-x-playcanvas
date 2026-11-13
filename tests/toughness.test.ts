import { describe, expect, it } from 'vitest';
import type { EnemyArchetypeId, ShotSimulationReport, TargetHealthState, WoundChannelEvent } from '../src/contracts/ballistics.ts';
import { copyVec3, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_12G_00_BUCK,
  AMMO_556_NATO_M855,
  DEFAULT_ENVIRONMENT,
  WEAPON_M4A1,
  WEAPON_M590,
} from '../src/core/ballistics/weapons.ts';
import { applyShotReportToTarget, deathClipFor, simulateShot } from '../src/core/ballistics/solver.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { WoundChannelTally, weakEnoughForKnockdown } from '../src/core/ballistics/shot/archetypeToughness.ts';
import { evaluateLethalityAndRagdollPlan } from '../src/core/ballistics/shot/shotLethalityPass.ts';
import { applySurvivingReaction } from '../src/core/ballistics/trauma/reactionAgonyApplicator.ts';
import type { NewlySeveredLimbs } from '../src/core/ballistics/trauma/dismembermentTreeApplicator.ts';

const TOUGH: readonly EnemyArchetypeId[] = ['MILITIA_GUNNER', 'MASKED_BRUISER', 'HEAVY_ENFORCER'];

function target(id: string, archetype: EnemyArchetypeId, rangeM: number, seed?: number): TargetHealthState {
  const t = createTargetHealthState(id, 'Tough', vec3(0, 0, -rangeM), 0, archetype);
  t.bloodLossRateMlPerSec = 0;
  if (seed !== undefined) t.shotVarianceSeed = seed;
  return t;
}

/** A 00 buckshot blast aimed at the middle of the chest from a standing shooter. */
function blastChest(t: TargetHealthState, rangeM: number): ShotSimulationReport {
  const shooter = vec3(0, 1.5, 0);
  const aim = normalize(sub(vec3(0, 1.3, -rangeM), shooter));
  return simulateShot(WEAPON_M590, AMMO_12G_00_BUCK, shooter, aim, t, DEFAULT_ENVIRONMENT);
}

describe('toughness: a body blast does not fold a tough guy', () => {
  it('keeps more than 80% of its health and stays on its feet after a shotgun blast to the torso at 8 m', () => {
    for (const archetype of TOUGH) {
      for (const seed of [undefined, 3, 17, 42]) {
        const t = target(`t8-${archetype}-${seed}`, archetype, 8, seed);
        const before = copyVec3(t.worldPosition);
        const rep = blastChest(t, 8);
        expect(rep.pelletResults.filter((p) => p.hitTarget).length).toBeGreaterThanOrEqual(5);
        applyShotReportToTarget(t, rep);
        expect(t.alive).toBe(true);
        expect(t.currentHp / t.maxHp).toBeGreaterThan(0.8);
        expect(t.isRagdollActive).toBe(false);
        // It flinches where it stands: no shove across the floor.
        expect(t.worldPosition).toEqual(before);
      }
    }
  });

  it('a skinny punk takes far more from the same blast', () => {
    const punk = target('punk8', 'SKINHEAD_PUNK', 8);
    const tough = target('tough8', 'MILITIA_GUNNER', 8);
    const punkFrac = blastChest(punk, 8).totalDamageHp / punk.maxHp;
    const toughFrac = blastChest(tough, 8).totalDamageHp / tough.maxHp;
    expect(punkFrac).toBeGreaterThan(2.5 * toughFrac);
  });

  it('a point-blank blast at full health rocks a tough guy but does not knock him down', () => {
    for (const archetype of TOUGH) {
      const t = target(`t3-${archetype}`, archetype, 3);
      const before = copyVec3(t.worldPosition);
      const rep = blastChest(t, 3);
      const imp = rep.ragdollPlan.netRootImpulseWorld;
      // Hard enough to knock a spent body flat...
      expect(Math.hypot(imp.x, imp.z)).toBeGreaterThan(230);
      expect(rep.ragdollPlan.willEnableRagdoll).toBe(false);
      applyShotReportToTarget(t, rep);
      expect(t.alive).toBe(true);
      expect(t.isRagdollActive).toBe(false);
      expect(t.worldPosition).toEqual(before);
    }
  });

  it('the same blast knocks him down once he is down to 30% health', () => {
    for (const archetype of ['MILITIA_GUNNER', 'MASKED_BRUISER'] as const) {
      const t = target(`low-${archetype}`, archetype, 3);
      t.currentHp = t.maxHp * 0.3;
      const rep = blastChest(t, 3);
      expect(rep.ragdollPlan.willEnableRagdoll).toBe(true);
      applyShotReportToTarget(t, rep);
      expect(t.isRagdollActive).toBe(true);
    }
  });

  it('a heavy enforcer needs to be lower still before a shove puts him down', () => {
    const heavy = { archetype: 'HEAVY_ENFORCER' as const, maxHp: 100 };
    const regular = { archetype: 'MILITIA_GUNNER' as const, maxHp: 100 };
    const punk = { archetype: 'SKINHEAD_PUNK' as const, maxHp: 100 };
    expect(weakEnoughForKnockdown(heavy, 28)).toBe(false);
    expect(weakEnoughForKnockdown(heavy, 25)).toBe(true);
    expect(weakEnoughForKnockdown(regular, 28)).toBe(true);
    expect(weakEnoughForKnockdown(regular, 32)).toBe(false);
    expect(weakEnoughForKnockdown(punk, 35)).toBe(true);
    expect(weakEnoughForKnockdown(punk, 60)).toBe(false);
  });
});

describe('toughness never softens a vital hit', () => {
  it('a rifle round to the head still kills a tough guy outright', () => {
    for (const archetype of ['MILITIA_GUNNER', 'MASKED_BRUISER'] as const) {
      const t = target(`head-${archetype}`, archetype, 12);
      const head = t.ragdollBones.HEAD_CRANIUM.position;
      const aimPoint = vec3(head.x, head.y + 0.08, head.z);
      const origin = vec3(aimPoint.x, aimPoint.y, 0);
      const rep = simulateShot(WEAPON_M4A1, AMMO_556_NATO_M855, origin, normalize(sub(aimPoint, origin)), t, DEFAULT_ENVIRONMENT);
      expect(rep.ragdollPlan.primaryHitZone?.startsWith('HEAD')).toBe(true);
      expect(rep.isLethalKill).toBe(true);
      applyShotReportToTarget(t, rep);
      expect(t.alive).toBe(false);
      // Killed on its feet by a head shot: it drops with the crumple clip before the ragdoll.
      expect(deathClipFor(t)).toBe('DeathCrumple');
    }
  });

  it('brain, heart, aorta and spine count in full; meat that stays shallow is soaked', () => {
    const tally = new WoundChannelTally({ archetype: 'MILITIA_GUNNER' });
    tally.addLayer({ layerType: 'SOFT_FLESH', ghoulZone: 'HEAD_CRANIUM' }, 10);
    tally.addLayer({ layerType: 'ORGAN_BRAIN', ghoulZone: 'HEAD_CRANIUM' }, 50);
    // Went deep, so the scalp counts at the deep scale (0.8), the brain in full.
    expect(tally.close()).toBeCloseTo(50 + 10 * 0.8, 5);
    tally.addLayer({ layerType: 'ORGAN_HEART', ghoulZone: 'TORSO_UPPER_THORAX' }, 40);
    expect(tally.close()).toBeCloseTo(40, 5);
    tally.addLayer({ layerType: 'CORTICAL_BONE', ghoulZone: 'NECK_CERVICAL' }, 30);
    expect(tally.close()).toBeCloseTo(30, 5);
    tally.addLayer({ layerType: 'SOFT_FLESH', ghoulZone: 'TORSO_UPPER_THORAX' }, 10);
    expect(tally.close()).toBeCloseTo(10 * 0.22, 5);
    // A lung still hurts a big man nearly as much: square root of the deep scale.
    tally.addLayer({ layerType: 'ORGAN_LUNG_LEFT', ghoulZone: 'TORSO_UPPER_THORAX' }, 20);
    expect(tally.close()).toBeCloseTo(20 * Math.sqrt(0.8), 5);
    // An ordinary build only soaks shallow wounds a little.
    const punk = new WoundChannelTally({ archetype: 'SKINHEAD_PUNK' });
    punk.addLayer({ layerType: 'SOFT_FLESH', ghoulZone: 'TORSO_UPPER_THORAX' }, 10);
    expect(punk.close()).toBeCloseTo(7, 5);
  });
});

const NONE_SEVERED: NewlySeveredLimbs = {
  newlySeveredRightLeg: false,
  newlySeveredLeftLeg: false,
  newlySeveredRightArm: false,
  newlySeveredLeftArm: false,
};

describe('a broken pelvis', () => {
  const pelvisWound = { boneFractured: true, ghoulZone: 'PELVIS_GROIN', localEntryOffset: vec3(-0.05, 0, 0) } as WoundChannelEvent;

  function plan(t: TargetHealthState) {
    return evaluateLethalityAndRagdollPlan(
      WEAPON_M4A1, AMMO_556_NATO_M855, t, 12, vec3(0, 0, -1), true, 'PELVIS_GROIN', 0.01, 300, 20,
      [pelvisWound], [], new Set(), new Set(), new Set(), {}, vec3(0, 0, -20), vec3(0, 0, 0)
    );
  }

  it('drops a healthy body with the leg-shot fall instead of throwing it into the ragdoll', () => {
    const t = target('pelvis-high', 'MILITIA_GUNNER', 12);
    const res = plan(t);
    expect(res.ragdollPlan.willEnableRagdoll).toBe(false);
    applySurvivingReaction(
      t,
      { ragdollPlan: res.ragdollPlan, woundEvents: [pelvisWound], totalEnergyDepositedJ: 300, aimDirectionWorld: vec3(0, 0, -1) } as unknown as ShotSimulationReport,
      NONE_SEVERED
    );
    expect(t.rightLegFunctional).toBe(false);
    expect(t.activeReaction.type).toBe('LEG_BUCKLE_RIGHT');
    expect(t.isRagdollActive).toBe(false);
  });

  it('still knocks a spent body flat', () => {
    const t = target('pelvis-low', 'MILITIA_GUNNER', 12);
    t.currentHp = t.maxHp * 0.3;
    expect(plan(t).ragdollPlan.willEnableRagdoll).toBe(true);
  });
});
