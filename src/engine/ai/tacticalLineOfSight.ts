import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { length, scale, sub } from '../../core/ballistics/vec3.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';

export function isSightBlockedBySolidCover(
  eyeOrigin: Vec3Like,
  targetPoint: Vec3Like,
  rapierWorld: RapierPhysicsWorld | null,
  isLineOfSightBlockedCallback?: (from: Vec3Like, to: Vec3Like) => boolean
): boolean {
  if (isLineOfSightBlockedCallback) {
    return isLineOfSightBlockedCallback(eyeOrigin, targetPoint);
  }
  if (!rapierWorld) return false;

  const delta = sub(targetPoint, eyeOrigin);
  const dist = length(delta);
  if (dist <= 0.05) return false;

  const dir = scale(delta, 1 / dist);
  const maxDist = Math.max(0.01, dist - 0.02);
  const hits = rapierWorld.castPenetrationRay(eyeOrigin, dir, maxDist);
  for (const h of hits) {
    if (h.distanceM > maxDist) continue;
    if (h.surface.material === 'GLASS_MARCHING_256' || h.surface.material === 'GLASS_VORONOI') continue;
    return true;
  }
  return false;
}

export function resolveExposedPlayerAimPoint(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEyeWorldPos: Vec3Like,
  rapierWorld: RapierPhysicsWorld | null,
  isLineOfSightBlockedCallback?: (from: Vec3Like, to: Vec3Like) => boolean
): Vec3Like | null {
  // A seated last stand shoots and looks from the floor, like a crawler, not from standing height.
  const isGroundedOrDowned = agent.state === 'DOWNED_CRAWLING' || hs.isRagdollActive || isSeatedAnimated(hs);
  const basePos = hs.isRagdollActive
    ? hs.ragdollBones.TORSO_UPPER_THORAX?.position ?? hs.worldPosition
    : hs.worldPosition;
  // Kneeling to shoot (wounded sequence KNEEL_FIRE) the gun and eyes sit lower than standing.
  const kneeling = hs.woundedPhase === 'KNEEL_DOWN' || hs.woundedPhase === 'KNEEL_FIRE';
  const muzzleHeight = hs.isRagdollActive
    ? Math.max(0.42, basePos.y)
    : isGroundedOrDowned
      ? hs.worldPosition.y + 0.62
      : hs.worldPosition.y + (kneeling ? 0.92 : 1.32);
  const eyeHeight = hs.isRagdollActive
    ? Math.max(0.55, hs.ragdollBones.HEAD_CRANIUM?.position.y ?? basePos.y + 0.16)
    : isGroundedOrDowned
      ? hs.worldPosition.y + 0.78
      : hs.worldPosition.y + (kneeling ? 1.05 : 1.55);

  const enemyCorePos: Vec3Like = { x: basePos.x, y: muzzleHeight, z: basePos.z };
  const enemyEyePos: Vec3Like = { x: basePos.x, y: eyeHeight, z: basePos.z };
  const playerChestTarget: Vec3Like = {
    x: playerEyeWorldPos.x,
    y: playerEyeWorldPos.y - 0.18,
    z: playerEyeWorldPos.z,
  };

  const chestClear = !isSightBlockedBySolidCover(enemyCorePos, playerChestTarget, rapierWorld, isLineOfSightBlockedCallback);
  const eyeClear = !isSightBlockedBySolidCover(enemyEyePos, playerEyeWorldPos, rapierWorld, isLineOfSightBlockedCallback);

  if (!chestClear && !eyeClear) return null;
  if (chestClear) return playerChestTarget;
  if (!isSightBlockedBySolidCover(enemyCorePos, playerEyeWorldPos, rapierWorld, isLineOfSightBlockedCallback)) {
    return playerEyeWorldPos;
  }
  return null;
}
