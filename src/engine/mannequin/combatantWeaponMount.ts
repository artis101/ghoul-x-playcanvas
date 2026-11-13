import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import type * as pc from 'playcanvas';
import type {
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../../contracts/ballistics.ts';
import {
  add,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from '../../core/ballistics/vec3.ts';
import {
  getArchetypeWeaponAssetId,
  type CombatantGlbInstance,
  type GlbModelRegistry,
  type WeaponAssetId,
  type WeaponGlbInstance,
} from '../assets/glbLoader.ts';
import { getPreferredPrimaryHand, isArmChainIntactAndFunctional } from '../ai/combatantArmEvaluation.ts';
import { CombatantWeaponHands } from './combatantWeaponHands.ts';
import { RELOAD_ANIM_SPEED, reloadDurationS } from '../../core/ballistics/weapons/weaponHandling.ts';

/**
 * Plays a held gun's reload clip at the player's reload speed and returns the reload time the
 * player would get from the same clip.
 */
export function playWeaponReloadClip(glb: WeaponGlbInstance | null | undefined): number | undefined {
  if (!glb) return undefined;
  if (glb.rootEntity.enabled) glb.playReload(RELOAD_ANIM_SPEED);
  return reloadDurationS(glb.getClipDuration(glb.reloadClipName));
}
import { CombatantWeaponGrip, M4A1_PALM_OFFSET_X } from './combatantWeaponGrip.ts';
import { CombatantWeaponHold } from './combatantWeaponHold.ts';
import { isOneHandedStance } from '../../core/ghoul/anatomy/weaponHold.ts';
import { resolveWeaponHoldStance } from './combatantWeaponStance.ts';
import { CombatantUnarmedArms } from './combatantUnarmedArms.ts';
import { CombatantAimHead } from './combatantAimHead.ts';
import {
  createPropAttachmentState,
  transitionPropAttachment,
  type PropAttachmentState,
} from './propAttachmentState.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';

function smoothGripWeight(value: number, minimum: number, fullWeight: number): number {
  const t = Math.min(1, Math.max(0, (value - minimum) / (fullWeight - minimum)));
  return t * t * (3 - 2 * t);
}

export class CombatantWeaponMount {
  public heldWeaponNode: pc.Entity | null = null;
  public heldWeaponGlb: WeaponGlbInstance | null = null;
  public attachmentState: PropAttachmentState<'RIGHT' | 'LEFT'> = createPropAttachmentState('ATTACHED');
  /** The gun lying on the floor after a disarm, until the combatant picks it back up. */
  private droppedProp: pc.Entity | null = null;
  private hands: CombatantWeaponHands | null = null;
  private readonly grip = new CombatantWeaponGrip();
  private readonly hold = new CombatantWeaponHold();
  private readonly unarmed = new CombatantUnarmedArms();
  private readonly aimHead = new CombatantAimHead();

  public get wasWeaponHeld(): boolean {
    return this.attachmentState.kind === 'ATTACHED';
  }

  public reset(): void {
    this.attachmentState = createPropAttachmentState('ATTACHED');
    this.unarmed.reset();
    this.aimHead.reset();
    if (this.heldWeaponNode) {
      this.heldWeaponNode.enabled = true;
    }
  }

  public attachGlbWeaponIfReady(
    glbRegistry: GlbModelRegistry,
    healthState: TargetHealthState,
    rootEntity: pc.Entity,
    weaponAssetId: WeaponAssetId = getArchetypeWeaponAssetId(healthState.archetype)
  ): void {
    if (this.heldWeaponGlb) return;
    if (!glbRegistry.isLoaded(weaponAssetId)) return;

    try {
      const wInst = glbRegistry.instantiateWeapon(weaponAssetId, {
        castShadows: true,
        receiveShadows: true,
      });
      if (wInst.animComponent) {
        wInst.animComponent.playing = false;
      }
      this.heldWeaponGlb = wInst;
      this.hands = new CombatantWeaponHands(wInst);
      this.heldWeaponNode = wInst.rootEntity;
      this.heldWeaponNode.enabled = this.attachmentState.kind === 'ATTACHED';
      rootEntity.addChild(this.heldWeaponNode);
    } catch {
      // headless test environment
    }
  }

  public syncWeaponPosition(
    healthState: TargetHealthState,
    glb: CombatantGlbInstance | null,
    fxManager?: GoreAndBallisticsFxManager,
    guarding = false,
    dt?: number,
    /** The hand holding a drawn backup sidearm, if any; that arm is posed by the sidearm sync. */
    sidearmHand: 'RIGHT' | 'LEFT' | null = null
  ): void {
    const triggerHand = getPreferredPrimaryHand(healthState);
    const supportHand = oppositeSide(triggerHand);
    const triggerHandZone: GhoulZoneId = `HAND_${triggerHand}`;
    const supportHandZone: GhoulZoneId = `HAND_${supportHand}`;

    const armIntact = isArmChainIntactAndFunctional(healthState, triggerHand);
    const shouldHoldWeapon =
      !healthState.weaponDropped &&
      healthState.alive &&
      healthState.currentHp > 0 &&
      !healthState.isRagdollActive &&
      armIntact;

    const temporarilyHidden =
      !shouldHoldWeapon &&
      !healthState.weaponDropped &&
      healthState.alive &&
      healthState.currentHp > 0 &&
      armIntact &&
      healthState.isRagdollActive &&
      healthState.posture === 'AIRBORNE_RAGDOLL';

    const transition = transitionPropAttachment(this.attachmentState, {
      shouldBeAttached: shouldHoldWeapon,
      temporarilyHidden,
      hand: triggerHand,
      allowReattachAfterDrop: shouldHoldWeapon,
    });
    this.attachmentState = transition.state;

    if (transition.shouldSpawnDroppedProp && fxManager && this.heldWeaponNode) {
      const trigBone = healthState.ragdollBones[triggerHandZone];
      const dropPos = this.heldWeaponNode.getPosition();
      this.droppedProp = fxManager.spawnDroppedWeaponProp(
        healthState.archetype,
        dropPos,
        trigBone.velocity
      );
    }
    this.trackDroppedProp(healthState);

    if (this.heldWeaponNode) {
      this.heldWeaponNode.enabled = transition.isVisible;
    }

    const armed = transition.isVisible && this.heldWeaponNode !== null;
    // With the long gun gone, an empty arm hangs free instead of gripping a gun that is not there.
    // A drawn sidearm keeps its own arm; only the other one is let go.
    if (glb && !armed) {
      this.unarmed.sync(glb, healthState, true, dt, sidearmHand ? oppositeSide(sidearmHand) : undefined);
    }

    if (transition.isVisible && this.heldWeaponNode) {
      const charFwd = vec3(
        Math.sin(healthState.yawRad),
        0,
        Math.cos(healthState.yawRad)
      );
      const weaponId =
        this.heldWeaponGlb?.weaponId ?? getArchetypeWeaponAssetId(healthState.archetype);
      const forendRiseOffset =
        weaponId === 'msg90_sniper' ? 0.07 : weaponId === 'm590_shotgun' ? 0.044 : 0.032;

      let palmTrig: Vec3Like;
      let gunFwd: Vec3Like;

      const glbTrigNode = glb?.boneNodes.get(triggerHandZone);
      const glbSuppNode = glb?.boneNodes.get(supportHandZone);

      const canUseSupport =
        healthState.posture === 'COMBAT_READY' && healthState.activeReaction.type === 'NONE' &&
        weaponId !== 'frag_grenade' &&
        isArmChainIntactAndFunctional(healthState, supportHand);
      const clip = glb?.animComponent?.baseLayer?.activeState;
      const stance = canUseSupport ? resolveWeaponHoldStance(weaponId, clip, guarding) : null;
      const supportGrip = glb && stance
        ? this.hold.place(this.heldWeaponNode, glb, weaponId, stance, triggerHand, dt)
        : null;
      const oneHanded = stance !== null && isOneHandedStance(stance);
      if (glb) this.unarmed.sync(glb, healthState, oneHanded, dt, supportHand);
      if (glb && supportGrip) {
        this.hands?.syncHold(glb, triggerHand, supportGrip, oneHanded);
        const aiming = stance === 'SHOULDERED' || stance === 'PISTOL_AIM';
        this.aimHead.sync(glb, aiming ? this.heldWeaponNode.forward : null, dt);
        return;
      }
      this.hold.release();
      if (glb) this.aimHead.sync(glb, null, dt);
      const twoHandReadyIdle = canUseSupport && weaponId !== 'silver_talon_50ae' &&
        (clip === 'CombatReadyIdle' || clip === 'CombatReadyIdle_Southpaw');
      if (glbTrigNode) {
        const pT = glbTrigNode.getPosition();
        const uT = glbTrigNode.up;
        palmTrig = vec3(pT.x + uT.x * 0.052, pT.y + uT.y * 0.052, pT.z + uT.z * 0.052);

        const handAim = vec3(uT.x, uT.y * 0.35, uT.z);
        gunFwd = normalize(add(scale(handAim, 0.32), scale(charFwd, 0.68)));

        if (canUseSupport && weaponId !== 'silver_talon_50ae' && glbSuppNode) {
          if (twoHandReadyIdle) {
            // Keep the forend within reach across the body when the authored palms are close.
            const across = supportHand === 'LEFT' ? 0.9 : -0.9;
            gunFwd = normalize(add(gunFwd, vec3(charFwd.z * across, 0.12, -charFwd.x * across)));
          }
          const pS = glbSuppNode.getPosition();
          const uS = glbSuppNode.up;
          const palmSupp = vec3(pS.x + uS.x * 0.05, pS.y + uS.y * 0.05, pS.z + uS.z * 0.05);
          const aimSpan = sub(palmSupp, add(palmTrig, vec3(0, forendRiseOffset, 0)));
          // Fade out the support-hand aim as the authored palms approach each other or cross.
          const reachWeight = smoothGripWeight(length(aimSpan), 0.08, 0.18);
          const forwardWeight = guarding ? 1 : smoothGripWeight(dot(aimSpan, charFwd), 0.07, 0.23);
          const supportWeight = reachWeight * forwardWeight;
          gunFwd = normalize(add(scale(gunFwd, 1 - supportWeight), scale(normalize(aimSpan), supportWeight)));
        }
      } else {
        const handTrig = healthState.ragdollBones[triggerHandZone];
        palmTrig = add(handTrig.position, scale(handTrig.basisForward, 0.045));
        gunFwd = normalize(charFwd);
      }

      const triggerOffset = weaponId === 'm4a1_carbine' && canUseSupport
        ? (triggerHand === 'RIGHT' ? M4A1_PALM_OFFSET_X : -M4A1_PALM_OFFSET_X)
        : 0;
      this.grip.align(this.heldWeaponNode, this.heldWeaponNode, weaponId, palmTrig, gunFwd, triggerOffset);
      if (glb) this.hands?.sync(glb, triggerHand, canUseSupport, twoHandReadyIdle);
    }
  }

  /** Starts the gun's reload clip; returns how long the reload takes. */
  public playReload(): number | undefined {
    return playWeaponReloadClip(this.heldWeaponGlb);
  }

  public playFire(): Vec3Like | undefined {
    const weapon = this.heldWeaponGlb;
    if (!weapon?.rootEntity.enabled) return undefined;
    weapon.playFire?.();
    return weapon.muzzleNode?.getPosition();
  }

  /** Publishes where the dropped gun lies for the AI, and hides it once the AI has picked it up. */
  private trackDroppedProp(healthState: TargetHealthState): void {
    const prop = this.droppedProp;
    if (!prop) return;
    if (!healthState.alive || !prop.parent) {
      healthState.droppedWeaponWorld = undefined;
      this.droppedProp = null;
      return;
    }
    if (!healthState.weaponDropped) {
      prop.enabled = false;
      healthState.droppedWeaponWorld = undefined;
      this.droppedProp = null;
      return;
    }
    const p = prop.getPosition();
    healthState.droppedWeaponWorld = { x: p.x, y: p.y, z: p.z };
  }

  public destroy(): void {
    this.heldWeaponGlb?.destroy();
    this.heldWeaponGlb = null;
    this.heldWeaponNode = null;
    this.hands = null;
  }
}
