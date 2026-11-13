import { describe, expect, it } from 'vitest';
import type { GhoulZoneId, ShotSimulationReport, TargetHealthState, Vec3Like } from '../src/contracts/ballistics.ts';
import {
  stepLivingTargetVitalsAndFall,
  transitionTargetLifecycle,
} from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { buildLivingGroundedPoseTargets } from '../src/core/ballistics/triage/groundedPoseTargets.ts';
import { applyDismembermentTree } from '../src/core/ballistics/trauma/dismembermentTreeApplicator.ts';
import { isLimbLossFatal, listLostLimbs } from '../src/core/ballistics/trauma/limbLossDeathRule.ts';
import { WOUND_CLIP_SECONDS } from '../src/core/ballistics/trauma/woundReactionTimings.ts';
import { canDownedBodyAimAt, computeDownedAimReach } from '../src/core/ballistics/triage/downedAimReach.ts';
import { computeChestFrame } from '../src/core/ghoul/anatomy/ragdollBodyFrames.ts';
import { keepAimClearOfChest } from '../src/core/ballistics/triage/downedChestClearance.ts';
import { dot, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { getSubtreeZones } from '../src/core/ghoul/anatomy/ghoulHierarchy.ts';

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

describe('two lost limbs kill, except one arm and one leg', () => {
  it('reads each limb as lost from any cut along its chain', () => {
    expect(listLostLimbs(new Set<GhoulZoneId>(['HAND_LEFT', 'SHIN_RIGHT']))).toEqual(['ARM_LEFT', 'LEG_RIGHT']);
  });

  it('decides which pairs are fatal', () => {
    const fatal = (...zones: GhoulZoneId[]) => isLimbLossFatal(new Set(zones));
    expect(fatal()).toBe(false);
    expect(fatal('UPPER_ARM_RIGHT')).toBe(false);
    expect(fatal('UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 'HAND_RIGHT')).toBe(false);
    expect(fatal('UPPER_ARM_RIGHT', 'THIGH_LEFT')).toBe(false);
    expect(fatal('THIGH_RIGHT', 'THIGH_LEFT')).toBe(true);
    expect(fatal('UPPER_ARM_RIGHT', 'HAND_LEFT')).toBe(true);
    expect(fatal('UPPER_ARM_RIGHT', 'THIGH_LEFT', 'FOOT_RIGHT')).toBe(true);
  });

  it('keeps a combatant missing an arm and a leg alive', () => {
    const target = createTargetHealthState('arm-leg', 'Militia', vec3(0, 0, 0), 0);
    sever(target, 'UPPER_ARM_RIGHT');
    sever(target, 'THIGH_LEFT');
    expect(target.alive).toBe(true);
  });

  it('kills on the second leg', () => {
    const target = createTargetHealthState('legs', 'Militia', vec3(0, 0, 0), 0);
    sever(target, 'THIGH_RIGHT');
    expect(target.alive).toBe(true);
    sever(target, 'SHIN_LEFT');
    expect(target.alive).toBe(false);
    expect(target.ragdollPhase.kind).toBe('CORPSE_DYNAMIC');
  });

  it('kills on the second arm and on a third limb', () => {
    const arms = createTargetHealthState('arms', 'Militia', vec3(0, 0, 0), 0);
    sever(arms, 'FOREARM_LEFT', 'UPPER_ARM_RIGHT');
    expect(arms.alive).toBe(false);

    const three = createTargetHealthState('three', 'Militia', vec3(0, 0, 0), 0);
    sever(three, 'UPPER_ARM_LEFT', 'THIGH_RIGHT');
    expect(three.alive).toBe(true);
    sever(three, 'KNEE_LEFT');
    expect(three.alive).toBe(false);
  });

  it('kills a body already down in its last stand', () => {
    const target = createTargetHealthState('downed', 'Militia', vec3(0, 0, 0), 0);
    sever(target, 'THIGH_RIGHT');
    transitionTargetLifecycle(target, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
    expect(target.ragdollPhase.kind).toBe('LIVING_AGONY');
    sever(target, 'THIGH_LEFT');
    expect(target.alive).toBe(false);
    expect(target.ragdollPhase.kind).toBe('CORPSE_DYNAMIC');
  });
});

// A body lying with its head toward +z on a floor at y = 0.
function lying(faceDown: boolean): TargetHealthState {
  const target = createTargetHealthState(faceDown ? 'prone' : 'supine', 'Militia', vec3(0, 0, 0), 0);
  const place = (zone: GhoulZoneId, p: Vec3Like): void => {
    target.ragdollBones[zone].position = p;
    target.ragdollBones[zone].prevPosition = p;
  };
  // Face up the body's own left lies along -x; face down along +x.
  const left = faceDown ? 1 : -1;
  place('PELVIS_GROIN', vec3(0, 0.12, 0));
  place('TORSO_UPPER_THORAX', vec3(0, 0.15, 0.35));
  place('NECK_CERVICAL', vec3(0, 0.17, 0.55));
  place('SHOULDER_LEFT', vec3(0.2 * left, 0.17, 0.5));
  place('SHOULDER_RIGHT', vec3(-0.2 * left, 0.17, 0.5));
  target.isRagdollActive = true;
  return target;
}

const at = (target: TargetHealthState, x: number, y: number, z: number) => canDownedBodyAimAt(target, vec3(x, y, z));

describe('a downed shooter only covers what lies in front of its extended arm', () => {
  it('starts the cone at the gun arm shoulder', () => {
    const target = lying(false);
    expect(computeDownedAimReach(target)?.origin).toEqual(target.ragdollBones.SHOULDER_RIGHT.position);
    sever(target, 'FOREARM_RIGHT');
    expect(computeDownedAimReach(target)?.origin).toEqual(target.ragdollBones.SHOULDER_LEFT.position);
  });

  it('on its back, covers past its feet but not behind or over its head', () => {
    const target = lying(false);
    expect(at(target, 0, 0.5, -6)).toBe(true);
    expect(at(target, 0, 3, -2)).toBe(true);
    expect(at(target, 0, 0.5, 6)).toBe(false);
    expect(at(target, 0, 6, 1.2)).toBe(false);
  });

  it('reaches further out to its gun side than across its chest', () => {
    const target = lying(false);
    // Face up, the right-hander's gun side lies along +x. 60 degrees off the feet line.
    const y = target.ragdollBones.SHOULDER_RIGHT.position.y;
    expect(at(target, 8.66, y, -5)).toBe(true);
    expect(at(target, -8.66, y, -5)).toBe(false);
  });

  it('on its front, only covers ahead of its head', () => {
    const target = lying(true);
    expect(at(target, 0, 0.8, 6)).toBe(true);
    expect(at(target, 0, 0.8, -6)).toBe(false);
  });
});

describe('a downed gun arm reaching across the body', () => {
  it('passes in front of the chest instead of through it', () => {
    // Face up the chest faces +y and the right-hander's gun side lies along +x.
    const target = lying(false);
    const chest = computeChestFrame(target)!;
    const across = keepAimClearOfChest(target, vec3(-1, 0.05, -0.3));
    // The frame's right is the body's own left, the way this arm crosses.
    const medial = dot(across, chest.right);
    expect(medial).toBeGreaterThan(0);
    // Crossing no steeper than 40 degrees from the chest's forward line.
    expect(medial).toBeLessThanOrEqual(Math.tan((40 * Math.PI) / 180) * dot(across, chest.forward) + 1e-6);
  });

  it('leaves aims out to the gun side or up off the chest alone', () => {
    const target = lying(false);
    for (const wanted of [vec3(1, 0.1, -0.4), vec3(-0.3, 0.9, -0.2), vec3(0.2, 0.3, -1)]) {
      expect(dot(keepAimClearOfChest(target, wanted), normalize(wanted))).toBeGreaterThan(0.999);
    }
  });
});

describe('a one-armed combatant stands until its last stand, then sits down to fight', () => {
  it('stays up while strong and goes down alive once spent', () => {
    const target = createTargetHealthState('one-arm', 'Militia', vec3(0, 0, 0), 0);
    sever(target, 'UPPER_ARM_RIGHT');
    target.bloodLossRateMlPerSec = 0;
    stepLivingTargetVitalsAndFall(target, 1 / 60, 0);
    expect(target.isRagdollActive).toBe(false);

    target.currentHp = target.maxHp * 0.3;
    stepLivingTargetVitalsAndFall(target, 1 / 60, 0);
    // It plays the collapse clip first and only goes to the ragdoll once that has sat it down.
    expect(target.activeReaction.type).toBe('DOWNED_COLLAPSE');
    expect(target.isRagdollActive).toBe(false);
    for (let t = 0; t < WOUND_CLIP_SECONDS.DOWNED_COLLAPSE + 0.05; t += 1 / 60) {
      stepLivingTargetVitalsAndFall(target, 1 / 60, 0);
    }
    expect(target.alive).toBe(true);
    expect(target.isRagdollActive).toBe(true);
    expect(target.ragdollPhase.kind).toBe('LIVING_AGONY');
  });
});

// The head used to turn toward a procedurally posed pistol arm. The ragdoll never holds a gun
// now (the seated last stand is a clip), so the head simply rests looking past the feet.
describe('a body lying on its back in the ragdoll', () => {
  it('rests looking out past its feet', () => {
    const pose = buildLivingGroundedPoseTargets(lying(false), 0, 0)!;
    const face = normalize(sub(pose.HEAD_FACE_JAW!, pose.HEAD_CRANIUM!));
    // Lying with its head toward +z, its feet lie toward -z.
    expect(face.z).toBeLessThan(0);
  });
});
