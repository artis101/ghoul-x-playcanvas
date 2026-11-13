import { describe, expect, it } from 'vitest';
import {
  absorbPlayerPullDown,
  createRecoilClimbState,
  creditClimb,
  kickRecoilClimb,
  stepRecoilClimb,
} from '../src/core/ballistics/weapons/recoilClimb.ts';

const M4 = 'm4a1_carbine';
const DEAGLE = 'silver_talon_50ae';

/** Fires `shots` rounds at `intervalS`, stepping in 1/60 s frames; returns the total climb. */
function spray(weaponId: string, shots: number, intervalS: number, adsBlend: number): number {
  const state = createRecoilClimbState();
  let pitch = 0;
  for (let i = 0; i < shots; i++) {
    const kick = kickRecoilClimb(state, weaponId, adsBlend, 0.5);
    pitch += kick.pitchDeg;
    creditClimb(state, kick.pitchDeg);
    for (let t = 0; t < intervalS; t += 1 / 60) pitch -= stepRecoilClimb(state, 1 / 60);
  }
  return pitch;
}

describe('recoil climb', () => {
  it('ramps the M4 burst up from a gentle first shot', () => {
    const state = createRecoilClimbState();
    const first = kickRecoilClimb(state, M4, 0, 0.5).pitchDeg;
    kickRecoilClimb(state, M4, 0, 0.5);
    kickRecoilClimb(state, M4, 0, 0.5);
    const fourth = kickRecoilClimb(state, M4, 0, 0.5).pitchDeg;
    expect(fourth).toBeGreaterThan(first * 2.5);
  });

  it('climbs a held-down M4 magazine well off the target, aimed or not', () => {
    const interval = 60 / 750;
    expect(spray(M4, 30, interval, 1)).toBeGreaterThan(10);
    expect(spray(M4, 30, interval, 0)).toBeGreaterThan(spray(M4, 30, interval, 1));
  });

  it('throws the .50 AE up hard every shot, and quick follow-ups land high', () => {
    const state = createRecoilClimbState();
    expect(kickRecoilClimb(state, DEAGLE, 1, 0.5).pitchDeg).toBeGreaterThan(3);
    expect(spray(DEAGLE, 4, 60 / 180, 1)).toBeGreaterThan(5);
  });

  it('brings back only part of the climb once the trigger is let go', () => {
    const state = createRecoilClimbState();
    let pitch = 0;
    for (let i = 0; i < 10; i++) {
      const k = kickRecoilClimb(state, M4, 0, 0.5);
      pitch += k.pitchDeg;
      creditClimb(state, k.pitchDeg);
      pitch -= stepRecoilClimb(state, 0.08);
    }
    const peak = pitch;
    for (let i = 0; i < 300; i++) pitch -= stepRecoilClimb(state, 1 / 60);
    expect(pitch).toBeLessThan(peak);
    expect(pitch).toBeGreaterThan(peak * 0.5);
  });

  it('does not pull the view down again after the player already did', () => {
    const state = createRecoilClimbState();
    const k = kickRecoilClimb(state, DEAGLE, 0, 0.5);
    creditClimb(state, k.pitchDeg);
    absorbPlayerPullDown(state, 10);
    let pulled = 0;
    for (let i = 0; i < 120; i++) pulled += stepRecoilClimb(state, 1 / 60);
    expect(pulled).toBe(0);
  });
});
