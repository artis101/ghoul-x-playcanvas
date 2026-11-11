import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  ColliderSurfaceTag,
  DestructibleMaterialKind,
  PenetrationRayHit,
} from '../../../contracts/destruction.ts';
import { add, normalize, scale } from '../../../core/ballistics/vec3.ts';
import type { CombatAudioEngine } from '../../audio/combatAudioEngine.ts';
import type { EnvironmentRayInterceptResult } from '../../combat/combatDirector.ts';
import type { ExplosiveBarrelManager } from '../../fx/mayhemDirector.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { BrickWallSystem } from '../brickWallSystem.ts';
import type { ConcreteWallSystem } from '../concreteWallSystem.ts';
import type { GlassSystem } from '../glassSystem.ts';
import type { PomCraterDecalSystem } from '../pomCraterDecals.ts';
import type { WoodWallSystem } from '../woodWallSystem.ts';

export interface DestructionRaycastContext {
  readonly rapierWorld: RapierPhysicsWorld;
  readonly woodWalls: WoodWallSystem;
  readonly glassSystem: GlassSystem;
  readonly brickWalls: BrickWallSystem;
  readonly concreteWalls: ConcreteWallSystem;
  readonly pomDecals: PomCraterDecalSystem;
  readonly barrelManager: ExplosiveBarrelManager | null;
  readonly combatAudio: CombatAudioEngine | null;
  readonly getListenerPos?: () => Vec3Like;
  notifyBreach: () => void;
}

export function classifyHitGroup(tag: ColliderSurfaceTag): string {
  if (tag.objectId.startsWith('hazard_barrel_')) {
    return 'BARREL';
  }
  switch (tag.material) {
    case 'WOOD_DRYWALL':
    case 'WOOD_STUD':
      return 'WOOD';
    case 'GLASS_MARCHING_256':
    case 'GLASS_VORONOI':
      return 'GLASS';
    case 'BRICK_MASONRY':
      return 'BRICK';
    case 'CONCRETE_CHUNKS':
    case 'CONCRETE_INTACT':
      return 'CONCRETE';
    case 'STEEL':
      return 'STEEL';
  }
}

export function dispatchSubsystemRaySegment(
  ctx: DestructionRaycastContext,
  hit: PenetrationRayHit,
  seg: BallisticSegmentImpact
): BallisticPenetrationResult | null {
  const mat = hit.surface.material;
  const objId = hit.surface.objectId;

  if (objId.startsWith('hazard_barrel_') && ctx.barrelManager) {
    return ctx.barrelManager.handleRaySegment(seg);
  }

  if (mat === 'WOOD_DRYWALL' || mat === 'WOOD_STUD') {
    return ctx.woodWalls.handleRaySegment(seg);
  }

  if (mat === 'GLASS_MARCHING_256' || mat === 'GLASS_VORONOI') {
    return ctx.glassSystem.handleRaySegment(seg);
  }

  if (mat === 'BRICK_MASONRY') {
    return ctx.brickWalls.handleRaySegment(seg);
  }

  if (mat === 'CONCRETE_CHUNKS' || mat === 'CONCRETE_INTACT') {
    if (ctx.concreteWalls.getWall(objId)) {
      return ctx.concreteWalls.handleRaySegment(seg);
    }
    ctx.pomDecals.spawnCraterImpact(
      hit.pointWorld,
      hit.normalWorld,
      seg.directionWorld,
      seg.kineticEnergyJ,
      seg.caliberRadiusM
    );
    return {
      remainingEnergyJ: 0,
      remainingSpeedMs: 0,
      stopped: true,
      impactPointWorld: hit.pointWorld,
      impactNormalWorld: hit.normalWorld,
      hitMaterial: 'CONCRETE_INTACT',
    };
  }

  if (mat === 'STEEL') {
    return {
      remainingEnergyJ: 0,
      remainingSpeedMs: 0,
      stopped: true,
      impactPointWorld: hit.pointWorld,
      impactNormalWorld: hit.normalWorld,
      hitMaterial: 'STEEL',
    };
  }

  return null;
}

export function interceptRaySegment(
  ctx: DestructionRaycastContext,
  origin: Vec3Like,
  dir: Vec3Like,
  maxDistM: number,
  energyJ: number,
  speedMs: number,
  caliberDiameterM: number,
  isAp: boolean
): EnvironmentRayInterceptResult {
  if (maxDistM <= 0 || energyJ <= 0 || speedMs <= 0) {
    return {
      remainingEnergyJ: Math.max(0, energyJ),
      remainingSpeedMs: Math.max(0, speedMs),
      blocked: energyJ <= 0 || speedMs <= 0,
    };
  }

  const normDir = normalize(dir);
  const rawHits = ctx.rapierWorld.castPenetrationRay(origin, normDir, maxDistM);
  if (rawHits.length === 0) {
    return {
      remainingEnergyJ: energyJ,
      remainingSpeedMs: speedMs,
      blocked: false,
    };
  }

  const massKg = (2 * energyJ) / Math.max(1, speedMs * speedMs);
  const caliberRadiusM = Math.max(0.002, caliberDiameterM * 0.5);

  const orderedObjects: Array<{
    readonly key: string;
    readonly firstHit: PenetrationRayHit;
    lastDistM: number;
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
    } else {
      indexByKey.set(key, orderedObjects.length);
      orderedObjects.push({
        key,
        firstHit: h,
        lastDistM: h.distanceM,
      });
    }
  }

  let curEnergyJ = energyJ;
  let curSpeedMs = speedMs;
  const listenerPos = ctx.getListenerPos ? ctx.getListenerPos() : { x: 0, y: 1.62, z: 0 };

  for (let i = 0; i < orderedObjects.length; i++) {
    const entry = orderedObjects[i];
    const hit = entry.firstHit;
    const startDistM = Math.max(0, hit.distanceM - 0.06);
    const endDistM = Math.min(
      maxDistM + 0.04,
      entry.lastDistM + Math.max(0.18, hit.surface.thicknessM + 0.14)
    );
    const segLenM = Math.max(0.08, endDistM - startDistM);
    const segOrigin = add(origin, scale(normDir, startDistM));

    const seg: BallisticSegmentImpact = {
      originWorld: segOrigin,
      directionWorld: normDir,
      maxDistanceM: segLenM,
      kineticEnergyJ: curEnergyJ,
      speedMs: curSpeedMs,
      caliberRadiusM,
      isArmorPiercing: isAp,
    };

    const energyBefore = curEnergyJ;
    const res = dispatchSubsystemRaySegment(ctx, hit, seg);
    if (!res) {
      continue;
    }

    const energyLost = energyBefore - res.remainingEnergyJ;
    if (energyLost > 1.0 || res.stopped) {
      ctx.notifyBreach();
      const audioMat: DestructibleMaterialKind = res.hitMaterial ?? hit.surface.material;
      const audioPt = res.impactPointWorld ?? hit.pointWorld;
      ctx.combatAudio?.playMaterialImpact(audioMat, audioPt, energyBefore, listenerPos);
    }

    curEnergyJ = Math.max(0, res.remainingEnergyJ);
    curSpeedMs =
      res.remainingSpeedMs > 0
        ? res.remainingSpeedMs
        : curEnergyJ > 0 && massKg > 1e-7
          ? Math.sqrt((2 * curEnergyJ) / massKg)
          : 0;

    if (res.stopped || curEnergyJ <= 10 || curSpeedMs <= 25) {
      const stopPt = res.impactPointWorld ?? hit.pointWorld;
      const sdx = stopPt.x - origin.x;
      const sdy = stopPt.y - origin.y;
      const sdz = stopPt.z - origin.z;
      return {
        remainingEnergyJ: 0,
        remainingSpeedMs: 0,
        blocked: true,
        stoppedDistanceM: Math.hypot(sdx, sdy, sdz),
      };
    }
  }

  return {
    remainingEnergyJ: curEnergyJ,
    remainingSpeedMs: curSpeedMs,
    blocked: false,
  };
}
