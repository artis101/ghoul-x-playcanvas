import { describe, expect, it } from 'vitest';
import type { GhoulZoneId, ShotSimulationReport, TargetHealthState } from '../src/contracts/ballistics.ts';
import { transitionTargetLifecycle } from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { clampSwingDirection, DEG } from '../src/core/ballistics/ragdoll/ragdollJointLimitMath.ts';
import { stabilizeRagdollPoseForTransition } from '../src/core/ballistics/ragdoll/ragdollPoseStabilizer.ts';
import { stepRagdollPhysics } from '../src/core/ballistics/ragdoll/ragdollVerletStep.ts';
import { applyDismembermentTree } from '../src/core/ballistics/trauma/dismembermentTreeApplicator.ts';
import { cross, dot, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { getSubtreeZones } from '../src/core/ghoul/anatomy/ghoulHierarchy.ts';
import { computeChestFrame, computePelvisFrame, rejectFromAxis } from '../src/core/ghoul/anatomy/ragdollBodyFrames.ts';

const STEP_S = 1 / 60;

function sever(target: TargetHealthState, zone: GhoulZoneId): void {
  const dismembermentEvents = [{
    zone,
    goreMode: 'CLEAN_SEVER' as const,
    detachedSubtree: getSubtreeZones(zone),
    stumpWorldPosition: target.ragdollBones[zone].position,
    arterialSprayDirection: vec3(0, 1, 0),
    severedLimbVelocity: vec3(zone.endsWith('RIGHT') ? -1.6 : 1.6, 1.8, -0.6),
    severedLimbAngularVelocity: vec3(3, 2, -4),
    gibCount: 0,
  }];
  applyDismembermentTree(target, { dismembermentEvents } as unknown as ShotSimulationReport);
  target.bloodLossRateMlPerSec = 0;
}

function knockDown(target: TargetHealthState): void {
  transitionTargetLifecycle(target, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
  stabilizeRagdollPoseForTransition(target, 0);
}

function simulate(target: TargetHealthState, seconds: number, consciousness?: number): void {
  for (let i = 0; i < Math.round(seconds / STEP_S); i++) {
    if (consciousness !== undefined && target.alive) target.consciousness = consciousness;
    stepRagdollPhysics(target, STEP_S, 0);
  }
}

/** Knee flexion in degrees, negative when the shin has folded in front of the thigh. */
function kneeFlexionDeg(target: TargetHealthState, side: 'RIGHT' | 'LEFT'): number {
  const bones = target.ragdollBones;
  const pelvis = computePelvisFrame(target)!;
  const thigh = normalize(sub(bones[`KNEE_${side}`].position, bones[`THIGH_${side}`].position));
  const shin = normalize(sub(bones[`FOOT_${side}`].position, bones[`KNEE_${side}`].position));
  const behind = cross(normalize(rejectFromAxis(pelvis.right, thigh)), thigh);
  const flex = Math.acos(Math.max(-1, Math.min(1, dot(shin, thigh)))) / DEG;
  return dot(shin, behind) >= -0.3 * Math.sin(flex * DEG) ? flex : -flex;
}

function bendDeg(target: TargetHealthState, a: GhoulZoneId, joint: GhoulZoneId, b: GhoulZoneId): number {
  const bones = target.ragdollBones;
  const lower = normalize(sub(bones[joint].position, bones[a].position));
  const upper = normalize(sub(bones[b].position, bones[joint].position));
  return Math.acos(Math.max(-1, Math.min(1, dot(lower, upper)))) / DEG;
}

describe('Ragdoll anatomical joint limits', () => {
  it('clamps a swing direction to the limit on the side it leans toward', () => {
    const limits = { forward: 40 * DEG, back: 10 * DEG, outward: 20 * DEG, inward: 20 * DEG };
    const up = vec3(0, 1, 0);
    const side = vec3(1, 0, 0);
    const forward = vec3(0, 0, 1);
    expect(clampSwingDirection(normalize(vec3(0, 1, 0.5)), up, side, forward, limits)).toBeNull();

    const leaningBack = clampSwingDirection(normalize(vec3(0, 1, -1)), up, side, forward, limits)!;
    expect(Math.acos(dot(leaningBack, up)) / DEG).toBeCloseTo(10, 3);
    expect(leaningBack.z).toBeLessThan(0);
  });

  it('keeps the pelvis oriented after a leg is severed at the hip', () => {
    const target = createTargetHealthState('frame', 'Militia', vec3(0, 0, 0), 0);
    const intact = computePelvisFrame(target)!;
    sever(target, 'THIGH_RIGHT');
    target.ragdollBones.THIGH_RIGHT.position = vec3(3, 0.1, -2);
    const oneLegged = computePelvisFrame(target)!;
    expect(dot(oneLegged.right, intact.right)).toBeGreaterThan(0.99);
    expect(dot(oneLegged.forward, intact.forward)).toBeGreaterThan(0.99);
  });

  it('lets a corpse collapse into a human pose and fall asleep', () => {
    const target = createTargetHealthState('collapse', 'Militia', vec3(0, 0, 0), 0);
    transitionTargetLifecycle(target, { kind: 'LETHAL_DEATH' });
    knockDown(target);

    let highest = 0;
    for (let i = 0; i < 360; i++) {
      stepRagdollPhysics(target, STEP_S, 0);
      highest = Math.max(highest, target.ragdollBones.FOOT_RIGHT.position.y, target.ragdollBones.FOOT_LEFT.position.y);
    }

    expect(target.ragdollPhase.kind).toBe('CORPSE_SLEEPING');
    // Nothing flings the legs into the air on the way down.
    expect(highest).toBeLessThan(0.6);
    for (const side of ['RIGHT', 'LEFT'] as const) {
      expect(kneeFlexionDeg(target, side)).toBeGreaterThan(-15);
    }
    expect(bendDeg(target, 'PELVIS_GROIN', 'TORSO_LOWER_ABDOMEN', 'TORSO_UPPER_THORAX')).toBeLessThan(50);
    expect(bendDeg(target, 'TORSO_LOWER_ABDOMEN', 'TORSO_UPPER_THORAX', 'NECK_CERVICAL')).toBeLessThan(40);
  });

  it('lays a corpse out flat instead of leaving it folded where it fell', () => {
    const pushes = [vec3(0, 0, 0), vec3(0, 0.3, -3), vec3(0, 0, 1), vec3(2, 0.2, 0), vec3(1.5, 0.2, -1.5)];
    for (const [index, push] of pushes.entries()) {
      const target = createTargetHealthState(`sprawl_${index}`, 'Militia', vec3(0, 0, 0), 0);
      transitionTargetLifecycle(target, { kind: 'LETHAL_DEATH' });
      knockDown(target);
      for (const bone of Object.values(target.ragdollBones)) bone.velocity = { ...push };
      simulate(target, 6);

      const bones = target.ragdollBones;
      expect(target.ragdollPhase.kind).toBe('CORPSE_SLEEPING');
      for (const bone of Object.values(bones)) expect(bone.position.y - bone.radiusM).toBeLessThan(0.2);
      for (const side of ['RIGHT', 'LEFT'] as const) {
        // Legs lie in line with the body: not drawn up at the hip, not doubled back at the knee.
        const spine = normalize(sub(bones.PELVIS_GROIN.position, bones.TORSO_UPPER_THORAX.position));
        const thigh = normalize(sub(bones[`KNEE_${side}`].position, bones[`THIGH_${side}`].position));
        expect(Math.acos(Math.max(-1, Math.min(1, dot(spine, thigh)))) / DEG).toBeLessThan(40);
        expect(bendDeg(target, `THIGH_${side}`, `KNEE_${side}`, `FOOT_${side}`)).toBeLessThan(40);
      }
    }
  });

  it('holds a living downed combatant in place, with or without a lost limb', () => {
    for (const lost of [null, 'THIGH_RIGHT', 'UPPER_ARM_LEFT'] as const) {
      const target = createTargetHealthState(`downed_${lost}`, 'Militia', vec3(0, 0, 0), 0);
      if (lost) sever(target, lost);
      target.currentHp = target.maxHp * 0.25;
      knockDown(target);
      simulate(target, 5, 0.6);
      const settled = { ...target.ragdollBones.PELVIS_GROIN.position };
      simulate(target, 10, 0.6);
      const pelvis = target.ragdollBones.PELVIS_GROIN.position;

      expect(target.alive).toBe(true);
      expect(Math.hypot(pelvis.x - settled.x, pelvis.z - settled.z)).toBeLessThan(0.03);

      // The torso stays one piece: no wringing between hips and shoulders, no folded spine.
      const spine = normalize(sub(target.ragdollBones.TORSO_UPPER_THORAX.position, pelvis));
      const hipLine = normalize(rejectFromAxis(computePelvisFrame(target)!.right, spine));
      const shoulderLine = normalize(rejectFromAxis(computeChestFrame(target)!.right, spine));
      expect(Math.acos(Math.max(-1, Math.min(1, dot(hipLine, shoulderLine)))) / DEG).toBeLessThan(55);
      expect(bendDeg(target, 'PELVIS_GROIN', 'TORSO_LOWER_ABDOMEN', 'TORSO_UPPER_THORAX')).toBeLessThan(50);
    }
  });

  it('slumps a combatant who dies sitting up on its butt, then lets the corpse sleep', () => {
    const target = createTargetHealthState('sit_death', 'Militia', vec3(0, 0, 0), 0);
    target.rightLegFunctional = false;
    simulate(target, 3, 1);
    expect(target.isRagdollActive).toBe(true);
    // Sitting on its butt to fight, chest and head up, but well below standing height.
    expect(target.ragdollBones.HEAD_CRANIUM.position.y).toBeGreaterThan(0.6);
    expect(target.ragdollBones.HEAD_CRANIUM.position.y).toBeLessThan(1.0);

    transitionTargetLifecycle(target, { kind: 'LETHAL_DEATH' });
    simulate(target, 3);
    expect(target.ragdollBones.HEAD_CRANIUM.position.y).toBeLessThan(0.25);
    expect(target.ragdollPhase.kind).toBe('CORPSE_SLEEPING');
  });
});
