import type { AiBarkCategory, BrutalKillRewardKind } from '../../contracts/ai/aiContracts.ts';
import type { EnemyArchetypeId, Vec3Like } from '../../contracts/ballistics.ts';

export type TacticalResolveKind =
  | 'HARDENED_VETERAN'
  | 'FANATIC_BERSERKER'
  | 'GRITTY_REGULAR'
  | 'PANICKED_SCRAPPER';

export type AlertedEngagementSubstate =
  | 'CLUTCHING_RETREAT'
  | 'BERSERKER_CHARGE'
  | 'FLANKING_RUSH'
  | 'JUGGERNAUT_PRESS'
  | 'SNIPER_SNAP_PEEK'
  | 'EVASIVE_BACKPEDAL'
  | 'PANIC_SCRAMBLE'
  | 'COVER_SHELTER'
  | 'COVER_PEEK';

export interface TacticalDoctrineInput {
  readonly archetype: EnemyArchetypeId;
  readonly resolveProfile: TacticalResolveKind;
  readonly clutchingWound: boolean;
  readonly isWounded: boolean;
  readonly cyclePhase01: number;
  readonly playerDistanceM: number;
  readonly hasChestArmor: boolean;
  readonly chestArmorIntegrity: number;
  readonly primaryWeaponIntact: boolean;
  readonly suppression: number;
  readonly moraleShockTimerS: number;
  readonly berserkerFrenzyTimerS: number;
  readonly anchorBlockedByCover: boolean;
}

export interface CoverStationCandidate {
  readonly stationId: string;
  readonly coverAnchorWorld: Vec3Like;
  readonly peekSign: -1 | 1;
  readonly peekStrideM: number;
}

export interface WitnessedBrutalityReaction {
  readonly nextAdrenaline: number;
  readonly nextSuppression: number;
  readonly moraleShockTimerS: number;
  readonly berserkerFrenzyTimerS: number;
  readonly staggerDurationS: number;
  readonly flipPeekSign: boolean;
  readonly barkCategory: AiBarkCategory | null;
}

export function isBrutalFeatKind(kind: BrutalKillRewardKind): boolean {
  return kind !== 'STANDARD_KILL';
}

export function evaluateTacticalEngagementSubstate(
  input: TacticalDoctrineInput
): AlertedEngagementSubstate {
  if (input.clutchingWound) {
    return 'CLUTCHING_RETREAT';
  }

  if (
    input.resolveProfile === 'FANATIC_BERSERKER' &&
    (input.isWounded || input.berserkerFrenzyTimerS > 0)
  ) {
    return 'BERSERKER_CHARGE';
  }

  if (
    input.resolveProfile === 'PANICKED_SCRAPPER' &&
    (input.moraleShockTimerS > 0 || (input.isWounded && input.suppression > 0.72))
  ) {
    return 'PANIC_SCRAMBLE';
  }

  if (input.archetype === 'SNIPER_OPERATIVE') {
    if (input.primaryWeaponIntact && !input.anchorBlockedByCover && input.playerDistanceM < 8.8) {
      return 'EVASIVE_BACKPEDAL';
    }
    return input.cyclePhase01 >= 0.34 && input.cyclePhase01 <= 0.76
      ? 'SNIPER_SNAP_PEEK'
      : 'COVER_SHELTER';
  }

  if (
    input.archetype === 'HEAVY_ENFORCER' &&
    input.primaryWeaponIntact &&
    input.hasChestArmor &&
    input.chestArmorIntegrity > 0.35 &&
    input.suppression < 0.72 &&
    !input.anchorBlockedByCover &&
    input.playerDistanceM > 4.8
  ) {
    return 'JUGGERNAUT_PRESS';
  }

  if (
    input.archetype === 'SKINHEAD_PUNK' &&
    input.resolveProfile === 'FANATIC_BERSERKER' &&
    !input.anchorBlockedByCover &&
    input.playerDistanceM > 4.2
  ) {
    return 'FLANKING_RUSH';
  }

  return input.cyclePhase01 >= 0.2 && input.cyclePhase01 <= 0.88
    ? 'COVER_PEEK'
    : 'COVER_SHELTER';
}

export function computeMoraleSpreadMultiplier(moraleShockTimerS: number): number {
  if (moraleShockTimerS <= 0) return 1.0;
  const normalized = Math.min(1.0, moraleShockTimerS / 2.2);
  return 1.0 + normalized * 0.58;
}

export function evaluateWitnessedBrutalityReaction(
  resolveProfile: TacticalResolveKind,
  kind: BrutalKillRewardKind,
  witnessDistanceM: number,
  currentAdrenaline: number,
  currentSuppression: number
): WitnessedBrutalityReaction | null {
  if (!isBrutalFeatKind(kind) || witnessDistanceM > 18.5) {
    return null;
  }

  const intensityBonus =
    kind === 'DECAPITATION' || kind === 'CRANIAL_POP' || kind === 'MULTI_KILL_BLAST'
      ? 1.18
      : 1.0;

  switch (resolveProfile) {
    case 'PANICKED_SCRAPPER':
      return {
        nextAdrenaline: Math.max(currentAdrenaline, 0.95),
        nextSuppression: 1.0,
        moraleShockTimerS: 3.1 * intensityBonus,
        berserkerFrenzyTimerS: 0,
        staggerDurationS: witnessDistanceM <= 14.0 ? 0.48 : 0.22,
        flipPeekSign: true,
        barkCategory: 'HORROR_SHOCK',
      };

    case 'GRITTY_REGULAR':
      return {
        nextAdrenaline: Math.max(currentAdrenaline, 0.9),
        nextSuppression: Math.min(1.0, currentSuppression + 0.55 * intensityBonus),
        moraleShockTimerS: 1.45 * intensityBonus,
        berserkerFrenzyTimerS: 0,
        staggerDurationS: witnessDistanceM <= 11.0 ? 0.28 : 0,
        flipPeekSign: true,
        barkCategory: 'HORROR_SHOCK',
      };

    case 'FANATIC_BERSERKER':
      return {
        nextAdrenaline: 1.0,
        nextSuppression: 0,
        moraleShockTimerS: 0,
        berserkerFrenzyTimerS: 4.6 * intensityBonus,
        staggerDurationS: 0,
        flipPeekSign: false,
        barkCategory: 'BERSERKER_CHARGE',
      };

    case 'HARDENED_VETERAN':
      return {
        nextAdrenaline: Math.max(currentAdrenaline, 0.94),
        nextSuppression: Math.min(1.0, currentSuppression + 0.22),
        moraleShockTimerS: 0,
        berserkerFrenzyTimerS: 0,
        staggerDurationS: 0,
        flipPeekSign: true,
        barkCategory: 'TACTICAL_CALLOUT',
      };
  }
}

export function selectCoverRelocationStation(
  currentAnchor: Vec3Like,
  occupiedAnchors: readonly Vec3Like[],
  stations: readonly CoverStationCandidate[]
): CoverStationCandidate | null {
  let bestStation: CoverStationCandidate | null = null;
  let bestDist = 8.2;

  for (const st of stations) {
    const dx = st.coverAnchorWorld.x - currentAnchor.x;
    const dz = st.coverAnchorWorld.z - currentAnchor.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.6 || dist > bestDist) continue;
    // Relocate laterally or to deeper fallback cover, never charging forward into open lanes
    if (st.coverAnchorWorld.z > currentAnchor.z + 0.6) continue;

    let occupied = false;
    for (const occ of occupiedAnchors) {
      if (Math.hypot(st.coverAnchorWorld.x - occ.x, st.coverAnchorWorld.z - occ.z) < 1.4) {
        occupied = true;
        break;
      }
    }
    if (occupied) continue;

    bestDist = dist;
    bestStation = st;
  }

  return bestStation;
}
