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
  AuxParticleId,
  GoreMode,
  PainReactionType,
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
  ALL_AUX_PARTICLES,
  AUX_PARTICLE_REST_LOCAL,
  buildAnatomicalColliders,
  getSubtreeZones,
  GHOUL_ZONE_HIERARCHY,
  recomputeRagdollBasisVectors,
} from '../ghoul/anatomy.ts';

// Cache colliders statically for performance
const ALL_ANATOMICAL_COLLIDERS = buildAnatomicalColliders();

// Precompute standing rest-pose basis for each bone so live posed bones map cleanly back to collider space
const REST_BONE_BASES: Record<
  GhoulZoneId,
  { right: Vec3Like; up: Vec3Like; forward: Vec3Like; jointPos: Vec3Like }
> = (() => {
  const dummy = {
    yawRad: 0,
    ragdollBones: {} as TargetHealthState['ragdollBones'],
    auxParticles: {} as TargetHealthState['auxParticles'],
  } as TargetHealthState;

  for (const z of ALL_GHOUL_ZONES) {
    const p = GHOUL_ZONE_HIERARCHY[z].jointLocalPos;
    dummy.ragdollBones[z] = {
      zone: z,
      position: copyVec3(p),
      prevPosition: copyVec3(p),
      velocity: vec3(0, 0, 0),
      angularVelocity: vec3(0, 0, 0),
      rotationEuler: vec3(0, 0, 0),
      basisRight: vec3(1, 0, 0),
      basisUp: vec3(0, 1, 0),
      basisForward: vec3(0, 0, 1),
      distalPosition: copyVec3(p),
      massKg: 1,
      radiusM: 0.05,
      componentId: 'BODY',
      severed: false,
      goreMode: 'INTACT',
      grounded: false,
    };
  }
  for (const a of ALL_AUX_PARTICLES) {
    const spec = AUX_PARTICLE_REST_LOCAL[a];
    dummy.auxParticles[a] = {
      id: a,
      parentZone: spec.parentZone,
      position: copyVec3(spec.localPos),
      prevPosition: copyVec3(spec.localPos),
      velocity: vec3(0, 0, 0),
      massKg: spec.massKg,
      radiusM: spec.radiusM,
      componentId: 'BODY',
    };
  }
  recomputeRagdollBasisVectors(dummy);

  const out = {} as Record<
    GhoulZoneId,
    { right: Vec3Like; up: Vec3Like; forward: Vec3Like; jointPos: Vec3Like }
  >;
  for (const z of ALL_GHOUL_ZONES) {
    const b = dummy.ragdollBones[z];
    out[z] = {
      right: copyVec3(b.basisRight),
      up: copyVec3(b.basisUp),
      forward: copyVec3(b.basisForward),
      jointPos: copyVec3(GHOUL_ZONE_HIERARCHY[z].jointLocalPos),
    };
  }
  return out;
})();

/**
 * Standard Mach drag multiplier model (realistic transonic drag rise between Mach 0.85 and 1.3).
 */
export function computeMachDragMultiplier(mach: number): number {
  if (mach < 0.75) {
    return 1.0;
  } else if (mach < 1.0) {
    const t = (mach - 0.75) / 0.25;
    return 1.0 + 1.6 * (t * t);
  } else if (mach < 1.35) {
    const t = (mach - 1.0) / 0.35;
    return 2.6 - 0.7 * t;
  } else if (mach < 2.5) {
    const t = (mach - 1.35) / 1.15;
    return 1.9 - 0.5 * t;
  } else {
    return 1.35;
  }
}

/**
 * 4th-Order Runge-Kutta (RK4) numerical ballistic integrator.
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

  // Parse buckshot pellet index (> 0) for downrange unbuffered soft-lead aerodynamic wake bloom
  let buckshotPelletIdx = 0;
  if (proj.ammo.type === 'BUCKSHOT_00' && proj.ammo.pelletCount > 1) {
    const pPos = proj.id.lastIndexOf('_p');
    if (pPos !== -1) {
      const parsed = Number.parseInt(proj.id.slice(pPos + 2), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        buckshotPelletIdx = parsed;
      }
    }
  }

  const computeAcceleration = (_pos: Vec3Like, vel: Vec3Like): Vec3Like => {
    const vRel = sub(vel, env.windVelocity);
    const speedRel = length(vRel);
    if (speedRel < 1e-4) {
      return env.gravity;
    }

    const mach = speedRel / vsound;
    const machMult = computeMachDragMultiplier(mach);
    const cd = baseCd * machMult;

    const dragMagnitude = 0.5 * rho * speedRel * speedRel * cd * area;
    const dragAccelMag = dragMagnitude / m;
    const dragAccel = scale(normalize(vRel), -dragAccelMag);

    let spinDriftAccel: Vec3Like = { x: 0, y: 0, z: 0 };
    if (proj.spinRadS !== 0 && speedRel > 10) {
      const vNorm = normalize(vel);
      const driftDir = normalize(cross({ x: 0, y: 1, z: 0 }, vNorm));
      const driftAccelMag = 0.00012 * proj.spinRadS * (speedRel / vsound);
      spinDriftAccel = scale(driftDir, driftAccelMag);
    }

    // Past 2.8m wad-cup separation, deformed spherical buckshot pellets experience aerodynamic wake lift,
    // keeping close-quarters patterns tight while blooming wide at medium-to-long range!
    let wakeBloomAccel: Vec3Like = { x: 0, y: 0, z: 0 };
    if (buckshotPelletIdx > 0 && proj.distanceTraveledM > 2.8) {
      const vNorm = normalize(vel);
      const arbUp = Math.abs(vNorm.y) < 0.999 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      const pRight = normalize(cross(arbUp, vNorm));
      const pUp = cross(vNorm, pRight);
      const goldenRatio = 1.618033988749895;
      const theta = 2 * Math.PI * (buckshotPelletIdx * goldenRatio + 0.337);
      const rNorm = Math.sqrt(buckshotPelletIdx / Math.max(1, proj.ammo.pelletCount - 1));
      const radialDir = add(scale(pRight, Math.cos(theta)), scale(pUp, Math.sin(theta)));
      const bloomRamp = Math.min(1.0, (proj.distanceTraveledM - 2.8) / 3.5);
      const liftMag = dragAccelMag * 0.48 * rNorm * bloomRamp;
      wakeBloomAccel = scale(radialDir, liftMag);
    }

    return add(add(add(env.gravity, dragAccel), spinDriftAccel), wakeBloomAccel);
  };

  const p0 = proj.position;
  const v0 = proj.velocity;

  const a1 = computeAcceleration(p0, v0);
  const dp1 = v0;

  const p1 = add(p0, scale(dp1, 0.5 * dt));
  const v1 = add(v0, scale(a1, 0.5 * dt));
  const a2 = computeAcceleration(p1, v1);
  const dp2 = v1;

  const p2 = add(p0, scale(dp2, 0.5 * dt));
  const v2 = add(v0, scale(a2, 0.5 * dt));
  const a3 = computeAcceleration(p2, v2);
  const dp3 = v2;

  const p3 = add(p0, scale(dp3, dt));
  const v3 = add(v0, scale(a3, dt));
  const a4 = computeAcceleration(p3, v3);
  const dp4 = v3;

  const dpCombined = scale(add(add(dp1, scale(dp2, 2)), add(scale(dp3, 2), dp4)), dt / 6);
  const dvCombined = scale(add(add(a1, scale(a2, 2)), add(scale(a3, 2), a4)), dt / 6);

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
 * Transforms a world point into standing target local coordinates.
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
 * Transforms a standing target local point to world coordinates.
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
 * Maps a world-space point into the standing-equivalent collider space of a specific posed ragdoll bone,
 * AND returns the bone-local offset (bx, by, bz) along (basisRight, basisUp, basisForward).
 */
function worldToBoneColliderSpace(
  worldPt: Vec3Like,
  target: TargetHealthState,
  zone: GhoulZoneId
): { colliderSpacePt: Vec3Like; boneLocalOffset: Vec3Like } {
  const bone = target.ragdollBones[zone];
  const rest = REST_BONE_BASES[zone];
  const rel = sub(worldPt, bone.position);
  const bx = dot(rel, bone.basisRight);
  const by = dot(rel, bone.basisUp);
  const bz = dot(rel, bone.basisForward);

  const colliderSpacePt = {
    x: rest.jointPos.x + rest.right.x * bx + rest.up.x * by + rest.forward.x * bz,
    y: rest.jointPos.y + rest.right.y * bx + rest.up.y * by + rest.forward.y * bz,
    z: rest.jointPos.z + rest.right.z * bx + rest.up.z * by + rest.forward.z * bz,
  };

  return {
    colliderSpacePt,
    boneLocalOffset: { x: bx, y: by, z: bz },
  };
}

function boneColliderDirToWorld(
  colliderDir: Vec3Like,
  target: TargetHealthState,
  zone: GhoulZoneId
): Vec3Like {
  const bone = target.ragdollBones[zone];
  const rest = REST_BONE_BASES[zone];
  const bx = dot(colliderDir, rest.right);
  const by = dot(colliderDir, rest.up);
  const bz = dot(colliderDir, rest.forward);
  return normalize({
    x: bone.basisRight.x * bx + bone.basisUp.x * by + bone.basisForward.x * bz,
    y: bone.basisRight.y * bx + bone.basisUp.y * by + bone.basisForward.y * bz,
    z: bone.basisRight.z * bx + bone.basisUp.z * by + bone.basisForward.z * bz,
  });
}

/**
 * Ray-volume intersection in collider local coordinate space.
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
    const radius = col.halfExtents.x;
    const oc = sub(pA, col.localCenter);
    const b = dot(oc, rayDir);
    const c = dot(oc, oc) - radius * radius;
    const discr = b * b - c;
    if (discr < 0) return null;

    const sqrtD = Math.sqrt(discr);
    const t1 = -b - sqrtD;
    const t2 = -b + sqrtD;

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
 * Computes broad-phase AABB encompassing all non-severed bones of the target (even when airborne or sprawled on the floor!).
 */
function computeTargetLiveBounds(target: TargetHealthState): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    if (b.severed && b.goreMode === 'CRANIAL_POP') continue;
    const pad = 0.28;
    if (b.position.x - pad < minX) minX = b.position.x - pad;
    if (b.position.x + pad > maxX) maxX = b.position.x + pad;
    if (b.position.y - pad < minY) minY = b.position.y - pad;
    if (b.position.y + pad > maxY) maxY = b.position.y + pad;
    if (b.position.z - pad < minZ) minZ = b.position.z - pad;
    if (b.position.z + pad > maxZ) maxZ = b.position.z + pad;
  }

  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Full simulation of a weapon shot against a combatant target.
 * Computes RK4 external ballistics, armor vs penetration, multi-layer tissue cavitation,
 * real-world physiological trauma, Soldier of Fortune GHOUL dismemberment, and 3D ragdoll launch.
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
  const maxRangeM = 300.0;
  const maxFlightTimeS = 2.0;

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

    while (
      proj.alive &&
      proj.distanceTraveledM < maxRangeM &&
      proj.flightTimeS < maxFlightTimeS &&
      proj.position.y > -5.0
    ) {
      const prevPos = copyVec3(proj.position);
      proj = stepProjectileRK4(proj, env, dt);
      const currPos = proj.position;

      if (trajectorySamples.length < 50 || trajectorySamples.length % 5 === 0) {
        const speed = length(proj.velocity);
        const mach = speed / env.speedOfSoundMs;
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

      // Broad-phase check against live posed bounds
      const segMinX = Math.min(prevPos.x, currPos.x);
      const segMaxX = Math.max(prevPos.x, currPos.x);
      const segMinY = Math.min(prevPos.y, currPos.y);
      const segMaxY = Math.max(prevPos.y, currPos.y);
      const segMinZ = Math.min(prevPos.z, currPos.z);
      const segMaxZ = Math.max(prevPos.z, currPos.z);

      const aabbOverlap =
        segMaxX >= bounds.minX &&
        segMinX <= bounds.maxX &&
        segMaxY >= bounds.minY &&
        segMinY <= bounds.maxY &&
        segMaxZ >= bounds.minZ &&
        segMinZ <= bounds.maxZ;

      if (aabbOverlap) {
        interface HitCandidate {
          collider: AnatomicalColliderVolume;
          tEntry: number;
          tExit: number;
          localNormal: Vec3Like;
          entryWorld: Vec3Like;
          exitWorld: Vec3Like;
          localEntryOffset: Vec3Like;
          localExitOffset: Vec3Like;
          normalWorld: Vec3Like;
          pathLen: number;
        }
        const hits: HitCandidate[] = [];

        for (const col of ALL_ANATOMICAL_COLLIDERS) {
          // Skip armor colliders if target does not wear or has lost that armor
          if (col.id === 'vol_helmet_kevlar') {
            if (!target.hasHelmetArmor || !target.headgearIntact || target.helmetArmorIntegrity <= 5) {
              continue;
            }
          }
          if (col.id === 'vol_thorax_kevlar_vest') {
            if (!target.hasChestArmor || target.chestArmorIntegrity <= 5) {
              continue;
            }
          }

          // Skip obliterated cranial pop head; allow shooting severed limbs on the floor!
          if (
            target.zoneGoreMode[col.ghoulZone] === 'CRANIAL_POP' &&
            (col.ghoulZone === 'HEAD_CRANIUM' || col.ghoulZone === 'HEAD_FACE_JAW')
          ) {
            continue;
          }
          if (penetratedColliders.has(col.id)) {
            continue;
          }

          // Transform segment into the live posed bone's collider coordinate frame
          const mapA = worldToBoneColliderSpace(prevPos, target, col.ghoulZone);
          const mapB = worldToBoneColliderSpace(currPos, target, col.ghoulZone);

          const inter = intersectSegmentVolume(mapA.colliderSpacePt, mapB.colliderSpacePt, col);
          if (inter) {
            const entryWorld = add(prevPos, scale(sub(currPos, prevPos), inter.tEntry));
            const exitWorld = add(prevPos, scale(sub(currPos, prevPos), inter.tExit));
            const localEntryOffset = add(
              mapA.boneLocalOffset,
              scale(sub(mapB.boneLocalOffset, mapA.boneLocalOffset), inter.tEntry)
            );
            const localExitOffset = add(
              mapA.boneLocalOffset,
              scale(sub(mapB.boneLocalOffset, mapA.boneLocalOffset), inter.tExit)
            );
            const normalWorld = boneColliderDirToWorld(inter.localNormal, target, col.ghoulZone);
            const pathLen = Math.max(0.005, distance(entryWorld, exitWorld));

            hits.push({
              collider: col,
              tEntry: inter.tEntry,
              tExit: inter.tExit,
              localNormal: inter.localNormal,
              entryWorld,
              exitWorld,
              localEntryOffset,
              localExitOffset,
              normalWorld,
              pathLen,
            });
          }
        }

        hits.sort((a, b) => a.tEntry - b.tEntry);

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
                const shotRightRaw = cross(pelletAimDir, vec3(0, 1, 0));
                const shotRight =
                  lengthSq(shotRightRaw) > 1e-6 ? normalize(shotRightRaw) : vec3(1, 0, 0);
                bulletDropAtImpactCm = (straightPos.y - hit.entryWorld.y) * 100;
                windDriftAtImpactCm = dot(sub(hit.entryWorld, straightPos), shotRight) * 100;
              }
            }

            const currentSpeed = length(proj.velocity);
            const entryEnergy = proj.kineticEnergyJ;
            const bulletDir = normalize(proj.velocity);

            // Check NIJ IIIA Kevlar Armor Interaction (Stopping rounds defeated; Penetrators perforate!)
            if (col.layerType === 'ARMOR_KEVLAR') {
              const armorRatingFactor =
                ammo.armorPenetrationFactor * Math.pow(currentSpeed / 520, 0.85);
              const defeatedArmor = armorRatingFactor >= 1.15;

              if (!defeatedArmor) {
                // Armor STOPS the projectile! Transfers blunt backface deformation shock without perforating
                const bluntTraumaJ = entryEnergy * 0.18;
                const bluntDamageHp = bluntTraumaJ / 16.0;
                const impulseMag =
                  (ammo.massKg * currentSpeed + entryEnergy / 220.0) *
                  ammo.ragdollImpulseMultiplier;
                const impulseVec = scale(bulletDir, impulseMag);

                totalDamageHp += bluntDamageHp;
                totalEnergyDepositedJ += entryEnergy;
                pelletEnergyDeposited += entryEnergy;
                pelletImpulseTransferred += impulseMag;

                zoneImpulses[col.ghoulZone] = add(
                  zoneImpulses[col.ghoulZone] || vec3(0, 0, 0),
                  impulseVec
                );
                netRootImpulseWorld = add(netRootImpulseWorld, impulseVec);

                if (col.ghoulZone === 'HEAD_CRANIUM' && entryEnergy > 180) {
                  headgearKnockedOff = true;
                  combatantEffectsSet.add('PASGT Helmet Deflected Round — Helmet Knocked Off!');
                } else {
                  combatantEffectsSet.add('NIJ IIIA Kevlar Stopped Projectile — Blunt Rib Trauma');
                }

                const armorWound: WoundChannelEvent = {
                  colliderId: col.id,
                  label: col.label,
                  ghoulZone: col.ghoulZone,
                  layerType: col.layerType,
                  entryPointWorld: hit.entryWorld,
                  exitPointWorld: hit.entryWorld,
                  entryNormalWorld: hit.normalWorld,
                  localEntryOffset: hit.localEntryOffset,
                  localExitOffset: hit.localEntryOffset,
                  impactDirectionWorld: bulletDir,
                  pathLengthM: 0.015,
                  entryVelocityMs: currentSpeed,
                  exitVelocityMs: 0,
                  entryEnergyJ: entryEnergy,
                  exitEnergyJ: 0,
                  energyDepositedJ: entryEnergy,
                  impulseTransferredNs: impulseMag,
                  permanentCavityRadiusCm: 0.8,
                  temporaryStretchCavityRadiusCm: 2.5,
                  armorStopped: true,
                  bluntTraumaJ,
                  boneFractured: false,
                  boneShattered: false,
                  organRuptured: false,
                  limbSensoryShock: bluntTraumaJ > 65,
                  limbSevered: false,
                  arterialSevered: false,
                  deflectionAngleDeg: 0,
                  physiologicalEffect: 'Stopped by Kevlar Armor (Backface Blunt Trauma)',
                };
                pelletWoundEvents.push(armorWound);
                allWoundEvents.push(armorWound);
                penetratedColliders.add(col.id);
                proj.alive = false;
                break;
              } else {
                // Rifle / AP penetrator punches straight through Kevlar!
                const armorEnergyCost = Math.min(
                  entryEnergy * 0.22,
                  260 / ammo.armorPenetrationFactor
                );
                const exitE = Math.max(0, entryEnergy - armorEnergyCost);
                const exitSpd = Math.sqrt((2 * exitE) / ammo.massKg);
                proj.kineticEnergyJ = exitE;
                proj.velocity = scale(bulletDir, exitSpd);
                penetratedColliders.add(col.id);
                combatantEffectsSet.add(`${col.label} Perforated by ${ammo.caliber}`);
                continue;
              }
            }

            // Stopping Power (Mushroom Expansion) vs Over-Penetration (Rigid Core) inside Soft Tissue
            if (col.layerType === 'SOFT_FLESH' || col.layerType.startsWith('ORGAN_')) {
              const maxDiam = ammo.diameterM * ammo.tissueExpansionFactor;
              const expansionProgress = Math.min(1.0, hit.pathLen / 0.11);
              const targetDiam =
                ammo.diameterM * (1.0 + (ammo.tissueExpansionFactor - 1.0) * expansionProgress);
              proj.currentDiameterM = Math.min(
                maxDiam,
                Math.max(proj.currentDiameterM, targetDiam)
              );
            }

            const diamRatio = proj.currentDiameterM / ammo.diameterM;
            const resistanceBase = 1550 * col.stoppingPowerFactor * (col.densityKgM3 / 1000);
            const penetrationMultiplier =
              col.layerType === 'CORTICAL_BONE'
                ? 1.0 / Math.pow(ammo.armorPenetrationFactor, 1.45)
                : Math.pow(diamRatio, 2.2);
            const energyLossRate = resistanceBase * penetrationMultiplier;
            // Ribcage is a hollow cage (front + back ribs ~5.5cm cortical bone), not a solid 21cm ivory block!
            const effectiveTissuePathM =
              col.id === 'vol_thorax_ribcage' ? Math.min(hit.pathLen, 0.055) : hit.pathLen;
            const energyDeposited = Math.min(entryEnergy, energyLossRate * effectiveTissuePathM);

            const exitEnergy = Math.max(0, entryEnergy - energyDeposited);
            const exitSpeed = Math.sqrt((2 * exitEnergy) / ammo.massKg);

            // Physical projectile momentum transfer (delta_p) + localized inelastic tissue shock
            const deltaP = ammo.massKg * (currentSpeed - exitSpeed);
            const impulseMagnitude =
              (deltaP + energyDeposited / 195.0) * ammo.ragdollImpulseMultiplier;
            const impulseVec = scale(bulletDir, impulseMagnitude);

            // Stopping Power cavitation bonus rewards expanding JHP & multi-pellet buckshot on unarmored flesh
            const pelletSynergy = ammo.pelletCount > 1 ? 1.48 : 1.0;
            const stoppingDamageMult = Math.pow(ammo.tissueExpansionFactor, 1.25) * pelletSynergy;
            const layerDamage =
              (energyDeposited / 36.0) * col.vitalityMultiplier * stoppingDamageMult;
            totalDamageHp += layerDamage;
            totalEnergyDepositedJ += energyDeposited;
            pelletEnergyDeposited += energyDeposited;
            pelletImpulseTransferred += impulseMagnitude;

            const currentZoneE = zoneEnergyDeposited[col.ghoulZone] || 0;
            zoneEnergyDeposited[col.ghoulZone] = currentZoneE + energyDeposited * ammo.goreFactor;

            const existingZoneImpulse = zoneImpulses[col.ghoulZone] || vec3(0, 0, 0);
            zoneImpulses[col.ghoulZone] = add(existingZoneImpulse, impulseVec);

            netRootImpulseWorld = add(netRootImpulseWorld, impulseVec);
            const comWorld = target.ragdollBones.PELVIS_GROIN.position;
            const hitOffsetFromCom = sub(hit.entryWorld, comWorld);
            netTorqueWorld = add(netTorqueWorld, cross(hitOffsetFromCom, impulseVec));

            // High-energy rifle/AP penetrators still fracture cortical bone on direct perforation
            const highEnergyBonePerforation =
              col.layerType === 'CORTICAL_BONE' &&
              entryEnergy >= col.fractureThresholdJ * 3.5 &&
              hit.pathLen >= 0.025;
            const boneFractured =
              col.layerType === 'CORTICAL_BONE' &&
              (energyDeposited >= col.fractureThresholdJ || highEnergyBonePerforation);
            const boneShattered =
              boneFractured &&
              (energyDeposited >= col.fractureThresholdJ * 1.8 ||
                ammo.goreFactor >= 2.2 ||
                entryEnergy >= col.fractureThresholdJ * 6.0);
            const organRuptured =
              col.layerType.startsWith('ORGAN_') && energyDeposited >= col.fractureThresholdJ;
            const arterialSevered =
              col.layerType === 'ARTERY_CAROTID_AORTA' && energyDeposited >= col.fractureThresholdJ;

            if (boneFractured) shatteredBonesSet.add(col.label);
            if (organRuptured || arterialSevered) rupturedOrgansSet.add(col.label);

            // Real-world physiological impact classification
            let physEffect = 'Soft Tissue Cavitation & Laceration';
            if (col.layerType === 'ORGAN_BRAIN' && organRuptured) {
              physEffect = 'CNS Cranial Disruption — Instant Neuromuscular Collapse';
              combatantEffectsSet.add(physEffect);
            } else if (col.id === 'vol_neck_spine' && boneFractured) {
              physEffect = 'Cervical Spinal Cord Severance — Instant Paralysis';
              combatantEffectsSet.add(physEffect);
            } else if (col.layerType === 'ORGAN_HEART' && organRuptured) {
              physEffect = 'Cardiac Ventricular Rupture — Catastrophic BP Loss';
              combatantEffectsSet.add(physEffect);
            } else if (arterialSevered) {
              physEffect = `${col.label} Transected — Pulsing Arterial Hemorrhage`;
              combatantEffectsSet.add(physEffect);
            } else if (
              (col.layerType === 'ORGAN_LUNG_LEFT' || col.layerType === 'ORGAN_LUNG_RIGHT') &&
              organRuptured
            ) {
              physEffect = `${col.label} Perforation — Tension Pneumothorax`;
              combatantEffectsSet.add(physEffect);
            } else if (
              (col.layerType === 'ORGAN_STOMACH_GUT' || col.layerType === 'ORGAN_LIVER') &&
              organRuptured
            ) {
              physEffect = `${col.label} Hydrostatic Rupture — Visceral Shock`;
              combatantEffectsSet.add(physEffect);
            } else if (boneFractured) {
              if (
                col.ghoulZone === 'THIGH_LEFT' ||
                col.ghoulZone === 'KNEE_LEFT' ||
                col.ghoulZone === 'SHIN_LEFT' ||
                col.ghoulZone === 'THIGH_RIGHT' ||
                col.ghoulZone === 'KNEE_RIGHT' ||
                col.ghoulZone === 'SHIN_RIGHT' ||
                col.ghoulZone === 'PELVIS_GROIN'
              ) {
                physEffect = `${col.label} Fractured — Structural Leg Collapse`;
                combatantEffectsSet.add(physEffect);
              } else if (
                col.ghoulZone === 'UPPER_ARM_RIGHT' ||
                col.ghoulZone === 'FOREARM_RIGHT'
              ) {
                physEffect = `${col.label} Shattered — Combatant Disarmed`;
                weaponDisarmed = true;
                combatantEffectsSet.add(physEffect);
              } else {
                physEffect = `${col.label} Comminuted Fracture`;
                combatantEffectsSet.add(physEffect);
              }
            }

            if (
              (col.ghoulZone === 'HAND_RIGHT' ||
                col.ghoulZone === 'FOREARM_RIGHT' ||
                col.ghoulZone === 'UPPER_ARM_RIGHT') &&
              energyDeposited >= 65
            ) {
              weaponDisarmed = true;
              combatantEffectsSet.add('Weapon Arm Trauma — Dropped Firearm');
            }

            if (
              (col.ghoulZone === 'HEAD_CRANIUM' || col.ghoulZone === 'HEAD_FACE_JAW') &&
              target.headgearIntact &&
              energyDeposited >= 45
            ) {
              headgearKnockedOff = true;
            }

            const permRadiusCm = Math.max(
              0.4,
              proj.currentDiameterM * 100 * 0.5 * ammo.tissueExpansionFactor
            );
            const tempRadiusCm = Math.min(
              14.0,
              permRadiusCm * (currentSpeed / 120.0) * Math.sqrt(ammo.tissueExpansionFactor)
            );

            const woundEvent: WoundChannelEvent = {
              colliderId: col.id,
              label: col.label,
              ghoulZone: col.ghoulZone,
              layerType: col.layerType,
              entryPointWorld: hit.entryWorld,
              exitPointWorld: hit.exitWorld,
              entryNormalWorld: hit.normalWorld,
              localEntryOffset: hit.localEntryOffset,
              localExitOffset: hit.localExitOffset,
              impactDirectionWorld: bulletDir,
              pathLengthM: hit.pathLen,
              entryVelocityMs: currentSpeed,
              exitVelocityMs: exitSpeed,
              entryEnergyJ: entryEnergy,
              exitEnergyJ: exitEnergy,
              energyDepositedJ: energyDeposited,
              impulseTransferredNs: impulseMagnitude,
              permanentCavityRadiusCm: permRadiusCm,
              temporaryStretchCavityRadiusCm: tempRadiusCm,
              armorStopped: false,
              bluntTraumaJ: 0,
              boneFractured,
              boneShattered,
              organRuptured,
              limbSensoryShock: energyDeposited > 130,
              limbSevered: false,
              arterialSevered,
              deflectionAngleDeg: 1.2 * (col.layerType === 'CORTICAL_BONE' ? 3.5 : 1.0),
              physiologicalEffect: physEffect,
            };

            pelletWoundEvents.push(woundEvent);
            allWoundEvents.push(woundEvent);
            penetratedColliders.add(col.id);

            proj.penetratedLayers++;
            proj.kineticEnergyJ = exitEnergy;
            proj.velocity = scale(bulletDir, exitSpeed);

            if (exitEnergy < 15.0 || exitSpeed < 40.0) {
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

  const targetDistanceM = distance(originWorld, target.worldPosition);

  // ---------------------------------------------------------------------------
  // Grounded Real-World GHOUL Dismemberment & Joint Precision Pass
  // ---------------------------------------------------------------------------
  // Requires large caliber + adequate range; rewards deliberate shots at anatomical joints!
  const pointToSegmentDist = (pt: Vec3Like, a: Vec3Like, b: Vec3Like): number => {
    const ab = sub(b, a);
    const lenSq = lengthSq(ab);
    if (lenSq < 1e-8) return distance(pt, a);
    const t = Math.max(0, Math.min(1, dot(sub(pt, a), ab) / lenSq));
    return distance(pt, add(a, scale(ab, t)));
  };

  const isHeavyDismembermentCaliber =
    ammo.diameterM >= 0.007 &&
    ((ammo.type === 'BUCKSHOT_00' && targetDistanceM <= 6.5) ||
      (ammo.id === '12G_FLECHETTE_SLUG' && targetDistanceM <= 16.0) ||
      (weapon.role === 'HEAVY_PISTOL' && ammo.diameterM >= 0.012 && targetDistanceM <= 15.0) ||
      (weapon.role === 'SNIPER' && targetDistanceM <= 45.0));

  const isPointBlank12G = weapon.role === 'SHOTGUN' && targetDistanceM <= 3.2;

  // Map anatomical joint pivots so deliberate shots at Shoulder, Elbow, Wrist, Hip, Knee, Ankle, or Neck
  // sever cleanly at that joint!
  const JOINT_SEVER_SPECS: Array<{
    severZone: GhoulZoneId;
    jointPivotZone: GhoulZoneId;
    radiusM: number;
    label: string;
    relatedZones: GhoulZoneId[];
  }> = [
    {
      severZone: 'HAND_LEFT',
      jointPivotZone: 'HAND_LEFT',
      radiusM: 0.085,
      label: 'Left Wrist Joint',
      relatedZones: ['HAND_LEFT', 'FOREARM_LEFT'],
    },
    {
      severZone: 'HAND_RIGHT',
      jointPivotZone: 'HAND_RIGHT',
      radiusM: 0.085,
      label: 'Right Wrist Joint',
      relatedZones: ['HAND_RIGHT', 'FOREARM_RIGHT'],
    },
    {
      severZone: 'FOREARM_LEFT',
      jointPivotZone: 'FOREARM_LEFT',
      radiusM: 0.085,
      label: 'Left Elbow Joint',
      relatedZones: ['FOREARM_LEFT', 'UPPER_ARM_LEFT'],
    },
    {
      severZone: 'FOREARM_RIGHT',
      jointPivotZone: 'FOREARM_RIGHT',
      radiusM: 0.085,
      label: 'Right Elbow Joint',
      relatedZones: ['FOREARM_RIGHT', 'UPPER_ARM_RIGHT'],
    },
    {
      severZone: 'UPPER_ARM_LEFT',
      jointPivotZone: 'UPPER_ARM_LEFT',
      radiusM: 0.088,
      label: 'Left Shoulder Joint',
      relatedZones: ['UPPER_ARM_LEFT', 'SHOULDER_LEFT'],
    },
    {
      severZone: 'UPPER_ARM_RIGHT',
      jointPivotZone: 'UPPER_ARM_RIGHT',
      radiusM: 0.088,
      label: 'Right Shoulder Joint',
      relatedZones: ['UPPER_ARM_RIGHT', 'SHOULDER_RIGHT'],
    },
    {
      severZone: 'FOOT_LEFT',
      jointPivotZone: 'FOOT_LEFT',
      radiusM: 0.085,
      label: 'Left Ankle Joint',
      relatedZones: ['FOOT_LEFT', 'SHIN_LEFT'],
    },
    {
      severZone: 'FOOT_RIGHT',
      jointPivotZone: 'FOOT_RIGHT',
      radiusM: 0.085,
      label: 'Right Ankle Joint',
      relatedZones: ['FOOT_RIGHT', 'SHIN_RIGHT'],
    },
    {
      severZone: 'KNEE_LEFT',
      jointPivotZone: 'KNEE_LEFT',
      radiusM: 0.092,
      label: 'Left Knee Joint',
      relatedZones: ['KNEE_LEFT', 'THIGH_LEFT', 'SHIN_LEFT'],
    },
    {
      severZone: 'KNEE_RIGHT',
      jointPivotZone: 'KNEE_RIGHT',
      radiusM: 0.092,
      label: 'Right Knee Joint',
      relatedZones: ['KNEE_RIGHT', 'THIGH_RIGHT', 'SHIN_RIGHT'],
    },
    {
      severZone: 'THIGH_LEFT',
      jointPivotZone: 'THIGH_LEFT',
      radiusM: 0.090,
      label: 'Left Hip Joint',
      relatedZones: ['THIGH_LEFT', 'PELVIS_GROIN'],
    },
    {
      severZone: 'THIGH_RIGHT',
      jointPivotZone: 'THIGH_RIGHT',
      radiusM: 0.090,
      label: 'Right Hip Joint',
      relatedZones: ['THIGH_RIGHT', 'PELVIS_GROIN'],
    },
    {
      severZone: 'NECK_CERVICAL',
      jointPivotZone: 'NECK_CERVICAL',
      radiusM: 0.075,
      label: 'Cervical Neck Joint',
      relatedZones: ['NECK_CERVICAL'],
    },
  ];

  const jointHitBonusByZone: Partial<Record<GhoulZoneId, { maxEntryJ: number; label: string }>> = {};
  if (isHeavyDismembermentCaliber && allWoundEvents.length > 0) {
    for (const jSpec of JOINT_SEVER_SPECS) {
      const pivotPos = target.ragdollBones[jSpec.jointPivotZone].position;
      let maxEntryJ = 0;
      let matched = false;
      for (const we of allWoundEvents) {
        if (we.armorStopped) continue;
        if (!jSpec.relatedZones.includes(we.ghoulZone)) continue;
        const d = pointToSegmentDist(pivotPos, we.entryPointWorld, we.exitPointWorld);
        if (d <= jSpec.radiusM) {
          matched = true;
          if (we.entryEnergyJ > maxEntryJ) maxEntryJ = we.entryEnergyJ;
        }
      }
      if (matched) {
        // Heavy pistol (.50 AE) severs distal joints (wrist/elbow/knee/ankle) cleanly up to 15m,
        // while thick proximal hip/shoulder sockets require <= 6m for pistol!
        const isThickSocket =
          jSpec.severZone === 'THIGH_LEFT' ||
          jSpec.severZone === 'THIGH_RIGHT' ||
          jSpec.severZone === 'UPPER_ARM_LEFT' ||
          jSpec.severZone === 'UPPER_ARM_RIGHT';
        if (weapon.role === 'HEAVY_PISTOL' && isThickSocket && targetDistanceM > 6.0) {
          continue;
        }
        jointHitBonusByZone[jSpec.severZone] = { maxEntryJ, label: jSpec.label };
        // Ensure candidate zone is evaluated even if the bullet grazed the adjacent parent/child collider at the joint!
        if (zoneEnergyDeposited[jSpec.severZone] === undefined) {
          zoneEnergyDeposited[jSpec.severZone] = 0;
        }
      }
    }
  }

  const candidateZones = Object.keys(zoneEnergyDeposited) as GhoulZoneId[];
  if (isHeavyDismembermentCaliber) {
    for (const zone of candidateZones) {
      if (severedZonesSet.has(zone)) continue;

      const shotGoreEnergy = zoneEnergyDeposited[zone] || 0;
      const jointHit = jointHitBonusByZone[zone];

      // Cranial Pop only happens at close execution range with heavy ordnance (no distant watermelon head pops!)
      if (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW') {
        const canPopSkull =
          (weapon.role === 'SHOTGUN' && targetDistanceM <= 5.5) ||
          (ammo.diameterM >= 0.012 && targetDistanceM <= 7.0) ||
          (weapon.role === 'SNIPER' && ammo.tissueExpansionFactor >= 1.4 && targetDistanceM <= 12.0);
        if (!canPopSkull) continue;
      }

      // Stomach Evisceration requires point-blank heavy blast
      if (zone === 'TORSO_LOWER_ABDOMEN' && !isPointBlank12G) {
        continue;
      }

      const refCol = ALL_ANATOMICAL_COLLIDERS.find(
        (c) => c.ghoulZone === zone && c.layerType !== 'ARMOR_KEVLAR'
      );
      const severThreshold = refCol ? refCol.severThresholdJ : 9999;

      // Deliberate joint hits get a major articular-capsule shatter multiplier;
      // mid-shaft muscle/diaphysis hits resist single-bullet amputation unless point-blank 12G!
      let effectiveShotGoreJ = shotGoreEnergy;
      if (jointHit) {
        let jointRelatedGoreJ = shotGoreEnergy;
        for (const we of allWoundEvents) {
          if (!we.armorStopped && distance(we.entryPointWorld, target.ragdollBones[zone].position) <= 0.12) {
            jointRelatedGoreJ += we.energyDepositedJ * ammo.goreFactor * 0.65;
          }
        }
        effectiveShotGoreJ = jointRelatedGoreJ * 1.85 + jointHit.maxEntryJ * 0.34;
      } else if (
        !isPointBlank12G &&
        zone !== 'HEAD_CRANIUM' &&
        zone !== 'HEAD_FACE_JAW' &&
        zone !== 'TORSO_LOWER_ABDOMEN'
      ) {
        effectiveShotGoreJ = shotGoreEnergy * 0.36;
      }

      const totalZoneGoreEnergy = (target.zoneCumulativeDamageJ[zone] || 0) + effectiveShotGoreJ;

      if (totalZoneGoreEnergy >= severThreshold && !severedZonesSet.has(zone)) {
        const blastDir = normalize(normAimDir);
        const boneState = target.ragdollBones[zone];
        const stumpWorld = copyVec3(boneState.position);

        // Special Case: TORSO_LOWER_ABDOMEN EVISCERATION!
        // Keeps spine & body 100% connected as one flying ragdoll, while ripping open visceral stomach cavity!
        if (zone === 'TORSO_LOWER_ABDOMEN') {
          if (target.zoneGoreMode.TORSO_LOWER_ABDOMEN !== 'EVISCERATED') {
            combatantEffectsSet.add('GHOUL Gut Evisceration — Massive Abdominal Trauma');
            dismembermentEvents.push({
              zone,
              parentZone: 'PELVIS_GROIN',
              goreMode: 'EVISCERATED',
              detachedSubtree: [],
              stumpWorldPosition: stumpWorld,
              arterialSprayDirection: scale(blastDir, -0.6),
              severedLimbVelocity: scale(blastDir, 6.0),
              severedLimbAngularVelocity: vec3(4, 3, -4),
              gibCount: 7,
            });
          }
          continue;
        }

        let goreMode: GoreMode = 'CLEAN_SEVER';
        let gibCount = 4;

        if (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW') {
          goreMode = 'CRANIAL_POP';
          gibCount = 14;
          combatantEffectsSet.add('GHOUL Cranial Pop — Catastrophic Head Obliteration');
        } else if (jointHit) {
          combatantEffectsSet.add(`JOINT SHATTERED — ${jointHit.label} Severed`);
        } else {
          combatantEffectsSet.add(`GHOUL Clean Sever — ${GHOUL_ZONE_HIERARCHY[zone].label} Amputated`);
        }

        if (
          zone === 'UPPER_ARM_RIGHT' ||
          zone === 'FOREARM_RIGHT' ||
          zone === 'HAND_RIGHT'
        ) {
          weaponDisarmed = true;
        }

        const detachedSubtree = getSubtreeZones(zone);
        for (const det of detachedSubtree) {
          severedZonesSet.add(det);
          if (!newlySeveredZones.includes(det)) {
            newlySeveredZones.push(det);
          }
        }

        const hierNode = GHOUL_ZONE_HIERARCHY[zone];
        const zoneImpulse = zoneImpulses[zone] || scale(blastDir, 22);
        const limbSpeed = Math.min(11.0, Math.max(3.8, length(zoneImpulse) / (hierNode.defaultMassKg + 1.1)));
        const limbVelocity = add(
          scale(blastDir, limbSpeed),
          vec3((Math.random() - 0.5) * 1.4, 1.6 + Math.random() * 1.4, (Math.random() - 0.5) * 1.4)
        );

        const parentZone = hierNode.parent;
        const sprayDir = parentZone
          ? normalize(add(sub(boneState.position, target.ragdollBones[parentZone].position), vec3(0, 0.35, 0)))
          : vec3(0, 1, 0);

        dismembermentEvents.push({
          zone,
          parentZone,
          goreMode,
          detachedSubtree,
          stumpWorldPosition: stumpWorld,
          arterialSprayDirection: sprayDir,
          severedLimbVelocity: limbVelocity,
          severedLimbAngularVelocity: vec3(
            (Math.random() - 0.5) * 8,
            (Math.random() - 0.5) * 8,
            (Math.random() - 0.5) * 8
          ),
          gibCount,
        });

        for (const we of allWoundEvents) {
          if (we.ghoulZone === zone) {
            we.limbSevered = true;
          }
        }
      }
    }
  }

  // Acute Cardiac Shock bonus on direct Heart rupture (lethal for sniper / .50 AE / close 12G!)
  if (rupturedOrgansSet.has('Heart (Myocardium & Ventricles)')) {
    totalDamageHp += 68.0;
  }

  // Peripheral Limb Non-Lethality Invariant:
  // Shooting or even severing an arm, hand, leg, knee, shin, or foot NEVER instakills a combatant!
  const isLimbZone = (z: GhoulZoneId): boolean =>
    z === 'SHOULDER_LEFT' ||
    z === 'UPPER_ARM_LEFT' ||
    z === 'FOREARM_LEFT' ||
    z === 'HAND_LEFT' ||
    z === 'SHOULDER_RIGHT' ||
    z === 'UPPER_ARM_RIGHT' ||
    z === 'FOREARM_RIGHT' ||
    z === 'HAND_RIGHT' ||
    z === 'THIGH_LEFT' ||
    z === 'KNEE_LEFT' ||
    z === 'SHIN_LEFT' ||
    z === 'FOOT_LEFT' ||
    z === 'THIGH_RIGHT' ||
    z === 'KNEE_RIGHT' ||
    z === 'SHIN_RIGHT' ||
    z === 'FOOT_RIGHT';

  const isPureLimbShot =
    hasHitTarget &&
    allWoundEvents.length > 0 &&
    allWoundEvents.every((w) => isLimbZone(w.ghoulZone));

  if (isPureLimbShot && target.currentHp > 32.0) {
    totalDamageHp = Math.min(totalDamageHp, Math.min(52.0, target.currentHp - 25.0));
  }

  // Close-range muzzle blast & concentrated stopping-power knockback!
  // Shotgun has punchy close-quarters knockback inside < 6.5m, decaying smoothly to ZERO at long range!
  const closeRangeCutoffM = weapon.role === 'SHOTGUN' ? 6.5 : 3.8;
  if (hasHitTarget && targetDistanceM < closeRangeCutoffM) {
    const closeFactor = Math.pow(Math.max(0, 1.0 - targetDistanceM / closeRangeCutoffM), 1.45);
    const roleBlastScale = weapon.role === 'SHOTGUN' ? 0.19 : 0.09;
    const closeBlastNs =
      totalEnergyDepositedJ * roleBlastScale * closeFactor * ammo.ragdollImpulseMultiplier;
    const blastVec = scale(normAimDir, closeBlastNs);
    netRootImpulseWorld = add(netRootImpulseWorld, blastVec);
    if (primaryHitZone) {
      zoneImpulses[primaryHitZone] = add(
        zoneImpulses[primaryHitZone] || vec3(0, 0, 0),
        blastVec
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Lethality, Stagger-Before-Collapse & Realistic 82 kg Heavy-Body Ragdoll Plan
  // ---------------------------------------------------------------------------
  const isCranialExploded = dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP');
  const isNeckSevered = dismembermentEvents.some((d) => d.zone === 'NECK_CERVICAL');
  const isGutEviscerated = dismembermentEvents.some((d) => d.goreMode === 'EVISCERATED');
  const isPelvisShattered = allWoundEvents.some(
    (w) => w.boneFractured && w.ghoulZone === 'PELVIS_GROIN'
  );

  // Instant HP-bypassing organ death ONLY on true Central Nervous System destruction (Brain / Cervical Spine)!
  const isCnsDestroyed =
    rupturedOrgansSet.has('Brain (Cerebrum & Brainstem)') ||
    shatteredBonesSet.has('Cervical Spine (C1-C7)');

  const isLethalKill =
    hasHitTarget &&
    !isPureLimbShot &&
    (totalDamageHp >= target.currentHp ||
      isCranialExploded ||
      isNeckSevered ||
      isGutEviscerated ||
      isCnsDestroyed);

  const leftLegSeveredAfter =
    severedZonesSet.has('THIGH_LEFT') ||
    severedZonesSet.has('KNEE_LEFT') ||
    severedZonesSet.has('SHIN_LEFT') ||
    severedZonesSet.has('FOOT_LEFT');
  const rightLegSeveredAfter =
    severedZonesSet.has('THIGH_RIGHT') ||
    severedZonesSet.has('KNEE_RIGHT') ||
    severedZonesSet.has('SHIN_RIGHT') ||
    severedZonesSet.has('FOOT_RIGHT');
  const bothLegsSevered = leftLegSeveredAfter && rightLegSeveredAfter;

  const bodyMassKg = 82.0;
  const horizontalImpulseMag = length(vec3(netRootImpulseWorld.x, 0, netRootImpulseWorld.z));

  // Single-leg sever staggers first (~0.72s) while standing on the remaining leg before falling alive!
  // Immediate ragdoll knockdown only occurs on lethal kills, both legs severed, shattered pelvis,
  // or overwhelming torso point-blank shotgun blast.
  const isImmediateKnockdown =
    hasHitTarget &&
    (bothLegsSevered ||
      isPelvisShattered ||
      (!isPureLimbShot && horizontalImpulseMag >= 230.0));

  const willEnableRagdoll = target.isRagdollActive || isLethalKill || isImmediateKnockdown;

  let launchLiftVelocityMs = 0;
  let estimatedLaunchDistanceM = 0;

  if (willEnableRagdoll && hasHitTarget) {
    // Punchy close-range shotgun unweighting lifts boots slightly so body flies/skids 2-3.5m backward,
    // while 20m shots have ZERO lift and collapse heavily in place!
    launchLiftVelocityMs =
      horizontalImpulseMag > 110.0
        ? Math.min(1.15, (horizontalImpulseMag - 110.0) / 340.0)
        : 0.0;
    const horizSpeed = Math.min(5.6, horizontalImpulseMag / bodyMassKg);
    estimatedLaunchDistanceM = Math.min(3.8, horizSpeed * 0.62);
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

  const triggerXRayKillCam =
    weapon.role === 'SNIPER' &&
    isLethalKill &&
    (rupturedOrgansSet.size > 0 || shatteredBonesSet.size > 0);

  let xRayHighlightPoint: Vec3Like | null = null;
  let xRayFocusZone: GhoulZoneId | null = null;
  if (allWoundEvents.length > 0) {
    const vitalWound =
      allWoundEvents.find((w) => w.organRuptured || w.boneShattered) || allWoundEvents[0];
    xRayHighlightPoint = vitalWound.entryPointWorld;
    xRayFocusZone = vitalWound.ghoulZone;
  }

  // If shot missed target, still compute drop & signed wind drift at targetDistanceM
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
    combatantEffects: Array.from(combatantEffectsSet),
    headgearKnockedOff,
    weaponDisarmed,
    trajectorySamples: primarySamples,
  };
}

/**
 * Applies the shot simulation report to TargetHealthState:
 * updates vitals, armor, surface wounds, pain reactions, GHOUL dismemberment components,
 * and injects realistic 3D jackknife/spin velocities into the PBD ragdoll skeleton!
 */
export function applyShotReportToTarget(
  target: TargetHealthState,
  report: ShotSimulationReport
): void {
  if (!report.hitTarget) return;

  const wasAlreadyRagdoll = target.isRagdollActive;

  target.currentHp = Math.max(0, target.currentHp - report.totalDamageHp);
  if (report.isLethalKill || target.currentHp <= 0) {
    target.alive = false;
    target.consciousness = 0;
  }

  if (report.headgearKnockedOff) {
    target.headgearIntact = false;
  }
  if (report.weaponDisarmed || !target.alive) {
    target.weaponDropped = true;
  }

  for (const b of report.shatteredBones) {
    target.fracturedBones.add(b);
  }
  for (const o of report.rupturedOrgans) {
    target.rupturedOrgans.add(o);
  }

  let leftLegShotEnergyJ = 0;
  let rightLegShotEnergyJ = 0;

  // Process per-wound physiological & localized surface trauma
  for (const w of report.woundEvents) {
    if (!w.armorStopped) {
      if (
        w.ghoulZone === 'THIGH_LEFT' ||
        w.ghoulZone === 'KNEE_LEFT' ||
        w.ghoulZone === 'SHIN_LEFT' ||
        w.ghoulZone === 'FOOT_LEFT'
      ) {
        leftLegShotEnergyJ += w.energyDepositedJ;
      } else if (
        w.ghoulZone === 'THIGH_RIGHT' ||
        w.ghoulZone === 'KNEE_RIGHT' ||
        w.ghoulZone === 'SHIN_RIGHT' ||
        w.ghoulZone === 'FOOT_RIGHT'
      ) {
        rightLegShotEnergyJ += w.energyDepositedJ;
      }
    }

    if (w.armorStopped) {
      if (w.ghoulZone === 'HEAD_CRANIUM') {
        target.helmetArmorIntegrity = Math.max(0, target.helmetArmorIntegrity - 36);
        if (target.helmetArmorIntegrity <= 5) {
          target.headgearIntact = false;
        }
      } else {
        target.chestArmorIntegrity = Math.max(0, target.chestArmorIntegrity - 26);
      }
    } else {
      if (w.layerType === 'SOFT_FLESH' || w.layerType === 'CORTICAL_BONE') {
        target.zoneCumulativeDamageJ[w.ghoulZone] =
          (target.zoneCumulativeDamageJ[w.ghoulZone] || 0) + w.energyDepositedJ * 0.55;
      }
      if (w.layerType === 'SOFT_FLESH') {
        const loss = Math.min(85, w.energyDepositedJ / 4.5);
        target.zoneIntegrity[w.ghoulZone] = Math.max(5, target.zoneIntegrity[w.ghoulZone] - loss);
        if (target.zoneGoreMode[w.ghoulZone] === 'INTACT' && w.energyDepositedJ > 25) {
          target.zoneGoreMode[w.ghoulZone] = 'LACERATED';
        }
        target.bloodLossRateMlPerSec += 2.2;
      }
    }

    if (w.arterialSevered) {
      target.bloodLossRateMlPerSec += w.ghoulZone === 'NECK_CERVICAL' ? 140 : 52;
    }
    if (w.layerType === 'ORGAN_HEART' && w.organRuptured) {
      target.bloodLossRateMlPerSec += 220;
      target.heartRateBpm = 0;
      target.systolicBpMmHg = 25;
    }
    if (
      (w.layerType === 'ORGAN_LUNG_LEFT' || w.layerType === 'ORGAN_LUNG_RIGHT') &&
      w.organRuptured
    ) {
      target.oxygenSaturationPct = Math.max(40, target.oxygenSaturationPct - 28);
      target.bloodLossRateMlPerSec += 26;
    }

    // Structural limb breakdown
    if (w.boneFractured) {
      if (
        w.ghoulZone === 'THIGH_LEFT' ||
        w.ghoulZone === 'KNEE_LEFT' ||
        w.ghoulZone === 'SHIN_LEFT'
      ) {
        target.leftLegFunctional = false;
      }
      if (
        w.ghoulZone === 'THIGH_RIGHT' ||
        w.ghoulZone === 'KNEE_RIGHT' ||
        w.ghoulZone === 'SHIN_RIGHT'
      ) {
        target.rightLegFunctional = false;
      }
      if (w.ghoulZone === 'PELVIS_GROIN') {
        target.leftLegFunctional = false;
        target.rightLegFunctional = false;
      }
      if (w.ghoulZone === 'UPPER_ARM_LEFT' || w.ghoulZone === 'FOREARM_LEFT') {
        target.leftArmFunctional = false;
      }
      if (w.ghoulZone === 'UPPER_ARM_RIGHT' || w.ghoulZone === 'FOREARM_RIGHT') {
        target.rightArmFunctional = false;
        target.weaponDropped = true;
      }
    }

    // Attach 3D bullet wound decal to the hit bone (cap at 28 decals per character)
    if (
      (w.layerType === 'SOFT_FLESH' || w.armorStopped) &&
      target.surfaceWounds.length < 28
    ) {
      target.surfaceWounds.push({
        id: `sw_${target.surfaceWounds.length}_${w.ghoulZone}`,
        zone: w.ghoulZone,
        localOffset: copyVec3(w.localEntryOffset),
        localNormal: vec3(0, 0, 1),
        radiusM: w.armorStopped
          ? 0.018
          : Math.min(0.042, Math.max(0.014, (w.permanentCavityRadiusCm / 100) * 1.8)),
        isExit: false,
        armorDent: w.armorStopped,
      });

      if (!w.armorStopped && w.exitEnergyJ > 25 && target.surfaceWounds.length < 28) {
        target.surfaceWounds.push({
          id: `sw_exit_${target.surfaceWounds.length}_${w.ghoulZone}`,
          zone: w.ghoulZone,
          localOffset: copyVec3(w.localExitOffset),
          localNormal: vec3(0, 0, -1),
          radiusM: Math.min(0.055, Math.max(0.022, (w.permanentCavityRadiusCm / 100) * 2.6)),
          isExit: true,
          armorDent: false,
        });
      }
    }
  }

  if (leftLegShotEnergyJ >= 85.0) {
    target.leftLegFunctional = false;
  }
  if (rightLegShotEnergyJ >= 85.0) {
    target.rightLegFunctional = false;
  }

  // Adrenaline spike if still alive
  if (target.alive) {
    target.painShock = Math.min(1.0, target.painShock + 0.65);
    target.heartRateBpm = Math.min(168, target.heartRateBpm + 32);
  }

  let newlySeveredLeftLeg = false;
  let newlySeveredRightLeg = false;

  // Apply GHOUL Dismemberment & Evisceration Events
  for (const dism of report.dismembermentEvents) {
    target.zoneGoreMode[dism.zone] = dism.goreMode;
    target.zoneIntegrity[dism.zone] = 0;

    // EVISCERATED rips open the stomach cavity WITHOUT severing spine constraints!
    if (dism.goreMode === 'EVISCERATED') {
      target.bloodLossRateMlPerSec += 110;
      continue;
    }

    const severCompId = `SEVERED_${dism.zone}`;
    target.severedZones.add(dism.zone);

    // Realistic arterial hemorrhage by amputation level (keeps downed amputees alive in shock for ~15-35s!)
    if (dism.zone === 'HAND_LEFT' || dism.zone === 'HAND_RIGHT' || dism.zone === 'FOOT_LEFT' || dism.zone === 'FOOT_RIGHT') {
      target.bloodLossRateMlPerSec += 16;
    } else if (
      dism.zone === 'FOREARM_LEFT' ||
      dism.zone === 'FOREARM_RIGHT' ||
      dism.zone === 'KNEE_LEFT' ||
      dism.zone === 'KNEE_RIGHT' ||
      dism.zone === 'SHIN_LEFT' ||
      dism.zone === 'SHIN_RIGHT'
    ) {
      target.bloodLossRateMlPerSec += 26;
    } else if (dism.zone === 'UPPER_ARM_LEFT' || dism.zone === 'UPPER_ARM_RIGHT') {
      target.bloodLossRateMlPerSec += 38;
    } else if (dism.zone === 'THIGH_LEFT' || dism.zone === 'THIGH_RIGHT') {
      target.bloodLossRateMlPerSec += 58;
    }

    const rootBone = target.ragdollBones[dism.zone];
    if (rootBone) {
      rootBone.severed = true;
      rootBone.goreMode = dism.goreMode;
      rootBone.componentId = severCompId;
      rootBone.prevPosition = copyVec3(rootBone.position);
      rootBone.velocity = copyVec3(dism.severedLimbVelocity);
    }

    for (const child of dism.detachedSubtree) {
      target.severedZones.add(child);
      target.zoneIntegrity[child] = 0;
      const childBone = target.ragdollBones[child];
      if (childBone) {
        childBone.severed = true;
        if (dism.goreMode === 'CRANIAL_POP') {
          childBone.goreMode = 'CRANIAL_POP';
        }
        childBone.componentId = severCompId;
        childBone.prevPosition = copyVec3(childBone.position);
        const offset = sub(childBone.position, rootBone.position);
        const rotVel = cross(dism.severedLimbAngularVelocity, offset);
        childBone.velocity = add(dism.severedLimbVelocity, scale(rotVel, 0.35));
      }
    }

    // Also move any auxiliary tip particles attached to the detached subtree into severCompId!
    for (const auxId of ALL_AUX_PARTICLES) {
      const aux = target.auxParticles[auxId];
      if (dism.detachedSubtree.includes(aux.parentZone)) {
        aux.componentId = severCompId;
        aux.prevPosition = copyVec3(aux.position);
        const offset = sub(aux.position, rootBone.position);
        const rotVel = cross(dism.severedLimbAngularVelocity, offset);
        aux.velocity = add(dism.severedLimbVelocity, scale(rotVel, 0.35));
      }
    }

    if (
      dism.zone === 'THIGH_LEFT' ||
      dism.zone === 'KNEE_LEFT' ||
      dism.zone === 'SHIN_LEFT' ||
      dism.zone === 'FOOT_LEFT'
    ) {
      target.leftLegFunctional = false;
      newlySeveredLeftLeg = true;
    }
    if (
      dism.zone === 'THIGH_RIGHT' ||
      dism.zone === 'KNEE_RIGHT' ||
      dism.zone === 'SHIN_RIGHT' ||
      dism.zone === 'FOOT_RIGHT'
    ) {
      target.rightLegFunctional = false;
      newlySeveredRightLeg = true;
    }
    if (dism.zone === 'UPPER_ARM_LEFT' || dism.zone === 'FOREARM_LEFT' || dism.zone === 'HAND_LEFT') {
      target.leftArmFunctional = false;
    }
    if (dism.zone === 'UPPER_ARM_RIGHT' || dism.zone === 'FOREARM_RIGHT' || dism.zone === 'HAND_RIGHT') {
      target.rightArmFunctional = false;
      target.weaponDropped = true;
    }
  }

  // Trigger Pain Flinch / One-Legged Stagger / Agony Posture if target survived AND was not immediately ragdolled
  const hitZone = report.ragdollPlan.primaryHitZone;
  if (!report.ragdollPlan.willEnableRagdoll && target.alive && hitZone) {
    // Physical boot-skid pushback when surviving a heavy close-range blast (e.g. Kevlar Heavy Enforcer!)
    const imp = report.ragdollPlan.netRootImpulseWorld;
    const hImpMag = length(vec3(imp.x, 0, imp.z));
    if (hImpMag > 32.0) {
      const pushDist = Math.min(0.55, (hImpMag - 32.0) / 280.0);
      const pushDir = normalize(vec3(imp.x, 0, imp.z));
      const shift = scale(pushDir, pushDist);
      target.worldPosition = add(target.worldPosition, shift);
      target.worldPosition.x = Math.max(-9.4, Math.min(9.4, target.worldPosition.x));
      for (const z of ALL_GHOUL_ZONES) {
        const b = target.ragdollBones[z];
        if (!b.severed) {
          b.position = add(b.position, shift);
          b.prevPosition = copyVec3(b.position);
        }
      }
      for (const aId of ALL_AUX_PARTICLES) {
        const a = target.auxParticles[aId];
        if (a.componentId === 'BODY') {
          a.position = add(a.position, shift);
          a.prevPosition = copyVec3(a.position);
        }
      }
    }

    let rxType: PainReactionType = 'CHEST_STAGGER';
    let rxDurationS = 0.65;

    if (!target.leftLegFunctional || !target.rightLegFunctional) {
      // Any disabled/shot/severed leg triggers a brief stumble (~0.46s-0.68s) before going down ALIVE!
      rxType = !target.leftLegFunctional ? 'LEG_BUCKLE_LEFT' : 'LEG_BUCKLE_RIGHT';
      rxDurationS = newlySeveredLeftLeg || newlySeveredRightLeg ? 0.68 : 0.46;
      target.posture = 'LEG_BUCKLED';
      target.weaponDropped = true;
    } else if (hitZone === 'NECK_CERVICAL') {
      rxType = 'THROAT_CLUTCH';
      target.posture = 'THROAT_CLUTCH';
      target.weaponDropped = true;
    } else if (hitZone === 'TORSO_LOWER_ABDOMEN') {
      rxType = 'GUT_FOLD';
      target.posture = 'GUT_HURT';
    } else if (hitZone === 'HEAD_CRANIUM' || hitZone === 'HEAD_FACE_JAW') {
      rxType = 'HEAD_SNAP';
      target.posture = 'STAGGERED';
    } else if (
      hitZone === 'SHOULDER_LEFT' ||
      hitZone === 'UPPER_ARM_LEFT' ||
      hitZone === 'FOREARM_LEFT' ||
      hitZone === 'HAND_LEFT'
    ) {
      rxType = 'ARM_WRENCH_LEFT';
    } else if (
      hitZone === 'SHOULDER_RIGHT' ||
      hitZone === 'UPPER_ARM_RIGHT' ||
      hitZone === 'FOREARM_RIGHT' ||
      hitZone === 'HAND_RIGHT'
    ) {
      rxType = 'ARM_WRENCH_RIGHT';
      if (target.weaponDropped) target.posture = 'DISARMED';
    }

    target.activeReaction = {
      type: rxType,
      timerS: 0,
      durationS: rxDurationS,
      intensity: Math.min(1.3, 0.60 + report.totalEnergyDepositedJ / 450),
      hitDirectionWorld: copyVec3(report.aimDirectionWorld),
    };
  }

  // ---------------------------------------------------------------------------
  // Activate or Impulse Cohesive Rigid-Skeleton 82 kg PBD Ragdoll Physics!
  // ---------------------------------------------------------------------------
  if (report.ragdollPlan.willEnableRagdoll) {
    target.isRagdollActive = true;
    target.weaponDropped = true;
    target.posture = 'AIRBORNE_RAGDOLL';

    // CRITICAL FIX: Eliminate frame-0 pose-to-ragdoll PBD constraint snap explosion!
    if (!wasAlreadyRagdoll) {
      stabilizeRagdollPoseForTransition(target, 0.0);
    }

    const bodyMassKg = 82.0;
    const impulse = report.ragdollPlan.netRootImpulseWorld;
    const liftY = wasAlreadyRagdoll
      ? Math.min(0.32, report.ragdollPlan.launchLiftVelocityMs * 0.4)
      : report.ragdollPlan.launchLiftVelocityMs;

    const isStomachHit = hitZone === 'TORSO_LOWER_ABDOMEN';
    const horizImp = vec3(impulse.x, 0, impulse.z);
    const horizImpMag = length(horizImp);
    const horizDir =
      horizImpMag > 1e-3
        ? scale(horizImp, 1 / horizImpMag)
        : normalize(vec3(report.aimDirectionWorld.x, 0, report.aimDirectionWorld.z));

    const targetHorizSpeed = Math.min(5.6, horizImpMag / bodyMassKg);

    const baseVel = vec3(
      horizDir.x * targetHorizSpeed,
      Math.max(-0.4, Math.min(1.25, impulse.y / bodyMassKg + liftY)),
      horizDir.z * targetHorizSpeed
    );

    if (!wasAlreadyRagdoll) {
      target.ragdollRootVelocity = copyVec3(baseVel);
    } else {
      target.ragdollRootVelocity = add(target.ragdollRootVelocity, scale(baseVel, 0.55));
    }

    target.ragdollAngularVelocity = scale(report.ragdollPlan.netTorqueWorld, 1 / 65.0);

    const facingFwd = vec3(Math.sin(target.yawRad), 0, Math.cos(target.yawRad));
    const isLowImpulseCollapse = !wasAlreadyRagdoll && targetHorizSpeed < 1.0;

    for (const z of ALL_GHOUL_ZONES) {
      const bone = target.ragdollBones[z];
      if (bone.componentId !== 'BODY') continue;

      const isExtremity =
        z === 'HAND_LEFT' ||
        z === 'HAND_RIGHT' ||
        z === 'FOOT_LEFT' ||
        z === 'FOOT_RIGHT' ||
        z === 'SHIN_LEFT' ||
        z === 'SHIN_RIGHT';
      const isMidsection =
        z === 'TORSO_LOWER_ABDOMEN' || z === 'PELVIS_GROIN' || z === 'TORSO_UPPER_THORAX';

      let weight = 0.96;
      if (isStomachHit && targetHorizSpeed > 0.8) {
        if (z === 'TORSO_LOWER_ABDOMEN') weight = 1.28;
        else if (z === 'PELVIS_GROIN') weight = 1.15;
        else if (z === 'TORSO_UPPER_THORAX') weight = 1.04;
        else if (isExtremity) weight = 0.62;
      } else if (isExtremity) {
        weight = 0.72;
      } else if (isMidsection) {
        weight = 1.04;
      }

      const zImp = report.ragdollPlan.zoneImpulses[z];
      const rawKick = zImp ? scale(zImp, 1 / (bone.massKg * 3.2 + 12.0)) : vec3(0, 0, 0);
      const kickMag = length(rawKick);
      const localKick = kickMag > 2.6 ? scale(rawKick, 2.6 / kickMag) : rawKick;

      let nextVel = !wasAlreadyRagdoll
        ? add(scale(baseVel, weight), localKick)
        : add(bone.velocity, add(scale(baseVel, weight * 0.45), localKick));

      if (isLowImpulseCollapse && (z === 'KNEE_LEFT' || z === 'KNEE_RIGHT')) {
        nextVel = add(nextVel, add(scale(facingFwd, 0.85), vec3(0, -0.35, 0)));
      } else if (isLowImpulseCollapse && z === 'PELVIS_GROIN') {
        nextVel = add(nextVel, vec3(0, -0.45, 0));
      }

      bone.velocity = nextVel;
    }

    for (const auxId of ALL_AUX_PARTICLES) {
      const aux = target.auxParticles[auxId];
      if (aux.componentId !== 'BODY') continue;
      const parentVel = target.ragdollBones[aux.parentZone].velocity;
      aux.velocity = scale(parentVel, 0.90);
    }
  }
}

interface RagdollParticleRef {
  position: Vec3Like;
  prevPosition: Vec3Like;
  velocity: Vec3Like;
  massKg: number;
  radiusM: number;
  componentId: string;
  grounded?: boolean;
  active: boolean;
}

function getRagdollParticleRef(
  target: TargetHealthState,
  id: GhoulZoneId | AuxParticleId
): RagdollParticleRef {
  if (id in target.ragdollBones) {
    const b = target.ragdollBones[id as GhoulZoneId];
    const active =
      (target.isRagdollActive || b.componentId !== 'BODY') && b.goreMode !== 'CRANIAL_POP';
    return {
      position: b.position,
      prevPosition: b.prevPosition,
      velocity: b.velocity,
      massKg: b.massKg,
      radiusM: b.radiusM,
      componentId: b.componentId,
      grounded: b.grounded,
      active,
    };
  }
  const a = target.auxParticles[id as AuxParticleId];
  const parentBone = target.ragdollBones[a.parentZone];
  const active =
    (target.isRagdollActive || a.componentId !== 'BODY') &&
    parentBone.goreMode !== 'CRANIAL_POP';
  return {
    position: a.position,
    prevPosition: a.prevPosition,
    velocity: a.velocity,
    massKg: a.massKg,
    radiusM: a.radiusM,
    componentId: a.componentId,
    active,
  };
}

/**
 * Single PBD projection pass enforcing exact skeletal bone lengths, seated shoulder/hip sockets,
 * torso anti-twist/anti-fold rigidity, jaw alignment, knee anti-hyperextension, arm-vs-chest
 * self-collision pushout, and concrete floor/barrier bounds.
 */
function projectConstraintsAndAnatomyOnce(target: TargetHealthState, floorY: number): void {
  for (const c of target.ragdollConstraints) {
    const pA = getRagdollParticleRef(target, c.nodeA);
    const pB = getRagdollParticleRef(target, c.nodeB);
    if (!pA.active && !pB.active) continue;
    if (pA.componentId !== pB.componentId) continue;

    const delta = sub(pB.position, pA.position);
    const dist = length(delta);
    if (dist < 1e-6) continue;

    let targetDist = dist;
    if (dist < c.minLength) targetDist = c.minLength;
    else if (dist > c.maxLength) targetDist = c.maxLength;
    else continue;

    const wA = pA.active ? 1 / pA.massKg : 0;
    const wB = pB.active ? 1 / pB.massKg : 0;
    const wSum = wA + wB;
    if (wSum < 1e-8) continue;

    const diff = (dist - targetDist) / dist;
    const corr = scale(delta, (diff * c.stiffness) / wSum);

    if (pA.active) {
      pA.position.x += corr.x * wA;
      pA.position.y += corr.y * wA;
      pA.position.z += corr.z * wA;
    }
    if (pB.active) {
      pB.position.x -= corr.x * wB;
      pB.position.y -= corr.y * wB;
      pB.position.z -= corr.z * wB;
    }
  }

  if (target.isRagdollActive) {
    const pelvis = target.ragdollBones.PELVIS_GROIN;
    const abdomen = target.ragdollBones.TORSO_LOWER_ABDOMEN;
    const thorax = target.ragdollBones.TORSO_UPPER_THORAX;
    const shL = target.ragdollBones.SHOULDER_LEFT;
    const shR = target.ragdollBones.SHOULDER_RIGHT;
    const tL = target.ragdollBones.THIGH_LEFT;
    const tR = target.ragdollBones.THIGH_RIGHT;

    // 1. Torso Axial Anti-Twist Guard: keep shoulders aligned with hips within physiological spine twist (< ~42 deg)
    if (
      pelvis.componentId === 'BODY' &&
      abdomen.componentId === 'BODY' &&
      thorax.componentId === 'BODY' &&
      shL.componentId === 'BODY' &&
      shR.componentId === 'BODY' &&
      tL.componentId === 'BODY' &&
      tR.componentId === 'BODY'
    ) {
      const spineAxis = normalize(sub(thorax.position, pelvis.position));
      const hipVec = sub(tR.position, tL.position);
      const hipOrtho = sub(hipVec, scale(spineAxis, dot(hipVec, spineAxis)));
      const shVec = sub(shR.position, shL.position);
      const shOrtho = sub(shVec, scale(spineAxis, dot(shVec, spineAxis)));

      const hipLen = length(hipOrtho);
      const shLen = length(shOrtho);
      if (hipLen > 0.08 && shLen > 0.12) {
        const hipDir = scale(hipOrtho, 1 / hipLen);
        const shDir = scale(shOrtho, 1 / shLen);
        if (dot(hipDir, shDir) < 0.72) {
          const targetDir = normalize(add(shDir, scale(hipDir, 0.85)));
          const halfSpan = shLen * 0.5;
          const midSh = scale(add(shL.position, shR.position), 0.5);
          const desL = add(midSh, scale(targetDir, -halfSpan));
          const desR = add(midSh, scale(targetDir, halfSpan));
          shL.position = add(scale(shL.position, 0.55), scale(desL, 0.45));
          shR.position = add(scale(shR.position, 0.55), scale(desR, 0.45));
        }
      }
    }

    // 2. Head / Jaw Anti-Spin Guard: keep jaw pointing forward relative to upper thorax
    const cranium = target.ragdollBones.HEAD_CRANIUM;
    const jaw = target.ragdollBones.HEAD_FACE_JAW;
    if (
      cranium.componentId === 'BODY' &&
      jaw.componentId === 'BODY' &&
      cranium.goreMode !== 'CRANIAL_POP' &&
      shL.componentId === 'BODY' &&
      shR.componentId === 'BODY'
    ) {
      const shRight = normalize(sub(shR.position, shL.position));
      const spUp = normalize(sub(thorax.position, abdomen.position));
      const thoraxFwd = normalize(cross(shRight, spUp));
      if (length(thoraxFwd) > 0.5) {
        const jawRel = sub(jaw.position, cranium.position);
        const jawLen = length(jawRel);
        if (jawLen > 0.04) {
          const jawDir = scale(jawRel, 1 / jawLen);
          if (dot(jawDir, thoraxFwd) < 0.35) {
            const clampedDir = normalize(add(jawDir, scale(thoraxFwd, 0.75)));
            const desJaw = add(cranium.position, scale(clampedDir, jawLen));
            jaw.position = add(scale(jaw.position, 0.5), scale(desJaw, 0.5));
          }
        }
      }
    }

    // 3. Anatomical Knee Anti-Hyperextension Check
    if (
      tL.componentId === pelvis.componentId &&
      tR.componentId === pelvis.componentId &&
      abdomen.componentId === pelvis.componentId
    ) {
      const pUp = normalize(sub(abdomen.position, pelvis.position));
      const pRight = sub(tR.position, tL.position);
      const pFwd = normalize(cross(pRight, pUp));

      if (length(pFwd) > 0.5) {
        for (const side of ['LEFT', 'RIGHT'] as const) {
          const thigh = target.ragdollBones[side === 'LEFT' ? 'THIGH_LEFT' : 'THIGH_RIGHT'];
          const knee = target.ragdollBones[side === 'LEFT' ? 'KNEE_LEFT' : 'KNEE_RIGHT'];
          const shin = target.ragdollBones[side === 'LEFT' ? 'SHIN_LEFT' : 'SHIN_RIGHT'];
          if (
            knee.componentId === thigh.componentId &&
            shin.componentId === knee.componentId
          ) {
            const mid = scale(add(thigh.position, shin.position), 0.5);
            const kneeOffset = sub(knee.position, mid);
            const fwdProj = dot(kneeOffset, pFwd);
            if (fwdProj < -0.01) {
              const push = scale(pFwd, (-0.01 - fwdProj) * 0.70);
              knee.position.x += push.x;
              knee.position.y += push.y;
              knee.position.z += push.z;
            }
          }
        }
      }
    }

    // 4. Forearm & Hand vs Torso Self-Collision Pushout (prevents arms collapsing inside ribcage/gut!)
    if (pelvis.componentId === 'BODY' && thorax.componentId === 'BODY') {
      const seg = sub(thorax.position, pelvis.position);
      const segLenSq = lengthSq(seg);
      if (segLenSq > 1e-4) {
        const armZones: GhoulZoneId[] = [
          'FOREARM_LEFT',
          'HAND_LEFT',
          'FOREARM_RIGHT',
          'HAND_RIGHT',
        ];
        const minChestClearanceM = 0.155;
        for (const az of armZones) {
          const armBone = target.ragdollBones[az];
          if (armBone.componentId !== 'BODY') continue;
          const tProj = Math.max(
            0,
            Math.min(1, dot(sub(armBone.position, pelvis.position), seg) / segLenSq)
          );
          const closestOnSpine = add(pelvis.position, scale(seg, tProj));
          const radial = sub(armBone.position, closestOnSpine);
          const rDist = length(radial);
          if (rDist > 1e-5 && rDist < minChestClearanceM) {
            const pushOut = scale(radial, ((minChestClearanceM - rDist) / rDist) * 0.65);
            armBone.position = add(armBone.position, pushOut);
          }
        }
      }
    }
  }

  // 5. Floor & Range Barrier Collision Projection
  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    const active =
      (target.isRagdollActive || b.componentId !== 'BODY') && b.goreMode !== 'CRANIAL_POP';
    if (!active) continue;

    const minFloor = floorY + b.radiusM;
    if (b.position.y < minFloor) {
      b.position.y = minFloor;
    }
    if (b.position.x < -9.7) b.position.x = -9.7;
    if (b.position.x > 9.7) b.position.x = 9.7;
  }

  for (const aId of ALL_AUX_PARTICLES) {
    const a = target.auxParticles[aId];
    if (!target.isRagdollActive && a.componentId === 'BODY') continue;
    const minFloor = floorY + a.radiusM;
    if (a.position.y < minFloor) {
      a.position.y = minFloor;
    }
  }
}

/**
 * Projects procedural standing/kneeling/wounded pose onto exact PBD rest manifolds and zeroes
 * synthetic position-delta velocity BEFORE activating ragdoll so limbs NEVER explode on frame 0!
 */
function stabilizeRagdollPoseForTransition(target: TargetHealthState, floorY: number): void {
  for (let pass = 0; pass < 10; pass++) {
    projectConstraintsAndAnatomyOnce(target, floorY);
  }
  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    if (b.componentId === 'BODY') {
      b.prevPosition = copyVec3(b.position);
      b.velocity = vec3(0, 0, 0);
    }
  }
  for (const aId of ALL_AUX_PARTICLES) {
    const a = target.auxParticles[aId];
    if (a.componentId === 'BODY') {
      a.prevPosition = copyVec3(a.position);
      a.velocity = vec3(0, 0, 0);
    }
  }
  recomputeRagdollBasisVectors(target);
}

export type CombatantTriageStatus = 'HEALTHY' | 'WOUNDED' | 'MORTALLY_WOUNDED' | 'DEAD';

/**
 * Classifies a combatant's physiological & structural medical triage state:
 * - HEALTHY: Uninjured & combat-ready
 * - WOUNDED: Injured / crippled / downed on ground, but stable enough to survive short-term
 * - MORTALLY_WOUNDED: Critical HP, major arterial/organ hemorrhage, or major amputation — actively dying
 * - DEAD: Deceased (zero muscle tone)
 */
export function computeCombatantTriageStatus(target: TargetHealthState): CombatantTriageStatus {
  if (!target.alive || target.currentHp <= 0) {
    return 'DEAD';
  }

  const hpRatio = target.currentHp / Math.max(1, target.maxHp);
  const hasMajorAmputation =
    target.severedZones.has('THIGH_LEFT') ||
    target.severedZones.has('THIGH_RIGHT') ||
    target.severedZones.has('KNEE_LEFT') ||
    target.severedZones.has('KNEE_RIGHT') ||
    target.severedZones.has('SHIN_LEFT') ||
    target.severedZones.has('SHIN_RIGHT') ||
    target.severedZones.has('UPPER_ARM_LEFT') ||
    target.severedZones.has('UPPER_ARM_RIGHT');

  if (
    hpRatio <= 0.32 ||
    target.bloodVolumeMl <= 3550 ||
    target.bloodLossRateMlPerSec >= 24 ||
    target.rupturedOrgans.size > 0 ||
    hasMajorAmputation
  ) {
    return 'MORTALLY_WOUNDED';
  }

  const isAnyWound =
    hpRatio < 0.98 ||
    target.bloodLossRateMlPerSec > 0.5 ||
    target.severedZones.size > 0 ||
    target.fracturedBones.size > 0 ||
    !target.leftLegFunctional ||
    !target.rightLegFunctional ||
    !target.leftArmFunctional ||
    !target.rightArmFunctional ||
    target.surfaceWounds.some((sw) => !sw.armorDent);

  return isAnyWound ? 'WOUNDED' : 'HEALTHY';
}

const livingGroundAgonyClock = new WeakMap<TargetHealthState, number>();

/**
 * Builds Active Ragdoll Muscle-Tone target positions for a LIVING downed combatant on the ground!
 * Instead of collapsing flat like a dead sandbag, a living leg-shot human sits/props their upper body
 * upright (~45 deg), plants one hand on the concrete behind their hip, bends their intact leg, and
 * reaches their other hand forward to clutch their wounded leg while rocking/breathing in pain!
 */
function buildLivingGroundedPoseTargets(
  target: TargetHealthState,
  floorY: number,
  agonyTimeS: number
): Partial<Record<GhoulZoneId, Vec3Like>> | null {
  if (!target.alive || !target.isRagdollActive) return null;

  const pelvis = target.ragdollBones.PELVIS_GROIN;
  if (pelvis.componentId !== 'BODY' || pelvis.position.y > floorY + 0.44) {
    return null;
  }

  const cosY = Math.cos(target.yawRad);
  const sinY = Math.sin(target.yawRad);
  const rightW = vec3(cosY, 0, -sinY);
  const fwdW = vec3(sinY, 0, cosY);

  const leftHurt = !target.leftLegFunctional;
  const rightHurt = !target.rightLegFunctional;
  const leanSide = leftHurt && !rightHurt ? 0.16 : rightHurt && !leftHurt ? -0.16 : 0;
  const rock = Math.sin(agonyTimeS * 2.8) * 0.05;

  const anchorP = vec3(pelvis.position.x, floorY + pelvis.radiusM + 0.015, pelvis.position.z);
  const spineDir = normalize(
    vec3(
      -fwdW.x * (0.62 - rock) + rightW.x * leanSide,
      0.77 + rock * 0.3,
      -fwdW.z * (0.62 - rock) + rightW.z * leanSide
    )
  );

  const abdomenPos = add(anchorP, scale(spineDir, 0.17));
  const thoraxPos = add(anchorP, scale(spineDir, 0.37));
  const neckPos = add(anchorP, scale(spineDir, 0.59));
  const headLookDir = normalize(vec3(fwdW.x * 0.34, 0.94, fwdW.z * 0.34));
  const headPos = add(neckPos, scale(headLookDir, 0.15));
  const jawPos = add(headPos, add(scale(fwdW, 0.085), vec3(0, -0.045, 0)));

  const shLeftPos = add(add(thoraxPos, scale(spineDir, 0.09)), scale(rightW, -0.19));
  const shRightPos = add(add(thoraxPos, scale(spineDir, 0.09)), scale(rightW, 0.19));

  const targets: Partial<Record<GhoulZoneId, Vec3Like>> = {
    TORSO_LOWER_ABDOMEN: abdomenPos,
    TORSO_UPPER_THORAX: thoraxPos,
    SHOULDER_LEFT: shLeftPos,
    SHOULDER_RIGHT: shRightPos,
    NECK_CERVICAL: neckPos,
    HEAD_CRANIUM: headPos,
    HEAD_FACE_JAW: jawPos,
  };

  // Support arm plants palm on concrete behind hip; other arm clutches the shot leg!
  const clutchLeftLeg = leftHurt || (!leftHurt && !rightHurt);
  const tremor = Math.sin(agonyTimeS * 5.8) * 0.018;

  if (clutchLeftLeg) {
    if (target.rightArmFunctional && target.ragdollBones.HAND_RIGHT.componentId === 'BODY') {
      targets.HAND_RIGHT = add(
        add(vec3(anchorP.x, floorY + 0.045, anchorP.z), scale(fwdW, -0.20)),
        scale(rightW, 0.30)
      );
    }
    if (target.leftArmFunctional && target.ragdollBones.HAND_LEFT.componentId === 'BODY') {
      const woundFocus =
        target.ragdollBones.KNEE_LEFT.componentId === 'BODY'
          ? scale(
              add(target.ragdollBones.THIGH_LEFT.position, target.ragdollBones.KNEE_LEFT.position),
              0.5
            )
          : target.ragdollBones.THIGH_LEFT.position;
      targets.HAND_LEFT = add(woundFocus, vec3(0, 0.075 + tremor, 0));
    }
  } else {
    if (target.leftArmFunctional && target.ragdollBones.HAND_LEFT.componentId === 'BODY') {
      targets.HAND_LEFT = add(
        add(vec3(anchorP.x, floorY + 0.045, anchorP.z), scale(fwdW, -0.20)),
        scale(rightW, -0.30)
      );
    }
    if (target.rightArmFunctional && target.ragdollBones.HAND_RIGHT.componentId === 'BODY') {
      const woundFocus =
        target.ragdollBones.KNEE_RIGHT.componentId === 'BODY'
          ? scale(
              add(target.ragdollBones.THIGH_RIGHT.position, target.ragdollBones.KNEE_RIGHT.position),
              0.5
            )
          : target.ragdollBones.THIGH_RIGHT.position;
      targets.HAND_RIGHT = add(woundFocus, vec3(0, 0.075 + tremor, 0));
    }
  }

  // Intact leg draws up into a protective bent-knee ground brace; injured leg lies out!
  if (target.rightLegFunctional && target.ragdollBones.KNEE_RIGHT.componentId === 'BODY') {
    targets.KNEE_RIGHT = add(
      add(vec3(anchorP.x, floorY + 0.25, anchorP.z), scale(fwdW, 0.30)),
      scale(rightW, 0.14)
    );
    targets.FOOT_RIGHT = add(
      add(vec3(anchorP.x, floorY + 0.065, anchorP.z), scale(fwdW, 0.64)),
      scale(rightW, 0.15)
    );
  }
  if (target.leftLegFunctional && target.ragdollBones.KNEE_LEFT.componentId === 'BODY') {
    targets.KNEE_LEFT = add(
      add(vec3(anchorP.x, floorY + 0.25, anchorP.z), scale(fwdW, 0.30)),
      scale(rightW, -0.14)
    );
    targets.FOOT_LEFT = add(
      add(vec3(anchorP.x, floorY + 0.065, anchorP.z), scale(fwdW, 0.64)),
      scale(rightW, -0.15)
    );
  }

  return targets;
}

/**
 * Steps ongoing physiological bleedout, leg-shot stumble-to-ground transitions, active-ragdoll
 * living ground muscle tone, AND the rigid-skeleton 27-particle PBD 3D Ragdoll Physics solver!
 */
export function stepRagdollPhysics(
  target: TargetHealthState,
  dt: number,
  floorY = 0.0
): void {
  if (dt <= 0) return;

  // 1. Tick Physiological Hemorrhage, Leg-Disable Fall & Pain Reactions on living combatants
  if (target.alive) {
    if (target.bloodLossRateMlPerSec > 0) {
      target.bloodVolumeMl = Math.max(0, target.bloodVolumeMl - target.bloodLossRateMlPerSec * dt);
      const bloodRatio = target.bloodVolumeMl / 5000;
      target.systolicBpMmHg = Math.max(0, Math.round(120 * Math.pow(bloodRatio, 1.35)));
      target.consciousness = Math.max(0.2, Math.min(1.0, (target.bloodVolumeMl - 2500) / 2200));
      target.currentHp = Math.max(0, target.currentHp - (target.bloodLossRateMlPerSec * 0.16) * dt);

      // Fatal hypovolemic shock (< 2,500 mL blood or HP depleted) -> instant loss of all muscle tone!
      if (target.bloodVolumeMl <= 2500 || target.currentHp <= 0) {
        target.alive = false;
        target.consciousness = 0;
        target.heartRateBpm = 0;
        target.systolicBpMmHg = 0;
        target.weaponDropped = true;
        if (!target.isRagdollActive) {
          target.isRagdollActive = true;
          target.posture = 'AIRBORNE_RAGDOLL';
          stabilizeRagdollPoseForTransition(target, floorY);
          const slump = vec3(
            (Math.random() - 0.5) * 0.5,
            0,
            Math.cos(target.yawRad) * 0.75
          );
          target.ragdollBones.TORSO_UPPER_THORAX.velocity = slump;
          target.ragdollBones.HEAD_CRANIUM.velocity = scale(slump, 1.2);
        }
      }
    }

    if (target.alive && target.activeReaction.type !== 'NONE') {
      target.activeReaction.timerS += dt;
      if (target.activeReaction.timerS >= target.activeReaction.durationS) {
        target.activeReaction.type = 'NONE';
      }
    }

    // Any living combatant with a shot/fractured/severed leg goes DOWN onto the ground once the brief stumble ends!
    if (
      target.alive &&
      (!target.leftLegFunctional || !target.rightLegFunctional) &&
      !target.isRagdollActive &&
      target.activeReaction.type === 'NONE'
    ) {
      target.isRagdollActive = true;
      target.weaponDropped = true;
      target.posture = 'AIRBORNE_RAGDOLL';
      stabilizeRagdollPoseForTransition(target, floorY);

      const cosY = Math.cos(target.yawRad);
      const sinY = Math.sin(target.yawRad);
      const sideSign = !target.leftLegFunctional ? -1.0 : 1.0;
      const sideWorld = vec3(cosY * sideSign, 0, -sinY * sideSign);
      const fwdWorld = vec3(sinY, 0, cosY);
      // Controlled sit/drop onto hip rather than a limp corpse faceplant!
      const dropVel = add(scale(sideWorld, 0.55), add(scale(fwdWorld, -0.35), vec3(0, -1.1, 0)));

      for (const z of ALL_GHOUL_ZONES) {
        const b = target.ragdollBones[z];
        if (b.componentId === 'BODY') {
          b.velocity = copyVec3(dropVel);
        }
      }
      for (const aId of ALL_AUX_PARTICLES) {
        const a = target.auxParticles[aId];
        if (a.componentId === 'BODY') {
          a.velocity = copyVec3(dropVel);
        }
      }
    }

    target.painShock = Math.max(0, target.painShock - dt * 0.55);
  }

  const hasSeveredLimbs = target.severedZones.size > 0;
  if (!target.isRagdollActive && !hasSeveredLimbs) {
    return;
  }

  // Advance living ground agony clock for breathing & wound-clutching active ragdoll motion
  let agonyClock = livingGroundAgonyClock.get(target) || 0;
  if (target.alive && target.isRagdollActive) {
    agonyClock += dt;
    livingGroundAgonyClock.set(target, agonyClock);
  }

  // 2. Sub-stepped Rigid-Skeleton Position-Based Dynamics (PBD) Ragdoll Solver
  const gravity = -9.81;
  const subSteps = Math.max(2, Math.min(8, Math.ceil(dt / 0.004)));
  const h = dt / subSteps;
  const constraintIterations = 14;
  const jointViscosityAlpha = 1 - Math.exp(-7.0 * h);

  const muscleTone = target.alive
    ? Math.max(0.22, target.consciousness * (1.0 - 0.55 * target.painShock))
    : 0.0;

  for (let step = 0; step < subSteps; step++) {
    const activePoseTargets =
      muscleTone > 0.01 ? buildLivingGroundedPoseTargets(target, floorY, agonyClock) : null;

    // A. Symplectic Euler Prediction Step (+ Active Ragdoll Muscle Tone when ALIVE on ground!)
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      const active =
        (target.isRagdollActive || b.componentId !== 'BODY') && b.goreMode !== 'CRANIAL_POP';
      if (!active) continue;

      b.prevPosition = copyVec3(b.position);
      b.velocity.y += gravity * h;

      if (activePoseTargets && b.componentId === 'BODY') {
        const desiredPos = activePoseTargets[z];
        if (desiredPos) {
          // Postural anti-gravity + critically-damped PD muscle spring keeps living human propped up & clutching wound!
          b.velocity.y += -gravity * muscleTone * h;
          const posErr = sub(desiredPos, b.position);
          let pdAx = posErr.x * 42.0 * muscleTone - b.velocity.x * 8.5 * muscleTone;
          let pdAy = posErr.y * 42.0 * muscleTone - b.velocity.y * 8.5 * muscleTone;
          let pdAz = posErr.z * 42.0 * muscleTone - b.velocity.z * 8.5 * muscleTone;
          const aMag = Math.sqrt(pdAx * pdAx + pdAy * pdAy + pdAz * pdAz);
          if (aMag > 28.0) {
            const s = 28.0 / aMag;
            pdAx *= s;
            pdAy *= s;
            pdAz *= s;
          }
          b.velocity.x += pdAx * h;
          b.velocity.y += pdAy * h;
          b.velocity.z += pdAz * h;
        }
      }

      const airDamp = Math.exp(-0.45 * h);
      b.velocity.x *= airDamp;
      b.velocity.z *= airDamp;

      b.position = add(b.position, scale(b.velocity, h));
    }

    for (const aId of ALL_AUX_PARTICLES) {
      const a = target.auxParticles[aId];
      const parentBone = target.ragdollBones[a.parentZone];
      const active =
        (target.isRagdollActive || a.componentId !== 'BODY') &&
        parentBone.goreMode !== 'CRANIAL_POP';
      if (!active) continue;

      a.prevPosition = copyVec3(a.position);
      a.velocity.y += gravity * h;
      if (activePoseTargets && a.componentId === 'BODY' && aId === 'HEAD_TOP') {
        a.velocity.y += -gravity * muscleTone * h;
      }
      const airDamp = Math.exp(-0.45 * h);
      a.velocity.x *= airDamp;
      a.velocity.z *= airDamp;

      a.position = add(a.position, scale(a.velocity, h));
    }

    // B. Iterative PBD Distance, Seated Socket, Anti-Twist & Self-Collision Constraints
    for (let iter = 0; iter < constraintIterations; iter++) {
      projectConstraintsAndAnatomyOnce(target, floorY);
    }

    // C. PBD Velocity Update + Ground Friction & Bounce Restitution
    let groundedCount = 0;
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      const active =
        (target.isRagdollActive || b.componentId !== 'BODY') && b.goreMode !== 'CRANIAL_POP';
      if (!active) continue;

      const preImpactVy = b.velocity.y;
      const newVel = scale(sub(b.position, b.prevPosition), 1 / h);

      const minFloor = floorY + b.radiusM;
      if (b.position.y <= minFloor + 0.004) {
        b.grounded = true;
        if (b.componentId === 'BODY') groundedCount++;

        const slideFriction = Math.exp(-7.2 * h);
        newVel.x *= slideFriction;
        newVel.z *= slideFriction;

        if (preImpactVy < -1.8) {
          newVel.y = Math.max(newVel.y, -preImpactVy * 0.16);
        }

        if (!target.alive && length(newVel) < 0.06) {
          newVel.x = 0;
          newVel.y = 0;
          newVel.z = 0;
          b.position.x = b.prevPosition.x;
          b.position.z = b.prevPosition.z;
        }
      } else {
        b.grounded = false;
      }

      b.velocity = newVel;
    }

    for (const aId of ALL_AUX_PARTICLES) {
      const a = target.auxParticles[aId];
      const parentBone = target.ragdollBones[a.parentZone];
      const active =
        (target.isRagdollActive || a.componentId !== 'BODY') &&
        parentBone.goreMode !== 'CRANIAL_POP';
      if (!active) continue;

      const newVel = scale(sub(a.position, a.prevPosition), 1 / h);
      if (a.position.y <= floorY + a.radiusM + 0.004) {
        const slideFriction = Math.exp(-8.5 * h);
        newVel.x *= slideFriction;
        newVel.z *= slideFriction;
        if (length(newVel) < 0.06) {
          newVel.x = 0;
          newVel.y = 0;
          newVel.z = 0;
        }
      }
      a.velocity = newVel;
    }

    // D. Momentum-Conserving Passive Joint Viscosity:
    // Damps internal spaghetti limb flailing toward each rigid bone link's center-of-mass velocity,
    // preserving 100% of whole-body fall & shotgun knockback momentum!
    for (const c of target.ragdollConstraints) {
      if (c.maxLength - c.minLength > 0.005) continue;
      const pA = getRagdollParticleRef(target, c.nodeA);
      const pB = getRagdollParticleRef(target, c.nodeB);
      if (!pA.active || !pB.active || pA.componentId !== pB.componentId) continue;

      const totalM = pA.massKg + pB.massKg;
      if (totalM < 1e-6) continue;
      const vCm = scale(
        add(scale(pA.velocity, pA.massKg), scale(pB.velocity, pB.massKg)),
        1 / totalM
      );
      pA.velocity.x += (vCm.x - pA.velocity.x) * jointViscosityAlpha;
      pA.velocity.y += (vCm.y - pA.velocity.y) * jointViscosityAlpha;
      pA.velocity.z += (vCm.z - pA.velocity.z) * jointViscosityAlpha;
      pB.velocity.x += (vCm.x - pB.velocity.x) * jointViscosityAlpha;
      pB.velocity.y += (vCm.y - pB.velocity.y) * jointViscosityAlpha;
      pB.velocity.z += (vCm.z - pB.velocity.z) * jointViscosityAlpha;
    }

    if (target.isRagdollActive) {
      target.posture = groundedCount >= 3 ? 'RAGDOLL_GROUNDED' : 'AIRBORNE_RAGDOLL';
    }
  }

  // 3. Sync Root Position/Velocity & Recompute Exact 3D Orthonormal Bone Bases!
  if (target.isRagdollActive) {
    const pelvis = target.ragdollBones.PELVIS_GROIN;
    target.ragdollRootPosition = copyVec3(pelvis.position);
    target.ragdollRootVelocity = copyVec3(pelvis.velocity);
    target.worldPosition = vec3(
      pelvis.position.x,
      Math.max(floorY, pelvis.position.y - 0.95),
      pelvis.position.z
    );
  }

  recomputeRagdollBasisVectors(target);
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

