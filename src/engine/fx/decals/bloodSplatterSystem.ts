import type { GoreMode, ShotSimulationReport, Vec3Like } from '../../../contracts/ballistics.ts';
import { dot, length, normalize, scale } from '../../../core/ballistics/vec3.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { computeSurfaceAlignedQuadQuaternion } from '../math/surfaceAlignment.ts';
import type { BulletTimeController } from '../bulletTime/bulletTimeController.ts';
import type { SurfaceOpenPredicate } from '../impacts/surfaceImpactFx.ts';

export interface BloodSplatterProjectionParams {
  readonly originWorld: Vec3Like;
  readonly impactDirectionWorld: Vec3Like;
  readonly exitEnergyJ: number;
  readonly goreMode?: GoreMode;
  readonly splatterScaleM?: number;
}

const BLOOD_RAY_MAX_DIST_M = 4.5;
const BLOOD_WALL_NORMAL_OFFSET_M = 0.004;
const BLOOD_SUPPORT_PROBE_OFFSET_M = 0.05;
const BLOOD_SUPPORT_PROBE_DIST_M = 0.12;

export interface BloodSplatterSlotAnchor {
  active: boolean;
  isFloor: boolean;
  pointWorld: Vec3Like;
  normalWorld: Vec3Like;
}

export interface BloodSplatterContext {
  rapierWorld: RapierPhysicsWorld;
  bloodSplatterPool: HardwareInstancedPool;
  bulletTime: BulletTimeController;
  isSurfaceOpenAtHit?: SurfaceOpenPredicate;
  slotAnchors?: BloodSplatterSlotAnchor[];
}

export function castWallOrFloorBloodRay(
  rapierWorld: RapierPhysicsWorld,
  origin: Vec3Like,
  dirNormalized: Vec3Like,
  maxDistM: number,
  isSurfaceOpenAtHit?: SurfaceOpenPredicate,
): { pointWorld: Vec3Like; normalWorld: Vec3Like; distanceM: number } | null {
  const wallHits = rapierWorld.castPenetrationRay(origin, dirNormalized, maxDistM);

  let bestWallHit: { pointWorld: Vec3Like; normalWorld: Vec3Like; distanceM: number } | null = null;
  for (const h of wallHits) {
    if (h.surface.objectId.startsWith('hazard_barrel_')) continue;
    if (!rapierWorld.isStaticCollider(h.colliderHandle)) continue;
    if (h.distanceM > 0.02 && h.distanceM <= maxDistM) {
      if (isSurfaceOpenAtHit?.(h, origin, dirNormalized, maxDistM)) continue;
      let n = h.normalWorld;
      if (dot(n, dirNormalized) > 0) n = scale(n, -1);
      bestWallHit = { pointWorld: h.pointWorld, normalWorld: normalize(n), distanceM: h.distanceM };
      break;
    }
  }

  let floorHit: { pointWorld: Vec3Like; normalWorld: Vec3Like; distanceM: number } | null = null;
  if (dirNormalized.y < -1e-4 && origin.y > 0.005) {
    const tFloor = -origin.y / dirNormalized.y;
    if (tFloor > 0.02 && tFloor <= maxDistM) {
      floorHit = {
        pointWorld: { x: origin.x + dirNormalized.x * tFloor, y: 0, z: origin.z + dirNormalized.z * tFloor },
        normalWorld: { x: 0, y: 1, z: 0 },
        distanceM: tFloor,
      };
    }
  }

  if (bestWallHit && floorHit) {
    return bestWallHit.distanceM <= floorHit.distanceM ? bestWallHit : floorHit;
  }
  return bestWallHit ?? floorHit;
}

export function projectBloodSplatter(
  ctx: BloodSplatterContext,
  params: BloodSplatterProjectionParams,
  recycleCursor: { value: number },
  seedCounter: { value: number },
): number {
  const isHighGoreSever = params.goreMode === 'CRANIAL_POP' || params.goreMode === 'CLEAN_SEVER';
  if (params.exitEnergyJ <= 80 && !isHighGoreSever) return 0;

  const baseDir = normalize(params.impactDirectionWorld);
  if (length(baseDir) < 1e-6) return 0;

  const raysToCast: Vec3Like[] = [baseDir];
  if (isHighGoreSever) {
    raysToCast.push(
      normalize({ x: baseDir.x + 0.14, y: baseDir.y - 0.32, z: baseDir.z }),
      normalize({ x: baseDir.x - 0.14, y: baseDir.y - 0.44, z: baseDir.z }),
    );
  }

  let stampedCount = 0;
  for (let r = 0; r < raysToCast.length; r++) {
    const rayDir = raysToCast[r];
    const hit = castWallOrFloorBloodRay(
      ctx.rapierWorld,
      params.originWorld,
      rayDir,
      BLOOD_RAY_MAX_DIST_M,
      ctx.isSurfaceOpenAtHit,
    );
    if (!hit) continue;

    let slotId = ctx.bloodSplatterPool.allocSlot();
    if (slotId < 0) {
      slotId = recycleCursor.value % ctx.bloodSplatterPool.maxInstances;
      recycleCursor.value++;
    }

    const seed = seedCounter.value++;
    const rollRad = (seed * 1.93) % (Math.PI * 2);
    const energyFactor = Math.min(2.1, 0.72 + params.exitEnergyJ / 950);
    const baseSize =
      params.splatterScaleM ??
      (params.goreMode === 'CRANIAL_POP' ? 0.92 : params.goreMode === 'CLEAN_SEVER' ? 0.78 : 0.52 * energyFactor);
    const stretchY = Math.abs(hit.normalWorld.y) < 0.5 ? 1.24 : 1.05;

    const depthBias = BLOOD_WALL_NORMAL_OFFSET_M + (slotId % 8) * 0.00012;
    const decalPos: Vec3Like = {
      x: hit.pointWorld.x + hit.normalWorld.x * depthBias,
      y: hit.pointWorld.y + hit.normalWorld.y * depthBias,
      z: hit.pointWorld.z + hit.normalWorld.z * depthBias,
    };
    const quat = computeSurfaceAlignedQuadQuaternion(hit.normalWorld, rayDir, rollRad);

    ctx.bloodSplatterPool.setSlotTRS(slotId, decalPos, quat, {
      x: baseSize,
      y: baseSize * stretchY,
      z: 1.0,
    });
    if (ctx.slotAnchors && slotId >= 0 && slotId < ctx.slotAnchors.length) {
      const anchor = ctx.slotAnchors[slotId];
      anchor.active = true;
      anchor.isFloor = hit.normalWorld.y > 0.9 && hit.pointWorld.y <= 0.035;
      anchor.pointWorld = { x: hit.pointWorld.x, y: hit.pointWorld.y, z: hit.pointWorld.z };
      anchor.normalWorld = { x: hit.normalWorld.x, y: hit.normalWorld.y, z: hit.normalWorld.z };
    }
    stampedCount++;
  }

  if (stampedCount > 0) ctx.bloodSplatterPool.upload();
  return stampedCount;
}

export function pruneUnsupportedBloodSplatters(ctx: BloodSplatterContext): number {
  const anchors = ctx.slotAnchors;
  if (!anchors) return 0;

  let freedCount = 0;
  for (let slotId = 0; slotId < anchors.length; slotId++) {
    const anchor = anchors[slotId];
    if (!anchor.active || anchor.isFloor) continue;
    if (!ctx.bloodSplatterPool.isSlotActive(slotId)) {
      anchor.active = false;
      continue;
    }

    const nx = anchor.normalWorld.x;
    const ny = anchor.normalWorld.y;
    const nz = anchor.normalWorld.z;
    const origin: Vec3Like = {
      x: anchor.pointWorld.x + nx * BLOOD_SUPPORT_PROBE_OFFSET_M,
      y: anchor.pointWorld.y + ny * BLOOD_SUPPORT_PROBE_OFFSET_M,
      z: anchor.pointWorld.z + nz * BLOOD_SUPPORT_PROBE_OFFSET_M,
    };
    const dir: Vec3Like = { x: -nx, y: -ny, z: -nz };
    const hits = ctx.rapierWorld.castPenetrationRay(origin, dir, BLOOD_SUPPORT_PROBE_DIST_M);

    let supported = false;
    for (const h of hits) {
      if (h.surface.objectId.startsWith('hazard_barrel_')) continue;
      if (!ctx.rapierWorld.isStaticCollider(h.colliderHandle)) continue;
      if (ctx.isSurfaceOpenAtHit?.(h, origin, dir, BLOOD_SUPPORT_PROBE_DIST_M)) continue;
      supported = true;
      break;
    }

    if (!supported) {
      ctx.bloodSplatterPool.freeSlot(slotId);
      anchor.active = false;
      freedCount++;
    }
  }

  if (freedCount > 0) ctx.bloodSplatterPool.upload();
  return freedCount;
}

export function processShotSimulationReport(
  ctx: BloodSplatterContext,
  report: ShotSimulationReport,
  recycleCursor: { value: number },
  seedCounter: { value: number },
): number {
  if (!report.hitTarget) return 0;
  let totalDecals = 0;

  for (const wound of report.woundEvents) {
    if (wound.exitEnergyJ > 80) {
      totalDecals += projectBloodSplatter(
        ctx,
        { originWorld: wound.exitPointWorld, impactDirectionWorld: wound.impactDirectionWorld, exitEnergyJ: wound.exitEnergyJ },
        recycleCursor,
        seedCounter,
      );
    }
  }

  let sawHeadLoss = false;
  let sawDismemberment = false;
  for (const dism of report.dismembermentEvents) {
    if (dism.goreMode === 'CRANIAL_POP' || dism.zone === 'NECK_CERVICAL') {
      sawHeadLoss = true;
    } else if (dism.goreMode === 'CLEAN_SEVER' || dism.goreMode === 'EVISCERATED') {
      sawDismemberment = true;
    }
    if (dism.goreMode === 'CRANIAL_POP' || dism.goreMode === 'CLEAN_SEVER') {
      totalDecals += projectBloodSplatter(
        ctx,
        {
          originWorld: dism.stumpWorldPosition,
          impactDirectionWorld: report.aimDirectionWorld,
          exitEnergyJ: Math.max(250, report.impactEnergyJ * 0.4),
          goreMode: dism.goreMode,
        },
        recycleCursor,
        seedCounter,
      );
    }
  }

  if (sawHeadLoss) {
    ctx.bulletTime.triggerKillPunch(0.35, 0.16, 'CRANIAL_POP');
  } else if (sawDismemberment) {
    ctx.bulletTime.triggerKillPunch('DISMEMBERMENT', 0.22);
  }
  return totalDecals;
}
