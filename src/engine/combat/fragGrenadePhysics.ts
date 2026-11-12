import type { EnvironmentState, Vec3Like } from '../../contracts/ballistics.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import {
  GRENADE_CRITICAL_FUSE_WARNING_S,
  GRENADE_RADIUS_M,
  type ActiveFragGrenade,
  type GrenadeFlightState,
  type GrenadeFuseState,
  type GrenadeSweepInterceptor,
} from './fragGrenadeTypes.ts';

const GRENADE_FLOOR_Y = 0.05;
const GRENADE_WALL_LIMIT_X = 9.0;
const GRENADE_BOUNCE_MIN_VY = 0.45;
const GRENADE_AIR_DRAG_PER_S = 0.35;
const GRENADE_ROLL_DRAG_PER_S = 4.2;
const GRENADE_ANGULAR_DRAG_PER_S = 5.0;
const GRENADE_REST_SPEED_EPS = 0.04;
const GRENADE_REST_ANGULAR_EPS = 0.15;

export function resolveGrenadeFuseState(fuseRemainingS: number): GrenadeFuseState {
  if (fuseRemainingS <= 0) return 'DETONATED';
  if (fuseRemainingS < GRENADE_CRITICAL_FUSE_WARNING_S) return 'CRITICAL_WARNING';
  return 'ARMED';
}

function clampArenaBoundsX(g: ActiveFragGrenade): void {
  if (g.position.x < -GRENADE_WALL_LIMIT_X) {
    g.position.x = -GRENADE_WALL_LIMIT_X;
    g.velocity.x = Math.abs(g.velocity.x) * 0.45;
  } else if (g.position.x > GRENADE_WALL_LIMIT_X) {
    g.position.x = GRENADE_WALL_LIMIT_X;
    g.velocity.x = -Math.abs(g.velocity.x) * 0.45;
  }
}

export function stepActiveGrenades(
  activeGrenades: ActiveFragGrenade[],
  dt: number,
  environment: EnvironmentState,
  onDetonate: (center: Vec3Like) => void,
  sweepInterceptor?: GrenadeSweepInterceptor
): void {
  for (let i = activeGrenades.length - 1; i >= 0; i--) {
    const g = activeGrenades[i];
    g.fuseRemainingS -= dt;
    g.blinkTimerS += dt;
    g.fuseState = resolveGrenadeFuseState(g.fuseRemainingS);
    if (!g.crossedGlassIds) {
      g.crossedGlassIds = new Set<string>();
    }

    const flightState: GrenadeFlightState = g.flightState ?? 'BALLISTIC';
    switch (flightState) {
      case 'BALLISTIC': {
        g.velocity.y += environment.gravity.y * dt;
        g.velocity.mulScalar(Math.exp(-GRENADE_AIR_DRAG_PER_S * dt));

        const prevPos: Vec3Like = { x: g.position.x, y: g.position.y, z: g.position.z };
        const desiredPos: Vec3Like = {
          x: g.position.x + g.velocity.x * dt,
          y: g.position.y + g.velocity.y * dt,
          z: g.position.z + g.velocity.z * dt,
        };

        if (sweepInterceptor) {
          const swept = sweepInterceptor(
            prevPos,
            desiredPos,
            { x: g.velocity.x, y: g.velocity.y, z: g.velocity.z },
            GRENADE_RADIUS_M,
            g.crossedGlassIds
          );
          g.position.set(swept.position.x, swept.position.y, swept.position.z);
          g.velocity.set(swept.velocity.x, swept.velocity.y, swept.velocity.z);
          if (swept.bounced) {
            g.angularVelocity.set(
              -g.angularVelocity.x * 0.65 + g.velocity.z * 0.45,
              g.angularVelocity.y * 0.72 + g.velocity.x * 0.35,
              -g.angularVelocity.z * 0.65
            );
          } else if (swept.brokeGlass) {
            g.angularVelocity.mulScalar(0.75);
          }
        } else {
          g.position.set(desiredPos.x, desiredPos.y, desiredPos.z);
        }

        clampArenaBoundsX(g);

        if (g.position.y <= GRENADE_FLOOR_Y) {
          g.position.y = GRENADE_FLOOR_Y;
          if (Math.abs(g.velocity.y) > GRENADE_BOUNCE_MIN_VY) {
            g.velocity.y = -g.velocity.y * 0.42;
            g.velocity.x *= 0.68;
            g.velocity.z *= 0.68;
            g.angularVelocity.mulScalar(0.65);
            g.flightState = 'BALLISTIC';
          } else {
            g.velocity.y = 0;
            g.velocity.x *= 0.68;
            g.velocity.z *= 0.68;
            g.angularVelocity.mulScalar(0.65);
            const horizSpd = Math.hypot(g.velocity.x, g.velocity.z);
            g.flightState =
              horizSpd < GRENADE_REST_SPEED_EPS && g.angularVelocity.length() < GRENADE_REST_ANGULAR_EPS
                ? 'RESTING'
                : 'GROUND_ROLLING';
          }
        } else {
          g.flightState = 'BALLISTIC';
        }
        break;
      }
      case 'GROUND_ROLLING': {
        g.position.y = GRENADE_FLOOR_Y;
        g.velocity.y = 0;
        const rollDamp = Math.exp(-GRENADE_ROLL_DRAG_PER_S * dt);
        const angDamp = Math.exp(-GRENADE_ANGULAR_DRAG_PER_S * dt);
        g.velocity.x *= rollDamp;
        g.velocity.z *= rollDamp;
        g.angularVelocity.mulScalar(angDamp);

        const prevPos: Vec3Like = { x: g.position.x, y: GRENADE_FLOOR_Y, z: g.position.z };
        const desiredPos: Vec3Like = {
          x: g.position.x + g.velocity.x * dt,
          y: GRENADE_FLOOR_Y,
          z: g.position.z + g.velocity.z * dt,
        };

        if (sweepInterceptor) {
          const swept = sweepInterceptor(
            prevPos,
            desiredPos,
            { x: g.velocity.x, y: 0, z: g.velocity.z },
            GRENADE_RADIUS_M,
            g.crossedGlassIds
          );
          g.position.set(swept.position.x, GRENADE_FLOOR_Y, swept.position.z);
          g.velocity.set(swept.velocity.x, 0, swept.velocity.z);
        } else {
          g.position.x = desiredPos.x;
          g.position.z = desiredPos.z;
        }
        clampArenaBoundsX(g);

        const horizSpd = Math.hypot(g.velocity.x, g.velocity.z);
        if (horizSpd < GRENADE_REST_SPEED_EPS && g.angularVelocity.length() < GRENADE_REST_ANGULAR_EPS) {
          g.velocity.set(0, 0, 0);
          g.angularVelocity.set(0, 0, 0);
          g.flightState = 'RESTING';
        }
        break;
      }
      case 'RESTING': {
        g.position.y = GRENADE_FLOOR_Y;
        g.velocity.set(0, 0, 0);
        g.angularVelocity.set(0, 0, 0);
        break;
      }
    }

    g.entity.setPosition(g.position.x, g.position.y, g.position.z);
    if (g.flightState !== 'RESTING') {
      g.entity.rotate(
        g.angularVelocity.x * dt * 45,
        g.angularVelocity.y * dt * 45,
        g.angularVelocity.z * dt * 45
      );
    }

    const blinkPeriod = g.fuseState === 'CRITICAL_WARNING' ? 0.06 : 0.14;
    g.fusePinLed.enabled =
      g.fuseState !== 'DETONATED' && Math.floor(g.blinkTimerS / blinkPeriod) % 2 === 0;

    if (g.fuseState === 'DETONATED') {
      const detCenter = vec3(g.position.x, g.position.y, g.position.z);
      g.glbInstance?.destroy();
      g.entity.destroy();
      activeGrenades.splice(i, 1);
      onDetonate(detCenter);
    }
  }
}
