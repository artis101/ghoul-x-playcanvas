import {
  AmmoSpec,
  DismembermentEvent,
  EnvironmentState,
  GhoulZoneId,
  PelletTrajectoryResult,
  ProjectileState,
  ShotSimulationReport,
  TargetHealthState,
  TrajectorySample,
  Vec3Like,
  WeaponSpec,
  WoundChannelEvent,
} from '../../../contracts/ballistics.ts';
import {
  add,
  copyVec3,
  cross,
  deterministicConeSpread,
  distance,
  dot,
  length,
  lengthSq,
  normalize,
  scale,
  sub,
  vec3,
} from '../vec3.ts';
import { stepProjectileRK4InPlace } from '../external/rk4Integrator.ts';
import { computeTargetLiveBounds } from '../math/segmentIntersections.ts';
import { findSegmentHits } from './shotNarrowPhase.ts';
import { evaluateArmorInteraction } from './shotArmorInteraction.ts';
import { evaluateTissueCavitation } from './shotTissueCavitation.ts';
import { evaluateJointDismemberment } from './shotJointDismemberment.ts';
import { evaluateLethalityAndRagdollPlan } from './shotLethalityPass.ts';

export interface SimulateShotOptions {
  readonly allowedPelletIndices?: ReadonlySet<number>;
  readonly pelletSpeedOverridesMs?: ReadonlyMap<number, number>;
}

export function simulateShot(
  weapon: WeaponSpec,
  ammo: AmmoSpec,
  originWorld: Vec3Like,
  aimDirectionWorld: Vec3Like,
  target: TargetHealthState,
  env: EnvironmentState,
  options?: SimulateShotOptions
): ShotSimulationReport {
  const shotId = `shot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const normAimDir = normalize(aimDirectionWorld);
  const pelletCount = Math.max(1, ammo.pelletCount);
  const muzzleEnergyJ = 0.5 * ammo.massKg * ammo.muzzleVelocityMs * ammo.muzzleVelocityMs;

  const pelletResults: PelletTrajectoryResult[] = [];
  const allWoundEvents: WoundChannelEvent[] = [];
  const shatteredBonesSet = new Set<string>();
  const rupturedOrgansSet = new Set<string>();
  const combatantEffectsSet = new Set<string>();
  const severedZonesSet = new Set<GhoulZoneId>(target.severedZones);
  const newlySeveredZones: GhoulZoneId[] = [];
  const dismembermentEvents: DismembermentEvent[] = [];

  const zoneEnergyDeposited: Partial<Record<GhoulZoneId, number>> = {};
  const zoneImpulses: Partial<Record<GhoulZoneId, Vec3Like>> = {};

  let totalEnergyDepositedJ = 0;
  let totalDamageHp = 0;
  let hasHitTarget = false;
  let firstImpactSpeed = ammo.muzzleVelocityMs;
  let firstImpactEnergy = muzzleEnergyJ;
  let firstImpactTime = 0;
  let bulletDropAtImpactCm = 0;
  let windDriftAtImpactCm = 0;
  let primaryHitZone: GhoulZoneId | null = null;
  let netRootImpulseWorld: Vec3Like = vec3(0, 0, 0);
  let netTorqueWorld: Vec3Like = vec3(0, 0, 0);
  let headgearKnockedOff = false;
  let weaponDisarmed = false;

  const bounds = computeTargetLiveBounds(target);
  const dt = 0.0015;
  const maxFlightTimeS = 2.0;
  const boundsMaxDx = Math.max(Math.abs(bounds.minX - originWorld.x), Math.abs(bounds.maxX - originWorld.x));
  const boundsMaxDy = Math.max(Math.abs(bounds.minY - originWorld.y), Math.abs(bounds.maxY - originWorld.y));
  const boundsMaxDz = Math.max(Math.abs(bounds.minZ - originWorld.z), Math.abs(bounds.maxZ - originWorld.z));
  const effectiveMaxRangeM = Math.min(300.0, Math.max(4.0, Math.hypot(boundsMaxDx, boundsMaxDy, boundsMaxDz) + 2.2));

  for (let pIdx = 0; pIdx < pelletCount; pIdx++) {
    const pelletAimDir = deterministicConeSpread(normAimDir, ammo.spreadRadians, pIdx, pelletCount);
    if (options?.allowedPelletIndices && !options.allowedPelletIndices.has(pIdx)) {
      pelletResults.push({
        pelletIndex: pIdx,
        aimDirectionWorld: pelletAimDir,
        hitTarget: false,
        impactTimeS: 0,
        impactPointWorld: null,
        impactZone: null,
        energyDepositedJ: 0,
        impulseNs: 0,
        trajectorySamples: [],
        woundEvents: [],
      });
      continue;
    }

    const initialPelletSpeedMs = options?.pelletSpeedOverridesMs?.get(pIdx) ?? ammo.muzzleVelocityMs;
    const initialPelletEnergyJ = 0.5 * ammo.massKg * initialPelletSpeedMs * initialPelletSpeedMs;
    const shotRightRaw = cross(pelletAimDir, vec3(0, 1, 0));
    const shotRight = lengthSq(shotRightRaw) > 1e-6 ? normalize(shotRightRaw) : vec3(1, 0, 0);

    let proj: ProjectileState = {
      id: `${shotId}_p${pIdx}`,
      ammo,
      position: copyVec3(originWorld),
      velocity: scale(pelletAimDir, initialPelletSpeedMs),
      spinRadS: weapon.role === 'SNIPER' ? 2400 : weapon.role === 'ASSAULT_RIFLE' ? 3000 : 0,
      currentDiameterM: ammo.diameterM,
      flightTimeS: 0,
      distanceTraveledM: 0,
      kineticEnergyJ: initialPelletEnergyJ,
      penetratedLayers: 0,
      alive: true,
    };

    const trajectorySamples: TrajectorySample[] = [];
    const pelletWoundEvents: WoundChannelEvent[] = [];
    const penetratedColliders = new Set<string>();

    trajectorySamples.push({
      timeS: 0,
      position: copyVec3(proj.position),
      velocity: copyVec3(proj.velocity),
      speedMs: initialPelletSpeedMs,
      mach: initialPelletSpeedMs / env.speedOfSoundMs,
      kineticEnergyJ: initialPelletEnergyJ,
      dropM: 0,
      windDriftM: 0,
    });

    let pelletHit = false;
    let pelletImpactTime = 0;
    let pelletImpactPoint: Vec3Like | null = null;
    let pelletImpactZone: GhoulZoneId | null = null;
    let pelletEnergyDeposited = 0;
    let pelletImpulseTransferred = 0;
    let stepIdx = 0;
    const prevPos: Vec3Like = { x: 0, y: 0, z: 0 };

    while (proj.alive && proj.distanceTraveledM < effectiveMaxRangeM && proj.flightTimeS < maxFlightTimeS && proj.position.y > -5.0) {
      prevPos.x = proj.position.x;
      prevPos.y = proj.position.y;
      prevPos.z = proj.position.z;
      stepProjectileRK4InPlace(proj, env, dt, pIdx);
      const currPos = proj.position;
      stepIdx++;

      if (stepIdx < 50 || stepIdx % 5 === 0) {
        const speed = length(proj.velocity);
        const straightX = originWorld.x + pelletAimDir.x * proj.distanceTraveledM;
        const straightY = originWorld.y + pelletAimDir.y * proj.distanceTraveledM;
        const straightZ = originWorld.z + pelletAimDir.z * proj.distanceTraveledM;
        const drop = straightY - currPos.y;
        const drift = (currPos.x - straightX) * shotRight.x + (currPos.y - straightY) * shotRight.y + (currPos.z - straightZ) * shotRight.z;

        trajectorySamples.push({
          timeS: proj.flightTimeS,
          position: copyVec3(currPos),
          velocity: copyVec3(proj.velocity),
          speedMs: speed,
          mach: speed / env.speedOfSoundMs,
          kineticEnergyJ: proj.kineticEnergyJ,
          dropM: drop,
          windDriftM: drift,
        });
      }

      const segMinX = Math.min(prevPos.x, currPos.x);
      const segMaxX = Math.max(prevPos.x, currPos.x);
      const segMinY = Math.min(prevPos.y, currPos.y);
      const segMaxY = Math.max(prevPos.y, currPos.y);
      const segMinZ = Math.min(prevPos.z, currPos.z);
      const segMaxZ = Math.max(prevPos.z, currPos.z);

      const aabbOverlap = segMaxX >= bounds.minX && segMinX <= bounds.maxX && segMaxY >= bounds.minY && segMinY <= bounds.maxY && segMaxZ >= bounds.minZ && segMinZ <= bounds.maxZ;

      if (aabbOverlap) {
        const hits = findSegmentHits(prevPos, currPos, target, penetratedColliders);
        if (hits.length > 0) {
          pelletHit = true;
          hasHitTarget = true;

          for (const hit of hits) {
            if (!proj.alive) break;
            const col = hit.collider;

            if (!pelletImpactPoint) {
              pelletImpactPoint = hit.entryWorld;
              pelletImpactZone = col.ghoulZone;
              pelletImpactTime = proj.flightTimeS;

              if (!primaryHitZone) {
                primaryHitZone = col.ghoulZone;
                firstImpactSpeed = length(proj.velocity);
                firstImpactEnergy = proj.kineticEnergyJ;
                firstImpactTime = proj.flightTimeS;

                const straightPos = add(originWorld, scale(pelletAimDir, proj.distanceTraveledM));
                bulletDropAtImpactCm = (straightPos.y - hit.entryWorld.y) * 100;
                windDriftAtImpactCm = dot(sub(hit.entryWorld, straightPos), shotRight) * 100;
              }
            }

            const currentSpeed = length(proj.velocity);
            const entryEnergy = proj.kineticEnergyJ;
            const bulletDir = normalize(proj.velocity);

            if (col.layerType === 'ARMOR_KEVLAR') {
              const armorRes = evaluateArmorInteraction(proj, ammo, hit, currentSpeed, entryEnergy, bulletDir);
              if (armorRes.stopped) {
                totalDamageHp += armorRes.bluntDamageHp;
                totalEnergyDepositedJ += armorRes.energyDeposited;
                pelletEnergyDeposited += armorRes.energyDeposited;
                pelletImpulseTransferred += armorRes.impulseMagnitude;
                zoneImpulses[col.ghoulZone] = add(zoneImpulses[col.ghoulZone] || vec3(0, 0, 0), armorRes.impulseVec);
                netRootImpulseWorld = add(netRootImpulseWorld, armorRes.impulseVec);
                if (armorRes.headgearKnockedOff) headgearKnockedOff = true;
                combatantEffectsSet.add(armorRes.effectMessage);
                if (armorRes.woundEvent) {
                  pelletWoundEvents.push(armorRes.woundEvent);
                  allWoundEvents.push(armorRes.woundEvent);
                }
                penetratedColliders.add(col.id);
                break;
              } else {
                penetratedColliders.add(col.id);
                combatantEffectsSet.add(armorRes.effectMessage);
                continue;
              }
            }

            const cavRes = evaluateTissueCavitation(proj, ammo, target, hit, currentSpeed, entryEnergy, bulletDir);
            totalDamageHp += cavRes.layerDamage;
            totalEnergyDepositedJ += cavRes.energyDeposited;
            pelletEnergyDeposited += cavRes.energyDeposited;
            pelletImpulseTransferred += cavRes.impulseMagnitude;

            const curZE = zoneEnergyDeposited[col.ghoulZone] || 0;
            zoneEnergyDeposited[col.ghoulZone] = curZE + cavRes.energyDeposited * ammo.goreFactor;
            zoneImpulses[col.ghoulZone] = add(zoneImpulses[col.ghoulZone] || vec3(0, 0, 0), cavRes.impulseVec);
            netRootImpulseWorld = add(netRootImpulseWorld, cavRes.impulseVec);

            const comWorld = target.ragdollBones.PELVIS_GROIN.position;
            netTorqueWorld = add(netTorqueWorld, cross(sub(hit.entryWorld, comWorld), cavRes.impulseVec));

            if (cavRes.boneFractured) shatteredBonesSet.add(col.label);
            if (cavRes.organRuptured || cavRes.arterialSevered) rupturedOrgansSet.add(col.label);
            combatantEffectsSet.add(cavRes.physEffect);

            if (cavRes.headgearKnockedOff) headgearKnockedOff = true;
            if (cavRes.weaponDisarmed) weaponDisarmed = true;

            pelletWoundEvents.push(cavRes.woundEvent);
            allWoundEvents.push(cavRes.woundEvent);
            penetratedColliders.add(col.id);
          }
        }
      }
    }

    pelletResults.push({
      pelletIndex: pIdx,
      aimDirectionWorld: pelletAimDir,
      hitTarget: pelletHit,
      impactTimeS: pelletImpactTime,
      impactPointWorld: pelletImpactPoint,
      impactZone: pelletImpactZone,
      energyDepositedJ: pelletEnergyDeposited,
      impulseNs: pelletImpulseTransferred,
      trajectorySamples,
      woundEvents: pelletWoundEvents,
    });
  }

  // Range is measured across the ground: eye height above the feet is not distance to the target.
  const targetDistanceM = Math.hypot(originWorld.x - target.worldPosition.x, originWorld.z - target.worldPosition.z);

  const dismRes = evaluateJointDismemberment(
    weapon, ammo, target, targetDistanceM, normAimDir,
    allWoundEvents, zoneEnergyDeposited, zoneImpulses,
    severedZonesSet, newlySeveredZones, dismembermentEvents, combatantEffectsSet
  );
  if (dismRes.weaponDisarmed) weaponDisarmed = true;

  const lethality = evaluateLethalityAndRagdollPlan(
    weapon, ammo, target, targetDistanceM, normAimDir, hasHitTarget,
    primaryHitZone, firstImpactTime, totalEnergyDepositedJ, totalDamageHp,
    allWoundEvents, dismembermentEvents, severedZonesSet,
    shatteredBonesSet, rupturedOrgansSet, zoneImpulses,
    netRootImpulseWorld, netTorqueWorld
  );
  totalDamageHp = lethality.totalDamageHp;

  const primarySamples = pelletResults[0]?.trajectorySamples || [];
  if (!hasHitTarget && primarySamples.length > 1) {
    let closestSample = primarySamples[primarySamples.length - 1];
    let minDistDiff = Infinity;
    for (const s of primarySamples) {
      const d = distance(originWorld, s.position);
      const diff = Math.abs(d - targetDistanceM);
      if (diff < minDistDiff) {
        minDistDiff = diff;
        closestSample = s;
      }
    }
    bulletDropAtImpactCm = closestSample.dropM * 100;
    windDriftAtImpactCm = closestSample.windDriftM * 100;
  }

  return {
    shotId,
    weaponId: weapon.id,
    ammoId: ammo.id,
    originWorld: copyVec3(originWorld),
    aimDirectionWorld: copyVec3(normAimDir),
    targetDistanceM,
    pelletCount,
    muzzleEnergyJ,
    impactSpeedMs: firstImpactSpeed,
    impactEnergyJ: firstImpactEnergy,
    flightTimeAtImpactS: firstImpactTime,
    bulletDropAtImpactCm,
    windDriftAtImpactCm,
    hitTarget: hasHitTarget,
    targetId: hasHitTarget ? target.targetId : null,
    pelletResults,
    woundEvents: allWoundEvents,
    totalEnergyDepositedJ,
    totalDamageHp,
    isLethalKill: lethality.isLethalKill,
    ragdollPlan: lethality.ragdollPlan,
    severedZones: newlySeveredZones,
    dismembermentEvents,
    shatteredBones: Array.from(shatteredBonesSet),
    rupturedOrgans: Array.from(rupturedOrgansSet),
    combatantEffects: Array.from(combatantEffectsSet),
    headgearKnockedOff,
    weaponDisarmed,
    trajectorySamples: primarySamples,
  };
}
