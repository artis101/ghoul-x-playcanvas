import { describe, expect, it } from 'vitest';
import {
  adsFovDeg,
  adsSensitivityScale,
  aimSpreadRad,
  deflectWithinCone,
  easeAdsBlend,
  stepAdsProgress,
} from '../src/core/ballistics/aim/aimDownSights.ts';
import { rotateBySightQuat, solveAdsViewmodelPose } from '../src/core/ballistics/aim/sightAlignment.ts';
import { WEAPONS, WEAPON_ADS_PROFILES, getWeaponAdsProfile } from '../src/core/ballistics/weapons.ts';
import { add, dot, normalize } from '../src/core/ballistics/vec3.ts';

describe('aim down sights', () => {
  it('has a profile for every player weapon', () => {
    for (const weapon of WEAPONS) expect(WEAPON_ADS_PROFILES[weapon.id]).toBeDefined();
  });

  it('puts both sight points on the view axis with the rear sight at eye relief', () => {
    for (const weapon of WEAPONS) {
      const profile = getWeaponAdsProfile(weapon.id);
      const pose = solveAdsViewmodelPose(profile);
      const rear = add(pose.position, rotateBySightQuat(pose.rotation, profile.rearSightLocal));
      const front = add(pose.position, rotateBySightQuat(pose.rotation, profile.frontSightLocal));

      expect(rear.x).toBeCloseTo(0, 6);
      expect(rear.y).toBeCloseTo(0, 6);
      expect(rear.z).toBeCloseTo(-profile.eyeReliefM, 6);
      expect(front.x).toBeCloseTo(0, 6);
      expect(front.y).toBeCloseTo(0, 6);
      expect(front.z).toBeLessThan(rear.z);
    }
  });

  it('raises and lowers the weapon in the profile time with a smooth start and stop', () => {
    const profile = getWeaponAdsProfile('m4a1_carbine');
    let progress = 0;
    let elapsedS = 0;
    while (progress < 1) {
      progress = stepAdsProgress(progress, true, 1 / 120, profile);
      elapsedS += 1 / 120;
    }
    expect(elapsedS).toBeCloseTo(profile.aimInTimeS, 1);
    expect(stepAdsProgress(1, false, profile.aimOutTimeS, profile)).toBe(0);

    expect(easeAdsBlend(0)).toBe(0);
    expect(easeAdsBlend(1)).toBe(1);
    expect(easeAdsBlend(0.5)).toBeCloseTo(0.5, 6);
    expect(easeAdsBlend(0.05)).toBeLessThan(0.01);
  });

  it('zooms by the profile magnification and slows the look speed to match', () => {
    expect(adsFovDeg(68, 4, 0)).toBeCloseTo(68, 6);
    const scopedFov = adsFovDeg(68, 4, 1);
    expect(Math.tan((34 * Math.PI) / 180) / Math.tan((scopedFov * Math.PI) / 360)).toBeCloseTo(4, 6);
    expect(adsSensitivityScale(68, scopedFov)).toBeCloseTo(0.25, 6);
    expect(adsSensitivityScale(68, 68)).toBe(1);
  });

  it('fires exactly along the sights when aimed and inside the hip cone otherwise', () => {
    const profile = getWeaponAdsProfile('m4a1_carbine');
    const settledAimed = aimSpreadRad(profile, 1, 0, 0);
    expect(settledAimed).toBeGreaterThan(0);
    expect(settledAimed).toBeLessThan(0.001);
    // Walking and being hit open the cone even when aimed, but less than at the hip.
    expect(aimSpreadRad(profile, 1, 1, 0)).toBeGreaterThan(settledAimed * 3);
    expect(aimSpreadRad(profile, 1, 1, 0)).toBeLessThan(aimSpreadRad(profile, 0, 1, 0));
    expect(aimSpreadRad(profile, 1, 0, 0, 3)).toBeGreaterThan(settledAimed);

    const standing = aimSpreadRad(profile, 0, 0, 0);
    expect(standing).toBeCloseTo(profile.hipSpreadRad, 9);
    expect(aimSpreadRad(profile, 0, 1, 0)).toBeGreaterThan(standing);
    expect(aimSpreadRad(profile, 0, 1, 0)).toBeGreaterThan(standing * 3);
    expect(aimSpreadRad(profile, 0, 0, 4)).toBeGreaterThan(standing);

    const aim = normalize({ x: 0.3, y: 0.1, z: -1 });
    expect(dot(deflectWithinCone(aim, 0, 0.7, 0.2), aim)).toBeCloseTo(1, 9);
    for (let i = 0; i < 64; i++) {
      const fired = deflectWithinCone(aim, standing, (i + 0.5) / 64, (i * 0.618) % 1);
      expect(Math.acos(Math.min(1, dot(fired, aim)))).toBeLessThanOrEqual(standing + 1e-9);
    }
  });
});
