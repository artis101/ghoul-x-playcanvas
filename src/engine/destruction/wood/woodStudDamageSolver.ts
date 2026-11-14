import type { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  createJaggedHoleStamp,
  type SplinterSpawnDescriptor,
} from '../../../core/destruction/woodPolygonClipper.ts';
import {
  cutStampFromWoodPanel,
  detachUnanchoredWoodShells,
} from '../../../core/destruction/wood/clipperBooleanSolver.ts';
import { markWallPanelMeshDirty } from './woodPanelMeshSync.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import {
  type BuckshotClusterTier,
  DEFAULT_WOOD_STUD_WIDTH_M,
  MEDIUM_BUCKSHOT_CLUSTER_RADIUS_M,
  TIGHT_BUCKSHOT_CLUSTER_RADIUS_M,
  type PelletVolleyState,
  type WallInternalState,
  type WoodWallInstance,
} from './woodWallTypes.ts';
import { findBestPelletCluster } from './buckshotVolleyTracker.ts';
import { collapseFloatingStudSections } from './woodStudFrameBuilder.ts';
import {
  buildStudAnchorsFromColumns,
  rebuildWallStudColliders,
  uploadWallStudFrameMesh,
} from './woodStudColliderSync.ts';
import { spawnPerimeterSplinters, spawnPlankChunkBurst } from './woodSplinterEmitter.ts';
import type { WoodSlabDynamicPool } from './woodSlabDynamicPool.ts';

export function damageInteriorStudSections(
  physicsWorld: RapierPhysicsWorld,
  splinterPools: readonly HardwareInstancedPool[],
  nextRand: () => number,
  wall: WoodWallInstance,
  internal: WallInternalState,
  centerU: number,
  centerV: number,
  radiusU: number,
  radiusV: number,
  damageHp: number,
  impulseDirWorld: Vec3Like,
  exitSignZ: number,
  energyJ: number,
  slabPool?: WoodSlabDynamicPool,
): boolean {
  if (damageHp <= 0) return false;
  const halfStudW = DEFAULT_WOOD_STUD_WIDTH_M * 0.5;
  let brokeAnySection = false;

  const emitStudSectionBreakFx = (colU: number, vMin: number, vMax: number): void => {
    const midV = (vMin + vMax) * 0.5;
    const burstDesc: SplinterSpawnDescriptor[] = [];
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      burstDesc.push({
        u: colU + (nextRand() - 0.5) * DEFAULT_WOOD_STUD_WIDTH_M,
        v: midV + (nextRand() - 0.5) * (vMax - vMin) * 0.7,
        tangentU: (nextRand() - 0.5) * 0.35,
        tangentV: k % 2 === 0 ? 1 : -1,
        radialU: Math.cos(ang),
        radialV: Math.sin(ang),
        lengthM: 0.11 + nextRand() * 0.11,
      });
    }
    spawnPerimeterSplinters(
      splinterPools,
      nextRand,
      wall,
      burstDesc,
      impulseDirWorld,
      exitSignZ,
      Math.max(900, energyJ),
    );
  };

  for (let i = 0; i < internal.studColumns.length; i++) {
    const col = internal.studColumns[i];
    if (col.isBorderPost) continue;
    if (Math.abs(centerU - col.u) > halfStudW + radiusU) continue;

    let colBroke = false;
    for (let s = 0; s < col.sections.length; s++) {
      const sec = col.sections[s];
      if (sec.broken) continue;
      if (centerV + radiusV < sec.vMin || centerV - radiusV > sec.vMax) continue;

      sec.hp -= damageHp;
      if (sec.hp <= 0) {
        sec.hp = 0;
        sec.broken = true;
        brokeAnySection = true;
        colBroke = true;
        emitStudSectionBreakFx(col.u, sec.vMin, sec.vMax);
      }
    }

    if (colBroke) {
      const collapsedFloating = collapseFloatingStudSections(col);
      for (let c = 0; c < collapsedFloating.length; c++) {
        const sec = col.sections[collapsedFloating[c]];
        emitStudSectionBreakFx(col.u, sec.vMin, sec.vMax);
      }
    }
  }

  if (brokeAnySection) {
    wall.panelState.studAnchors = buildStudAnchorsFromColumns(internal.studColumns);
    rebuildWallStudColliders(physicsWorld, wall, internal);
    uploadWallStudFrameMesh(wall, internal);

    const recheck = detachUnanchoredWoodShells(wall.panelState, 6);
    if (recheck.cutAnyWood) {
      markWallPanelMeshDirty(wall);
      spawnPerimeterSplinters(
        splinterPools,
        nextRand,
        wall,
        recheck.splinters,
        impulseDirWorld,
        exitSignZ,
        Math.max(700, energyJ),
      );
      slabPool?.spawnDroppedSlabs(
        wall,
        recheck.droppedSlabs,
        impulseDirWorld,
        exitSignZ,
        Math.max(700, energyJ),
        nextRand,
      );
    }
  }

  return brokeAnySection;
}

const CLUSTER_TIER_RANK: Readonly<Record<BuckshotClusterTier, number>> = {
  NONE: 0,
  MEDIUM_3: 1,
  TIGHT_5: 2,
  TIGHT_8: 3,
};

const CLUSTER_TIER_TARGET_STUD_DAMAGE_HP: Readonly<Record<BuckshotClusterTier, number>> = {
  NONE: 0,
  MEDIUM_3: 600,
  TIGHT_5: 1_250,
  TIGHT_8: 1_250,
};

export function tryApplyBuckshotClusterBlowout(
  physicsWorld: RapierPhysicsWorld,
  splinterPools: readonly HardwareInstancedPool[],
  nextRand: () => number,
  wall: WoodWallInstance,
  internal: WallInternalState,
  volley: PelletVolleyState,
  caliberRadiusM: number,
  slabPool?: WoodSlabDynamicPool,
): void {
  if (volley.impacts.length < 3) return;
  const lastImp = volley.impacts[volley.impacts.length - 1];

  const tight = findBestPelletCluster(volley.impacts, TIGHT_BUCKSHOT_CLUSTER_RADIUS_M);
  if (tight.count >= 5) {
    const targetTier: BuckshotClusterTier = tight.count >= 8 ? 'TIGHT_8' : 'TIGHT_5';
    if (CLUSTER_TIER_RANK[targetTier] <= CLUSTER_TIER_RANK[volley.tier]) return;
    volley.tier = targetTier;

    const targetDamageHp = CLUSTER_TIER_TARGET_STUD_DAMAGE_HP[targetTier];
    const deltaStudDamageHp = Math.max(0, targetDamageHp - volley.appliedStudDamageHp);
    volley.appliedStudDamageHp += deltaStudDamageHp;

    const pelletFrac = Math.min(1, (tight.count - 3) / 6);
    const tightnessBonus = Math.max(0, 1 - tight.maxSpreadM / TIGHT_BUCKSHOT_CLUSTER_RADIUS_M);
    const clusterRadiusM = Math.min(0.27, Math.max(0.19 + 0.055 * pelletFrac + 0.02 * tightnessBonus, tight.maxSpreadM * 1.15 + 0.045));

    if (deltaStudDamageHp > 0) {
      damageInteriorStudSections(
        physicsWorld,
        splinterPools,
        nextRand,
        wall,
        internal,
        tight.centerU,
        tight.centerV,
        clusterRadiusM * 0.78,
        clusterRadiusM * 0.85,
        deltaStudDamageHp,
        lastImp.dirWorld,
        lastImp.exitSignZ,
        lastImp.energyJ * tight.count,
        slabPool,
      );
    }

    const clusterStamp = createJaggedHoleStamp({
      u: tight.centerU,
      v: tight.centerV,
      caliberRadiusM,
      kineticEnergyJ: lastImp.energyJ * tight.count,
      profile: 'BUCKSHOT_CLUSTER',
      seed: wall.panelState.shotCount + 31,
      overrideRadiusM: clusterRadiusM,
      grainStretchOverride: 1.44,
    });

    const subRes = cutStampFromWoodPanel(wall.panelState, clusterStamp, targetTier === 'TIGHT_8' ? 8 : 11);
    volley.clusterCuts.push({ u: tight.centerU, v: tight.centerV, cutRadiusM: clusterRadiusM * 1.48 });

    if (subRes.cutAnyWood) {
      markWallPanelMeshDirty(wall);
      spawnPerimeterSplinters(splinterPools, nextRand, wall, subRes.splinters, lastImp.dirWorld, lastImp.exitSignZ, lastImp.energyJ * 4.5);
      slabPool?.spawnDroppedSlabs(wall, subRes.droppedSlabs, lastImp.dirWorld, lastImp.exitSignZ, lastImp.energyJ * 4.5, nextRand);
      spawnPlankChunkBurst(splinterPools, nextRand, wall, tight.centerU, tight.centerV, clusterRadiusM, lastImp.dirWorld, lastImp.exitSignZ, lastImp.energyJ * 5.0, targetTier === 'TIGHT_8' ? 5 : 9);
    }
    return;
  }

  if (CLUSTER_TIER_RANK[volley.tier] < CLUSTER_TIER_RANK.MEDIUM_3) {
    const med = findBestPelletCluster(volley.impacts, MEDIUM_BUCKSHOT_CLUSTER_RADIUS_M);
    if (med.count >= 3) {
      volley.tier = 'MEDIUM_3';
      const targetDamageHp = CLUSTER_TIER_TARGET_STUD_DAMAGE_HP.MEDIUM_3;
      const deltaStudDamageHp = Math.max(0, targetDamageHp - volley.appliedStudDamageHp);
      volley.appliedStudDamageHp += deltaStudDamageHp;

      const clusterRadiusM = Math.min(0.17, Math.max(0.12 + 0.012 * (med.count - 3), med.maxSpreadM * 0.80 + 0.032));

      if (deltaStudDamageHp > 0) {
        damageInteriorStudSections(
          physicsWorld,
          splinterPools,
          nextRand,
          wall,
          internal,
          med.centerU,
          med.centerV,
          clusterRadiusM * 0.55,
          clusterRadiusM * 0.65,
          deltaStudDamageHp,
          lastImp.dirWorld,
          lastImp.exitSignZ,
          lastImp.energyJ * med.count,
          slabPool,
        );
      }

      const clusterStamp = createJaggedHoleStamp({
        u: med.centerU,
        v: med.centerV,
        caliberRadiusM,
        kineticEnergyJ: lastImp.energyJ * med.count,
        profile: 'BUCKSHOT_CLUSTER',
        seed: wall.panelState.shotCount + 17,
        overrideRadiusM: clusterRadiusM,
        grainStretchOverride: 1.38,
      });

      const subRes = cutStampFromWoodPanel(wall.panelState, clusterStamp, 7);
      volley.clusterCuts.push({ u: med.centerU, v: med.centerV, cutRadiusM: clusterRadiusM * 1.42 });

      if (subRes.cutAnyWood) {
        markWallPanelMeshDirty(wall);
        spawnPerimeterSplinters(splinterPools, nextRand, wall, subRes.splinters, lastImp.dirWorld, lastImp.exitSignZ, lastImp.energyJ * 3.0);
        slabPool?.spawnDroppedSlabs(wall, subRes.droppedSlabs, lastImp.dirWorld, lastImp.exitSignZ, lastImp.energyJ * 3.0, nextRand);
        spawnPlankChunkBurst(splinterPools, nextRand, wall, med.centerU, med.centerV, clusterRadiusM, lastImp.dirWorld, lastImp.exitSignZ, lastImp.energyJ * 3.2, 4);
      }
    }
  }
}
