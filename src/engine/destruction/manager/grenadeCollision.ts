import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  DestructibleMaterialKind,
  GrenadeSweepStepResult,
  PenetrationRayHit,
} from '../../../contracts/destruction.ts';
import { add, dot, length, normalize, scale, sub } from '../../../core/ballistics/vec3.ts';
import { isWoodWallRayInOpenHole } from './destructionCoverQueries.ts';
import type { DestructionRaycastContext } from './destructionRaycast.ts';

const GRENADE_RAY_BACKOFF_M = 0.06;

function resolveBounceCoefficients(material: DestructibleMaterialKind): {
  normalRestitution: number;
  tangentRetention: number;
} {
  switch (material) {
    case 'GLASS_MARCHING_256':
      return { normalRestitution: 0.38, tangentRetention: 0.75 };
    case 'WOOD_DRYWALL':
    case 'WOOD_STUD':
      return { normalRestitution: 0.36, tangentRetention: 0.72 };
    case 'BRICK_MASONRY':
    case 'CONCRETE_INTACT':
    case 'CONCRETE_CHUNKS':
    case 'STEEL':
    default:
      return { normalRestitution: 0.44, tangentRetention: 0.76 };
  }
}

function orientOutwardNormal(rawNormal: Vec3Like, moveDir: Vec3Like): Vec3Like {
  const n = normalize(rawNormal);
  if (length(n) < 0.5) {
    return scale(moveDir, -1);
  }
  const d = dot(moveDir, n);
  if (Math.abs(d) < 0.02) {
    return scale(moveDir, -1);
  }
  return d < 0 ? n : scale(n, -1);
}

/**
 * Sweeps a live fragmentation grenade across `[prevPos -> desiredPos]` against all
 * destructible and static cover colliders:
 * - Bounces off intact portions of wood, brick, concrete, steel, barrels, and armored glass.
 * - Flies cleanly through breached/destroyed holes in wood, brick, concrete, and glass.
 * - Breaks intact regular glass (`GLASS_VORONOI`) while slowing grenade velocity by 50%.
 * - Visually breaks/crazes armored glass (`GLASS_MARCHING_256`) in-place without shattering
 *   or losing fragments, and bounces the grenade back.
 */
export function resolveGrenadeSweepStep(
  ctx: DestructionRaycastContext,
  prevPos: Vec3Like,
  desiredPos: Vec3Like,
  velocity: Vec3Like,
  grenadeRadiusM = 0.045,
  crossedGlassIds?: Set<string>
): GrenadeSweepStepResult {
  let curPos: Vec3Like = { x: prevPos.x, y: prevPos.y, z: prevPos.z };
  let targetPos: Vec3Like = { x: desiredPos.x, y: desiredPos.y, z: desiredPos.z };
  let curVel: Vec3Like = { x: velocity.x, y: velocity.y, z: velocity.z };
  let bounced = false;
  let brokeGlass = false;
  let crazedArmoredGlass = false;
  let hitMaterial: DestructibleMaterialKind | undefined;

  const listenerPos = ctx.getListenerPos ? ctx.getListenerPos() : { x: 0, y: 1.62, z: 0 };

  for (let pass = 0; pass < 2; pass++) {
    const delta = sub(targetPos, curPos);
    let stepDist = length(delta);
    if (stepDist < 1e-6) break;

    const moveDir = scale(delta, 1 / stepDist);
    const rayOrigin = sub(curPos, scale(moveDir, GRENADE_RAY_BACKOFF_M));
    const maxRayDist = GRENADE_RAY_BACKOFF_M + stepDist + grenadeRadiusM;
    const hits = ctx.rapierWorld.castPenetrationRay(rayOrigin, moveDir, maxRayDist);
    if (hits.length === 0) {
      curPos = targetPos;
      break;
    }

    let solidHit: PenetrationRayHit | null = null;
    let solidDistFromCur = 0;

    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const distFromCur = h.distanceM - GRENADE_RAY_BACKOFF_M;
      if (distFromCur < -grenadeRadiusM * 0.85 || distFromCur > stepDist + grenadeRadiusM) {
        continue;
      }

      const mat = h.surface.material;
      const objId = h.surface.objectId;

      if (objId.startsWith('hazard_barrel_')) {
        if (ctx.barrelManager?.getBarrelByObjectId(objId)?.state === 'DETONATED') {
          continue;
        }
        solidHit = h;
        solidDistFromCur = distFromCur;
        break;
      }

      if (mat === 'GLASS_VORONOI') {
        if (crossedGlassIds?.has(objId)) {
          continue;
        }
        const vorWin = ctx.glassSystem.getVoronoiWindow(objId);
        if (!vorWin || vorWin.isOpenAtWorldPoint(h.pointWorld)) {
          if (distFromCur <= stepDist) {
            crossedGlassIds?.add(objId);
          }
          continue;
        }

        crossedGlassIds?.add(objId);
        const speedBefore = length(curVel);
        const shatterEnergyJ = Math.max(260, speedBefore * 38);
        const didShatter = ctx.glassSystem.shatterVoronoiWindowFromImpact(
          objId,
          h.pointWorld,
          moveDir,
          shatterEnergyJ,
          0.14
        );
        if (didShatter) {
          brokeGlass = true;
          hitMaterial = 'GLASS_VORONOI';
          ctx.notifyBreach();
          ctx.combatAudio?.playMaterialImpact('GLASS_VORONOI', h.pointWorld, 320, listenerPos);
        }

        // Grenade punches through regular glass and slows down by 50%
        curVel = scale(curVel, 0.5);
        const preDist = Math.max(0, Math.min(stepDist, distFromCur));
        const postDist = Math.max(0, stepDist - preDist) * 0.5;
        stepDist = preDist + postDist;
        targetPos = add(curPos, scale(moveDir, stepDist));
        continue;
      }

      if (mat === 'GLASS_MARCHING_256') {
        const marWin = ctx.glassSystem.getMarchingWindow(objId);
        if (!marWin || marWin.isBrokenAtWorldPoint(h.pointWorld)) {
          continue;
        }

        const speedBefore = length(curVel);
        if (speedBefore >= 1.0) {
          const didCraze = marWin.crazeFromBluntImpact(h.pointWorld, 0.24);
          if (didCraze) {
            crazedArmoredGlass = true;
            ctx.notifyBreach();
          }
          ctx.combatAudio?.playMaterialImpact('GLASS_MARCHING_256', h.pointWorld, 280, listenerPos);
        }
        solidHit = h;
        solidDistFromCur = distFromCur;
        break;
      }

      if (mat === 'WOOD_DRYWALL') {
        if (
          isWoodWallRayInOpenHole(
            ctx.woodWalls,
            objId,
            curPos,
            moveDir,
            stepDist + grenadeRadiusM,
            h.pointWorld
          )
        ) {
          continue;
        }
        solidHit = h;
        solidDistFromCur = distFromCur;
        break;
      }

      if (mat === 'BRICK_MASONRY') {
        if (
          ctx.brickWalls.isWallOpenAlongRay(
            objId,
            curPos,
            moveDir,
            stepDist + grenadeRadiusM,
            h.pointWorld
          )
        ) {
          continue;
        }
        solidHit = h;
        solidDistFromCur = distFromCur;
        break;
      }

      // WOOD_STUD, CONCRETE_INTACT, CONCRETE_CHUNKS, STEEL
      solidHit = h;
      solidDistFromCur = distFromCur;
      break;
    }

    if (!solidHit) {
      curPos = targetPos;
      break;
    }

    const mat = solidHit.surface.material;
    const outNormal = orientOutwardNormal(solidHit.normalWorld, moveDir);
    const vnScalar = dot(curVel, outNormal);

    const safeTravel = Math.max(0, solidDistFromCur - grenadeRadiusM - 0.004);
    const pushOut = solidDistFromCur < grenadeRadiusM ? grenadeRadiusM - solidDistFromCur + 0.003 : 0;
    const contactPos = add(
      add(curPos, scale(moveDir, safeTravel)),
      scale(outNormal, pushOut)
    );

    if (vnScalar < 0) {
      const { normalRestitution, tangentRetention } = resolveBounceCoefficients(mat);
      const vnVec = scale(outNormal, vnScalar);
      const vtVec = sub(curVel, vnVec);
      curVel = add(scale(vtVec, tangentRetention), scale(outNormal, -vnScalar * normalRestitution));
      bounced = true;
      hitMaterial = mat;

      if (mat !== 'GLASS_MARCHING_256' && Math.abs(vnScalar) > 1.1) {
        ctx.combatAudio?.playMaterialImpact(
          mat,
          solidHit.pointWorld,
          Math.min(160, 12 + Math.abs(vnScalar) * 9),
          listenerPos
        );
      }
    }

    const remFraction = Math.max(0, 1 - safeTravel / Math.max(1e-5, stepDist));
    const postSpeed = length(curVel);
    curPos = contactPos;
    if (remFraction <= 0.02 || postSpeed < 0.05) {
      targetPos = contactPos;
      break;
    }
    const approxRemDist = Math.min(stepDist * remFraction, postSpeed * 0.02);
    targetPos = add(contactPos, scale(normalize(curVel), approxRemDist));
  }

  return {
    position: curPos,
    velocity: curVel,
    bounced,
    brokeGlass,
    crazedArmoredGlass,
    hitMaterial,
  };
}
