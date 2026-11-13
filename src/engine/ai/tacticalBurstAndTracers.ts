import type { PlayerNearMissGrazePayload } from '../../contracts/ai/aiContracts.ts';
import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { computeSuppressionTargetWorld } from '../../core/ai/attackTokenPool.ts';
import { cancelActiveBurst, stepWeaponBurstCadence } from '../../core/ai/weaponBurstFsm.ts';
import {
  canFireFromMagazine,
  consumeMagazineRound,
  enemyShotDamageScaleAtRange,
  nextVolleyShotDelayS,
  planVolleyShots,
  resolveEnemyGunHandling,
} from '../../core/ai/enemyGunHandling.ts';
import { canDownedBodyAimAt } from '../../core/ballistics/triage/downedAimReach.ts';
import {
  add,
  copyVec3,
  cross,
  deterministicConeSpread,
  distance,
  normalize,
  scale,
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
import { ARCHETYPE_TUNING, BACKUP_SIDEARM_WEAPON_ID, BACKUP_SIDEARM_TUNING } from './archetypeTuning.ts';
import { getAgentMagazine } from './enemyWeaponMagazine.ts';
import { kickEnemyWeaponSway, refreshEnemyWeaponSway, sampleEnemyWeaponSway } from './enemyWeaponSway.ts';
import { woundedSequenceAllowsShot } from './woundedSequenceDriver.ts';
import {
  bendTowardDeliberateMiss,
  closestApproach,
  fallbackMuzzleOrigin,
  isBarrelOnTarget,
  readEnemyBarrelPose,
  resolveEnemyShotRay,
  type EnemyBarrelPose,
  type EnemyShotRay,
} from './enemyFireSolution.ts';

function primaryHandling(hs: TargetHealthState) {
  return resolveEnemyGunHandling(ARCHETYPE_TUNING[hs.archetype].primaryWeaponId);
}
import { resolveIncomingPlayerShotDamage } from './playerVitalsController.ts';

export interface BurstContext {
  elapsedClockS: number;
  playerVitals: PlayerCombatVitals;
  tracerPool: HardwareInstancedPool | null;
  rapierWorld: RapierPhysicsWorld | null;
  interceptEnemyShotCover?: (origin: Vec3Like, dir: Vec3Like, maxDist: number) => EnemyCoverShotInterceptResult;
  /** Plays the gun's fire clip. The shot itself starts at the barrel read before the clip. */
  playFireVisual?: (targetId: string, usingSidearm: boolean) => Vec3Like | undefined;
  /** The held gun's muzzle and barrel; defaults to the reader the game installs for the frame. */
  readBarrelPose?: (targetId: string, usingSidearm: boolean) => EnemyBarrelPose | null;
  /** Plays the gun's reload clip; returns how long the reload takes, timed like the player's. */
  playReloadVisual?: (targetId: string, usingSidearm: boolean) => number | undefined;
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
  ctx: BurstContext,
  /** True while the shooter is still moving or settling its aim: no new burst starts. */
  holdFire = false
): void {
  // Every enemy shot passes the wounded sequence first: nothing fires while clutching, kneeling
  // down, falling, crawling or lying face down, and a body on the floor only fires at a player
  // straight in front of it (docs/wound-movement.md).
  if (!woundedSequenceAllowsShot(hs, agent)) {
    refreshEnemyWeaponSway(hs, agent, aimProfile, false, ctx.elapsedClockS);
    cancelActiveBurst(agent);
    return;
  }
  // A body on the ground cannot twist round to shoot behind itself. It waits for a target it
  // can actually bring the weapon to bear on.
  if (hs.isRagdollActive && !canDownedBodyAimAt(hs, playerEyeWorldPos)) {
    refreshEnemyWeaponSway(hs, agent, aimProfile, false, ctx.elapsedClockS);
    cancelActiveBurst(agent);
    return;
  }

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
  // The settle-in wobble starts when the shooter stops and brings the gun onto a visible target.
  refreshEnemyWeaponSway(hs, agent, aimProfile, exposedAimTarget !== null && !holdFire, ctx.elapsedClockS);
  const usingSidearm = aimProfile.usingBackupSidearm;
  // The trigger is pulled only while the barrel itself points at the player (within the spread
  // plus a little). Until then the shooter keeps aiming, and mid-burst it waits for the last
  // shot's recoil to settle back onto the target, so bursts climb and recover like the player's.
  const barrel = readBarrel(hs, usingSidearm, ctx);
  const ray = exposedAimTarget ? shotRayFor(hs, agent, barrel, exposedAimTarget, ctx) : null;
  const barrelOnTarget =
    ray !== null &&
    isBarrelOnTarget(ray, [exposedAimTarget!, chestOf(playerEyeWorldPos)], aimProfile.effectiveSpreadRad);
  const isAimAligned =
    !holdFire &&
    barrelOnTarget &&
    (hs.isRagdollActive || Math.abs(wrapAngleRad(aimYaw - hs.yawRad)) <= Math.PI / 12);

  // The gun runs by the same rules as the player's: its own cycle, one shot per pull unless
  // it is full-auto, and nothing fires from an empty or reloading magazine.
  const handling = resolveEnemyGunHandling(usingSidearm ? BACKUP_SIDEARM_WEAPON_ID : tuning.primaryWeaponId);
  const magazine = getAgentMagazine(hs, agent, usingSidearm);
  if (!canFireFromMagazine(magazine)) {
    cancelActiveBurst(agent);
    return;
  }

  const volleySeed = agent.tracerSeedCounter + agent.completedBurstCount * 131;
  let extraShots = 0;
  if (agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded) extraShots = 2;
  else if (agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded) extraShots = 3;
  let desiredBurstShots = planVolleyShots(handling, volleySeed, extraShots);
  if (aimProfile.isOneHandedDownedFire && !usingSidearm) {
    desiredBurstShots = Math.max(1, Math.ceil(desiredBurstShots * 0.65));
  }
  desiredBurstShots = Math.min(desiredBurstShots, magazine.mag);

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
  const oneHandedSlowdown = aimProfile.isOneHandedDownedFire && !usingSidearm ? 1.3 : 1.0;

  // Haste or weakness changes how fast the shooter gets back on target, never the gun's cycle.
  const nextInterShotDelayS = nextVolleyShotDelayS(
    handling,
    volleySeed + agent.burstShotsRemaining * 17,
    cadenceScale * raggedWoundDelay * oneHandedSlowdown
  );

  const baseCooldown = usingSidearm ? BACKUP_SIDEARM_TUNING.burstCooldownS : tuning.burstCooldownS;
  const offScreenCooldownMul = agent.isOffScreen ? 2.0 : 1.0;
  const nextBurstCooldownS = Math.max(
    handling.fireCycleS,
    baseCooldown *
      cadenceScale *
      offScreenCooldownMul *
      (aimProfile.isOneHandedDownedFire && !usingSidearm ? 1.25 : 1.0)
  );

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
  consumeMagazineRound(magazine);

  emitEnemyTracerShot(hs, agent, aimProfile, playerEyeWorldPos, exposedAimTarget, ctx, barrel);

  if (
    burstRes.completedBurst &&
    agent.resolveProfile === 'HARDENED_VETERAN' &&
    agent.completedBurstCount % 2 === 0
  ) {
    agent.peekSign = (agent.peekSign === 1 ? -1 : 1) as -1 | 1;
  }
}

function readBarrel(hs: TargetHealthState, usingSidearm: boolean, ctx: BurstContext): EnemyBarrelPose | null {
  return (ctx.readBarrelPose ?? readEnemyBarrelPose)(hs.targetId, usingSidearm);
}

function shotRayFor(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  barrel: EnemyBarrelPose | null,
  aimTarget: Vec3Like,
  ctx: BurstContext
): EnemyShotRay {
  const sway = sampleEnemyWeaponSway(hs.targetId, ctx.elapsedClockS);
  return resolveEnemyShotRay(barrel, fallbackMuzzleOrigin(hs, agent), aimTarget, sway);
}

function chestOf(playerEye: Vec3Like): Vec3Like {
  return { x: playerEye.x, y: playerEye.y - 0.18, z: playerEye.z };
}

const PLAYER_HIT_RADIUS_M = 0.36;

export function emitEnemyTracerShot(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  aimProfile: EnemyAimProfile,
  playerEyeWorldPos: Vec3Like,
  aimTargetPos: Vec3Like,
  ctx: BurstContext,
  /** The barrel the fire gate already read this tick; read afresh when left out. */
  barrelPose?: EnemyBarrelPose | null
): void {
  const tuning = ARCHETYPE_TUNING[hs.archetype];
  const usingSidearm = aimProfile.usingBackupSidearm;
  const firingHand: ActiveFiringHand = aimProfile.activeFiringHand ?? agent.activeFiringHand;
  const seed = agent.tracerSeedCounter++;

  const isSuppressionToken = agent.fireMode === 'CINEMATIC_SUPPRESSION';
  const firstShotGrace =
    !agent.hasFiredWarningShot &&
    (agent.isOffScreen === true || primaryHandling(hs).fireCycleS < 1.5 || isSuppressionToken);
  agent.hasFiredWarningShot = true;
  const suppressionMode = isSuppressionToken || firstShotGrace;

  // The bullet leaves the muzzle along the barrel the player sees, which the pose has already
  // swung by the sway and recoil. Without a visible gun, the swayed aim line stands in for it.
  const barrel = barrelPose === undefined ? readBarrel(hs, usingSidearm, ctx) : barrelPose;
  const ray = shotRayFor(hs, agent, barrel, aimTargetPos, ctx);
  const origin = ray.origin;
  const missTarget = suppressionMode
    ? computeSuppressionTargetWorld(seed, playerEyeWorldPos, origin, firstShotGrace)
    : null;
  // A suppression or warning shot is aimed a little off the player, never far from the barrel.
  const baseDir = missTarget ? bendTowardDeliberateMiss(ray.dir, origin, aimTargetPos, missTarget) : ray.dir;
  const shotDir = deterministicConeSpread(baseDir, aimProfile.effectiveSpreadRad, (seed % 7) + 1, 8, seed * 31);

  // The muzzle climbs only after the bullet has gone.
  kickEnemyWeaponSway(hs.targetId, usingSidearm ? BACKUP_SIDEARM_TUNING.weaponId : tuning.primaryWeaponId, ctx.elapsedClockS);

  const playerChestTarget = chestOf(playerEyeWorldPos);
  const chest = closestApproach(origin, shotDir, playerChestTarget);
  const aimed = closestApproach(origin, shotDir, aimTargetPos);
  const chestHit = chest.missM <= PLAYER_HIT_RADIUS_M;
  const aimHit = aimed.missM <= PLAYER_HIT_RADIUS_M;
  const wouldHitPlayer = !suppressionMode && (chestHit || aimHit);
  const playerHitDist = chestHit
    ? chest.along
    : aimHit
      ? aimed.along
      : Math.max(0.5, distance(origin, missTarget ?? aimTargetPos));
  const playerHitPoint = chestHit ? chest.pointWorld : aimed.pointWorld;
  const coverCheckDist = wouldHitPlayer ? Math.max(0.05, playerHitDist) : playerHitDist + 6.0;

  // Every impact lies on the shot line, so the tracer and the sparks follow the bullet.
  let blockedByCover = false;
  let impactPointWorld = add(origin, scale(shotDir, firstShotGrace ? playerHitDist : playerHitDist + 4.0));
  let impactNormalWorld: Vec3Like | undefined = firstShotGrace ? vec3(0, 1, 0) : undefined;
  let impactSurfaceTag: string | undefined = firstShotGrace ? 'CONCRETE_WALL' : undefined;

  if (ctx.interceptEnemyShotCover) {
    const intercept = ctx.interceptEnemyShotCover(origin, shotDir, coverCheckDist);
    if (intercept.blocked) {
      blockedByCover = true;
      impactPointWorld =
        intercept.impactPointWorld ??
        intercept.hitPointWorld ??
        add(origin, scale(shotDir, coverCheckDist));
      impactNormalWorld = intercept.impactNormalWorld ?? intercept.hitNormalWorld;
      impactSurfaceTag = intercept.impactSurfaceTag ?? intercept.surfaceTag;
    }
  } else if (ctx.rapierWorld) {
    const hits = ctx.rapierWorld.castPenetrationRay(origin, shotDir, coverCheckDist);
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

  // The fire clip only animates the gun; the shot already starts at the barrel read above.
  ctx.playFireVisual?.(hs.targetId, usingSidearm);
  const muzzleOrigin = origin;
  const tracerSpeedMs = usingSidearm ? BACKUP_SIDEARM_TUNING.tracerSpeedMs : tuning.tracerSpeedMs;
  const firedWeaponId = usingSidearm ? BACKUP_SIDEARM_TUNING.weaponId : tuning.primaryWeaponId;
  const rawChip =
    (usingSidearm ? BACKUP_SIDEARM_TUNING.baseChipDamage : tuning.baseChipDamage) *
    enemyShotDamageScaleAtRange(firedWeaponId, distance(origin, playerChestTarget));

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
    // The tracer flies from the muzzle along the bullet's own line, never toward a point the
    // gun was not aimed at.
    const tracerDir = shotDir;
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

  const weaponId = firedWeaponId;
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
