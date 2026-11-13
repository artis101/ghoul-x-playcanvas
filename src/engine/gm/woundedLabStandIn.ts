import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { SidearmRule } from '../../core/ai/enemyArmamentFsm.ts';
import { effectiveFortitude, stepWoundedSequence } from '../../core/ai/woundedSequenceFsm.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import { isArmChainIntactAndFunctional } from '../ai/combatantArmEvaluation.ts';
import type { EnemyAiAgentRuntime } from '../ai/tacticalAiTypes.ts';
import { resolveSidearmRule, senseWoundedPlayer, woundedSequenceAllowsShot } from '../ai/woundedSequenceDriver.ts';

/**
 * Character Lab stand-ins for what the AI would see: where the player is and how gritty the
 * combatant is. The live mannequin's wounded sequence runs on these, so the downed fire cone,
 * the crawl-away and every fortitude branch can be watched. No engine code here, so the logic
 * is checked headlessly.
 */

/** Where the player stand-in is, relative to the way the combatant first stood (+Z). */
export type PlayerStandIn = 'FRONT' | 'LEFT' | 'BEHIND';
/** A fortitude override; AUTO keeps the value rolled from the resolve profile. */
export type FortitudeChoice = 'AUTO' | 'HIGH' | 'MIDDLING' | 'LOW';

const STAND_IN_DISTANCE_M = 4;
const EYE_HEIGHT_M = 1.35;

/**
 * Base fortitude per choice. The branch is taken on the value scaled by health and
 * consciousness, so these sit well inside their bands: HIGH blazes down to a fifth of its
 * health, MIDDLING kneels, LOW sits down.
 */
export const FORTITUDE_VALUES: Readonly<Record<Exclude<FortitudeChoice, 'AUTO'>, number>> = {
  HIGH: 1,
  MIDDLING: 0.55,
  LOW: 0.2,
};

export function fortitudeOverride(choice: FortitudeChoice): number | undefined {
  return choice === 'AUTO' ? undefined : FORTITUDE_VALUES[choice];
}

/** The stand-in's eye position. The combatant starts at the origin facing +Z; its left is +X. */
export function standInPosition(standIn: PlayerStandIn): Vec3Like {
  switch (standIn) {
    case 'FRONT': return vec3(0, EYE_HEIGHT_M, STAND_IN_DISTANCE_M);
    case 'LEFT': return vec3(STAND_IN_DISTANCE_M, EYE_HEIGHT_M, 0);
    case 'BEHIND': return vec3(0, EYE_HEIGHT_M, -STAND_IN_DISTANCE_M);
  }
}

/**
 * The pieces of the AI agent the game's wounded-sequence rules read. The lab has no agent, so it
 * keeps these itself; the player is always in sight (the lab has no walls).
 */
export type LabAgentView = Pick<EnemyAiAgentRuntime, 'sidearmActive' | 'sidearmDrawing' | 'woundedSense' | 'state'>;

/** Senses the stand-in the way the game's AI senses the player, and steps the wounded sequence. */
export function stepLabWoundedSequence(
  hs: TargetHealthState, agent: LabAgentView, dt: number, player: Vec3Like, hasSidearm: boolean,
): void {
  if (!hs.alive) return;
  const sense = senseWoundedPlayer(hs, player, () => false);
  agent.woundedSense = sense;
  stepWoundedSequence(hs, {
    dt,
    hasSidearm,
    freeArmWorks: isArmChainIntactAndFunctional(hs, 'RIGHT') || isArmChainIntactAndFunctional(hs, 'LEFT'),
    playerBearingRad: sense.playerBearingRad,
    playerVisible: sense.playerVisible,
  });
}

/** The game's sidearm rule for this body (resolveSidearmRule reads only the fields in the view). */
export function labSidearmRule(hs: TargetHealthState, agent: LabAgentView): SidearmRule {
  return resolveSidearmRule(hs, agent as EnemyAiAgentRuntime);
}

/** True when the game would let this body pull a trigger on the player right now. */
export function wouldFire(hs: TargetHealthState, agent: LabAgentView, weaponInHand: boolean): boolean {
  return hs.alive && weaponInHand && woundedSequenceAllowsShot(hs, agent as EnemyAiAgentRuntime);
}

/** The status line's wounded-sequence part: phase, its clock, fortitude and whether it would fire. */
export function woundedStatus(hs: TargetHealthState, fire: boolean, agent: LabAgentView): string {
  const bearingRad = agent.woundedSense?.playerBearingRad ?? null;
  const phase = hs.woundedPhase ?? 'NONE';
  const timer = (hs.woundedPhaseTimerS ?? 0).toFixed(2);
  const base = hs.fortitude === undefined ? '—' : hs.fortitude.toFixed(2);
  const bearing = bearingRad === null ? '—' : `${Math.round((bearingRad * 180) / Math.PI)}°`;
  return `${phase} ${timer} s · fortitude ${base} (now ${effectiveFortitude(hs).toFixed(2)}) · ` +
    `you at ${bearing} · would fire: ${fire ? 'yes' : 'no'}`;
}

const CRAWL_SPEED_MS = 0.4;
const CRAWL_TURN_RAD_S = 1.4;

/**
 * Drags a crawling body away from the player, turning it slowly to put its back to them. The
 * game's AI does this; the lab has no AI agent, so it stands in for it.
 */
export function crawlAwayStep(hs: TargetHealthState, player: Vec3Like, dt: number): void {
  const away = Math.atan2(hs.worldPosition.x - player.x, hs.worldPosition.z - player.z);
  let turn = away - hs.yawRad;
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn < -Math.PI) turn += 2 * Math.PI;
  const maxTurn = CRAWL_TURN_RAD_S * dt;
  hs.yawRad += Math.max(-maxTurn, Math.min(maxTurn, turn));
  hs.worldPosition.x += Math.sin(hs.yawRad) * CRAWL_SPEED_MS * dt;
  hs.worldPosition.z += Math.cos(hs.yawRad) * CRAWL_SPEED_MS * dt;
}
