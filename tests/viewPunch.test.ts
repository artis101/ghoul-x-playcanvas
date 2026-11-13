import { describe, expect, it } from 'vitest';
import { addPunchImpulse, createViewPunch, hitFlinch, stepViewPunch } from '../src/core/ballistics/weapons/viewPunch.ts';

describe('viewPunch', () => {
  it('kicks then settles back to rest', () => {
    const s = createViewPunch();
    addPunchImpulse(s, 100, -80, 120, 40);
    let peak = 0;
    for (let i = 0; i < 20; i++) { stepViewPunch(s, 1 / 60); peak = Math.max(peak, s.pitch.value); }
    expect(peak).toBeGreaterThan(1);
    for (let i = 0; i < 120; i++) stepViewPunch(s, 1 / 60);
    expect(Math.abs(s.pitch.value)).toBeLessThan(0.01);
    expect(Math.abs(s.roll.value)).toBeLessThan(0.01);
  });

  it('stays bounded under stacked hits and long frames', () => {
    const s = createViewPunch();
    for (let i = 0; i < 50; i++) addPunchImpulse(s, 500, 500, 500, 500);
    stepViewPunch(s, 0.5);
    expect(Math.abs(s.pitch.value)).toBeLessThanOrEqual(9);
    expect(Math.abs(s.fov.value)).toBeLessThanOrEqual(6);
  });

  it('flinches away from the side the shot came from and harder for bigger damage', () => {
    const fromRight = hitFlinch(1, 0.5, 0.5, 0.5);
    const fromLeft = hitFlinch(-1, 0.5, 0.5, 0.5);
    expect(fromRight.aimYawDeg).toBeLessThan(0);
    expect(fromLeft.aimYawDeg).toBeGreaterThan(0);
    expect(hitFlinch(0, 1, 0.5, 0.5).aimPitchDeg).toBeGreaterThan(hitFlinch(0, 0, 0.5, 0.5).aimPitchDeg);
  });
});
