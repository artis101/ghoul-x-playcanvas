import { describe, expect, it } from 'vitest';
import {
  beginMagazineReload,
  consumeMagazineRound,
  enemyShotDamageScaleAtRange,
  createEnemyMagazine,
  isMagazineDry,
  nextVolleyShotDelayS,
  planVolleyShots,
  resolveEnemyGunHandling,
  stepMagazineReload,
  wantsTacticalReload,
} from '../src/core/ai/enemyGunHandling.ts';
import { WEAPON_MAP } from '../src/core/ballistics/weapons.ts';
import { fireCycleS, isFullAuto, weaponCapacity } from '../src/core/ballistics/weapons/weaponHandling.ts';

describe('enemy guns run by the player rules', () => {
  it('uses the player magazine, reserve, cycle and fire mode for every shared gun', () => {
    for (const spec of Object.values(WEAPON_MAP)) {
      const h = resolveEnemyGunHandling(spec.id);
      expect(h.magCap).toBe(weaponCapacity(spec.id).magCap);
      expect(h.reserve).toBe(weaponCapacity(spec.id).reserve);
      expect(h.fireCycleS).toBeCloseTo(fireCycleS(spec));
      expect(h.fullAuto).toBe(isFullAuto(spec));
    }
  });

  it('only the carbine is full-auto', () => {
    expect(resolveEnemyGunHandling('m4a1_carbine').fullAuto).toBe(true);
    for (const id of ['silver_talon_50ae', 'm590_shotgun', 'msg90_sniper']) {
      expect(resolveEnemyGunHandling(id).fullAuto).toBe(false);
    }
  });

  it('never fires faster than the action cycles', () => {
    for (const id of ['silver_talon_50ae', 'm590_shotgun', 'msg90_sniper', 'm4a1_carbine']) {
      const h = resolveEnemyGunHandling(id);
      for (let seed = 0; seed < 50; seed++) {
        expect(nextVolleyShotDelayS(h, seed, 0.5)).toBeGreaterThanOrEqual(h.fireCycleS);
      }
    }
    // Pump and bolt guns are worked between every shot.
    expect(nextVolleyShotDelayS(resolveEnemyGunHandling('m590_shotgun'), 3)).toBeGreaterThanOrEqual(0.8);
    expect(nextVolleyShotDelayS(resolveEnemyGunHandling('msg90_sniper'), 3)).toBeGreaterThanOrEqual(2.0);
  });

  it('plans held bursts for the carbine and single aimed pulls for the bolt gun', () => {
    const m4 = resolveEnemyGunHandling('m4a1_carbine');
    const bolt = resolveEnemyGunHandling('msg90_sniper');
    const pistol = resolveEnemyGunHandling('silver_talon_50ae');
    for (let seed = 0; seed < 50; seed++) {
      expect(planVolleyShots(m4, seed)).toBeGreaterThanOrEqual(3);
      expect(planVolleyShots(bolt, seed, 3)).toBe(1);
      const pulls = planVolleyShots(pistol, seed);
      expect(pulls).toBeGreaterThanOrEqual(1);
      expect(pulls).toBeLessThanOrEqual(3);
    }
  });

  it('empties the magazine, reloads from reserve, and finally runs dry', () => {
    const m = createEnemyMagazine(resolveEnemyGunHandling('silver_talon_50ae'));
    expect(m.mag).toBe(7);
    let fired = 0;
    for (;;) {
      while (consumeMagazineRound(m)) fired++;
      if (!beginMagazineReload(m, 0.9)) break;
      expect(consumeMagazineRound(m)).toBe(false);
      expect(stepMagazineReload(m, 0.5)).toBe(false);
      expect(stepMagazineReload(m, 0.5)).toBe(true);
    }
    expect(fired).toBe(7 + 35);
    expect(isMagazineDry(m)).toBe(true);
  });

  it('tops up a half-spent magazine but not a nearly full one', () => {
    const m = createEnemyMagazine(resolveEnemyGunHandling('m4a1_carbine'));
    for (let i = 0; i < 5; i++) consumeMagazineRound(m);
    expect(wantsTacticalReload(m)).toBe(false);
    for (let i = 0; i < 12; i++) consumeMagazineRound(m);
    expect(wantsTacticalReload(m)).toBe(true);
    beginMagazineReload(m, 0.9);
    stepMagazineReload(m, 1);
    expect(m.mag).toBe(30);
    expect(m.reserve).toBe(120 - 17);
  });

  it('enemy buckshot loses its punch downrange; rifles do not', () => {
    expect(enemyShotDamageScaleAtRange('m590_shotgun', 4)).toBe(1);
    expect(enemyShotDamageScaleAtRange('m590_shotgun', 25)).toBeLessThan(0.35);
    expect(enemyShotDamageScaleAtRange('m4a1_carbine', 40)).toBe(1);
  });
});
