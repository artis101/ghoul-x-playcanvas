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
import { createPlayCanvasApp } from './appSetup.ts';
import { onEngineUpdate } from './engineUpdateLoop.ts';
import { wireCombatDirectorInterceptors } from './combatEventWiring.ts';
import {
  handleTriggerPull,
  handleThrowGrenade,
  handleToggleBulletTime,
  spawnFreshWave,
} from './playerActionHandlers.ts';

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
  public readonly arsenalManager: ArsenalManager;
  public readonly combatDirector: CombatDirector;

  public totalElapsedTimeS = 0;

  constructor(
    canvas?: HTMLCanvasElement,
    app?: pc.Application,
    glbRegistry?: GlbModelRegistry
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

    this.app = app ?? createPlayCanvasApp(this.canvas);
    this.rapierWorld = new RapierPhysicsWorld();
    this.materials = getOrCreateMaterials();
    applyRetroEnvironmentTextures(
      this.app.graphicsDevice,
      this.materials.floorGridMat,
      this.materials.barrierConcreteMat
    );

    this.hudController = new HudController();
    this.combatAudio = new CombatAudioEngine();
    this.glbRegistry = glbRegistry ?? new GlbModelRegistry(this.app);
    this.fxManager = new GoreAndBallisticsFxManager(this.app, this.materials, this.glbRegistry);

    this.arenaBuilder = new ArenaBuilder(this.app, this.materials, this.rapierWorld);
    this.arenaBuilder.build();

    this.mayhemDirector = new MayhemDirector({
      app: this.app,
      rapierWorld: this.rapierWorld,
      dynamicLightPoolSize: 2,
      bulletTimeOptions: {
        onVignetteUpdate: (state) => this.hudController.updateBulletTimeHud(state),
      },
      onCasingBounce: (ev) => {
        const eye = this.fpsController.getEyePosition();
        this.combatAudio.playShellCasingBounce(
          ev.isShotgunHull ? 'SHOTGUN_HULL' : 'BRASS',
          ev.position,
          vec3(eye.x, eye.y, eye.z)
        );
      },
      onExplosionBlast: (blast) => {
        this.destructionManager.applyBlast(blast);
        this.mayhemDirector.syncSurfaceBreaches();
        this.combatDirector.applyExternalExplosionTrauma(blast, 'HAZARD BARREL');
        this.tacticalAi.notifyGunshotOrExplosion(blast.centerWorld, 45.0, 0.78);
      },
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
    this.mayhemDirector.isSurfaceOpenAtHit = (hit, origin, dir, maxDistM) =>
      this.destructionManager.isSurfaceOpenAtHit(hit, origin, dir, maxDistM);
    this.mayhemDirector.getBreachVersion = () => this.destructionManager.breachVersion;

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
      onPlayerDamaged: () => {
        this.hudController.triggerPlayerDamageFlash();
        this.fpsController.applyCameraShake(1.15, 0.16);
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
        onToggleXRay: () =>
          this.combatDirector.setXRayMode(!this.combatDirector.enableXRayInspector),
        onToggleBulletTime: () => handleToggleBulletTime(this),
      },
      (prev, next) => this.destructionManager.resolvePlayerHorizontalCollision(prev, next, 0.36)
    );

    this.arsenalManager = new ArsenalManager(
      this.fpsController.cameraEntity,
      this.materials,
      this.hudController,
      (switchedWeapon) => {
        if (this.fpsController.isAimingDownSights) {
          this.fpsController.setAimDownSights(false, switchedWeapon);
        }
      },
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

    wireCombatDirectorInterceptors(
      this.combatDirector,
      this.destructionManager,
      this.mayhemDirector,
      this.tacticalAi
    );

    this.combatDirector.spawnAllTargets();
    this.hudController.updatePlayerVitals(this.tacticalAi.playerVitals, 0);

    this.app.start();
    this.app.on('update', (dt: number) => onEngineUpdate(this, dt));
  }
}
