import * as pc from 'playcanvas';
import { afterEach, describe, expect, it } from 'vitest';
import type { Vec3Like } from '../src/contracts/ballistics.ts';
import { applySwayToDirection } from '../src/core/ai/weaponSway.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import {
  clearEnemyWeaponSway,
  sampleEnemyWeaponSway,
  refreshEnemyWeaponSway,
  setEnemySwayClock,
} from '../src/engine/ai/enemyWeaponSway.ts';
import type { EnemyAimProfile, EnemyAiAgentRuntime } from '../src/engine/ai/tacticalAiTypes.ts';
import type { CombatantGlbInstance, GlbModelRegistry } from '../src/engine/assets/glbLoader.ts';
import {
  aimDeltaWeight,
  applyAimDelta,
  barrelForward,
  clearCombatantAimTargets,
  setCombatantAimTarget,
} from '../src/engine/mannequin/combatantAimDelta.ts';
import { CombatantWeaponMount } from '../src/engine/mannequin/combatantWeaponMount.ts';
import { createClipPose } from './combatantClipPose.ts';

const DEG = Math.PI / 180;

/** Registers the combatant's sway the way the AI does each tick, rifle shouldered, aim not raised. */
function trackSway(hs: ReturnType<typeof createTargetHealthState>): void {
  const agent = {} as EnemyAiAgentRuntime;
  const aim = { usingBackupSidearm: false } as EnemyAimProfile;
  refreshEnemyWeaponSway(hs, agent, aim, false, 0);
}
const heading = (d: Vec3Like): number => Math.atan2(d.x, d.z);
const elevation = (d: Vec3Like): number => Math.asin(d.y / Math.hypot(d.x, d.y, d.z));

/** Chest, gun arm and hand, with a rifle fixed in the fist pointing straight ahead (+Z). */
function makeRig() {
  const root = new pc.GraphNode('GhoulCombatantRoot');
  const bone = (name: string, parent: pc.GraphNode, x: number, y: number, z: number) => {
    const node = new pc.GraphNode(name);
    parent.addChild(node);
    node.setLocalPosition(x, y, z);
    return node;
  };
  const chest = bone('TORSO_UPPER_THORAX', root, 0, 1.35, 0);
  const upper = bone('UPPER_ARM_RIGHT', chest, -0.18, 0.1, 0);
  const forearm = bone('FOREARM_RIGHT', upper, 0, -0.26, 0.05);
  const hand = bone('HAND_RIGHT', forearm, 0, 0, 0.25);
  const gun = new pc.GraphNode('Weapon_m4a1_carbine');
  hand.addChild(gun);
  gun.setLocalEulerAngles(0, 180, 0);
  const boneNodes = new Map<string, pc.GraphNode>([
    ['TORSO_UPPER_THORAX', chest], ['UPPER_ARM_RIGHT', upper], ['FOREARM_RIGHT', forearm], ['HAND_RIGHT', hand],
  ]);
  const glb = { rootEntity: root, boneNodes } as unknown as CombatantGlbInstance;
  return { glb, gun, chest };
}

afterEach(() => {
  clearEnemyWeaponSway();
  clearCombatantAimTargets();
});

describe('combatant aim delta', () => {
  it('reads the barrel along the weapon model\'s -Z', () => {
    const { gun } = makeRig();
    const barrel = barrelForward(gun);
    expect(barrel.z).toBeCloseTo(1, 6);
    expect(Math.hypot(barrel.x, barrel.y)).toBeLessThan(1e-6);
  });

  it('turns the barrel exactly onto a target inside the clamp', () => {
    const { glb, gun } = makeRig();
    const hs = createTargetHealthState('aim_exact', 'Aimer', { x: 0, y: 0, z: 0 }, 0);
    const aim = { x: Math.sin(8 * DEG), y: Math.sin(-12 * DEG), z: Math.cos(8 * DEG) };
    applyAimDelta(glb, hs, { aimDirWorld: aim, hand: 'RIGHT', weight: 1, targetId: hs.targetId }, Infinity, barrelForward(gun));
    const barrel = barrelForward(gun);
    expect(heading(barrel)).toBeCloseTo(heading(aim), 6);
    expect(elevation(barrel)).toBeCloseTo(elevation(aim), 6);
  });

  it('clamps the turn to 15 degrees of yaw and 25 of pitch', () => {
    const { glb, gun } = makeRig();
    const hs = createTargetHealthState('aim_clamp', 'Aimer', { x: 0, y: 0, z: 0 }, 0);
    const aim = { x: Math.sin(50 * DEG), y: 1.5, z: Math.cos(50 * DEG) };
    applyAimDelta(glb, hs, { aimDirWorld: aim, hand: 'RIGHT', weight: 1, targetId: hs.targetId }, Infinity, barrelForward(gun));
    const barrel = barrelForward(gun);
    expect(heading(barrel)).toBeCloseTo(15 * DEG, 6);
    expect(elevation(barrel)).toBeCloseTo(25 * DEG, 6);
  });

  it('eases in and does nothing at zero weight', () => {
    const { glb, gun, chest } = makeRig();
    const hs = createTargetHealthState('aim_ease', 'Aimer', { x: 0, y: 0, z: 0 }, 0);
    const aim = { x: Math.sin(10 * DEG), y: 0, z: Math.cos(10 * DEG) };
    const rest = chest.getLocalRotation().clone();
    applyAimDelta(glb, hs, { aimDirWorld: aim, hand: 'RIGHT', weight: 0, targetId: hs.targetId }, 0.1, barrelForward(gun));
    expect(chest.getLocalRotation().equals(rest)).toBe(true);
    applyAimDelta(glb, hs, { aimDirWorld: aim, hand: 'RIGHT', weight: 1, targetId: hs.targetId }, 0.05, barrelForward(gun));
    expect(aimDeltaWeight(glb)).toBeGreaterThan(0.2);
    expect(aimDeltaWeight(glb)).toBeLessThan(0.5);
    expect(heading(barrelForward(gun))).toBeGreaterThan(0);
    expect(heading(barrelForward(gun))).toBeLessThan(10 * DEG);
  });

  it('swings the held rifle by exactly the sway offset the bullets use', () => {
    const { glb, gun } = makeRig();
    const hs = createTargetHealthState('aim_sway', 'Aimer', { x: 0, y: 0, z: 0 }, 0);
    hs.painShock = 0.6;
    trackSway(hs);
    setEnemySwayClock(3.21);
    const sway = sampleEnemyWeaponSway(hs.targetId);
    expect(Math.hypot(sway.yawRad, sway.pitchRad)).toBeGreaterThan(0);
    applyAimDelta(glb, hs, { aimDirWorld: null, hand: 'RIGHT', weight: 1, targetId: hs.targetId }, Infinity, barrelForward(gun));
    const barrel = barrelForward(gun);
    expect(heading(barrel)).toBeCloseTo(sway.yawRad, 6);
    expect(elevation(barrel)).toBeCloseTo(sway.pitchRad, 6);
  });
});

describe('weapon mount aims the rifle in the long-gun aim clip', () => {
  it('points the barrel at the published aim point plus sway, and lets go outside the aim clip', () => {
    const canvas = { width: 1, height: 1 };
    const app = new pc.Application(canvas as HTMLCanvasElement, { graphicsDevice: new pc.NullGraphicsDevice(canvas) });
    try {
      const pose = createClipPose('LongGunAim');
      pose.sample(pose.frames[pose.frames.length - 1]);
      const hs = createTargetHealthState('mount_aim', 'Aimer', pc.Vec3.ZERO, 0, 'MILITIA_GUNNER', false);
      const holder = new pc.Entity('Held item', app);
      const registry = {
        isLoaded: () => true,
        instantiateWeapon: () => ({
          weaponId: 'm4a1_carbine', rootEntity: holder, boneNodes: new Map(), fireClipName: null, destroy: () => holder.destroy(),
        }),
      } as unknown as GlbModelRegistry;
      const mount = new CombatantWeaponMount();
      mount.attachGlbWeaponIfReady(registry, hs, app.root, 'm4a1_carbine');

      // Without a published target the clip's own aim stands, bent only by the sway (none yet).
      mount.syncWeaponPosition(hs, pose.glb);
      const clipBarrel = barrelForward(holder);

      // A far target a few degrees off the clip's barrel: the parallax of the turn is negligible.
      const p = holder.getPosition();
      const dir = applySwayToDirection(clipBarrel, { yawRad: 6 * DEG, pitchRad: -9 * DEG });
      setCombatantAimTarget(hs.targetId, { x: p.x + dir.x * 200, y: p.y + dir.y * 200, z: p.z + dir.z * 200 });
      hs.painShock = 0.5;
      trackSway(hs);
      setEnemySwayClock(1.7);
      const sway = sampleEnemyWeaponSway(hs.targetId);
      pose.sample(pose.frames[pose.frames.length - 1]);
      mount.syncWeaponPosition(hs, pose.glb);
      const expected = applySwayToDirection(dir, sway);
      const barrel = barrelForward(holder);
      expect(Math.abs(heading(barrel) - heading(expected))).toBeLessThan(0.2 * DEG);
      expect(Math.abs(elevation(barrel) - elevation(expected))).toBeLessThan(0.2 * DEG);

      // Out of the aim clip the delta is gone (snapped here, since no frame time is given).
      expect(aimDeltaWeight(pose.glb)).toBe(1);
      (pose.glb.animComponent!.baseLayer as { activeState: string }).activeState = 'CombatReadyIdle';
      mount.syncWeaponPosition(hs, pose.glb);
      expect(aimDeltaWeight(pose.glb)).toBe(0);
      mount.destroy();
    } finally {
      app.destroy();
    }
  });

  it('aims a hurt body that raises its gun from HurtIdle, but not while a reaction holds it', () => {
    const canvas = { width: 1, height: 1 };
    const app = new pc.Application(canvas as HTMLCanvasElement, { graphicsDevice: new pc.NullGraphicsDevice(canvas) });
    try {
      const pose = createClipPose('LongGunAim');
      pose.sample(pose.frames[pose.frames.length - 1]);
      const hs = createTargetHealthState('hurt_aim', 'Hurt aimer', pc.Vec3.ZERO, 0, 'MILITIA_GUNNER', false);
      hs.posture = 'GUT_HURT';
      const holder = new pc.Entity('Held item', app);
      const registry = {
        isLoaded: () => true,
        instantiateWeapon: () => ({
          weaponId: 'm4a1_carbine', rootEntity: holder, boneNodes: new Map(), fireClipName: null, destroy: () => holder.destroy(),
        }),
      } as unknown as GlbModelRegistry;
      const mount = new CombatantWeaponMount();
      mount.attachGlbWeaponIfReady(registry, hs, app.root, 'm4a1_carbine');
      setCombatantAimTarget(hs.targetId, { x: 0, y: 1.5, z: 200 });

      mount.syncWeaponPosition(hs, pose.glb);
      expect(aimDeltaWeight(pose.glb)).toBe(1);

      hs.activeReaction = { ...hs.activeReaction, type: 'GUT_FOLD' };
      pose.sample(pose.frames[pose.frames.length - 1]);
      mount.syncWeaponPosition(hs, pose.glb);
      expect(aimDeltaWeight(pose.glb)).toBe(0);
      mount.destroy();
    } finally {
      app.destroy();
    }
  });
});
