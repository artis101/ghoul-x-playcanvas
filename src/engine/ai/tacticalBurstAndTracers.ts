import type { PlayerNearMissGrazePayload } from '../../contracts/ai/aiContracts.ts';
import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { computeSuppressionTargetWorld } from '../../core/ai/attackTokenPool.ts';
import { stepWeaponBurstCadence } from '../../core/ai/weaponBurstFsm.ts';
import {
  add,
  copyVec3,
  cross,
  deterministicConeSpread,
  distance,
  dot,
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
import { wrapAngleRad, yawToward } from './combatantArmEvaluation.ts';
import { ARCHETYPE_TUNING, SIDEARM_M9_TUNING } from './archetypeTuning.ts';
import { resolveIncomingPlayerShotDamage } from './playerVitalsController.ts';

export interface BurstContext {
  elapsedClockS: number;
  playerVitals: PlayerCombatVitals;
  tracerPool: HardwareInstancedPool | null;
  rapierWorld: RapierPhysicsWorld | null;
  interceptEnemyShotCover?: (origin: Vec3Like, dir: Vec3Like, maxDist: number) => EnemyCoverShotInterceptResult;
  playFireVisual?: (targetId: string, usingSidearm: boolean) => Vec3Like | undefined;
  onEnemyFireTracer?: (event: EnemyTracerFireEvent) => void;
  onPlayerDamaged?: (vitals: Readonly<PlayerCombatVitals>, event: EnemyTracerFireEvent) => void;
  onPlayerNearMissGraze?: (event: PlayerNearMissGrazePayload) => void;
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
  const isWounded =
    hs.currentHp < hs.maxHp * 0.88 || hs.painShock > 0.18 || hs.rupturedOrgans.size > 0;

  const exposedAimTarget = ctx.resolveExposedPlayerAimPoint(hs, agent, playerEyeWorldPos);
  if (exposedAimTarget) {
    agent.lastAimTargetWorld = copyVec3(exposedAimTarget);
  }

  const aimYaw = exposedAimTarget
    ? yawToward(hs.worldPosition, exposedAimTarget, hs.yawRad)
    : hs.yawRad;
  const isAimAligned =
    hs.isRagdollActive || Math.abs(wrapAngleRad(aimYaw - hs.yawRad)) <= Math.PI / 12;

  let desiredBurstShots: number;
  if (aimProfile.usingBackupSidearm) {
    desiredBurstShots = agent.completedBurstCount % 2 === 0 ? 2 : 3;
  } else {
    let desiredBurst = tuning.burstCount;
    if (agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded) desiredBurst += 2;
    else if (agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded) desiredBurst += 3;
    desiredBurstShots = aimProfile.isOneHandedDownedFire
      ? Math.max(2, Math.ceil(desiredBurst * 0.65))
      : desiredBurst;
  }

  const cadenceScale =
    agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded
      ? 0.65
      : agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded
        ? 0.75
        : agent.resolveProfile === 'HARDENED_VETERAN'
          ? 0.92
          : 1.0;
  const raggedWoundDelay =
    agent.triageStatus === 'MORTALLY_WOUNDED' && agent.resolveProfile !== 'FANATIC_BERSERKER'
      ? 1.18
      : 1.0;

  const baseInterShot = aimProfile.usingBackupSidearm
    ? SIDEARM_M9_TUNING.interShotDelayS
    : tuning.interShotDelayS;
  const nextInterShotDelayS =
    baseInterShot *
    cadenceScale *
    raggedWoundDelay *
    (aimProfile.isOneHandedDownedFire && !aimProfile.usingBackupSidearm ? 1.3 : 1.0);

  const baseCooldown = aimProfile.usingBackupSidearm
    ? SIDEARM_M9_TUNING.burstCooldownS
    : tuning.burstCooldownS;
  const offScreenCooldownMul = agent.isOffScreen ? 2.0 : 1.0;
  const nextBurstCooldownS =
    baseCooldown *
    cadenceScale *
    offScreenCooldownMul *
    (aimProfile.isOneHandedDownedFire && !aimProfile.usingBackupSidearm ? 1.25 : 1.0);

  const burstRes = stepWeaponBurstCadence(agent, {
    dt,
    hasLineOfSight: exposedAimTarget !== null,
    isAimAligned,
    desiredBurstShots,
    nextInterShotDelayS,
    nextBurstCooldownS,
  });

  if (!burstRes.shouldFireShot || !exposedAimTarget) {
    return;
  }

  emitEnemyTracerShot(hs, agent, aimProfile, playerEyeWorldPos, exposedAimTarget, ctx);

  if (
    burstRes.completedBurst &&
    agent.resolveProfile === 'HARDENED_VETERAN' &&
    agent.completedBurstCount % 2 === 0
  ) {
    agent.peekSign = (agent.peekSign === 1 ? -1 : 1) as -1 | 1;
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
  const basePos = hs.isRagdollActive
    ? hs.ragdollBones.TORSO_UPPER_THORAX?.position ?? hs.worldPosition
    : hs.worldPosition;
  const muzzleHeight = hs.isRagdollActive
    ? Math.max(0.42, basePos.y)
    : isGroundedOrDowned
      ? hs.worldPosition.y + 0.62
      : hs.worldPosition.y + 1.32;

  const coreOrigin: Vec3Like = { x: basePos.x, y: muzzleHeight, z: basePos.z };
  const seed = agent.tracerSeedCounter++;

  const isSuppressionToken = agent.fireMode === 'CINEMATIC_SUPPRESSION';
  const firstShotGrace =
    !agent.hasFiredWarningShot &&
    (agent.isOffScreen === true || tuning.burstCount > 1 || isSuppressionToken);
  agent.hasFiredWarningShot = true;
  const suppressionMode = isSuppressionToken || firstShotGrace;

  const effectiveAimTargetPos = suppressionMode
    ? computeSuppressionTargetWorld(seed, playerEyeWorldPos, coreOrigin, firstShotGrace)
    : aimTargetPos;

  const idealDir = normalize(sub(effectiveAimTargetPos, coreOrigin));
  const fwdDir = usingSidearm ? idealDir : { x: Math.sin(hs.yawRad), y: 0, z: Math.cos(hs.yawRad) };

  const rawMuzzleOrigin: Vec3Like = handPos
    ? add(handPos, scale(fwdDir, usingSidearm ? 0.19 : 0.28))
    : { x: coreOrigin.x + fwdDir.x * 0.38, y: muzzleHeight, z: coreOrigin.z + fwdDir.z * 0.38 };

  const playerChestTarget: Vec3Like = {
    x: playerEyeWorldPos.x,
    y: playerEyeWorldPos.y - 0.18,
    z: playerEyeWorldPos.z,
  };
  const shotDir = deterministicConeSpread(
    idealDir,
    aimProfile.effectiveSpreadRad,
    (seed % 7) + 1,
    8,
    seed * 31
  );

  const toChest = sub(playerChestTarget, coreOrigin);
  const alongChest = dot(toChest, shotDir);
  const closestChestPt = alongChest > 0 ? add(coreOrigin, scale(shotDir, alongChest)) : coreOrigin;
  const missDistChest = alongChest > 0 ? distance(closestChestPt, playerChestTarget) : Infinity;

  const toAim = sub(aimTargetPos, coreOrigin);
  const alongAim = dot(toAim, shotDir);
  const closestAimPt = alongAim > 0 ? add(coreOrigin, scale(shotDir, alongAim)) : coreOrigin;
  const missDistAim = alongAim > 0 ? distance(closestAimPt, aimTargetPos) : Infinity;

  const wouldHitPlayer = !suppressionMode && (missDistChest <= 0.36 || missDistAim <= 0.36);
  const playerHitDist =
    missDistChest <= 0.36
      ? alongChest
      : missDistAim <= 0.36
        ? alongAim
        : Math.max(0.5, distance(coreOrigin, effectiveAimTargetPos));
  const playerHitPoint = missDistChest <= 0.36 ? closestChestPt : closestAimPt;
  const coverCheckDist = wouldHitPlayer ? Math.max(0.05, playerHitDist) : playerHitDist + 6.0;

  let blockedByCover = false;
  let impactPointWorld = firstShotGrace
    ? copyVec3(effectiveAimTargetPos)
    : add(coreOrigin, scale(shotDir, playerHitDist + 4.0));
  let impactNormalWorld: Vec3Like | undefined = firstShotGrace ? vec3(0, 1, 0) : undefined;
  let impactSurfaceTag: string | undefined = firstShotGrace ? 'CONCRETE_WALL' : undefined;

  if (ctx.interceptEnemyShotCover) {
    const intercept = ctx.interceptEnemyShotCover(coreOrigin, shotDir, coverCheckDist);
    if (intercept.blocked) {
      blockedByCover = true;
      impactPointWorld =
        intercept.impactPointWorld ??
        intercept.hitPointWorld ??
        add(coreOrigin, scale(shotDir, coverCheckDist));
      impactNormalWorld = intercept.impactNormalWorld ?? intercept.hitNormalWorld;
      impactSurfaceTag = intercept.impactSurfaceTag ?? intercept.surfaceTag;
    }
  } else if (ctx.rapierWorld) {
    const hits = ctx.rapierWorld.castPenetrationRay(coreOrigin, shotDir, coverCheckDist);
    for (const h of hits) {
      if (h.distanceM > coverCheckDist) continue;
      const isGlass =
        h.surface.material === 'GLASS_MARCHING_256' || h.surface.material === 'GLASS_VORONOI';
      if (isGlass && !suppressionMode) continue;
      blockedByCover = true;
      impactPointWorld = h.pointWorld;
      impactNormalWorld = h.normalWorld;
      impactSurfaceTag = h.surface.material;
      break;
    }
  }

  const visualMuzzle = ctx.playFireVisual?.(hs.targetId, usingSidearm);
  const muzzleOrigin =
    blockedByCover && distance(coreOrigin, impactPointWorld) < 0.48
      ? coreOrigin
      : visualMuzzle ?? rawMuzzleOrigin;
  const tracerSpeedMs = usingSidearm ? SIDEARM_M9_TUNING.tracerSpeedMs : tuning.tracerSpeedMs;
  const rawChip = usingSidearm ? SIDEARM_M9_TUNING.baseChipDamage : tuning.baseChipDamage;

  let hitPlayer = false;
  let armorChipApplied = 0;
  let healthDamageApplied = 0;

  if (!blockedByCover && wouldHitPlayer) {
    hitPlayer = true;
    impactPointWorld = playerHitPoint;
    const dmgRes = resolveIncomingPlayerShotDamage(ctx.playerVitals, {
      rawChipDamage: rawChip,
      attackerId: hs.targetId,
      archetype: hs.archetype,
      hitPointWorld: playerHitPoint,
      playerEyeWorldPos,
    });
    armorChipApplied = dmgRes.armorChipApplied;
    healthDamageApplied = dmgRes.healthDamageApplied;
    if (dmgRes.grazeEvent) {
      ctx.onPlayerNearMissGraze?.(dmgRes.grazeEvent);
    }
  }

  if (ctx.tracerPool) {
    const tracerDir =
      visualMuzzle && muzzleOrigin === visualMuzzle
        ? normalize(sub(impactPointWorld, muzzleOrigin))
        : shotDir;
    const quat = computeTracerOrientationQuat(tracerDir);
    const flightDist = distance(muzzleOrigin, impactPointWorld);
    const ttl = Math.max(0.05, Math.min(0.28, flightDist / tracerSpeedMs));
    ctx.tracerPool.spawnKinematicParticle(
      muzzleOrigin,
      scale(tracerDir, tracerSpeedMs),
      vec3(0, 0, 0),
      { x: 0.024, y: 0.024, z: 0.95 },
      0,
      0,
      ttl,
      quat
    );
  }

  const weaponId = usingSidearm ? SIDEARM_M9_TUNING.weaponId : tuning.primaryWeaponId;
  const event: EnemyTracerFireEvent = {
    targetId: hs.targetId,
    archetype: hs.archetype,
    muzzleOriginWorld: muzzleOrigin,
    shotDirectionWorld: shotDir,
    impactPointWorld,
    impactNormalWorld,
    impactSurfaceTag,
    tracerSpeedMs,
    spreadConeRad: aimProfile.effectiveSpreadRad,
    spreadMultiplier: aimProfile.spreadMultiplier,
    hitPlayer,
    blockedByCover,
    armorChipApplied,
    healthDamageApplied,
    activeFiringHand: firingHand,
    usedBackupSidearm: usingSidearm,
    weaponId,
    isSupersonic: !usingSidearm,
    suppressionMode,
  };

  ctx.onEnemyFireTracer?.(event);
  if (hitPlayer && (armorChipApplied > 0 || healthDamageApplied > 0)) {
    ctx.onPlayerDamaged?.(ctx.playerVitals, event);
  }
}
