import * as pc from 'playcanvas';
import type { GhoulZoneId, TargetHealthState } from '../../contracts/ballistics.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { ZoneMeshBundle } from './types.ts';

export class CombatantWoundDecals {
  public syncedCount = 0;

  public syncSurfaceWounds(
    healthState: TargetHealthState,
    zoneBundles: Map<GhoulZoneId, ZoneMeshBundle>,
    materials: EngineMaterialPalette
  ): void {
    while (this.syncedCount < healthState.surfaceWounds.length) {
      const sw = healthState.surfaceWounds[this.syncedCount];
      this.syncedCount++;

      const bundle = zoneBundles.get(sw.zone);
      if (!bundle) continue;

      const decal = new pc.Entity(sw.id);
      decal.addComponent('render', {
        type: 'sphere',
        material: sw.armorDent
          ? materials.sandbagMat
          : sw.isExit
            ? materials.stumpFleshMat
            : materials.woundGoreMat,
        castShadows: false,
      });

      const r = sw.radiusM * 2.0;
      decal.setLocalScale(r, r, r * 0.35);
      decal.setLocalPosition(sw.localOffset.x, sw.localOffset.y, sw.localOffset.z);
      bundle.zoneNode.addChild(decal);
      bundle.woundDecalNodes.push(decal);
    }
  }

  public reset(): void {
    this.syncedCount = 0;
  }
}
