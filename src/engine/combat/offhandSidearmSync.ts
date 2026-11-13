import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import type { GhoulZoneId, Vec3Like } from '../../contracts/ballistics.ts';
import { length, normalize, sub, vec3 } from '../../core/ballistics/vec3.ts';
import { DOWNED_FIRE_CONE_RAD } from '../../core/ai/woundedSequenceFsm.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import { isArmChainIntactAndFunctional, type ActiveFiringHand, type TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import type { OffhandSidearmRig } from './offhandSidearmTypes.ts';
import { CombatantWeaponGrip } from '../mannequin/combatantWeaponGrip.ts';
import { transitionPropAttachment } from '../mannequin/propAttachmentState.ts';
import { isSeatedAnimated, SEATED_PISTOL_VISIBLE_PROGRESS } from '../mannequin/combatantSeatedClips.ts';
import { DRAW_PISTOL_VISIBLE_PROGRESS, drawClipProgress } from '../mannequin/combatantDrawClips.ts';
import { applyAimDelta, combatantAimTarget } from '../mannequin/combatantAimDelta.ts';
import { SidearmFistGrip } from './sidearmFistGrip.ts';

// How fast the grip eases between the one-handed and the two-handed wrist bend when the aim clip
// changes, so the pistol does not snap round in the fist.
const GRIP_BLEND_RATE = 10;

/**
 * The backup pistol. Nothing here poses an arm: the draw and aim clips move the body, the pistol
 * rides the animated fist rigidly in every state (standing, one-handed, kneeling, seated, walking
 * under the upper-body aim layer), and the only correction is the shared aim delta, which turns
 * the chest and gun arm a few degrees toward the target and carries the sway and recoil.
 *
 * A living body on the ground in the ragdoll (face down) keeps the pistol holstered: it never
 * shoots from there.
 */
export class OffhandSidearmSync {
  private readonly grip = new CombatantWeaponGrip();
  private readonly fist = new SidearmFistGrip();
  private readonly twoHandBlend = new Map<string, number>();

  public sync(
    target: GhoulMannequinEntity,
    viewerWorldPos: Vec3Like,
    rig: OffhandSidearmRig,
    tacticalAi: Pick<TacticalCombatAiSystem, 'getSidearmVisualState'> | null,
    fxManager?: GoreAndBallisticsFxManager,
    dt?: number,
  ): boolean {
    const hs = target.healthState;
    const alive = hs.alive && hs.currentHp > 0;
    if (!alive) hs.weaponDropped = true;

    const sidearmState = tacticalAi?.getSidearmVisualState(hs.targetId);
    const hand: ActiveFiringHand | null = sidearmState?.hand ?? null;
    const armIntact = hand !== null && isArmChainIntactAndFunctional(hs, hand);
    const isAirborneRagdoll = hs.isRagdollActive && hs.posture === 'AIRBORNE_RAGDOLL';
    const faceDown = hs.isRagdollActive && !isAirborneRagdoll && alive;
    const glb = target.combatantGlb;
    const seated = isSeatedAnimated(hs);

    // A draw clip reaches round to the hip first: the pistol stays in the holster until the hand
    // gets there (DRAW_PISTOL_VISIBLE_PROGRESS through the clip), then rides the animated hand.
    // With no draw clip playing (the seated draw, or no animated body) the armament's own draw
    // timer stands in for the clip.
    const drawing = sidearmState?.drawing ?? false;
    const clipProgress = drawClipProgress(glb);
    const holstered =
      faceDown ||
      (clipProgress !== null
        ? clipProgress < DRAW_PISTOL_VISIBLE_PROGRESS
        : drawing && (sidearmState?.drawProgress ?? 1) < SEATED_PISTOL_VISIBLE_PROGRESS);
    const wantsSidearm = Boolean(sidearmState?.visible) && alive && armIntact && !holstered;
    const shouldBeAttached = wantsSidearm && !isAirborneRagdoll;
    const temporarilyHidden =
      (wantsSidearm && isAirborneRagdoll) ||
      (holstered && alive) ||
      (!wantsSidearm && alive && rig.attachmentState.kind === 'HIDDEN_TEMP' && rig.attachmentState.hand === undefined);

    // Only a pistol that was in a hand remembers that hand. A holstered one must stay handless, or
    // the next frame reads it as held-then-hidden and throws it on the floor as a dropped prop
    // before the body has even drawn it.
    const prevState = rig.attachmentState;
    const wasInHand = prevState.kind === 'ATTACHED' || (prevState.kind === 'HIDDEN_TEMP' && prevState.hand !== undefined);
    const transition = transitionPropAttachment(rig.attachmentState, {
      shouldBeAttached,
      temporarilyHidden,
      hand: holstered ? undefined : hand ?? (wasInHand ? rig.lastHand ?? undefined : undefined),
    });
    rig.attachmentState = transition.state;
    rig.wasHeldLastFrame = transition.isVisible;
    if ((transition.state.kind === 'ATTACHED' || transition.state.kind === 'HIDDEN_TEMP') && transition.state.hand) {
      rig.lastHand = transition.state.hand;
    }

    if (transition.shouldSpawnDroppedProp) {
      const dropHand = transition.dropHand ?? rig.lastHand;
      const dropZone: GhoulZoneId = dropHand === 'RIGHT' ? 'HAND_RIGHT' : 'HAND_LEFT';
      if (rig.glbInstance && fxManager) {
        fxManager.spawnDroppedWeaponProp('SKINHEAD_PUNK', rig.holderEntity.getPosition(), hs.ragdollBones[dropZone].velocity);
      }
    }

    if (!transition.isVisible || !hand) {
      rig.holderEntity.enabled = false;
      return false;
    }
    rig.holderEntity.enabled = true;

    const charFwd = vec3(Math.sin(hs.yawRad), 0, Math.cos(hs.yawRad));
    const handZone: GhoulZoneId = hand === 'RIGHT' ? 'HAND_RIGHT' : 'HAND_LEFT';
    const aimPoint =
      combatantAimTarget(hs.targetId) ??
      sidearmState?.aimTargetWorld ??
      vec3(viewerWorldPos.x, viewerWorldPos.y - 0.16, viewerWorldPos.z);
    let aimDir = normalize(sub(aimPoint, hs.ragdollBones[handZone].position));
    if (length(aimDir) < 1e-4) aimDir = charFwd;
    // Sitting its last stand it faces the way it sat down and never turns: the gun swings no
    // further round than the cone it may fire in (woundedSequenceFsm).
    if (seated) aimDir = clampToFacingCone(aimDir, hs.downedFacingWorld ?? charFwd, DOWNED_FIRE_CONE_RAD);

    const animatedHand = glb?.boneNodes.get(handZone);
    if (!glb || !animatedHand || !rig.glbInstance) {
      // No animated body (a headless run): the pistol sits on the hit skeleton's hand.
      if (rig.glbInstance) {
        this.grip.align(rig.holderEntity, rig.glbInstance.rootEntity, 'silver_talon_50ae', hs.ragdollBones[handZone].position, aimDir);
      }
      return true;
    }

    // PistolAim bends the wrist in toward the support hand; every other pistol clip holds the
    // gun one-handed down the forearm.
    const twoHandGoal =
      !seated && target.isPlayingPistolAim && isArmChainIntactAndFunctional(hs, oppositeSide(hand)) ? 1 : 0;
    const blend = this.easeTwoHand(hs.targetId, twoHandGoal, dt);
    // Drawn and aiming, the chest and arm turn the last few degrees onto the target and carry the
    // sway and recoil; mid-draw the clip alone moves the arm.
    const drawn = clipProgress === null && !drawing;
    applyAimDelta(
      glb, hs,
      { aimDirWorld: drawn ? aimDir : null, hand, weight: drawn ? 1 : 0, targetId: hs.targetId },
      dt ?? Number.POSITIVE_INFINITY,
      this.fist.barrelWorld(animatedHand, hand, blend),
    );
    this.fist.seat(rig.holderEntity, rig.glbInstance.rootEntity, animatedHand, hand, blend);
    // Two-handed, the support palm settles on the frame when the clip has it within reach.
    if (blend > 0.5) rig.hands?.sync(glb, hand, true);
    return true;
  }

  private easeTwoHand(targetId: string, goal: number, dt: number | undefined): number {
    const prev = this.twoHandBlend.get(targetId);
    const step = dt === undefined || !Number.isFinite(dt) ? 1 : 1 - Math.exp(-GRIP_BLEND_RATE * Math.max(0, dt));
    const next = prev === undefined ? goal : prev + (goal - prev) * step;
    this.twoHandBlend.set(targetId, next);
    return next;
  }
}

/**
 * Keeps a direction's flat heading within `coneRad` of `facing`, leaving its rise as it was.
 * Used so a seated shooter's aim agrees with the fire cone in `woundedSequenceFsm.ts`.
 */
export function clampToFacingCone(dir: Vec3Like, facing: Vec3Like, coneRad: number): Vec3Like {
  const flatLen = Math.hypot(dir.x, dir.z);
  const facingLen = Math.hypot(facing.x, facing.z);
  if (flatLen < 1e-4 || facingLen < 1e-4) return dir;
  const fx = facing.x / facingLen;
  const fz = facing.z / facingLen;
  const heading = Math.atan2(dir.x / flatLen, dir.z / flatLen);
  const facingHeading = Math.atan2(fx, fz);
  let off = heading - facingHeading;
  while (off > Math.PI) off -= Math.PI * 2;
  while (off < -Math.PI) off += Math.PI * 2;
  if (Math.abs(off) <= coneRad) return dir;
  const kept = facingHeading + Math.sign(off) * coneRad;
  return vec3(Math.sin(kept) * flatLen, dir.y, Math.cos(kept) * flatLen);
}
