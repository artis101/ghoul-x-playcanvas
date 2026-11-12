import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import { add, normalize, scale, vec3 } from '../../core/ballistics/vec3.ts';
import type { GlbModelRegistry, WeaponGlbInstance } from '../assets/glbLoader.ts';
import { GRENADE_FUSE_S, type ActiveFragGrenade } from './fragGrenadeTypes.ts';

export function spawnLiveFragGrenade(
  origin: Vec3Like,
  aimDir: Vec3Like,
  glbRegistry: GlbModelRegistry | null,
  fxRoot: pc.Entity
): ActiveFragGrenade {
  const normAim = normalize(aimDir);
  const spawnPos = add(add(origin, scale(normAim, 0.48)), vec3(0, -0.08, 0));
  const throwVel = add(scale(normAim, 14.8), vec3(0, 2.65, 0));

  const grenadeRoot = new pc.Entity('LiveFragGrenade');
  grenadeRoot.setPosition(spawnPos.x, spawnPos.y, spawnPos.z);

  let glbInstance: WeaponGlbInstance | null = null;
  if (glbRegistry && glbRegistry.isLoaded('frag_grenade')) {
    try {
      glbInstance = glbRegistry.instantiateWeapon('frag_grenade');
      glbInstance.playFire(1.0);
      grenadeRoot.addChild(glbInstance.rootEntity);
    } catch {
      glbInstance = null;
    }
  }

  const fusePinLed = new pc.Entity('GrenadeFuseLed');
  fusePinLed.setLocalPosition(0, 0.09, 0);
  grenadeRoot.addChild(fusePinLed);

  fxRoot.addChild(grenadeRoot);

  return {
    entity: grenadeRoot,
    fusePinLed,
    glbInstance,
    position: new pc.Vec3(spawnPos.x, spawnPos.y, spawnPos.z),
    velocity: new pc.Vec3(throwVel.x, throwVel.y, throwVel.z),
    angularVelocity: new pc.Vec3(8.5, 5.2, -6.4),
    fuseRemainingS: GRENADE_FUSE_S,
    blinkTimerS: 0,
    flightState: 'BALLISTIC',
    fuseState: 'ARMED',
    crossedGlassIds: new Set<string>(),
  };
}
