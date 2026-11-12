import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  DestructibleMaterialKind,
  PenetrationRayHit,
} from '../../../contracts/destruction.ts';
import {
  createJaggedHoleStamp,
  inferWoodStampProfile,
  isPointInOpenHole,
  stampHoleInWoodPanel,
  type SplinterSpawnDescriptor,
} from '../../../core/destruction/woodPolygonClipper.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  acquirePelletVolley,
  resetPelletVolley,
  wasPointCutByCurrentVolley,
} from './buckshotVolleyTracker.ts';
import { isPointOverIntactStud } from './woodStudColliderSync.ts';
import {
  damageInteriorStudSections,
  tryApplyBuckshotClusterBlowout,
} from './woodStudDamageSolver.ts';
import {
  spawnPerimeterSplinters,
  spawnPlankChunkBurst,
} from './woodSplinterEmitter.ts';
import {
  applyWoodWallRadialBlast,
  uploadWallPanelMesh,
} from './woodWallBlastSolver.ts';
import type { WoodSlabDynamicPool } from './woodSlabDynamicPool.ts';
import {
  DEFAULT_WOOD_STUD_WIDTH_M,
  type WallInternalState,
  type WoodWallInstance,
} from './woodWallTypes.ts';

export { applyWoodWallRadialBlast, uploadWallPanelMesh };

function worldPointToWallUv(wall: WoodWallInstance, pointWorld: Vec3Like): { u: number; v: number } {
  const rx = pointWorld.x - wall.centerWorld.x;
  const rz = pointWorld.z - wall.centerWorld.z;
  const localX = rx * wall.cosYaw - rz * wall.sinYaw;
  const localY = pointWorld.y - wall.centerWorld.y;
  return {
    u: localX + wall.widthM * 0.5,
    v: localY + wall.heightM * 0.5,
  };
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
  slabPool?: WoodSlabDynamicPool,
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
    { wall: WoodWallInstance; primaryHit: PenetrationRayHit; studHit: PenetrationRayHit | null }
  >();

  for (let i = 0; i < allHits.length; i++) {
    const hit = allHits[i];
    const wall = wallsById.get(hit.surface.objectId);
    if (!wall) continue;

    let group = wallHitGroups.get(wall.id);
    if (!group) {
      group = {
        wall,
        primaryHit: hit,
        studHit: hit.surface.material === 'WOOD_STUD' ? hit : null,
      };
      wallHitGroups.set(wall.id, group);
      orderedWallIds.push(wall.id);
    } else if (hit.surface.material === 'WOOD_STUD' && !group.studHit) {
      group.studHit = hit;
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
      firstImpactPoint = (group.studHit ?? primaryHit).pointWorld;
      firstImpactNormal = (group.studHit ?? primaryHit).normalWorld;
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
    const midplaneOverStud = isPointOverIntactStud(wall, internal, u, v);
    const studHitUv = group.studHit ? worldPointToWallUv(wall, group.studHit.pointWorld) : null;
    const colliderOverStud =
      studHitUv !== null && isPointOverIntactStud(wall, internal, studHitUv.u, studHitUv.v, 0.008);

    let hitStud = midplaneOverStud || colliderOverStud;
    let studDamageU = midplaneOverStud || !studHitUv ? u : studHitUv.u;
    let studDamageV = midplaneOverStud || !studHitUv ? v : studHitUv.v;

    const rawAlreadyOpen =
      wall.lastMeshStats.indexCount <= 0 || isPointInOpenHole(wall.panelState, u, v);
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
            slabPool?.spawnDroppedSlabs(wall, subRes.droppedSlabs, unitDir, exitSignZ, currentEnergyJ, nextRand);
          }
        }

        volley.impacts.push({ u, v, cutRadiusM: 0.052, energyJ: currentEnergyJ, dirWorld: unitDir, exitSignZ });
        tryApplyBuckshotClusterBlowout(physicsWorld, splinterPools, nextRand, uploadWallPanelMesh, wall, internal, volley, seg.caliberRadiusM, slabPool);

        if (
          hitStud &&
          !isPointOverIntactStud(wall, internal, studDamageU, studDamageV, 0.008)
        ) {
          hitStud = false;
        }
      }
    } else {
      resetPelletVolley(internal);

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
          const spawnedSlabs = slabPool
            ? slabPool.spawnDroppedSlabs(wall, subResult.droppedSlabs, unitDir, exitSignZ, currentEnergyJ, nextRand)
            : 0;
          if (subResult.droppedIslandAreaM2 > 0.004 && spawnedSlabs === 0) {
            spawnPlankChunkBurst(splinterPools, nextRand, wall, u, v, 0.09, unitDir, exitSignZ, currentEnergyJ, 4);
          }
        }
      }
    }

    if (alreadyOpenBeforeThisShot && hitStud) {
      const studSplinters: SplinterSpawnDescriptor[] = [];
      const clampedU = Math.max(0, Math.min(wall.widthM, studDamageU));
      const clampedV = Math.max(0, Math.min(wall.heightM, studDamageV));
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
        studDamageU,
        studDamageV,
        hitRadiusM,
        hitRadiusM,
        studDamageHp,
        unitDir,
        exitSignZ,
        currentEnergyJ,
        uploadWallPanelMesh,
        slabPool,
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
