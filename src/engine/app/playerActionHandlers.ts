import { vec3 } from '../../core/ballistics/vec3.ts';
import type { IGhoulXApp } from './appContext.ts';

export function handleTriggerPull(app: IGhoulXApp): void {
  if (!app.arsenalManager.tryConsumeRoundForShot()) return;

  const weapon = app.arsenalManager.currentWeapon;
  const ammo = app.arsenalManager.currentAmmo;

  app.fpsController.syncCameraTransform();
  const eye = app.fpsController.getEyePosition();
  const aim = app.fpsController.getAimDirection();
  const eyeVec = vec3(eye.x, eye.y, eye.z);
  const aimVec = vec3(aim.x, aim.y, aim.z);
  const muzzleWorld = app.arsenalManager.muzzleFlashEntity.getPosition();
  const muzzleVec = vec3(muzzleWorld.x, muzzleWorld.y, muzzleWorld.z);

  app.combatAudio.playWeaponFire(weapon.id, ammo.type, app.fpsController.isAimingDownSights);
  app.mayhemDirector.onPlayerWeaponFired(eyeVec, aimVec, weapon, ammo, muzzleVec);
  app.tacticalAi.notifyGunshotOrExplosion(eyeVec, 40.0, 0.24);
  app.combatDirector.fireWeapon(weapon, ammo, eyeVec, aimVec);

  app.fpsController.applyRecoilKick(weapon.recoilKickDeg);
  app.fpsController.syncCameraTransform();
}

export function handleThrowGrenade(app: IGhoulXApp): void {
  app.fpsController.syncCameraTransform();
  const eye = app.fpsController.getEyePosition();
  const aim = app.fpsController.getAimDirection();
  app.combatDirector.throwFragGrenade(vec3(eye.x, eye.y, eye.z), vec3(aim.x, aim.y, aim.z));
}

export function handleToggleBulletTime(app: IGhoulXApp): void {
  const entering = app.mayhemDirector.bulletTime.toggleReflex();
  app.combatAudio.playSlowMoTransition(entering);
}

export function spawnFreshWave(app: IGhoulXApp): void {
  app.destructionManager.resetAll();
  app.mayhemDirector.resetWave(true);
  app.tacticalAi.notifyWaveCleared();
  app.combatDirector.spawnAllTargets();
  app.arsenalManager.initAmmoInventory();
  app.hudController.pushSystemToast('BREACH RESET', '7 HOSTILES & COVER RESTORED');
}
