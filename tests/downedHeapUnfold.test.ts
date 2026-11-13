import { describe, expect, it } from 'vitest';
import type { GhoulZoneId, TargetHealthState } from '../src/contracts/ballistics.ts';
import { transitionTargetLifecycle } from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { DEG } from '../src/core/ballistics/ragdoll/ragdollJointLimitMath.ts';
import { stepRagdollPhysics } from '../src/core/ballistics/ragdoll/ragdollVerletStep.ts';
import { distance, dot, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';

type Point = readonly [number, number, number];

// A leg-shot combatant as it lay in the game once the collapse clip had played: on its side,
// knees drawn up, the useless left leg doubled back toward the chest.
const HEAP_BONES: Partial<Record<GhoulZoneId, Point>> = {
  HEAD_CRANIUM: [-4.2514, 0.3806, -8.372],
  HEAD_FACE_JAW: [-4.2554, 0.3515, -8.2824],
  NECK_CERVICAL: [-4.309, 0.2917, -8.342],
  TORSO_UPPER_THORAX: [-4.4941, 0.1881, -8.2099],
  TORSO_LOWER_ABDOMEN: [-4.5762, 0.1385, -8.0344],
  PELVIS_GROIN: [-4.6381, 0.1555, -7.8988],
  SHOULDER_RIGHT: [-4.4682, 0.4549, -8.3046],
  UPPER_ARM_RIGHT: [-4.4843, 0.3859, -8.212],
  FOREARM_RIGHT: [-4.3877, 0.183, -8.0945],
  HAND_RIGHT: [-4.4909, 0.045, -7.8855],
  SHOULDER_LEFT: [-4.2467, 0.075, -8.2921],
  UPPER_ARM_LEFT: [-4.3617, 0.06, -8.2822],
  FOREARM_LEFT: [-4.2498, 0.05, -8.0566],
  HAND_LEFT: [-4.3326, 0.045, -7.8366],
  THIGH_RIGHT: [-4.6333, 0.291, -7.8445],
  KNEE_RIGHT: [-4.9007, 0.0624, -7.9226],
  SHIN_RIGHT: [-4.8165, 0.0566, -7.7215],
  FOOT_RIGHT: [-4.7098, 0.06, -7.5312],
  THIGH_LEFT: [-4.7122, 0.08, -7.7981],
  KNEE_LEFT: [-4.3704, 0.06, -7.6871],
  SHIN_LEFT: [-4.3931, 0.0561, -7.9043],
  FOOT_LEFT: [-4.4477, 0.06, -8.1149],
};
const HEAP_AUX: Partial<Record<keyof TargetHealthState['auxParticles'], Point>> = {
  HEAD_TOP: [-4.138, 0.4643, -8.4234],
  HAND_TIP_RIGHT: [-4.523, 0.035, -7.7913],
  HAND_TIP_LEFT: [-4.4242, 0.035, -7.8012],
  FOOT_TOE_RIGHT: [-4.55, 0.049, -7.5915],
  FOOT_TOE_LEFT: [-4.6125, 0.045, -8.0727],
};

function downedInHeap(id: string, uselessLegs: readonly ('RIGHT' | 'LEFT')[]): TargetHealthState {
  const target = createTargetHealthState(id, 'Militia', vec3(0, 0, 0), 0.55);
  for (const [zone, [x, y, z]] of Object.entries(HEAP_BONES) as [GhoulZoneId, Point][]) {
    const bone = target.ragdollBones[zone];
    bone.position = vec3(x, y, z);
    bone.prevPosition = vec3(x, y, z);
    bone.velocity = vec3(0, 0, 0);
  }
  for (const [id, [x, y, z]] of Object.entries(HEAP_AUX) as [keyof typeof HEAP_AUX, Point][]) {
    const particle = target.auxParticles[id];
    particle.position = vec3(x, y, z);
    particle.prevPosition = vec3(x, y, z);
    particle.velocity = vec3(0, 0, 0);
  }
  for (const side of uselessLegs) {
    if (side === 'RIGHT') target.rightLegFunctional = false;
    else target.leftLegFunctional = false;
  }
  target.currentHp = target.maxHp * 0.5;
  target.painShock = 1.26;
  target.bloodLossRateMlPerSec = 0;
  transitionTargetLifecycle(target, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
  return target;
}

function kneeBendDeg(target: TargetHealthState, side: 'RIGHT' | 'LEFT'): number {
  const b = target.ragdollBones;
  const thigh = normalize(sub(b[`KNEE_${side}`].position, b[`THIGH_${side}`].position));
  const shin = normalize(sub(b[`FOOT_${side}`].position, b[`KNEE_${side}`].position));
  return Math.acos(Math.max(-1, Math.min(1, dot(thigh, shin)))) / DEG;
}

describe('Downed combatant landing in a heap', () => {
  it('spreads out of the heap instead of lying folded up', () => {
    for (const useless of [['LEFT'], ['RIGHT', 'LEFT']] as const) {
      const target = downedInHeap(`heap_${useless.join('_')}`, useless);
      for (let i = 0; i < 4 * 60; i++) {
        target.consciousness = 1;
        stepRagdollPhysics(target, 1 / 60, 0);
      }
      const b = target.ragdollBones;
      expect(target.alive).toBe(true);
      for (const side of useless) {
        // A useless leg lies out straight, its foot well past the hip, away from the chest.
        expect(kneeBendDeg(target, side)).toBeLessThan(30);
        expect(distance(b[`FOOT_${side}`].position, b.TORSO_UPPER_THORAX.position)).toBeGreaterThan(
          distance(b.PELVIS_GROIN.position, b.TORSO_UPPER_THORAX.position) + 0.5
        );
      }
      // The working leg may plant its foot with the knee raised, but not doubled up.
      expect(kneeBendDeg(target, 'RIGHT')).toBeLessThan(110);
    }
  });
});
