import * as pc from 'playcanvas';
import { vec3 } from './core/ballistics/vec3.ts';
import { getOrCreateMaterials, EngineMaterialPalette } from './engine/materials.ts';
import { applyRetroEnvironmentTextures } from './engine/retroTextures.ts';
import { GoreAndBallisticsFxManager } from './engine/goreFx.ts';
import { HudController } from './engine/hudController.ts';
import { FpsController } from './engine/player/fpsController.ts';
import { ArsenalManager } from './engine/player/arsenalManager.ts';
import { ArenaBuilder } from './engine/world/arenaBuilder.ts';
import { CombatDirector } from './engine/combat/combatDirector.ts';
import { initRapierPhysics, RapierPhysicsWorld } from './engine/physics/rapierWorld.ts';
import { GlbModelRegistry } from './engine/assets/glbLoader.ts';
import { CombatAudioEngine } from './engine/audio/combatAudioEngine.ts';
import { MayhemDirector } from './engine/fx/mayhemDirector.ts';
import { DestructionManager } from './engine/destruction/destructionManager.ts';
import { TacticalCombatAiSystem } from './engine/ai/tacticalCombatAi.ts';

export class GhoulXApplication {
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

  private totalElapsedTimeS = 0;

  constructor() {
    const canvasEl = document.getElementById('playcanvas-viewport');
    if (!(canvasEl instanceof HTMLCanvasElement)) {
      throw new Error('Canvas #playcanvas-viewport not found in document!');
    }
    this.canvas = canvasEl;

    this.app = new pc.Application(this.canvas, {
      mouse: new pc.Mouse(this.canvas),
      touch: new pc.TouchDevice(this.canvas),
      keyboard: new pc.Keyboard(window),
    });

    this.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    this.app.setCanvasResolution(pc.RESOLUTION_AUTO);
    window.addEventListener('resize', () => this.app.resizeCanvas());

    this.rapierWorld = new RapierPhysicsWorld();
    this.materials = getOrCreateMaterials();
    applyRetroEnvironmentTextures(
      this.app.graphicsDevice,
      this.materials.floorGridMat,
      this.materials.barrierConcreteMat
    );

    this.hudController = new HudController();
    this.combatAudio = new CombatAudioEngine();
    this.glbRegistry = new GlbModelRegistry(this.app);
    this.fxManager = new GoreAndBallisticsFxManager(this.app, this.materials);

    this.arenaBuilder = new ArenaBuilder(this.app, this.materials);
    this.arenaBuilder.build();

    this.mayhemDirector = new MayhemDirector({
      app: this.app,
      rapierWorld: this.rapierWorld,
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
        this.combatDirector.applyExternalExplosionTrauma(blast, 'HAZARD BARREL');
        this.tacticalAi.notifyGunshotOrExplosion(blast.centerWorld, 45.0, 0.78);
      },
    });

    this.destructionManager = new DestructionManager(this.app, this.rapierWorld, {
      materials: this.materials,
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
        onTriggerPull: () => this.handleTriggerPull(),
        onSelectWeapon: (idx) => this.arsenalManager.selectWeaponByIndex(idx),
        onCycleWeapon: (delta) =>
          this.arsenalManager.selectWeaponByIndex(this.arsenalManager.currentWeaponIndex + delta),
        onCycleAmmo: () => this.arsenalManager.cycleAmmoType(),
        onReload: () =>
          this.arsenalManager.startReload(this.combatDirector.areAllTargetsDown(), () =>
            this.spawnFreshWave()
          ),
        onSpawnWave: () => this.spawnFreshWave(),
        onThrowGrenade: () => this.handleThrowGrenade(),
        onToggleXRay: () =>
          this.combatDirector.setXRayMode(!this.combatDirector.enableXRayInspector),
        onToggleBulletTime: () => this.handleToggleBulletTime(),
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
      (intensityDeg, durationS) => this.fpsController.applyCameraShake(intensityDeg, durationS),
      {
        mayhemDirector: this.mayhemDirector,
        tacticalAi: this.tacticalAi,
        combatAudio: this.combatAudio,
        glbRegistry: this.glbRegistry,
      }
    );

    this.combatDirector.environmentRayInterceptor = (
      origin,
      dir,
      maxDistM,
      energyJ,
      speedMs,
      caliberDiameterM,
      isAp
    ) =>
      this.destructionManager.interceptRaySegment(
        origin,
        dir,
        maxDistM,
        energyJ,
        speedMs,
        caliberDiameterM,
        isAp
      );

    this.combatDirector.onExplosionBlast = (center, radiusM, peakImpulseNs, peakEnergyJ) => {
      const blast = { centerWorld: center, radiusM, peakImpulseNs, peakEnergyJ };
      this.destructionManager.applyBlast(blast);
      this.mayhemDirector.notifyExternalExplosion(blast, 0);
      this.tacticalAi.notifyGunshotOrExplosion(center, 45.0, 0.72);
    };

    this.combatDirector.spawnAllTargets();
    this.hudController.updatePlayerVitals(this.tacticalAi.playerVitals, 0);

    this.app.start();
    this.app.on('update', (dt: number) => this.onEngineUpdate(dt));

    // Stream & live-upgrade all 8 Blender 4.5 .glb assets + fractured concrete connectivity graph!
    void this.glbRegistry
      .preloadAll()
      .then(() => {
        this.arsenalManager.attachGlbRegistry(this.glbRegistry);
        this.destructionManager.upgradeWithGlbAssets(this.glbRegistry);
        this.combatDirector.upgradeTargetsWithGlb(this.glbRegistry);
      })
      .catch((err: unknown) => {
        console.warn('GLB preload skipped/fallback to procedural retro meshes:', err);
      });
  }

  private handleTriggerPull(): void {
    if (!this.arsenalManager.tryConsumeRoundForShot()) return;

    const weapon = this.arsenalManager.currentWeapon;
    const ammo = this.arsenalManager.currentAmmo;
    this.fpsController.applyRecoilKick(weapon.recoilKickDeg);

    const eye = this.fpsController.getEyePosition();
    const aim = this.fpsController.getAimDirection();
    const eyeVec = vec3(eye.x, eye.y, eye.z);
    const aimVec = vec3(aim.x, aim.y, aim.z);

    this.combatAudio.playWeaponFire(weapon.id, ammo.type, this.fpsController.isAimingDownSights);
    this.mayhemDirector.onPlayerWeaponFired(eyeVec, aimVec, weapon, ammo);
    this.tacticalAi.notifyGunshotOrExplosion(eyeVec, 40.0, 0.24);
    this.combatDirector.fireWeapon(weapon, ammo, eyeVec, aimVec);
  }

  private handleThrowGrenade(): void {
    const eye = this.fpsController.getEyePosition();
    const aim = this.fpsController.getAimDirection();
    this.combatDirector.throwFragGrenade(vec3(eye.x, eye.y, eye.z), vec3(aim.x, aim.y, aim.z));
  }

  private handleToggleBulletTime(): void {
    const entering = this.mayhemDirector.bulletTime.toggleReflex();
    this.combatAudio.playSlowMoTransition(entering);
  }

  private spawnFreshWave(): void {
    this.destructionManager.resetAll();
    this.mayhemDirector.resetWave(true);
    this.tacticalAi.notifyWaveCleared();
    this.combatDirector.spawnAllTargets();
    this.arsenalManager.initAmmoInventory();
    this.hudController.pushSystemToast('BREACH RESET', '7 HOSTILES & COVER RESTORED');
  }

  private onEngineUpdate(dt: number): void {
    const clampedDt = Math.min(0.05, dt);
    const scaledDt = this.mayhemDirector.update(clampedDt);
    const timeScale = this.mayhemDirector.bulletTime.timeScale;
    this.totalElapsedTimeS += scaledDt;

    const eye = this.fpsController.getEyePosition();
    this.combatAudio.setTimeScale(timeScale);
    this.combatAudio.updateListener(
      vec3(eye.x, eye.y, eye.z),
      this.fpsController.cameraYaw,
      this.fpsController.cameraPitch
    );
    this.combatAudio.update(clampedDt);

    // F.E.A.R. Reflex feel: player camera & viewmodel stay responsive while world dilates to 0.22x
    const playerDt = clampedDt * (0.45 + 0.55 * timeScale);
    this.arsenalManager.update(playerDt);
    this.fpsController.update(
      playerDt,
      this.arsenalManager.currentWeapon,
      this.arsenalManager.reloadTimerS,
      this.arsenalManager.weaponViewmodelEntity
    );

    if (
      this.fpsController.isAimingDownSights &&
      this.arsenalManager.currentWeapon.role === 'SNIPER'
    ) {
      const aim = this.fpsController.getAimDirection();
      this.combatDirector.updateSniperRangefinder(
        this.arsenalManager.currentWeapon,
        this.arsenalManager.currentAmmo,
        vec3(eye.x, eye.y, eye.z),
        vec3(aim.x, aim.y, aim.z),
        this.hudController
      );
    }

    this.hudController.updateContextPrompt(
      this.fpsController.isPointerLocked,
      this.combatDirector.areAllTargetsDown()
    );

    this.destructionManager.update(scaledDt);

    this.combatDirector.update(
      scaledDt,
      this.totalElapsedTimeS,
      this.fpsController.cameraEntity.camera,
      this.hudController
    );

    this.fxManager.update(scaledDt, false);
    this.hudController.updatePlayerVitals(this.tacticalAi.playerVitals, clampedDt);
  }
}

export async function bootstrap(): Promise<GhoulXApplication> {
  await initRapierPhysics();
  return new GhoulXApplication();
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
}
