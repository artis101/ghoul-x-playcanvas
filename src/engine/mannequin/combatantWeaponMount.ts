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
import { CombatantWeaponGrip } from './combatantWeaponGrip.ts';
import {
  createPropAttachmentState,
  transitionPropAttachment,
  type PropAttachmentState,
} from './propAttachmentState.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';

export class CombatantWeaponMount {
  public heldWeaponNode: pc.Entity | null = null;
  public heldWeaponGlb: WeaponGlbInstance | null = null;
  public attachmentState: PropAttachmentState<'LEFT' | 'RIGHT'> = createPropAttachmentState('ATTACHED');
  private hands: CombatantWeaponHands | null = null;
  private readonly grip = new CombatantWeaponGrip();

  public get wasWeaponHeld(): boolean {
    return this.attachmentState.kind === 'ATTACHED';
  }

  public reset(): void {
    this.attachmentState = createPropAttachmentState('ATTACHED');
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
    guarding = false
  ): void {
    const triggerHand = getPreferredPrimaryHand(healthState);
    const supportHand = triggerHand === 'LEFT' ? 'RIGHT' : 'LEFT';
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
      fxManager.spawnDroppedWeaponProp(
        healthState.archetype,
        dropPos,
        trigBone.velocity
      );
    }

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

      const canUseSupport =
        healthState.posture === 'COMBAT_READY' && healthState.activeReaction.type === 'NONE' &&
        weaponId !== 'frag_grenade' &&
        isArmChainIntactAndFunctional(healthState, supportHand);
      if (glbTrigNode) {
        const pT = glbTrigNode.getPosition();
        const uT = glbTrigNode.up;
        palmTrig = vec3(pT.x + uT.x * 0.052, pT.y + uT.y * 0.052, pT.z + uT.z * 0.052);

        const handAim = vec3(uT.x, uT.y * 0.35, uT.z);
        gunFwd = normalize(add(scale(handAim, 0.32), scale(charFwd, 0.68)));

        if (canUseSupport && weaponId !== 'silver_talon_50ae' && glbSuppNode) {
          const pS = glbSuppNode.getPosition();
          const uS = glbSuppNode.up;
          const palmSupp = vec3(pS.x + uS.x * 0.05, pS.y + uS.y * 0.05, pS.z + uS.z * 0.05);
          const aimSpan = sub(palmSupp, add(palmTrig, vec3(0, forendRiseOffset, 0)));
          if (length(aimSpan) > 0.08 && (guarding || dot(aimSpan, charFwd) > 0.07)) {
            gunFwd = normalize(aimSpan);
          }
        }
      } else {
        const handTrig = healthState.ragdollBones[triggerHandZone];
        palmTrig = add(handTrig.position, scale(handTrig.basisForward, 0.045));
        gunFwd = normalize(charFwd);
      }

      this.grip.align(this.heldWeaponNode, this.heldWeaponNode, weaponId, palmTrig, gunFwd);
      if (glb) this.hands?.sync(glb, triggerHand, canUseSupport);
    }
  }

  public playFire(): Vec3Like | undefined {
    const weapon = this.heldWeaponGlb;
    if (!weapon?.rootEntity.enabled) return undefined;
    weapon.playFire?.();
    return weapon.muzzleNode?.getPosition();
  }

  public destroy(): void {
    this.heldWeaponGlb?.destroy();
    this.heldWeaponGlb = null;
    this.heldWeaponNode = null;
    this.hands = null;
  }
}
