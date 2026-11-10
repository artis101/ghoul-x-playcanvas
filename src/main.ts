import * as pc from 'playcanvas';
import {
  WeaponSpec,
  AmmoSpec,
  EnvironmentState,
  GhoulZoneId,
  TargetHealthState,
} from './contracts/ballistics.ts';
import { vec3, copyVec3, normalize, sub } from './core/ballistics/vec3.ts';
import {
  WEAPONS,
  WEAPON_M590,
  WEAPON_SILVER_TALON,
  WEAPON_MSG90,
  WEAPON_M4A1,
  DEFAULT_ENVIRONMENT,
} from './core/ballistics/weapons.ts';
import { createTargetHealthState } from './core/ghoul/anatomy.ts';
import {
  simulateShot,
  applyShotReportToTarget,
  stepRagdollPhysics,
} from './core/ballistics/solver.ts';
import { getOrCreateMaterials, EngineMaterialPalette } from './engine/materials.ts';
import { GhoulMannequinEntity } from './engine/mannequin.ts';
import { GoreAndBallisticsFxManager } from './engine/goreFx.ts';
import { XRayKillCamDirector } from './engine/killCamDirector.ts';
import { HudController } from './engine/hudController.ts';

/**
 * Tactical Enemy Target Definition
 */
interface RangeTargetConfig {
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
  yawDeg: number;
}

const TARGET_CONFIGS: RangeTargetConfig[] = [
  {
    id: 'target_0',
    name: 'MERCENARY POINTMAN (5m)',
    position: { x: 0, y: 0, z: -5 },
    yawDeg: 180,
  },
  {
    id: 'target_1',
    name: 'ENFORCER HEAVY (8m)',
    position: { x: -2.2, y: 0, z: -8 },
    yawDeg: 165,
  },
  {
    id: 'target_2',
    name: 'SPEC-OPS SPOTTER (16m)',
    position: { x: 2.4, y: 0, z: -16 },
    yawDeg: 195,
  },
  {
    id: 'target_3',
    name: 'OVERWATCH SNIPER (55m)',
    position: { x: 0.5, y: 0, z: -55 },
    yawDeg: 180,
  },
];

class GhoulXApplication {
  private canvas: HTMLCanvasElement;
  private app: pc.Application;
  private materials: EngineMaterialPalette;

  // Camera & Viewmodel
  private cameraEntity: pc.Entity;
  private weaponViewmodelEntity: pc.Entity;
  private muzzleFlashEntity: pc.Entity;
  private cameraPitch = 0;
  private cameraYaw = 0;
  private isPointerLocked = false;
  private isAimingDownSights = false;
  private recoilPitch = 0;
  private recoilOffsetZ = 0;

  // Shooter Position
  private playerPos = new pc.Vec3(0, 1.65, 0);
  private keysPressed: Record<string, boolean> = {};

  // Simulation State
  private targets: GhoulMannequinEntity[] = [];
  private activeTargetIndex = 0;
  private currentWeapon: WeaponSpec = WEAPON_M590;
  private currentAmmo: AmmoSpec = WEAPON_M590.defaultAmmo;
  private environment: EnvironmentState = { ...DEFAULT_ENVIRONMENT };
  private baseTimeScale = 1.0;
  private enableXRayCam = true;
  private enablePermanentXRay = false;
  private enableBulletTrails = true;
  private activeAimZone: GhoulZoneId = 'TORSO_UPPER_THORAX';
  private fireCooldownTimerS = 0;
  private totalElapsedTimeS = 0;

  // Engine Subsystems
  private fxManager: GoreAndBallisticsFxManager;
  private killCamDirector: XRayKillCamDirector;
  private hudController: HudController;

  constructor() {
    this.canvas = document.getElementById('playcanvas-viewport') as HTMLCanvasElement;
    if (!this.canvas) {
      throw new Error('Canvas #playcanvas-viewport not found in document!');
    }

    // 1. Initialize PlayCanvas App
    this.app = new pc.Application(this.canvas, {
      mouse: new pc.Mouse(this.canvas),
      touch: new pc.TouchDevice(this.canvas),
      keyboard: new pc.Keyboard(window),
    });

    this.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    this.app.setCanvasResolution(pc.RESOLUTION_AUTO);

    window.addEventListener('resize', () => this.app.resizeCanvas());

    this.materials = getOrCreateMaterials();

    // 2. Build Environment (Lighting, Floor, Sandbags, Distance Markers)
    this.buildRangeEnvironment();

    // 3. Build Player Camera & FPS Weapon Viewmodel
    this.cameraEntity = new pc.Entity('PlayerCamera');
    this.cameraEntity.addComponent('camera', {
      clearColor: new pc.Color(0.04, 0.06, 0.08),
      fov: 65,
      nearClip: 0.1,
      farClip: 400,
    });
    this.cameraEntity.setPosition(this.playerPos.x, this.playerPos.y, this.playerPos.z);
    this.app.root.addChild(this.cameraEntity);

    const { viewmodel, muzzleFlash } = this.buildWeaponViewmodel();
    this.weaponViewmodelEntity = viewmodel;
    this.muzzleFlashEntity = muzzleFlash;
    this.cameraEntity.addChild(this.weaponViewmodelEntity);

    // 4. Initialize Subsystems
    this.fxManager = new GoreAndBallisticsFxManager(this.app, this.materials);

    this.killCamDirector = new XRayKillCamDirector({
      app: this.app,
      cameraEntity: this.cameraEntity,
      fxManager: this.fxManager,
      onSequenceComplete: () => {
        this.cameraEntity.setPosition(this.playerPos.x, this.playerPos.y, this.playerPos.z);
        this.cameraEntity.setEulerAngles(this.cameraPitch, this.cameraYaw, 0);
      },
    });

    // 5. Spawn Range Targets
    this.spawnAllTargets();

    // 6. Setup HUD Controller & Callbacks
    this.hudController = new HudController({
      onWeaponSelected: (weapon) => this.selectWeapon(weapon),
      onAmmoSelected: (ammo) => this.selectAmmo(ammo),
      onAimZoneSelected: (zone) => this.aimAtTargetZone(zone),
      onFireRequested: () => this.handleTriggerPull(),
      onRespawnRequested: () => this.spawnAllTargets(),
      onToggleXRayCam: (enabled) => {
        this.enableXRayCam = enabled;
      },
      onToggleXRayVision: (enabled) => {
        this.enablePermanentXRay = enabled;
        for (const t of this.targets) {
          t.setXRayMode(enabled);
        }
      },
      onToggleBulletTrails: (enabled) => {
        this.enableBulletTrails = enabled;
      },
      onWindChanged: (windSpeed) => {
        this.environment.windVelocity = vec3(windSpeed, 0, 0);
      },
      onTimeScaleChanged: (timeScale) => {
        this.baseTimeScale = timeScale;
      },
      onPresetShotgunRagdoll: () => this.runPresetShotgunRagdoll(),
      onPresetDecap50ae: () => this.runPresetDecap50ae(),
      onPresetLimbSever: () => this.runPresetLimbSever(),
      onPresetSniperXray: () => this.runPresetSniperXray(),
    });

    this.hudController.setupArsenal(this.currentWeapon, this.currentAmmo);

    // 7. Bind Viewport & Mouse Controls
    this.bindInputListeners();

    // 8. Start PlayCanvas Engine Loop
    this.app.start();
    this.app.on('update', (dt: number) => this.onEngineUpdate(dt));
  }

  /**
   * Builds the tactical firing range environment.
   */
  private buildRangeEnvironment(): void {
    // Directional Sunlight & Shadows
    const light = new pc.Entity('SunLight');
    light.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1.0, 0.98, 0.92),
      intensity: 1.4,
      castShadows: true,
      shadowResolution: 2048,
      shadowDistance: 80,
    });
    light.setEulerAngles(45, 35, 0);
    this.app.root.addChild(light);

    // Ambient Fill Light
    const fillLight = new pc.Entity('FillLight');
    fillLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(0.2, 0.35, 0.5),
      intensity: 0.6,
      castShadows: false,
    });
    fillLight.setEulerAngles(-60, -145, 0);
    this.app.root.addChild(fillLight);

    // Floor Grid Surface
    const floor = new pc.Entity('ArenaFloor');
    floor.addComponent('render', {
      type: 'box',
      material: this.materials.floorGridMat,
    });
    floor.setLocalScale(40, 0.2, 160);
    floor.setPosition(0, -0.1, -50);
    this.app.root.addChild(floor);

    // Tactical Distance Markers (5m, 10m, 25m, 50m, 100m)
    const markerDistances = [5, 10, 25, 50, 100];
    for (const d of markerDistances) {
      const lineMarker = new pc.Entity(`DistanceMarker_${d}m`);
      lineMarker.addComponent('render', {
        type: 'box',
        material: this.materials.rangeDistanceMarkerMat,
      });
      lineMarker.setLocalScale(18, 0.04, 0.15);
      lineMarker.setPosition(0, 0.02, -d);
      this.app.root.addChild(lineMarker);

      // Marker post on sides
      for (const side of [-8, 8]) {
        const post = new pc.Entity(`MarkerPost_${d}m_${side}`);
        post.addComponent('render', {
          type: 'cylinder',
          material: this.materials.rangeDistanceMarkerMat,
        });
        post.setLocalScale(0.18, 0.8, 0.18);
        post.setPosition(side, 0.4, -d);
        this.app.root.addChild(post);
      }
    }

    // Concrete Barriers & Sandbags around range perimeter
    for (const z of [-10, -25, -45]) {
      const barrierL = new pc.Entity(`Barrier_L_${z}`);
      barrierL.addComponent('render', {
        type: 'box',
        material: this.materials.barrierConcreteMat,
      });
      barrierL.setLocalScale(1.0, 1.2, 6.0);
      barrierL.setPosition(-10.5, 0.6, z);
      this.app.root.addChild(barrierL);

      const barrierR = new pc.Entity(`Barrier_R_${z}`);
      barrierR.addComponent('render', {
        type: 'box',
        material: this.materials.barrierConcreteMat,
      });
      barrierR.setLocalScale(1.0, 1.2, 6.0);
      barrierR.setPosition(10.5, 0.6, z);
      this.app.root.addChild(barrierR);
    }
  }

  /**
   * Procedural first-person weapon model attached to camera.
   */
  private buildWeaponViewmodel(): { viewmodel: pc.Entity; muzzleFlash: pc.Entity } {
    const viewmodel = new pc.Entity('WeaponViewmodel');
    viewmodel.setPosition(0.24, -0.22, -0.48);

    // Gun body
    const gunBody = new pc.Entity('GunBody');
    gunBody.addComponent('render', {
      type: 'box',
      material: this.materials.bootsDark,
    });
    gunBody.setLocalScale(0.06, 0.08, 0.38);
    viewmodel.addChild(gunBody);

    // Gun barrel
    const barrel = new pc.Entity('GunBarrel');
    barrel.addComponent('render', {
      type: 'cylinder',
      material: this.materials.tacticalArmorVest,
    });
    barrel.setLocalScale(0.035, 0.32, 0.035);
    barrel.setLocalPosition(0, 0.02, -0.26);
    barrel.setLocalEulerAngles(90, 0, 0);
    viewmodel.addChild(barrel);

    // Muzzle Flash
    const muzzleFlash = new pc.Entity('MuzzleFlash');
    muzzleFlash.addComponent('render', {
      type: 'sphere',
      material: this.materials.rangeDistanceMarkerMat,
    });
    muzzleFlash.setLocalScale(0.12, 0.12, 0.12);
    muzzleFlash.setLocalPosition(0, 0.02, -0.46);
    muzzleFlash.enabled = false;
    viewmodel.addChild(muzzleFlash);

    return { viewmodel, muzzleFlash };
  }

  /**
   * Spawns or resets all 4 range targets.
   */
  private spawnAllTargets(): void {
    // Clear old mannequins
    for (const t of this.targets) {
      t.destroy();
    }
    this.targets = [];
    this.fxManager.clearAll();

    for (const cfg of TARGET_CONFIGS) {
      const yawRad = (cfg.yawDeg * Math.PI) / 180;
      const healthState = createTargetHealthState(
        cfg.id,
        cfg.name,
        vec3(cfg.position.x, cfg.position.y, cfg.position.z),
        yawRad
      );

      const mannequin = new GhoulMannequinEntity(this.app, healthState, this.materials);
      this.app.root.addChild(mannequin.rootEntity);
      this.targets.push(mannequin);

      if (this.enablePermanentXRay) {
        mannequin.setXRayMode(true);
      }
    }

    this.activeTargetIndex = 0;
  }

  private selectWeapon(weapon: WeaponSpec): void {
    this.currentWeapon = weapon;
    this.currentAmmo = weapon.defaultAmmo;
    this.hudController.setActiveWeapon(weapon, this.currentAmmo);

    // Adjust camera FOV if zoomed
    const baseFov = this.isAimingDownSights ? 65 / this.currentWeapon.scopeZoomLevels[0] : 65;
    if (this.cameraEntity.camera) {
      this.cameraEntity.camera.fov = baseFov;
    }
  }

  private selectAmmo(ammo: AmmoSpec): void {
    this.currentAmmo = ammo;
  }

  private bindInputListeners(): void {
    // Pointer lock for FPS mouselook
    this.canvas.addEventListener('click', () => {
      if (!this.isPointerLocked) {
        this.canvas.requestPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.canvas;
    });

    // Mouselook
    document.addEventListener('mousemove', (e) => {
      if (!this.isPointerLocked || this.killCamDirector.isActive()) return;

      const sensitivity = this.isAimingDownSights ? 0.08 : 0.16;
      this.cameraYaw -= e.movementX * sensitivity;
      this.cameraPitch -= e.movementY * sensitivity;

      this.cameraPitch = Math.max(-85, Math.min(85, this.cameraPitch));
    });

    // Mouse Down (Fire / Aim Down Sights)
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        // LMB: Fire
        this.handleTriggerPull();
      } else if (e.button === 2) {
        // RMB: Toggle Precision Scope
        e.preventDefault();
        this.toggleAimDownSights();
      }
    });

    // Prevent context menu on RMB
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // WASD movement keys
    window.addEventListener('keydown', (e) => {
      this.keysPressed[e.code] = true;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.toggleAimDownSights();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keysPressed[e.code] = false;
    });
  }

  private toggleAimDownSights(): void {
    this.isAimingDownSights = !this.isAimingDownSights;
    const isSniper = this.currentWeapon.role === 'SNIPER';

    if (this.isAimingDownSights) {
      const zoom = this.currentWeapon.scopeZoomLevels[0] || 2.0;
      if (this.cameraEntity.camera) {
        this.cameraEntity.camera.fov = 65 / zoom;
      }
      this.weaponViewmodelEntity.setPosition(0, -0.16, -0.32); // align with sight
      if (isSniper) {
        this.hudController.setScopeOverlay(true, zoom, 55.0, -1.2, this.environment.windVelocity.x);
      }
    } else {
      if (this.cameraEntity.camera) {
        this.cameraEntity.camera.fov = 65;
      }
      this.weaponViewmodelEntity.setPosition(0.24, -0.22, -0.48);
      this.hudController.setScopeOverlay(false);
    }
  }

  /**
   * Automatically aims the player's view at a specific anatomical zone on a specified or nearest live target,
   * optionally compensating for RK4 gravity drop and crosswind drift at long range.
   */
  private aimAtTargetZone(
    zone: GhoulZoneId,
    explicitTarget?: GhoulMannequinEntity,
    compensateBallistics = false
  ): void {
    this.activeAimZone = zone;
    const target = explicitTarget || this.getClosestLiveTarget();
    if (!target) return;

    const bone = target.healthState.ragdollBones[zone];
    const targetWorldPos = bone ? bone.position : target.healthState.worldPosition;

    const eyePos = this.playerPos;
    let dx = targetWorldPos.x - eyePos.x;
    let dy = targetWorldPos.y - eyePos.y;
    const dz = targetWorldPos.z - eyePos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    if (compensateBallistics && this.currentAmmo.muzzleVelocityMs > 0) {
      const approxFlightTime = horizDist / (this.currentAmmo.muzzleVelocityMs * 0.92);
      const dropComp = 0.5 * 9.81 * approxFlightTime * approxFlightTime;
      const windComp = 0.45 * this.environment.windVelocity.x * approxFlightTime;
      dy += dropComp;
      dx -= windComp;
    }

    this.cameraYaw = (Math.atan2(-dx, -dz) * 180) / Math.PI;
    this.cameraPitch = (Math.atan2(dy, horizDist) * 180) / Math.PI;
  }

  private getClosestLiveTarget(): GhoulMannequinEntity | null {
    if (this.targets[this.activeTargetIndex] && this.targets[this.activeTargetIndex].healthState.alive) {
      return this.targets[this.activeTargetIndex];
    }

    let closest: GhoulMannequinEntity | null = null;
    let minDist = Infinity;

    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i];
      if (t.healthState.alive) {
        const d = this.playerPos.distance(
          new pc.Vec3(
            t.healthState.worldPosition.x,
            t.healthState.worldPosition.y,
            t.healthState.worldPosition.z
          )
        );
        if (d < minDist) {
          minDist = d;
          closest = t;
          this.activeTargetIndex = i;
        }
      }
    }

    return closest || this.targets[0] || null;
  }

  /**
   * Computes the normalized aim direction from camera pitch and yaw.
   */
  private getAimDirection(): pc.Vec3 {
    const pitchRad = (this.cameraPitch * Math.PI) / 180;
    const yawRad = (this.cameraYaw * Math.PI) / 180;

    const x = -Math.sin(yawRad) * Math.cos(pitchRad);
    const y = Math.sin(pitchRad);
    const z = -Math.cos(yawRad) * Math.cos(pitchRad);

    return new pc.Vec3(x, y, z).normalize();
  }

  /**
   * Triggers a weapon shot with external RK4 ballistics, terminal cavitation,
   * GHOUL dismemberment, and Kill Cam activation.
   */
  private handleTriggerPull(explicitTarget?: GhoulMannequinEntity): void {
    if (this.killCamDirector.isActive()) return;
    if (this.fireCooldownTimerS > 0) return;

    this.fireCooldownTimerS = 60 / this.currentWeapon.fireRateRpm;

    // Viewmodel Recoil Kick & Muzzle Flash
    this.recoilPitch = this.currentWeapon.recoilKickDeg;
    this.recoilOffsetZ = 0.08;
    this.muzzleFlashEntity.enabled = true;
    setTimeout(() => {
      this.muzzleFlashEntity.enabled = false;
    }, 45);

    const aimDirPc = this.getAimDirection();
    const aimDir = vec3(aimDirPc.x, aimDirPc.y, aimDirPc.z);
    const origin = vec3(this.playerPos.x, this.playerPos.y, this.playerPos.z);

    // Find best matching target along aim ray or use explicit/closest target
    let target = explicitTarget || this.getClosestLiveTarget() || this.targets[0];
    if (!target) return;

    let report = simulateShot(
      this.currentWeapon,
      this.currentAmmo,
      origin,
      aimDir,
      target.healthState,
      this.environment
    );

    // If current active target was missed, check if any other target on the range was hit
    if (!report.hitTarget && !explicitTarget) {
      for (let i = 0; i < this.targets.length; i++) {
        const candidate = this.targets[i];
        if (candidate === target) continue;
        const candReport = simulateShot(
          this.currentWeapon,
          this.currentAmmo,
          origin,
          aimDir,
          candidate.healthState,
          this.environment
        );
        if (candReport.hitTarget) {
          target = candidate;
          report = candReport;
          this.activeTargetIndex = i;
          break;
        }
      }
    }

    // Always spawn 3D flying projectile(s) and Mach shockwave trails so they are visible in both normal & Kill Cam views!
    if (this.currentAmmo.pelletCount > 1) {
      for (const pr of report.pelletResults) {
        this.fxManager.spawnFlyingProjectile(pr.trajectorySamples, true);
      }
    } else if (report.trajectorySamples.length > 1) {
      this.fxManager.spawnFlyingProjectile(report.trajectorySamples, false);
    }

    // Log terminal wound channel
    this.hudController.logWoundReport(report);

    // Check if Sniper Elite X-Ray Kill Cam or Shotgun Action Cam should trigger
    let killCamStarted = false;
    if (this.enableXRayCam) {
      killCamStarted = this.killCamDirector.startSequence(report, target);
    }

    if (!killCamStarted) {
      // Standard realtime shot execution
      applyShotReportToTarget(target.healthState, report);

      for (const w of report.woundEvents) {
        this.fxManager.spawnBloodBurst(
          w.entryPointWorld,
          w.impactDirectionWorld,
          w.energyDepositedJ,
          18
        );
        if (w.boneShattered) {
          this.fxManager.spawnBoneShatterSparks(w.entryPointWorld, w.impactDirectionWorld);
        }
      }

      for (const dism of report.dismembermentEvents) {
        this.fxManager.spawnDismembermentGibs(dism);
        this.fxManager.attachArterialFountain(target.healthState, dism);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Quick Demonstration Presets
  // ---------------------------------------------------------------------------
  private runPresetShotgunRagdoll(): void {
    this.killCamDirector.skipKillCam();
    this.spawnAllTargets();
    this.activeTargetIndex = 0;
    this.selectWeapon(WEAPON_M590);
    this.isAimingDownSights = false;
    this.hudController.setScopeOverlay(false);
    this.playerPos.set(0, 1.45, -1.0); // 4.0m point-blank from Target 0 at z = -5
    this.aimAtTargetZone('TORSO_UPPER_THORAX', this.targets[0], false);
    this.fireCooldownTimerS = 0;
    setTimeout(() => this.handleTriggerPull(this.targets[0]), 120);
  }

  private runPresetDecap50ae(): void {
    this.killCamDirector.skipKillCam();
    this.spawnAllTargets();
    this.activeTargetIndex = 1;
    this.selectWeapon(WEAPON_SILVER_TALON);
    this.isAimingDownSights = false;
    this.hudController.setScopeOverlay(false);
    this.playerPos.set(-2.2, 1.65, -2.0); // 6m from Target 1 at (-2.2, 0, -8)
    this.aimAtTargetZone('HEAD_CRANIUM', this.targets[1], true);
    this.fireCooldownTimerS = 0;
    setTimeout(() => this.handleTriggerPull(this.targets[1]), 120);
  }

  private runPresetLimbSever(): void {
    this.killCamDirector.skipKillCam();
    this.spawnAllTargets();
    this.activeTargetIndex = 0;
    this.selectWeapon(WEAPON_M590);
    this.isAimingDownSights = false;
    this.hudController.setScopeOverlay(false);
    this.playerPos.set(-0.3, 1.45, -0.8); // 4.2m aimed squarely at left bicep
    this.aimAtTargetZone('UPPER_ARM_LEFT', this.targets[0], false);
    this.fireCooldownTimerS = 0;
    setTimeout(() => this.handleTriggerPull(this.targets[0]), 120);
  }

  private runPresetSniperXray(): void {
    this.killCamDirector.skipKillCam();
    this.spawnAllTargets();
    this.activeTargetIndex = 3;
    this.selectWeapon(WEAPON_MSG90);
    this.playerPos.set(0.5, 1.50, 5.0); // 60m range from Target 3 at (0.5, 0, -55)
    this.isAimingDownSights = false;
    this.toggleAimDownSights(); // activate sniper scope
    this.aimAtTargetZone('TORSO_UPPER_THORAX', this.targets[3], true);
    this.fireCooldownTimerS = 0;
    setTimeout(() => this.handleTriggerPull(this.targets[3]), 180);
  }

  /**
   * Main per-frame update loop.
   */
  private onEngineUpdate(dt: number): void {
    // 1. Fire cooldown timer
    if (this.fireCooldownTimerS > 0) {
      this.fireCooldownTimerS -= dt;
    }

    // 2. Recoil decay
    if (this.recoilPitch > 0) {
      this.recoilPitch = Math.max(0, this.recoilPitch - dt * 25);
    }
    if (this.recoilOffsetZ > 0) {
      this.recoilOffsetZ = Math.max(0, this.recoilOffsetZ - dt * 0.4);
    }

    // 3. Player Movement (WASD) if not in Kill Cam
    if (!this.killCamDirector.isActive()) {
      const moveSpeed = 4.2 * dt;
      const yawRad = (this.cameraYaw * Math.PI) / 180;
      const fwdX = -Math.sin(yawRad);
      const fwdZ = -Math.cos(yawRad);
      const rightX = Math.cos(yawRad);
      const rightZ = -Math.sin(yawRad);

      if (this.keysPressed['KeyW']) {
        this.playerPos.x += fwdX * moveSpeed;
        this.playerPos.z += fwdZ * moveSpeed;
      }
      if (this.keysPressed['KeyS']) {
        this.playerPos.x -= fwdX * moveSpeed;
        this.playerPos.z -= fwdZ * moveSpeed;
      }
      if (this.keysPressed['KeyA']) {
        this.playerPos.x -= rightX * moveSpeed;
        this.playerPos.z -= rightZ * moveSpeed;
      }
      if (this.keysPressed['KeyD']) {
        this.playerPos.x += rightX * moveSpeed;
        this.playerPos.z += rightZ * moveSpeed;
      }

      this.cameraEntity.setPosition(this.playerPos.x, this.playerPos.y, this.playerPos.z);
      this.cameraEntity.setEulerAngles(this.cameraPitch + this.recoilPitch, this.cameraYaw, 0);

      // Weapon viewmodel recoil kick
      const baseVmZ = this.isAimingDownSights ? -0.32 : -0.48;
      this.weaponViewmodelEntity.setLocalPosition(
        this.weaponViewmodelEntity.getLocalPosition().x,
        this.weaponViewmodelEntity.getLocalPosition().y,
        baseVmZ + this.recoilOffsetZ
      );
    }

    // 4. Update Kill Cam Director
    this.killCamDirector.update(dt);

    // 5. Compute effective simulation dt accounting for Kill Cam time dilation
    const timeScale = this.killCamDirector.isActive()
      ? this.killCamDirector.getCurrentTimeScale()
      : this.baseTimeScale;
    const simDt = dt * timeScale;
    this.totalElapsedTimeS += simDt;

    // 6. Step Ragdoll Physics & Sync Mannequins
    for (const t of this.targets) {
      stepRagdollPhysics(t.healthState, simDt, 0.0);
      t.syncFromHealthState(simDt, this.totalElapsedTimeS);
    }

    // 7. Update Gore & Ballistics FX
    this.fxManager.update(simDt, this.enableBulletTrails);

    // 8. Real-time Pre-Impact Ballistic Predictor
    this.updateRealTimePredictor();
  }

  /**
   * Runs a lightweight pre-impact simulation every frame along the player's aim vector
   * against the closest live target to update telemetry and reticle pip before firing!
   */
  private updateRealTimePredictor(): void {
    const target = this.getClosestLiveTarget();
    if (!target) return;

    const aimDirPc = this.getAimDirection();
    const aimDir = vec3(aimDirPc.x, aimDirPc.y, aimDirPc.z);
    const origin = vec3(this.playerPos.x, this.playerPos.y, this.playerPos.z);

    // Simulate preview shot
    const previewReport = simulateShot(
      this.currentWeapon,
      this.currentAmmo,
      origin,
      aimDir,
      target.healthState,
      this.environment
    );

    // Compute pixel offset for reticle pip based on bullet drop and crosswind drift
    const dropCm = previewReport.bulletDropAtImpactCm;
    const windDriftCm = previewReport.windDriftAtImpactCm;
    const pxPerCm = 0.85;

    const pipOffset = {
      x: windDriftCm * pxPerCm,
      y: dropCm * pxPerCm,
    };

    this.hudController.updatePreImpactTelemetry(previewReport, target.healthState, pipOffset);
    this.hudController.updateTargetHealthDisplay(target.healthState);
  }
}

// Instantiate engine when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  new GhoulXApplication();
});
