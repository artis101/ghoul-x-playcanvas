import type * as pc from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import { COMBATANT_ANIMATION_CLIPS, COMBATANT_SIDED_CLIPS } from '../src/engine/assets/glbLoader.ts';
import { CombatantAnimController } from '../src/engine/mannequin/combatantAnimController.ts';
import {
  drawClipPlan, drawClipProgress, drawClipSecondsFor, drawPlaybackSpeed, isDrawClipPlaying,
  KNEEL_STUMP_DRAW_S, PISTOL_DRAW_S, STUMP_DRAW_S,
} from '../src/engine/mannequin/combatantDrawClips.ts';

const ALL_CLIPS: ReadonlySet<string> = new Set([...COMBATANT_ANIMATION_CLIPS, ...COMBATANT_SIDED_CLIPS]);

function drawing() {
  const hs = createTargetHealthState('draw', 'Draw', vec3());
  hs.isLeftHanded = false;
  hs.weaponDropped = true;
  hs.combatantStatusTag = 'SIDEARM_DRAWING';
  return hs;
}

function layerGlb(activeState: string, activeStateProgress: number) {
  return { animComponent: { baseLayer: { activeState, activeStateProgress } } as unknown as pc.AnimComponent };
}

describe('sidearm draw clips', () => {
  it('draws two-handed standing, from the stump clutch with an arm gone, and on one knee', () => {
    const hs = drawing();
    expect(drawClipPlan(hs, 'RIGHT')?.chain[0]).toBe('PistolDraw');
    expect(drawClipPlan(hs, 'LEFT')?.southpaw).toBe(true);
    expect(drawClipSecondsFor(hs)).toBe(PISTOL_DRAW_S);

    hs.severedZones.add('UPPER_ARM_RIGHT');
    hs.woundedPhase = 'BLAZE';
    expect(drawClipPlan(hs, 'LEFT')?.chain).toEqual(['StumpDrawRight', 'StumpClutchRight']);
    expect(drawClipSecondsFor(hs)).toBe(STUMP_DRAW_S);

    hs.woundedPhase = 'KNEEL_FIRE';
    expect(drawClipPlan(hs, 'LEFT')?.chain).toEqual(['KneelStumpDrawRight', 'StumpKneelRight']);
    expect(drawClipSecondsFor(hs)).toBe(KNEEL_STUMP_DRAW_S);
  });

  it('does not draw while kneeling down, sitting down, crawling, seated or with the pistol out', () => {
    const hs = drawing();
    hs.severedZones.add('UPPER_ARM_LEFT');
    for (const phase of ['KNEEL_DOWN', 'SIT_DOWN', 'DOWNED_CRAWL'] as const) {
      hs.woundedPhase = phase;
      expect(drawClipPlan(hs, 'RIGHT')).toBeNull();
    }
    hs.woundedPhase = 'BLAZE';
    hs.combatantStatusTag = 'SIDEARM_DRAWN';
    expect(drawClipPlan(hs, 'RIGHT')).toBeNull();
  });

  it('reads the draw progress from the playing clip, mirrored twins included', () => {
    expect(isDrawClipPlaying(layerGlb('PistolDraw_Southpaw', 0.3))).toBe(true);
    expect(drawClipProgress(layerGlb('PistolDraw_Southpaw', 0.3))).toBeCloseTo(0.3);
    expect(drawClipProgress(layerGlb('KneelStumpDrawLeft', 1.4))).toBe(1);
    expect(drawClipProgress(layerGlb('PistolAim', 0.3))).toBeNull();
    expect(isDrawClipPlaying(null)).toBe(false);
  });

  it('times the clip to the armament draw', () => {
    const hs = drawing();
    expect(drawPlaybackSpeed(hs, PISTOL_DRAW_S)).toBeCloseTo(1);
    expect(drawPlaybackSpeed(hs, 1.6)).toBeCloseTo(1.6 / PISTOL_DRAW_S);
    expect(drawPlaybackSpeed(hs, undefined)).toBe(1);
  });

  it('plays the draw in place of the stump clutch, then the one-handed aim', () => {
    const hs = drawing();
    hs.severedZones.add('UPPER_ARM_LEFT');
    hs.woundedPhase = 'BLAZE';
    const baseLayer = { activeStateProgress: 0, activeStateDuration: STUMP_DRAW_S * 1.1 };
    const animComponent = { playing: true, speed: 1, baseLayer } as unknown as pc.AnimComponent;
    const playClip = vi.fn(() => true);
    const glb = { animComponent, playClip, availableClips: ALL_CLIPS };
    const controller = new CombatantAnimController();
    const aim = { clip: 'PistolAimOneHand' as const, hand: 'RIGHT' as const };
    controller.syncAnimation(glb, hs, false, { clip: 'Walk', playbackSpeed: 1 }, aim);
    expect(playClip).toHaveBeenLastCalledWith('StumpDrawLeft', 0.2, 1, false);
    expect(animComponent.speed).toBeCloseTo(1.1);
    controller.syncAnimation(glb, hs, false, undefined, aim);
    expect(playClip).toHaveBeenCalledTimes(1);

    hs.combatantStatusTag = 'RUSHING';
    controller.syncAnimation(glb, hs, false, undefined, aim);
    expect(playClip).toHaveBeenLastCalledWith('PistolAimOneHand', 0.12, 1, false);
  });
});
