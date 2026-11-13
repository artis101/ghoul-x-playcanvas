import type { AmmoSpec, EnvironmentState, Vec3Like, WeaponSpec } from '../../contracts/ballistics.ts';
import { triggerSide } from '../../core/ghoul/anatomy/handedness.ts';
import { scale } from '../../core/ballistics/vec3.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { EnvironmentRayInterceptor } from './combatTypes.ts';
import { buildSyntheticFlightSamples } from './hitRoutingUtils.ts';
import { findHeldWeaponStrike } from './heldWeaponStrike.ts';
import type { ImpactDispatcherContext } from './impactDamageDispatcher.ts';
import { HELD_WEAPON_STRIKE_DROP_CHANCE } from '../../core/combatant/hitDisarmPolicy.ts';

/**
 * A round that hits an enemy's gun before it reaches flesh only rarely tears it out of their hands
 * (`HELD_WEAPON_STRIKE_DROP_CHANCE`): then the bullet stops in the receiver, sparks fly and the
 * combatant lets go, unhurt, and goes to pick it back up. Otherwise the gun is held on to and the
 * round carries on into the body. Returns true when the shot was spent on a gun.
 */
export function strikeHeldWeapon(
  _weapon: WeaponSpec,
  ammo: AmmoSpec,
  origin: Vec3Like,
  normAim: Vec3Like,
  targets: readonly GhoulMannequinEntity[],
  bodyHitDistM: number,
  muzzleEnergyJ: number,
  muzzleSpeedMs: number,
  isAp: boolean,
  environment: EnvironmentState,
  fxManager: GoreAndBallisticsFxManager,
  interceptor?: EnvironmentRayInterceptor,
  impactCtx?: ImpactDispatcherContext,
): boolean {
  const strike = findHeldWeaponStrike(origin, normAim, targets, bodyHitDistM);
  if (!strike) return false;

  if (interceptor) {
    const env = interceptor(
      origin, normAim, strike.distanceM, muzzleEnergyJ, muzzleSpeedMs,
      ammo.diameterM, isAp, ammo.armorPenetrationFactor,
    );
    if (env.blocked || env.remainingSpeedMs <= 25) return false;
  }

  if (Math.random() >= HELD_WEAPON_STRIKE_DROP_CHANCE) return false;

  const hs = strike.target.healthState;
  // A plain drop: both arms still work, so the fighter can pick the gun back up.
  hs.weaponDropped = true;

  fxManager.spawnFlyingProjectile(
    buildSyntheticFlightSamples(origin, normAim, muzzleSpeedMs, ammo.massKg, strike.distanceM, environment.speedOfSoundMs),
    false,
  );
  fxManager.spawnArmorImpactSparks(strike.pointWorld, scale(normAim, -1));

  if (impactCtx) {
    impactCtx.hudController.triggerHitmarker('ARMOR');
    impactCtx.tacticalAi?.notifyEnemyHit(hs, {
      hitZone: `HAND_${triggerSide(hs.isLeftHanded)}`,
      energyDepositedJ: 0,
    });
  }
  return true;
}
