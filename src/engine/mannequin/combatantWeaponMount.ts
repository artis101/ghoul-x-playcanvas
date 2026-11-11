import * as pc from 'playcanvas';
import {
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../../contracts/ballistics.ts';
import {
  add,
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
  type WeaponGlbInstance,
} from '../assets/glbLoader.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';

export class CombatantWeaponMount {
  public heldWeaponNode: pc.Entity | null = null;
  public heldWeaponGlb: WeaponGlbInstance | null = null;
  private wasWeaponHeld = true;

  public attachGlbWeaponIfReady(
    glbRegistry: GlbModelRegistry,
    healthState: TargetHealthState,
    rootEntity: pc.Entity
  ): void {
    if (this.heldWeaponGlb) return;
    const weaponAssetId = getArchetypeWeaponAssetId(healthState.archetype);
    if (!glbRegistry.isLoaded(weaponAssetId)) return;

    try {
      const wInst = glbRegistry.instantiateWeapon(weaponAssetId, {
        castShadows: false,
        receiveShadows: true,
      });
      if (wInst.animComponent) {
        wInst.animComponent.playing = false;
      }
      if (this.heldWeaponNode) {
        this.heldWeaponNode.destroy();
      }
      this.heldWeaponGlb = wInst;
      this.heldWeaponNode = wInst.rootEntity;
      this.heldWeaponNode.enabled = this.wasWeaponHeld;
      rootEntity.addChild(this.heldWeaponNode);
    } catch {
      // headless test environment
    }
  }

  public syncWeaponPosition(
    healthState: TargetHealthState,
    glb: CombatantGlbInstance | null,
    fxManager?: GoreAndBallisticsFxManager
  ): void {
    const isSouthpaw = healthState.isLeftHanded;
    const triggerHandZone: GhoulZoneId = isSouthpaw ? 'HAND_RIGHT' : 'HAND_LEFT';
    const supportHandZone: GhoulZoneId = isSouthpaw ? 'HAND_LEFT' : 'HAND_RIGHT';

    const shouldHoldWeapon =
      !healthState.weaponDropped &&
      healthState.alive &&
      !healthState.isRagdollActive &&
      !healthState.severedZones.has(triggerHandZone);

    if (this.wasWeaponHeld && !shouldHoldWeapon) {
      this.wasWeaponHeld = false;
      if (this.heldWeaponNode) this.heldWeaponNode.enabled = false;
      if (fxManager) {
        const trigBone = healthState.ragdollBones[triggerHandZone];
        const glbHandNode = glb?.boneNodes.get(triggerHandZone);
        const dropPos = glbHandNode
          ? vec3(
              glbHandNode.getPosition().x,
              glbHandNode.getPosition().y,
              glbHandNode.getPosition().z
            )
          : trigBone.position;
        fxManager.spawnDroppedWeaponProp(
          healthState.archetype,
          dropPos,
          trigBone.velocity
        );
      }
    }

    if (this.heldWeaponNode) {
      this.heldWeaponNode.enabled = shouldHoldWeapon;
    }

    if (shouldHoldWeapon && this.heldWeaponNode) {
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

      if (glb && glbTrigNode && glbSuppNode) {
        const pT = glbTrigNode.getPosition();
        const uT = glbTrigNode.up;
        const pS = glbSuppNode.getPosition();
        const uS = glbSuppNode.up;

        palmTrig = vec3(pT.x + uT.x * 0.052, pT.y + uT.y * 0.052, pT.z + uT.z * 0.052);
        const palmSupp = vec3(pS.x + uS.x * 0.05, pS.y + uS.y * 0.05, pS.z + uS.z * 0.05);

        const isOneHanded =
          weaponId === 'silver_talon_50ae' ||
          healthState.archetype === 'SKINHEAD_PUNK' ||
          healthState.posture === 'GUT_HURT' ||
          healthState.posture === 'THROAT_CLUTCH' ||
          healthState.severedZones.has(supportHandZone);

        const aimSpan = sub(palmSupp, add(palmTrig, vec3(0, forendRiseOffset, 0)));
        if (!isOneHanded && length(aimSpan) > 0.08) {
          gunFwd = normalize(add(scale(normalize(aimSpan), 0.88), scale(charFwd, 0.12)));
        } else {
          const handAim = vec3(uT.x, uT.y * 0.35, uT.z);
          gunFwd =
            length(handAim) > 0.15
              ? normalize(add(scale(normalize(handAim), 0.32), scale(charFwd, 0.68)))
              : normalize(charFwd);
        }
      } else {
        const handTrig = healthState.ragdollBones[triggerHandZone];
        palmTrig = add(handTrig.position, scale(handTrig.basisForward, 0.045));
        gunFwd = normalize(charFwd);
      }

      this.heldWeaponNode.setPosition(palmTrig.x, palmTrig.y, palmTrig.z);
      const yawDeg = (Math.atan2(gunFwd.x, gunFwd.z) * 180) / Math.PI;
      const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, gunFwd.y))) * 180) / Math.PI;
      this.heldWeaponNode.setEulerAngles(-pitchDeg, yawDeg, 0);
    }
  }

  public destroy(): void {
    if (this.heldWeaponGlb) {
      this.heldWeaponGlb.destroy();
      this.heldWeaponGlb = null;
    }
    if (this.heldWeaponNode) {
      this.heldWeaponNode.destroy();
      this.heldWeaponNode = null;
    }
  }
}
