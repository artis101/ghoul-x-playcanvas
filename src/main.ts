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

export class GhoulXApplication {
  public readonly canvas: HTMLCanvasElement;
  public readonly app: pc.Application;
  public readonly materials: EngineMaterialPalette;
  public readonly hudController: HudController;
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

    this.materials = getOrCreateMaterials();
    applyRetroEnvironmentTextures(
      this.app.graphicsDevice,
      this.materials.floorGridMat,
      this.materials.barrierConcreteMat
    );

    this.hudController = new HudController();
    this.fxManager = new GoreAndBallisticsFxManager(this.app, this.materials);

    this.arenaBuilder = new ArenaBuilder(this.app, this.materials);
    this.arenaBuilder.build();

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
            this.combatDirector.spawnAllTargets()
          ),
        onSpawnWave: () => this.spawnFreshWave(),
        onThrowGrenade: () => this.handleThrowGrenade(),
        onToggleXRay: () =>
          this.combatDirector.setXRayMode(!this.combatDirector.enableXRayInspector),
      }
    );

    this.arsenalManager = new ArsenalManager(
      this.fpsController.cameraEntity,
      this.materials,
      this.hudController,
      (switchedWeapon) => {
        if (this.fpsController.isAimingDownSights) {
          this.fpsController.setAimDownSights(false, switchedWeapon);
        }
      }
    );

    this.combatDirector = new CombatDirector(
      this.app,
      this.materials,
      this.fxManager,
      this.hudController,
      (intensityDeg, durationS) => this.fpsController.applyCameraShake(intensityDeg, durationS)
    );
    this.combatDirector.spawnAllTargets();

    this.app.start();
    this.app.on('update', (dt: number) => this.onEngineUpdate(dt));
  }

  private handleTriggerPull(): void {
    if (!this.arsenalManager.tryConsumeRoundForShot()) return;

    const weapon = this.arsenalManager.currentWeapon;
    const ammo = this.arsenalManager.currentAmmo;
    this.fpsController.applyRecoilKick(weapon.recoilKickDeg);

    const eye = this.fpsController.getEyePosition();
    const aim = this.fpsController.getAimDirection();
    this.combatDirector.fireWeapon(
      weapon,
      ammo,
      vec3(eye.x, eye.y, eye.z),
      vec3(aim.x, aim.y, aim.z)
    );
  }

  private handleThrowGrenade(): void {
    const eye = this.fpsController.getEyePosition();
    const aim = this.fpsController.getAimDirection();
    this.combatDirector.throwFragGrenade(vec3(eye.x, eye.y, eye.z), vec3(aim.x, aim.y, aim.z));
  }

  private spawnFreshWave(): void {
    this.combatDirector.spawnAllTargets();
    this.arsenalManager.initAmmoInventory();
    this.hudController.pushSystemToast('WAVE SPAWNED', '4 HOSTILES DEPLOYED');
  }

  private onEngineUpdate(dt: number): void {
    const clampedDt = Math.min(0.05, dt);
    this.totalElapsedTimeS += clampedDt;

    this.arsenalManager.update(clampedDt);
    this.fpsController.update(
      clampedDt,
      this.arsenalManager.currentWeapon,
      this.arsenalManager.reloadTimerS,
      this.arsenalManager.weaponViewmodelEntity
    );

    if (
      this.fpsController.isAimingDownSights &&
      this.arsenalManager.currentWeapon.role === 'SNIPER'
    ) {
      const eye = this.fpsController.getEyePosition();
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

    this.combatDirector.update(
      clampedDt,
      this.totalElapsedTimeS,
      this.fpsController.cameraEntity.camera,
      this.hudController
    );

    this.fxManager.update(clampedDt, false);
  }
}

export async function bootstrap(): Promise<GhoulXApplication> {
  return new GhoulXApplication();
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
}
