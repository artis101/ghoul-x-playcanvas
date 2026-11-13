import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';
import type { CombatantAnimationClipName, CombatantGlbInstance } from '../assets/glbTypes.ts';
import { lostArmSide } from './combatantWoundClips.ts';
import { PHASE_BLEND_S, type WoundedPhaseClipPlan } from './combatantWoundedPhaseClips.ts';

/**
 * The authored sidearm draws (docs/procedural-animation-audit.md, A2). The clip moves the whole
 * body, hand to the holster and up to the aim, so nothing poses the arm by code while it plays:
 * the pistol is holstered until `DRAW_PISTOL_VISIBLE_PROGRESS`, then rides the animated fist.
 *
 * - Standing, both arms: `PistolDraw` (the `_Southpaw` twin draws with the left hand).
 * - Standing with an arm cut short (BLAZE, or still clutching): `StumpDraw<lost side>`, which
 *   starts from the stump clutch and ends near the one-handed aim.
 * - Kneeling (KNEEL_FIRE): `KneelStumpDraw<lost side>`, from the last stump-kneel frame to the
 *   kneeling one-handed aim.
 * - Seated: `SeatedPistolDraw`, owned by combatantSeatedClips.ts.
 */

type ArmSide = 'RIGHT' | 'LEFT';

/** The pistol shows in the hand from this far through a draw clip; before that it is holstered. */
export const DRAW_PISTOL_VISIBLE_PROGRESS = 0.45;

/** Clip lengths at speed 1, as baked. The armament's draw should last exactly this long. */
export const PISTOL_DRAW_S = 1.57;
export const STUMP_DRAW_S = 1.97;
export const KNEEL_STUMP_DRAW_S = 1.77;

const DRAW_CLIPS: ReadonlySet<string> = new Set<CombatantAnimationClipName>([
  'PistolDraw', 'StumpDrawRight', 'StumpDrawLeft', 'KneelStumpDrawRight', 'KneelStumpDrawLeft',
]);

export function isDrawClip(clip: string): boolean {
  return DRAW_CLIPS.has(clip.replace(/_Southpaw$/, ''));
}

const sideName = (side: ArmSide): 'Right' | 'Left' => (side === 'RIGHT' ? 'Right' : 'Left');
const otherSide = (side: ArmSide): ArmSide => (side === 'RIGHT' ? 'LEFT' : 'RIGHT');

/** The kneeling draw is used from the kneel-down on; a standing body uses the standing ones. */
function isKneeling(hs: TargetHealthState): boolean {
  return hs.woundedPhase === 'KNEEL_FIRE' || hs.woundedPhase === 'KNEEL_DOWN';
}

/**
 * The arm the draw clip treats as lost: the stump, or else the arm that is not drawing, so a
 * kneeling body with two arms still reaches with the right one.
 */
function drawStumpSide(hs: TargetHealthState, hand: ArmSide | undefined): ArmSide | null {
  const lost = lostArmSide(hs);
  if (lost) return lost;
  return isKneeling(hs) ? otherSide(hand ?? (hs.isLeftHanded ? 'LEFT' : 'RIGHT')) : null;
}

/**
 * How long the draw takes for this body, the length of the clip it will play. The armament FSM
 * should use this as its draw duration so the pistol comes out on the frame the clip shows it.
 * Seated draws keep their own timing (`SEATED_DRAW_S`).
 */
export function drawClipSecondsFor(hs: TargetHealthState): number {
  if (isKneeling(hs)) return KNEEL_STUMP_DRAW_S;
  return lostArmSide(hs) ? STUMP_DRAW_S : PISTOL_DRAW_S;
}

/**
 * The draw clip for this frame, or null when the body is not drawing (or is seated, where the
 * seated clips draw). `hand` is the hand the pistol comes out in, when the AI has said so.
 */
export function drawClipPlan(hs: TargetHealthState, hand: ArmSide | undefined): WoundedPhaseClipPlan | null {
  if (hs.combatantStatusTag !== 'SIDEARM_DRAWING' || isSeatedAnimated(hs)) return null;
  // The kneel-down, the sit-down and the crawl finish their own clips; none of them draws.
  const phase = hs.woundedPhase;
  if (phase === 'KNEEL_DOWN' || phase === 'SIT_DOWN' || phase === 'DOWNED_CRAWL') return null;
  const stump = drawStumpSide(hs, hand);
  if (isKneeling(hs) && stump) {
    const draw: CombatantAnimationClipName = `KneelStumpDraw${sideName(stump)}`;
    const kneel: CombatantAnimationClipName = `StumpKneel${sideName(stump)}`;
    return { chain: [draw, kneel], blendS: PHASE_BLEND_S, owner: null, southpaw: false, crawl: false };
  }
  if (stump) {
    const draw: CombatantAnimationClipName = `StumpDraw${sideName(stump)}`;
    const clutch: CombatantAnimationClipName = `StumpClutch${sideName(stump)}`;
    return { chain: [draw, clutch], blendS: PHASE_BLEND_S, owner: null, southpaw: false, crawl: false };
  }
  const drawHand = hand ?? (hs.isLeftHanded ? 'LEFT' : 'RIGHT');
  return { chain: ['PistolDraw', 'CombatReadyIdle'], blendS: PHASE_BLEND_S, owner: null, southpaw: drawHand === 'LEFT', crawl: false };
}

type LayerGlb = Pick<CombatantGlbInstance, 'animComponent'>;

/** True while the body's base layer is playing one of the draw clips. */
export function isDrawClipPlaying(glb: LayerGlb | null | undefined): boolean {
  const state = glb?.animComponent?.baseLayer?.activeState;
  return typeof state === 'string' && isDrawClip(state);
}

/**
 * How far through its draw clip the body is, 0..1, or null when no draw clip plays. Read this
 * instead of the armament's timer for anything visible (when the pistol leaves the holster).
 */
export function drawClipProgress(glb: LayerGlb | null | undefined): number | null {
  if (!isDrawClipPlaying(glb)) return null;
  const progress = glb?.animComponent?.baseLayer?.activeStateProgress ?? 0;
  return Math.max(0, Math.min(1, progress));
}

/**
 * Playback speed that makes a draw clip last exactly `drawClipSecondsFor`, so it stays on the
 * armament's clock even if a rebake changes its length by a frame or two.
 */
export function drawPlaybackSpeed(hs: TargetHealthState, clipDurationS: number | undefined): number {
  if (!(clipDurationS && clipDurationS > 0)) return 1;
  return Math.max(0.5, Math.min(2, clipDurationS / drawClipSecondsFor(hs)));
}
