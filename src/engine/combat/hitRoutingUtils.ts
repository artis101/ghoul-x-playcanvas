import type {
  AmmoSpec,
  EnvironmentState,
  ShotSimulationReport,
  TrajectorySample,
  Vec3Like,
  WeaponSpec,
} from '../../contracts/ballistics.ts';
import { add, copyVec3, distance, length, normalize, scale } from '../../core/ballistics/vec3.ts';
import { simulateShot } from '../../core/ballistics/solver.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';

export function isTargetNearShotCone(
  candidate: GhoulMannequinEntity,
  origin: Vec3Like,
  normAim: Vec3Like,
  ammo: AmmoSpec,
  environment: EnvironmentState
): boolean {
  const hs = candidate.healthState;
  const pelvis = hs.ragdollBones.PELVIS_GROIN?.position;
  const thorax = hs.ragdollBones.TORSO_UPPER_THORAX?.position;
  const cx = thorax ? (thorax.x + (pelvis?.x ?? thorax.x)) * 0.5 : hs.worldPosition.x;
  const cy = thorax ? (thorax.y + (pelvis?.y ?? thorax.y)) * 0.5 : hs.worldPosition.y + 1.0;
  const cz = thorax ? (thorax.z + (pelvis?.z ?? thorax.z)) * 0.5 : hs.worldPosition.z;

  const rx = cx - origin.x;
  const ry = cy - origin.y;
  const rz = cz - origin.z;

  const proj = rx * normAim.x + ry * normAim.y + rz * normAim.z;
  const bodyRadius = hs.severedZones.size > 0 ? 4.4 : 1.75;
  if (proj < -bodyRadius) return false;

  const d = Math.max(0, proj);
  const spreadSlope =
    Math.tan(Math.min(0.65, Math.max(0, ammo.spreadRadians))) +
    (ammo.pelletCount > 1 ? 0.16 : 0.025);
  const estFlightS = d / Math.max(110, ammo.muzzleVelocityMs * 0.62);
  const windSpeed = length(environment.windVelocity);
  const ballisticMargin = 5.2 * estFlightS * estFlightS + windSpeed * estFlightS;
  const maxRadius = bodyRadius + d * spreadSlope + ballisticMargin;

  const perpX = rx - normAim.x * d;
  const perpY = ry - normAim.y * d;
  const perpZ = rz - normAim.z * d;
  return perpX * perpX + perpY * perpY + perpZ * perpZ <= maxRadius * maxRadius;
}

export function findBestTargetHit(
  weapon: WeaponSpec,
  ammo: AmmoSpec,
  origin: Vec3Like,
  aimDir: Vec3Like,
  targets: GhoulMannequinEntity[],
  environment: EnvironmentState,
  excludeTargets?: Set<GhoulMannequinEntity>
): { target: GhoulMannequinEntity; report: ShotSimulationReport } | null {
  if (targets.length === 0) return null;

  const normAim = normalize(aimDir);
  let bestHit: { target: GhoulMannequinEntity; report: ShotSimulationReport } | null = null;
  let bestImpactTime = Infinity;

  for (let i = 0; i < targets.length; i++) {
    const candidate = targets[i];
    if (excludeTargets?.has(candidate)) continue;
    if (!isTargetNearShotCone(candidate, origin, normAim, ammo, environment)) continue;

    const candReport = simulateShot(weapon, ammo, origin, normAim, candidate.healthState, environment);
    if (candReport.hitTarget) {
      const tHit = candReport.flightTimeAtImpactS || candReport.targetDistanceM / 500;
      if (tHit < bestImpactTime) {
        bestImpactTime = tHit;
        bestHit = { target: candidate, report: candReport };
      }
    }
  }

  return bestHit;
}

export function truncateTrajectorySamples(
  samples: TrajectorySample[],
  origin: Vec3Like,
  maxDistM: number
): TrajectorySample[] {
  if (samples.length <= 2) return samples;
  const out: TrajectorySample[] = [];
  for (const s of samples) {
    out.push(s);
    if (distance(origin, s.position) >= maxDistM) break;
  }
  return out.length >= 2 ? out : samples.slice(0, 2);
}

export function buildSyntheticFlightSamples(
  origin: Vec3Like,
  normDir: Vec3Like,
  speedMs: number,
  massKg: number,
  distM: number,
  speedOfSoundMs: number
): TrajectorySample[] {
  const safeSpeed = Math.max(60, speedMs);
  const flightS = distM / safeSpeed;
  const midPos = add(origin, scale(normDir, distM * 0.5));
  const endPos = add(origin, scale(normDir, distM));
  const ke = 0.5 * massKg * safeSpeed * safeSpeed;
  const mach = safeSpeed / speedOfSoundMs;
  const vel = scale(normDir, safeSpeed);

  return [
    {
      timeS: 0,
      position: copyVec3(origin),
      velocity: copyVec3(vel),
      speedMs: safeSpeed,
      mach,
      kineticEnergyJ: ke,
      dropM: 0,
      windDriftM: 0,
    },
    {
      timeS: flightS * 0.5,
      position: midPos,
      velocity: copyVec3(vel),
      speedMs: safeSpeed,
      mach,
      kineticEnergyJ: ke,
      dropM: 0,
      windDriftM: 0,
    },
    {
      timeS: flightS,
      position: endPos,
      velocity: copyVec3(vel),
      speedMs: safeSpeed,
      mach,
      kineticEnergyJ: ke,
      dropM: 0,
      windDriftM: 0,
    },
  ];
}
