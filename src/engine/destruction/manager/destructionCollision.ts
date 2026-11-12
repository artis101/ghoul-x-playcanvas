import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { distance, length, scale, sub, vec3 } from '../../../core/ballistics/vec3.ts';
import { computePanelRemainingAreaM2, isPointInOpenHole } from '../../../core/destruction/woodPolygonClipper.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { BrickWallSystem } from '../brickWallSystem.ts';
import type { GlassSystem } from '../glassSystem.ts';
import type { WoodWallSystem } from '../woodWallSystem.ts';

export interface DestructionCollisionContext {
  readonly rapierWorld: RapierPhysicsWorld;
  readonly woodWalls: WoodWallSystem;
  readonly glassSystem: GlassSystem;
  readonly brickWalls?: BrickWallSystem;
}

export function isHorizontalStepBlocked(
  ctx: DestructionCollisionContext,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  radiusM: number
): boolean {
  const delta = sub(vec3(x1, 0, z1), vec3(x0, 0, z0));
  const stepDist = length(delta);
  if (stepDist < 1e-5) return false;

  const stepDir = scale(delta, 1 / stepDist);
  // Probe at waist height (0.95m) and shin height (0.38m)
  const probeHeights = [0.95, 0.38];
  for (let p = 0; p < probeHeights.length; p++) {
    const origin: Vec3Like = { x: x0, y: probeHeights[p], z: z0 };
    const hits = ctx.rapierWorld.castPenetrationRay(
      origin,
      stepDir,
      stepDist + radiusM
    );
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.distanceM > stepDist + radiusM) continue;

      if (h.surface.material === 'WOOD_DRYWALL') {
        const wallInst = ctx.woodWalls.getWall(h.surface.objectId);
        if (wallInst && distance(origin, h.pointWorld) <= stepDist + radiusM) {
          const dxLocal = h.pointWorld.x - wallInst.centerWorld.x;
          const dyLocal = h.pointWorld.y - wallInst.centerWorld.y;
          const dzLocal = h.pointWorld.z - wallInst.centerWorld.z;
          const u = dxLocal * wallInst.cosYaw - dzLocal * wallInst.sinYaw + wallInst.widthM * 0.5;
          const v = dyLocal + wallInst.heightM * 0.5;
          const remArea = computePanelRemainingAreaM2(wallInst.panelState);
          if (
            isPointInOpenHole(wallInst.panelState, u, v) ||
            remArea < wallInst.widthM * wallInst.heightM * 0.35
          ) {
            continue;
          }
        }
      }

      if (h.surface.material === 'GLASS_VORONOI') {
        const vorWin = ctx.glassSystem.voronoiWindows.find(
          (w) => w.id === h.surface.objectId
        );
        if (vorWin && vorWin.isPlayerPassable(h.pointWorld)) {
          continue;
        }
      }

      if (h.surface.material === 'GLASS_MARCHING_256') {
        const marWin = ctx.glassSystem.marchingWindows.find(
          (w) => w.id === h.surface.objectId
        );
        if (marWin && marWin.isPlayerPassable(h.pointWorld)) {
          continue;
        }
      }

      if (h.surface.material === 'BRICK_MASONRY' && ctx.brickWalls) {
        if (ctx.brickWalls.isPlayerPassableAtWorldPoint(h.surface.objectId, h.pointWorld, radiusM)) {
          continue;
        }
      }

      return true;
    }
  }

  return false;
}

export function resolvePlayerHorizontalCollision(
  ctx: DestructionCollisionContext,
  prevPos: Vec3Like,
  desiredPos: Vec3Like,
  playerRadiusM = 0.36
): { x: number; z: number } {
  const dx = desiredPos.x - prevPos.x;
  const dz = desiredPos.z - prevPos.z;
  if (Math.hypot(dx, dz) < 1e-5) {
    return { x: desiredPos.x, z: desiredPos.z };
  }

  if (!isHorizontalStepBlocked(ctx, prevPos.x, prevPos.z, desiredPos.x, desiredPos.z, playerRadiusM)) {
    return { x: desiredPos.x, z: desiredPos.z };
  }

  let resolvedX = prevPos.x;
  let resolvedZ = prevPos.z;

  if (
    Math.abs(dx) > 1e-5 &&
    !isHorizontalStepBlocked(ctx, prevPos.x, prevPos.z, desiredPos.x, prevPos.z, playerRadiusM)
  ) {
    resolvedX = desiredPos.x;
  }

  if (
    Math.abs(dz) > 1e-5 &&
    !isHorizontalStepBlocked(ctx, resolvedX, prevPos.z, resolvedX, desiredPos.z, playerRadiusM)
  ) {
    resolvedZ = desiredPos.z;
  }

  desiredPos.x = resolvedX;
  desiredPos.z = resolvedZ;
  return { x: resolvedX, z: resolvedZ };
}
