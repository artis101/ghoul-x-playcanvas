import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { add, normalize, scale } from '../../../core/ballistics/vec3.ts';
import { isPointInOpenHole } from '../../../core/destruction/woodPolygonClipper.ts';
import type { PenetrationRayHit } from '../../../contracts/destruction.ts';
import type { WoodWallSystem } from '../woodWallSystem.ts';
import {
  classifyHitGroup,
  type DestructionRaycastContext,
} from './destructionRaycast.ts';

export function isWoodWallRayInOpenHole(
  woodWalls: WoodWallSystem,
  objectId: string,
  rayOrigin: Vec3Like,
  unitDir: Vec3Like,
  maxDist: number,
  fallbackPointWorld: Vec3Like
): boolean {
  const wall = woodWalls.getWall(objectId);
  if (!wall) return false;
  if (wall.lastMeshStats.indexCount <= 0) return true;

  const relOx = rayOrigin.x - wall.centerWorld.x;
  const relOy = rayOrigin.y - wall.centerWorld.y;
  const relOz = rayOrigin.z - wall.centerWorld.z;

  const localOx = relOx * wall.cosYaw - relOz * wall.sinYaw;
  const localOy = relOy;
  const localOz = relOx * wall.sinYaw + relOz * wall.cosYaw;

  const localDx = unitDir.x * wall.cosYaw - unitDir.z * wall.sinYaw;
  const localDy = unitDir.y;
  const localDz = unitDir.x * wall.sinYaw + unitDir.z * wall.cosYaw;

  let hitLocalX: number;
  let hitLocalY: number;
  if (Math.abs(localDz) > 1e-5) {
    const tMid = -localOz / localDz;
    if (tMid >= -wall.thicknessM && tMid <= maxDist + wall.thicknessM) {
      hitLocalX = localOx + localDx * tMid;
      hitLocalY = localOy + localDy * tMid;
    } else {
      const rx = fallbackPointWorld.x - wall.centerWorld.x;
      const rz = fallbackPointWorld.z - wall.centerWorld.z;
      hitLocalX = rx * wall.cosYaw - rz * wall.sinYaw;
      hitLocalY = fallbackPointWorld.y - wall.centerWorld.y;
    }
  } else {
    const rx = fallbackPointWorld.x - wall.centerWorld.x;
    const rz = fallbackPointWorld.z - wall.centerWorld.z;
    hitLocalX = rx * wall.cosYaw - rz * wall.sinYaw;
    hitLocalY = fallbackPointWorld.y - wall.centerWorld.y;
  }

  const u = hitLocalX + wall.widthM * 0.5;
  const v = hitLocalY + wall.heightM * 0.5;
  return isPointInOpenHole(wall.panelState, u, v);
}

export function isSurfaceHitInOpenBreach(
  ctx: DestructionRaycastContext,
  hit: PenetrationRayHit,
  rayOrigin: Vec3Like,
  unitDir: Vec3Like,
  maxDistM: number
): boolean {
  const mat = hit.surface.material;
  const objId = hit.surface.objectId;

  if (objId.startsWith('hazard_barrel_')) {
    return ctx.barrelManager?.getBarrelByObjectId(objId)?.state === 'DETONATED';
  }
  if (mat === 'WOOD_DRYWALL') {
    return isWoodWallRayInOpenHole(ctx.woodWalls, objId, rayOrigin, unitDir, maxDistM, hit.pointWorld);
  }
  if (mat === 'GLASS_MARCHING_256' || mat === 'GLASS_VORONOI') {
    return ctx.glassSystem.isGlassOpenAtWorldPoint(objId, mat, hit.pointWorld);
  }
  return false;
}

export function isLineOfSightBlocked(
  ctx: DestructionRaycastContext,
  fromWorld: Vec3Like,
  toWorld: Vec3Like
): boolean {
  const dx = toWorld.x - fromWorld.x;
  const dy = toWorld.y - fromWorld.y;
  const dz = toWorld.z - fromWorld.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist <= 0.05) return false;

  const invDist = 1 / dist;
  const dir: Vec3Like = { x: dx * invDist, y: dy * invDist, z: dz * invDist };
  const maxDist = Math.max(0.01, dist - 0.02);

  return ctx.rapierWorld.hasAnyBlockingHit(fromWorld, dir, maxDist, (surface, pointWorld) => {
    const mat = surface.material;
    if (mat === 'GLASS_MARCHING_256' || mat === 'GLASS_VORONOI') {
      return false;
    }
    if (surface.objectId.startsWith('hazard_barrel_')) {
      return ctx.barrelManager?.getBarrelByObjectId(surface.objectId)?.state !== 'DETONATED';
    }
    if (mat === 'WOOD_DRYWALL') {
      return !isWoodWallRayInOpenHole(ctx.woodWalls, surface.objectId, fromWorld, dir, maxDist, pointWorld);
    }
    return true;
  });
}

export function interceptEnemyShot(
  ctx: DestructionRaycastContext,
  origin: Vec3Like,
  dir: Vec3Like,
  maxDistM: number,
  kineticEnergyJ = 460
): { blocked: boolean; impactPointWorld?: Vec3Like } {
  if (maxDistM <= 0) {
    return { blocked: false };
  }

  const normDir = normalize(dir);
  const rawHits = ctx.rapierWorld.castPenetrationRay(origin, normDir, maxDistM);
  if (rawHits.length === 0) {
    return { blocked: false };
  }

  const orderedObjects: Array<{
    readonly key: string;
    readonly firstHit: PenetrationRayHit;
    lastDistM: number;
    hitStud: boolean;
  }> = [];
  const indexByKey = new Map<string, number>();

  for (let i = 0; i < rawHits.length; i++) {
    const h = rawHits[i];
    if (h.distanceM > maxDistM) continue;
    const groupKind = classifyHitGroup(h.surface);
    const key = `${groupKind}:${h.surface.objectId}`;
    const existingIdx = indexByKey.get(key);
    if (
      existingIdx !== undefined &&
      h.distanceM - orderedObjects[existingIdx].lastDistM <= 0.65
    ) {
      orderedObjects[existingIdx].lastDistM = Math.max(
        orderedObjects[existingIdx].lastDistM,
        h.distanceM
      );
      if (h.surface.material === 'WOOD_STUD') {
        orderedObjects[existingIdx].hitStud = true;
      }
    } else {
      indexByKey.set(key, orderedObjects.length);
      orderedObjects.push({
        key,
        firstHit: h,
        lastDistM: h.distanceM,
        hitStud: h.surface.material === 'WOOD_STUD',
      });
    }
  }

  let curEnergyJ = Math.max(60, kineticEnergyJ);
  let curSpeedMs = 390;
  const listenerPos = ctx.getListenerPos ? ctx.getListenerPos() : { x: 0, y: 1.62, z: 0 };

  for (let i = 0; i < orderedObjects.length; i++) {
    const entry = orderedObjects[i];
    const hit = entry.firstHit;
    const mat = hit.surface.material;
    const objId = hit.surface.objectId;

    const startDistM = Math.max(0, hit.distanceM - 0.06);
    const endDistM = Math.min(
      maxDistM + 0.04,
      entry.lastDistM + Math.max(0.18, hit.surface.thicknessM + 0.14)
    );
    const segLenM = Math.max(0.08, endDistM - startDistM);
    const segOrigin = add(origin, scale(normDir, startDistM));

    if (objId.startsWith('hazard_barrel_') && ctx.barrelManager) {
      const barrelRes = ctx.barrelManager.handleRaySegment({
        originWorld: segOrigin,
        directionWorld: normDir,
        maxDistanceM: segLenM,
        kineticEnergyJ: curEnergyJ,
        speedMs: curSpeedMs,
        caliberRadiusM: 0.0045,
        isArmorPiercing: false,
      });
      if (!barrelRes) continue;
      ctx.notifyBreach();
      const impactPt = barrelRes.impactPointWorld ?? hit.pointWorld;
      ctx.combatAudio?.playMaterialImpact('STEEL', impactPt, curEnergyJ, listenerPos);
      if (barrelRes.stopped || barrelRes.remainingEnergyJ <= 20) {
        return { blocked: true, impactPointWorld: impactPt };
      }
      curEnergyJ = barrelRes.remainingEnergyJ;
      curSpeedMs = barrelRes.remainingSpeedMs;
      continue;
    }

    if (mat === 'GLASS_MARCHING_256' || mat === 'GLASS_VORONOI') {
      const res = ctx.glassSystem.handleRaySegment({
        originWorld: segOrigin,
        directionWorld: normDir,
        maxDistanceM: segLenM,
        kineticEnergyJ: curEnergyJ,
        speedMs: curSpeedMs,
        caliberRadiusM: 0.0045,
        isArmorPiercing: false,
      });
      if (!res) continue;

      const energyLost = curEnergyJ - res.remainingEnergyJ;
      if (energyLost > 1.0 || res.stopped) {
        ctx.notifyBreach();
        ctx.combatAudio?.playMaterialImpact(
          res.hitMaterial ?? mat,
          res.impactPointWorld ?? hit.pointWorld,
          curEnergyJ,
          listenerPos
        );
      }

      curEnergyJ = Math.max(0, res.remainingEnergyJ);
      curSpeedMs = Math.max(0, res.remainingSpeedMs);
      if (res.stopped || curEnergyJ <= 15 || curSpeedMs <= 25) {
        return {
          blocked: true,
          impactPointWorld: res.impactPointWorld ?? hit.pointWorld,
        };
      }
      continue;
    }

    if (mat === 'WOOD_DRYWALL' || mat === 'WOOD_STUD') {
      if (
        !entry.hitStud &&
        isWoodWallRayInOpenHole(ctx.woodWalls, objId, origin, normDir, maxDistM, hit.pointWorld)
      ) {
        continue;
      }

      const segEnergyJ = Math.min(220, curEnergyJ);
      const res = ctx.woodWalls.handleRaySegment({
        originWorld: segOrigin,
        directionWorld: normDir,
        maxDistanceM: segLenM,
        kineticEnergyJ: segEnergyJ,
        speedMs: 310,
        caliberRadiusM: 0.0045,
        isArmorPiercing: false,
      });
      if (!res || (!res.stopped && segEnergyJ - res.remainingEnergyJ <= 1.0)) {
        continue;
      }

      ctx.notifyBreach();
      const impactPt = res.impactPointWorld ?? hit.pointWorld;
      ctx.combatAudio?.playMaterialImpact(
        res.hitMaterial ?? (entry.hitStud ? 'WOOD_STUD' : 'WOOD_DRYWALL'),
        impactPt,
        curEnergyJ,
        listenerPos
      );
      return {
        blocked: true,
        impactPointWorld: impactPt,
      };
    }

    if (mat === 'BRICK_MASONRY') {
      const res = ctx.brickWalls.handleRaySegment({
        originWorld: segOrigin,
        directionWorld: normDir,
        maxDistanceM: segLenM,
        kineticEnergyJ: Math.min(320, curEnergyJ),
        speedMs: 340,
        caliberRadiusM: 0.0045,
        isArmorPiercing: false,
      });
      if (!res) continue;

      ctx.notifyBreach();
      const impactPt = res.impactPointWorld ?? hit.pointWorld;
      ctx.combatAudio?.playMaterialImpact('BRICK_MASONRY', impactPt, curEnergyJ, listenerPos);
      return {
        blocked: true,
        impactPointWorld: impactPt,
      };
    }

    if (mat === 'CONCRETE_CHUNKS' || mat === 'CONCRETE_INTACT') {
      let impactPt = hit.pointWorld;
      if (ctx.concreteWalls.getWall(objId)) {
        const res = ctx.concreteWalls.handleRaySegment({
          originWorld: segOrigin,
          directionWorld: normDir,
          maxDistanceM: segLenM,
          kineticEnergyJ: curEnergyJ,
          speedMs: curSpeedMs,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        if (!res) continue;
        if (res.impactPointWorld) {
          impactPt = res.impactPointWorld;
        }
      } else {
        ctx.pomDecals.spawnCraterImpact(hit.pointWorld, hit.normalWorld, normDir, curEnergyJ, 0.0045);
      }
      ctx.notifyBreach();
      ctx.combatAudio?.playMaterialImpact(mat, impactPt, curEnergyJ, listenerPos);
      return {
        blocked: true,
        impactPointWorld: impactPt,
      };
    }

    ctx.notifyBreach();
    ctx.combatAudio?.playMaterialImpact('STEEL', hit.pointWorld, curEnergyJ, listenerPos);
    return {
      blocked: true,
      impactPointWorld: hit.pointWorld,
    };
  }

  return { blocked: false };
}
