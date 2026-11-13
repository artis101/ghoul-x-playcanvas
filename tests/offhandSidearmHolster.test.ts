import { describe, expect, it, vi } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import { OffhandSidearmSync } from '../src/engine/combat/offhandSidearmSync.ts';
import type { OffhandSidearmRig } from '../src/engine/combat/offhandSidearmTypes.ts';
import { createPropAttachmentState } from '../src/engine/mannequin/propAttachmentState.ts';
import type { GhoulMannequinEntity } from '../src/engine/mannequin/ghoulMannequinEntity.ts';

describe('holstered backup sidearm', () => {
  it('stays in the holster while a downed body waits to draw, instead of dropping to the floor', () => {
    const hs = createTargetHealthState('holster', 'Holster', vec3(0, 0, 0));
    hs.isRagdollActive = true;
    hs.posture = 'RAGDOLL_GROUNDED';
    // A rig that once knew a hand (as after a previous sequence or the primary's drop) but whose
    // pistol has never been drawn.
    const rig = {
      attachmentState: createPropAttachmentState<'RIGHT' | 'LEFT'>('HIDDEN_TEMP'),
      lastHand: 'RIGHT',
      holderEntity: { enabled: false },
      glbInstance: null,
      wasHeldLastFrame: false,
    } as unknown as OffhandSidearmRig;
    const target = { healthState: hs } as unknown as GhoulMannequinEntity;
    const holstered = { getSidearmVisualState: () => ({ visible: false, hand: null }) } as never;
    const fx = { spawnDroppedWeaponProp: vi.fn() };
    const sync = new OffhandSidearmSync();
    for (let frame = 0; frame < 5; frame++) {
      expect(sync.sync(target, vec3(0, 1.6, 4), rig, holstered, fx as never)).toBe(false);
    }
    expect(rig.attachmentState.kind).toBe('HIDDEN_TEMP');
    expect(fx.spawnDroppedWeaponProp).not.toHaveBeenCalled();
  });
});
