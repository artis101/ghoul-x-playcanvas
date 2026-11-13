import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import * as pc from 'playcanvas';
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
import { armsClipName, CombatantWeaponHands } from './combatantWeaponHands.ts';
import { CombatantPistolHold } from './combatantPistolHold.ts';
import { gunKindOf, isOneHandPistolClip } from './combatantWeaponPoseMap.ts';
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
import { CombatantWeaponGrip, GRIPPED_LONG_GUN_CLIPS, M4A1_PALM_OFFSET_X } from './combatantWeaponGrip.ts';
import { isWoundClip } from './combatantWoundClips.ts';
import { applyAimDelta, barrelForward, combatantAimTarget, isPlayingAimClip } from './combatantAimDelta.ts';
import { animatedBarrelDirection } from './combatantGunHeading.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';
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
  private readonly pistol = new CombatantPistolHold();
  private readonly gunInHand = new pc.Vec3();
  private readonly gunInHandRotation = new pc.Quat();
  private readonly handInverse = new pc.Quat();
  private readonly scratch = new pc.Vec3();

  public get wasWeaponHeld(): boolean {
    return this.attachmentState.kind === 'ATTACHED';
  }

  public reset(): void {
    this.attachmentState = createPropAttachmentState('ATTACHED');
    this.pistol.reset();
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

      const clip = glb?.animComponent?.baseLayer?.activeState;
      // A flinch plays out after its reaction ends; until it does, the clip's arms own the pose.
      const woundClipPlaying = clip !== undefined && isWoundClip(clip.replace('_Southpaw', ''));
      // A hurt body (stagger, gut, throat) may still raise its gun from HurtIdle once its reaction
      // and flinch clip are over; it aims, sways and recoils like a ready one while it does.
      const aimClip = glb !== null && isPlayingAimClip(glb);
      const steady =
        (healthState.posture === 'COMBAT_READY' || aimClip) && healthState.activeReaction.type === 'NONE' &&
        !woundClipPlaying && !isSeatedAnimated(healthState);
      const supportArmIntact = isArmChainIntactAndFunctional(healthState, supportHand);
      // A one-handed pistol clip has the other forearm tucked in: no hand goes to the gun.
      const oneHandClip = glb !== null && isOneHandPistolClip(armsClipName(glb));
      const canUseSupport = steady && weaponId !== 'frag_grenade' && supportArmIntact && !oneHandClip;
      const isPistol = gunKindOf(weaponId) === 'PISTOL';
      // The gun rides the animated trigger palm in every state. Its barrel comes from the animated
      // chest and forearm (see combatantGunHeading: the takes' wrist roll cannot aim a gun), and
      // leans toward the support palm when the clip has that hand out on the forend.
      if (glbTrigNode) {
        const pT = glbTrigNode.getPosition();
        const uT = glbTrigNode.up;
        palmTrig = vec3(pT.x + uT.x * 0.052, pT.y + uT.y * 0.052, pT.z + uT.z * 0.052);

        const elbow = glb?.boneNodes.get(`FOREARM_${triggerHand}`)?.getPosition();
        const forearm = elbow ? normalize(vec3(pT.x - elbow.x, pT.y - elbow.y, pT.z - elbow.z)) : uT;
        gunFwd = animatedBarrelDirection(glb ?? null, forearm, charFwd);

        if (canUseSupport && !isPistol && glbSuppNode) {
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
      // A clip the Blender grip pass baked with the hands on a long gun holds it rigidly in the
      // trigger fist (combatantWeaponGrip.ts GRIPPED_LONG_GUN_CLIPS).
      const gripped = glb !== null && glbTrigNode !== undefined && !isPistol && !woundClipPlaying &&
        GRIPPED_LONG_GUN_CLIPS.has(armsClipName(glb) ?? '');
      if (isPistol && glb && glbTrigNode && CombatantPistolHold.ownsGun(glb)) {
        // A Desert Eagle in a pistol clip sits rigidly in the fist, like the backup pistol.
        this.pistol.seat(this.heldWeaponNode, glb, glbTrigNode, triggerHand, supportArmIntact, dt);
      } else if (gripped && glbTrigNode) {
        this.grip.seatInFist(this.heldWeaponNode, this.heldWeaponNode, weaponId, glbTrigNode, triggerHand);
      } else {
        this.grip.align(this.heldWeaponNode, this.heldWeaponNode, weaponId, palmTrig, gunFwd, triggerOffset);
      }
      if (glb && glbTrigNode) {
        const aiming = steady && sidearmHand === null && aimClip;
        this.aimTowardTarget(glb, healthState, glbTrigNode, triggerHand, aiming, dt);
      }
      if (glb) this.hands?.sync(glb, triggerHand, canUseSupport, dt, supportArmIntact, gripped);
    }
  }

  /**
   * Turns the chest and gun arm by the small aim delta (toward the published aim point, plus the
   * sway and recoil the bullets use), then re-glues the gun rigidly to the turned hand, so the
   * barrel the player sees is the line the bullet leaves along.
   */
  private aimTowardTarget(
    glb: CombatantGlbInstance,
    healthState: TargetHealthState,
    hand: pc.GraphNode,
    triggerHand: 'RIGHT' | 'LEFT',
    aiming: boolean,
    dt: number | undefined,
  ): void {
    const gun = this.heldWeaponNode;
    if (!gun) return;
    // Remember where the gun sits in the fist before the arm turns.
    this.handInverse.copy(hand.getRotation()).invert();
    this.handInverse.transformVector(this.scratch.sub2(gun.getPosition(), hand.getPosition()), this.gunInHand);
    this.gunInHandRotation.mul2(this.handInverse, gun.getRotation());

    const muzzle = gun.getPosition();
    const target = aiming ? combatantAimTarget(healthState.targetId) : null;
    const aimDirWorld = target ? normalize(sub(target, vec3(muzzle.x, muzzle.y, muzzle.z))) : null;
    applyAimDelta(glb, healthState, {
      aimDirWorld, hand: triggerHand, weight: aiming ? 1 : 0, targetId: healthState.targetId,
    }, dt ?? Number.POSITIVE_INFINITY, barrelForward(gun));

    const turned = hand.getRotation();
    turned.transformVector(this.gunInHand, this.scratch).add(hand.getPosition());
    gun.setPosition(this.scratch);
    gun.setRotation(this.handInverse.mul2(turned, this.gunInHandRotation));
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
