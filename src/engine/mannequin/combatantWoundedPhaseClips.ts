import type { TargetHealthState, WoundedPhase } from '../../contracts/ballistics.ts';
import { SIT_TO_CRAWL_S } from '../../core/ballistics/trauma/woundReactionTimings.ts';
import { evaluateCrawlCondition } from '../../core/ghoul/anatomy/crawlCondition.ts';
import type { CombatantAnimationClipName } from '../assets/glbTypes.ts';
import { lostArmSide, pistolAimClip } from './combatantWoundClips.ts';

/**
 * Which clip each step of the wounded sequence plays (docs/wound-movement.md). The AI decides
 * the phase; this only says what the body looks like while it lasts. A reaction clip (a flinch,
 * fall or loss) still wins over these while it plays.
 */

type ArmSide = 'RIGHT' | 'LEFT';

/** Blend into a phase clip. Short, so each step reads as the next beat, not a slow morph. */
export const PHASE_BLEND_S = 0.2;
/** The crawl loop picks up from the sit-to-crawl roll; a slightly longer blend hides the seam. */
export const CRAWL_BLEND_S = 0.3;

/** Where the downed crawl is: rolling from the seat onto the belly, or dragging itself along. */
export type CrawlStage = 'SIT_TO_CRAWL' | 'CRAWL';

export interface WoundedPhaseClipPlan {
  /** Preferred clip first, then what to play while the GLB does not have it yet. */
  readonly chain: readonly CombatantAnimationClipName[];
  readonly blendS: number;
  /**
   * COMMITTED: the clip owns the whole body, so the prop-up, the clutch IK and most of the jolt
   * step back. Null: the overlays work on it as usual.
   */
  readonly owner: 'COMMITTED' | null;
  /** The southpaw twin is used for handed clips (the kneeling pistol aim). */
  readonly southpaw: boolean;
  /** Plays at the crawl rate, with the crawl overlay (the blood trail) on. */
  readonly crawl: boolean;
}

/** The arm the body reacts to: the lost one, or the gun arm while nothing is lost. */
function stumpSide(hs: TargetHealthState): ArmSide {
  return lostArmSide(hs) ?? (hs.isLeftHanded ? 'LEFT' : 'RIGHT');
}

const sided = (base: 'StumpClutch' | 'StumpKneel', side: ArmSide): CombatantAnimationClipName =>
  `${base}${side === 'RIGHT' ? 'Right' : 'Left'}`;

/** The kneel-down onto the knee on the stump side. */
export function stumpKneelChain(side: ArmSide): readonly CombatantAnimationClipName[] {
  return [sided('StumpKneel', side)];
}

/** Kneeling one-handed pistol aim, then the standing ones while it is not baked. */
export const KNEEL_AIM_CHAIN: readonly CombatantAnimationClipName[] = [
  'KneelPistolAimOneHand', 'PistolAimOneHand', 'PistolAim',
];

/** Phases where the body is low (kneeling, seated or on its belly): a standing flinch would pop it up. */
export function isGroundedWoundedPhase(phase: WoundedPhase | undefined): boolean {
  return phase === 'KNEEL_DOWN' || phase === 'KNEEL_FIRE' || phase === 'SIT_DOWN' || phase === 'DOWNED_CRAWL';
}

/**
 * The clip plan for the body's wounded phase, or null when the usual idle, aim and gait choice
 * applies (no phase, BLAZE, and the ragdolled downed phases).
 *
 * `aimHand` is the hand holding a drawn sidearm, if any; `crawlStage` says whether the downed
 * crawl has finished rolling onto its belly.
 */
export function woundedPhaseClipPlan(
  hs: TargetHealthState,
  aimHand: ArmSide | undefined,
  crawlStage: CrawlStage,
): WoundedPhaseClipPlan | null {
  const side = stumpSide(hs);
  const plan = (
    chain: readonly CombatantAnimationClipName[], owner: 'COMMITTED' | null, blendS = PHASE_BLEND_S,
    southpaw = false, crawl = false,
  ): WoundedPhaseClipPlan => ({ chain, blendS, owner, southpaw, crawl });

  switch (hs.woundedPhase) {
    case 'CLUTCH':
      // The stump clutch holds the arm itself, so the clutch IK is suppressed by the clip check.
      return plan([sided('StumpClutch', side), 'CombatReadyIdle'], null);
    case 'KNEEL_DOWN':
      return plan(stumpKneelChain(side), 'COMMITTED');
    case 'KNEEL_FIRE': {
      // It stays on its knee, holding the last kneel frame, while the hand goes for the holster;
      // the kneeling aim only comes up once the pistol is out.
      if (hs.combatantStatusTag !== 'SIDEARM_DRAWN') return plan(stumpKneelChain(side), 'COMMITTED');
      const hand: ArmSide = aimHand ?? (side === 'RIGHT' ? 'LEFT' : 'RIGHT');
      return plan(KNEEL_AIM_CHAIN, null, PHASE_BLEND_S, hand === 'LEFT');
    }
    case 'SIT_DOWN':
      // The collapse reaction plays this; the plan only covers a frame between phase and reaction.
      return plan(['DownedCollapse'], 'COMMITTED');
    case 'DOWNED_CRAWL':
      return crawlStage === 'CRAWL'
        ? plan(crawlClipChain(hs), null, CRAWL_BLEND_S, false, true)
        : plan(['SitToCrawl', 'Crawl'], 'COMMITTED');
    default:
      return null;
  }
}

/** True for the kneel-down clips: they own the body like a fall does. */
export function isKneelDownClip(clip: string): boolean {
  return clip === 'StumpKneelRight' || clip === 'StumpKneelLeft';
}

/** The crawl loops: on both knees, or pulling one useless leg behind. */
export function isCrawlLoopClip(clip: string): boolean {
  return clip === 'Crawl' || clip === 'CrawlDragLegRight' || clip === 'CrawlDragLegLeft';
}

/**
 * The crawl loop for the body's legs. One useless leg (not cut off) is dragged by its own take,
 * which pushes with the good leg only; with both legs useless the plain crawl stands in, the arms
 * doing the work.
 */
export function crawlClipChain(hs: TargetHealthState): readonly CombatantAnimationClipName[] {
  const condition = evaluateCrawlCondition(hs, 0);
  if (condition.dragRightLeg && !condition.dragLeftLeg) return ['CrawlDragLegRight', 'Crawl'];
  if (condition.dragLeftLeg && !condition.dragRightLeg) return ['CrawlDragLegLeft', 'Crawl'];
  return ['Crawl'];
}

export type SidearmAimClip = 'PistolAim' | 'PistolAimOneHand' | 'KneelPistolAimOneHand';

/**
 * The aim clip for a drawn sidearm. Kneeling to fire uses the kneeling one-handed aim; standing,
 * the one-handed aim when the support arm is gone, else the two-handed one.
 */
export function sidearmAimClip(hs: TargetHealthState, hand: ArmSide): SidearmAimClip {
  return hs.woundedPhase === 'KNEEL_FIRE' ? 'KneelPistolAimOneHand' : pistolAimClip(hs, hand);
}

/** The roll onto the belly counts as done this far through its clip. */
const SIT_TO_CRAWL_END_PROGRESS = 0.97;

/**
 * Where the downed crawl is. The roll onto the belly starts once the fall has ended and runs for
 * its clip length (or until the clip is all but done); with no roll clip baked, the crawl loop
 * starts at once. It starts over whenever the body leaves DOWNED_CRAWL.
 */
export class DownedCrawlStage {
  private stage: CrawlStage = 'SIT_TO_CRAWL';
  private rollS = 0;

  public reset(): void {
    this.stage = 'SIT_TO_CRAWL';
    this.rollS = 0;
  }

  public advance(
    phase: WoundedPhase | undefined,
    playing: { readonly kind: string; readonly clip?: string },
    dt: number,
    progress: number | undefined,
  ): CrawlStage {
    if (phase !== 'DOWNED_CRAWL') {
      this.reset();
      return this.stage;
    }
    if (this.stage === 'SIT_TO_CRAWL' && playing.kind === 'PLAYING') {
      if (playing.clip && isCrawlLoopClip(playing.clip)) this.stage = 'CRAWL';
      else if (playing.clip === 'SitToCrawl') {
        this.rollS += Math.max(0, dt);
        if (this.rollS >= SIT_TO_CRAWL_S || (progress ?? 0) >= SIT_TO_CRAWL_END_PROGRESS) this.stage = 'CRAWL';
      }
    }
    return this.stage;
  }
}
