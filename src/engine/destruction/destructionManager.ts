import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  ColliderSurfaceTag,
  DestructibleMaterialKind,
  PenetrationRayHit,
} from '../../contracts/destruction.ts';
import { add, distance, length, normalize, scale, sub, vec3 } from '../../core/ballistics/vec3.ts';
import {
  computePanelRemainingAreaM2,
  isPointInOpenHole,
} from '../../core/destruction/woodPolygonClipper.ts';
import type { ImportedVoronoiChunkMesh } from '../../core/destruction/voronoiWallGenerator.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import type { CombatAudioEngine } from '../audio/combatAudioEngine.ts';
import type { EnvironmentRayInterceptResult } from '../combat/combatDirector.ts';
import type { ExplosiveBarrelManager } from '../fx/mayhemDirector.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { DESTRUCTION_ZONE_LAYOUT } from '../world/arenaBuilder.ts';
import { BrickWallSystem, type BrickWallSystemOptions } from './brickWallSystem.ts';
import { ConcreteWallSystem } from './concreteWallSystem.ts';
import { GlassSystem } from './glassSystem.ts';
import { PomCraterDecalSystem } from './pomCraterDecals.ts';
import { WoodWallSystem, type WoodWallSystemOptions } from './woodWallSystem.ts';

export interface DestructionManagerOptions {
  readonly materials?: EngineMaterialPalette;
  readonly barrelManager?: ExplosiveBarrelManager | null;
  readonly combatAudio?: CombatAudioEngine | null;
  readonly getListenerPos?: () => Vec3Like;
  readonly woodOptions?: WoodWallSystemOptions;
  readonly brickOptions?: BrickWallSystemOptions;
  /** Automatically build default breaching arena cover stations on construction (default true) */
  readonly buildDefaultArena?: boolean;
}

interface StaticCoverFixture {
  readonly objectId: string;
  readonly colliderHandle: number;
  readonly entity: pc.Entity;
}

function extractImportedVoronoiChunkMesh(
  mesh: pc.Mesh,
  name: string,
): ImportedVoronoiChunkMesh {
  const rawPos: number[] = [];
  const rawNorm: number[] = [];
  const rawUv: number[] = [];
  const rawIdx: number[] = [];

  mesh.getPositions(rawPos);
  mesh.getNormals(rawNorm);
  mesh.getUvs(0, rawUv);
  mesh.getIndices(rawIdx);

  const vertCount = Math.floor(rawPos.length / 3);
  const positions = new Float32Array(rawPos);
  const normals =
    rawNorm.length === rawPos.length
      ? new Float32Array(rawNorm)
      : new Float32Array(vertCount * 3);
  if (rawNorm.length !== rawPos.length) {
    for (let i = 1; i < normals.length; i += 3) {
      normals[i] = 1;
    }
  }

  const uvs =
    rawUv.length === vertCount * 2 ? new Float32Array(rawUv) : undefined;
  const indices = new Uint32Array(rawIdx);

  return {
    name,
    positions,
    normals,
    uvs,
    indices,
    positionsAreWallLocal: false,
  };
}

/**
 * Coordinates all Wave-2 destructible cover & hazard subsystems inside the shared `RapierPhysicsWorld`:
 * 1. R6 Clipper2/Earcut Wood & 2x4 Stud Shoot-House Wall (`WoodWallSystem`)
 * 2. 256 Marching-Squares Atlas Window & Runtime Delaunator Voronoi Glass Window (`GlassSystem`)
 * 3. Running-Bond Hardware-Instanced Masonry Brick Wall (`BrickWallSystem`)
 * 4. PlayCanvas 2.4 `setMultiDraw` 36-Cell Voronoi Concrete Barrier (`ConcreteWallSystem` + `PomCraterDecalSystem`)
 * 5. Shootable Explosive Red Hazard Barrels (`ExplosiveBarrelManager`)
 */
export class DestructionManager {
  public readonly app: pc.Application;
  public readonly rapierWorld: RapierPhysicsWorld;
  public readonly pomDecals: PomCraterDecalSystem;
  public readonly woodWalls: WoodWallSystem;
  public readonly glassSystem: GlassSystem;
  public readonly brickWalls: BrickWallSystem;
  public readonly concreteWalls: ConcreteWallSystem;

  public barrelManager: ExplosiveBarrelManager | null;
  public combatAudio: CombatAudioEngine | null;
  public getListenerPos?: () => Vec3Like;

  private readonly rootEntity: pc.Entity;
  private readonly staticFixtures: StaticCoverFixture[] = [];
  private readonly sillConcreteMat: pc.StandardMaterial;
  private ownsSillMaterial = false;
  private glbConcreteApplied = false;
  private blastRecursionDepth = 0;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    rapierWorld: RapierPhysicsWorld,
    options: DestructionManagerOptions = {},
  ) {
    this.app = app;
    this.rapierWorld = rapierWorld;
    this.barrelManager = options.barrelManager ?? null;
    this.combatAudio = options.combatAudio ?? null;
    this.getListenerPos = options.getListenerPos;

    this.rootEntity = new pc.Entity('DestructionArenaRoot');
    this.app.root.addChild(this.rootEntity);

    if (options.materials) {
      this.sillConcreteMat = options.materials.barrierConcreteMat;
      this.ownsSillMaterial = false;
    } else {
      this.sillConcreteMat = new pc.StandardMaterial();
      this.sillConcreteMat.name = 'WindowParapetConcreteMat';
      this.sillConcreteMat.diffuse = new pc.Color(0.32, 0.34, 0.36);
      this.sillConcreteMat.gloss = 0.2;
      this.sillConcreteMat.update();
      this.ownsSillMaterial = true;
    }

    this.pomDecals = new PomCraterDecalSystem(app);
    this.pomDecals.registerConcreteMaterial(this.sillConcreteMat);

    this.woodWalls = new WoodWallSystem(app, rapierWorld, options.woodOptions);
    this.glassSystem = new GlassSystem(app, rapierWorld);
    this.brickWalls = new BrickWallSystem(app, rapierWorld, options.brickOptions);
    this.concreteWalls = new ConcreteWallSystem(app, rapierWorld, {
      pomDecalSystem: this.pomDecals,
    });

    if (options.buildDefaultArena !== false) {
      this.buildBreachingArenaStations();
    }
  }

  /**
   * Builds the tactical Max Mayhem breaching arena across firing lanes `z = -6.5m .. -14m`:
   * - Shoot-house wood & 2x4 stud partition (`z = -7.2m`, left-center lane)
   * - Marching-squares 256 tactical observation window (`z = -6.5m`, west lane)
   * - Runtime Delaunator Voronoi tempered plate window (`z = -6.5m`, east lane)
   * - Staggered running-bond instanced masonry brick wall (`z = -12.5m`, west-mid lane)
   * - 36-cell MultiDraw Voronoi reinforced concrete barrier (`z = -13.5m`, east-mid lane)
   */
  public buildBreachingArenaStations(): void {
    if (this.destroyed) return;

    const layout = DESTRUCTION_ZONE_LAYOUT;

    // 1. R6 Shoot-House Wood & 2x4 Stud Partition
    this.woodWalls.createWall({
      id: layout.woodShootHouseWall.id,
      centerWorld: { ...layout.woodShootHouseWall.center },
      widthM: layout.woodShootHouseWall.widthM,
      heightM: layout.woodShootHouseWall.heightM,
      thicknessM: layout.woodShootHouseWall.thicknessM,
      yawRad: (layout.woodShootHouseWall.yawDeg * Math.PI) / 180,
      studSpacingM: 0.6,
    });

    // 2. West Lane: 256 Marching-Squares Tactical Glass Window + Low Concrete Parapet Sill
    this.glassSystem.createMarchingWindow({
      id: layout.glassMarchingWindow.id,
      centerWorld: { ...layout.glassMarchingWindow.center },
      widthM: layout.glassMarchingWindow.widthM,
      heightM: layout.glassMarchingWindow.heightM,
      thicknessM: layout.glassMarchingWindow.thicknessM,
      gridW: 16,
      gridH: 16,
    });
    this.createWindowParapetSill(
      'window_sill_marching_west',
      layout.glassMarchingWindow.center.x,
      layout.glassMarchingWindow.center.z,
      layout.glassMarchingWindow.widthM,
      Math.max(0.2, layout.glassMarchingWindow.center.y - layout.glassMarchingWindow.heightM * 0.5),
    );

    // 3. East Lane: Runtime Voronoi Tempered Glass Window + Low Concrete Parapet Sill
    this.glassSystem.createVoronoiWindow({
      id: layout.glassVoronoiWindow.id,
      centerWorld: { ...layout.glassVoronoiWindow.center },
      widthM: layout.glassVoronoiWindow.widthM,
      heightM: layout.glassVoronoiWindow.heightM,
      thicknessM: layout.glassVoronoiWindow.thicknessM,
      voronoiShardCount: 42,
    });
    this.createWindowParapetSill(
      'window_sill_voronoi_east',
      layout.glassVoronoiWindow.center.x,
      layout.glassVoronoiWindow.center.z,
      layout.glassVoronoiWindow.widthM,
      Math.max(0.2, layout.glassVoronoiWindow.center.y - layout.glassVoronoiWindow.heightM * 0.5),
    );

    // 4. Staggered Running-Bond Instanced Masonry Brick Wall (base flush at y = 0)
    this.brickWalls.addBrickWall({
      wallId: layout.instancedBrickWall.id,
      position: {
        x: layout.instancedBrickWall.center.x,
        y: 0,
        z: layout.instancedBrickWall.center.z,
      },
      cols: 13,
      rows: 26,
      brickW: 0.215,
      brickH: 0.072,
      brickD: 0.14,
      mortarBreakJ: 650,
      mortarGapM: 0.008,
    });

    // 5. 36-Cell MultiDraw Voronoi Reinforced Concrete Barrier (base flush at y = 0)
    this.concreteWalls.addConcreteWall({
      wallId: layout.voronoiConcreteWall.id,
      position: {
        x: layout.voronoiConcreteWall.center.x,
        y: 0,
        z: layout.voronoiConcreteWall.center.z,
      },
      width: layout.voronoiConcreteWall.widthM,
      height: 2.2,
      depth: layout.voronoiConcreteWall.thicknessM,
      cellCount: 36,
      seed: 1337,
    });
  }

  /**
   * Upgrades the Voronoi concrete barrier in-place with the Blender 5.2 pre-fractured 36-chunk
   * `.glb` meshes + baked `concrete_wall_connectivity.json` once `GlbModelRegistry` finishes loading,
   * provided the wall has not already been partially blown apart mid-combat.
   */
  public upgradeWithGlbAssets(glbRegistry: GlbModelRegistry): boolean {
    if (
      this.destroyed ||
      this.glbConcreteApplied ||
      !glbRegistry.isLoaded('concrete_wall_fractured')
    ) {
      return false;
    }

    const wallId = DESTRUCTION_ZONE_LAYOUT.voronoiConcreteWall.id;
    const existing = this.concreteWalls.getWall(wallId);
    if (existing && existing.detachedChunkCount > 0) {
      return false;
    }

    try {
      const bundle = glbRegistry.getFracturedConcreteWallBundle();
      const importedMeshes: ImportedVoronoiChunkMesh[] = bundle.chunkMeshes.map((m, idx) =>
        extractImportedVoronoiChunkMesh(
          m,
          bundle.connectivity.nodes[idx]?.name ?? `Chunk_${String(idx).padStart(2, '0')}`,
        ),
      );

      this.concreteWalls.addConcreteWall({
        wallId,
        position: {
          x: DESTRUCTION_ZONE_LAYOUT.voronoiConcreteWall.center.x,
          y: 0,
          z: DESTRUCTION_ZONE_LAYOUT.voronoiConcreteWall.center.z,
        },
        importedChunks: {
          meshes: importedMeshes,
          connectivity: {
            ...bundle.connectivity,
            wallId,
          },
        },
      });
      this.glbConcreteApplied = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sequential multi-layer ballistic penetration ray interceptor compatible with `CombatDirector`.
   * Steps front-to-back across every destructible cover station / hazard barrel intersected along
   * `[origin, origin + dir * maxDistM]`, computing exact residual energy/speed and triggering
   * 3D spatial material fracture/ricochet audio.
   */
  public interceptRaySegment(
    origin: Vec3Like,
    dir: Vec3Like,
    maxDistM: number,
    energyJ: number,
    speedMs: number,
    caliberDiameterM: number,
    isAp: boolean,
  ): EnvironmentRayInterceptResult {
    if (this.destroyed || maxDistM <= 0 || energyJ <= 0 || speedMs <= 0) {
      return {
        remainingEnergyJ: Math.max(0, energyJ),
        remainingSpeedMs: Math.max(0, speedMs),
        blocked: energyJ <= 0 || speedMs <= 0,
      };
    }

    const normDir = normalize(dir);
    const rawHits = this.rapierWorld.castPenetrationRay(origin, normDir, maxDistM);
    if (rawHits.length === 0) {
      return {
        remainingEnergyJ: energyJ,
        remainingSpeedMs: speedMs,
        blocked: false,
      };
    }

    const massKg = (2 * energyJ) / Math.max(1, speedMs * speedMs);
    const caliberRadiusM = Math.max(0.002, caliberDiameterM * 0.5);

    // Group ordered hits by (subsystemKind, objectId) so composite walls (drywall + internal 2x4 stud)
    // are evaluated once in ascending distance order with a tight window spanning that object.
    const orderedObjects: Array<{
      readonly key: string;
      readonly firstHit: PenetrationRayHit;
      lastDistM: number;
    }> = [];
    const indexByKey = new Map<string, number>();

    for (let i = 0; i < rawHits.length; i++) {
      const h = rawHits[i];
      if (h.distanceM > maxDistM) continue;
      const groupKind = this.classifyHitGroup(h.surface);
      const key = `${groupKind}:${h.surface.objectId}`;
      const existingIdx = indexByKey.get(key);
      if (existingIdx !== undefined) {
        orderedObjects[existingIdx].lastDistM = Math.max(
          orderedObjects[existingIdx].lastDistM,
          h.distanceM,
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
    const listenerPos = this.getListenerPos
      ? this.getListenerPos()
      : { x: 0, y: 1.62, z: 0 };

    for (let i = 0; i < orderedObjects.length; i++) {
      const entry = orderedObjects[i];
      const hit = entry.firstHit;
      const startDistM = Math.max(0, hit.distanceM - 0.06);
      const endDistM = Math.min(
        maxDistM + 0.04,
        entry.lastDistM + Math.max(0.18, hit.surface.thicknessM + 0.14),
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
      const res = this.dispatchSubsystemRaySegment(hit, seg);
      if (!res) {
        continue;
      }

      const energyLost = energyBefore - res.remainingEnergyJ;
      if (energyLost > 1.0 || res.stopped) {
        const audioMat: DestructibleMaterialKind =
          res.hitMaterial ?? hit.surface.material;
        const audioPt = res.impactPointWorld ?? hit.pointWorld;
        this.combatAudio?.playMaterialImpact(
          audioMat,
          audioPt,
          energyBefore,
          listenerPos,
        );
      }

      curEnergyJ = Math.max(0, res.remainingEnergyJ);
      curSpeedMs =
        res.remainingSpeedMs > 0
          ? res.remainingSpeedMs
          : curEnergyJ > 0 && massKg > 1e-7
            ? Math.sqrt((2 * curEnergyJ) / massKg)
            : 0;

      if (res.stopped || curEnergyJ <= 10 || curSpeedMs <= 25) {
        return {
          remainingEnergyJ: 0,
          remainingSpeedMs: 0,
          blocked: true,
        };
      }
    }

    return {
      remainingEnergyJ: curEnergyJ,
      remainingSpeedMs: curSpeedMs,
      blocked: false,
    };
  }

  /**
   * Breach-aware visual line-of-sight query across `[fromWorld, toWorld]`:
   * - Casts across `[0, dist - 0.02]` so hugging cover (`< 0.10m` away) still reliably blocks sight.
   * - Intact opaque cover (`CONCRETE_*`, `BRICK_MASONRY`, `STEEL`, `WOOD_STUD`) always blocks sight.
   * - `WOOD_DRYWALL` blocks sight UNLESS the ray passes through an already blown-open Clipper2 hole.
   * - Transparent glass (`GLASS_MARCHING_256`, `GLASS_VORONOI`) does NOT block visual sight.
   */
  public isLineOfSightBlocked(fromWorld: Vec3Like, toWorld: Vec3Like): boolean {
    if (this.destroyed) return false;

    const delta = sub(toWorld, fromWorld);
    const dist = length(delta);
    if (dist <= 0.05) return false;

    const dir = scale(delta, 1 / dist);
    const maxDist = Math.max(0.01, dist - 0.02);
    const hits = this.rapierWorld.castPenetrationRay(fromWorld, dir, maxDist);

    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.distanceM > maxDist) continue;
      const mat = h.surface.material;

      if (mat === 'GLASS_MARCHING_256' || mat === 'GLASS_VORONOI') {
        continue;
      }

      if (mat === 'WOOD_DRYWALL') {
        if (
          this.isWoodWallRayInOpenHole(
            h.surface.objectId,
            fromWorld,
            dir,
            maxDist,
            h.pointWorld,
          )
        ) {
          continue;
        }
        return true;
      }

      return true;
    }

    return false;
  }

  /**
   * Intercepts an enemy bullet segment `[origin, origin + normDir * maxDistM]` against arena cover:
   * - Passes cleanly through blown-open breaches in wood/brick/concrete walls.
   * - Fractures/shatters glass windows when enemies fire through glass panes.
   * - Stops enemy rounds on intact solid cover (`CONCRETE_*`, `BRICK_MASONRY`, `STEEL`, `WOOD_STUD`,
   *   and intact `WOOD_DRYWALL`), stamping POM craters / splinters without unfair wallbang damage.
   */
  public interceptEnemyShot(
    origin: Vec3Like,
    dir: Vec3Like,
    maxDistM: number,
    kineticEnergyJ = 460,
  ): { blocked: boolean; impactPointWorld?: Vec3Like } {
    if (this.destroyed || maxDistM <= 0) {
      return { blocked: false };
    }

    const normDir = normalize(dir);
    const rawHits = this.rapierWorld.castPenetrationRay(origin, normDir, maxDistM);
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
      const groupKind = this.classifyHitGroup(h.surface);
      const key = `${groupKind}:${h.surface.objectId}`;
      const existingIdx = indexByKey.get(key);
      if (existingIdx !== undefined) {
        orderedObjects[existingIdx].lastDistM = Math.max(
          orderedObjects[existingIdx].lastDistM,
          h.distanceM,
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
    const listenerPos = this.getListenerPos
      ? this.getListenerPos()
      : { x: 0, y: 1.62, z: 0 };

    for (let i = 0; i < orderedObjects.length; i++) {
      const entry = orderedObjects[i];
      const hit = entry.firstHit;
      const mat = hit.surface.material;
      const objId = hit.surface.objectId;

      const startDistM = Math.max(0, hit.distanceM - 0.06);
      const endDistM = Math.min(
        maxDistM + 0.04,
        entry.lastDistM + Math.max(0.18, hit.surface.thicknessM + 0.14),
      );
      const segLenM = Math.max(0.08, endDistM - startDistM);
      const segOrigin = add(origin, scale(normDir, startDistM));

      if (mat === 'GLASS_MARCHING_256' || mat === 'GLASS_VORONOI') {
        const res = this.glassSystem.handleRaySegment({
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
          this.combatAudio?.playMaterialImpact(
            res.hitMaterial ?? mat,
            res.impactPointWorld ?? hit.pointWorld,
            curEnergyJ,
            listenerPos,
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
          this.isWoodWallRayInOpenHole(objId, origin, normDir, maxDistM, hit.pointWorld)
        ) {
          continue;
        }

        const res = this.woodWalls.handleRaySegment({
          originWorld: segOrigin,
          directionWorld: normDir,
          maxDistanceM: segLenM,
          kineticEnergyJ: Math.min(220, curEnergyJ),
          speedMs: 310,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        const impactPt = res?.impactPointWorld ?? hit.pointWorld;
        this.combatAudio?.playMaterialImpact(
          entry.hitStud ? 'WOOD_STUD' : 'WOOD_DRYWALL',
          impactPt,
          curEnergyJ,
          listenerPos,
        );
        return {
          blocked: true,
          impactPointWorld: impactPt,
        };
      }

      if (mat === 'BRICK_MASONRY') {
        const res = this.brickWalls.handleRaySegment({
          originWorld: segOrigin,
          directionWorld: normDir,
          maxDistanceM: segLenM,
          kineticEnergyJ: Math.min(320, curEnergyJ),
          speedMs: 340,
          caliberRadiusM: 0.0045,
          isArmorPiercing: false,
        });
        const impactPt = res?.impactPointWorld ?? hit.pointWorld;
        this.combatAudio?.playMaterialImpact(
          'BRICK_MASONRY',
          impactPt,
          curEnergyJ,
          listenerPos,
        );
        return {
          blocked: true,
          impactPointWorld: impactPt,
        };
      }

      if (mat === 'CONCRETE_CHUNKS' || mat === 'CONCRETE_INTACT') {
        let impactPt = hit.pointWorld;
        if (this.concreteWalls.getWall(objId)) {
          const res = this.concreteWalls.handleRaySegment({
            originWorld: segOrigin,
            directionWorld: normDir,
            maxDistanceM: segLenM,
            kineticEnergyJ: curEnergyJ,
            speedMs: curSpeedMs,
            caliberRadiusM: 0.0045,
            isArmorPiercing: false,
          });
          if (res?.impactPointWorld) {
            impactPt = res.impactPointWorld;
          }
        } else {
          this.pomDecals.spawnCraterImpact(
            hit.pointWorld,
            hit.normalWorld,
            normDir,
            curEnergyJ,
            0.0045,
          );
        }
        this.combatAudio?.playMaterialImpact(
          mat,
          impactPt,
          curEnergyJ,
          listenerPos,
        );
        return {
          blocked: true,
          impactPointWorld: impactPt,
        };
      }

      // STEEL (including intact hazard barrels — stop hostile fire with metallic ricochet without friendly-fire detonation)
      this.combatAudio?.playMaterialImpact(
        'STEEL',
        hit.pointWorld,
        curEnergyJ,
        listenerPos,
      );
      return {
        blocked: true,
        impactPointWorld: hit.pointWorld,
      };
    }

    return { blocked: false };
  }

  /**
   * Routes high-explosive blasts (M67 frag grenades and detonating red hazard barrels) across
   * all destructible subsystems + Rapier dynamic rigid bodies with recursion protection.
   */
  public applyBlast(blast: BlastEvent): number {
    if (this.destroyed || this.blastRecursionDepth >= 4) {
      return 0;
    }

    this.blastRecursionDepth += 1;
    try {
      this.woodWalls.applyBlast(blast);
      this.glassSystem.applyBlast(blast);
      this.brickWalls.applyBlast(blast);
      this.concreteWalls.applyBlast(blast);
      this.barrelManager?.applyBlast(blast);
      return this.rapierWorld.applyRadialBlastImpulse(blast);
    } finally {
      this.blastRecursionDepth -= 1;
    }
  }

  /**
   * Resolves horizontal player capsule/cylinder movement against intact Rapier cover colliders
   * with smooth axis-separated wall sliding, allowing players to walk through breached openings!
   */
  public resolvePlayerHorizontalCollision(
    prevPos: Vec3Like,
    desiredPos: Vec3Like,
    playerRadiusM = 0.36,
  ): { x: number; z: number } {
    if (this.destroyed) {
      return { x: desiredPos.x, z: desiredPos.z };
    }

    const dx = desiredPos.x - prevPos.x;
    const dz = desiredPos.z - prevPos.z;
    if (Math.hypot(dx, dz) < 1e-5) {
      return { x: desiredPos.x, z: desiredPos.z };
    }

    if (!this.isHorizontalStepBlocked(prevPos.x, prevPos.z, desiredPos.x, desiredPos.z, playerRadiusM)) {
      return { x: desiredPos.x, z: desiredPos.z };
    }

    // Try sliding independently along X then Z
    let resolvedX = prevPos.x;
    let resolvedZ = prevPos.z;

    if (
      Math.abs(dx) > 1e-5 &&
      !this.isHorizontalStepBlocked(prevPos.x, prevPos.z, desiredPos.x, prevPos.z, playerRadiusM)
    ) {
      resolvedX = desiredPos.x;
    }

    if (
      Math.abs(dz) > 1e-5 &&
      !this.isHorizontalStepBlocked(resolvedX, prevPos.z, resolvedX, desiredPos.z, playerRadiusM)
    ) {
      resolvedZ = desiredPos.z;
    }

    desiredPos.x = resolvedX;
    desiredPos.z = resolvedZ;
    return { x: resolvedX, z: resolvedZ };
  }

  /**
   * Steps Rapier3D physics + syncs all hardware-instanced / MultiDraw destruction meshes.
   */
  public update(dt: number): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }
    this.rapierWorld.step(dt);
    this.woodWalls.update(dt);
    this.glassSystem.update(dt);
    this.brickWalls.update(dt);
    this.concreteWalls.update(dt);
  }

  /**
   * Restores all destructible walls, windows, POM concrete craters, and masonry bricks to 100% intact state.
   */
  public resetAll(): void {
    if (this.destroyed) return;
    this.woodWalls.reset();
    this.glassSystem.reset();
    this.brickWalls.reset();
    this.concreteWalls.reset();
    this.pomDecals.clear();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const fix of this.staticFixtures) {
      this.rapierWorld.removeCollider(fix.colliderHandle);
      fix.entity.destroy();
    }
    this.staticFixtures.length = 0;

    this.woodWalls.destroy();
    this.glassSystem.destroy();
    this.brickWalls.destroy();
    this.concreteWalls.destroy();
    this.pomDecals.destroy();

    if (this.ownsSillMaterial) {
      this.sillConcreteMat.destroy();
    }
    this.rootEntity.destroy();
  }

  private classifyHitGroup(tag: ColliderSurfaceTag): string {
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

  private dispatchSubsystemRaySegment(
    hit: PenetrationRayHit,
    seg: BallisticSegmentImpact,
  ): BallisticPenetrationResult | null {
    const mat = hit.surface.material;
    const objId = hit.surface.objectId;

    if (objId.startsWith('hazard_barrel_') && this.barrelManager) {
      return this.barrelManager.handleRaySegment(seg);
    }

    if (mat === 'WOOD_DRYWALL' || mat === 'WOOD_STUD') {
      return this.woodWalls.handleRaySegment(seg);
    }

    if (mat === 'GLASS_MARCHING_256' || mat === 'GLASS_VORONOI') {
      return this.glassSystem.handleRaySegment(seg);
    }

    if (mat === 'BRICK_MASONRY') {
      return this.brickWalls.handleRaySegment(seg);
    }

    if (mat === 'CONCRETE_CHUNKS' || mat === 'CONCRETE_INTACT') {
      if (this.concreteWalls.getWall(objId)) {
        return this.concreteWalls.handleRaySegment(seg);
      }
      // Static concrete parapet sill impact -> stamp POM crater + stop round
      this.pomDecals.spawnCraterImpact(
        hit.pointWorld,
        hit.normalWorld,
        seg.directionWorld,
        seg.kineticEnergyJ,
        seg.caliberRadiusM,
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

  private createWindowParapetSill(
    objectId: string,
    centerX: number,
    centerZ: number,
    widthM: number,
    heightM: number,
  ): void {
    const halfExtents: Vec3Like = {
      x: widthM * 0.5 + 0.04,
      y: heightM * 0.5,
      z: 0.11,
    };
    const center: Vec3Like = {
      x: centerX,
      y: heightM * 0.5,
      z: centerZ,
    };

    const colliderHandle = this.rapierWorld.createStaticBox(center, halfExtents, undefined, {
      material: 'CONCRETE_INTACT',
      objectId,
      thicknessM: halfExtents.z * 2,
      penetrationResistanceJ: 12000,
    });

    const entity = new pc.Entity(objectId);
    entity.addComponent('render', {
      type: 'box',
      material: this.sillConcreteMat,
      castShadows: true,
      receiveShadows: true,
    });
    entity.setLocalScale(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2);
    entity.setPosition(center.x, center.y, center.z);
    this.rootEntity.addChild(entity);

    this.staticFixtures.push({
      objectId,
      colliderHandle,
      entity,
    });
  }

  private isHorizontalStepBlocked(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    radiusM: number,
  ): boolean {
    const delta = sub(vec3(x1, 0, z1), vec3(x0, 0, z0));
    const stepDist = length(delta);
    if (stepDist < 1e-5) return false;

    const stepDir = scale(delta, 1 / stepDist);
    // Probe at waist height (0.95m) and shin height (0.38m)
    const probeHeights = [0.95, 0.38];
    for (let p = 0; p < probeHeights.length; p++) {
      const origin: Vec3Like = { x: x0, y: probeHeights[p], z: z0 };
      const hits = this.rapierWorld.castPenetrationRay(
        origin,
        stepDir,
        stepDist + radiusM,
      );
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (h.distanceM > stepDist + radiusM) continue;

        // Check if wood wall already has an open breach hole wide enough at player height!
        if (h.surface.material === 'WOOD_DRYWALL') {
          const wallInst = this.woodWalls.getWall(h.surface.objectId);
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

        // Check if marching/Voronoi glass window is shattered open at player chest height
        if (
          h.surface.material === 'GLASS_MARCHING_256' ||
          h.surface.material === 'GLASS_VORONOI'
        ) {
          const vorWin = this.glassSystem.voronoiWindows.find(
            (w) => w.id === h.surface.objectId,
          );
          if (vorWin && vorWin.shattered) {
            continue;
          }
        }

        return true;
      }
    }

    return false;
  }

  private isWoodWallRayInOpenHole(
    objectId: string,
    rayOrigin: Vec3Like,
    unitDir: Vec3Like,
    maxDist: number,
    fallbackPointWorld: Vec3Like,
  ): boolean {
    const wall = this.woodWalls.getWall(objectId);
    if (!wall) return false;

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
}
