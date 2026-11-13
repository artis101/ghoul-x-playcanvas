import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pc from 'playcanvas';
import type { Vec3Like } from '../src/contracts/ballistics.ts';
import {
  applySwayToDirection,
  createWeaponSwayState,
  holdSwayAmplitudeRad,
  kickWeaponSway,
  MAX_SWAY_RAD,
  noteAimRaised,
  recoilAt,
  recoilKickForWeapon,
  sampleWeaponSway,
  swayRotationForBarrel,
  type WeaponSwayConditions,
} from '../src/core/ai/weaponSway.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { normalize, sub } from '../src/core/ballistics/vec3.ts';
import { TacticalCombatAiSystem } from '../src/engine/ai/tacticalCombatAi.ts';
import type { EnemyTracerFireEvent } from '../src/engine/ai/tacticalAiTypes.ts';
import { emitEnemyTracerShot, type BurstContext } from '../src/engine/ai/tacticalBurstAndTracers.ts';
import {
  clearEnemyWeaponSway,
  refreshEnemyWeaponSway,
  sampleEnemyWeaponSway,
  setEnemySwayClock,
} from '../src/engine/ai/enemyWeaponSway.ts';

const DEG = Math.PI / 180;

const REST: WeaponSwayConditions = {
  hold: 'RIFLE_SHOULDERED',
  posture: 'STANDING',
  painShock: 0,
  bloodLossFraction: 0,
  consciousness: 1,
  heartRateBpm: 72,
  resolveProfile: 'GRITTY_REGULAR',
};

const WOUNDED: Partial<WeaponSwayConditions> = { painShock: 0.5, bloodLossFraction: 0.25, consciousness: 0.8, heartRateBpm: 120 };

/** Largest angular deviation over half a minute at 60 Hz, aim held steady (no settle-in). */
function peakSwayDeg(c: WeaponSwayConditions, id = 'sway_probe'): number {
  const state = createWeaponSwayState(id);
  let peak = 0;
  for (let i = 0; i <= 1800; i++) {
    const o = sampleWeaponSway(state, c, i / 60);
    peak = Math.max(peak, Math.hypot(o.yawRad, o.pitchRad));
  }
  return peak / DEG;
}

function heading(d: Vec3Like): number {
  return Math.atan2(d.x, d.z);
}

function elevation(d: Vec3Like): number {
  return Math.asin(d.y / Math.hypot(d.x, d.y, d.z));
}

afterEach(() => clearEnemyWeaponSway());

describe('weapon sway core', () => {
  it('is deterministic per combatant and never rolls Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    const a = createWeaponSwayState('gunner_7');
    const b = createWeaponSwayState('gunner_7');
    const other = createWeaponSwayState('gunner_8');
    let differs = false;
    for (let i = 0; i < 300; i++) {
      const t = i / 30;
      const sa = sampleWeaponSway(a, REST, t);
      expect(sampleWeaponSway(b, REST, t)).toEqual(sa);
      // Sampling twice at one moment changes nothing: the shot and the pose see the same offset.
      expect(sampleWeaponSway(a, REST, t)).toEqual(sa);
      const so = sampleWeaponSway(other, REST, t);
      if (Math.abs(so.yawRad - sa.yawRad) > 1e-5) differs = true;
    }
    expect(differs).toBe(true);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('stays subtle at rest and grows clearly when wounded', () => {
    const rifle = peakSwayDeg(REST);
    expect(rifle).toBeGreaterThan(0.3);
    expect(rifle).toBeLessThan(0.7);

    const pistol = peakSwayDeg({ ...REST, hold: 'PISTOL_TWO_HAND' });
    expect(pistol).toBeGreaterThan(0.7);
    expect(pistol).toBeLessThan(1.3);
    expect(peakSwayDeg({ ...REST, hold: 'PISTOL_ONE_HAND' })).toBeGreaterThan(pistol);

    const wounded = peakSwayDeg({ ...REST, ...WOUNDED });
    expect(wounded).toBeGreaterThan(2);
    expect(wounded).toBeLessThan(4.5);
    // Even a badly hurt one-handed shooter on the floor stays within a few degrees of the target.
    const worst = peakSwayDeg({ ...REST, painShock: 1, bloodLossFraction: 0.5, consciousness: 0.3, hold: 'PISTOL_ONE_HAND', posture: 'SEATED' });
    expect(worst).toBeGreaterThan(3);
    expect(worst).toBeLessThan(5);
  });

  it('is steadier kneeling and for veterans, shakier seated and for panicked scrappers', () => {
    const amp = (c: Partial<WeaponSwayConditions>) => holdSwayAmplitudeRad({ ...REST, ...c });
    expect(amp({ posture: 'KNEELING' })).toBeLessThan(amp({}));
    expect(amp({ posture: 'SEATED', hold: 'PISTOL_ONE_HAND' })).toBeGreaterThan(amp({ hold: 'PISTOL_ONE_HAND' }));
    expect(amp({ resolveProfile: 'HARDENED_VETERAN' })).toBeLessThan(amp({}));
    expect(amp({ resolveProfile: 'PANICKED_SCRAPPER' })).toBeGreaterThan(amp({}));
    expect(amp({ painShock: 1, bloodLossFraction: 0.5, consciousness: 0.3 })).toBeLessThanOrEqual(MAX_SWAY_RAD + 1e-12);
  });

  it('kicks the muzzle up on a shot and recovers within a fraction of a second', () => {
    const state = createWeaponSwayState('shotgunner');
    const kick = recoilKickForWeapon('m590_shotgun');
    kickWeaponSway(state, kick, REST, 10);
    expect(recoilAt(state, 10).pitchRad).toBeCloseTo(kick.pitchRad, 10);
    expect(recoilAt(state, 10.1).pitchRad).toBeLessThan(kick.pitchRad * 0.5);
    expect(recoilAt(state, 10.5).pitchRad).toBeLessThan(kick.pitchRad * 0.02);

    // A badly hurt one-handed shooter takes longer to bring the gun back down.
    const shaky = createWeaponSwayState('shotgunner');
    kickWeaponSway(shaky, kick, { ...REST, ...WOUNDED, hold: 'PISTOL_ONE_HAND' }, 10);
    expect(recoilAt(shaky, 10.1).pitchRad).toBeGreaterThan(recoilAt(state, 10.1).pitchRad);

    // Rapid shots stack, but never past the cap.
    const auto = createWeaponSwayState('auto');
    for (let i = 0; i < 40; i++) kickWeaponSway(auto, kick, REST, i * 0.01);
    expect(recoilAt(auto, 0.39).pitchRad).toBeLessThanOrEqual(8 * DEG + 1e-12);
  });

  it('wobbles more right after the aim comes up, then settles', () => {
    const state = createWeaponSwayState('settler');
    const still = createWeaponSwayState('settler');
    noteAimRaised(state, true, 5);
    const early = sampleWeaponSway(state, REST, 5.02);
    const base = sampleWeaponSway(still, REST, 5.02);
    expect(Math.hypot(early.yawRad - base.yawRad, early.pitchRad - base.pitchRad)).toBeGreaterThan(0.3 * DEG);
    const late = sampleWeaponSway(state, REST, 7.5);
    const lateBase = sampleWeaponSway(still, REST, 7.5);
    expect(Math.hypot(late.yawRad - lateBase.yawRad, late.pitchRad - lateBase.pitchRad)).toBeLessThan(0.01 * DEG);
  });

  it('turns a barrel the same way as it turns an aim direction', () => {
    const offset = { yawRad: 0.031, pitchRad: -0.022 };
    for (const barrel of [{ x: 0, y: 0, z: 1 }, normalize({ x: 0.6, y: 0.2, z: -0.7 }), normalize({ x: -1, y: -0.3, z: 0.1 })]) {
      const q = swayRotationForBarrel(barrel, offset);
      const viaQuat = new pc.Quat(q.x, q.y, q.z, q.w).transformVector(new pc.Vec3(barrel.x, barrel.y, barrel.z));
      const viaAngles = applySwayToDirection(barrel, offset);
      expect(viaQuat.x).toBeCloseTo(viaAngles.x, 9);
      expect(viaQuat.y).toBeCloseTo(viaAngles.y, 9);
      expect(viaQuat.z).toBeCloseTo(viaAngles.z, 9);
    }
  });
});

describe('enemy weapon sway in the game', () => {
  it('sends the bullet along the swayed aim, then kicks the muzzle', () => {
    const shots: EnemyTracerFireEvent[] = [];
    const ai = new TacticalCombatAiSystem({ onEnemyFireTracer: (ev) => shots.push(ev) });
    const hs = createTargetHealthState('sway_gunner', 'Sway', { x: 0, y: 0, z: -10 }, 0);
    hs.painShock = 0.4;
    ai.registerWaveTargets([hs], false);
    const agent = ai.getAgent('sway_gunner')!;
    agent.hasFiredWarningShot = true;
    agent.fireMode = undefined;
    const profile = { ...ai.computeEnemyAimProfile(hs, agent), effectiveSpreadRad: 0 };

    const now = 12.34;
    refreshEnemyWeaponSway(hs, agent, profile, true, now);
    const sway = sampleEnemyWeaponSway('sway_gunner', now);
    expect(Math.hypot(sway.yawRad, sway.pitchRad)).toBeGreaterThan(0);

    const eye = { x: 0, y: 1.7, z: 0 };
    const aim = { x: 0, y: 1.5, z: 0 };
    const ctx: BurstContext = {
      elapsedClockS: now,
      playerVitals: ai.playerVitals,
      tracerPool: null,
      rapierWorld: null,
      onEnemyFireTracer: (ev) => shots.push(ev),
      resolveExposedPlayerAimPoint: () => aim,
    };
    emitEnemyTracerShot(hs, agent, profile, eye, aim, ctx);
    expect(shots).toHaveLength(1);

    const origin = { x: 0, y: 1.32, z: -10 };
    const expected = applySwayToDirection(normalize(sub(aim, origin)), sway);
    const dir = shots[0].shotDirectionWorld;
    expect(dir.x).toBeCloseTo(expected.x, 9);
    expect(dir.y).toBeCloseTo(expected.y, 9);
    expect(dir.z).toBeCloseTo(expected.z, 9);

    const after = sampleEnemyWeaponSway('sway_gunner', now);
    expect(after.pitchRad).toBeGreaterThan(sway.pitchRad + 0.5 * DEG);
  });
});
