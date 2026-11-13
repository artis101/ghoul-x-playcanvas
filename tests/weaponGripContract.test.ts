import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LONG_GUN_TRIGGER_HAND_EULER_X, M4A1_PALM_OFFSET_X, TRIGGER_GRIPS, TRIGGER_PALM_ALONG_HAND_M,
} from '../src/engine/mannequin/combatantWeaponGrip.ts';

/**
 * The Blender grip pass bakes the hands onto the guns through `weapon_grips.json`; the runtime
 * glues the guns back into those hands through its own constants. They must be the same numbers,
 * or a baked grip and the gun the game draws drift apart.
 */
const grips = JSON.parse(fs.readFileSync(path.resolve('scripts/blender/weapon_grips.json'), 'utf8'));

describe('weapon grip contract', () => {
  it('glues long guns into the hand the grip pass baked', () => {
    const m4 = TRIGGER_GRIPS.m4a1_carbine;
    expect([m4.x + M4A1_PALM_OFFSET_X, m4.y, m4.z]).toEqual(grips.long_gun.trigger_point);
    expect(LONG_GUN_TRIGGER_HAND_EULER_X).toBe(grips.long_gun.trigger_hand_euler_x);
    expect(TRIGGER_PALM_ALONG_HAND_M).toBe(grips.palm_along_hand_m.trigger);
  });

  it('seats the pistol on the trigger point the grip pass baked', () => {
    const pistol = TRIGGER_GRIPS.silver_talon_50ae;
    expect([pistol.x, pistol.y, pistol.z]).toEqual(grips.pistol.trigger_point);
  });
});
