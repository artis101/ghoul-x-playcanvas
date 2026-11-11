import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  DestructibleMaterialKind,
  PenetrationRayHit,
} from '../../../contracts/destruction.ts';
import {
  createJaggedHoleStamp,
  inferWoodStampProfile,
  isPointInOpenHole,
  stampHoleInWoodPanel,
  type SplinterSpawnDescriptor,
  type WoodMeshBuildStats,
} from '../../../core/destruction/woodPolygonClipper.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { acquirePelletVolley, wasPointCutByCurrentVolley } from './buckshotVolleyTracker.ts';
import { isPointOverIntactStud } from './woodStudColliderSync.ts';
import {
  damageInteriorStudSections,
  tryApplyBuckshotClusterBlowout,
} from './woodStudDamageSolver.ts';
import {
  spawnBlastSplinterShower,
  spawnPerimeterSplinters,
  spawnPlankChunkBurst,
} from './woodSplinterEmitter.ts';
import {
  DEFAULT_WOOD_STUD_WIDTH_M,
  type WallInternalState,
  type WoodWallInstance,
} from './woodWallTypes.ts';

export function uploadWallPanelMesh(
  wall: WoodWallInstance,
  stats: WoodMeshBuildStats,
): void {
  wall.lastMeshStats = stats;
  if (stats.vertexCount <= 0 || stats.indexCount <= 0) {
    wall.panelEntity.enabled = false;
    return;
  }
  wall.panelEntity.enabled = true;
  const mesh = wall.panelMesh;
  const buf = wall.scratchBuffers;
  mesh.setPositions(buf.positions, 3, stats.vertexCount);
  mesh.setNormals(buf.normals, 3, stats.vertexCount);
  mesh.setUvs(0, buf.uvs, 2, stats.vertexCount);
  mesh.setIndices(buf.indices, stats.indexCount);
  mesh.update(pc.PRIMITIVE_TRIANGLES, false);
}

export function handleWoodWallRaySegment(
  physicsWorld: RapierPhysicsWorld,
  walls: readonly WoodWallInstance[],
  wallsById: ReadonlyMap<string, WoodWallInstance>,
  internalByWallId: ReadonlyMap<string, WallInternalState>,
  splinterPools: readonly HardwareInstancedPool[],
  nextRand: () => number,
  elapsedSimTimeS: number,
  seg: BallisticSegmentImpact,
): BallisticPenetrationResult | null {
  if (walls.length === 0 || seg.maxDistanceM <= 0) return null;

  const dirLen = Math.hypot(seg.directionWorld.x, seg.directionWorld.y, seg.directionWorld.z);
  if (dirLen < 1e-8) return null;

  const dx = seg.directionWorld.x / dirLen;
  const dy = seg.directionWorld.y / dirLen;
  const dz = seg.directionWorld.z / dirLen;
  const unitDir: Vec3Like = { x: dx, y: dy, z: dz };

  const allHits = physicsWorld.castPenetrationRay(seg.originWorld, unitDir, seg.maxDistanceM);
  if (allHits.length === 0) return null;

  const orderedWallIds: string[] = [];
  const wallHitGroups = new Map<
    string,
    { wall: WoodWallInstance; primaryHit: PenetrationRayHit; hitStudCollider: boolean }
  >();

  for (let i = 0; i < allHits.length; i++) {
    const hit = allHits[i];
    const wall = wallsById.get(hit.surface.objectId);
    if (!wall) continue;

    let group = wallHitGroups.get(wall.id);
    if (!group) {
      group = { wall, primaryHit: hit, hitStudCollider: hit.surface.material === 'WOOD_STUD' };
      wallHitGroups.set(wall.id, group);
      orderedWallIds.push(wall.id);
    } else if (hit.surface.material === 'WOOD_STUD') {
      group.hitStudCollider = true;
    }
  }

  if (orderedWallIds.length === 0) return null;

  let currentEnergyJ = Math.max(0, seg.kineticEnergyJ);
  let currentSpeedMs = Math.max(0, seg.speedMs);
  let stopped = false;
  let firstImpactPoint: Vec3Like | undefined;
  let firstImpactNormal: Vec3Like | undefined;
  let effectiveMaterial: DestructibleMaterialKind = 'WOOD_DRYWALL';

  for (let wIdx = 0; wIdx < orderedWallIds.length; wIdx++) {
    const group = wallHitGroups.get(orderedWallIds[wIdx]);
    if (!group) continue;

    const { wall, primaryHit } = group;
    const internal = internalByWallId.get(wall.id);
    if (!internal) continue;

    if (!firstImpactPoint) {
      firstImpactPoint = primaryHit.pointWorld;
      firstImpactNormal = primaryHit.normalWorld;
    }

    const relOx = seg.originWorld.x - wall.centerWorld.x;
    const relOy = seg.originWorld.y - wall.centerWorld.y;
    const relOz = seg.originWorld.z - wall.centerWorld.z;

    const localOx = relOx * wall.cosYaw - relOz * wall.sinYaw;
    const localOy = relOy;
    const localOz = relOx * wall.sinYaw + relOz * wall.cosYaw;

    const localDx = dx * wall.cosYaw - dz * wall.sinYaw;
    const localDy = dy;
    const localDz = dx * wall.sinYaw + dz * wall.cosYaw;

    let hitLocalX: number;
    let hitLocalY: number;

    if (Math.abs(localDz) > 1e-5) {
      const tMid = -localOz / localDz;
      if (tMid >= 0 && tMid <= seg.maxDistanceM + wall.thicknessM) {
        hitLocalX = localOx + localDx * tMid;
        hitLocalY = localOy + localDy * tMid;
      } else {
        const hp = primaryHit.pointWorld;
        hitLocalX = (hp.x - wall.centerWorld.x) * wall.cosYaw - (hp.z - wall.centerWorld.z) * wall.sinYaw;
        hitLocalY = hp.y - wall.centerWorld.y;
      }
    } else {
      const hp = primaryHit.pointWorld;
      hitLocalX = (hp.x - wall.centerWorld.x) * wall.cosYaw - (hp.z - wall.centerWorld.z) * wall.sinYaw;
      hitLocalY = hp.y - wall.centerWorld.y;
    }

    const u = hitLocalX + wall.widthM * 0.5;
    const v = hitLocalY + wall.heightM * 0.5;
    const inPanelBounds = u >= 0 && u <= wall.widthM && v >= 0 && v <= wall.heightM;
    const exitSignZ = localDz >= 0 ? 1 : -1;

    const profile = inferWoodStampProfile(seg.caliberRadiusM, currentEnergyJ, seg.isArmorPiercing);
    let hitStud = group.hitStudCollider || isPointOverIntactStud(wall, internal, u, v);
    const rawAlreadyOpen = isPointInOpenHole(wall.panelState, u, v);
    let alreadyOpenBeforeThisShot = rawAlreadyOpen;

    if (profile === 'BUCKSHOT_PELLET') {
      const volley = acquirePelletVolley(internal, elapsedSimTimeS);
      const openedByVolley = rawAlreadyOpen && wasPointCutByCurrentVolley(volley, u, v);
      alreadyOpenBeforeThisShot = rawAlreadyOpen && !openedByVolley;

      if (alreadyOpenBeforeThisShot && !hitStud) {
        effectiveMaterial = 'WOOD_DRYWALL';
        continue;
      }

      if (inPanelBounds && !alreadyOpenBeforeThisShot) {
        if (!rawAlreadyOpen) {
          const pelletStamp = createJaggedHoleStamp({
            u,
            v,
            caliberRadiusM: seg.caliberRadiusM,
            kineticEnergyJ: currentEnergyJ,
            profile: 'BUCKSHOT_PELLET',
            isArmorPiercing: false,
            seed: wall.panelState.shotCount + 1,
          });
          const subRes = stampHoleInWoodPanel(wall.panelState, pelletStamp, wall.scratchBuffers, 3);
          if (subRes.cutAnyWood) {
            uploadWallPanelMesh(wall, subRes.meshStats);
            spawnPerimeterSplinters(splinterPools, nextRand, wall, subRes.splinters, unitDir, exitSignZ, currentEnergyJ);
          }
        }

        volley.impacts.push({ u, v, cutRadiusM: 0.052, energyJ: currentEnergyJ, dirWorld: unitDir, exitSignZ });
        tryApplyBuckshotClusterBlowout(physicsWorld, splinterPools, nextRand, uploadWallPanelMesh, wall, internal, volley, seg.caliberRadiusM);

        if (hitStud && !isPointOverIntactStud(wall, internal, u, v)) {
          hitStud = false;
        }
      }
    } else {
      internal.activeVolley = null;

      if (alreadyOpenBeforeThisShot && !hitStud) {
        effectiveMaterial = 'WOOD_DRYWALL';
        continue;
      }

      if (!alreadyOpenBeforeThisShot && inPanelBounds) {
        const stamp = createJaggedHoleStamp({
          u,
          v,
          caliberRadiusM: seg.caliberRadiusM,
          kineticEnergyJ: currentEnergyJ,
          profile,
          isArmorPiercing: seg.isArmorPiercing,
          seed: wall.panelState.shotCount + 1,
        });

        const splinterHint = profile === 'HEAVY_50AE_SLUG' || profile === 'BLAST_BREACH' ? 6 : 5;
        const subResult = stampHoleInWoodPanel(wall.panelState, stamp, wall.scratchBuffers, splinterHint);

        if (subResult.cutAnyWood) {
          uploadWallPanelMesh(wall, subResult.meshStats);
          spawnPerimeterSplinters(splinterPools, nextRand, wall, subResult.splinters, unitDir, exitSignZ, currentEnergyJ);
          if (subResult.droppedIslandAreaM2 > 0.004) {
            spawnPlankChunkBurst(splinterPools, nextRand, wall, u, v, 0.09, unitDir, exitSignZ, currentEnergyJ, 4);
          }
        }
      }
    }

    if (alreadyOpenBeforeThisShot && hitStud) {
      const studSplinters: SplinterSpawnDescriptor[] = [];
      const clampedU = Math.max(0, Math.min(wall.widthM, u));
      const clampedV = Math.max(0, Math.min(wall.heightM, v));
      for (let k = 0; k < 4; k++) {
        const ang = (k / 4) * Math.PI * 2;
        studSplinters.push({
          u: clampedU,
          v: clampedV,
          tangentU: -Math.sin(ang),
          tangentV: Math.cos(ang),
          radialU: Math.cos(ang),
          radialV: Math.sin(ang),
          lengthM: 0.065,
        });
      }
      spawnPerimeterSplinters(splinterPools, nextRand, wall, studSplinters, unitDir, exitSignZ, currentEnergyJ);
    }

    const cosIncidence = Math.abs(localDz);
    const obliquity = Math.min(2.1, 1 / Math.max(0.48, cosIncidence));
    const effectiveThicknessScale = Math.min(1.25, Math.max(0.75, 0.72 + 0.28 * (wall.thicknessM / 0.08)));

    let energyLossJ: number;
    if (hitStud) {
      effectiveMaterial = 'WOOD_STUD';
      const baseStudJ = alreadyOpenBeforeThisShot
        ? seg.isArmorPiercing ? 525 : 615
        : seg.isArmorPiercing ? 595 : 685;
      energyLossJ = baseStudJ * obliquity;

      const studDamageHp =
        profile === 'BUCKSHOT_PELLET'
          ? 320
          : profile === 'HEAVY_50AE_SLUG' || profile === 'BLAST_BREACH'
            ? 1_200
            : currentEnergyJ >= 900 ? 620 : 480;
      const hitRadiusM = profile === 'HEAVY_50AE_SLUG' ? 0.035 : DEFAULT_WOOD_STUD_WIDTH_M * 0.55;
      damageInteriorStudSections(
        physicsWorld,
        splinterPools,
        nextRand,
        wall,
        internal,
        u,
        v,
        hitRadiusM,
        hitRadiusM,
        studDamageHp,
        unitDir,
        exitSignZ,
        currentEnergyJ,
      );
    } else {
      effectiveMaterial = 'WOOD_DRYWALL';
      const basePanelJ = seg.isArmorPiercing ? 115 : profile === 'BUCKSHOT_PELLET' ? 124 : 144;
      energyLossJ = basePanelJ * effectiveThicknessScale * obliquity;
    }

    if (currentEnergyJ <= energyLossJ || currentEnergyJ <= 1e-4) {
      currentEnergyJ = 0;
      currentSpeedMs = 0;
      stopped = true;
      break;
    }

    const nextEnergyJ = currentEnergyJ - energyLossJ;
    if (seg.kineticEnergyJ > 1e-6) {
      currentSpeedMs = seg.speedMs * Math.sqrt(Math.max(0, nextEnergyJ / seg.kineticEnergyJ));
    }
    currentEnergyJ = nextEnergyJ;
  }

  return {
    remainingEnergyJ: currentEnergyJ,
    remainingSpeedMs: currentSpeedMs,
    stopped,
    impactPointWorld: firstImpactPoint,
    impactNormalWorld: firstImpactNormal,
    hitMaterial: effectiveMaterial,
  };
}

export function applyWoodWallRadialBlast(
  physicsWorld: RapierPhysicsWorld,
  walls: readonly WoodWallInstance[],
  internalByWallId: ReadonlyMap<string, WallInternalState>,
  splinterPools: readonly HardwareInstancedPool[],
  nextRand: () => number,
  blast: BlastEvent,
): void {
  if (blast.radiusM <= 0 || blast.peakEnergyJ <= 0 || walls.length === 0) return;

  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i];
    const internal = internalByWallId.get(wall.id);
    if (internal) {
      internal.activeVolley = null;
    }

    const rx = blast.centerWorld.x - wall.centerWorld.x;
    const ry = blast.centerWorld.y - wall.centerWorld.y;
    const rz = blast.centerWorld.z - wall.centerWorld.z;

    const localX = rx * wall.cosYaw - rz * wall.sinYaw;
    const localY = ry;
    const localZ = rx * wall.sinYaw + rz * wall.cosYaw;

    const halfW = wall.widthM * 0.5;
    const halfH = wall.heightM * 0.5;

    const clampedX = Math.max(-halfW, Math.min(halfW, localX));
    const clampedY = Math.max(-halfH, Math.min(halfH, localY));

    const dx = localX - clampedX;
    const dy = localY - clampedY;
    const dz = localZ;
    const distToPanel = Math.hypot(dx, dy, dz);

    if (distToPanel > blast.radiusM) continue;

    const proximity = Math.max(0, 1 - distToPanel / blast.radiusM);
    const energyScale = Math.min(2.0, Math.max(0.55, Math.sqrt(blast.peakEnergyJ / 6000)));
    const breachRadiusM = Math.max(
      0.24,
      Math.min(Math.max(wall.widthM, wall.heightM) * 0.65, (0.28 + 0.52 * proximity) * energyScale),
    );

    const hitU = clampedX + halfW;
    const hitV = clampedY + halfH;
    const awaySignZ = localZ >= 0 ? -1 : 1;

    if (internal && blast.peakEnergyJ * proximity >= 1_800) {
      const awayDir: Vec3Like = {
        x: awaySignZ * wall.sinYaw,
        y: 0.2,
        z: awaySignZ * wall.cosYaw,
      };
      damageInteriorStudSections(
        physicsWorld,
        splinterPools,
        nextRand,
        wall,
        internal,
        hitU,
        hitV,
        breachRadiusM * 0.85,
        breachRadiusM * 0.85,
        1_600,
        awayDir,
        awaySignZ,
        blast.peakEnergyJ,
      );
    }

    const stamp = createJaggedHoleStamp({
      u: hitU,
      v: hitV,
      caliberRadiusM: 0.04,
      kineticEnergyJ: blast.peakEnergyJ,
      profile: 'BLAST_BREACH',
      seed: wall.panelState.shotCount + 101,
      overrideRadiusM: breachRadiusM,
    });

    const subRes = stampHoleInWoodPanel(wall.panelState, stamp, wall.scratchBuffers, 6);
    if (subRes.cutAnyWood) {
      uploadWallPanelMesh(wall, subRes.meshStats);
    }

    spawnBlastSplinterShower(
      splinterPools,
      nextRand,
      wall,
      hitU,
      hitV,
      Math.min(breachRadiusM, 0.45),
      blast.centerWorld,
      awaySignZ,
      30,
      proximity,
    );
  }
}
