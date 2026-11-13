import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { PHYSIOLOGY_CONSTANTS } from '../../contracts/physiology/physiologyConstants.ts';
import {
  createWeaponSwayState,
  kickWeaponSway,
  noteAimRaised,
  recoilKickForWeapon,
  sampleWeaponSway,
  type SwayHold,
  type SwayPosture,
  type WeaponSwayConditions,
  type WeaponSwayOffset,
  type WeaponSwayState,
} from '../../core/ai/weaponSway.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';
import { ARCHETYPE_TUNING } from './archetypeTuning.ts';
import { isArmChainIntactAndFunctional } from './combatantArmEvaluation.ts';
import type { EnemyAimProfile, EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import { currentWoundedPhase, isKneelingPhase } from './woundedSequenceDriver.ts';

/**
 * Per-combatant weapon sway for the running game. The AI refreshes each combatant's conditions
 * and the shared clock while it aims; the shot path and the weapon pose then read the same offset
 * at the same time, so the bullet leaves along the barrel the player sees.
 */

interface SwayEntry {
  /** The AI agent this entry belongs to; a new agent under the same id starts afresh. */
  owner: EnemyAiAgentRuntime | null;
  readonly state: WeaponSwayState;
  conditions: WeaponSwayConditions;
}

const ZERO: Readonly<WeaponSwayOffset> = { yawRad: 0, pitchRad: 0 };
const entries = new Map<string, SwayEntry>();
// The AI's own clock, so sway slows and pauses with the game rather than with the wall clock.
let clockS = 0;

/** Sets the sway clock. The AI calls it with its elapsed time every tick it aims. */
export function setEnemySwayClock(nowS: number): void {
  if (Number.isFinite(nowS)) clockS = nowS;
}

export function enemySwayClockS(): number {
  return clockS;
}

/** How the gun is held for sway purposes. */
export function resolveSwayHold(hs: TargetHealthState, aimProfile: EnemyAimProfile): SwayHold {
  const pistol = aimProfile.usingBackupSidearm || ARCHETYPE_TUNING[hs.archetype].primaryWeaponId === 'silver_talon_50ae';
  if (!pistol) return 'RIFLE_SHOULDERED';
  const hand = aimProfile.activeFiringHand ?? 'RIGHT';
  const support = hand === 'RIGHT' ? 'LEFT' : 'RIGHT';
  // Seated and downed bodies hold the pistol out in one hand (the other props the body up), and
  // the visual sidearm path uses the one-hand sway for them, so the shot must too.
  const posture = resolveSwayPosture(hs);
  const downedOrSeated = isSeatedAnimated(hs) || posture === 'SEATED' || posture === 'LYING';
  const oneHand =
    aimProfile.isOneHandedDownedFire ||
    hs.isRagdollActive ||
    downedOrSeated ||
    !isArmChainIntactAndFunctional(hs, support);
  return oneHand ? 'PISTOL_ONE_HAND' : 'PISTOL_TWO_HAND';
}

/** Where the body is: seated last stand, lying in the ragdoll, on one knee or on its feet. */
export function resolveSwayPosture(hs: TargetHealthState, agent?: EnemyAiAgentRuntime): SwayPosture {
  const phase = currentWoundedPhase(hs);
  if (hs.isRagdollActive || agent?.state === 'DOWNED_CRAWLING' || phase === 'DOWNED_CRAWL' || phase === 'FACE_DOWN') {
    return 'LYING';
  }
  if (phase === 'DOWNED_ENGAGE' || phase === 'DOWNED_AGONY' || phase === 'SIT_DOWN') return 'SEATED';
  if (isKneelingPhase(hs)) return 'KNEELING';
  return 'STANDING';
}

export function buildEnemySwayConditions(
  hs: TargetHealthState,
  hold: SwayHold,
  agent?: EnemyAiAgentRuntime,
): WeaponSwayConditions {
  const baseline = PHYSIOLOGY_CONSTANTS.BASELINE_BLOOD_VOLUME_ML;
  return {
    hold,
    posture: resolveSwayPosture(hs, agent),
    painShock: hs.painShock,
    bloodLossFraction: Math.max(0, 1 - hs.bloodVolumeMl / baseline),
    consciousness: hs.consciousness,
    heartRateBpm: hs.heartRateBpm,
    resolveProfile: agent?.resolveProfile ?? hs.resolveProfile ?? 'GRITTY_REGULAR',
  };
}

function entryFor(hs: TargetHealthState, hold: SwayHold, agent?: EnemyAiAgentRuntime): SwayEntry {
  let entry = entries.get(hs.targetId);
  if (!entry || (agent && entry.owner !== null && entry.owner !== agent)) {
    entry = { owner: agent ?? null, state: createWeaponSwayState(hs.targetId, clockS), conditions: buildEnemySwayConditions(hs, hold, agent) };
    entries.set(hs.targetId, entry);
  }
  if (agent) entry.owner = agent;
  entry.conditions = buildEnemySwayConditions(hs, hold, agent ?? entry.owner ?? undefined);
  return entry;
}

/**
 * Brings a combatant's sway up to date for this tick: its body state, whether the aim is up (for
 * the settle-in) and the shared clock.
 */
export function refreshEnemyWeaponSway(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  aimProfile: EnemyAimProfile,
  aiming: boolean,
  nowS: number,
): void {
  setEnemySwayClock(nowS);
  const entry = entryFor(hs, resolveSwayHold(hs, aimProfile), agent);
  noteAimRaised(entry.state, aiming, clockS);
}

/** The gun's current offset from the intended aim; zero for a combatant the AI never aimed with. */
export function sampleEnemyWeaponSway(targetId: string, nowS = clockS): WeaponSwayOffset {
  const entry = entries.get(targetId);
  if (!entry) return { ...ZERO };
  return sampleWeaponSway(entry.state, entry.conditions, nowS);
}

/**
 * One shot's recoil, by the player's recoil numbers for this gun and hold. Sample the shot
 * direction first: the bullet leaves before the muzzle climbs. The weapon pose reads the kick
 * through sampleEnemyWeaponSway, so the visible barrel climbs and settles with it.
 */
export function kickEnemyWeaponSway(targetId: string, weaponId: string, nowS = clockS): void {
  const entry = entries.get(targetId);
  if (!entry) return;
  sampleWeaponSway(entry.state, entry.conditions, nowS);
  kickWeaponSway(entry.state, recoilKickForWeapon(weaponId, entry.conditions.hold), entry.conditions, nowS);
}

export function forgetEnemyWeaponSway(targetId: string): void {
  entries.delete(targetId);
}

export function clearEnemyWeaponSway(): void {
  entries.clear();
  clockS = 0;
}
