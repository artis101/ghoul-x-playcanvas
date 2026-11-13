import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import {
  applyArmamentStateToRuntime, createPrimaryArmedState, reconcileEnemyArmamentState,
  stepEnemyArmamentState, type SyncedArmamentRuntimeFields,
} from '../../core/ai/enemyArmamentFsm.ts';
import {
  getPreferredPrimaryHand, isArmChainIntactAndFunctional, selectIntactFiringHand,
} from '../ai/combatantArmEvaluation.ts';
import type { EnemySidearmVisualState } from '../ai/tacticalAiTypes.ts';
import { sidearmDrawProgress, sidearmDrawSecondsFor } from '../ai/agentArmamentController.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';
import { isWoundClipHoldingBody } from '../ai/woundClipHold.ts';
import { drawClipSecondsFor } from '../mannequin/combatantDrawClips.ts';
import {
  crawlAwayStep, labSidearmRule, stepLabWoundedSequence, wouldFire, woundedStatus, type LabAgentView,
} from './woundedLabStandIn.ts';

/**
 * The AI half of a Character Lab combatant: the wounded sequence and the armament, stepped with
 * the game's own rules against a player stand-in. No engine code, so a whole branch (arm off,
 * clutch, draw, fire or not) can be run headlessly.
 */
export class LabCombatantBrain {
  private readonly armament: SyncedArmamentRuntimeFields;
  /** The few agent fields the game's wounded-sequence rules read. */
  private readonly agentView: LabAgentView = {
    sidearmActive: false, sidearmDrawing: false, woundedSense: undefined, state: 'ALERTED_ENGAGING',
  };

  public constructor(
    private readonly health: TargetHealthState,
    private readonly backupSidearm: boolean,
    /** The player stand-in: where a drawn sidearm points and what the downed fire cone measures. */
    public readonly player: () => Vec3Like,
  ) {
    const hand = getPreferredPrimaryHand(health);
    this.armament = {
      activeFiringHand: hand,
      sidearmDrawTimerS: 0,
      sidearmDrawing: false,
      sidearmActive: false,
      sidearmDropped: false,
      armamentState: createPrimaryArmedState(hand),
    };
  }

  public get armamentKind(): string {
    return this.armament.armamentState?.kind ?? '—';
  }

  /** True when the game would let this body fire at the stand-in right now. */
  public get wouldFire(): boolean {
    const kind = this.armament.armamentState?.kind;
    const inHand = kind === 'SIDEARM_ACTIVE' || (kind === 'PRIMARY_ARMED' && !this.health.weaponDropped);
    return wouldFire(this.health, this.agentView, inHand);
  }

  /** Phase, phase clock, fortitude, the stand-in's bearing and the fire verdict. */
  public get statusLine(): string {
    return woundedStatus(this.health, this.wouldFire, this.agentView);
  }

  /**
   * The AI tick, in the game's order: the wounded sequence, then the armament. `crawling` says
   * the body is in its crawl loop; the game's AI drags a crawler away from the player, and the
   * lab has no AI, so it is done here.
   */
  public step(dt: number, crawling: boolean): void {
    const hs = this.health;
    const player = this.player();
    stepLabWoundedSequence(hs, this.agentView, dt, player, this.backupSidearm && !this.armament.sidearmDropped);
    if (hs.alive && hs.woundedPhase === 'DOWNED_CRAWL' && crawling) crawlAwayStep(hs, player, dt);
    this.stepArmament(dt);
  }

  private stepArmament(dt: number): void {
    const hs = this.health;
    const preferred = getPreferredPrimaryHand(hs);
    const result = stepEnemyArmamentState(reconcileEnemyArmamentState(this.armament), {
      dt,
      alive: hs.alive && hs.currentHp > 0,
      rightArmIntact: isArmChainIntactAndFunctional(hs, 'RIGHT'),
      leftArmIntact: isArmChainIntactAndFunctional(hs, 'LEFT'),
      preferredPrimaryHand: preferred,
      intactHand: selectIntactFiringHand(hs, preferred),
      weaponDropped: hs.weaponDropped,
      primaryArmDisarmed: hs.primaryArmDisarmed === true,
      isRagdollActive: hs.isRagdollActive,
      isAirborneRagdoll: hs.isRagdollActive && hs.posture === 'AIRBORNE_RAGDOLL',
      carriesBackupSidearm: this.backupSidearm,
      isGuarding: false,
      isLastStandVital: hs.currentHp <= hs.maxHp * 0.32,
      // A standing or kneeling draw lasts its clip, so the pistol comes out when the clip shows it.
      sidearmDrawDurationS: isSeatedAnimated(hs) ? sidearmDrawSecondsFor(hs) : drawClipSecondsFor(hs),
      seatedOnFloor: isSeatedAnimated(hs),
      // The game passes both: falls and losses play out before any draw, and the wounded
      // sequence says when the pistol may come out at all.
      woundClipPlaying: isWoundClipHoldingBody(hs),
      sidearmRule: labSidearmRule(hs, this.agentView),
    });
    applyArmamentStateToRuntime(this.armament, result.state);
    hs.sidearmHand =
      result.state.kind === 'SIDEARM_ACTIVE' || result.state.kind === 'SIDEARM_DRAWING' ? result.state.hand : null;
    if (result.dropPrimaryWeapon) hs.weaponDropped = true;
    if (result.markPrimaryArmDisarmed) hs.primaryArmDisarmed = true;
    if (result.forceDisarmedPosture) hs.posture = 'DISARMED';
    hs.combatantStatusTag = result.statusTag;
    this.agentView.sidearmActive = this.armament.sidearmActive;
    this.agentView.sidearmDrawing = this.armament.sidearmDrawing;
  }

  /** The primary is back in hand (a scripted pickup): the armament holds it again. */
  public rearm(): void {
    applyArmamentStateToRuntime(this.armament, createPrimaryArmedState(getPreferredPrimaryHand(this.health)));
    this.agentView.sidearmActive = this.armament.sidearmActive;
    this.agentView.sidearmDrawing = this.armament.sidearmDrawing;
  }

  public sidearmState(): EnemySidearmVisualState {
    const state = reconcileEnemyArmamentState(this.armament);
    const visible = state.kind === 'SIDEARM_ACTIVE' || state.kind === 'SIDEARM_DRAWING';
    return {
      visible,
      drawing: state.kind === 'SIDEARM_DRAWING',
      drawProgress: sidearmDrawProgress(state),
      hand: visible ? state.hand : null,
      dropped: state.kind === 'DISARMED' && state.sidearmDropped,
      aimTargetWorld: this.player(),
      weaponId: 'silver_talon_50ae',
    };
  }
}
