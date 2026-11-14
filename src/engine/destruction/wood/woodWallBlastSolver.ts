import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { BlastEvent } from '../../../contracts/destruction.ts';
import {
  createJaggedHoleStamp,
} from '../../../core/destruction/woodPolygonClipper.ts';
import { cutStampFromWoodPanel } from '../../../core/destruction/wood/clipperBooleanSolver.ts';
import {
  BLAST_REACH_SCALE,
  blastLocalEnergyJ,
  blastReachForEnergyM,
} from '../../../core/destruction/blastFalloff.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { markWallPanelMeshDirty } from './woodPanelMeshSync.ts';
import { resetPelletVolley } from './buckshotVolleyTracker.ts';
import { damageInteriorStudSections } from './woodStudDamageSolver.ts';
import { spawnBlastSplinterShower } from './woodSplinterEmitter.ts';
import type { WoodSlabDynamicPool } from './woodSlabDynamicPool.ts';
import type { WallInternalState, WoodWallInstance } from './woodWallTypes.ts';

/**
 * Local blast energy (J) that blows out plank sheathing / a 2x4 stud section.
 * Both sit well below a brick's ~870 J (100 HP / 0.115 J->HP), so a blast that
 * clears bricks always clears wood framing at the same distance and further.
 */
const WOOD_PANEL_BLAST_BREAK_J = 380;
const WOOD_STUD_BLAST_BREAK_J = 650;
/** Fringe energy that still splinters a small hole even where nothing breaks clean. */
const WOOD_PANEL_BLAST_FRINGE_J = 120;
const MIN_BLAST_BREACH_RADIUS_M = 0.24;
const BLAST_STUD_DAMAGE_HP = 1_800;

/** Radius on the wall plane, around the closest point, where blast energy reaches `thresholdJ`. */
function breachRadiusOnPlaneM(blast: BlastEvent, distToPanelM: number, thresholdJ: number): number {
  const reachM = blastReachForEnergyM(blast.peakEnergyJ, blast.radiusM, thresholdJ);
  if (reachM <= distToPanelM) return 0;
  return Math.sqrt(reachM * reachM - distToPanelM * distToPanelM);
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
      resetPelletVolley(internal);
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

    if (distToPanel >= blast.radiusM * BLAST_REACH_SCALE) continue;
    if (blastLocalEnergyJ(blast.peakEnergyJ, blast.radiusM, distToPanel) < WOOD_PANEL_BLAST_FRINGE_J) continue;

    const maxBreachRadiusM = Math.hypot(wall.widthM, wall.heightM);
    const breachRadiusM = Math.min(
      maxBreachRadiusM,
      Math.max(MIN_BLAST_BREACH_RADIUS_M, breachRadiusOnPlaneM(blast, distToPanel, WOOD_PANEL_BLAST_BREAK_J)),
    );
    const studBreachRadiusM = Math.min(
      maxBreachRadiusM,
      breachRadiusOnPlaneM(blast, distToPanel, WOOD_STUD_BLAST_BREAK_J),
    );
    const proximity = Math.max(0, 1 - distToPanel / (blast.radiusM * BLAST_REACH_SCALE));

    const hitU = clampedX + halfW;
    const hitV = clampedY + halfH;
    const awaySignZ = localZ >= 0 ? -1 : 1;

    if (internal && studBreachRadiusM > 0) {
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
        studBreachRadiusM,
        studBreachRadiusM,
        BLAST_STUD_DAMAGE_HP,
        awayDir,
        awaySignZ,
        blast.peakEnergyJ,
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

    const subRes = cutStampFromWoodPanel(wall.panelState, stamp, 6);
    if (subRes.cutAnyWood) {
      markWallPanelMeshDirty(wall);
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
