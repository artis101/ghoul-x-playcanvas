import * as pc from 'playcanvas';
import { describe, expect, it } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { solveTwoBoneIk } from '../src/core/ghoul/anatomy/twoBoneIk.ts';
import { length, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import { CombatantAnimController } from '../src/engine/mannequin/combatantAnimController.ts';
import { CombatantWeaponGrip } from '../src/engine/mannequin/combatantWeaponGrip.ts';

describe('NPC animation and weapon grips', () => {
  it('selects guard and injury clips even when AI posture has returned to combat-ready', () => {
    const state = createTargetHealthState('npc', 'NPC', vec3());
    const controller = new CombatantAnimController();

    expect(controller.resolveDesiredClip(state, true)).toBe('UnsuspectingIdle');
    expect(controller.resolveDesiredClip(state)).toBe('CombatReadyIdle');

    state.activeReaction.type = 'CHEST_STAGGER';
    expect(controller.resolveDesiredClip(state)).toBe('HitStaggerChest');
    state.activeReaction.type = 'GUT_FOLD';
    expect(controller.resolveDesiredClip(state)).toBe('DiaphragmDropKneel');
    state.activeReaction.type = 'LEG_BUCKLE_LEFT';
    expect(controller.resolveDesiredClip(state)).toBe('LegCollapseCrawl');
  });

  it('selects the Kimodo guard clip only when the matching handed variant is available', () => {
    const state = createTargetHealthState('npc', 'NPC', vec3());
    const controller = new CombatantAnimController();
    const availableClips = new Set(['UnsuspectingIdle_Kimodo']);
    const glb = {
      animComponent: { playing: true } as pc.AnimComponent,
      availableClips,
      playClip: () => true,
    };

    state.isLeftHanded = false;
    controller.syncAnimation(glb, state, true);
    expect(controller.clipState).toMatchObject({ clip: 'UnsuspectingIdle_Kimodo', isSouthpaw: false });

    state.isLeftHanded = true;
    controller.syncAnimation(glb, state, true);
    expect(controller.clipState).toMatchObject({ clip: 'UnsuspectingIdle', isSouthpaw: true });

    availableClips.add('UnsuspectingIdle_Kimodo_Southpaw');
    controller.syncAnimation(glb, state, true);
    expect(controller.clipState).toMatchObject({ clip: 'UnsuspectingIdle_Kimodo', isSouthpaw: true });
  });

  it('points the authored negative Z muzzle toward the aim while holding the scaled pistol at the palm', () => {
    const holder = new pc.GraphNode();
    const weapon = new pc.GraphNode();
    const muzzle = new pc.GraphNode();
    holder.addChild(weapon);
    weapon.addChild(muzzle);
    weapon.setLocalScale(0.84, 0.84, 0.84);
    muzzle.setLocalPosition(0, 0, -0.292);

    const palm = new pc.Vec3(2, 1.3, -5);
    const aim = new pc.Vec3(0.4, 0.25, 1).normalize();
    new CombatantWeaponGrip().align(holder, weapon, 'silver_talon_50ae', palm, aim);

    expect(holder.forward.dot(aim)).toBeCloseTo(1);
    const grip = weapon.getWorldTransform().transformPoint(new pc.Vec3(0, -0.045, 0.02));
    expect(grip.distance(palm)).toBeLessThan(1e-5);
    expect(muzzle.getPosition().clone().sub(holder.getPosition()).dot(aim)).toBeCloseTo(0.292 * 0.84);
  });

  it('keeps support-arm segment lengths for reachable and unreachable grips', () => {
    const shoulder = vec3();
    const elbow = vec3(0, -0.3, 0);
    const wrist = vec3(0, -0.3, 0.25);
    const reachable = vec3(0.1, -0.1, 0.35);
    const unreachable = vec3(0, 0, 1);
    const reachablePose = solveTwoBoneIk(shoulder, elbow, wrist, reachable)!;
    const clampedPose = solveTwoBoneIk(shoulder, elbow, wrist, unreachable)!;

    expect(length(sub(reachablePose.wrist, reachable))).toBeLessThan(1e-5);
    expect(length(clampedPose.wrist)).toBeCloseTo(0.55);
    for (const pose of [reachablePose, clampedPose]) {
      expect(length(sub(pose.elbow, shoulder))).toBeCloseTo(0.3);
      expect(length(sub(pose.wrist, pose.elbow))).toBeCloseTo(0.25);
    }
  });
});
