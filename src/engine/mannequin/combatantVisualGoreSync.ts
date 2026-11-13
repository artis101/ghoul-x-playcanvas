import { ALL_GHOUL_ZONES } from '../../core/ghoul/anatomy.ts';
import type { GhoulZoneId, TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { GlbZoneMaterialPair, ZoneMeshBundle } from './types.ts';

export class CombatantVisualGoreSync {
  private lastMatSyncHasGlb: boolean | null = null;
  private lastMatSyncFractureCount = -1;
  private lastMatSyncWoundCount = -1;
  private readonly lastSyncedZoneGoreModes: Partial<Record<GhoulZoneId, string>> = {};

  public refreshIfDirty(
    healthState: TargetHealthState,
    combatantGlb: CombatantGlbInstance | null,
    syncedWoundCount: number,
    glbZoneMaterialPairs: Map<GhoulZoneId, GlbZoneMaterialPair[]>,
    zoneBundles: Map<GhoulZoneId, ZoneMeshBundle>
  ): void {
    const hasGlb = combatantGlb !== null;
    const fracCount = healthState.fracturedBones.size;
    let dirty =
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

    this.lastMatSyncHasGlb = hasGlb;
    this.lastMatSyncFractureCount = fracCount;
    this.lastMatSyncWoundCount = syncedWoundCount;

    this.applyMaterials(healthState, combatantGlb, glbZoneMaterialPairs, zoneBundles);
  }

  private applyMaterials(
    healthState: TargetHealthState,
    combatantGlb: CombatantGlbInstance | null,
    glbZoneMaterialPairs: Map<GhoulZoneId, GlbZoneMaterialPair[]>,
    zoneBundles: Map<GhoulZoneId, ZoneMeshBundle>
  ): void {
    const isHeadPopped = healthState.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';

    if (combatantGlb) {
      // Internal anatomy stays hidden; only the skull shows once the cranium is popped.
      combatantGlb.setInternalAnatomyVisible(false);
      if (combatantGlb.internalAnatomyEntities.skeletSkull) {
        combatantGlb.internalAnatomyEntities.skeletSkull.enabled = isHeadPopped;
      }

      for (const [zone, pairs] of glbZoneMaterialPairs) {
        const goreMode = healthState.zoneGoreMode[zone];
        const isBloody = goreMode === 'LACERATED' || goreMode === 'EVISCERATED';
        for (const pair of pairs) {
          pair.meshInstance.material = isBloody ? pair.laceratedMat : pair.intactMat;
        }
      }
    }

    for (const [zone, bundle] of zoneBundles) {
      const isPoppedZone = isHeadPopped && (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW');
      for (const decal of bundle.woundDecalNodes) {
        decal.enabled = !isPoppedZone;
      }
    }
  }

}
