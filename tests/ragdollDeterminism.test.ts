import { describe, expect, it } from 'vitest';
import type { TargetHealthState } from '../src/contracts/ballistics.ts';
import { transitionTargetLifecycle } from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { stabilizeRagdollPoseForTransition } from '../src/core/ballistics/ragdoll/ragdollPoseStabilizer.ts';
import { stepRagdollPhysics } from '../src/core/ballistics/ragdoll/ragdollVerletStep.ts';
import {
  add,
  addInto,
  addScaledInto,
  copyInto,
  cross,
  crossInto,
  distance,
  distanceSq,
  lerp,
  lerpInto,
  normalize,
  normalizeInto,
  scale,
  scaleInto,
  sub,
  subInto,
  vec3,
} from '../src/core/ballistics/vec3.ts';
import {
  ALL_AUX_PARTICLES,
  ALL_GHOUL_ZONES,
  createTargetHealthState,
} from '../src/core/ghoul/anatomy.ts';

function fallingCorpse(): TargetHealthState {
  const t = createTargetHealthState('det_corpse', 'Militia', vec3(1.5, 0, -4.0), 0.3);
  t.alive = false;
  t.isRagdollActive = true;
  t.posture = 'AIRBORNE_RAGDOLL';
  stabilizeRagdollPoseForTransition(t, 0.0);
  t.ragdollBones.TORSO_UPPER_THORAX.velocity = vec3(0.4, -0.5, 0.3);
  t.ragdollBones.HEAD_CRANIUM.velocity = vec3(-1.2, 0.6, 0.9);
  t.ragdollBones.HAND_LEFT.velocity = vec3(2.5, 1.0, -1.5);
  return t;
}

function downedLiving(): TargetHealthState {
  const t = createTargetHealthState('det_downed', 'Militia', vec3(0, 0, 0), 0.55);
  t.leftLegFunctional = false;
  t.currentHp = t.maxHp * 0.5;
  t.painShock = 1.26;
  t.bloodLossRateMlPerSec = 0;
  transitionTargetLifecycle(t, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
  return t;
}

const BUILDERS: Array<[string, () => TargetHealthState]> = [
  ['falling corpse', fallingCorpse],
  ['downed living', downedLiving],
];

function step(t: TargetHealthState, dt: number): void {
  if (t.alive) t.consciousness = 1;
  stepRagdollPhysics(t, dt, 0);
}

function runSchedule(t: TargetHealthState): void {
  for (let i = 0; i < 90; i++) step(t, 1 / 60);
  for (let i = 0; i < 10; i++) step(t, 1 / 30);
  for (let i = 0; i < 3; i++) step(t, 0.1);
  for (let i = 0; i < 60; i++) step(t, 1 / 60);
}

function particles(t: TargetHealthState) {
  return [
    ...ALL_GHOUL_ZONES.map((z) => t.ragdollBones[z]),
    ...ALL_AUX_PARTICLES.map((id) => t.auxParticles[id]),
  ];
}

function fingerprint(t: TargetHealthState): number[] {
  const out: number[] = [];
  for (const p of particles(t)) {
    for (const v of [p.position, p.prevPosition, p.velocity]) out.push(v.x, v.y, v.z);
  }
  return out;
}

describe('ragdoll determinism and reference safety', () => {
  it('steps the same scenario to exactly the same state twice', () => {
    for (const [, build] of BUILDERS) {
      const a = build();
      const b = build();
      runSchedule(a);
      runSchedule(b);
      const fp = fingerprint(b);
      expect(fp).toEqual(fingerprint(a));
      expect(fp.every(Number.isFinite)).toBe(true);
    }
  });

  // Velocity objects are not covered: the prediction pass has always added gravity to the
  // velocity a particle carries into the step in place.
  it('leaves positions held from before a step untouched', () => {
    const t = fallingCorpse();
    step(t, 1 / 60);
    const picks = [
      t.ragdollBones.HAND_LEFT,
      t.ragdollBones.PELVIS_GROIN,
      t.ragdollBones.HEAD_CRANIUM,
      t.auxParticles.HEAD_TOP,
    ];
    const held = picks.map((p) => ({
      pos: p.position,
      prev: p.prevPosition,
      posCopy: { ...p.position },
      prevCopy: { ...p.prevPosition },
    }));
    for (let i = 0; i < 5; i++) step(t, 1 / 60);
    for (const h of held) {
      expect(h.pos).toEqual(h.posCopy);
      expect(h.prev).toEqual(h.prevCopy);
    }
  });

  it('never shares a vector object between particles or fields', () => {
    for (const [, build] of BUILDERS) {
      const t = build();
      runSchedule(t);
      const all = particles(t).flatMap((p) => [p.position, p.prevPosition, p.velocity]);
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('in-place vec3 helpers match the immutable ones', () => {
    const a = vec3(0.3, -1.7, 2.9);
    const b = vec3(-4.1, 0.25, 1e-3);
    const s = 0.37;
    expect(addInto(vec3(), a, b)).toEqual(add(a, b));
    expect(subInto(vec3(), a, b)).toEqual(sub(a, b));
    expect(scaleInto(vec3(), a, s)).toEqual(scale(a, s));
    expect(crossInto(vec3(), a, b)).toEqual(cross(a, b));
    expect(normalizeInto(vec3(), a)).toEqual(normalize(a));
    expect(lerpInto(vec3(), a, b, s)).toEqual(lerp(a, b, s));
    expect(addScaledInto(vec3(), a, b, s)).toEqual(add(a, scale(b, s)));
    expect(copyInto(vec3(), a)).toEqual(a);
    expect(distanceSq(a, b)).toBeCloseTo(distance(a, b) ** 2, 9);

    const c = { ...a };
    crossInto(c, c, b);
    expect(c).toEqual(cross(a, b));
    const n = { ...a };
    normalizeInto(n, n);
    expect(n).toEqual(normalize(a));
    const d = { ...a };
    addInto(d, d, b);
    expect(d).toEqual(add(a, b));

    expect(normalizeInto(vec3(1, 1, 1), vec3(0, 0, 0))).toEqual(vec3(0, 0, 0));
  });
});
