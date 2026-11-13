import * as pc from 'playcanvas';
import { describe, expect, it } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import type { GlbModelRegistry, WeaponAssetId } from '../src/engine/assets/glbLoader.ts';
import { CombatantWeaponMount } from '../src/engine/mannequin/combatantWeaponMount.ts';
import { createClipPose } from './combatantClipPose.ts';

/** Each long gun's support grip in its own frame (combatantWeaponHands.ts SUPPORT_RAILS). */
const RAILS: Record<string, { x: number; y: number; near: number; far: number }> = {
  m4a1_carbine: { x: 0.027, y: -0.054, near: -0.21, far: -0.35 },
  m590_shotgun: { x: 0, y: -0.037, near: -0.25, far: -0.25 },
  msg90_sniper: { x: 0, y: -0.036, near: -0.2, far: -0.36 },
};

function palmOf(hand: pc.GraphNode, offset: number): pc.Vec3 {
  return hand.up.clone().mulScalar(offset).add(hand.getPosition());
}

/**
 * The Blender grip pass bakes the hands onto a long gun in every clip that holds one, so in the
 * game the gun rides the trigger fist and the support palm lands on that gun's own handguard or
 * pump on every frame, for both hands (the `_Southpaw` clips are mirrored at load).
 */
describe('baked long-gun grips in the game', () => {
  const clips = ['CombatReadyIdle', 'LongGunAim', 'Walk', 'StrafeRight', 'CombatReadyIdle_Southpaw', 'LongGunAim_Southpaw'];
  it.each(clips)('%s puts the support palm on every long gun', (clip) => {
    const pose = createClipPose(clip);
    const canvas = { width: 1, height: 1 };
    const app = new pc.Application(canvas as HTMLCanvasElement, { graphicsDevice: new pc.NullGraphicsDevice(canvas) });
    try {
      const southpaw = clip.endsWith('_Southpaw');
      const state = createTargetHealthState('grip', 'Grip', pc.Vec3.ZERO, 0, 'MILITIA_GUNNER', southpaw);
      const supportSide = southpaw ? 'RIGHT' : 'LEFT';
      const hand = pose.glb.boneNodes.get(`HAND_${supportSide}`)!;
      for (const weaponId of Object.keys(RAILS) as WeaponAssetId[]) {
        const rail = RAILS[weaponId];
        const mount = new CombatantWeaponMount();
        const holder = new pc.Entity('Held item', app);
        const registry = {
          isLoaded: () => true,
          instantiateWeapon: () => ({ weaponId, rootEntity: holder, boneNodes: new Map(), fireClipName: null, destroy: () => holder.destroy() }),
        } as unknown as GlbModelRegistry;
        mount.attachGlbWeaponIfReady(registry, state, app.root, weaponId);
        let worst = 0;
        for (const time of pose.frames) {
          pose.sample(time);
          mount.syncWeaponPosition(state, pose.glb);
          const local = new pc.Mat4().invert(holder.getWorldTransform()).transformPoint(palmOf(hand, 0.05));
          const z = Math.min(rail.near, Math.max(rail.far, local.z));
          const x = supportSide === 'RIGHT' ? rail.x : -rail.x;
          worst = Math.max(worst, local.distance(new pc.Vec3(x, rail.y, z)));
        }
        expect(worst, `${weaponId} support palm off its grip`).toBeLessThan(0.015);
        mount.destroy();
      }
    } finally {
      app.destroy();
    }
  });
});
