import { vec3 } from '../../core/ballistics/vec3.ts';
import type { IGhoulXApp } from './appContext.ts';

export function onEngineUpdate(app: IGhoulXApp, dt: number): void {
  const clampedDt = Math.min(0.1, dt);

  // 1. Step responsive player movement, camera pose, viewmodel & full-auto fire FIRST
  app.arsenalManager.update(clampedDt);
  app.fpsController.update(
    clampedDt,
    app.arsenalManager.currentWeapon,
    app.arsenalManager.reloadTimerS,
    app.arsenalManager.weaponViewmodelEntity,
    {
      aimBlocked: app.arsenalManager.isHandsBusy,
      firing: app.arsenalManager.actionState.kind === 'FIRING',
      weaponGlb: app.arsenalManager.activeWeaponGlb,
    }
  );

  // 2. Step hazard barrels, tracers, sparks & casings
  app.mayhemDirector.update(clampedDt);
  app.totalElapsedTimeS += clampedDt;

  const eye = app.fpsController.getEyePosition();
  app.combatAudio.updateListener(
    vec3(eye.x, eye.y, eye.z),
    app.fpsController.cameraYaw,
    app.fpsController.cameraPitch
  );
  app.combatAudio.update(clampedDt);

  // 3. Step grenades, AI shots, physiology & ragdolls BEFORE Rapier step
  app.combatDirector.update(
    clampedDt,
    app.totalElapsedTimeS,
    app.fpsController.cameraEntity.camera ?? null,
    app.hudController
  );

  // 4. Step Rapier3D physics & upload all destructible debris / MultiDraw / instanced pools in lockstep
  app.destructionManager.update(clampedDt);
  app.mayhemDirector.syncSurfaceBreaches();

  if (
    app.fpsController.isScopeOpticActive &&
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

  app.fxManager.update(clampedDt, false);
  app.hudController.updatePlayerVitals(app.tacticalAi.playerVitals, clampedDt);
}
