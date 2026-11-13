import { describe, expect, it } from 'vitest';
import { normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_12G_00_BUCK, AMMO_556_NATO_M855, DEFAULT_ENVIRONMENT, WEAPON_M4A1, WEAPON_M590, WEAPON_MSG90, AMMO_762_NATO_M118LR,
} from '../src/core/ballistics/weapons.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { simulateShot } from '../src/core/ballistics/solver.ts';
import { gradeZoneWound } from '../src/core/ballistics/trauma/woundSeverity.ts';
import { chooseDeathFallStyle } from '../src/core/ballistics/trauma/deathFallStyle.ts';
import type { WoundChannelEvent } from '../src/contracts/ballistics.ts';

const wound = (over: Partial<WoundChannelEvent>): WoundChannelEvent => ({
  ghoulZone: 'NECK_CERVICAL', armorStopped: false, pathLengthM: 0.02, energyDepositedJ: 40,
  arterialSevered: false, organRuptured: false, boneFractured: false, boneShattered: false,
  ...over,
} as WoundChannelEvent);

describe('wound severity follows what the projectile did, not just where it hit', () => {
  it('a shallow low-energy pellet in the neck is a graze; an opened artery is critical', () => {
    expect(gradeZoneWound('NECK_CERVICAL', [wound({})]).severity).toBe('GRAZE');
    expect(gradeZoneWound('NECK_CERVICAL', [wound({ arterialSevered: true })]).severity).toBe('CRITICAL');
    expect(gradeZoneWound('NECK_CERVICAL', [wound({ pathLengthM: 0.1, energyDepositedJ: 300 })]).severity).toBe('PENETRATING');
  });

  it('a 5.56 round through the chest is at least penetrating', () => {
    const t = createTargetHealthState('t', 'T', vec3(0, 0, -8), 0, 'SKINHEAD_PUNK');
    const o = vec3(0, 1.35, 0);
    const r = simulateShot(WEAPON_M4A1, AMMO_556_NATO_M855, o, normalize(sub(vec3(0, 1.35, -8), o)), t, DEFAULT_ENVIRONMENT);
    expect(gradeZoneWound('TORSO_UPPER_THORAX', r.woundEvents).severity).not.toBe('GRAZE');
  });
});

describe('death fall style', () => {
  it('a destroyed brain always drops the body where it stands', () => {
    const t = createTargetHealthState('cns', 'T', vec3(0, 0, -10), 0, 'MILITIA_GUNNER');
    const o = vec3(0, 1.68, 0);
    const r = simulateShot(WEAPON_MSG90, AMMO_762_NATO_M118LR, o, normalize(sub(vec3(0, 1.68, -10), o)), t, DEFAULT_ENVIRONMENT);
    expect(r.isLethalKill).toBe(true);
    expect(chooseDeathFallStyle(t, r)).toBe('CRUMPLE');
  });

  it('a contact-range buckshot blast throws the body', () => {
    const t = createTargetHealthState('blast', 'T', vec3(0, 0, -1.2), 0, 'SKINHEAD_PUNK');
    const o = vec3(0, 1.2, 0);
    const r = simulateShot(WEAPON_M590, AMMO_12G_00_BUCK, o, normalize(sub(vec3(0, 1.2, -1.2), o)), t, DEFAULT_ENVIRONMENT);
    const imp = r.ragdollPlan.netRootImpulseWorld;
    if (Math.hypot(imp.x, imp.z) >= 230 && !r.rupturedOrgans.includes('Brain (Cerebrum & Brainstem)')) {
      expect(chooseDeathFallStyle(t, r)).toBe('KNOCKBACK');
    }
  });
});
