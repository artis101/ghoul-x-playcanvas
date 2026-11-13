import { describe, it, expect } from 'vitest';
import { vec3, normalize, sub, scale, add } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_50BMG_M33_BALL,
  AMMO_50BMG_M903_SLAP,
  AMMO_762_NATO_M118LR,
  DEFAULT_ENVIRONMENT,
  WEAPON_MSG90,
} from '../src/core/ballistics/weapons.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { simulateShot } from '../src/core/ballistics/solver.ts';
import type { AmmoSpec, GhoulZoneId } from '../src/contracts/ballistics.ts';

const TARGET_Z = -30;

/** Fires the sniper straight down -Z at the middle of the bone running from `zone` to `childZone`. */
function shootBoneShaft(zone: GhoulZoneId, childZone: GhoulZoneId | null, ammo: AmmoSpec) {
  const target = createTargetHealthState(`t_${zone}`, 'Rifleman', vec3(0, 0, TARGET_Z), 0);
  const a = target.ragdollBones[zone].position;
  const aim = childZone ? scale(add(a, target.ragdollBones[childZone].position), 0.5) : a;
  const origin = vec3(aim.x, aim.y, 0);
  return simulateShot(WEAPON_MSG90, ammo, origin, normalize(sub(aim, origin)), target, DEFAULT_ENVIRONMENT);
}

describe('MSG90-H .50 BMG sniper', () => {
  it('is a slow-firing, high-calibre, high-penetration rifle', () => {
    expect(WEAPON_MSG90.fireRateRpm).toBeLessThanOrEqual(40);
    for (const ammo of WEAPON_MSG90.availableAmmo) {
      const muzzleEnergyJ = 0.5 * ammo.massKg * ammo.muzzleVelocityMs ** 2;
      expect(muzzleEnergyJ).toBeGreaterThan(15000);
      expect(ammo.armorPenetrationFactor).toBeGreaterThan(2.0);
    }
  });

  it.each([
    ['UPPER_ARM_RIGHT', 'FOREARM_RIGHT'],
    ['FOREARM_LEFT', 'HAND_LEFT'],
    ['THIGH_RIGHT', 'KNEE_RIGHT'],
    ['SHIN_LEFT', 'FOOT_LEFT'],
  ] as const)('a direct hit through %s takes the limb off at 30m', (zone, child) => {
    for (const ammo of [AMMO_50BMG_M33_BALL, AMMO_50BMG_M903_SLAP]) {
      const rep = shootBoneShaft(zone, child, ammo);
      expect(rep.hitTarget).toBe(true);
      expect(rep.dismembermentEvents.length).toBeGreaterThan(0);
      expect(rep.severedZones).toContain(child);
    }
  });

  it('takes the head off with a neck shot and bursts the skull with a head shot', () => {
    const neckRep = shootBoneShaft('NECK_CERVICAL', null, AMMO_50BMG_M33_BALL);
    expect(neckRep.severedZones).toContain('HEAD_CRANIUM');
    expect(neckRep.isLethalKill).toBe(true);

    const headRep = shootBoneShaft('HEAD_CRANIUM', null, AMMO_50BMG_M33_BALL);
    expect(headRep.dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP' || d.zone === 'NECK_CERVICAL')).toBe(true);
    expect(headRep.isLethalKill).toBe(true);
  });

  it('a 7.62 match round through the same arm still only wounds it', () => {
    const rep = shootBoneShaft('UPPER_ARM_RIGHT', 'FOREARM_RIGHT', AMMO_762_NATO_M118LR);
    expect(rep.hitTarget).toBe(true);
    expect(rep.dismembermentEvents).toHaveLength(0);
  });
});
