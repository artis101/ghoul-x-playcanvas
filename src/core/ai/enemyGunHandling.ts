import { WEAPON_MAP } from '../ballistics/weapons/weaponSpecs.ts';
import { fireCycleS, isFullAuto, weaponCapacity } from '../ballistics/weapons/weaponHandling.ts';

/**
 * Enemies run their guns by the same rules as the player: the same magazine, the same spare
 * rounds, the same cycle between shots, one shot per trigger pull unless the gun is full-auto,
 * and a reload that takes as long as the player's. What differs is only the trigger finger.
 */
export interface EnemyGunHandling {
  readonly weaponId: string;
  /** Shortest time between two shots the action allows. */
  readonly fireCycleS: number;
  readonly fullAuto: boolean;
  /** A bolt or pump gun that has to be worked by hand between shots. */
  readonly manualAction: boolean;
  readonly magCap: number;
  readonly reserve: number;
}

export interface EnemyMagazineState {
  readonly weaponId: string;
  readonly magCap: number;
  mag: number;
  reserve: number;
  /** Seconds left on the reload under way; 0 when none is. */
  reloadRemainingS: number;
}

/** The enemies' backup pistol: a 9 mm service sidearm, not one of the player's guns. */
const BACKUP_PISTOL_CYCLE_S = 0.2;
const MANUAL_ACTION_CYCLE_S = 0.6;

export function resolveEnemyGunHandling(weaponId: string): EnemyGunHandling {
  const spec = WEAPON_MAP[weaponId];
  const cap = weaponCapacity(weaponId);
  const cycleS = spec ? fireCycleS(spec) : BACKUP_PISTOL_CYCLE_S;
  return {
    weaponId,
    fireCycleS: cycleS,
    fullAuto: spec ? isFullAuto(spec) : false,
    manualAction: cycleS >= MANUAL_ACTION_CYCLE_S,
    magCap: cap.magCap,
    reserve: cap.reserve,
  };
}

export function createEnemyMagazine(handling: EnemyGunHandling): EnemyMagazineState {
  return {
    weaponId: handling.weaponId,
    magCap: handling.magCap,
    mag: handling.magCap,
    reserve: handling.reserve,
    reloadRemainingS: 0,
  };
}

export function isMagazineReloading(m: EnemyMagazineState): boolean {
  return m.reloadRemainingS > 0;
}

export function canFireFromMagazine(m: EnemyMagazineState): boolean {
  return m.mag > 0 && m.reloadRemainingS <= 0;
}

/** Nothing in the gun and nothing left to load into it. */
export function isMagazineDry(m: EnemyMagazineState): boolean {
  return m.mag <= 0 && m.reserve <= 0 && m.reloadRemainingS <= 0;
}

export function consumeMagazineRound(m: EnemyMagazineState): boolean {
  if (!canFireFromMagazine(m)) return false;
  m.mag -= 1;
  return true;
}

/** Starts a reload; false when the magazine is full, nothing is left, or one is under way. */
export function beginMagazineReload(m: EnemyMagazineState, durationS: number): boolean {
  if (m.reloadRemainingS > 0 || m.mag >= m.magCap || m.reserve <= 0) return false;
  m.reloadRemainingS = Math.max(0.01, durationS);
  return true;
}

/** Counts a reload down; returns true on the frame the rounds go in. */
export function stepMagazineReload(m: EnemyMagazineState, dt: number): boolean {
  if (m.reloadRemainingS <= 0) return false;
  m.reloadRemainingS = Math.max(0, m.reloadRemainingS - dt);
  if (m.reloadRemainingS > 0) return false;
  const loaded = Math.min(m.magCap - m.mag, m.reserve);
  m.mag += loaded;
  m.reserve -= loaded;
  return true;
}

/** Out of contact with a half-empty gun, a fighter tops it up rather than wait to run dry. */
export function wantsTacticalReload(m: EnemyMagazineState): boolean {
  return m.reloadRemainingS <= 0 && m.reserve > 0 && m.mag < m.magCap * 0.5;
}

function unit01(seed: number): number {
  const h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/**
 * How many rounds the next trigger sequence fires. A rifle on full-auto gets a short held burst;
 * a pistol gets one to three deliberate pulls; a bolt or pump gun one shot, sometimes a quick
 * follow-up from the pump. `extraShots` comes from a wound-maddened or panicking shooter.
 */
export function planVolleyShots(h: EnemyGunHandling, seed: number, extraShots = 0): number {
  const r = unit01(seed);
  let shots: number;
  if (h.fullAuto) shots = 3 + Math.floor(r * 4);
  else if (h.fireCycleS >= 1.5) shots = 1;
  else if (h.manualAction) shots = r < 0.35 ? 2 : 1;
  else shots = 1 + Math.floor(r * 3);
  const extra = h.fireCycleS >= 1.5 ? 0 : h.manualAction ? Math.min(1, extraShots) : extraShots;
  return Math.max(1, shots + Math.max(0, extra));
}

/**
 * Time to the next round of a volley. A full-auto gun fires at its cyclic rate while the
 * trigger is held; every other gun is pulled again once the shooter has the sights back on,
 * never faster than the action cycles.
 */
export function nextVolleyShotDelayS(h: EnemyGunHandling, seed: number, reaimScale = 1): number {
  if (h.fullAuto) return h.fireCycleS;
  const reaimS = (0.08 + unit01(seed) * 0.22) * Math.max(0, reaimScale);
  return h.fireCycleS + reaimS;
}

/**
 * Share of a full buckshot load's damage that still lands on the player at `rangeM`: the whole
 * load inside 6 m, falling to under a third by 25 m as the pattern opens and the pellets slow,
 * matching how the player's own buckshot loses its punch downrange. Other guns are unaffected.
 */
export function enemyShotDamageScaleAtRange(weaponId: string, rangeM: number): number {
  if (weaponId !== 'm590_shotgun') return 1;
  const t = Math.min(1, Math.max(0, (rangeM - 6) / (25 - 6)));
  return 1 - 0.7 * t;
}
