import type * as pc from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import type { EnemyArchetypeId } from '../src/contracts/ballistics.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import { COMBATANT_ANIMATION_CLIPS, isLoopingClip } from '../src/engine/assets/glbLoader.ts';
import { CombatantAnimController } from '../src/engine/mannequin/combatantAnimController.ts';
import { canAimFrom, canMoveFrom, upperClipFor } from '../src/engine/mannequin/combatantStandingClips.ts';
import { isUpperBodyClipName } from '../src/engine/mannequin/combatantUpperBodyLayer.ts';
import {
  gunKindOf, heldWeaponPose, isOneHandPistolClip, primaryAimPose, weaponPoseFor,
} from '../src/engine/mannequin/combatantWeaponPoseMap.ts';

const body = (archetype: EnemyArchetypeId, southpaw = false) =>
  createTargetHealthState('pose', 'Pose', vec3(), 0, archetype, southpaw);

describe('weapon pose map', () => {
  it('holds the long guns as they are, whatever the arms', () => {
    for (const works of [true, false]) {
      expect(weaponPoseFor('LONG_GUN', works)).toEqual({ carry: 'CombatReadyIdle', aim: 'LongGunAim', twoHanded: true });
    }
    expect(gunKindOf('m4a1_carbine')).toBe('LONG_GUN');
    expect(gunKindOf('m590_shotgun')).toBe('LONG_GUN');
    expect(gunKindOf('msg90_sniper')).toBe('LONG_GUN');
  });

  it('holds a pistol in both hands while both arms work, and in one extended arm once the support arm is out', () => {
    expect(gunKindOf('silver_talon_50ae')).toBe('PISTOL');
    expect(weaponPoseFor('PISTOL', true)).toEqual({ carry: 'CombatReadyIdle', aim: 'PistolAim', twoHanded: true });
    expect(weaponPoseFor('PISTOL', false)).toEqual({ carry: 'PistolOneHandHold', aim: 'PistolAimOneHand', twoHanded: false });
  });

  it('reads the Desert Eagle primary, the backup pistol and the long gun off the health state', () => {
    const punk = body('SKINHEAD_PUNK');
    expect(heldWeaponPose(punk)?.aim).toBe('PistolAim');
    expect(primaryAimPose(punk)).toEqual({ clip: 'PistolAim' });
    punk.leftArmFunctional = false;
    expect(heldWeaponPose(punk)?.carry).toBe('PistolOneHandHold');
    expect(primaryAimPose(punk)).toEqual({ clip: 'PistolAimOneHand' });
    punk.weaponDropped = true;
    expect(heldWeaponPose(punk)).toBeNull();
    expect(primaryAimPose(punk)).toBeUndefined();

    // A southpaw's support arm is the right one; a severed one counts as gone.
    const lefty = body('SKINHEAD_PUNK', true);
    lefty.severedZones.add('FOREARM_RIGHT');
    expect(heldWeaponPose(lefty)?.aim).toBe('PistolAimOneHand');

    const gunner = body('MILITIA_GUNNER');
    gunner.leftArmFunctional = false;
    expect(primaryAimPose(gunner)).toEqual({ clip: 'LongGunAim' });
    expect(heldWeaponPose(gunner)?.carry).toBe('CombatReadyIdle');

    // A drawn backup pistol follows the same map, by the hand it is in.
    const enforcer = body('HEAVY_ENFORCER');
    enforcer.weaponDropped = true;
    expect(heldWeaponPose(enforcer, 'RIGHT')?.aim).toBe('PistolAim');
    enforcer.leftArmFunctional = false;
    expect(heldWeaponPose(enforcer, 'RIGHT')?.aim).toBe('PistolAimOneHand');
  });

  it('knows which clips hold the pistol in one hand', () => {
    expect(isOneHandPistolClip('PistolOneHandHold_Southpaw')).toBe(true);
    expect(isOneHandPistolClip('PistolAimOneHand')).toBe(true);
    expect(isOneHandPistolClip('KneelPistolAimOneHand')).toBe(true);
    expect(isOneHandPistolClip('PistolAim')).toBe(false);
    expect(isOneHandPistolClip('CombatReadyIdle')).toBe(false);
    expect(isOneHandPistolClip(undefined)).toBe(false);
  });

  it('lists the one-handed carry as a looping handed clip the upper layer can play', () => {
    expect(COMBATANT_ANIMATION_CLIPS).toContain('PistolOneHandHold');
    expect(isLoopingClip('PistolOneHandHold')).toBe(true);
    expect(isLoopingClip('PistolOneHandHold_Southpaw')).toBe(true);
    expect(isUpperBodyClipName('PistolOneHandHold_Southpaw')).toBe(true);
    expect(canAimFrom('PistolOneHandHold')).toBe(true);
    expect(canMoveFrom('PistolOneHandHold')).toBe(true);
  });

  it('puts the same map on the upper layer while walking', () => {
    // Two hands: the gait carries the gun until it aims, then the two-handed aim goes up top.
    expect(upperClipFor('CombatReadyIdle', 'Walk', undefined)).toBeNull();
    expect(upperClipFor('CombatReadyIdle', 'Walk', 'PistolAim')).toBe('PistolAim');
    expect(upperClipFor('CombatReadyIdle', 'Walk', 'LongGunAim')).toBe('LongGunAim');
    // One hand: the gait's arms would hold a forend, so the one-handed carry or aim goes up top.
    expect(upperClipFor('PistolOneHandHold', 'Walk', undefined)).toBe('PistolOneHandHold');
    expect(upperClipFor('PistolOneHandHold', 'StrafeLeft', 'PistolAimOneHand')).toBe('PistolAimOneHand');
  });

  it('plays the carry and aim for the gun in hand, mirrored for the gun hand', () => {
    const controller = new CombatantAnimController();
    const playClip = vi.fn(() => true);
    const glb = { animComponent: { playing: true, speed: 1 } as pc.AnimComponent, playClip };
    const punk = body('SKINHEAD_PUNK');
    controller.syncAnimation(glb, punk);
    expect(playClip).toHaveBeenLastCalledWith('CombatReadyIdle', 0.12, 1, false);
    controller.syncAnimation(glb, punk, false, undefined, primaryAimPose(punk));
    expect(playClip).toHaveBeenLastCalledWith('PistolAim', 0.12, 1, false);
    punk.leftArmFunctional = false;
    controller.syncAnimation(glb, punk);
    expect(playClip).toHaveBeenLastCalledWith('PistolOneHandHold', 0.12, 1, false);
    controller.syncAnimation(glb, punk, false, undefined, primaryAimPose(punk));
    expect(playClip).toHaveBeenLastCalledWith('PistolAimOneHand', 0.12, 1, false);

    const lefty = body('SKINHEAD_PUNK', true);
    lefty.rightArmFunctional = false;
    const southpaw = new CombatantAnimController();
    southpaw.syncAnimation(glb, lefty);
    expect(playClip).toHaveBeenLastCalledWith('PistolOneHandHold', 0.12, 1, true);

    // A rifleman with a dead support arm still carries and aims the rifle as before.
    const gunner = body('MILITIA_GUNNER');
    gunner.leftArmFunctional = false;
    const rifle = new CombatantAnimController();
    rifle.syncAnimation(glb, gunner, false, undefined, primaryAimPose(gunner));
    expect(playClip).toHaveBeenLastCalledWith('LongGunAim', 0.12, 1, false);
    expect(rifle.resolveDesiredClip(gunner)).toBe('CombatReadyIdle');
  });

  it('falls back to the shared carry on a GLB without the one-handed hold', () => {
    const punk = body('SKINHEAD_PUNK');
    punk.leftArmFunctional = false;
    const controller = new CombatantAnimController();
    expect(controller.resolveDesiredClip(punk, false, new Set(['CombatReadyIdle']))).toBe('CombatReadyIdle');
    expect(controller.resolveDesiredClip(punk, true)).toBe('UnsuspectingIdle');
  });
});
