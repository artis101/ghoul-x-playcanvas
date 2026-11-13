import * as pc from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import type { TargetHealthState } from '../src/contracts/ballistics.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import * as anatomy from '../src/core/ghoul/anatomy.ts';
import { createTargetHealthState, placeRestSkeleton } from '../src/core/ghoul/anatomy.ts';
import { hitJoltScale } from '../src/core/ghoul/anatomy/proceduralTraumaIk.ts';
import { OffhandSidearmSync } from '../src/engine/combat/offhandSidearmSync.ts';
import type { OffhandSidearmRig } from '../src/engine/combat/offhandSidearmTypes.ts';
import { createPropAttachmentState } from '../src/engine/mannequin/propAttachmentState.ts';
import type { GhoulMannequinEntity } from '../src/engine/mannequin/ghoulMannequinEntity.ts';

describe('procedural cleanup: clips own the living body', () => {
  it('plays the graze jolt only when no wound, fall, seated, clutch or crawl clip holds the body', () => {
    expect(hitJoltScale({})).toBe(1);
    expect(hitJoltScale({ woundClip: null, bodyClip: false })).toBe(1);
    expect(hitJoltScale({ woundClip: 'FLINCH' })).toBe(0);
    expect(hitJoltScale({ woundClip: 'COMMITTED' })).toBe(0);
    expect(hitJoltScale({ bodyClip: true })).toBe(0);
  });

  it('no longer ships the procedural standing pose', () => {
    expect('updateStandingCombatPose' in anatomy).toBe(false);
  });

  it('carries the rest skeleton rigidly with the root, and leaves an animated body alone', () => {
    const hs = createTargetHealthState('rest', 'Rest', vec3(0, 0, 0), 0);
    const restHead = { ...hs.ragdollBones.HEAD_CRANIUM.position };
    hs.worldPosition = vec3(3, 0, -2);
    hs.yawRad = Math.PI;
    placeRestSkeleton(hs);
    const head = hs.ragdollBones.HEAD_CRANIUM.position;
    // Same height (nothing bends or sinks), turned half round about the new root.
    expect(head.y).toBeCloseTo(restHead.y, 6);
    expect(head.x).toBeCloseTo(3 - restHead.x, 6);
    expect(head.z).toBeCloseTo(-2 - restHead.z, 6);

    hs.poseFromAnimation = true;
    hs.worldPosition = vec3(10, 0, 10);
    placeRestSkeleton(hs);
    expect(hs.ragdollBones.HEAD_CRANIUM.position.x).toBeCloseTo(3 - restHead.x, 6);
  });
});

describe('procedural cleanup: the sidearm rides the animated hand', () => {
  function setup(hs: TargetHealthState, drawClip: { state: string; progress: number } | null) {
    const root = new pc.Entity('combatant');
    const hand = new pc.Entity('Bone_HAND_RIGHT');
    root.addChild(hand);
    hand.setPosition(0.25, 1.35, 0.45);
    const holder = new pc.Entity('holder');
    const weaponRoot = new pc.Entity('pistol');
    holder.addChild(weaponRoot);
    const glb = {
      boneNodes: new Map([['HAND_RIGHT', hand]]),
      rootEntity: root,
      animComponent: drawClip
        ? { baseLayer: { activeState: drawClip.state, activeStateProgress: drawClip.progress } }
        : null,
    };
    const rig = {
      targetId: hs.targetId,
      holderEntity: holder,
      glbInstance: { rootEntity: weaponRoot },
      isGlbModel: true,
      attachmentState: createPropAttachmentState<'RIGHT' | 'LEFT'>('HIDDEN_TEMP'),
      wasHeldLastFrame: false,
      lastHand: null,
      clonedMaterials: [],
      cachedBoneEntities: new Map(),
    } as unknown as OffhandSidearmRig;
    const target = { healthState: hs, rootEntity: root, combatantGlb: glb } as unknown as GhoulMannequinEntity;
    return { rig, target, hand, holder, glb };
  }

  const provider = (drawing: boolean, progress = 1) => ({
    getSidearmVisualState: () => ({
      visible: true, drawing, drawProgress: progress, hand: 'RIGHT', dropped: false,
      aimTargetWorld: vec3(0, 1.5, 6), weaponId: 'silver_talon_50ae',
    }),
  }) as never;

  it('keeps the pistol holstered until the draw clip is 45 % through, then shows it in the fist', () => {
    const hs = createTargetHealthState('draw', 'Draw', vec3(0, 0, 0));
    const fx = { spawnDroppedWeaponProp: vi.fn() };
    const sync = new OffhandSidearmSync();
    const early = setup(hs, { state: 'PistolDraw', progress: 0.3 });
    expect(sync.sync(early.target, vec3(0, 1.6, 6), early.rig, provider(true, 0.9), fx as never, 1 / 60)).toBe(false);
    expect(early.rig.attachmentState).toMatchObject({ kind: 'HIDDEN_TEMP', hand: undefined });
    (early.glb.animComponent as { baseLayer: { activeStateProgress: number } }).baseLayer.activeStateProgress = 0.5;
    // The clip, not the armament timer, decides: the armament here says only 10 % drawn.
    expect(sync.sync(early.target, vec3(0, 1.6, 6), early.rig, provider(true, 0.1), fx as never, 1 / 60)).toBe(true);
    expect(early.rig.attachmentState).toMatchObject({ kind: 'ATTACHED', hand: 'RIGHT' });
    expect(fx.spawnDroppedWeaponProp).not.toHaveBeenCalled();
  });

  it('holds the gun rigidly in the hand and never writes the arm bones', () => {
    const hs = createTargetHealthState('rigid', 'Rigid', vec3(0, 0, 0));
    const { rig, target, hand, holder } = setup(hs, null);
    const handBefore = { ...hs.ragdollBones.HAND_RIGHT.position };
    const forearmBefore = { ...hs.ragdollBones.FOREARM_RIGHT.position };
    const sync = new OffhandSidearmSync();
    const relative = () => hand.getRotation().clone().invert().mul(holder.getRotation());
    expect(sync.sync(target, vec3(0, 1.6, 6), rig, provider(false), undefined, 1 / 60)).toBe(true);
    const first = relative();
    hand.setEulerAngles(20, -35, 10);
    hand.setPosition(0.1, 1.1, 0.3);
    expect(sync.sync(target, vec3(0, 1.6, 6), rig, provider(false), undefined, 1 / 60)).toBe(true);
    const second = relative();
    // Same rotation in the hand's frame, and the gun stays at the palm.
    expect(Math.abs(first.dot(second))).toBeGreaterThan(0.9999);
    expect(holder.getPosition().distance(hand.getPosition())).toBeLessThan(0.15);
    expect(hs.ragdollBones.HAND_RIGHT.position).toEqual(handBefore);
    expect(hs.ragdollBones.FOREARM_RIGHT.position).toEqual(forearmBefore);
  });

  it('keeps a face-down body holstered: it never shoots from the ground', () => {
    const hs = createTargetHealthState('facedown', 'FaceDown', vec3(0, 0, 0));
    hs.isRagdollActive = true;
    hs.posture = 'RAGDOLL_GROUNDED';
    const { rig, target } = setup(hs, null);
    const fx = { spawnDroppedWeaponProp: vi.fn() };
    const sync = new OffhandSidearmSync();
    for (let i = 0; i < 4; i++) {
      expect(sync.sync(target, vec3(0, 1.6, 6), rig, provider(false), fx as never, 1 / 60)).toBe(false);
    }
    expect(rig.attachmentState.kind).toBe('HIDDEN_TEMP');
    expect(fx.spawnDroppedWeaponProp).not.toHaveBeenCalled();
  });
});
