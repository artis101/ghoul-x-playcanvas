import type { PainReactionType, TargetHealthState } from '../../contracts/ballistics.ts';
import { isCommittedWoundReaction, isFallingReaction } from '../../core/ballistics/trauma/woundReactionTimings.ts';
import type { CombatantAnimationClipName, CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { CombatantMovementClip } from './combatantLocomotion.ts';
import {
  flinchPlaybackSpeed,
  isCommittedClip,
  isFallingClip,
  isFlinchClip,
  isStumpClutchClip,
  lostArmSide,
  pickAvailableClip,
  reactionWantsClip,
  stumpClutchClip,
  woundClipChainAt,
  type WoundClipOwner,
} from './combatantWoundClips.ts';
import {
  DownedCrawlStage, isGroundedWoundedPhase, KNEEL_AIM_CHAIN, woundedPhaseClipPlan,
  type SidearmAimClip, type WoundedPhaseClipPlan,
} from './combatantWoundedPhaseClips.ts';

// The retargeted clip reaches hand contact near source frame 71 of the 12–113 range.
const LEG_COLLAPSE_TIME_S = 1.17;
// The crawl take covers 1.06 m per 2.27 s cycle.
const CRAWL_NOMINAL_SPEED = 0.47;
// A flinch hands the body back once it is this far through; the last frames are the idle pose.
const FLINCH_END_PROGRESS = 0.98;
const COLLAPSE_END_PROGRESS = 0.97;

export interface CombatantAimPose {
  readonly clip: 'LongGunAim' | SidearmAimClip;
  readonly hand?: 'RIGHT' | 'LEFT';
}

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

type ClipGlb = Pick<CombatantGlbInstance, 'animComponent' | 'playClip'> &
  Partial<Pick<CombatantGlbInstance, 'availableClips'>>;

export class CombatantAnimController {
  public clipState: AnimClipState = { kind: 'FROZEN' };
  private ownership: WoundClipOwner = null;
  // Clips playClip refused, for a GLB that does not list its clips; they are not tried again.
  private readonly missingClips = new Set<string>();
  private readonly crawlStage = new DownedCrawlStage();

  public get isCrawling(): boolean {
    return this.clipState.kind === 'PLAYING' && this.clipState.clip === 'Crawl';
  }

  /** Which kind of wound clip owns the body right now; the procedural overlays step back for it. */
  public get activeWoundClip(): WoundClipOwner {
    return this.ownership;
  }

  /** True while an arm stump is held to the chest by the stump-clutch loop. */
  public get isStumpClutching(): boolean {
    return this.clipState.kind === 'PLAYING' && isStumpClutchClip(this.clipState.clip);
  }

  public reset(): void {
    this.clipState = { kind: 'FROZEN' };
    this.ownership = null;
    this.crawlStage.reset();
  }

  public resolveDesiredClip(
    healthState: TargetHealthState,
    guarding = false,
    availableClips?: ReadonlySet<string>
  ): CombatantAnimationClipName {
    const has = (clip: CombatantAnimationClipName): boolean =>
      !this.missingClips.has(clip) && (!availableClips || availableClips.has(clip));
    const { posture, activeReaction } = healthState;
    if (reactionWantsClip(activeReaction)) {
      const clip = pickAvailableClip(woundClipChainAt(activeReaction), has);
      if (clip) return clip;
    }
    if (posture === 'LEG_BUCKLED') return 'LegCollapseCrawl';
    // Gut and throat hits flinch like any other torso hit; nobody kneels down mid-firefight.
    if (posture === 'STAGGERED' || posture === 'GUT_HURT' || posture === 'THROAT_CLUTCH') {
      return 'HitStaggerChest';
    }
    // With the gun gone and an arm cut short, the stump is held to the chest. A drawn sidearm
    // replaces this with the one-handed aim (see syncAnimation).
    const stumpSide = healthState.weaponDropped ? lostArmSide(healthState) : null;
    if (stumpSide && has(stumpClutchClip(stumpSide))) return stumpClutchClip(stumpSide);
    return guarding ? 'UnsuspectingIdle' : 'CombatReadyIdle';
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
    // A standing flinch would pop a kneeling, seated or crawling body back up, so while it is low
    // a lesser hit only adds the spring jolt. Falls and losses still play.
    const reactionClip = reactionWantsClip(reaction) &&
      (!isGroundedWoundedPhase(phase) || isCommittedWoundReaction(reaction.type));
    const crawlRate = Math.max(0.1, Math.min(1.6, groundSpeed / CRAWL_NOMINAL_SPEED));
    if (!reactionClip) {
      const stage = this.crawlStage.advance(healthState.woundedPhase, this.clipState, dt, progress);
      const plan = woundedPhaseClipPlan(healthState, aim?.hand, stage);
      if (plan && (isGroundedWoundedPhase(phase) || !this.flinchStillPlaying(progress))) {
        this.syncPhaseClip(glb, healthState, plan, has, crawlRate);
        return;
      }
    } else {
      this.crawlStage.advance(healthState.woundedPhase, this.clipState, 0, progress);
    }
    const reactionEpoch = reaction.epoch ?? 0;
    const baseClip = this.resolveDesiredClip(healthState, guarding, available);
    const canAim = baseClip === 'CombatReadyIdle' || isStumpClutchClip(baseClip);
    const locomotion = canAim || baseClip === 'UnsuspectingIdle' ? movement : undefined;
    const prev = this.clipState;

    // Once a fall has played out, a downed combatant drags itself along in a crawl cycle.
    const collapsed =
      baseClip === 'LegCollapseCrawl' &&
      prev.kind === 'PLAYING' &&
      (prev.clip === 'Crawl' || (isFallingClip(prev.clip) && (progress ?? 0) >= COLLAPSE_END_PROGRESS));
    // A flinch plays to its end even once the reaction is over, so the gun comes back on target
    // before the body aims or walks again. Only standing clips wait for it.
    const flinchHolding =
      !reactionClip && prev.kind === 'PLAYING' && isFlinchClip(prev.clip) && baseClip !== 'LegCollapseCrawl' &&
      ((progress ?? 1) < FLINCH_END_PROGRESS || baseClip === 'HitStaggerChest');
    const aimClip = aim && canAim ? this.resolveAimClip(aim, has) : undefined;
    const desiredClip: CombatantAnimationClipName = collapsed
      ? 'Crawl'
      : flinchHolding && prev.kind === 'PLAYING'
        ? prev.clip
        : locomotion?.clip ?? aimClip ?? baseClip;
    const aimHand = desiredClip === 'PistolAim' || desiredClip === 'PistolAimOneHand' ||
      desiredClip === 'KneelPistolAimOneHand' ? aim?.hand : undefined;
    const isSouthpaw = aimHand ? aimHand === 'LEFT' : healthState.isLeftHanded;
    const clipKey = `${desiredClip}_${isSouthpaw ? 'L' : 'R'}`;
    const woundKind = reactionClip && !collapsed ? this.woundKindFor(desiredClip, reaction.type) : null;

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
      const speed = this.playbackSpeed(desiredClip, woundKind, healthState, collapsed, crawlRate, locomotion);
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
      else if (locomotion) glb.animComponent.speed = locomotion.playbackSpeed;
      this.clipState = { ...prev, reactionType: reaction.type, reactionEpoch, reactionTimerS: reaction.timerS };
    }
    this.ownership = this.resolveOwnership(reactionClip, reaction.type, progress);
  }

  /**
   * Plays the clip of a wounded-sequence phase. The clip starts once when the phase (or its
   * stage) begins and is never restarted while it lasts; one-shot clips hold their last frame.
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
    this.ownership = state.kind === 'PLAYING' && state.clipKey === clipKey ? plan.owner : null;
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
  }

  private resolveAimClip(
    aim: CombatantAimPose,
    has: (clip: CombatantAnimationClipName) => boolean
  ): CombatantAnimationClipName {
    if (aim.clip === 'KneelPistolAimOneHand') return pickAvailableClip(KNEEL_AIM_CHAIN, has) ?? 'PistolAim';
    // The one-handed pistol aim is new; until it is baked the two-handed aim stands in for it.
    if (aim.clip === 'PistolAimOneHand' && !has('PistolAimOneHand')) return 'PistolAim';
    return aim.clip;
  }

  private woundKindFor(clip: CombatantAnimationClipName, type: PainReactionType): 'FLINCH' | 'COMMITTED' | null {
    if (isCommittedClip(clip) || clip === 'LegCollapseCrawl' || isCommittedWoundReaction(type)) return 'COMMITTED';
    return isFlinchClip(clip) ? 'FLINCH' : null;
  }

  private playbackSpeed(
    clip: CombatantAnimationClipName,
    woundKind: 'FLINCH' | 'COMMITTED' | null,
    healthState: TargetHealthState,
    collapsed: boolean,
    crawlRate: number,
    locomotion?: CombatantMovementClip
  ): number {
    const reaction = healthState.activeReaction;
    if (collapsed) return crawlRate;
    // The old collapse take is shorter than a fall reaction; it never plays slower than authored.
    if (clip === 'LegCollapseCrawl' && isFallingReaction(reaction.type) && reaction.durationS > 0) {
      return Math.max(1, LEG_COLLAPSE_TIME_S / reaction.durationS);
    }
    // Authored falls and losses last exactly as long as their reaction, so they play at speed 1.
    if (woundKind === 'COMMITTED') return 1;
    if (woundKind === 'FLINCH') return flinchPlaybackSpeed(reaction);
    return locomotion?.playbackSpeed ?? 1;
  }

  private resolveOwnership(reactionClip: boolean, type: PainReactionType, progress: number | undefined): WoundClipOwner {
    const state = this.clipState;
    if (state.kind !== 'PLAYING' || !state.woundKind) return null;
    if (state.woundKind === 'COMMITTED') {
      // Authored falls own the body until the ragdoll takes it; the old collapse only while the
      // reaction lasts, after which the prop-up and crawl overlays work on it as before.
      return isCommittedClip(state.clip) || (reactionClip && isCommittedWoundReaction(type)) ? 'COMMITTED' : null;
    }
    return reactionClip || (progress ?? 1) < FLINCH_END_PROGRESS ? 'FLINCH' : null;
  }
}
