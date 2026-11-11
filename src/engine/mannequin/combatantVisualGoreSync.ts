import * as pc from 'playcanvas';
import { ALL_GHOUL_ZONES } from '../../core/ghoul/anatomy.ts';
import type { GhoulZoneId, TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { GlbZoneMaterialPair, ZoneMeshBundle } from './types.ts';

export class CombatantVisualGoreSync {
  private lastMatSyncXRay: boolean | null = null;
  private lastMatSyncHasGlb: boolean | null = null;
  private lastMatSyncFractureCount = -1;
  private lastMatSyncWoundCount = -1;
  private readonly lastSyncedZoneGoreModes: Partial<Record<GhoulZoneId, string>> = {};

  public refreshIfDirty(
    healthState: TargetHealthState,
    combatantGlb: CombatantGlbInstance | null,
    isXRayActive: boolean,
    syncedWoundCount: number,
    glbZoneMaterialPairs: Map<GhoulZoneId, GlbZoneMaterialPair[]>,
    glbGearOriginalMaterials: Map<pc.MeshInstance, pc.Material>,
    zoneBundles: Map<GhoulZoneId, ZoneMeshBundle>,
    materials: EngineMaterialPalette
  ): void {
    const hasGlb = combatantGlb !== null;
    const fracCount = healthState.fracturedBones.size;
    let dirty =
      this.lastMatSyncXRay !== isXRayActive ||
      this.lastMatSyncHasGlb !== hasGlb ||
      this.lastMatSyncFractureCount !== fracCount ||
      this.lastMatSyncWoundCount !== syncedWoundCount;

    for (let i = 0; i < ALL_GHOUL_ZONES.length; i++) {
      const z = ALL_GHOUL_ZONES[i];
      const gm = healthState.zoneGoreMode[z];
      if (this.lastSyncedZoneGoreModes[z] !== gm) {
        this.lastSyncedZoneGoreModes[z] = gm;
        dirty = true;
      }
    }

    if (!dirty) return;

    this.lastMatSyncXRay = isXRayActive;
    this.lastMatSyncHasGlb = hasGlb;
    this.lastMatSyncFractureCount = fracCount;
    this.lastMatSyncWoundCount = syncedWoundCount;

    this.applyMaterials(
      healthState,
      combatantGlb,
      isXRayActive,
      glbZoneMaterialPairs,
      glbGearOriginalMaterials,
      zoneBundles,
      materials
    );
  }

  private applyMaterials(
    healthState: TargetHealthState,
    combatantGlb: CombatantGlbInstance | null,
    isXRayActive: boolean,
    glbZoneMaterialPairs: Map<GhoulZoneId, GlbZoneMaterialPair[]>,
    glbGearOriginalMaterials: Map<pc.MeshInstance, pc.Material>,
    zoneBundles: Map<GhoulZoneId, ZoneMeshBundle>,
    materials: EngineMaterialPalette
  ): void {
    const xrayMat = materials.xraySkinMat;
    const isHeadPopped = healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';

    if (combatantGlb) {
      combatantGlb.setXRayVisible(isXRayActive);
      if (combatantGlb.internalAnatomyEntities.organBrain) {
        combatantGlb.internalAnatomyEntities.organBrain.enabled = isXRayActive && !isHeadPopped;
      }
      if (combatantGlb.internalAnatomyEntities.skeletSkull) {
        combatantGlb.internalAnatomyEntities.skeletSkull.enabled = isHeadPopped || isXRayActive;
      }

      for (const [zone, pairs] of glbZoneMaterialPairs) {
        const goreMode = healthState.zoneGoreMode[zone];
        const isBloody = goreMode === 'LACERATED' || goreMode === 'EVISCERATED';
        for (const pair of pairs) {
          pair.meshInstance.material = isXRayActive
            ? xrayMat
            : isBloody
              ? pair.laceratedMat
              : pair.intactMat;
        }
      }

      for (const [mi, origMat] of glbGearOriginalMaterials) {
        mi.material = isXRayActive ? xrayMat : origMat;
      }
    }

    for (const [zone, bundle] of zoneBundles) {
      const isPoppedZone = isHeadPopped && (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW');
      for (const decal of bundle.woundDecalNodes) {
        decal.enabled = !isPoppedZone && !isXRayActive;
      }
    }
  }

  public pulseXRayOrgans(
    glb: CombatantGlbInstance | null,
    healthState: TargetHealthState,
    isXRayActive: boolean,
    elapsedTime: number
  ): void {
    if (!isXRayActive || !healthState.alive || !glb) return;
    const bpmHz = (healthState.heartRateBpm / 60) * Math.PI * 2;
    const pulse = 1.0 + Math.sin(elapsedTime * bpmHz) * 0.1;
    const bPulse = 1.0 + Math.sin(elapsedTime * 2.5) * 0.04;
    if (glb.internalAnatomyEntities.organHeart) {
      glb.internalAnatomyEntities.organHeart.setLocalScale(pulse, pulse, pulse);
    }
    if (glb.internalAnatomyEntities.organBrain) {
      glb.internalAnatomyEntities.organBrain.setLocalScale(bPulse, bPulse, bPulse);
    }
  }
}
