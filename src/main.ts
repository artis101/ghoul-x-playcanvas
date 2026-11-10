import * as pc from 'playcanvas';
import {
  WeaponSpec,
  AmmoSpec,
  EnvironmentState,
  EnemyArchetypeId,
  ShotSimulationReport,
} from './contracts/ballistics.ts';
import { vec3, add, scale } from './core/ballistics/vec3.ts';
import {
  WEAPONS,
  WEAPON_M590,
  DEFAULT_ENVIRONMENT,
} from './core/ballistics/weapons.ts';
import { createTargetHealthState } from './core/ghoul/anatomy.ts';
import {
  simulateShot,
  applyShotReportToTarget,
  stepRagdollPhysics,
} from './core/ballistics/solver.ts';
import { getOrCreateMaterials, EngineMaterialPalette } from './engine/materials.ts';
import { applyRetroEnvironmentTextures } from './engine/retroTextures.ts';
import { populatePlayerWeaponViewmodel } from './engine/retroMeshBuilder.ts';
import { GhoulMannequinEntity } from './engine/mannequin.ts';
import { GoreAndBallisticsFxManager } from './engine/goreFx.ts';
import { HudController } from './engine/hudController.ts';

interface RangeTargetConfig {
  id: string;
  name: string;
  archetype: EnemyArchetypeId;
  position: { x: number; y: number; z: number };
  yawDeg: number;
}

const TARGET_CONFIGS: RangeTargetConfig[] = [
  {
    id: 'target_0',
    name: 'NYC SKINHEAD PUNK (5m)',
    archetype: 'SKINHEAD_PUNK',
    position: { x: 0, y: 0, z: -5.2 },
    yawDeg: 0,
  },
  {
    id: 'target_1',
    name: 'BALKAN MILITIA GUNNER (9m)',
    archetype: 'MILITIA_GUNNER',
    position: { x: -2.1, y: 0, z: -9.0 },
    yawDeg: 12,
  },
  {
    id: 'target_2',
    name: 'KOSOVO HEAVY ENFORCER (15m)',
    archetype: 'HEAVY_ENFORCER',
    position: { x: 2.2, y: 0, z: -15.0 },
    yawDeg: -10,
  },
  {
    id: 'target_3',
    name: 'SPETSNAZ SNIPER (42m)',
    archetype: 'SNIPER_OPERATIVE',
    position: { x: 0.4, y: 0, z: -42.0 },
    yawDeg: 0,
  },
];

interface WeaponAmmoState {
  magCap: number;
  mag: number;
  reserve: number;
  ammoIndex: number;
}

const WEAPON_CAPACITIES: Record<string, { magCap: number; reserve: number }> = {
  m590_shotgun: { magCap: 8, reserve: 40 },
  silver_talon_50ae: { magCap: 7, reserve: 35 },
  msg90_sniper: { magCap: 20, reserve: 60 },
  m4a1_carbine: { magCap: 30, reserve: 120 },
};

class GhoulXApplication {
  private canvas: HTMLCanvasElement;
  private app: pc.Application;
  private materials: EngineMaterialPalette;

  // Camera & FPS Viewmodel
  private cameraEntity: pc.Entity;
  private weaponViewmodelEntity: pc.Entity;
  private muzzleFlashEntity: pc.Entity;
  private cameraPitch = -3.5;
  private cameraYaw = 0;
  private isPointerLocked = false;
  private isAimingDownSights = false;
  private isTriggerHeld = false;
  private recoilPitch = 0;
  private recoilOffsetZ = 0;
  private moveBobPhase = 0;

  // Shooter Position
  private playerPos = new pc.Vec3(0, 1.62, 0);
  private keysPressed: Record<string, boolean> = {};

  // Arsenal & Magazine State
  private targets: GhoulMannequinEntity[] = [];
  private currentWeaponIndex = 0;
  private currentWeapon: WeaponSpec = WEAPON_M590;
  private currentAmmo: AmmoSpec = WEAPON_M590.defaultAmmo;
  private ammoInventory: Map<string, WeaponAmmoState> = new Map();
  private reloadTimerS = 0;
  private fireCooldownTimerS = 0;

  private environment: EnvironmentState = { ...DEFAULT_ENVIRONMENT };
  private enableXRayInspector = false;
  private totalElapsedTimeS = 0;

  // Engine Subsystems
  private fxManager: GoreAndBallisticsFxManager;
  private hudController: HudController;

  constructor() {
    this.canvas = document.getElementById('playcanvas-viewport') as HTMLCanvasElement;
    if (!this.canvas) {
      throw new Error('Canvas #playcanvas-viewport not found in document!');
    }

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

    this.initAmmoInventory();
    this.buildRangeEnvironment();

    // Build First-Person Camera & PS1/PS2 Gun Viewmodel
    this.cameraEntity = new pc.Entity('PlayerCamera');
    this.cameraEntity.addComponent('camera', {
      clearColor: new pc.Color(0.05, 0.07, 0.10),
      fov: 68,
      nearClip: 0.08,
      farClip: 400,
    });
    this.cameraEntity.setPosition(this.playerPos.x, this.playerPos.y, this.playerPos.z);
    this.app.root.addChild(this.cameraEntity);

    this.weaponViewmodelEntity = new pc.Entity('WeaponViewmodel');
    this.weaponViewmodelEntity.setPosition(0.24, -0.22, -0.48);
    this.cameraEntity.addChild(this.weaponViewmodelEntity);
    this.muzzleFlashEntity = populatePlayerWeaponViewmodel(
      this.weaponViewmodelEntity,
      this.currentWeapon,
      this.materials
    );

    this.fxManager = new GoreAndBallisticsFxManager(this.app, this.materials);
    this.hudController = new HudController();

    this.spawnAllTargets();
    this.syncWeaponHud();
    this.bindInputListeners();

    this.app.start();
    this.app.on('update', (dt: number) => this.onEngineUpdate(dt));
  }

  private initAmmoInventory(): void {
    this.ammoInventory.clear();
    for (const w of WEAPONS) {
      const cap = WEAPON_CAPACITIES[w.id] || { magCap: 12, reserve: 48 };
      this.ammoInventory.set(w.id, {
        magCap: cap.magCap,
        mag: cap.magCap,
        reserve: cap.reserve,
        ammoIndex: 0,
      });
    }
  }

  private buildRangeEnvironment(): void {
    const light = new pc.Entity('SunLight');
    light.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1.0, 0.96, 0.88),
      intensity: 1.55,
      castShadows: true,
      shadowResolution: 2048,
      shadowDistance: 75,
    });
    light.setEulerAngles(48, 32, 0);
    this.app.root.addChild(light);

    const fillLight = new pc.Entity('FillLight');
    fillLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(0.28, 0.42, 0.58),
      intensity: 0.72,
      castShadows: false,
    });
    fillLight.setEulerAngles(-45, -145, 0);
    this.app.root.addChild(fillLight);

    const floor = new pc.Entity('ArenaFloor');
    floor.addComponent('render', {
      type: 'box',
      material: this.materials.floorGridMat,
      receiveShadows: true,
    });
    floor.setLocalScale(40, 0.2, 160);
    floor.setPosition(0, -0.1, -50);
    this.app.root.addChild(floor);

    const markerDistances = [5, 10, 15, 25, 42];
    for (const d of markerDistances) {
      const lineMarker = new pc.Entity(`DistanceMarker_${d}m`);
      lineMarker.addComponent('render', {
        type: 'box',
        material: this.materials.rangeDistanceMarkerMat,
      });
      lineMarker.setLocalScale(17, 0.02, 0.08);
      lineMarker.setPosition(0, 0.01, -d);
      this.app.root.addChild(lineMarker);

      for (const side of [-8.5, 8.5]) {
        const post = new pc.Entity(`MarkerPost_${d}m_${side}`);
        post.addComponent('render', {
          type: 'box',
          material: this.materials.barrierConcreteMat,
        });
        post.setLocalScale(0.32, 1.1, 0.32);
        post.setPosition(side, 0.55, -d);
        this.app.root.addChild(post);
      }
    }

    for (const z of [-8, -20, -34, -48]) {
      for (const side of [-9.5, 9.5]) {
        const barrier = new pc.Entity(`Barrier_${side}_${z}`);
        barrier.addComponent('render', {
          type: 'box',
          material: this.materials.barrierConcreteMat,
          castShadows: true,
        });
        barrier.setLocalScale(1.1, 1.35, 7.5);
        barrier.setPosition(side, 0.675, z);
        this.app.root.addChild(barrier);
      }
    }
  }

  private spawnAllTargets(): void {
    const oldTargets = this.targets;
    const nextTargets: GhoulMannequinEntity[] = [];

    this.fxManager.clearAll();

    for (const cfg of TARGET_CONFIGS) {
      const yawRad = (cfg.yawDeg * Math.PI) / 180;
      const healthState = createTargetHealthState(
        cfg.id,
        cfg.name,
        vec3(cfg.position.x, cfg.position.y, cfg.position.z),
        yawRad,
        cfg.archetype
      );

      const mannequin = new GhoulMannequinEntity(
        this.app,
        healthState,
        this.materials,
        this.fxManager
      );
      this.app.root.addChild(mannequin.rootEntity);
      nextTargets.push(mannequin);

      if (this.enableXRayInspector) {
        mannequin.setXRayMode(true);
      }
    }

    for (const t of oldTargets) {
      t.destroy();
    }
    this.targets = nextTargets;
  }

  private selectWeaponByIndex(idx: number): void {
    const wrapped = ((idx % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
    if (wrapped === this.currentWeaponIndex && this.reloadTimerS <= 0) return;

    this.currentWeaponIndex = wrapped;
    this.currentWeapon = WEAPONS[wrapped];
    const inv = this.ammoInventory.get(this.currentWeapon.id)!;
    this.currentAmmo = this.currentWeapon.availableAmmo[inv.ammoIndex] || this.currentWeapon.defaultAmmo;
    this.reloadTimerS = 0;

    if (this.isAimingDownSights) {
      this.setAimDownSights(false);
    }

    this.muzzleFlashEntity = populatePlayerWeaponViewmodel(
      this.weaponViewmodelEntity,
      this.currentWeapon,
      this.materials
    );
    this.syncWeaponHud();
  }

  private cycleAmmoType(): void {
    const avail = this.currentWeapon.availableAmmo;
    if (avail.length <= 1) {
      this.hudController.pushSystemToast(this.currentWeapon.codeName, `${this.currentAmmo.caliber} ONLY`);
      return;
    }

    const inv = this.ammoInventory.get(this.currentWeapon.id)!;
    inv.ammoIndex = (inv.ammoIndex + 1) % avail.length;
    this.currentAmmo = avail[inv.ammoIndex];
    this.syncWeaponHud();
    this.hudController.pushSystemToast('AMMO LOADED', this.currentAmmo.name.toUpperCase());
  }

  private startReload(): void {
    if (this.reloadTimerS > 0) return;
    const inv = this.ammoInventory.get(this.currentWeapon.id)!;

    if (inv.mag >= inv.magCap) {
      // Convenience: if mag is already full and all hostiles are dead, [R] also spawns a fresh squad!
      if (this.targets.every((t) => !t.healthState.alive)) {
        this.spawnAllTargets();
        this.initAmmoInventory();
        this.syncWeaponHud();
      }
      return;
    }

    if (inv.reserve <= 0) {
      // Refill tactical reserve from depot crate on empty so player never gets permanently stuck
      inv.reserve = inv.magCap * 3;
    }

    this.reloadTimerS = 0.65;
    this.syncWeaponHud();
  }

  private syncWeaponHud(): void {
    const inv = this.ammoInventory.get(this.currentWeapon.id)!;
    this.hudController.updateWeaponHud(
      this.currentWeapon,
      this.currentAmmo,
      inv.mag,
      inv.reserve,
      this.reloadTimerS > 0
    );
  }

  private bindInputListeners(): void {
    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.canvas;
      if (!this.isPointerLocked) {
        this.isTriggerHeld = false;
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isPointerLocked) return;

      const sensitivity = this.isAimingDownSights ? 0.075 : 0.15;
      this.cameraYaw -= e.movementX * sensitivity;
      this.cameraPitch -= e.movementY * sensitivity;
      this.cameraPitch = Math.max(-85, Math.min(85, this.cameraPitch));
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.isPointerLocked) {
        this.canvas.requestPointerLock();
        return;
      }

      if (e.button === 0) {
        this.isTriggerHeld = true;
        this.handleTriggerPull();
      } else if (e.button === 2) {
        e.preventDefault();
        this.setAimDownSights(!this.isAimingDownSights);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.isTriggerHeld = false;
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.deltaY > 0) {
          this.selectWeaponByIndex(this.currentWeaponIndex + 1);
        } else if (e.deltaY < 0) {
          this.selectWeaponByIndex(this.currentWeaponIndex - 1);
        }
      },
      { passive: false }
    );

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      this.keysPressed[e.code] = true;

      if (e.code === 'Digit1') {
        this.selectWeaponByIndex(0);
      } else if (e.code === 'Digit2') {
        this.selectWeaponByIndex(1);
      } else if (e.code === 'Digit3') {
        this.selectWeaponByIndex(2);
      } else if (e.code === 'Digit4') {
        this.selectWeaponByIndex(3);
      } else if (e.code === 'KeyB') {
        this.cycleAmmoType();
      } else if (e.code === 'KeyR') {
        this.startReload();
      } else if (e.code === 'KeyT' || e.code === 'Backspace') {
        e.preventDefault();
        this.spawnAllTargets();
        this.initAmmoInventory();
        this.syncWeaponHud();
        this.hudController.pushSystemToast('WAVE SPAWNED', '4 HOSTILES DEPLOYED');
      } else if (e.code === 'KeyF') {
        this.handleTriggerPull();
      } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.setAimDownSights(!this.isAimingDownSights);
      } else if (e.code === 'KeyX') {
        this.enableXRayInspector = !this.enableXRayInspector;
        for (const t of this.targets) {
          t.setXRayMode(this.enableXRayInspector);
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keysPressed[e.code] = false;
    });
  }

  private setAimDownSights(active: boolean): void {
    this.isAimingDownSights = active;
    const isSniper = this.currentWeapon.role === 'SNIPER';

    if (active) {
      const zoom = this.currentWeapon.scopeZoomLevels[0] || 1.6;
      if (this.cameraEntity.camera) {
        this.cameraEntity.camera.fov = 68 / Math.max(1.25, zoom);
      }
      this.weaponViewmodelEntity.setPosition(0, -0.145, -0.32);
      if (isSniper) {
        this.hudController.setScopeOverlay(true, zoom, 42.0, 0);
      }
    } else {
      if (this.cameraEntity.camera) {
        this.cameraEntity.camera.fov = 68;
      }
      this.weaponViewmodelEntity.setPosition(0.24, -0.22, -0.48);
      this.hudController.setScopeOverlay(false);
    }
  }

  private getAimDirection(): pc.Vec3 {
    const pitchRad = (this.cameraPitch * Math.PI) / 180;
    const yawRad = (this.cameraYaw * Math.PI) / 180;

    const x = -Math.sin(yawRad) * Math.cos(pitchRad);
    const y = Math.sin(pitchRad);
    const z = -Math.cos(yawRad) * Math.cos(pitchRad);

    return new pc.Vec3(x, y, z).normalize();
  }

  private findBestTargetHit(
    origin: { x: number; y: number; z: number },
    aimDir: { x: number; y: number; z: number },
    ammoOverride?: AmmoSpec,
    excludeTargets?: Set<GhoulMannequinEntity>
  ): { target: GhoulMannequinEntity; report: ShotSimulationReport } | null {
    if (this.targets.length === 0) return null;
    const activeAmmo = ammoOverride || this.currentAmmo;

    let bestHit: { target: GhoulMannequinEntity; report: ShotSimulationReport } | null = null;
    let bestImpactTime = Infinity;

    for (let i = 0; i < this.targets.length; i++) {
      const candidate = this.targets[i];
      if (excludeTargets?.has(candidate)) continue;

      const candReport = simulateShot(
        this.currentWeapon,
        activeAmmo,
        origin,
        aimDir,
        candidate.healthState,
        this.environment
      );

      if (candReport.hitTarget) {
        const tHit = candReport.flightTimeAtImpactS || candReport.targetDistanceM / 500;
        if (tHit < bestImpactTime) {
          bestImpactTime = tHit;
          bestHit = { target: candidate, report: candReport };
        }
      }
    }

    if (bestHit || excludeTargets) {
      return bestHit;
    }

    const fallback = this.targets[0];
    const fbReport = simulateShot(
      this.currentWeapon,
      activeAmmo,
      origin,
      aimDir,
      fallback.healthState,
      this.environment
    );
    return { target: fallback, report: fbReport };
  }

  private applyImpactFxAndState(
    target: GhoulMannequinEntity,
    report: ShotSimulationReport
  ): void {
    const wasAlive = target.healthState.alive;
    applyShotReportToTarget(target.healthState, report);
    const isLethalNow = !target.healthState.alive;

    this.hudController.triggerHitmarker(isLethalNow);
    this.hudController.pushCombatFeed(
      report,
      this.currentWeapon.codeName,
      target.healthState.name,
      wasAlive,
      target.healthState.alive
    );

    for (const w of report.woundEvents) {
      if (w.armorStopped) {
        this.fxManager.spawnArmorImpactSparks(w.entryPointWorld, w.entryNormalWorld);
      } else {
        this.fxManager.spawnBloodBurst(
          w.entryPointWorld,
          w.impactDirectionWorld,
          w.energyDepositedJ,
          14
        );
        // Exit-wound blood spray when a penetrator punches clean out the back!
        if (w.exitEnergyJ > 140) {
          this.fxManager.spawnBloodBurst(
            w.exitPointWorld,
            w.impactDirectionWorld,
            w.energyDepositedJ * 0.85,
            10
          );
        }
        if (w.boneShattered) {
          this.fxManager.spawnBoneShatterSparks(w.entryPointWorld, w.impactDirectionWorld);
        }
      }
    }

    for (const dism of report.dismembermentEvents) {
      this.fxManager.spawnDismembermentGibs(dism);
      this.fxManager.attachArterialFountain(target.healthState, dism);
    }
  }

  private handleTriggerPull(): void {
    if (this.fireCooldownTimerS > 0 || this.reloadTimerS > 0) return;

    const inv = this.ammoInventory.get(this.currentWeapon.id)!;
    if (inv.mag <= 0) {
      this.startReload();
      return;
    }

    inv.mag -= 1;
    this.fireCooldownTimerS = 60 / this.currentWeapon.fireRateRpm;
    this.syncWeaponHud();

    // Crisp FPS Recoil Kick & Muzzle Flash
    this.recoilPitch = Math.min(8.0, this.recoilPitch + this.currentWeapon.recoilKickDeg * 0.72);
    this.recoilOffsetZ = 0.075;
    this.muzzleFlashEntity.enabled = true;
    window.setTimeout(() => {
      if (this.muzzleFlashEntity) {
        this.muzzleFlashEntity.enabled = false;
      }
    }, 42);

    const aimDirPc = this.getAimDirection();
    const aimDir = vec3(aimDirPc.x, aimDirPc.y, aimDirPc.z);
    const origin = vec3(this.playerPos.x, this.playerPos.y, this.playerPos.z);

    const match = this.findBestTargetHit(origin, aimDir);
    if (!match) return;

    const { target, report } = match;

    // Spawn 3D brass/pellet projectiles
    if (this.currentAmmo.pelletCount > 1) {
      for (const pr of report.pelletResults) {
        this.fxManager.spawnFlyingProjectile(pr.trajectorySamples, true);
      }
    } else if (report.trajectorySamples.length > 1) {
      this.fxManager.spawnFlyingProjectile(report.trajectorySamples, false);
    }

    if (report.hitTarget) {
      this.applyImpactFxAndState(target, report);

      // Over-penetration collateral pass: high-penetration AP/FMJ rounds exiting a body
      // with substantial residual velocity continue downrange into lined-up combatants!
      if (this.currentAmmo.pelletCount === 1 && report.woundEvents.length > 0) {
        const lastWound = report.woundEvents[report.woundEvents.length - 1];
        if (!lastWound.armorStopped && lastWound.exitEnergyJ > 160 && lastWound.exitVelocityMs > 90) {
          const excluded = new Set<GhoulMannequinEntity>([target]);
          const residualAmmo: AmmoSpec = {
            ...this.currentAmmo,
            muzzleVelocityMs: lastWound.exitVelocityMs,
            spreadRadians: 0,
          };
          const exitOrigin = add(
            lastWound.exitPointWorld,
            scale(lastWound.impactDirectionWorld, 0.06)
          );
          const collateral = this.findBestTargetHit(
            exitOrigin,
            lastWound.impactDirectionWorld,
            residualAmmo,
            excluded
          );
          if (collateral && collateral.report.hitTarget) {
            this.applyImpactFxAndState(collateral.target, collateral.report);
          }
        }
      }
    }

    if (inv.mag === 0) {
      window.setTimeout(() => this.startReload(), 220);
    }
  }

  private onEngineUpdate(dt: number): void {
    const clampedDt = Math.min(0.05, dt);
    this.totalElapsedTimeS += clampedDt;

    if (this.fireCooldownTimerS > 0) {
      this.fireCooldownTimerS -= clampedDt;
    }

    // Handle Reload Completion
    if (this.reloadTimerS > 0) {
      this.reloadTimerS -= clampedDt;
      if (this.reloadTimerS <= 0) {
        this.reloadTimerS = 0;
        const inv = this.ammoInventory.get(this.currentWeapon.id)!;
        const needed = inv.magCap - inv.mag;
        const loaded = Math.min(needed, inv.reserve);
        inv.mag += loaded;
        inv.reserve -= loaded;
        this.syncWeaponHud();
      }
    }

    // Full-Auto Trigger Hold for Assault Rifle
    if (this.isTriggerHeld && this.currentWeapon.role === 'ASSAULT_RIFLE') {
      this.handleTriggerPull();
    }

    // Recoil Recovery
    if (this.recoilPitch > 0) {
      this.recoilPitch = Math.max(0, this.recoilPitch - clampedDt * 24);
    }
    if (this.recoilOffsetZ > 0) {
      this.recoilOffsetZ = Math.max(0, this.recoilOffsetZ - clampedDt * 0.45);
    }

    // First-Person Movement & Subtle Viewmodel Bob
    const moveSpeed = 5.0 * clampedDt;
    const yawRad = (this.cameraYaw * Math.PI) / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const rightX = Math.cos(yawRad);
    const rightZ = -Math.sin(yawRad);

    let moving = false;
    if (this.keysPressed['KeyW']) {
      this.playerPos.x += fwdX * moveSpeed;
      this.playerPos.z += fwdZ * moveSpeed;
      moving = true;
    }
    if (this.keysPressed['KeyS']) {
      this.playerPos.x -= fwdX * moveSpeed;
      this.playerPos.z -= fwdZ * moveSpeed;
      moving = true;
    }
    if (this.keysPressed['KeyA']) {
      this.playerPos.x -= rightX * moveSpeed;
      this.playerPos.z -= rightZ * moveSpeed;
      moving = true;
    }
    if (this.keysPressed['KeyD']) {
      this.playerPos.x += rightX * moveSpeed;
      this.playerPos.z += rightZ * moveSpeed;
      moving = true;
    }

    // Keep player inside tactical depot bounds
    this.playerPos.x = Math.max(-8.2, Math.min(8.2, this.playerPos.x));
    this.playerPos.z = Math.max(-52.0, Math.min(6.0, this.playerPos.z));

    if (moving) {
      this.moveBobPhase += clampedDt * 10.5;
    }

    this.cameraEntity.setPosition(this.playerPos.x, this.playerPos.y, this.playerPos.z);
    this.cameraEntity.setEulerAngles(this.cameraPitch + this.recoilPitch, this.cameraYaw, 0);

    const baseVmX = this.isAimingDownSights ? 0 : 0.24;
    const baseVmY = this.isAimingDownSights ? -0.145 : -0.22;
    const baseVmZ = this.isAimingDownSights ? -0.32 : -0.48;
    const reloadDipY = this.reloadTimerS > 0 ? -Math.sin((this.reloadTimerS / 0.65) * Math.PI) * 0.14 : 0;
    const bobX = moving && !this.isAimingDownSights ? Math.cos(this.moveBobPhase * 0.5) * 0.008 : 0;
    const bobY = moving && !this.isAimingDownSights ? Math.abs(Math.sin(this.moveBobPhase)) * -0.009 : 0;

    this.weaponViewmodelEntity.setLocalPosition(
      baseVmX + bobX,
      baseVmY + bobY + reloadDipY,
      baseVmZ + this.recoilOffsetZ
    );
    this.weaponViewmodelEntity.enabled = !(
      this.isAimingDownSights && this.currentWeapon.role === 'SNIPER'
    );

    // Dynamic Crosshair Bloom & Sniper Scope Rangefinder
    const bloom = 1.0 + this.recoilPitch * 0.08 + (moving ? 0.16 : 0);
    const hideCrosshair = this.isAimingDownSights && this.currentWeapon.role === 'SNIPER';
    this.hudController.setCrosshairBloom(bloom, hideCrosshair);

    if (hideCrosshair) {
      const aimDirPc = this.getAimDirection();
      const match = this.findBestTargetHit(
        vec3(this.playerPos.x, this.playerPos.y, this.playerPos.z),
        vec3(aimDirPc.x, aimDirPc.y, aimDirPc.z)
      );
      if (match) {
        const zoom = this.currentWeapon.scopeZoomLevels[0] || 4.0;
        this.hudController.setScopeOverlay(
          true,
          zoom,
          match.report.targetDistanceM,
          match.report.bulletDropAtImpactCm
        );
      }
    }

    const allDown = this.targets.length > 0 && this.targets.every((t) => !t.healthState.alive);
    this.hudController.updateContextPrompt(this.isPointerLocked, allDown);

    // Step 3D Articulated PBD Ragdoll Physics & Sync PS1/PS2 Combatants
    for (const t of this.targets) {
      stepRagdollPhysics(t.healthState, clampedDt, 0.0);
      t.syncFromHealthState(clampedDt, this.totalElapsedTimeS);
    }

    // Update Gore, Projectiles, Dropped Weapons & Arterial Fountains (no debug yellow lines!)
    this.fxManager.update(clampedDt, false);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new GhoulXApplication();
});
