import type * as pc from 'playcanvas';
import type { DestructibleMaterialKind } from '../../contracts/destruction.ts';
import { scale, vec3 } from '../../core/ballistics/vec3.ts';
import { getOrCreateMaterials, type EngineMaterialPalette } from '../materials.ts';
import { applyRetroEnvironmentTextures } from '../retroTextures.ts';
import { GoreAndBallisticsFxManager } from '../goreFx.ts';
import { HudController } from '../hudController.ts';
import { FpsController } from '../player/fpsController.ts';
import { ArsenalManager } from '../player/arsenalManager.ts';
import { ArenaBuilder } from '../world/arenaBuilder.ts';
import { CombatDirector } from '../combat/combatDirector.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { GlbModelRegistry } from '../assets/glbLoader.ts';
import { CombatAudioEngine } from '../audio/combatAudioEngine.ts';
import { MayhemDirector } from '../fx/mayhemDirector.ts';
import { DestructionManager } from '../destruction/destructionManager.ts';
import { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import type { IGhoulXApp } from './appContext.ts';
import { createPlayCanvasApp, unbindPlayCanvasAppResize } from './appSetup.ts';
import { CinematicFrame } from './cinematicFrame.ts';
import { disposeDevRuntime } from '../dev/devRuntime.ts';
import { onEngineUpdate } from './engineUpdateLoop.ts';
import { wireCombatDirectorInterceptors } from './combatEventWiring.ts';
import { fanOutBlast, BARREL_BLAST_PROFILE } from './blastFanout.ts';
import {
  handleTriggerPull,
  handleThrowGrenade,
  spawnFreshWave,
} from './playerActionHandlers.ts';

const BLAST_WORK_BUDGET_MS = 3;

export interface GhoulXAppOptions {
  readonly materials?: EngineMaterialPalette;
  readonly combatAudio?: CombatAudioEngine;
  readonly autoStart?: boolean;
}

export type AppLifecycleState =
  | { readonly kind: 'INITIALIZED' }
  | { readonly kind: 'RUNNING'; readonly updateHandler: (dt: number) => void }
  | { readonly kind: 'DESTROYED' };

export class GhoulXApplication implements IGhoulXApp {
  public readonly canvas: HTMLCanvasElement;
  public readonly app: pc.Application;
  public readonly rapierWorld: RapierPhysicsWorld;
  public readonly materials: EngineMaterialPalette;
  public readonly hudController: HudController;
  public readonly combatAudio: CombatAudioEngine;
  public readonly glbRegistry: GlbModelRegistry;
  public readonly mayhemDirector: MayhemDirector;
  public readonly destructionManager: DestructionManager;
  public readonly tacticalAi: TacticalCombatAiSystem;
  public readonly fxManager: GoreAndBallisticsFxManager;
  public readonly arenaBuilder: ArenaBuilder;
  public readonly fpsController: FpsController;
  public readonly cinematicFrame: CinematicFrame;
  public readonly arsenalManager: ArsenalManager;
  public readonly combatDirector: CombatDirector;

  public totalElapsedTimeS = 0;
  public lifecycleState: AppLifecycleState = { kind: 'INITIALIZED' };

  private readonly ownsApp: boolean;
  private readonly ownsGlbRegistry: boolean;

  constructor(
    canvas?: HTMLCanvasElement,
    app?: pc.Application,
    glbRegistry?: GlbModelRegistry,
    options?: GhoulXAppOptions
  ) {
    if (canvas) {
      this.canvas = canvas;
    } else {
      const el = document.getElementById('playcanvas-viewport');
      if (!(el instanceof HTMLCanvasElement)) {
        throw new Error('Canvas #playcanvas-viewport not found in document!');
      }
      this.canvas = el;
    }

    this.ownsApp = !app;
    this.app = app ?? createPlayCanvasApp(this.canvas);
    this.rapierWorld = new RapierPhysicsWorld();
    this.materials = options?.materials ?? getOrCreateMaterials();
    applyRetroEnvironmentTextures(
      this.app.graphicsDevice,
      this.materials.floorGridMat,
      this.materials.barrierConcreteMat
    );

    this.hudController = new HudController();
    this.combatAudio = options?.combatAudio ?? new CombatAudioEngine({ pannerModel: 'equalpower' });
    this.ownsGlbRegistry = !glbRegistry;
    this.glbRegistry = glbRegistry ?? new GlbModelRegistry(this.app);
    this.fxManager = new GoreAndBallisticsFxManager(this.app, this.materials, this.glbRegistry);

    this.arenaBuilder = new ArenaBuilder(this.app, this.materials, this.rapierWorld);
    this.arenaBuilder.build();

    this.mayhemDirector = new MayhemDirector({
      app: this.app,
      rapierWorld: this.rapierWorld,
      dynamicLightPoolSize: 2,
      onCasingBounce: (ev) => {
        const eye = this.fpsController.getEyePosition();
        this.combatAudio.playShellCasingBounce(
          ev.isShotgunHull ? 'SHOTGUN_HULL' : 'BRASS',
          ev.position,
          vec3(eye.x, eye.y, eye.z)
        );
      },
      onExplosionBlast: (blast) => fanOutBlast(this, blast, BARREL_BLAST_PROFILE),
    });

    this.destructionManager = new DestructionManager(this.app, this.rapierWorld, {
      materials: this.materials,
      glbRegistry: this.glbRegistry,
      barrelManager: this.mayhemDirector.barrels,
      combatAudio: this.combatAudio,
      getListenerPos: () => {
        const eye = this.fpsController.getEyePosition();
        return vec3(eye.x, eye.y, eye.z);
      },
      buildDefaultArena: true,
    });

    this.tacticalAi = new TacticalCombatAiSystem({
      app: this.app,
      rapierWorld: this.rapierWorld,
      isLineOfSightBlocked: (from, to) => this.destructionManager.isLineOfSightBlocked(from, to),
      interceptEnemyShotCover: (origin, dir, maxDistM) =>
        this.destructionManager.interceptEnemyShot(origin, dir, maxDistM),
      onEnemyFireTracer: (ev) => {
        const eye = this.fpsController?.getEyePosition();
        const listenerPos = eye ? vec3(eye.x, eye.y, eye.z) : vec3(0, 1.62, 0);
        this.combatAudio.playEnemyBallisticShot({
          muzzleOrigin: ev.muzzleOriginWorld,
          impactPoint: ev.impactPointWorld,
          listenerPos,
          weaponId: ev.weaponId,
          isSupersonic: ev.isSupersonic,
        });

        const shotDir = ev.shotDirectionWorld;
        const rightDir = vec3(-shotDir.z, 0, shotDir.x);
        this.mayhemDirector.ejectEnemyShellCasing(
          ev.muzzleOriginWorld,
          rightDir,
          ev.usedBackupSidearm
        );
        this.mayhemDirector.injectGunsmoke(
          ev.muzzleOriginWorld,
          shotDir,
          ev.usedBackupSidearm ? 0.55 : 0.9
        );

        if ((ev.blockedByCover || ev.suppressionMode) && !ev.hitPlayer) {
          this.mayhemDirector.spawnSurfaceImpactFx(
            ev.impactPointWorld,
            ev.impactNormalWorld ?? scale(ev.shotDirectionWorld, -1),
            (ev.impactSurfaceTag as DestructibleMaterialKind) ?? 'CONCRETE_INTACT',
            420
          );
        }
      },
      onAiBark: (bark) => {
        const eye = this.fpsController?.getEyePosition();
        const listenerPos = eye ? vec3(eye.x, eye.y, eye.z) : vec3(0, 1.62, 0);
        this.hudController.pushRadioBark(bark);
        this.combatAudio.playRadioBarkCue({
          isRadio: bark.isRadio,
          vocalCue: bark.vocalCue,
          worldPos: bark.worldPos,
          listenerPos,
        });
      },
      onPlayerNearMissGraze: (graze) => {
        const eye = this.fpsController?.getEyePosition();
        const listenerPos = eye ? vec3(eye.x, eye.y, eye.z) : vec3(0, 1.62, 0);
        this.hudController.triggerNearMissGrazeFlash(graze.kind);
        const audioKind = graze.kind === 'HELMET_DEFLECT' ? 'HELMET_POP' : 'ARTERIAL_GRAZE';
        this.combatAudio.playNearMissGrazeTinnitus(audioKind, graze.hitPointWorld, listenerPos);
        this.fpsController?.applyCameraShake(
          graze.kind === 'HELMET_DEFLECT' ? 1.85 : 1.45,
          0.26
        );
      },
      onPlayerDamaged: (_vitals, ev) => {
        this.hudController.triggerPlayerDamageFlash();
        this.fpsController.applyCameraShake(0.6, 0.16);
        // Which side the round came from: the shooter is behind the shot's travel direction.
        const yawRad = (this.fpsController.cameraYaw * Math.PI) / 180;
        const d = ev.shotDirectionWorld;
        const rightness = -(d.x * Math.cos(yawRad) - d.z * Math.sin(yawRad));
        const damageNorm = (ev.healthDamageApplied + ev.armorChipApplied * 0.5) / 30;
        this.fpsController.applyHitFlinch(rightness, damageNorm);
      },
    });

    this.fpsController = new FpsController(
      this.app,
      this.canvas,
      this.hudController,
      () => this.arsenalManager.currentWeapon,
      {
        onTriggerPull: () => handleTriggerPull(this),
        onSelectWeapon: (idx) => this.arsenalManager.selectWeaponByIndex(idx),
        onCycleWeapon: (delta) =>
          this.arsenalManager.selectWeaponByIndex(this.arsenalManager.currentWeaponIndex + delta),
        onCycleAmmo: () => this.arsenalManager.cycleAmmoType(),
        onReload: () =>
          this.arsenalManager.startReload(this.combatDirector.areAllTargetsDown(), () =>
            spawnFreshWave(this)
          ),
        onSpawnWave: () => spawnFreshWave(this),
        onThrowGrenade: () => handleThrowGrenade(this),
      },
      (prev, next) => this.destructionManager.resolvePlayerHorizontalCollision(prev, next, 0.36)
    );
    this.cinematicFrame = new CinematicFrame(this.app, this.fpsController.cameraEntity.camera);
    // Smoke, plume and mist billboards turn to face this camera.
    this.mayhemDirector.setCameraEntity(this.fpsController.cameraEntity);
    this.fxManager.setCameraEntity(this.fpsController.cameraEntity);

    this.arsenalManager = new ArsenalManager(
      this.fpsController.cameraEntity,
      this.materials,
      this.hudController,
      () => this.fpsController.onWeaponSwitched(),
      this.glbRegistry
    );

    this.combatDirector = new CombatDirector(
      this.app,
      this.materials,
      this.fxManager,
      this.hudController,
      this.glbRegistry,
      {
        mayhemDirector: this.mayhemDirector,
        tacticalAi: this.tacticalAi,
        combatAudio: this.combatAudio,
        glbRegistry: this.glbRegistry,
        isLineOfSightBlocked: (from, to) => this.destructionManager.isLineOfSightBlocked(from, to),
        getCoverBreachVersion: () => this.destructionManager.breachVersion,
        getPlayerEyePosition: () => this.fpsController.getEyePosition(),
      }
    );

    // A blast's aftermath is worked off a few milliseconds a frame instead of all in the frame of the flash.
    this.combatDirector.blastWork.budgetMs = BLAST_WORK_BUDGET_MS;

    wireCombatDirectorInterceptors(
      this.combatDirector,
      this.destructionManager,
      this.mayhemDirector,
      this.tacticalAi,
      this.fpsController
    );

    this.combatDirector.spawnAllTargets();
    this.hudController.updatePlayerVitals(this.tacticalAi.playerVitals, 0);

    if (options?.autoStart !== false) {
      this.start();
    }
  }

  public get isStarted(): boolean {
    return this.lifecycleState.kind === 'RUNNING';
  }

  public start(): void {
    if (this.lifecycleState.kind !== 'INITIALIZED') return;
    const updateHandler = (dt: number): void => onEngineUpdate(this, dt);
    this.lifecycleState = { kind: 'RUNNING', updateHandler };
    this.app.start();
    this.app.on('update', updateHandler);
  }

  /**
   * Tears down every subsystem in reverse construction order. Each step runs even if an earlier one
   * throws; the errors are re-thrown together afterwards. The pc.Application, GLB registry and canvas
   * are released only when this instance created them. The shared material palette is never destroyed.
   */
  public destroy(): void {
    if (this.lifecycleState.kind === 'DESTROYED') return;
    if (this.lifecycleState.kind === 'RUNNING') {
      this.app.off('update', this.lifecycleState.updateHandler);
    }
    this.lifecycleState = { kind: 'DESTROYED' };

    const errors: unknown[] = [];
    const step = (release: () => void): void => {
      try { release(); } catch (err) { errors.push(err); }
    };
    step(() => disposeDevRuntime(this));
    step(() => unbindPlayCanvasAppResize(this.app));
    step(() => this.combatDirector.destroy());
    step(() => this.arsenalManager.destroy());
    step(() => this.cinematicFrame.destroy());
    step(() => this.fpsController.destroy());
    step(() => this.tacticalAi.destroy());
    step(() => this.destructionManager.destroy());
    step(() => this.mayhemDirector.destroy());
    step(() => this.arenaBuilder.destroy());
    step(() => this.fxManager.destroy());
    if (this.ownsGlbRegistry) step(() => this.glbRegistry.destroy());
    step(() => this.combatAudio.destroy());
    step(() => this.hudController.destroy());
    step(() => this.rapierWorld.destroy());
    if (this.ownsApp) step(() => this.app.destroy());

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `GhoulXApplication teardown: ${errors.length} subsystems failed`);
  }
}
