import type { EnvironmentState, Vec3Like } from '../../contracts/ballistics.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import type { ActiveFragGrenade } from './fragGrenadeTypes.ts';

export function stepActiveGrenades(
  activeGrenades: ActiveFragGrenade[],
  dt: number,
  environment: EnvironmentState,
  onDetonate: (center: Vec3Like) => void
): void {
  for (let i = activeGrenades.length - 1; i >= 0; i--) {
    const g = activeGrenades[i];
    g.fuseRemainingS -= dt;
    g.blinkTimerS += dt;

    g.velocity.y += environment.gravity.y * dt;
    g.velocity.mulScalar(Math.max(0.96, 1 - dt * 0.35));

    g.position.x += g.velocity.x * dt;
    g.position.y += g.velocity.y * dt;
    g.position.z += g.velocity.z * dt;

    if (g.position.x < -9.0) {
      g.position.x = -9.0;
      g.velocity.x = Math.abs(g.velocity.x) * 0.45;
    } else if (g.position.x > 9.0) {
      g.position.x = 9.0;
      g.velocity.x = -Math.abs(g.velocity.x) * 0.45;
    }

    if (g.position.y <= 0.05) {
      g.position.y = 0.05;
      if (Math.abs(g.velocity.y) > 0.45) {
        g.velocity.y = -g.velocity.y * 0.42;
      } else {
        g.velocity.y = 0;
      }
      g.velocity.x *= 0.68;
      g.velocity.z *= 0.68;
      g.angularVelocity.mulScalar(0.65);
    }

    g.entity.setPosition(g.position.x, g.position.y, g.position.z);
    g.entity.rotate(g.angularVelocity.x * dt * 45, g.angularVelocity.y * dt * 45, g.angularVelocity.z * dt * 45);

    const blinkPeriod = g.fuseRemainingS < 0.45 ? 0.06 : 0.14;
    g.fusePinLed.enabled = Math.floor(g.blinkTimerS / blinkPeriod) % 2 === 0;

    if (g.fuseRemainingS <= 0) {
      const detCenter = vec3(g.position.x, g.position.y, g.position.z);
      g.glbInstance?.destroy();
      g.entity.destroy();
      activeGrenades.splice(i, 1);
      onDetonate(detCenter);
    }
  }
}
