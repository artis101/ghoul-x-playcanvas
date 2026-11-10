import {
  WeaponSpec,
  AmmoSpec,
  EnvironmentState,
  ProjectileState,
  TrajectorySample,
  TargetHealthState,
  AnatomicalColliderVolume,
  WoundChannelEvent,
  PelletTrajectoryResult,
  ShotSimulationReport,
  RagdollActivationPlan,
  DismembermentEvent,
  GhoulZoneId,
  GoreMode,
  Vec3Like,
} from '../../contracts/ballistics.ts';
import {
  vec3,
  copyVec3,
  add,
  sub,
  scale,
  dot,
  cross,
  length,
  lengthSq,
  normalize,
  distance,
  deterministicConeSpread,
} from './vec3.ts';
import {
  ALL_GHOUL_ZONES,
  buildAnatomicalColliders,
  getSubtreeZones,
  GHOUL_ZONE_HIERARCHY,
} from '../ghoul/anatomy.ts';

// Cache colliders and bone rest lengths statically for performance
const ALL_ANATOMICAL_COLLIDERS = buildAnatomicalColliders();
const TOPOLOGICAL_GHOUL_ZONES = getSubtreeZones('PELVIS_GROIN');
const BONE_REST_LENGTHS: Partial<Record<GhoulZoneId, number>> = {};
for (const z of ALL_GHOUL_ZONES) {
  const node = GHOUL_ZONE_HIERARCHY[z];
  if (node.parent) {
    BONE_REST_LENGTHS[z] = distance(
      node.jointLocalPos,
      GHOUL_ZONE_HIERARCHY[node.parent].jointLocalPos
    );
  }
}

/**
 * Standard Mach drag multiplier model (realistic transonic drag rise between Mach 0.85 and 1.3).
 * Follows the standard G1 ballistic drag curve behavior.
 */
export function computeMachDragMultiplier(mach: number): number {
  if (mach < 0.75) {
    // Pure subsonic: steady baseline drag
    return 1.0;
  } else if (mach < 1.0) {
    // Transonic compression rise
    const t = (mach - 0.75) / 0.25;
    return 1.0 + 1.6 * (t * t); // Rises from 1.0 to 2.6
  } else if (mach < 1.35) {
    // Peak wave drag behind sonic barrier
    const t = (mach - 1.0) / 0.35;
    return 2.6 - 0.7 * t; // Drops from 2.6 down to 1.9
  } else if (mach < 2.5) {
    // Supersonic steady expansion
    const t = (mach - 1.35) / 1.15;
    return 1.9 - 0.5 * t; // Drops to 1.4
  } else {
    // Hypersonic asymptotic taper
    return 1.35;
  }
}

/**
 * 4th-Order Runge-Kutta (RK4) numerical ballistic integrator.
 * Solves:
 *   dv/dt = g - 0.5 * rho * A * Cd * M(mach) * |v - w| * (v - w) / m
 *   dx/dt = v
 */
export function stepProjectileRK4(
  proj: ProjectileState,
  env: EnvironmentState,
  dt: number
): ProjectileState {
  if (!proj.alive || dt <= 0) return proj;

  const m = proj.ammo.massKg;
  const area = Math.PI * Math.pow(proj.currentDiameterM * 0.5, 2);
  const baseCd = proj.ammo.dragCoefficient;
  const rho = env.airDensityKgM3;
  const vsound = env.speedOfSoundMs;

  const computeAcceleration = (pos: Vec3Like, vel: Vec3Like): Vec3Like => {
    // Relative air velocity accounting for wind
    const vRel = sub(vel, env.windVelocity);
    const speedRel = length(vRel);
    if (speedRel < 1e-4) {
      return env.gravity;
    }

    const mach = speedRel / vsound;
    const machMult = computeMachDragMultiplier(mach);
    const cd = baseCd * machMult;

    // Aerodynamic drag force: F_drag = 0.5 * rho * v_rel^2 * Cd * Area in direction -vRel
    const dragMagnitude = 0.5 * rho * speedRel * speedRel * cd * area;
    const dragAccelMag = dragMagnitude / m;
    const dragAccel = scale(normalize(vRel), -dragAccelMag);

    // Spin drift (small sideways deflection from bullet spin and rifling twist)
    let spinDriftAccel: Vec3Like = { x: 0, y: 0, z: 0 };
    if (proj.spinRadS !== 0 && speedRel > 10) {
      // Right-hand rifling twist causes slight rightward drift
      const vNorm = normalize(vel);
      const driftDir = normalize(cross({ x: 0, y: 1, z: 0 }, vNorm));
      // Realistic rifle spin drift acceleration: ~0.3 - 0.7 m/s^2 at supersonic speeds
      // Yielding ~2cm drift at 200m, ~15cm at 500m
      const driftAccelMag = 0.00012 * proj.spinRadS * (speedRel / vsound);
      spinDriftAccel = scale(driftDir, driftAccelMag);
    }

    return add(add(env.gravity, dragAccel), spinDriftAccel);
  };

  const p0 = proj.position;
  const v0 = proj.velocity;

  // k1
  const a1 = computeAcceleration(p0, v0);
  const dp1 = v0;

  // k2
  const p1 = add(p0, scale(dp1, 0.5 * dt));
  const v1 = add(v0, scale(a1, 0.5 * dt));
  const a2 = computeAcceleration(p1, v1);
  const dp2 = v1;

  // k3
  const p2 = add(p0, scale(dp2, 0.5 * dt));
  const v2 = add(v0, scale(a2, 0.5 * dt));
  const a3 = computeAcceleration(p2, v2);
  const dp3 = v2;

  // k4
  const p3 = add(p0, scale(dp3, dt));
  const v3 = add(v0, scale(a3, dt));
  const a4 = computeAcceleration(p3, v3);
  const dp4 = v3;

  // Combine RK4 increments
  // pos = p0 + (dt/6) * (dp1 + 2*dp2 + 2*dp3 + dp4)
  const dpCombined = scale(
    add(add(dp1, scale(dp2, 2)), add(scale(dp3, 2), dp4)),
    dt / 6
  );
  // vel = v0 + (dt/6) * (a1 + 2*a2 + 2*a3 + a4)
  const dvCombined = scale(
    add(add(a1, scale(a2, 2)), add(scale(a3, 2), a4)),
    dt / 6
  );

  const nextPos = add(p0, dpCombined);
  const nextVel = add(v0, dvCombined);
  const nextSpeed = length(nextVel);
  const stepDist = length(dpCombined);

  return {
    ...proj,
    position: nextPos,
    velocity: nextVel,
    flightTimeS: proj.flightTimeS + dt,
    distanceTraveledM: proj.distanceTraveledM + stepDist,
    kineticEnergyJ: 0.5 * m * nextSpeed * nextSpeed,
  };
}

/**
 * Transforms a world point into target local coordinates (rotated by -yawRad around Y, offset by target.worldPosition).
 */
export function worldToTargetLocal(worldPt: Vec3Like, targetPos: Vec3Like, yawRad: number): Vec3Like {
  const rel = sub(worldPt, targetPos);
  const cosY = Math.cos(-yawRad);
  const sinY = Math.sin(-yawRad);
  return {
    x: rel.x * cosY + rel.z * sinY,
    y: rel.y,
    z: -rel.x * sinY + rel.z * cosY,
  };
}

/**
 * Transforms a target local point to world coordinates.
 */
export function targetLocalToWorld(localPt: Vec3Like, targetPos: Vec3Like, yawRad: number): Vec3Like {
  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  return {
    x: targetPos.x + (localPt.x * cosY + localPt.z * sinY),
    y: targetPos.y + localPt.y,
    z: targetPos.z + (-localPt.x * sinY + localPt.z * cosY),
  };
}

/**
 * Transforms a direction from local to world space.
 */
export function targetLocalDirToWorld(localDir: Vec3Like, yawRad: number): Vec3Like {
  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  return {
    x: localDir.x * cosY + localDir.z * sinY,
    y: localDir.y,
    z: -localDir.x * sinY + localDir.z * cosY,
  };
}

/**
 * Ray-volume intersection in local coordinate space.
 * Checks segment [pA, pB] against the collider volume.
 * Returns [tEntry, tExit, localNormal] where t in [0, 1], or null if no intersection.
 */
export function intersectSegmentVolume(
  pA: Vec3Like,
  pB: Vec3Like,
  col: AnatomicalColliderVolume
): { tEntry: number; tExit: number; localNormal: Vec3Like } | null {
  const dir = sub(pB, pA);
  const segLen = length(dir);
  if (segLen < 1e-6) return null;
  const rayDir = scale(dir, 1 / segLen);

  if (col.shape === 'SPHERE') {
    // Sphere at col.localCenter with radius col.halfExtents.x
    const radius = col.halfExtents.x;
    const oc = sub(pA, col.localCenter);
    const b = dot(oc, rayDir);
    const c = dot(oc, oc) - radius * radius;
    const discr = b * b - c;
    if (discr < 0) return null;

    const sqrtD = Math.sqrt(discr);
    let t1 = -b - sqrtD;
    let t2 = -b + sqrtD;

    if (t2 < 0 || t1 > segLen) return null;

    const tEntryClamped = Math.max(0, t1);
    const tExitClamped = Math.min(segLen, t2);
    if (tEntryClamped > tExitClamped) return null;

    const entryPt = add(pA, scale(rayDir, tEntryClamped));
    const normal = normalize(sub(entryPt, col.localCenter));
    return {
      tEntry: tEntryClamped / segLen,
      tExit: tExitClamped / segLen,
      localNormal: normal,
    };
  } else if (col.shape === 'BOX') {
    // Oriented bounding box aligned with local axes centered at col.localCenter
    const min = sub(col.localCenter, col.halfExtents);
    const max = add(col.localCenter, col.halfExtents);

    let tmin = 0;
    let tmax = segLen;
    let normalAxis = 0;
    let normalSign = 1;

    for (const axis of ['x', 'y', 'z'] as const) {
      const d = rayDir[axis];
      const p0 = pA[axis];
      if (Math.abs(d) < 1e-8) {
        if (p0 < min[axis] || p0 > max[axis]) return null;
      } else {
        const invD = 1 / d;
        let tNear = (min[axis] - p0) * invD;
        let tFar = (max[axis] - p0) * invD;
        let sign = -1;
        if (tNear > tFar) {
          const tmp = tNear;
          tNear = tFar;
          tFar = tmp;
          sign = 1;
        }
        if (tNear > tmin) {
          tmin = tNear;
          normalAxis = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
          normalSign = sign;
        }
        if (tFar < tmax) tmax = tFar;
        if (tmin > tmax) return null;
      }
    }

    if (tmax < 0 || tmin > segLen) return null;

    const norm = vec3(
      normalAxis === 0 ? normalSign : 0,
      normalAxis === 1 ? normalSign : 0,
      normalAxis === 2 ? normalSign : 0
    );

    return {
      tEntry: Math.max(0, tmin) / segLen,
      tExit: Math.min(segLen, tmax) / segLen,
      localNormal: norm,
    };
  } else if (col.shape === 'CAPSULE') {
    // Vertical capsule along Y axis
    const radius = col.halfExtents.x;
    const pCenter = col.localCenter;
    const oc = sub(pA, pCenter);
    const dx = rayDir.x;
    const dz = rayDir.z;
    const ox = oc.x;
    const oz = oc.z;

    const aCyl = dx * dx + dz * dz;
    let t1 = 0;
    let t2 = segLen;

    if (aCyl > 1e-8) {
      const bCyl = 2 * (ox * dx + oz * dz);
      const cCyl = ox * ox + oz * oz - radius * radius;
      const discr = bCyl * bCyl - 4 * aCyl * cCyl;
      if (discr < 0) return null;
      const sqrtD = Math.sqrt(discr);
      t1 = (-bCyl - sqrtD) / (2 * aCyl);
      t2 = (-bCyl + sqrtD) / (2 * aCyl);
    } else if (ox * ox + oz * oz > radius * radius) {
      // Purely vertical ray outside cylinder radius
      return null;
    }

    const minY = pCenter.y - col.halfExtents.y;
    const maxY = pCenter.y + col.halfExtents.y;

    if (Math.abs(rayDir.y) > 1e-8) {
      let ty1 = (minY - pA.y) / rayDir.y;
      let ty2 = (maxY - pA.y) / rayDir.y;
      if (ty1 > ty2) {
        const tmp = ty1;
        ty1 = ty2;
        ty2 = tmp;
      }
      t1 = Math.max(t1, ty1);
      t2 = Math.min(t2, ty2);
    } else if (pA.y < minY || pA.y > maxY) {
      return null;
    }

    if (t2 < 0 || t1 > segLen || t1 > t2) {
      return null;
    }

    const hitTEntry = Math.max(0, t1);
    const hitTExit = Math.min(segLen, t2);
    if (hitTEntry > hitTExit) {
      return null;
    }

    const hitPoint = add(pA, scale(rayDir, hitTEntry));
    const norm = normalize(vec3(hitPoint.x - pCenter.x, 0, hitPoint.z - pCenter.z));

    return {
      tEntry: hitTEntry / segLen,
      tExit: hitTExit / segLen,
      localNormal: norm.x === 0 && norm.z === 0 ? vec3(0, 1, 0) : norm,
    };
  }

  return null;
}

/**
 * Full simulation of a weapon shot against a target.
 * Computes external RK4 trajectory, terminal ballistics with tissue cavitation,
 * GHOUL dismemberment events, and pre-calculated ragdoll launch parameters.
 */
export function simulateShot(
  weapon: WeaponSpec,
  ammo: AmmoSpec,
  originWorld: Vec3Like,
  aimDirectionWorld: Vec3Like,
  target: TargetHealthState,
  env: EnvironmentState
): ShotSimulationReport {
  const shotId = `shot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const normAimDir = normalize(aimDirectionWorld);
  const pelletCount = Math.max(1, ammo.pelletCount);
  const muzzleEnergyJ = 0.5 * ammo.massKg * ammo.muzzleVelocityMs * ammo.muzzleVelocityMs;

  const pelletResults: PelletTrajectoryResult[] = [];
  const allWoundEvents: WoundChannelEvent[] = [];
  const shatteredBonesSet = new Set<string>();
  const rupturedOrgansSet = new Set<string>();
  const severedZonesSet = new Set<GhoulZoneId>(target.severedZones);
  const newlySeveredZones: GhoulZoneId[] = [];
  const dismembermentEvents: DismembermentEvent[] = [];

  // Track cumulative gore-adjusted energy deposited per zone during this shot
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

  // Target bounding cylinder in world space for broad-phase check
  const targetRadius = 0.65;
  const targetMinY = target.worldPosition.y;
  const targetMaxY = target.worldPosition.y + 1.95;

  const dt = 0.0015; // 1.5 ms simulation step for high precision
  const maxRangeM = 300.0;
  const maxFlightTimeS = 2.0;

  // Simulate each pellet / bullet
  for (let pIdx = 0; pIdx < pelletCount; pIdx++) {
    const pelletAimDir = deterministicConeSpread(
      normAimDir,
      ammo.spreadRadians,
      pIdx,
      pelletCount
    );

    let proj: ProjectileState = {
      id: `${shotId}_p${pIdx}`,
      ammo,
      position: copyVec3(originWorld),
      velocity: scale(pelletAimDir, ammo.muzzleVelocityMs),
      spinRadS: weapon.role === 'SNIPER' ? 2400 : weapon.role === 'ASSAULT_RIFLE' ? 3000 : 0,
      currentDiameterM: ammo.diameterM,
      flightTimeS: 0,
      distanceTraveledM: 0,
      kineticEnergyJ: muzzleEnergyJ,
      penetratedLayers: 0,
      alive: true,
    };

    const trajectorySamples: TrajectorySample[] = [];
    const pelletWoundEvents: WoundChannelEvent[] = [];
    const penetratedColliders = new Set<string>();

    // Sample initial state
    const mach0 = ammo.muzzleVelocityMs / env.speedOfSoundMs;
    trajectorySamples.push({
      timeS: 0,
      position: copyVec3(proj.position),
      velocity: copyVec3(proj.velocity),
      speedMs: ammo.muzzleVelocityMs,
      mach: mach0,
      kineticEnergyJ: muzzleEnergyJ,
      dropM: 0,
      windDriftM: 0,
    });

    let pelletHit = false;
    let pelletImpactTime = 0;
    let pelletImpactPoint: Vec3Like | null = null;
    let pelletImpactZone: GhoulZoneId | null = null;
    let pelletEnergyDeposited = 0;
    let pelletImpulseTransferred = 0;

    // Numerical integration loop
    while (
      proj.alive &&
      proj.distanceTraveledM < maxRangeM &&
      proj.flightTimeS < maxFlightTimeS &&
      proj.position.y > -5.0
    ) {
      const prevPos = copyVec3(proj.position);
      proj = stepProjectileRK4(proj, env, dt);
      const currPos = proj.position;

      // Sample trajectory periodically
      if (trajectorySamples.length < 50 || trajectorySamples.length % 5 === 0) {
        const speed = length(proj.velocity);
        const mach = speed / env.speedOfSoundMs;
        // Bullet drop and signed lateral drift relative to straight boresight ray
        const straightPos = add(originWorld, scale(pelletAimDir, proj.distanceTraveledM));
        const drop = straightPos.y - currPos.y;
        const shotRightRaw = cross(pelletAimDir, vec3(0, 1, 0));
        const shotRight = lengthSq(shotRightRaw) > 1e-6 ? normalize(shotRightRaw) : vec3(1, 0, 0);
        const drift = dot(sub(currPos, straightPos), shotRight);

        trajectorySamples.push({
          timeS: proj.flightTimeS,
          position: copyVec3(currPos),
          velocity: copyVec3(proj.velocity),
          speedMs: speed,
          mach,
          kineticEnergyJ: proj.kineticEnergyJ,
          dropM: drop,
          windDriftM: drift,
        });
      }

      // -----------------------------------------------------------------------
      // Target Broad-Phase Intersection Check (Continuous Segment vs Cylinder)
      // -----------------------------------------------------------------------
      const minX = Math.min(prevPos.x, currPos.x);
      const maxX = Math.max(prevPos.x, currPos.x);
      const minY = Math.min(prevPos.y, currPos.y);
      const maxY = Math.max(prevPos.y, currPos.y);
      const minZ = Math.min(prevPos.z, currPos.z);
      const maxZ = Math.max(prevPos.z, currPos.z);

      const tMinX = target.worldPosition.x - targetRadius;
      const tMaxX = target.worldPosition.x + targetRadius;
      const tMinZ = target.worldPosition.z - targetRadius;
      const tMaxZ = target.worldPosition.z + targetRadius;

      const aabbOverlap =
        maxX >= tMinX &&
        minX <= tMaxX &&
        maxY >= targetMinY - 0.2 &&
        minY <= targetMaxY + 0.2 &&
        maxZ >= tMinZ &&
        minZ <= tMaxZ;

      if (aabbOverlap) {
        // Narrow-phase check: Transform segment [prevPos, currPos] into target local space
        const localA = worldToTargetLocal(prevPos, target.worldPosition, target.yawRad);
        const localB = worldToTargetLocal(currPos, target.worldPosition, target.yawRad);

        // Find all intersecting anatomical colliders that have not been severed yet
        interface HitCandidate {
          collider: AnatomicalColliderVolume;
          tEntry: number;
          tExit: number;
          localNormal: Vec3Like;
        }
        const hits: HitCandidate[] = [];

        for (const col of ALL_ANATOMICAL_COLLIDERS) {
          if (severedZonesSet.has(col.ghoulZone) || penetratedColliders.has(col.id)) {
            continue; // Skip parts that have already been blown off or penetrated!
          }
          const inter = intersectSegmentVolume(localA, localB, col);
          if (inter) {
            hits.push({
              collider: col,
              tEntry: inter.tEntry,
              tExit: inter.tExit,
              localNormal: inter.localNormal,
            });
          }
        }

        // Sort hits by entry depth along the segment
        hits.sort((a, b) => a.tEntry - b.tEntry);

        if (hits.length > 0) {
          pelletHit = true;
          hasHitTarget = true;

          for (const hit of hits) {
            if (!proj.alive) break;

            const col = hit.collider;
            const entryLocal = add(localA, scale(sub(localB, localA), hit.tEntry));
            const exitLocal = add(localA, scale(sub(localB, localA), hit.tExit));
            const entryWorld = targetLocalToWorld(entryLocal, target.worldPosition, target.yawRad);
            const exitWorld = targetLocalToWorld(exitLocal, target.worldPosition, target.yawRad);
            const normalWorld = normalize(targetLocalDirToWorld(hit.localNormal, target.yawRad));
            const pathLen = Math.max(0.005, distance(entryLocal, exitLocal));

            if (!pelletImpactPoint) {
              pelletImpactPoint = entryWorld;
              pelletImpactZone = col.ghoulZone;
              pelletImpactTime = proj.flightTimeS;

              if (!primaryHitZone) {
                primaryHitZone = col.ghoulZone;
                firstImpactSpeed = length(proj.velocity);
                firstImpactEnergy = proj.kineticEnergyJ;
                firstImpactTime = proj.flightTimeS;

                const straightPos = add(originWorld, scale(pelletAimDir, proj.distanceTraveledM));
                const shotRightRaw = cross(pelletAimDir, vec3(0, 1, 0));
                const shotRight =
                  lengthSq(shotRightRaw) > 1e-6 ? normalize(shotRightRaw) : vec3(1, 0, 0);
                bulletDropAtImpactCm = (straightPos.y - entryWorld.y) * 100;
                windDriftAtImpactCm = dot(sub(entryWorld, straightPos), shotRight) * 100;
              }
            }

            // Bullet expansion inside tissue (JHP expands up to tissueExpansionFactor)
            if (col.layerType === 'SOFT_FLESH' || col.layerType.startsWith('ORGAN_')) {
              const maxDiam = ammo.diameterM * ammo.tissueExpansionFactor;
              proj.currentDiameterM = Math.min(
                maxDiam,
                proj.currentDiameterM + ammo.diameterM * 0.15
              );
            }

            // Energy transfer calculation based on stopping power and density
            const currentSpeed = length(proj.velocity);
            const entryEnergy = proj.kineticEnergyJ;

            // Resistance per meter of tissue
            // Hard structures (bone) absorb more energy; soft tissue yields cavitation
            const resistanceBase = 1600 * col.stoppingPowerFactor * (col.densityKgM3 / 1000);
            const penetrationMultiplier =
              col.layerType === 'CORTICAL_BONE' ? 1.0 / Math.pow(ammo.armorPenetrationFactor, 1.5) : 1.0;
            const energyLossRate = resistanceBase * (proj.currentDiameterM / ammo.diameterM) * penetrationMultiplier;
            const energyDeposited = Math.min(entryEnergy, energyLossRate * pathLen);

            const exitEnergy = Math.max(0, entryEnergy - energyDeposited);
            const exitSpeed = Math.sqrt((2 * exitEnergy) / ammo.massKg);

            // Momentum transfer: J = delta_p * multiplier + kinetic energy blast push
            const deltaP = ammo.massKg * (currentSpeed - exitSpeed);
            const impulseMagnitude =
              (deltaP * ammo.ragdollImpulseMultiplier +
                (energyDeposited / 180) * ammo.ragdollImpulseMultiplier);

            const bulletDir = normalize(proj.velocity);
            const impulseVec = scale(bulletDir, impulseMagnitude);

            // Accumulate damage & health loss
            const layerDamage =
              (energyDeposited / 18.0) * col.vitalityMultiplier * (ammo.tissueExpansionFactor * 0.8);
            totalDamageHp += layerDamage;
            totalEnergyDepositedJ += energyDeposited;
            pelletEnergyDeposited += energyDeposited;
            pelletImpulseTransferred += impulseMagnitude;

            // Track zone cumulative energy
            const currentZoneE = zoneEnergyDeposited[col.ghoulZone] || 0;
            zoneEnergyDeposited[col.ghoulZone] = currentZoneE + energyDeposited * ammo.goreFactor;

            // Track localized zone impulse
            const existingZoneImpulse = zoneImpulses[col.ghoulZone] || vec3(0, 0, 0);
            zoneImpulses[col.ghoulZone] = add(existingZoneImpulse, impulseVec);

            // Accumulate root impulse and torque around target center of mass
            netRootImpulseWorld = add(netRootImpulseWorld, impulseVec);
            const hitOffsetFromRoot = sub(entryWorld, add(target.worldPosition, vec3(0, 1.0, 0)));
            const torque = cross(hitOffsetFromRoot, impulseVec);
            netTorqueWorld = add(netTorqueWorld, torque);

            // Bone fracture and organ rupture flags (direct high-energy rifle perforation also fractures cortical bone)
            const highEnergyBonePerforation =
              col.layerType === 'CORTICAL_BONE' &&
              entryEnergy >= col.fractureThresholdJ * 3.5 &&
              pathLen >= 0.03;
            const boneFractured =
              col.layerType === 'CORTICAL_BONE' &&
              (energyDeposited >= col.fractureThresholdJ || highEnergyBonePerforation);
            const boneShattered =
              boneFractured &&
              (energyDeposited >= col.fractureThresholdJ * 1.8 ||
                ammo.goreFactor >= 2.5 ||
                entryEnergy >= col.fractureThresholdJ * 6.0);
            const organRuptured =
              col.layerType.startsWith('ORGAN_') && energyDeposited >= col.fractureThresholdJ;
            const arterialSevered =
              col.layerType === 'ARTERY_CAROTID_AORTA' && energyDeposited >= col.fractureThresholdJ;

            if (boneFractured) shatteredBonesSet.add(col.label);
            if (organRuptured || arterialSevered) rupturedOrgansSet.add(col.label);

            // Cavitation radius (permanent crush vs temporary stretch)
            const permRadiusCm = Math.max(
              0.4,
              (proj.currentDiameterM * 100 * 0.5 * ammo.tissueExpansionFactor)
            );
            const tempRadiusCm = Math.min(
              14.0,
              permRadiusCm * (currentSpeed / 120.0) * Math.sqrt(ammo.tissueExpansionFactor)
            );

            // Create wound event
            const woundEvent: WoundChannelEvent = {
              colliderId: col.id,
              label: col.label,
              ghoulZone: col.ghoulZone,
              layerType: col.layerType,
              entryPointWorld: entryWorld,
              exitPointWorld: exitWorld,
              entryNormalWorld: normalWorld,
              impactDirectionWorld: bulletDir,
              pathLengthM: pathLen,
              entryVelocityMs: currentSpeed,
              exitVelocityMs: exitSpeed,
              entryEnergyJ: entryEnergy,
              exitEnergyJ: exitEnergy,
              energyDepositedJ: energyDeposited,
              impulseTransferredNs: impulseMagnitude,
              permanentCavityRadiusCm: permRadiusCm,
              temporaryStretchCavityRadiusCm: tempRadiusCm,
              boneFractured,
              boneShattered,
              organRuptured,
              limbSensoryShock: energyDeposited > 150,
              limbSevered: false, // will be evaluated in dismemberment pass
              arterialSevered,
              deflectionAngleDeg: 1.2 * (col.layerType === 'CORTICAL_BONE' ? 3.5 : 1.0),
            };

            pelletWoundEvents.push(woundEvent);
            allWoundEvents.push(woundEvent);
            penetratedColliders.add(col.id);

            // Update projectile state after passing through layer
            proj.penetratedLayers++;
            proj.kineticEnergyJ = exitEnergy;
            proj.velocity = scale(bulletDir, exitSpeed);

            if (exitEnergy < 15.0 || exitSpeed < 40.0) {
              // Projectile stopped inside tissue
              proj.alive = false;
              break;
            }
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

  // ---------------------------------------------------------------------------
  // Dismemberment & Severing Pass (Soldier of Fortune GHOUL rules)
  // ---------------------------------------------------------------------------
  for (const zone of Object.keys(zoneEnergyDeposited) as GhoulZoneId[]) {
    const cumulativeEnergy = zoneEnergyDeposited[zone] || 0;
    // Find representative collider for sever threshold
    const refCol = ALL_ANATOMICAL_COLLIDERS.find((c) => c.ghoulZone === zone);
    const severThreshold = refCol ? refCol.severThresholdJ : 400;

    // Check if cumulative energy surpasses the sever threshold
    if (cumulativeEnergy >= severThreshold && !severedZonesSet.has(zone)) {
      let goreMode: GoreMode = 'CLEAN_SEVER';
      let gibCount = 5;

      if (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW') {
        goreMode = 'CRANIAL_POP';
        gibCount = 14;
      } else if (zone === 'TORSO_LOWER_ABDOMEN') {
        goreMode = 'EVISCERATED';
        gibCount = 8;
      }

      // Detach kinematic subtree
      const detachedSubtree = getSubtreeZones(zone);
      for (const det of detachedSubtree) {
        severedZonesSet.add(det);
        if (!newlySeveredZones.includes(det)) {
          newlySeveredZones.push(det);
        }
      }

      // Calculate stump position in world coordinates
      const zoneNode = GHOUL_ZONE_HIERARCHY[zone];
      const stumpLocal = zoneNode.jointLocalPos;
      const stumpWorld = targetLocalToWorld(stumpLocal, target.worldPosition, target.yawRad);

      // Severed limb flies off with the shot blast impulse
      const blastDir = normalize(normAimDir);
      const zoneImpulse = zoneImpulses[zone] || scale(blastDir, 25);
      const limbSpeed = Math.min(18.0, length(zoneImpulse) / (zoneNode.defaultMassKg + 0.5));
      const limbVelocity = add(
        scale(blastDir, limbSpeed),
        vec3((Math.random() - 0.5) * 2, Math.random() * 2 + 1.5, (Math.random() - 0.5) * 2)
      );

      dismembermentEvents.push({
        zone,
        goreMode,
        detachedSubtree,
        stumpWorldPosition: stumpWorld,
        arterialSprayDirection: vec3(0, 1, 0), // arterial spray points upward/outward
        severedLimbVelocity: limbVelocity,
        severedLimbAngularVelocity: vec3(
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12
        ),
        gibCount,
      });

      // Update wound events to mark limbSevered
      for (const we of allWoundEvents) {
        if (we.ghoulZone === zone) {
          we.limbSevered = true;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lethality Pre-Calculation & Ragdoll Activation Plan
  // ---------------------------------------------------------------------------
  // Check instant lethality:
  // 1. Total damage >= target current HP
  // 2. Brain or heart ruptured, neck severed, or torso bisected/eviscerated
  // 3. Cranial pop
  const isCranialExploded = dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP');
  const isNeckSevered = dismembermentEvents.some((d) => d.zone === 'NECK_CERVICAL');
  const isTorsoBisected = dismembermentEvents.some(
    (d) =>
      d.zone === 'TORSO_LOWER_ABDOMEN' ||
      d.zone === 'TORSO_UPPER_THORAX' ||
      d.zone === 'PELVIS_GROIN'
  );
  const isVitalOrganDestroyed =
    rupturedOrgansSet.has('Brain (Cerebrum & Brainstem)') ||
    rupturedOrgansSet.has('Heart (Myocardium & Ventricles)');

  const isLethalKill =
    hasHitTarget &&
    (totalDamageHp >= target.currentHp ||
      isCranialExploded ||
      isNeckSevered ||
      isTorsoBisected ||
      isVitalOrganDestroyed);

  // Massive shotgun knockdown threshold
  const isShotgunKnockdown =
    ammo.type === 'BUCKSHOT_00' && length(netRootImpulseWorld) > 60.0;
  const willEnableRagdoll = isLethalKill || isShotgunKnockdown;

  // Shotgun victims fly backwards off their feet!
  // Compute upward lift velocity and launch distance
  let launchLiftVelocityMs = 0;
  let estimatedLaunchDistanceM = 0;

  if (willEnableRagdoll) {
    const horizontalImpulseMag = length(vec3(netRootImpulseWorld.x, 0, netRootImpulseWorld.z));
    // Upward launch boost proportional to blast impulse
    launchLiftVelocityMs = Math.min(6.5, Math.max(2.2, (horizontalImpulseMag / 50.0) * 3.2));
    // Estimate backward launch distance: v_x * t_air where t_air ~ 2 * v_y / g
    const horizSpeed = horizontalImpulseMag / 75.0; // body mass ~75-80kg
    const flightTimeEst = (2 * launchLiftVelocityMs) / 9.81;
    estimatedLaunchDistanceM = Math.max(1.5, horizSpeed * flightTimeEst + 1.2);
  }

  const ragdollPlan: RagdollActivationPlan = {
    willEnableRagdoll,
    activationTimeS: firstImpactTime,
    primaryHitZone,
    netRootImpulseWorld,
    launchLiftVelocityMs,
    estimatedLaunchDistanceM,
    zoneImpulses,
    netTorqueWorld,
    dismembermentEvents,
  };

  // Determine Sniper Elite X-Ray Kill Cam trigger
  // Triggers on precision rifle lethal hits to organs or bone fractures, or heavy sniper kills
  const triggerXRayKillCam =
    weapon.role === 'SNIPER' &&
    isLethalKill &&
    (rupturedOrgansSet.size > 0 || shatteredBonesSet.size > 0);

  let xRayHighlightPoint: Vec3Like | null = null;
  let xRayFocusZone: GhoulZoneId | null = null;
  if (triggerXRayKillCam && allWoundEvents.length > 0) {
    const vitalWound =
      allWoundEvents.find((w) => w.organRuptured || w.boneShattered) || allWoundEvents[0];
    xRayHighlightPoint = vitalWound.entryPointWorld;
    xRayFocusZone = vitalWound.ghoulZone;
  }

  // Calculate straight line distance to target
  const targetDistanceM = distance(originWorld, target.worldPosition);

  // If shot missed target, still compute drop & signed wind drift at targetDistanceM for smooth reticle prediction
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
    isLethalKill,
    ragdollPlan,
    triggerXRayKillCam,
    xRayFocusZone,
    xRayHighlightPointWorld: xRayHighlightPoint,
    severedZones: newlySeveredZones,
    dismembermentEvents,
    shatteredBones: Array.from(shatteredBonesSet),
    rupturedOrgans: Array.from(rupturedOrgansSet),
    trajectorySamples: primarySamples,
  };
}

/**
 * Applies the simulation results into the TargetHealthState.
 * Updates HP, zone integrity, fractured bones, severed limbs, and activates ragdoll physics if lethal/knockdown.
 */
export function applyShotReportToTarget(
  target: TargetHealthState,
  report: ShotSimulationReport
): void {
  if (!report.hitTarget) return;

  target.currentHp = Math.max(0, target.currentHp - report.totalDamageHp);
  if (report.isLethalKill || target.currentHp <= 0) {
    target.alive = false;
  }

  for (const b of report.shatteredBones) {
    target.fracturedBones.add(b);
  }
  for (const o of report.rupturedOrgans) {
    target.rupturedOrgans.add(o);
  }

  // Apply localized GHOUL zone integrity loss & laceration for non-severing wounds
  for (const w of report.woundEvents) {
    if (target.severedZones.has(w.ghoulZone)) continue;
    const refCol = ALL_ANATOMICAL_COLLIDERS.find((c) => c.ghoulZone === w.ghoulZone);
    const severThresh = refCol ? refCol.severThresholdJ : 400;
    const integrityLoss = Math.min(95, (w.energyDepositedJ / severThresh) * 120);
    const nextIntegrity = Math.max(5, (target.zoneIntegrity[w.ghoulZone] ?? 100) - integrityLoss);
    target.zoneIntegrity[w.ghoulZone] = nextIntegrity;
    if (nextIntegrity < 85 && target.zoneGoreMode[w.ghoulZone] === 'INTACT') {
      target.zoneGoreMode[w.ghoulZone] = 'LACERATED';
    }
  }

  // Apply dismemberment events
  for (const dism of report.dismembermentEvents) {
    target.severedZones.add(dism.zone);
    target.zoneGoreMode[dism.zone] = dism.goreMode;
    target.zoneIntegrity[dism.zone] = 0;

    const boneState = target.ragdollBones[dism.zone];
    if (boneState) {
      boneState.severed = true;
      boneState.goreMode = dism.goreMode;
      boneState.velocity = copyVec3(dism.severedLimbVelocity);
      boneState.angularVelocity = copyVec3(dism.severedLimbAngularVelocity);
    }

    for (const child of dism.detachedSubtree) {
      target.severedZones.add(child);
      target.zoneIntegrity[child] = 0;
      const childBone = target.ragdollBones[child];
      if (childBone) {
        childBone.severed = true;
        childBone.velocity = copyVec3(dism.severedLimbVelocity);
        childBone.angularVelocity = copyVec3(dism.severedLimbAngularVelocity);
      }
    }
  }

  // Activate Ragdoll if planned
  if (report.ragdollPlan.willEnableRagdoll) {
    target.isRagdollActive = true;

    // Body mass ~ 80kg
    const totalMass = 80.0;
    const impulse = report.ragdollPlan.netRootImpulseWorld;
    const liftY = report.ragdollPlan.launchLiftVelocityMs;

    target.ragdollRootVelocity = vec3(
      impulse.x / totalMass,
      impulse.y / totalMass + liftY,
      impulse.z / totalMass
    );

    target.ragdollAngularVelocity = scale(report.ragdollPlan.netTorqueWorld, 1 / 45.0);
    const comWorld = add(target.ragdollRootPosition, vec3(0, 0.95, 0));

    // Initialize ALL non-severed bones with root launch velocity + rotational whip + localized impulse
    for (const zone of ALL_GHOUL_ZONES) {
      const bone = target.ragdollBones[zone];
      if (!bone || bone.severed) continue;

      const offsetFromCom = sub(bone.position, comWorld);
      const rotVel = cross(target.ragdollAngularVelocity, offsetFromCom);
      let nextVel = add(target.ragdollRootVelocity, scale(rotVel, 0.45));

      const zImp = report.ragdollPlan.zoneImpulses[zone];
      if (zImp) {
        const localWhip = scale(zImp, 1 / Math.max(8.0, bone.massKg * 2.5));
        nextVel = add(nextVel, localWhip);
      }

      bone.velocity = nextVel;
      bone.angularVelocity = scale(target.ragdollAngularVelocity, 0.85);
    }
  }
}

/**
 * Steps the articulated ragdoll physics (gravity, parent-child joint constraints, floor bounce, friction, severed flying limbs).
 * Works headless for Vitest as well as inside PlayCanvas frames.
 */
export function stepRagdollPhysics(
  target: TargetHealthState,
  dt: number,
  floorY = 0.0
): void {
  if (!target.isRagdollActive && target.severedZones.size === 0) return;
  if (dt <= 0) return;

  const gravity = -9.81;
  const floorFriction = 0.85;
  const restitution = 0.25;

  // Step root ragdoll body if active
  if (target.isRagdollActive) {
    // Apply gravity
    target.ragdollRootVelocity.y += gravity * dt;

    // Linear motion
    target.ragdollRootPosition = add(
      target.ragdollRootPosition,
      scale(target.ragdollRootVelocity, dt)
    );
    target.worldPosition = copyVec3(target.ragdollRootPosition);

    // Ground collision for root
    if (target.ragdollRootPosition.y <= floorY + 0.3) {
      target.ragdollRootPosition.y = floorY + 0.3;
      target.worldPosition.y = floorY + 0.3;

      if (target.ragdollRootVelocity.y < 0) {
        target.ragdollRootVelocity.y = -target.ragdollRootVelocity.y * restitution;
      }
      target.ragdollRootVelocity.x *= Math.pow(floorFriction, dt * 60);
      target.ragdollRootVelocity.z *= Math.pow(floorFriction, dt * 60);
      target.ragdollAngularVelocity = scale(
        target.ragdollAngularVelocity,
        Math.pow(0.7, dt * 60)
      );
    }
  }

  // Save pre-step positions to keep velocities consistent after stick constraint projection
  const prevPositions: Partial<Record<GhoulZoneId, Vec3Like>> = {};

  // Step individual bones / flying severed limbs
  for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
    const bone = target.ragdollBones[zone];
    if (bone.severed || target.isRagdollActive) {
      prevPositions[zone] = copyVec3(bone.position);
      bone.velocity.y += gravity * dt;
      bone.position = add(bone.position, scale(bone.velocity, dt));
      bone.rotationEuler = add(bone.rotationEuler, scale(bone.angularVelocity, dt));
    }
  }

  // Anchor intact pelvis to the ragdoll root trajectory so the skeleton travels cohesively
  const pelvisBone = target.ragdollBones.PELVIS_GROIN;
  if (target.isRagdollActive && pelvisBone && !pelvisBone.severed) {
    const anchorTarget = vec3(
      target.ragdollRootPosition.x,
      Math.max(floorY + 0.12, target.ragdollRootPosition.y + 0.18),
      target.ragdollRootPosition.z
    );
    pelvisBone.position = add(
      scale(pelvisBone.position, 0.35),
      scale(anchorTarget, 0.65)
    );
  }

  // Iterative parent-child stick constraints keep both the body ragdoll and severed multi-bone limbs articulated
  const constraintIterations = 4;
  for (let iter = 0; iter < constraintIterations; iter++) {
    for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
      const node = GHOUL_ZONE_HIERARCHY[zone];
      if (!node.parent) continue;

      const bone = target.ragdollBones[zone];
      const parentBone = target.ragdollBones[node.parent];
      if (!bone || !parentBone) continue;
      if (!bone.severed && !target.isRagdollActive) continue;

      // Joint remains intact if both share severed state AND child wasn't the severed root itself
      const jointIntact =
        bone.severed === parentBone.severed && (!bone.severed || bone.goreMode === 'INTACT');
      if (!jointIntact) continue;

      const restLen = BONE_REST_LENGTHS[zone] ?? 0.2;
      const delta = sub(bone.position, parentBone.position);
      const curLen = length(delta);
      if (curLen < 1e-5) continue;

      const diff = (curLen - restLen) / curLen;
      if (node.parent === 'PELVIS_GROIN' && target.isRagdollActive && !parentBone.severed) {
        bone.position = sub(bone.position, scale(delta, diff * 0.85));
        parentBone.position = add(parentBone.position, scale(delta, diff * 0.15));
      } else {
        const wParent = bone.massKg / (parentBone.massKg + bone.massKg);
        const wChild = 1.0 - wParent;
        parentBone.position = add(parentBone.position, scale(delta, diff * wParent));
        bone.position = sub(bone.position, scale(delta, diff * wChild));
      }
    }

    // Enforce floor clamp inside constraint loop
    for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
      const bone = target.ragdollBones[zone];
      if ((bone.severed || target.isRagdollActive) && bone.position.y < floorY + 0.05) {
        bone.position.y = floorY + 0.05;
      }
    }
  }

  // Reconcile bone velocities and apply ground bounce / friction
  for (const zone of TOPOLOGICAL_GHOUL_ZONES) {
    const bone = target.ragdollBones[zone];
    if (!bone.severed && !target.isRagdollActive) continue;

    const prev = prevPositions[zone];
    if (prev) {
      const constrainedVel = scale(sub(bone.position, prev), 1 / dt);
      bone.velocity = add(scale(bone.velocity, 0.3), scale(constrainedVel, 0.7));
    }

    if (bone.position.y <= floorY + 0.055) {
      bone.position.y = floorY + 0.05;
      bone.grounded = true;
      if (bone.velocity.y < 0) {
        bone.velocity.y = -bone.velocity.y * restitution;
      }
      bone.velocity.x *= Math.pow(floorFriction, dt * 60);
      bone.velocity.z *= Math.pow(floorFriction, dt * 60);
      bone.angularVelocity = scale(bone.angularVelocity, Math.pow(0.7, dt * 60));
    }
  }
}

/**
 * Computes the exact boresight aim direction required for a projectile fired from `originWorld`
 * to impact `desiredImpactWorld` under full RK4 gravity, Mach drag, crosswind, and spin drift.
 */
export function computeBallisticZeroAimDirection(
  weapon: WeaponSpec,
  ammo: AmmoSpec,
  originWorld: Vec3Like,
  desiredImpactWorld: Vec3Like,
  env: EnvironmentState
): Vec3Like {
  const directVec = sub(desiredImpactWorld, originWorld);
  const targetDist = length(directVec);
  if (targetDist < 0.5 || ammo.muzzleVelocityMs <= 0) {
    return normalize(directVec);
  }

  const dt = 0.0015;
  const spinRadS =
    weapon.role === 'SNIPER' ? 2400 : weapon.role === 'ASSAULT_RIFLE' ? 3000 : 0;
  const muzzleEnergyJ = 0.5 * ammo.massKg * ammo.muzzleVelocityMs * ammo.muzzleVelocityMs;

  let aimTarget = copyVec3(desiredImpactWorld);

  for (let iter = 0; iter < 3; iter++) {
    const aimDir = normalize(sub(aimTarget, originWorld));
    let proj: ProjectileState = {
      id: 'zero_probe',
      ammo,
      position: copyVec3(originWorld),
      velocity: scale(aimDir, ammo.muzzleVelocityMs),
      spinRadS,
      currentDiameterM: ammo.diameterM,
      flightTimeS: 0,
      distanceTraveledM: 0,
      kineticEnergyJ: muzzleEnergyJ,
      penetratedLayers: 0,
      alive: true,
    };

    let prevPos = copyVec3(proj.position);
    let prevDist = 0;
    while (proj.alive && proj.distanceTraveledM < targetDist && proj.flightTimeS < 2.0) {
      prevPos = copyVec3(proj.position);
      prevDist = proj.distanceTraveledM;
      proj = stepProjectileRK4(proj, env, dt);
    }

    const segDist = proj.distanceTraveledM - prevDist;
    const alpha =
      segDist > 1e-6 ? Math.min(1, Math.max(0, (targetDist - prevDist) / segDist)) : 1;
    const posAtRange = add(prevPos, scale(sub(proj.position, prevPos), alpha));
    const error = sub(posAtRange, desiredImpactWorld);
    aimTarget = sub(aimTarget, error);
  }

  return normalize(sub(aimTarget, originWorld));
}

