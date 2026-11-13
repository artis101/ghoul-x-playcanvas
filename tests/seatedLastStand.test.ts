import { describe, expect, it } from 'vitest';
import type { GhoulZoneId, ShotSimulationReport, TargetHealthState } from '../src/contracts/ballistics.ts';
import {
  DOWNED_FIRE_CONE_RAD,
  type WoundedSequenceInput,
  isSeatedAnimated,
  stepWoundedSequence,
  woundedPhaseAllowsDraw,
  woundedPhaseAllowsFire,
  woundedPhaseKeepsBodyStill,
} from '../src/core/ai/woundedSequenceFsm.ts';
import { stepLivingTargetVitalsAndFall } from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import {
  SEATED_DRAW_PISTOL_VISIBLE_AT,
  SEATED_DRAW_S,
  seatedDrawProgress,
} from '../src/core/ballistics/triage/seatedLastStand.ts';
import { applyDismembermentTree } from '../src/core/ballistics/trauma/dismembermentTreeApplicator.ts';
import { startWoundReaction } from '../src/core/ballistics/trauma/woundReactionSelector.ts';
import { WOUND_CLIP_SECONDS } from '../src/core/ballistics/trauma/woundReactionTimings.ts';
import { applyShotReportToTarget, simulateShot } from '../src/core/ballistics/solver.ts';
import { AMMO_12G_00_BUCK, AMMO_556_NATO_M855, DEFAULT_ENVIRONMENT, WEAPON_M4A1, WEAPON_M590 } from '../src/core/ballistics/weapons.ts';
import { copyVec3, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { getSubtreeZones } from '../src/core/ghoul/anatomy/ghoulHierarchy.ts';

const DT = 1 / 60;
const DEG = Math.PI / 180;

const FRONT: WoundedSequenceInput = {
  dt: DT,
  hasSidearm: true,
  freeArmWorks: true,
  playerBearingRad: 0,
  playerVisible: true,
};
const ASIDE: WoundedSequenceInput = { ...FRONT, playerBearingRad: 90 * DEG };

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

function run(t: TargetHealthState, input: WoundedSequenceInput, seconds: number): void {
  for (let s = 0; s < seconds - 1e-9; s += DT) {
    stepWoundedSequence(t, input);
    stepLivingTargetVitalsAndFall(t, DT, 0);
  }
}

/** Shoots the right shin off a healthy, gritty body and plays the whole leg-loss fall. */
function seatedAfterLegLoss(id: string, input: WoundedSequenceInput, fortitude = 0.8): TargetHealthState {
  const t = createTargetHealthState(id, 'Militia', vec3(0, 0, -6), 0);
  t.bloodLossRateMlPerSec = 0;
  t.fortitude = fortitude;
  sever(t, 'SHIN_RIGHT');
  t.currentHp = t.maxHp;
  t.bloodLossRateMlPerSec = 0;
  startWoundReaction(t, {
    hitZone: 'SHIN_RIGHT',
    severity: 'PENETRATING',
    newlySeveredLegSide: 'RIGHT',
    newlySeveredArmSide: null,
    energyJ: 300,
    hitDirectionWorld: vec3(0, 0, -1),
  });
  run(t, input, WOUND_CLIP_SECONDS.LEG_LOSS + DT);
  return t;
}

describe('the seated last stand is animated, not ragdolled', () => {
  it('a leg loss with the player in front ends seated and animated, then draws, then fires inside its cone', () => {
    const t = seatedAfterLegLoss('seat-engage', FRONT);
    expect(t.activeReaction.type).toBe('NONE');
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    expect(t.isRagdollActive).toBe(false);
    expect(isSeatedAnimated(t)).toBe(true);
    expect(t.posture).toBe('LEG_BUCKLED');
    expect(t.downedFacingWorld?.z).toBeCloseTo(1);
    expect(woundedPhaseKeepsBodyStill(t)).toBe(true);

    // The seated draw starts at once; the pistol is still holstered early in the clip.
    expect(woundedPhaseAllowsDraw(t)).toBe(true);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
    expect(seatedDrawProgress(t)).toBeLessThan(SEATED_DRAW_PISTOL_VISIBLE_AT);
    run(t, FRONT, SEATED_DRAW_S * 0.5);
    expect(seatedDrawProgress(t)).toBeGreaterThan(SEATED_DRAW_PISTOL_VISIBLE_AT);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);

    run(t, FRONT, SEATED_DRAW_S * 0.5 + 0.05);
    expect(seatedDrawProgress(t)).toBe(1);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(true);
    expect(t.isRagdollActive).toBe(false);

    // Player steps aside: it keeps aiming ahead, engaged, and holds fire. It never turns.
    const yaw = t.yawRad;
    run(t, ASIDE, 1);
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    expect(woundedPhaseAllowsFire(t, ASIDE)).toBe(false);
    expect(woundedPhaseAllowsFire(t, { playerBearingRad: DOWNED_FIRE_CONE_RAD - 0.01, playerVisible: true })).toBe(true);
    expect(woundedPhaseAllowsFire(t, { playerBearingRad: 0, playerVisible: false })).toBe(false);
    expect(t.yawRad).toBe(yaw);
    expect(t.isRagdollActive).toBe(false);
  });

  it('a body lying seated in agony reaches for its pistol once the player steps in front, and draws from the start', () => {
    const t = seatedAfterLegLoss('seat-agony', { ...ASIDE, hasSidearm: true }, 0.95);
    expect(t.woundedPhase).toBe('DOWNED_AGONY');
    expect(isSeatedAnimated(t)).toBe(true);
    run(t, ASIDE, 2);
    expect(t.woundedPhase).toBe('DOWNED_AGONY');
    expect(woundedPhaseAllowsDraw(t)).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);

    run(t, FRONT, DT);
    expect(t.woundedPhase).toBe('DOWNED_ENGAGE');
    expect(seatedDrawProgress(t)).toBeLessThan(0.05);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
    run(t, FRONT, SEATED_DRAW_S + 0.05);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(true);
    expect(t.isRagdollActive).toBe(false);
  });

  it('a hit on a seated body only jolts it: no flinch, no new fall, no shove', () => {
    const t = seatedAfterLegLoss('seat-hit', FRONT);
    const jolts = t.joltEpoch ?? 0;
    const pos = copyVec3(t.worldPosition);
    startWoundReaction(t, {
      hitZone: 'TORSO_UPPER_THORAX',
      severity: 'CRITICAL',
      newlySeveredLegSide: null,
      newlySeveredArmSide: null,
      energyJ: 600,
      hitDirectionWorld: vec3(0, 0, -1),
    });
    expect(t.joltEpoch).toBe(jolts + 1);
    expect(t.activeReaction.type).toBe('NONE');
    expect(t.worldPosition).toEqual(pos);
    run(t, FRONT, 1);
    expect(isSeatedAnimated(t)).toBe(true);
  });

  it('losing the other leg or the gun arm while seated: gore and a jolt, and it stays sitting', () => {
    const t = seatedAfterLegLoss('seat-sever', FRONT);
    run(t, FRONT, SEATED_DRAW_S + 0.1);
    sever(t, 'FOREARM_RIGHT');
    startWoundReaction(t, {
      hitZone: 'FOREARM_RIGHT',
      severity: 'PENETRATING',
      newlySeveredLegSide: null,
      newlySeveredArmSide: 'RIGHT',
      energyJ: 400,
      hitDirectionWorld: vec3(0, 0, -1),
    });
    expect(t.activeReaction.type).toBe('NONE');
    // No arm left to hold the pistol: it gives up and lies there, still seated and animated.
    run(t, { ...FRONT, freeArmWorks: false }, 0.5);
    expect(t.woundedPhase).toBe('DOWNED_AGONY');
    expect(isSeatedAnimated(t)).toBe(true);
    expect(t.isRagdollActive).toBe(false);
    expect(woundedPhaseAllowsFire(t, FRONT)).toBe(false);
  });

  it('a close blast that would floor a spent standing body does not knock a seated one over', () => {
    const t = seatedAfterLegLoss('seat-blast', FRONT);
    t.currentHp = t.maxHp * 0.3;
    const shooter = vec3(0, 1.5, -3);
    const aim = normalize(sub(vec3(0, 1.3, -6), shooter));
    const rep = simulateShot(WEAPON_M590, AMMO_12G_00_BUCK, shooter, aim, t, DEFAULT_ENVIRONMENT);
    expect(rep.hitTarget).toBe(true);
    expect(rep.isLethalKill).toBe(false);
    expect(rep.ragdollPlan.willEnableRagdoll).toBe(false);
    applyShotReportToTarget(t, rep);
    expect(t.alive).toBe(true);
    expect(isSeatedAnimated(t)).toBe(true);
  });

  it('death while seated drops the corpse into the ragdoll from the seat', () => {
    // Shot dead.
    const shot = seatedAfterLegLoss('seat-death-shot', FRONT);
    const head = shot.ragdollBones.HEAD_CRANIUM.position;
    const aimPoint = vec3(head.x, head.y + 0.08, head.z);
    const origin = vec3(aimPoint.x, aimPoint.y, 6);
    const rep = simulateShot(WEAPON_M4A1, AMMO_556_NATO_M855, origin, normalize(sub(aimPoint, origin)), shot, DEFAULT_ENVIRONMENT);
    expect(rep.isLethalKill).toBe(true);
    applyShotReportToTarget(shot, rep);
    expect(shot.alive).toBe(false);
    expect(shot.isRagdollActive).toBe(true);
    expect(isSeatedAnimated(shot)).toBe(false);

    // Bled out.
    const bled = seatedAfterLegLoss('seat-death-bleed', FRONT);
    bled.bloodVolumeMl = 2510;
    bled.currentHp = 1;
    bled.bloodLossRateMlPerSec = 120;
    run(bled, FRONT, 0.2);
    expect(bled.alive).toBe(false);
    expect(bled.isRagdollActive).toBe(true);
    expect(bled.ragdollPhase.kind).toBe('CORPSE_DYNAMIC');
  });
});
