import * as pc from 'playcanvas';
import type { AmmoSpec, EnvironmentState, Vec3Like, WeaponSpec } from '../../contracts/ballistics.ts';
import { normalize } from '../../core/ballistics/vec3.ts';
import type { HudController } from '../hudController.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import { findBestTargetHit } from './hitRoutingUtils.ts';

export class SniperRangefinder {
  private lastClockS = -1;
  private lastWeaponId = '';
  private lastAmmoId = '';
  private readonly lastOrigin = new pc.Vec3(Infinity, Infinity, Infinity);
  private readonly lastAimDir = new pc.Vec3(0, 0, -1);

  public update(
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    origin: Vec3Like,
    aimDir: Vec3Like,
    hudController: HudController,
    targets: GhoulMannequinEntity[],
    environment: EnvironmentState,
    clockS: number
  ): void {
    const normAim = normalize(aimDir);
    const dxO = origin.x - this.lastOrigin.x;
    const dyO = origin.y - this.lastOrigin.y;
    const dzO = origin.z - this.lastOrigin.z;
    const dxA = normAim.x - this.lastAimDir.x;
    const dyA = normAim.y - this.lastAimDir.y;
    const dzA = normAim.z - this.lastAimDir.z;

    if (
      this.lastClockS >= 0 &&
      clockS - this.lastClockS < 0.06 &&
      weapon.id === this.lastWeaponId &&
      ammo.id === this.lastAmmoId &&
      dxO * dxO + dyO * dyO + dzO * dzO < 0.0004 &&
      dxA * dxA + dyA * dyA + dzA * dzA < 1e-6
    ) {
      return;
    }

    this.lastClockS = clockS;
    this.lastWeaponId = weapon.id;
    this.lastAmmoId = ammo.id;
    this.lastOrigin.set(origin.x, origin.y, origin.z);
    this.lastAimDir.set(normAim.x, normAim.y, normAim.z);

    const zoom = weapon.scopeZoomLevels[0] || 4.0;
    const match = findBestTargetHit(weapon, ammo, origin, normAim, targets, environment);
    if (match) {
      hudController.setScopeOverlay(
        true,
        zoom,
        match.report.targetDistanceM,
        match.report.bulletDropAtImpactCm
      );
    } else {
      const refDistM = 42.0;
      const flightS = refDistM / Math.max(120, ammo.muzzleVelocityMs * 0.92);
      const dropCm = 0.5 * 9.81 * flightS * flightS * 100;
      hudController.setScopeOverlay(true, zoom, refDistM, dropCm);
    }
  }
}
