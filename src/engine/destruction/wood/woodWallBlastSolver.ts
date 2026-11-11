import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { BlastEvent } from '../../../contracts/destruction.ts';
import {
  createJaggedHoleStamp,
  stampHoleInWoodPanel,
  type WoodMeshBuildStats,
} from '../../../core/destruction/woodPolygonClipper.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { damageInteriorStudSections } from './woodStudDamageSolver.ts';
import { spawnBlastSplinterShower } from './woodSplinterEmitter.ts';
import type { WoodSlabDynamicPool } from './woodSlabDynamicPool.ts';
import type { WallInternalState, WoodWallInstance } from './woodWallTypes.ts';

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

export function applyWoodWallRadialBlast(
  physicsWorld: RapierPhysicsWorld,
  walls: readonly WoodWallInstance[],
  internalByWallId: ReadonlyMap<string, WallInternalState>,
  splinterPools: readonly HardwareInstancedPool[],
  nextRand: () => number,
  blast: BlastEvent,
  slabPool?: WoodSlabDynamicPool,
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

    if (internal && blast.peakEnergyJ * proximity >= 850) {
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
        breachRadiusM * 0.92,
        breachRadiusM * 0.92,
        Math.max(1_150, 1_800 * proximity),
        awayDir,
        awaySignZ,
        blast.peakEnergyJ,
        uploadWallPanelMesh,
        slabPool,
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
      const awayDir: Vec3Like = {
        x: awaySignZ * wall.sinYaw,
        y: 0.25,
        z: awaySignZ * wall.cosYaw,
      };
      slabPool?.spawnDroppedSlabs(wall, subRes.droppedSlabs, awayDir, awaySignZ, blast.peakEnergyJ, nextRand);
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
