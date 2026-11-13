import * as pc from 'playcanvas';
import { describe, expect, it } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import type { GlbModelRegistry } from '../src/engine/assets/glbLoader.ts';
import { CombatantWeaponMount } from '../src/engine/mannequin/combatantWeaponMount.ts';
import { LOOSE_SUPPORT_FULL_M } from '../src/engine/mannequin/combatantWeaponHands.ts';
import { createClipPose } from './combatantClipPose.ts';

function palmOf(hand: pc.GraphNode, offset: number): pc.Vec3 {
  return hand.up.clone().mulScalar(offset).add(hand.getPosition());
}

/** The trigger fist sits on the M4 grip, thumb along the modelled grip axis. */
function expectM4TriggerGrip(holder: pc.Entity, hand: pc.GraphNode, side: 'RIGHT' | 'LEFT', time: number): void {
  const inverse = new pc.Mat4().invert(holder.getWorldTransform());
  const expectedPalm = new pc.Vec3(side === 'RIGHT' ? 0.027 : -0.027, -0.05, 0.023);
  const thumb = inverse.transformVector(hand.getRotation().transformVector(pc.Vec3.BACK)).normalize();
  const actualPalm = inverse.transformPoint(palmOf(hand, 0.052));
  expect(actualPalm.distance(expectedPalm), `${side} palm, t=${time}`).toBeLessThan(0.01);
  expect(thumb.dot(new pc.Vec3(0, 0.94, -0.342)), `${side} thumb, t=${time}`).toBeGreaterThan(0.99);
}

/**
 * CombatReadyIdle is a loose-support clip: Kimodo left the support palm 35-58 cm off the forend,
 * so the hand is brought onto the rail on every frame instead of hanging beside the gun. Where the
 * forend is beyond the arm's length the arm goes straight toward it and stops there.
 */
function expectSupportContact(
  holder: pc.Entity, hand: pc.GraphNode, side: 'RIGHT' | 'LEFT', authored: pc.Vec3, time: number,
): void {
  const inverse = new pc.Mat4().invert(holder.getWorldTransform());
  const x = side === 'RIGHT' ? 0.027 : -0.027;
  const railGap = (point: pc.Vec3) => {
    const local = inverse.transformPoint(point);
    return local.distance(new pc.Vec3(x, -0.054, Math.min(-0.21, Math.max(-0.35, local.z))));
  };
  const before = railGap(authored);
  const after = railGap(palmOf(hand, 0.05));
  expect(before, `${side} authored gap, t=${time}`).toBeLessThan(LOOSE_SUPPORT_FULL_M);
  expect(after, `${side} moved toward the rail, t=${time}`).toBeLessThan(before);
  if (after > 0.01) {
    const forearm = hand.parent!;
    const upper = forearm.parent!;
    const length = upper.getPosition().distance(forearm.getPosition()) + forearm.getPosition().distance(hand.getPosition());
    expect(upper.getPosition().distance(hand.getPosition()), `${side} arm at full reach, t=${time}`)
      .toBeGreaterThan(length - 0.005);
  }
}

describe('Combat Ready Idle held prop', () => {
  it.each(['CombatReadyIdle', 'CombatReadyIdle_Southpaw'])('keeps the gun stable across every authored frame of %s', (clip) => {
    const pose = createClipPose(clip);
    const canvas = { width: 1, height: 1 };
    const app = new pc.Application(canvas as HTMLCanvasElement, {
      graphicsDevice: new pc.NullGraphicsDevice(canvas),
    });
    try {
      const mount = new CombatantWeaponMount();
      const state = createTargetHealthState('idle', 'Idle', pc.Vec3.ZERO, 0, 'MILITIA_GUNNER', clip.endsWith('_Southpaw'));
      expect(pose.frames.length).toBeGreaterThan(10);
      for (const weaponId of ['m4a1_carbine', 'm590_shotgun', 'msg90_sniper', 'silver_talon_50ae'] as const) {
        const holder = new pc.Entity('Held item', app);
        const registry = {
          isLoaded: () => true,
          instantiateWeapon: () => ({
            weaponId, rootEntity: holder, boneNodes: new Map(), fireClipName: null, destroy: () => holder.destroy(),
          }),
        } as unknown as GlbModelRegistry;
        mount.attachGlbWeaponIfReady(registry, state, app.root, weaponId);
        const supportSide = state.isLeftHanded ? 'RIGHT' : 'LEFT';
        const triggerSide = state.isLeftHanded ? 'LEFT' : 'RIGHT';
        const supportHand = pose.glb.boneNodes.get(`HAND_${supportSide}`)!;
        const triggerHand = pose.glb.boneNodes.get(`HAND_${triggerSide}`)!;
        const barrelPoint = new pc.Vec3(0, 0, -0.5);
        const palms: pc.Vec3[] = [];
        const positions = pose.frames.map((time) => {
          pose.sample(time);
          const authored = palmOf(supportHand, 0.05);
          palms.push(palmOf(triggerHand, 0.052));
          mount.syncWeaponPosition(state, pose.glb);
          if (weaponId === 'm4a1_carbine') {
            expectM4TriggerGrip(holder, triggerHand, triggerSide, time);
            expectSupportContact(holder, supportHand, supportSide, authored, time);
          }
          return holder.getWorldTransform().transformPoint(barrelPoint);
        });
        // The gun rides the animated fist, so it moves as the clip moves the hand; it must add no
        // more than a little swing of its own on top (the clip twists the wrist near the loop seam).
        for (const [index, position] of positions.entries()) {
          const next = (index + 1) % positions.length;
          const handMove = palms[index].distance(palms[next]);
          expect(position.distance(positions[next]) - handMove, `${weaponId}, frame ${index}`).toBeLessThan(0.03);
        }
        mount.destroy();
      }
    } finally {
      app.destroy();
    }
  });
});
