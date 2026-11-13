import type { PainReactionType, TargetHealthState } from '../../contracts/ballistics.ts';
import { isCommittedWoundReaction } from '../../core/ballistics/trauma/woundReactionTimings.ts';
import type { CombatantAnimationClipName, CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { CombatantMovementClip } from './combatantLocomotion.ts';
import {
  isFlinchClip, isStumpClutchClip, lostArmSide, pickAvailableClip, reactionWantsClip, stumpClutchClip,
  woundClipChainAt, type WoundClipOwner,
} from './combatantWoundClips.ts';
import {
  DownedCrawlStage, isCrawlLoopClip, isGroundedWoundedPhase, woundedPhaseClipPlan, type WoundedPhaseClipPlan,
} from './combatantWoundedPhaseClips.ts';
import { seatedClipPlan, type SeatedClipPlan } from './combatantSeatedClips.ts';
import { playSeatedClip } from './combatantSeatedPlayback.ts';
import { playDeathClip } from './combatantDeathPlayback.ts';
import { drawClipPlan, drawPlaybackSpeed, isDrawClip } from './combatantDrawClips.ts';
import {
  canAimFrom, canMoveFrom, gaitClipFor, isEmptyHanded, legBuckledClip, PickupClipTracker, upperClipFor, upperRequest,
} from './combatantStandingClips.ts';
import { CombatantUpperBodyLayer, type UpperBodyRequest } from './combatantUpperBodyLayer.ts';
import { heldWeaponPose } from './combatantWeaponPoseMap.ts';
import {
  clipPlaybackSpeed, FLINCH_END_PROGRESS, isPistolHandClip, resolveAimClip, resolveClipOwnership, woundKindFor,
  type CombatantAimPose,
} from './combatantClipRules.ts';

export type { CombatantAimPose };

// The crawl take covers 1.06 m per 2.27 s cycle.
const CRAWL_NOMINAL_SPEED = 0.47;

export type AnimClipState =
  | { readonly kind: 'FROZEN' }
  | {
      readonly kind: 'PLAYING';
      readonly clip: CombatantAnimationClipName;
      readonly isSouthpaw: boolean;
      readonly clipKey: string;
      readonly reactionType: PainReactionType;
      readonly reactionEpoch: number;
      readonly reactionTimerS: number;
      /** Whether this clip was started for a wound, and which kind; null for idle, aim and gait. */
      readonly woundKind: Exclude<WoundClipOwner, null> | null;
    };

export type ClipGlb = Pick<CombatantGlbInstance, 'animComponent' | 'playClip'> &
  Partial<Pick<CombatantGlbInstance, 'availableClips'>>;

export class CombatantAnimController {
  public clipState: AnimClipState = { kind: 'FROZEN' };
  private ownership: WoundClipOwner = null;
  // Clips playClip refused, for a GLB that does not list its clips; they are not tried again.
  private readonly missingClips = new Set<string>();
  private readonly crawlStage = new DownedCrawlStage();
  private readonly pickup = new PickupClipTracker();
  /** The masked upper-body layer: the aim or carry over a gait (combatantUpperBodyLayer.ts). */
  public readonly upperBody = new CombatantUpperBodyLayer();
  /** The seated clip asked for this frame, or null when the body is not sitting its last stand. */
  public seatedClip: SeatedClipPlan | null = null;
  private pickupStanding = false;

  public get isCrawling(): boolean {
    return this.clipState.kind === 'PLAYING' && isCrawlLoopClip(this.clipState.clip);
  }

  /** Which kind of wound clip owns the body right now; the procedural overlays step back for it. */
  public get activeWoundClip(): WoundClipOwner {
    return this.ownership;
  }

  /**
   * True while a flinch clip holds the body, or the pickup clip is still standing it back up:
   * the AI must not walk or strafe it meanwhile, or its planted feet would skate.
   */
  public get isFlinchHolding(): boolean {
    return this.ownership === 'FLINCH' || this.pickupStanding;
  }

  /** True while an arm stump is held to the chest by the stump-clutch loop. */
  public get isStumpClutching(): boolean {
    return this.clipState.kind === 'PLAYING' && isStumpClutchClip(this.clipState.clip);
  }

  public reset(): void {
    this.clipState = { kind: 'FROZEN' };
    this.ownership = null;
    this.seatedClip = null;
    this.pickupStanding = false;
    this.crawlStage.reset();
    this.pickup.reset();
    this.upperBody.reset();
  }

  /**
   * The body clip for the health state alone, before gait, aim and draws. `pistolHand` is the
   * hand of a visible sidearm, so a body with a pistol out is not shown empty-handed.
   */
  public resolveDesiredClip(
    healthState: TargetHealthState,
    guarding = false,
    availableClips?: ReadonlySet<string>,
    pistolHand?: 'RIGHT' | 'LEFT',
  ): CombatantAnimationClipName {
    const has = (clip: CombatantAnimationClipName): boolean =>
      !this.missingClips.has(clip) && (!availableClips || availableClips.has(clip));
    const { posture, activeReaction } = healthState;
    if (reactionWantsClip(activeReaction)) {
      const clip = pickAvailableClip(woundClipChainAt(activeReaction), has);
      if (clip) return clip;
    }
    if (posture === 'LEG_BUCKLED') return 'DownedCollapse';
    // After the flinch, a body hurt in the chest, gut or throat stands hunched over the wound.
    if (posture === 'STAGGERED' || posture === 'GUT_HURT' || posture === 'THROAT_CLUTCH') {
      return pickAvailableClip(['HurtIdle', 'HitStaggerChest'], has) ?? 'HitStaggerChest';
    }
    // With the gun gone and an arm cut short, the stump is held to the chest. A drawn sidearm
    // replaces this with the one-handed aim (see syncAnimation).
    const stumpSide = healthState.weaponDropped ? lostArmSide(healthState) : null;
    if (stumpSide && has(stumpClutchClip(stumpSide))) return stumpClutchClip(stumpSide);
    if (isEmptyHanded(healthState, pistolHand) && has('UnarmedIdle')) return 'UnarmedIdle';
    if (guarding) return 'UnsuspectingIdle';
    // A pistol with no support arm left is carried low in one hand (combatantWeaponPoseMap.ts).
    const carry = heldWeaponPose(healthState, pistolHand)?.carry ?? 'CombatReadyIdle';
    return has(carry) ? carry : 'CombatReadyIdle';
  }

  public syncAnimation(
    glb: ClipGlb,
    healthState: TargetHealthState,
    guarding = false,
    movement?: CombatantMovementClip,
    aim?: CombatantAimPose,
    groundSpeed = 0,
    dt = 0
  ): void {
    if (!glb.animComponent) return;
    if (!glb.animComponent.playing) glb.animComponent.playing = true;

    const available = glb.availableClips;
    const has = (clip: CombatantAnimationClipName): boolean =>
      !this.missingClips.has(clip) && (!available || available.has(clip));
    const reaction = healthState.activeReaction;
    const phase = healthState.woundedPhase;
    const progress = glb.animComponent.baseLayer?.activeStateProgress;
    this.pickupStanding = false;
    // Sitting its last stand on the floor: the seated clips own the body. A hit only jolts it;
    // a flinch clip would stand it back up.
    this.seatedClip = seatedClipPlan(healthState, aim?.hand);
    if (this.seatedClip) {
      this.crawlStage.advance(phase, this.clipState, 0, progress);
      this.syncSeatedClip(glb, healthState, this.seatedClip, has);
      this.upperBody.sync(glb, null);
      return;
    }
    // A standing flinch would pop a kneeling, seated or crawling body back up, so while it is low
    // a lesser hit only adds the spring jolt. Falls and losses still play.
    const reactionClip = reactionWantsClip(reaction) &&
      (!isGroundedWoundedPhase(phase) || isCommittedWoundReaction(reaction.type));
    const crawlRate = Math.max(0.1, Math.min(1.6, groundSpeed / CRAWL_NOMINAL_SPEED));
    if (!reactionClip) {
      const stage = this.crawlStage.advance(healthState.woundedPhase, this.clipState, dt, progress);
      // A sidearm draw is a whole-body clip too: it plays where the body stands.
      const plan = drawClipPlan(healthState, aim?.hand) ?? woundedPhaseClipPlan(healthState, aim?.hand, stage);
      if (plan && (isGroundedWoundedPhase(phase) || !this.flinchStillPlaying(progress))) {
        this.syncPhaseClip(glb, healthState, plan, has, crawlRate);
        this.upperBody.sync(glb, null);
        return;
      }
    } else {
      this.crawlStage.advance(healthState.woundedPhase, this.clipState, 0, progress);
    }
    const reactionEpoch = reaction.epoch ?? 0;
    const baseClip = this.resolveDesiredClip(healthState, guarding, available, aim?.hand);
    const prev = this.clipState;
    const prevClip = prev.kind === 'PLAYING' ? prev.clip : null;

    // A body down on its seat with no plan plays the fall out, rolls onto its belly and crawls.
    const buckled = !reactionClip && healthState.posture === 'LEG_BUCKLED' ? legBuckledClip(prev, progress, has) : null;
    const collapsed = buckled === 'Crawl';
    // A flinch plays to its end even once the reaction is over, so the gun comes back on target
    // before the body aims or walks again. Only standing clips wait for it.
    const flinchHolding = !reactionClip && !buckled && prevClip !== null && isFlinchClip(prevClip) &&
      (progress ?? 1) < FLINCH_END_PROGRESS;
    const picking = !reactionClip && !buckled && has('PickupWeapon') &&
      this.pickup.wants(healthState, prevClip, progress, dt);
    this.pickupStanding = picking && !healthState.weaponDropped;
    const free = !reactionClip && !buckled && !flinchHolding && !picking;
    const aimClip = free && aim && canAimFrom(baseClip) ? resolveAimClip(aim, has) : undefined;
    const gait = free && canMoveFrom(baseClip) ? movement : undefined;
    const gaitClip = gait ? gaitClipFor(baseClip, gait.clip, has) : undefined;
    const desiredClip: CombatantAnimationClipName = buckled
      ?? (flinchHolding && prevClip ? prevClip : picking ? 'PickupWeapon' : gaitClip ?? aimClip ?? baseClip);
    const pistolSouthpaw = aim?.hand ? aim.hand === 'LEFT' : healthState.isLeftHanded;
    const isSouthpaw = isPistolHandClip(desiredClip) ? pistolSouthpaw : healthState.isLeftHanded;
    const clipKey = `${desiredClip}_${isSouthpaw ? 'L' : 'R'}`;
    const woundKind = reactionClip || buckled ? woundKindFor(desiredClip, reaction.type) : null;

    // A new hit restarts a flinch; a fall, loss or collapse is never restarted by a lesser hit.
    const restartFlinch =
      reactionClip &&
      woundKind === 'FLINCH' &&
      (prev.kind !== 'PLAYING' ||
        reactionEpoch !== prev.reactionEpoch ||
        reaction.type !== prev.reactionType ||
        reaction.timerS < prev.reactionTimerS - 1e-4);
    const clipChanged = prev.kind !== 'PLAYING' || prev.clipKey !== clipKey;

    if (clipChanged || restartFlinch) {
      const speed = clipPlaybackSpeed(woundKind, healthState, collapsed ? crawlRate : null, gaitClip ? gait?.playbackSpeed : undefined);
      if (glb.playClip(desiredClip, collapsed ? 0.4 : 0.12, speed, isSouthpaw)) {
        this.clipState = {
          kind: 'PLAYING', clip: desiredClip, isSouthpaw, clipKey,
          reactionType: reaction.type, reactionEpoch, reactionTimerS: reaction.timerS, woundKind,
        };
      } else if (!available) {
        this.missingClips.add(desiredClip);
      }
    } else if (prev.kind === 'PLAYING') {
      if (collapsed) glb.animComponent.speed = crawlRate;
      else if (gaitClip && gait) glb.animComponent.speed = gait.playbackSpeed;
      this.clipState = { ...prev, reactionType: reaction.type, reactionEpoch, reactionTimerS: reaction.timerS };
    }
    this.ownership = resolveClipOwnership(this.clipState, reactionClip, reaction.type, progress);
    // Moving: the gait stays on the base layer and the aim or carry goes on the upper body.
    const upper = gaitClip ? upperClipFor(baseClip, gaitClip, aimClip) : null;
    const upperSouthpaw = upper && isPistolHandClip(upper) ? pistolSouthpaw : healthState.isLeftHanded;
    this.syncUpperBody(glb, upperRequest(upper, upperSouthpaw));
  }

  private syncUpperBody(glb: ClipGlb, request: UpperBodyRequest | null): void {
    const playing = this.clipState.kind === 'PLAYING';
    this.upperBody.sync(glb, playing ? request : null);
  }

  /**
   * Plays the clip of a wounded-sequence phase or a draw. The clip starts once when the phase (or
   * its stage) begins and is never restarted while it lasts; one-shot clips hold their last frame.
   */
  private syncPhaseClip(
    glb: ClipGlb,
    healthState: TargetHealthState,
    plan: WoundedPhaseClipPlan,
    has: (clip: CombatantAnimationClipName) => boolean,
    crawlRate: number,
  ): void {
    const reaction = healthState.activeReaction;
    const clip = pickAvailableClip(plan.chain, has) ?? 'CombatReadyIdle';
    const clipKey = `${clip}_${plan.southpaw ? 'L' : 'R'}`;
    const prev = this.clipState;
    const speed = plan.crawl ? crawlRate : 1;
    if (prev.kind !== 'PLAYING' || prev.clipKey !== clipKey) {
      if (glb.playClip(clip, plan.blendS, speed, plan.southpaw)) {
        this.clipState = {
          kind: 'PLAYING', clip, isSouthpaw: plan.southpaw, clipKey, reactionType: reaction.type,
          reactionEpoch: reaction.epoch ?? 0, reactionTimerS: reaction.timerS, woundKind: plan.owner,
        };
      } else if (!glb.availableClips) {
        this.missingClips.add(clip);
      }
    } else {
      if (plan.crawl && glb.animComponent) glb.animComponent.speed = crawlRate;
      this.clipState = { ...prev, reactionType: reaction.type, reactionTimerS: reaction.timerS, woundKind: plan.owner };
    }
    const state = this.clipState;
    // A draw lasts exactly as long as the armament's draw, whatever length it was baked at.
    if (state.kind === 'PLAYING' && isDrawClip(state.clip) && glb.animComponent) {
      glb.animComponent.speed = drawPlaybackSpeed(healthState, glb.animComponent.baseLayer?.activeStateDuration);
    }
    this.ownership = state.kind === 'PLAYING' && state.clipKey === clipKey ? plan.owner : null;
  }

  /** Plays the seated last-stand clip (combatantSeatedPlayback.ts); it owns the whole body. */
  private syncSeatedClip(
    glb: ClipGlb,
    healthState: TargetHealthState,
    plan: SeatedClipPlan,
    has: (clip: CombatantAnimationClipName) => boolean,
  ): void {
    const played = playSeatedClip(glb, healthState, plan, has, this.clipState);
    this.clipState = played.state;
    if (played.missing) this.missingClips.add(played.missing);
    this.ownership = 'COMMITTED';
  }

  /**
   * Plays the death clip of a body killed on its feet (combatantDeathPlayback.ts). It owns the
   * whole body; the upper layer, the pickup and the flinch hold are off.
   */
  public syncDying(glb: ClipGlb, healthState: TargetHealthState): void {
    if (!glb.animComponent) return;
    if (!glb.animComponent.playing) glb.animComponent.playing = true;
    const available = glb.availableClips;
    const has = (clip: CombatantAnimationClipName): boolean =>
      !this.missingClips.has(clip) && (!available || available.has(clip));
    const played = playDeathClip(glb, healthState, has, this.clipState);
    this.clipState = played.state;
    if (played.missing) this.missingClips.add(played.missing);
    this.seatedClip = null;
    this.pickupStanding = false;
    this.ownership = 'COMMITTED';
    this.upperBody.sync(glb, null);
  }

  /** A flinch that is still playing out after its reaction, so a standing phase waits for it. */
  private flinchStillPlaying(progress: number | undefined): boolean {
    const prev = this.clipState;
    return prev.kind === 'PLAYING' && isFlinchClip(prev.clip) && (progress ?? 1) < FLINCH_END_PROGRESS;
  }

  public freezeAnimation(glb: Pick<CombatantGlbInstance, 'animComponent'>): void {
    if (glb.animComponent) glb.animComponent.playing = false;
    this.clipState = { kind: 'FROZEN' };
    this.ownership = null;
    this.pickupStanding = false;
    this.upperBody.sync(glb, null);
  }
}
