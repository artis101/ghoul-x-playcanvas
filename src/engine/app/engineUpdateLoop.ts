import { vec3 } from '../../core/ballistics/vec3.ts';
import type { IGhoulXApp } from './appContext.ts';

export function onEngineUpdate(app: IGhoulXApp, dt: number): void {
  const clampedDt = Math.min(0.1, dt);
  const prevTimeScale = app.mayhemDirector.bulletTime.timeScale;

  // 1. Step responsive player movement, camera pose, viewmodel & full-auto fire FIRST
  const playerDt = clampedDt * (0.45 + 0.55 * prevTimeScale);
  app.arsenalManager.update(playerDt);
  app.fpsController.update(
    playerDt,
    app.arsenalManager.currentWeapon,
    app.arsenalManager.reloadTimerS,
    app.arsenalManager.weaponViewmodelEntity
  );

  // 2. Step bullet-time dilation, hazard barrels, tracers, sparks & casings
  const scaledDt = app.mayhemDirector.update(clampedDt);
  const timeScale = app.mayhemDirector.bulletTime.timeScale;
  app.totalElapsedTimeS += scaledDt;

  const eye = app.fpsController.getEyePosition();
  app.combatAudio.setTimeScale(timeScale);
  app.combatAudio.updateListener(
    vec3(eye.x, eye.y, eye.z),
    app.fpsController.cameraYaw,
    app.fpsController.cameraPitch
  );
  app.combatAudio.update(clampedDt);

  // 3. Step grenades, AI shots, physiology & ragdolls BEFORE Rapier step
  app.combatDirector.update(
    scaledDt,
    app.totalElapsedTimeS,
    app.fpsController.cameraEntity.camera ?? null,
    app.hudController
  );

  // 4. Step Rapier3D physics & upload all destructible debris / MultiDraw / instanced pools in lockstep
  app.destructionManager.update(scaledDt);
  app.mayhemDirector.syncSurfaceBreaches();

  if (
    app.fpsController.isAimingDownSights &&
    app.arsenalManager.currentWeapon.role === 'SNIPER'
  ) {
    const aim = app.fpsController.getAimDirection();
    app.combatDirector.updateSniperRangefinder(
      app.arsenalManager.currentWeapon,
      app.arsenalManager.currentAmmo,
      vec3(eye.x, eye.y, eye.z),
      vec3(aim.x, aim.y, aim.z),
      app.hudController
    );
  }

  app.hudController.updateContextPrompt(
    app.fpsController.isPointerLocked,
    app.combatDirector.areAllTargetsDown()
  );

  app.fxManager.update(scaledDt, false);
  app.hudController.updatePlayerVitals(app.tacticalAi.playerVitals, clampedDt);
}
