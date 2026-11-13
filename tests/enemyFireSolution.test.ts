import { afterEach, describe, expect, it } from 'vitest';
import * as pc from 'playcanvas';
import type { Vec3Like } from '../src/contracts/ballistics.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { normalize, sub } from '../src/core/ballistics/vec3.ts';
import {
  PLAYER_RECOIL_RECOVERY_PER_S,
  createWeaponSwayState,
  kickWeaponSway,
  recoilAt,
  recoilKickForWeapon,
  type WeaponSwayConditions,
} from '../src/core/ai/weaponSway.ts';
import { WEAPON_M4A1, WEAPON_M590 } from '../src/core/ballistics/weapons/weaponSpecs.ts';
import { getWeaponAdsProfile } from '../src/core/ballistics/weapons/adsProfiles.ts';
import { TacticalCombatAiSystem } from '../src/engine/ai/tacticalCombatAi.ts';
import type { EnemyTracerFireEvent } from '../src/engine/ai/tacticalAiTypes.ts';
import {
  emitEnemyTracerShot,
  stepWeaponBurstFire,
  type BurstContext,
} from '../src/engine/ai/tacticalBurstAndTracers.ts';
import { clearEnemyWeaponSway } from '../src/engine/ai/enemyWeaponSway.ts';
import {
  angleBetweenRad,
  FIRE_GATE_MARGIN_RAD,
  isBarrelOnTarget,
  weaponBarrelPose,
  type EnemyBarrelPose,
} from '../src/engine/ai/enemyFireSolution.ts';
import type { HardwareInstancedPool } from '../src/engine/physics/instancedPool.ts';

const DEG = Math.PI / 180;
const EYE: Vec3Like = { x: 0, y: 1.7, z: 0 };
const CHEST: Vec3Like = { x: 0, y: 1.52, z: 0 };
const MUZZLE: Vec3Like = { x: 0.22, y: 1.45, z: -9.4 };

const REST: WeaponSwayConditions = {
  hold: 'RIFLE_SHOULDERED',
  posture: 'STANDING',
  painShock: 0,
  bloodLossFraction: 0,
  consciousness: 1,
  heartRateBpm: 72,
  resolveProfile: 'GRITTY_REGULAR',
};

/** A barrel at the test muzzle, turned `offDeg` to the side of the line to the chest. */
function barrelOff(offDeg: number): EnemyBarrelPose {
  const toChest = normalize(sub(CHEST, MUZZLE));
  const h = Math.atan2(toChest.x, toChest.z) + offDeg * DEG;
  const flat = Math.hypot(toChest.x, toChest.z);
  return { muzzleWorld: MUZZLE, barrelDirWorld: normalize({ x: Math.sin(h) * flat, y: toChest.y, z: Math.cos(h) * flat }) };
}

function setup(spreadRad: number, barrel: () => EnemyBarrelPose | null) {
  const shots: EnemyTracerFireEvent[] = [];
  const tracers: { origin: Vec3Like; velocity: Vec3Like }[] = [];
  const ai = new TacticalCombatAiSystem({});
  const hs = createTargetHealthState('barrel_gunner', 'Barrel', { x: 0, y: 0, z: -10 }, 0);
  ai.registerWaveTargets([hs], false);
  const agent = ai.getAgent('barrel_gunner')!;
  agent.hasFiredWarningShot = true;
  agent.fireMode = undefined;
  agent.alertReactionTimerS = 0;
  agent.fireCooldownTimerS = 0;
  const profile = { ...ai.computeEnemyAimProfile(hs, agent), effectiveSpreadRad: spreadRad };
  const tracerPool = {
    spawnKinematicParticle: (origin: Vec3Like, velocity: Vec3Like) => {
      tracers.push({ origin: { ...origin }, velocity: { ...velocity } });
    },
  } as unknown as HardwareInstancedPool;
  const ctx: BurstContext = {
    elapsedClockS: 5,
    playerVitals: ai.playerVitals,
    tracerPool,
    rapierWorld: null,
    onEnemyFireTracer: (ev) => shots.push(ev),
    resolveExposedPlayerAimPoint: () => CHEST,
    readBarrelPose: () => barrel(),
  };
  return { shots, tracers, hs, agent, profile, ctx };
}

afterEach(() => clearEnemyWeaponSway());

describe('enemy shots leave from the visible barrel', () => {
  it('fires along the barrel from the muzzle, and the tracer starts there too', () => {
    const barrel = barrelOff(1.5);
    const { shots, tracers, hs, agent, profile, ctx } = setup(0, () => barrel);
    emitEnemyTracerShot(hs, agent, profile, EYE, CHEST, ctx);
    expect(shots).toHaveLength(1);
    const ev = shots[0];
    expect(ev.muzzleOriginWorld).toEqual(MUZZLE);
    expect(angleBetweenRad(ev.shotDirectionWorld, barrel.barrelDirWorld)).toBeLessThan(1e-9);
    // The impact lies on the shot line out of the muzzle.
    expect(angleBetweenRad(sub(ev.impactPointWorld, MUZZLE), ev.shotDirectionWorld)).toBeLessThan(1e-6);

    expect(tracers).toHaveLength(1);
    expect(tracers[0].origin).toEqual(MUZZLE);
    expect(angleBetweenRad(tracers[0].velocity, ev.shotDirectionWorld)).toBeLessThan(1e-9);
  });

  it('lays the spread cone on top of the barrel, never further', () => {
    const barrel = barrelOff(-1);
    const spread = 1.2 * DEG;
    const { shots, hs, agent, profile, ctx } = setup(spread, () => barrel);
    for (let i = 0; i < 12; i++) emitEnemyTracerShot(hs, agent, profile, EYE, CHEST, ctx);
    for (const ev of shots) {
      expect(angleBetweenRad(ev.shotDirectionWorld, barrel.barrelDirWorld)).toBeLessThanOrEqual(spread + 1e-9);
    }
  });

  it('holds the trigger while the barrel points away, and fires once it comes on target', () => {
    let barrel = barrelOff(14);
    const { shots, hs, agent, profile, ctx } = setup(0.5 * DEG, () => barrel);
    for (let i = 0; i < 40; i++) {
      ctx.elapsedClockS += 0.05;
      stepWeaponBurstFire(0.05, hs, agent, profile, EYE, ctx);
    }
    expect(shots).toHaveLength(0);

    barrel = barrelOff(1);
    for (let i = 0; i < 40 && shots.length === 0; i++) {
      ctx.elapsedClockS += 0.05;
      stepWeaponBurstFire(0.05, hs, agent, profile, EYE, ctx);
    }
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0].muzzleOriginWorld).toEqual(MUZZLE);
  });

  it('reads the barrel off the weapon root and the muzzle off its muzzle bone', () => {
    const root = new pc.GraphNode('Weapon_m4a1_carbine');
    const muzzle = new pc.GraphNode('Bone_Muzzle');
    muzzle.setLocalPosition(0, 0.028, -0.565);
    root.addChild(muzzle);
    root.setPosition(1, 1.4, 2);
    root.setEulerAngles(0, 90, 0);
    const pose = weaponBarrelPose(root)!;
    // Local -Z turned 90 degrees about +Y points down world -X.
    expect(pose.barrelDirWorld.x).toBeCloseTo(-1, 6);
    expect(pose.muzzleWorld.x).toBeCloseTo(1 - 0.565, 6);
    expect(pose.muzzleWorld.y).toBeCloseTo(1.428, 6);
    expect(weaponBarrelPose(null)).toBeNull();
  });
});

describe('enemy recoil uses the player recoil numbers', () => {
  it('kicks by the player rig shares of recoilKickDeg, braced by the sights', () => {
    const kick = recoilKickForWeapon('m4a1_carbine');
    const brace = getWeaponAdsProfile('m4a1_carbine').adsRecoilScale;
    expect(kick.pitchRad).toBeCloseTo(WEAPON_M4A1.recoilKickDeg * 0.72 * brace * DEG, 12);
    expect(kick.yawRad).toBeCloseTo(WEAPON_M4A1.recoilKickDeg * 0.11 * brace * DEG, 12);
    // A one-handed hold has nothing bracing it.
    const loose = recoilKickForWeapon('silver_talon_50ae', 'PISTOL_ONE_HAND');
    expect(loose.pitchRad).toBeCloseTo(6.2 * 0.72 * DEG, 12);
  });

  it('climbs over a burst, alternates sideways, and recovers at the player rate', () => {
    const state = createWeaponSwayState('burster');
    const kick = recoilKickForWeapon('m4a1_carbine');
    const cycle = 60 / WEAPON_M4A1.fireRateRpm;
    const pitches: number[] = [];
    const yaws: number[] = [];
    for (let i = 0; i < 4; i++) {
      kickWeaponSway(state, kick, REST, i * cycle);
      pitches.push(recoilAt(state, i * cycle).pitchRad);
      yaws.push(recoilAt(state, i * cycle).yawRad);
    }
    for (let i = 1; i < 4; i++) expect(pitches[i]).toBeGreaterThan(pitches[i - 1]);
    expect(Math.sign(yaws[0])).toBe(-1);
    expect(Math.sign(yaws[1] - yaws[0] * Math.exp(-PLAYER_RECOIL_RECOVERY_PER_S * cycle))).toBe(1);
    const last = 3 * cycle;
    expect(recoilAt(state, last + 0.2).pitchRad).toBeCloseTo(pitches[3] * Math.exp(-PLAYER_RECOIL_RECOVERY_PER_S * 0.2), 12);
  });

  it('keeps the next shot waiting until a heavy kick settles back inside the fire gate', () => {
    const state = createWeaponSwayState('pump');
    const kick = recoilKickForWeapon('m590_shotgun');
    expect(kick.pitchRad).toBeCloseTo(WEAPON_M590.recoilKickDeg * 0.72 * 0.75 * DEG, 12);
    kickWeaponSway(state, kick, REST, 0);
    const spread = 0.5 * DEG;
    const onTargetAt = (t: number) => {
      const r = recoilAt(state, t);
      const dir = { x: 0, y: Math.sin(r.pitchRad), z: Math.cos(r.pitchRad) };
      return isBarrelOnTarget({ origin: { x: 0, y: 0, z: 0 }, dir, fromVisualWeapon: true }, [{ x: 0, y: 0, z: 10 }], spread);
    };
    expect(kick.pitchRad).toBeGreaterThan(spread + FIRE_GATE_MARGIN_RAD);
    expect(onTargetAt(0.01)).toBe(false);
    expect(onTargetAt(0.15)).toBe(true);
  });
});
