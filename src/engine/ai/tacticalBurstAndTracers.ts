import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import {
  add,
  copyVec3,
  cross,
  deterministicConeSpread,
  distance,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from '../../core/ballistics/vec3.ts';
import { basisColumnsToQuaternion } from '../fx/mayhemDirector.ts';
import type { HardwareInstancedPool } from '../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type {
  ActiveFiringHand,
  EnemyAimProfile,
  EnemyAiAgentRuntime,
  EnemyCoverShotInterceptResult,
  EnemyTracerFireEvent,
  PlayerCombatVitals,
} from './tacticalAiTypes.ts';
import { ARCHETYPE_TUNING, SIDEARM_M9_TUNING } from './archetypeTuning.ts';

export interface BurstContext {
  elapsedClockS: number;
  playerVitals: PlayerCombatVitals;
  tracerPool: HardwareInstancedPool | null;
  rapierWorld: RapierPhysicsWorld | null;
  interceptEnemyShotCover?: (origin: Vec3Like, dir: Vec3Like, maxDist: number) => EnemyCoverShotInterceptResult;
  onEnemyFireTracer?: (event: EnemyTracerFireEvent) => void;
  onPlayerDamaged?: (vitals: Readonly<PlayerCombatVitals>, event: EnemyTracerFireEvent) => void;
  resolveExposedPlayerAimPoint: (hs: TargetHealthState, agent: EnemyAiAgentRuntime, playerEye: Vec3Like) => Vec3Like | null;
}

export function computeTracerOrientationQuat(shotDir: Vec3Like) {
  const f = normalize(shotDir);
  const upRef = Math.abs(f.y) < 0.98 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  const r = normalize(cross(upRef, f));
  const u = normalize(cross(f, r));
  return basisColumnsToQuaternion(r.x, r.y, r.z, u.x, u.y, u.z, f.x, f.y, f.z);
}

export function stepWeaponBurstFire(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  aimProfile: EnemyAimProfile,
  playerEyeWorldPos: Vec3Like,
  ctx: BurstContext
): void {
  const tuning = ARCHETYPE_TUNING[hs.archetype];
  const isWounded = hs.currentHp < hs.maxHp * 0.88 || hs.painShock > 0.18 || hs.rupturedOrgans.size > 0;

  if (agent.burstShotsRemaining <= 0) {
    agent.fireCooldownTimerS = Math.max(0, agent.fireCooldownTimerS - dt);
  }

  const exposedAimTarget = ctx.resolveExposedPlayerAimPoint(hs, agent, playerEyeWorldPos);
  if (!exposedAimTarget) {
    if (agent.burstShotsRemaining > 0) {
      agent.burstShotsRemaining = 0;
      agent.fireCooldownTimerS = Math.max(agent.fireCooldownTimerS, 0.25);
    }
    return;
  }

  agent.lastAimTargetWorld = copyVec3(exposedAimTarget);

  if (agent.burstShotsRemaining <= 0) {
    if (agent.fireCooldownTimerS <= 0) {
      if (aimProfile.usingBackupSidearm) {
        agent.burstShotsRemaining = agent.completedBurstCount % 2 === 0 ? 2 : 3;
      } else {
        let desiredBurst = tuning.burstCount;
        if (agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded) desiredBurst += 2;
        else if (agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded) desiredBurst += 3;
        agent.burstShotsRemaining = aimProfile.isOneHandedDownedFire ? Math.max(2, Math.ceil(desiredBurst * 0.65)) : desiredBurst;
      }
      agent.burstInterShotTimerS = 0;
    }
    return;
  }

  agent.burstInterShotTimerS -= dt;
  if (agent.burstInterShotTimerS > 0) return;

  emitEnemyTracerShot(hs, agent, aimProfile, playerEyeWorldPos, exposedAimTarget, ctx);

  const cadenceScale =
    agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded
      ? 0.65
      : agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded
        ? 0.75
        : agent.resolveProfile === 'HARDENED_VETERAN'
          ? 0.92
          : 1.0;

  const raggedWoundDelay =
    agent.triageStatus === 'MORTALLY_WOUNDED' && agent.resolveProfile !== 'FANATIC_BERSERKER' ? 1.18 : 1.0;

  agent.burstShotsRemaining -= 1;
  if (agent.burstShotsRemaining > 0) {
    const baseInterShot = aimProfile.usingBackupSidearm ? SIDEARM_M9_TUNING.interShotDelayS : tuning.interShotDelayS;
    agent.burstInterShotTimerS =
      baseInterShot * cadenceScale * raggedWoundDelay * (aimProfile.isOneHandedDownedFire && !aimProfile.usingBackupSidearm ? 1.3 : 1.0);
  } else {
    agent.completedBurstCount += 1;
    if (agent.resolveProfile === 'HARDENED_VETERAN' && agent.completedBurstCount % 2 === 0) {
      agent.peekSign = (agent.peekSign === 1 ? -1 : 1) as -1 | 1;
    }
    const baseCooldown = aimProfile.usingBackupSidearm ? SIDEARM_M9_TUNING.burstCooldownS : tuning.burstCooldownS;
    agent.fireCooldownTimerS =
      baseCooldown * cadenceScale * (aimProfile.isOneHandedDownedFire && !aimProfile.usingBackupSidearm ? 1.25 : 1.0);
  }
}

export function emitEnemyTracerShot(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  aimProfile: EnemyAimProfile,
  playerEyeWorldPos: Vec3Like,
  aimTargetPos: Vec3Like,
  ctx: BurstContext
): void {
  const tuning = ARCHETYPE_TUNING[hs.archetype];
  const usingSidearm = aimProfile.usingBackupSidearm;
  const firingHand: ActiveFiringHand = aimProfile.activeFiringHand ?? agent.activeFiringHand;
  const firingHandZone: GhoulZoneId = firingHand === 'LEFT' ? 'HAND_LEFT' : 'HAND_RIGHT';

  const handBone = hs.ragdollBones[firingHandZone];
  const handPos = handBone && !handBone.severed ? handBone.position : undefined;
  const isGroundedOrDowned = agent.state === 'DOWNED_CRAWLING' || hs.isRagdollActive;
  const basePos = hs.isRagdollActive ? hs.ragdollBones.TORSO_UPPER_THORAX?.position ?? hs.worldPosition : hs.worldPosition;
  const muzzleHeight = hs.isRagdollActive ? Math.max(0.42, basePos.y) : isGroundedOrDowned ? hs.worldPosition.y + 0.62 : hs.worldPosition.y + 1.32;

  const coreOrigin: Vec3Like = { x: basePos.x, y: muzzleHeight, z: basePos.z };
  const idealDir = normalize(sub(aimTargetPos, coreOrigin));
  const fwdDir = usingSidearm ? idealDir : { x: Math.sin(hs.yawRad), y: 0, z: Math.cos(hs.yawRad) };

  const rawMuzzleOrigin: Vec3Like = handPos
    ? add(handPos, scale(fwdDir, usingSidearm ? 0.19 : 0.28))
    : { x: coreOrigin.x + fwdDir.x * 0.38, y: muzzleHeight, z: coreOrigin.z + fwdDir.z * 0.38 };

  const playerChestTarget: Vec3Like = { x: playerEyeWorldPos.x, y: playerEyeWorldPos.y - 0.18, z: playerEyeWorldPos.z };
  const seed = agent.tracerSeedCounter++;
  const shotDir = deterministicConeSpread(idealDir, aimProfile.effectiveSpreadRad, (seed % 7) + 1, 8, seed * 31);

  const toChest = sub(playerChestTarget, coreOrigin);
  const alongChest = dot(toChest, shotDir);
  const closestChestPt = alongChest > 0 ? add(coreOrigin, scale(shotDir, alongChest)) : coreOrigin;
  const missDistChest = alongChest > 0 ? distance(closestChestPt, playerChestTarget) : Infinity;

  const toAim = sub(aimTargetPos, coreOrigin);
  const alongAim = dot(toAim, shotDir);
  const closestAimPt = alongAim > 0 ? add(coreOrigin, scale(shotDir, alongAim)) : coreOrigin;
  const missDistAim = alongAim > 0 ? distance(closestAimPt, aimTargetPos) : Infinity;

  const wouldHitPlayer = missDistChest <= 0.36 || missDistAim <= 0.36;
  const playerHitDist = missDistChest <= 0.36 ? alongChest : missDistAim <= 0.36 ? alongAim : Math.max(0.5, distance(coreOrigin, aimTargetPos));
  const playerHitPoint = missDistChest <= 0.36 ? closestChestPt : closestAimPt;
  const coverCheckDist = wouldHitPlayer ? Math.max(0.05, playerHitDist) : playerHitDist + 6.0;

  let blockedByCover = false;
  let impactPointWorld = add(coreOrigin, scale(shotDir, playerHitDist + 4.0));

  if (ctx.interceptEnemyShotCover) {
    const intercept = ctx.interceptEnemyShotCover(coreOrigin, shotDir, coverCheckDist);
    if (intercept.blocked) {
      blockedByCover = true;
      impactPointWorld = intercept.impactPointWorld ?? add(coreOrigin, scale(shotDir, coverCheckDist));
    }
  } else if (ctx.rapierWorld) {
    const hits = ctx.rapierWorld.castPenetrationRay(coreOrigin, shotDir, coverCheckDist);
    for (const h of hits) {
      if (h.distanceM > coverCheckDist) continue;
      if (h.surface.material === 'GLASS_MARCHING_256' || h.surface.material === 'GLASS_VORONOI') continue;
      blockedByCover = true;
      impactPointWorld = h.pointWorld;
      break;
    }
  }

  const muzzleOrigin = blockedByCover && distance(coreOrigin, impactPointWorld) < 0.48 ? coreOrigin : rawMuzzleOrigin;
  const tracerSpeedMs = usingSidearm ? SIDEARM_M9_TUNING.tracerSpeedMs : tuning.tracerSpeedMs;
  const rawChip = usingSidearm ? SIDEARM_M9_TUNING.baseChipDamage : tuning.baseChipDamage;

  let hitPlayer = false;
  let armorChipApplied = 0;
  let healthDamageApplied = 0;

  if (!blockedByCover && wouldHitPlayer) {
    hitPlayer = true;
    impactPointWorld = playerHitPoint;
    if (ctx.playerVitals.damageEnabled && ctx.playerVitals.invulnerabilityRemainingS <= 0) {
      if (ctx.playerVitals.armor > 0) {
        armorChipApplied = Math.min(ctx.playerVitals.armor, rawChip * 0.7);
        ctx.playerVitals.armor = Math.max(0, ctx.playerVitals.armor - armorChipApplied);
        healthDamageApplied = rawChip * 0.35;
      } else {
        healthDamageApplied = rawChip;
      }
      ctx.playerVitals.health = Math.max(0, ctx.playerVitals.health - healthDamageApplied);
      ctx.playerVitals.timeSinceLastHitS = 0;
      ctx.playerVitals.invulnerabilityRemainingS = 0.22;
    }
  }

  if (ctx.tracerPool) {
    const quat = computeTracerOrientationQuat(shotDir);
    const flightDist = distance(muzzleOrigin, impactPointWorld);
    const ttl = Math.max(0.05, Math.min(0.28, flightDist / tracerSpeedMs));
    ctx.tracerPool.spawnKinematicParticle(
      muzzleOrigin,
      scale(shotDir, tracerSpeedMs),
      vec3(0, 0, 0),
      { x: 0.024, y: 0.024, z: 0.95 },
      0,
      0,
      ttl,
      quat
    );
  }

  const event: EnemyTracerFireEvent = {
    targetId: hs.targetId,
    archetype: hs.archetype,
    muzzleOriginWorld: muzzleOrigin,
    shotDirectionWorld: shotDir,
    impactPointWorld,
    tracerSpeedMs,
    spreadConeRad: aimProfile.effectiveSpreadRad,
    spreadMultiplier: aimProfile.spreadMultiplier,
    hitPlayer,
    blockedByCover,
    armorChipApplied,
    healthDamageApplied,
    activeFiringHand: firingHand,
    usedBackupSidearm: usingSidearm,
    weaponId: usingSidearm ? SIDEARM_M9_TUNING.weaponId : tuning.primaryWeaponId,
  };

  ctx.onEnemyFireTracer?.(event);
  if (hitPlayer && (armorChipApplied > 0 || healthDamageApplied > 0)) {
    ctx.onPlayerDamaged?.(ctx.playerVitals, event);
  }
}
