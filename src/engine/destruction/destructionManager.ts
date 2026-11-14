import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BlastEvent,
  GrenadeSweepStepResult,
  PenetrationRayHit,
} from '../../contracts/destruction.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import type { CombatAudioEngine } from '../audio/combatAudioEngine.ts';
import type { EnvironmentRayInterceptResult } from '../combat/combatDirector.ts';
import type { ExplosiveBarrelManager } from '../fx/mayhemDirector.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { BLAST_BREACH_MARGIN_M, BreachRegionTracker } from './manager/breachRegionTracker.ts';
import { BrickWallSystem } from './brickWallSystem.ts';
import { ConcreteWallSystem } from './concreteWallSystem.ts';
import { GlassSystem } from './glassSystem.ts';
import {
  type ArenaBuildContext,
  buildBreachingArenaStations,
} from './manager/arenaStationBuilder.ts';
import {
  type DestructionCollisionContext,
  resolvePlayerHorizontalCollision,
} from './manager/destructionCollision.ts';
import {
  type EnemyShotInterceptResult,
  interceptEnemyShot,
  isLineOfSightBlocked,
  isSurfaceHitInOpenBreach,
} from './manager/destructionCoverQueries.ts';
import {
  type DestructionManagerOptions,
  type StaticCoverFixture,
} from './manager/destructionManagerTypes.ts';
import {
  type DestructionRaycastContext,
  interceptRaySegment,
} from './manager/destructionRaycast.ts';
import { resolveGrenadeSweepStep } from './manager/grenadeCollision.ts';
import { PomCraterDecalSystem } from './pomCraterDecals.ts';
import { WoodWallSystem } from './woodWallSystem.ts';

export * from './manager/destructionManagerTypes.ts';
export * from './manager/breachRegionTracker.ts';
export * from './manager/arenaStationBuilder.ts';
export * from './manager/destructionRaycast.ts';
export * from './manager/destructionCoverQueries.ts';
export * from './manager/destructionCollision.ts';
export * from './manager/grenadeCollision.ts';

type MutableRaycastContext = { -readonly [K in keyof DestructionRaycastContext]: DestructionRaycastContext[K] };

const MAX_BLAST_RECURSION_DEPTH = 4;

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
  private readonly ownsSillMaterial: boolean;
  private readonly breaches = new BreachRegionTracker();
  private readonly raycastCtx: MutableRaycastContext;
  private readonly isSurfaceOpenFn = (hit: PenetrationRayHit, o: Vec3Like, d: Vec3Like, m: number): boolean =>
    this.isSurfaceOpenAtHit(hit, o, d, m);
  private blastRecursionDepth = 0;
  private destroyed = false;

  public get breachVersion(): number {
    return this.breaches.version;
  }

  public constructor(
    app: pc.Application,
    rapierWorld: RapierPhysicsWorld,
    options: DestructionManagerOptions = {}
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

    const debrisBundle =
      options.glbRegistry && options.glbRegistry.isLoaded('debris_pack')
        ? options.glbRegistry.getDebrisPackBundle()
        : null;
    const woodOptions =
      debrisBundle && !options.woodOptions?.splinterMeshes
        ? { ...options.woodOptions, splinterMeshes: debrisBundle.splinterMeshes }
        : options.woodOptions;
    const brickOptions =
      debrisBundle &&
      !options.brickOptions?.variantMeshes &&
      debrisBundle.brickMeshes.length >= 3
        ? {
            ...options.brickOptions,
            rubbleMaterial: options.brickOptions?.rubbleMaterial ?? debrisBundle.brickMaterial,
            variantMeshes: [
              debrisBundle.brickMeshes[0],
              debrisBundle.brickMeshes[1],
              debrisBundle.brickMeshes[2],
            ] as const,
          }
        : options.brickOptions;

    this.woodWalls = new WoodWallSystem(app, rapierWorld, woodOptions);
    this.glassSystem = new GlassSystem(app, rapierWorld);
    this.brickWalls = new BrickWallSystem(app, rapierWorld, brickOptions);
    this.concreteWalls = new ConcreteWallSystem(app, rapierWorld, {
      pomDecalSystem: this.pomDecals,
    });

    this.raycastCtx = {
      rapierWorld: this.rapierWorld,
      woodWalls: this.woodWalls,
      glassSystem: this.glassSystem,
      brickWalls: this.brickWalls,
      concreteWalls: this.concreteWalls,
      pomDecals: this.pomDecals,
      barrelManager: this.barrelManager,
      combatAudio: this.combatAudio,
      getListenerPos: this.getListenerPos,
      notifyBreach: (centerWorld?: Vec3Like, radiusM?: number) => this.breaches.note(centerWorld, radiusM),
    };

    if (options.buildDefaultArena !== false) {
      this.buildBreachingArenaStations(options.glbRegistry);
    }
  }

  public buildBreachingArenaStations(glbRegistry?: GlbModelRegistry | null): void {
    if (this.destroyed) return;
    const ctx: ArenaBuildContext = {
      app: this.app,
      rootEntity: this.rootEntity,
      rapierWorld: this.rapierWorld,
      sillConcreteMat: this.sillConcreteMat,
      staticFixtures: this.staticFixtures,
      woodWalls: this.woodWalls,
      glassSystem: this.glassSystem,
      brickWalls: this.brickWalls,
      concreteWalls: this.concreteWalls,
    };
    buildBreachingArenaStations(ctx, glbRegistry);
  }

  public interceptRaySegment(
    origin: Vec3Like,
    dir: Vec3Like,
    maxDistM: number,
    energyJ: number,
    speedMs: number,
    caliberDiameterM: number,
    isAp: boolean,
    armorPenetrationFactor?: number
  ): EnvironmentRayInterceptResult {
    if (this.destroyed) {
      return {
        remainingEnergyJ: Math.max(0, energyJ),
        remainingSpeedMs: Math.max(0, speedMs),
        blocked: energyJ <= 0 || speedMs <= 0,
      };
    }
    return interceptRaySegment(
      this.getRaycastContext(),
      origin,
      dir,
      maxDistM,
      energyJ,
      speedMs,
      caliberDiameterM,
      isAp,
      armorPenetrationFactor
    );
  }

  public resolveGrenadeStep(
    prevPos: Vec3Like,
    desiredPos: Vec3Like,
    velocity: Vec3Like,
    grenadeRadiusM = 0.045,
    crossedGlassIds?: Set<string>
  ): GrenadeSweepStepResult {
    if (this.destroyed) {
      return {
        position: { x: desiredPos.x, y: desiredPos.y, z: desiredPos.z },
        velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
        bounced: false,
        brokeGlass: false,
        crazedArmoredGlass: false,
      };
    }
    return resolveGrenadeSweepStep(
      this.getRaycastContext(),
      prevPos,
      desiredPos,
      velocity,
      grenadeRadiusM,
      crossedGlassIds
    );
  }

  public isLineOfSightBlocked(fromWorld: Vec3Like, toWorld: Vec3Like): boolean {
    if (this.destroyed) return false;
    return isLineOfSightBlocked(this.getRaycastContext(), fromWorld, toWorld);
  }

  public isSurfaceOpenAtHit(
    hit: PenetrationRayHit,
    rayOrigin: Vec3Like,
    unitDir: Vec3Like,
    maxDistM: number
  ): boolean {
    if (this.destroyed) return true;
    return isSurfaceHitInOpenBreach(
      this.getRaycastContext(),
      hit,
      rayOrigin,
      unitDir,
      maxDistM
    );
  }

  public interceptEnemyShot(
    origin: Vec3Like,
    dir: Vec3Like,
    maxDistM: number,
    kineticEnergyJ = 460
  ): EnemyShotInterceptResult {
    if (this.destroyed) return { blocked: false };
    return interceptEnemyShot(this.getRaycastContext(), origin, dir, maxDistM, kineticEnergyJ);
  }

  /**
   * The pieces of one blast in execution order: wall families, barrels, body impulses, then the
   * crater prune and debris wake for the blasted region. Running them all in order equals applyBlast.
   */
  public planBlastJobs(blast: BlastEvent): Array<() => void> {
    return this.buildBlastJobs(blast, { impulsedBodies: 0 });
  }

  public applyBlast(blast: BlastEvent): number {
    if (this.destroyed || this.blastRecursionDepth >= MAX_BLAST_RECURSION_DEPTH) return 0;
    const out = { impulsedBodies: 0 };
    const jobs = this.buildBlastJobs(blast, out);
    const last = jobs.length - 1;
    try {
      for (let i = 0; i < last; i++) jobs[i]();
    } finally {
      if (last >= 0) jobs[last]();
    }
    return out.impulsedBodies;
  }

  private buildBlastJobs(blast: BlastEvent, out: { impulsedBodies: number }): Array<() => void> {
    if (this.destroyed) return [];
    const breachRadiusM = blast.radiusM + BLAST_BREACH_MARGIN_M;
    // Every topology stage records the breach after its work, so jobs spread over several frames
    // never leave a change behind a breach that update() has already processed.
    const noteBreach = (): void => this.breaches.note(blast.centerWorld, breachRadiusM);
    return [
      () => this.runBlastStage(() => {
        noteBreach();
        this.woodWalls.applyBlast(blast);
        noteBreach();
      }),
      () => this.runBlastStage(() => { this.glassSystem.applyBlast(blast); noteBreach(); }),
      () => this.runBlastStage(() => { this.brickWalls.applyBlast(blast); noteBreach(); }),
      () => this.runBlastStage(() => { this.concreteWalls.applyBlast(blast); noteBreach(); }),
      () => this.runBlastStage(() => { this.barrelManager?.applyBlast(blast); noteBreach(); }),
      () => this.runBlastStage(() => {
        out.impulsedBodies = this.rapierWorld.applyRadialBlastImpulse(blast);
      }),
      () => {
        if (!this.destroyed && this.blastRecursionDepth === 0) this.processPendingBreaches();
      },
    ];
  }

  private runBlastStage(stage: () => void): void {
    if (this.destroyed || this.blastRecursionDepth >= MAX_BLAST_RECURSION_DEPTH) return;
    this.blastRecursionDepth += 1;
    try {
      stage();
    } finally {
      this.blastRecursionDepth -= 1;
    }
  }

  public resolvePlayerHorizontalCollision(
    prevPos: Vec3Like,
    desiredPos: Vec3Like,
    playerRadiusM = 0.36
  ): { x: number; z: number } {
    if (this.destroyed) {
      return { x: desiredPos.x, z: desiredPos.z };
    }
    const ctx: DestructionCollisionContext = {
      rapierWorld: this.rapierWorld,
      woodWalls: this.woodWalls,
      glassSystem: this.glassSystem,
      brickWalls: this.brickWalls,
    };
    return resolvePlayerHorizontalCollision(ctx, prevPos, desiredPos, playerRadiusM);
  }

  public update(dt: number): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }
    this.rapierWorld.step(dt);
    this.woodWalls.update(dt);
    this.glassSystem.update(dt);
    this.brickWalls.update(dt);
    this.concreteWalls.update(dt);
    if (this.breaches.hasPending) this.processPendingBreaches();
  }

  public resetAll(): void {
    if (this.destroyed) return;
    this.breaches.note();
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

  private processPendingBreaches(): void {
    this.breaches.process(this.rapierWorld, this.pomDecals, this.isSurfaceOpenFn);
  }

  private getRaycastContext(): DestructionRaycastContext {
    const ctx = this.raycastCtx;
    ctx.barrelManager = this.barrelManager;
    ctx.combatAudio = this.combatAudio;
    ctx.getListenerPos = this.getListenerPos;
    return ctx;
  }
}
