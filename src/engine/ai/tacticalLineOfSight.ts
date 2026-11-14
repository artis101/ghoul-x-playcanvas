import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { ColliderSurfaceTag } from '../../contracts/destruction.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';

const SIGHT_DIR: Vec3Like = { x: 0, y: 0, z: 1 };

/** Glass is see-through for sight lines; every other tagged surface blocks. */
function isOpaqueSurface(surface: ColliderSurfaceTag): boolean {
  return surface.material !== 'GLASS_MARCHING_256' && surface.material !== 'GLASS_VORONOI';
}

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

  const dx = targetPoint.x - eyeOrigin.x;
  const dy = targetPoint.y - eyeOrigin.y;
  const dz = targetPoint.z - eyeOrigin.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= 0.05) return false;

  const inv = 1 / dist;
  SIGHT_DIR.x = dx * inv;
  SIGHT_DIR.y = dy * inv;
  SIGHT_DIR.z = dz * inv;
  const maxDist = Math.max(0.01, dist - 0.02);
  return rapierWorld.hasAnyBlockingHit(eyeOrigin, SIGHT_DIR, maxDist, isOpaqueSurface);
}

export function resolveExposedPlayerAimPoint(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEyeWorldPos: Vec3Like,
  isSightBlocked: (from: Vec3Like, to: Vec3Like) => boolean
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

  const chestClear = !isSightBlocked(enemyCorePos, playerChestTarget);
  const eyeClear = !isSightBlocked(enemyEyePos, playerEyeWorldPos);

  if (!chestClear && !eyeClear) return null;
  if (chestClear) return playerChestTarget;
  if (!isSightBlocked(enemyCorePos, playerEyeWorldPos)) {
    return playerEyeWorldPos;
  }
  return null;
}
