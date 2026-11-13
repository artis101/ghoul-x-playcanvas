import type { TargetHealthState } from '../../contracts/ballistics/targetHealthContracts.ts';

/**
 * Fortitude: how much grit a combatant has left to keep fighting once it is badly hurt
 * (docs/wound-movement.md). It is rolled once per combatant, then weighed down by lost health and
 * fading consciousness at the moment a choice is made.
 */

type ResolveProfile = NonNullable<TargetHealthState['resolveProfile']>;

const BASE_BY_PROFILE: Readonly<Record<ResolveProfile, number>> = {
  FANATIC_BERSERKER: 0.9,
  HARDENED_VETERAN: 0.75,
  GRITTY_REGULAR: 0.5,
  PANICKED_SCRAPPER: 0.25,
};
/** A combatant with no resolve profile is an ordinary regular. */
const DEFAULT_BASE = 0.5;
/** Two regulars should not act alike, so each gets a fixed nudge either way. */
const JITTER = 0.1;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Turns a target id into a steady number in [0, 1). The same combatant always gets the same
 * nudge, so replays and previews stay repeatable and nothing depends on Math.random.
 */
function hashUnit(id: string): number {
  // FNV-1a over the UTF-16 code units, then folded to a fraction.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/**
 * The combatant's own fortitude, 0..1. Rolled from its resolve profile plus a per-id nudge the
 * first time it is asked for, then kept in `hs.fortitude` so it never changes. A value already
 * stored (for example a Character Lab override) is left as it is.
 */
export function rollFortitude(hs: TargetHealthState): number {
  if (hs.fortitude !== undefined) return hs.fortitude;
  const base = hs.resolveProfile ? BASE_BY_PROFILE[hs.resolveProfile] : DEFAULT_BASE;
  const jitter = (hashUnit(hs.targetId) * 2 - 1) * JITTER;
  hs.fortitude = clamp01(base + jitter);
  return hs.fortitude;
}

/**
 * Fortitude as it stands right now: a body with half its health left has three quarters of its
 * grit, and a fading mind drags it down further.
 */
export function effectiveFortitude(hs: TargetHealthState): number {
  const base = rollFortitude(hs);
  const hpFraction = hs.maxHp > 0 ? clamp01(hs.currentHp / hs.maxHp) : 0;
  return base * (0.5 + 0.5 * hpFraction) * clamp01(hs.consciousness);
}
