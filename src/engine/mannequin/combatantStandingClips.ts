import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantAnimationClipName } from '../assets/glbTypes.ts';
import { weaponPickupProgress } from '../ai/weaponRecovery.ts';
import type { CombatantMovementClip } from './combatantLocomotion.ts';
import { isFallingClip, isStumpClutchClip } from './combatantWoundClips.ts';
import type { UpperBodyClip, UpperBodyRequest } from './combatantUpperBodyLayer.ts';

/**
 * What a standing body plays when no wound, phase, draw or seated clip owns it: the idle for its
 * state (ready, guarding, hurt, empty-handed, clutching a stump), the gait when it moves, the aim
 * when it aims, and which of those goes on the upper-body layer.
 */

type Has = (clip: CombatantAnimationClipName) => boolean;

/** The falls end seated; the roll onto the belly starts once one is this far through. */
const COLLAPSE_END_PROGRESS = 0.97;
const SIT_TO_CRAWL_END_PROGRESS = 0.97;
/** The pickup clip hands the body back this far through: its last frames are the ready idle. */
export const PICKUP_END_PROGRESS = 0.97;
/** A pickup whose progress has not moved for this long was abandoned by the AI. */
const PICKUP_STALL_S = 0.3;

/** Idles a body can walk, run or strafe out of. */
const MOBILE_IDLES: ReadonlySet<string> = new Set<CombatantAnimationClipName>([
  'CombatReadyIdle', 'UnsuspectingIdle', 'HurtIdle', 'UnarmedIdle', 'StumpClutchRight', 'StumpClutchLeft',
  'PistolOneHandHold',
]);

/**
 * Idles that can raise a gun: the ready stance, the one-handed pistol carry, a hurt body and a
 * stump clutch with a drawn pistol.
 */
export function canAimFrom(baseClip: CombatantAnimationClipName): boolean {
  return baseClip === 'CombatReadyIdle' || baseClip === 'PistolOneHandHold' || baseClip === 'HurtIdle' ||
    isStumpClutchClip(baseClip);
}

export function canMoveFrom(baseClip: CombatantAnimationClipName): boolean {
  return MOBILE_IDLES.has(baseClip);
}

/**
 * True when the body holds no gun at all: the primary is on the floor and no pistol is out or
 * coming out. `pistolHand` is the hand of a sidearm the AI says is visible.
 */
export function isEmptyHanded(hs: TargetHealthState, pistolHand?: 'RIGHT' | 'LEFT'): boolean {
  if (!hs.weaponDropped || pistolHand) return false;
  const tag = hs.combatantStatusTag;
  return tag !== 'SIDEARM_DRAWING' && tag !== 'SIDEARM_DRAWN' && tag !== 'LAST_STAND' && tag !== 'RUSHING';
}

/**
 * The gait clip for a move out of `baseClip`. A hurt body walks hunched (HurtWalk) and an empty-
 * handed one swings its arms (UnarmedWalk, UnarmedRun); for the other directions the armed gait
 * plays and the upper layer carries the hurt or empty-handed arms.
 */
export function gaitClipFor(
  baseClip: CombatantAnimationClipName,
  gait: CombatantMovementClip['clip'],
  has: Has,
): CombatantAnimationClipName {
  if (baseClip === 'HurtIdle' && gait === 'Walk' && has('HurtWalk')) return 'HurtWalk';
  if (baseClip === 'UnarmedIdle') {
    if (gait === 'Walk' && has('UnarmedWalk')) return 'UnarmedWalk';
    if (gait === 'Run' && has('UnarmedRun')) return 'UnarmedRun';
  }
  return gait;
}

/**
 * The upper-layer clip for a moving body, or null when the gait clip already shows the arms
 * right. Aiming always goes up top; otherwise a stump clutch, a hurt carry or empty hands do
 * when the gait clip is an armed one.
 */
export function upperClipFor(
  baseClip: CombatantAnimationClipName,
  gaitClip: CombatantAnimationClipName,
  aimClip: CombatantAnimationClipName | undefined,
): UpperBodyClip | null {
  if (aimClip === 'LongGunAim' || aimClip === 'PistolAim' || aimClip === 'PistolAimOneHand') return aimClip;
  // The kneeling aim has no standing upper half; the one-handed standing aim stands in.
  if (aimClip === 'KneelPistolAimOneHand') return 'PistolAimOneHand';
  if (aimClip) return 'CombatReadyIdle';
  if (baseClip === 'StumpClutchRight' || baseClip === 'StumpClutchLeft') return baseClip;
  // A pistol carried in one hand: the gait's arms would hold a missing forend.
  if (baseClip === 'PistolOneHandHold') return baseClip;
  if (baseClip === 'HurtIdle' && gaitClip !== 'HurtWalk') return 'HurtIdle';
  if (baseClip === 'UnarmedIdle' && gaitClip !== 'UnarmedWalk' && gaitClip !== 'UnarmedRun') return 'UnarmedIdle';
  return null;
}

/** Builds the upper request, mirrored for a left-handed body or a pistol in the left hand. */
export function upperRequest(clip: UpperBodyClip | null, southpaw: boolean): UpperBodyRequest | null {
  return clip ? { clip, southpaw } : null;
}

/**
 * A body left on its seat with its legs gone (LEG_BUCKLED) and no seated or crawl plan: the fall
 * plays out, then the roll onto the belly, then the crawl. With nothing played yet it sits down.
 */
export function legBuckledClip(
  prev: { readonly kind: string; readonly clip?: CombatantAnimationClipName },
  progress: number | undefined,
  has: Has,
): CombatantAnimationClipName {
  const p = progress ?? 1;
  if (prev.kind === 'PLAYING' && prev.clip) {
    if (prev.clip === 'Crawl') return 'Crawl';
    if (prev.clip === 'SitToCrawl') return p < SIT_TO_CRAWL_END_PROGRESS ? 'SitToCrawl' : 'Crawl';
    if (isFallingClip(prev.clip)) {
      if (p < COLLAPSE_END_PROGRESS) return prev.clip;
      return has('SitToCrawl') ? 'SitToCrawl' : 'Crawl';
    }
  }
  return 'DownedCollapse';
}

/**
 * Whether the body plays `PickupWeapon` this frame. It starts when the AI reaches for the gun
 * (weaponRecovery.ts), keeps going once the gun is back in hand until the body has stood up, and
 * stops if the AI gives up (no progress for a moment) or the gun is lost again.
 */
export class PickupClipTracker {
  private lastProgress: number | null = null;
  private stallS = 0;

  public reset(): void {
    this.lastProgress = null;
    this.stallS = 0;
  }

  public wants(
    hs: TargetHealthState,
    playing: CombatantAnimationClipName | null,
    progress: number | undefined,
    dt: number,
  ): boolean {
    const reaching = weaponPickupProgress(hs);
    if (reaching === null) {
      this.reset();
      // Gun in hand: let the clip finish standing back up.
      return playing === 'PickupWeapon' && !hs.weaponDropped && (progress ?? 1) < PICKUP_END_PROGRESS;
    }
    if (!hs.weaponDropped) return false;
    if (reaching !== this.lastProgress) {
      this.lastProgress = reaching;
      this.stallS = 0;
    } else {
      this.stallS += Math.max(0, dt);
    }
    return this.stallS < PICKUP_STALL_S;
  }
}
