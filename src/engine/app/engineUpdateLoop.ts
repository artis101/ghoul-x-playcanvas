import * as pc from 'playcanvas';
import { adsFocus } from '../../core/ballistics/aim/aimDownSights.ts';
import { getDevRuntime } from '../dev/devRuntime.ts';
import { PROFILE_SECTION, type FrameProfiler } from '../dev/frameProfiler.ts';
import type { IGhoulXApp } from './appContext.ts';

// Reused every frame; the listener and rangefinder copy what they need.
const eyeScratch = new pc.Vec3();
const aimScratch = new pc.Vec3();

export function onEngineUpdate(app: IGhoulXApp, dt: number): void {
  const dev = getDevRuntime(app);
  dev.beginFrame(dt);
  // SimClock returns 0 while paused; the simulation is skipped rather than stepped with dt=0.
  const simDt = dev.clock.advance(dt);
  if (simDt > 0) {
    const prof = dev.profiler;
    prof.beginFrame();
    prof.begin(PROFILE_SECTION.update);
    stepSimulation(app, simDt, prof);
    prof.end(PROFILE_SECTION.update);
    prof.endFrame();
  }
  dev.endFrame();
}

function stepSimulation(app: IGhoulXApp, clampedDt: number, prof: FrameProfiler): void {
  // 1. Step responsive player movement, camera pose, viewmodel & full-auto fire FIRST
  prof.begin(PROFILE_SECTION.player);
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

  app.cinematicFrame.setAdsFocus(
    adsFocus(app.fpsController.sightKind, app.fpsController.adsBlend)
  );
  prof.end(PROFILE_SECTION.player);

  // 2. Step hazard barrels, tracers, sparks & casings
  prof.begin(PROFILE_SECTION.mayhem);
  app.mayhemDirector.update(clampedDt);
  app.totalElapsedTimeS += clampedDt;
  prof.end(PROFILE_SECTION.mayhem);

  prof.begin(PROFILE_SECTION.audio);
  const eye = app.fpsController.getEyePosition(eyeScratch);
  app.combatAudio.updateListener(eye, app.fpsController.cameraYaw, app.fpsController.cameraPitch);
  app.combatAudio.update(clampedDt);
  prof.end(PROFILE_SECTION.audio);

  // 3. Step grenades, AI shots, physiology & ragdolls BEFORE Rapier step
  prof.begin(PROFILE_SECTION.combat);
  app.combatDirector.update(
    clampedDt,
    app.totalElapsedTimeS,
    app.fpsController.cameraEntity.camera ?? null,
    app.hudController
  );
  prof.end(PROFILE_SECTION.combat);

  // 4. Step Rapier3D physics & upload all destructible debris / MultiDraw / instanced pools in lockstep
  prof.begin(PROFILE_SECTION.destruction);
  app.destructionManager.update(clampedDt);
  app.mayhemDirector.syncSurfaceBreaches();
  prof.end(PROFILE_SECTION.destruction);

  prof.begin(PROFILE_SECTION.hud);
  if (
    app.fpsController.isScopeOpticActive &&
    app.arsenalManager.currentWeapon.role === 'SNIPER'
  ) {
    const aim = app.fpsController.getAimDirection(aimScratch);
    app.combatDirector.updateSniperRangefinder(
      app.arsenalManager.currentWeapon,
      app.arsenalManager.currentAmmo,
      eye,
      aim,
      app.hudController
    );
  }

  app.hudController.updateContextPrompt(
    app.fpsController.isPointerLocked,
    app.combatDirector.areAllTargetsDown()
  );
  prof.end(PROFILE_SECTION.hud);

  prof.begin(PROFILE_SECTION.fx);
  app.fxManager.update(clampedDt, false);
  prof.end(PROFILE_SECTION.fx);

  prof.begin(PROFILE_SECTION.hud);
  app.hudController.updatePlayerVitals(app.tacticalAi.playerVitals, clampedDt);
  prof.end(PROFILE_SECTION.hud);
}
