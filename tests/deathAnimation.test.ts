import { describe, expect, it } from 'vitest';
import type { ShotSimulationReport, TargetHealthState, Vec3Like } from '../src/contracts/ballistics.ts';
import type { PhysiologicalEntityState } from '../src/contracts/physiology.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { applyShotReportToTarget, simulateShot } from '../src/core/ballistics/solver.ts';
import { length, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import { AMMO_762_NATO_M118LR, DEFAULT_ENVIRONMENT, WEAPON_MSG90 } from '../src/core/ballistics/weapons.ts';
import {
  DEATH_CLIP_SECONDS,
  deathClipFor,
  isDyingAnimated,
} from '../src/core/ballistics/lifecycle/deathAnimation.ts';
import { stepDeathAnimation } from '../src/core/ballistics/lifecycle/deathAnimationStep.ts';
import { stepLivingTargetVitalsAndFall } from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { stepRagdollPhysics } from '../src/core/ballistics/ragdoll/ragdollVerletStep.ts';
import { buildFragBlastReportForTarget } from '../src/engine/combat/fragBlastCalculator.ts';
import { syncPhysiologyToHealthState } from '../src/engine/combat/physiologySyncAdapter.ts';

/** A combatant standing 8 m down -Z, facing +Z (toward the shooter at the origin). */
function standing(id = 'd'): TargetHealthState {
  return createTargetHealthState(id, 'T', vec3(0, 0, -8), 0, 'SKINHEAD_PUNK');
}

/** A lethal hit with no wound channels, so only the fields under test decide the outcome. */
function killShot(t: TargetHealthState, over: Partial<ShotSimulationReport> & { dir?: Vec3Like; zone?: string; impulse?: Vec3Like } = {}): ShotSimulationReport {
  const dir = over.dir ?? vec3(0, 0, -1);
  const { dir: _d, zone, impulse, ...rest } = over;
  return {
    shotId: 's', weaponId: 'w', ammoId: 'a', originWorld: vec3(0, 1.5, 0), aimDirectionWorld: dir,
    targetDistanceM: 8, pelletCount: 1, muzzleEnergyJ: 3000, impactSpeedMs: 800, impactEnergyJ: 3000,
    flightTimeAtImpactS: 0.01, bulletDropAtImpactCm: 0, windDriftAtImpactCm: 0, hitTarget: true,
    targetId: t.targetId, pelletResults: [], woundEvents: [], totalEnergyDepositedJ: 300,
    totalDamageHp: 999, isLethalKill: true,
    ragdollPlan: {
      willEnableRagdoll: true, activationTimeS: 0,
      primaryHitZone: (zone ?? 'TORSO_UPPER_THORAX') as ShotSimulationReport['ragdollPlan']['primaryHitZone'],
      netRootImpulseWorld: impulse ?? vec3(dir.x * 40, 0, dir.z * 40), launchLiftVelocityMs: 0,
      estimatedLaunchDistanceM: 0, zoneImpulses: {}, netTorqueWorld: vec3(0, 0, 0), dismembermentEvents: [],
    },
    severedZones: [], dismembermentEvents: [], shatteredBones: [], rupturedOrgans: [], combatantEffects: [],
    headgearKnockedOff: false, weaponDisarmed: false, trajectorySamples: [],
    ...rest,
  };
}

function killedWith(over: Parameters<typeof killShot>[1]): TargetHealthState {
  const t = standing();
  applyShotReportToTarget(t, killShot(t, over));
  return t;
}

describe('a body killed on its feet plays a death clip', () => {
  it('picks the clip from where and how the kill landed', () => {
    expect(deathClipFor(killedWith({ zone: 'HEAD_CRANIUM' }))).toBe('DeathCrumple');
    expect(deathClipFor(killedWith({ rupturedOrgans: ['Brain (Cerebrum & Brainstem)'] }))).toBe('DeathCrumple');
    expect(deathClipFor(killedWith({ dir: vec3(0, 0, 1) }))).toBe('DeathFallForward');
    expect(deathClipFor(killedWith({ zone: 'TORSO_LOWER_ABDOMEN' }))).toBe('DeathFallForward');
    expect(deathClipFor(killedWith({ dir: vec3(1, 0, 0) }))).toBe('DeathSpin');
    expect(deathClipFor(killedWith({ zone: 'SHOULDER_RIGHT' }))).toBe('DeathSpin');
    expect(deathClipFor(killedWith({}))).toBe('DeathFallBack');
  });

  it('a real head shot drops the body with the crumple clip, dead but not ragdolled, gun dropped', () => {
    const t = createTargetHealthState('cns', 'T', vec3(0, 0, -10), 0, 'MILITIA_GUNNER');
    const o = vec3(0, 1.68, 0);
    const r = simulateShot(WEAPON_MSG90, AMMO_762_NATO_M118LR, o, normalize(sub(vec3(0, 1.68, -10), o)), t, DEFAULT_ENVIRONMENT);
    applyShotReportToTarget(t, r);
    expect(t.alive).toBe(false);
    expect(t.isRagdollActive).toBe(false);
    expect(t.weaponDropped).toBe(true);
    expect(deathClipFor(t)).toBe('DeathCrumple');
    expect(t.bodyState?.kind).toBe('DYING');
  });

  it('stays in the clip for its whole length, then the corpse ragdoll takes over gently', () => {
    const t = killedWith({});
    const dt = 1 / 60;
    let elapsed = 0;
    while (elapsed + dt < DEATH_CLIP_SECONDS.DeathFallBack - 1e-6) {
      stepRagdollPhysics(t, dt, 0);
      elapsed += dt;
      expect(isDyingAnimated(t)).toBe(true);
    }
    stepDeathAnimation(t, dt * 2, 0);
    expect(isDyingAnimated(t)).toBe(false);
    expect(t.dying ?? null).toBeNull();
    expect(t.isRagdollActive).toBe(true);
    expect(t.alive).toBe(false);
    for (const b of Object.values(t.ragdollBones)) {
      if (b.componentId === 'BODY') expect(length(b.velocity)).toBeLessThan(0.2);
    }
  });

  it('a hit during the clip only jolts it; a blast throws it at once', () => {
    const t = killedWith({});
    stepDeathAnimation(t, 0.5, 0);
    const jolt = t.joltEpoch ?? 0;
    applyShotReportToTarget(t, killShot(t, {}));
    expect(isDyingAnimated(t)).toBe(true);
    expect(t.dying?.timerS).toBeCloseTo(0.5, 5);
    expect(t.joltEpoch).toBe(jolt + 1);

    applyShotReportToTarget(t, buildFragBlastReportForTarget(t, vec3(0, 0, -10), 2, 9, 900, 4400));
    expect(t.isRagdollActive).toBe(true);
    expect(t.dying ?? null).toBeNull();
  });

  it('a heavy knockdown hit on the dying body ragdolls it too', () => {
    const t = killedWith({});
    applyShotReportToTarget(t, killShot(t, { impulse: vec3(0, 0, -400) }));
    expect(t.isRagdollActive).toBe(true);
  });
});

describe('bodies that do not get a death clip', () => {
  it('an explosion kill ragdolls immediately', () => {
    const t = standing('frag');
    applyShotReportToTarget(t, buildFragBlastReportForTarget(t, vec3(0, 0, -9.5), 1.5, 9, 900, 4400));
    expect(t.alive).toBe(false);
    expect(t.isRagdollActive).toBe(true);
    expect(deathClipFor(t)).toBeNull();
  });

  it('a kill that knocks the body over ragdolls immediately', () => {
    const t = killedWith({ impulse: vec3(0, 0, -300) });
    expect(t.isRagdollActive).toBe(true);
    expect(deathClipFor(t)).toBeNull();
  });

  it('a seated last-stander that dies drops as a corpse ragdoll', () => {
    const t = standing('seat');
    t.woundedPhase = 'DOWNED_AGONY';
    t.bloodVolumeMl = 2510;
    t.currentHp = 1;
    t.bloodLossRateMlPerSec = 100;
    stepLivingTargetVitalsAndFall(t, 0.5, 0);
    expect(t.alive).toBe(false);
    expect(t.isRagdollActive).toBe(true);
    expect(deathClipFor(t)).toBeNull();
  });
});

describe('running out of blood on its feet', () => {
  it('bleeds out with the slow DeathBleedOut clip', () => {
    const t = standing('bleed');
    t.bloodVolumeMl = 2510;
    t.currentHp = 1;
    t.bloodLossRateMlPerSec = 100;
    stepLivingTargetVitalsAndFall(t, 0.5, 0);
    expect(t.alive).toBe(false);
    expect(t.isRagdollActive).toBe(false);
    expect(deathClipFor(t)).toBe('DeathBleedOut');
    expect(t.dying?.durationS).toBeCloseTo(DEATH_CLIP_SECONDS.DeathBleedOut, 5);
  });

  it('a physiology death bleeds out on its feet, or takes the shot clip handed in', () => {
    const physio = () => ({ alive: false, baseBleedRateMlPerSec: 0, conscious: false, vascularWounds: [], readability: {} }) as unknown as PhysiologicalEntityState;
    const a = standing('physA');
    syncPhysiologyToHealthState(physio(), a);
    expect(deathClipFor(a)).toBe('DeathBleedOut');
    const b = standing('physB');
    syncPhysiologyToHealthState(physio(), b, null, 'DeathSpin');
    expect(deathClipFor(b)).toBe('DeathSpin');
    const c = standing('physC');
    syncPhysiologyToHealthState(physio(), c, null, null);
    expect(c.isRagdollActive).toBe(true);
  });
});
