import type { AmmoSpec, EnvironmentState, Vec3Like, WeaponSpec } from '../../contracts/ballistics.ts';
import { normalize } from '../../core/ballistics/vec3.ts';
import type { HudController } from '../hudController.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import { findBestTargetHit } from './hitRoutingUtils.ts';

// Range and drop are recomputed at most this often while the scope stays up.
const RECOMPUTE_INTERVAL_S = 0.1;

export class SniperRangefinder {
  private lastClockS = -1;
  private lastFrame = -2;
  private lastWeaponId = '';
  private lastAmmoId = '';
  private lastLabelKey = '';

  public update(
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    origin: Vec3Like,
    aimDir: Vec3Like,
    hudController: HudController,
    targets: GhoulMannequinEntity[],
    environment: EnvironmentState,
    clockS: number,
    frame: number
  ): void {
    // A call that does not follow the previous frame's call starts a new scope session, whose
    // labels were reset when the scope opened.
    const continuing = frame === this.lastFrame || frame === this.lastFrame + 1;
    this.lastFrame = frame;
    const fresh =
      !continuing || this.lastClockS < 0 || weapon.id !== this.lastWeaponId || ammo.id !== this.lastAmmoId;
    if (!fresh && clockS - this.lastClockS < RECOMPUTE_INTERVAL_S) return;
    this.lastClockS = clockS;
    this.lastWeaponId = weapon.id;
    this.lastAmmoId = ammo.id;

    const normAim = normalize(aimDir);
    const zoom = weapon.scopeZoomLevels[0] || 4.0;
    let rangeM: number;
    let dropCm: number;
    const match = findBestTargetHit(weapon, ammo, origin, normAim, targets, environment);
    if (match) {
      rangeM = match.report.targetDistanceM;
      dropCm = match.report.bulletDropAtImpactCm;
    } else {
      const refDistM = 42.0;
      const flightS = refDistM / Math.max(120, ammo.muzzleVelocityMs * 0.92);
      rangeM = refDistM;
      dropCm = 0.5 * 9.81 * flightS * flightS * 100;
    }

    // Same rounding the scope labels display.
    const labelKey = `${zoom.toFixed(1)}|${rangeM.toFixed(0)}|${Math.abs(dropCm).toFixed(1)}`;
    if (!fresh && labelKey === this.lastLabelKey) return;
    this.lastLabelKey = labelKey;
    hudController.setScopeOverlay(true, zoom, rangeM, dropCm);
  }
}
