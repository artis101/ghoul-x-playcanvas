import * as pc from 'playcanvas';
import { ShotSimulationReport, Vec3Like } from '../contracts/ballistics.ts';
import { applyShotReportToTarget } from '../core/ballistics/solver.ts';
import { cross, length, lengthSq, normalize, vec3 } from '../core/ballistics/vec3.ts';
import { GhoulMannequinEntity } from './mannequin.ts';
import { GoreAndBallisticsFxManager } from './goreFx.ts';

export type KillCamPhase =
  | 'IDLE'
  | 'BULLET_TRACKING'
  | 'XRAY_PENETRATION'
  | 'RAGDOLL_AFTERMATH'
  | 'BUCKSHOT_TRACKING'
  | 'IMPACT_FLASH'
  | 'RAGDOLL_LAUNCH';

export interface KillCamDirectorOptions {
  app: pc.AppBase;
  cameraEntity: pc.Entity;
  fxManager: GoreAndBallisticsFxManager;
  shouldRestoreXRayVision?: () => boolean;
  onSequenceComplete?: () => void;
}

/**
 * Class XRayKillCamDirector implements:
 * 1. Sniper Elite X-Ray Kill Cam:
 *    - Phase 1: Slow-motion bullet tracking following spinning projectile downrange along RK4 path.
 *    - Phase 2: Close-up X-Ray Penetration (timeScale 0.018), translucent anatomy silhouette, bone shatter & organ rupture.
 *    - Phase 3: Slow-motion Ragdoll Aftermath (timeScale 0.28) watching the enemy collapse with spraying arterial fountains.
 * 2. Shotgun Ragdoll Action Cam:
 *    - Pre-calculated muzzle lethality, buckshot swarm tracking, and high-impact Ragdoll Launch Action Cam.
 */
export class XRayKillCamDirector {
  public readonly app: pc.AppBase;
  public readonly cameraEntity: pc.Entity;
  public readonly fxManager: GoreAndBallisticsFxManager;

  private activePhase: KillCamPhase = 'IDLE';
  private phaseTimerS = 0;
  private simTimerS = 0;
  private trackingDurationS = 0.75;
  private shotApplied = false;
  private currentReport: ShotSimulationReport | null = null;
  private currentTarget: GhoulMannequinEntity | null = null;

  // Stored player camera transform to restore after Kill Cam
  private defaultCamPos = new pc.Vec3(0, 1.65, 0);
  private defaultCamRot = new pc.Vec3(0, 0, 0);

  // Time scale applied to game loop during Kill Cam
  private currentTimeScale = 1.0;

  // UI elements
  private overlayEl: HTMLElement | null = null;
  private reticleLayerEl: HTMLElement | null = null;
  private telemetryEl: HTMLElement | null = null;
  private woundTickerEl: HTMLElement | null = null;
  private shouldRestoreXRayVision?: () => boolean;
  private onSequenceCompleteCallback?: () => void;

  constructor(options: KillCamDirectorOptions) {
    this.app = options.app;
    this.cameraEntity = options.cameraEntity;
    this.fxManager = options.fxManager;
    this.shouldRestoreXRayVision = options.shouldRestoreXRayVision;
    this.onSequenceCompleteCallback = options.onSequenceComplete;

    this.overlayEl = document.getElementById('xray-cinema-overlay');
    this.reticleLayerEl = document.getElementById('reticle-layer');
    this.telemetryEl = document.getElementById('xray-live-telemetry');
    this.woundTickerEl = document.getElementById('xray-wound-ticker');

    const skipBtn = document.getElementById('btn-skip-killcam');
    if (skipBtn) {
      skipBtn.addEventListener('click', () => this.skipKillCam());
    }

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.isActive()) {
        e.preventDefault();
        this.skipKillCam();
      }
    });
  }

  public isActive(): boolean {
    return this.activePhase !== 'IDLE';
  }

  public getCurrentTimeScale(): number {
    return this.currentTimeScale;
  }

  private computeShotBasis(aimDir: Vec3Like): { fwd: Vec3Like; right: Vec3Like } {
    const fwd = lengthSq(aimDir) > 1e-6 ? normalize(aimDir) : vec3(0, 0, -1);
    const rightRaw = cross(fwd, vec3(0, 1, 0));
    const right = lengthSq(rightRaw) > 1e-6 ? normalize(rightRaw) : vec3(1, 0, 0);
    return { fwd, right };
  }

  private sampleBulletTrajectory(
    report: ShotSimulationReport,
    simTimeS: number
  ): { pos: Vec3Like; dir: Vec3Like } {
    const samples = report.trajectorySamples;
    if (samples && samples.length >= 2) {
      let idx = 0;
      while (idx < samples.length - 2 && samples[idx + 1].timeS <= simTimeS) {
        idx++;
      }
      const s0 = samples[idx];
      const s1 = samples[Math.min(samples.length - 1, idx + 1)];
      const segDt = s1.timeS - s0.timeS;
      const alpha = segDt > 1e-6 ? Math.min(1, Math.max(0, (simTimeS - s0.timeS) / segDt)) : 0;
      const pos = vec3(
        s0.position.x + (s1.position.x - s0.position.x) * alpha,
        s0.position.y + (s1.position.y - s0.position.y) * alpha,
        s0.position.z + (s1.position.z - s0.position.z) * alpha
      );
      const dir =
        lengthSq(s0.velocity) > 1e-4 ? normalize(s0.velocity) : report.aimDirectionWorld;
      return { pos, dir };
    }

    const flightT = Math.max(0.008, report.flightTimeAtImpactS);
    const normT = Math.min(1, simTimeS / flightT);
    const dist = report.targetDistanceM * normT;
    const pos = vec3(
      report.originWorld.x + report.aimDirectionWorld.x * dist,
      report.originWorld.y +
        report.aimDirectionWorld.y * dist -
        (report.bulletDropAtImpactCm / 100) * (normT * normT),
      report.originWorld.z + report.aimDirectionWorld.z * dist
    );
    return { pos, dir: report.aimDirectionWorld };
  }

  private applyImpactEffects(
    report: ShotSimulationReport,
    target: GhoulMannequinEntity,
    isBuckshot = false
  ): void {
    if (this.shotApplied) return;
    this.shotApplied = true;

    applyShotReportToTarget(target.healthState, report);

    if (isBuckshot) {
      this.fxManager.spawnBloodBurst(
        target.healthState.worldPosition,
        report.aimDirectionWorld,
        report.totalEnergyDepositedJ,
        42
      );
    }

    for (const wound of report.woundEvents) {
      this.fxManager.spawnBloodBurst(
        wound.entryPointWorld,
        wound.impactDirectionWorld,
        wound.energyDepositedJ,
        isBuckshot ? 8 : 16
      );
      if (wound.boneShattered || wound.boneFractured) {
        this.fxManager.spawnBoneShatterSparks(
          wound.entryPointWorld,
          wound.impactDirectionWorld
        );
      }
    }

    for (const dism of report.dismembermentEvents) {
      this.fxManager.spawnDismembermentGibs(dism);
      this.fxManager.attachArterialFountain(target.healthState, dism);
    }
  }

  /**
   * Starts a dynamic Kill Cam sequence based on the simulation report.
   */
  public startSequence(
    report: ShotSimulationReport,
    targetEntity: GhoulMannequinEntity
  ): boolean {
    if (this.isActive()) return false;
    if (!report.hitTarget) return false;

    const isBuckshot =
      (report.pelletCount > 1 || report.ammoId.includes('BUCK')) &&
      (report.isLethalKill || report.ragdollPlan.willEnableRagdoll || report.severedZones.length > 0);
    const isPrecisionKillCam = !isBuckshot && (report.triggerXRayKillCam || report.isLethalKill);

    if (!isBuckshot && !isPrecisionKillCam) {
      return false;
    }

    this.currentReport = report;
    this.currentTarget = targetEntity;
    this.shotApplied = false;
    this.phaseTimerS = 0;
    this.simTimerS = 0;

    // Cache original player camera transform
    const pos = this.cameraEntity.getPosition();
    const rot = this.cameraEntity.getEulerAngles();
    this.defaultCamPos.set(pos.x, pos.y, pos.z);
    this.defaultCamRot.set(rot.x, rot.y, rot.z);

    // Hide HUD crosshair / sniper scope mask and show Cinema Letterbox Overlay
    this.reticleLayerEl?.classList.add('hidden');
    this.overlayEl?.classList.remove('hidden');

    if (isBuckshot) {
      const flightTime = Math.max(0.008, report.flightTimeAtImpactS);
      this.trackingDurationS = 0.36;
      this.activePhase = 'BUCKSHOT_TRACKING';
      this.currentTimeScale = Math.max(0.02, (flightTime * 0.95) / this.trackingDurationS);

      const impulseMag = length(report.ragdollPlan.netRootImpulseWorld);
      if (this.telemetryEl) {
        this.telemetryEl.textContent = `12G BUCKSHOT // PRE-CALCULATED IMPULSE: ${impulseMag.toFixed(0)} N*s | LIFT: +${report.ragdollPlan.launchLiftVelocityMs.toFixed(1)} m/s`;
      }
      if (this.woundTickerEl) {
        this.woundTickerEl.textContent = `PRE-IMPACT TRAUMA LOCKED // ${report.pelletCount}-PELLET CONE ARRIVAL IN ${report.flightTimeAtImpactS.toFixed(3)}s`;
      }
      return true;
    }

    // Sniper Elite X-Ray Kill Cam
    const flightTime = Math.max(0.01, report.flightTimeAtImpactS);
    this.trackingDurationS = Math.max(0.55, Math.min(1.1, flightTime * 12.0));
    this.activePhase = 'BULLET_TRACKING';
    this.currentTimeScale = (flightTime * 0.96) / this.trackingDurationS;

    if (this.telemetryEl) {
      this.telemetryEl.textContent = `VEL: ${report.impactSpeedMs.toFixed(0)} m/s | E_k: ${report.impactEnergyJ.toFixed(0)} J | TARGET: ${report.xRayFocusZone || 'VITAL'}`;
    }
    if (this.woundTickerEl) {
      this.woundTickerEl.textContent = `CRITICAL ANATOMICAL PENETRATION CONFIRMED // TIME DILATION ACTIVE`;
    }
    return true;
  }

  /**
   * Updates Kill Cam phases and cinematic camera interpolation.
   */
  public update(realDt: number): void {
    if (this.activePhase === 'IDLE' || !this.currentReport || !this.currentTarget) {
      return;
    }

    this.phaseTimerS += realDt;
    const report = this.currentReport;
    const target = this.currentTarget;
    const targetPos = target.healthState.worldPosition;
    const { fwd, right } = this.computeShotBasis(report.aimDirectionWorld);

    switch (this.activePhase) {
      // -----------------------------------------------------------------------
      // SNIPER ELITE X-RAY KILL CAM PHASES
      // -----------------------------------------------------------------------
      case 'BULLET_TRACKING': {
        this.simTimerS += realDt * this.currentTimeScale;
        const flightTime = Math.max(0.01, report.flightTimeAtImpactS);
        const clampedSimT = Math.min(flightTime * 0.98, this.simTimerS);
        const { pos: bulletPos, dir: bulletDir } = this.sampleBulletTrajectory(report, clampedSimT);

        // Camera trails slightly behind (-fwd), to the right (+right), and slightly above the spinning projectile
        const camX = bulletPos.x - fwd.x * 0.65 + right.x * 0.28;
        const camY = bulletPos.y - fwd.y * 0.65 + 0.14;
        const camZ = bulletPos.z - fwd.z * 0.65 + right.z * 0.28;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(
          new pc.Vec3(
            bulletPos.x + bulletDir.x * 0.75,
            bulletPos.y + bulletDir.y * 0.75,
            bulletPos.z + bulletDir.z * 0.75
          )
        );

        if (this.phaseTimerS >= this.trackingDurationS || clampedSimT >= flightTime * 0.96) {
          // Transition to Phase 2: X-Ray Penetration
          this.activePhase = 'XRAY_PENETRATION';
          this.currentTimeScale = 0.018;
          this.phaseTimerS = 0;

          // Turn on translucent anatomical X-Ray mode
          target.setXRayMode(true, report.xRayFocusZone);

          // Apply shot report & gore FX immediately at impact
          this.applyImpactEffects(report, target, false);

          if (this.woundTickerEl) {
            const org = report.rupturedOrgans.join(', ') || 'VITAL ZONE';
            const b = report.shatteredBones.join(', ');
            this.woundTickerEl.textContent = `CAVITATION TRAUMA: ${org}${b ? ' | FRACTURED: ' + b : ''}`;
          }
        }
        break;
      }

      case 'XRAY_PENETRATION': {
        this.currentTimeScale = 0.018;

        // Camera frames target anatomy at close range along incoming shot angle + slight side angle
        const focusPt = report.xRayHighlightPointWorld || {
          x: targetPos.x,
          y: targetPos.y + 1.38,
          z: targetPos.z,
        };
        const orbitBlend = Math.min(1.0, this.phaseTimerS / 0.9);
        const sideOffset = 0.48 + orbitBlend * 0.22;

        const camX = focusPt.x - fwd.x * 1.2 + right.x * sideOffset;
        const camY = focusPt.y + 0.08;
        const camZ = focusPt.z - fwd.z * 1.2 + right.z * sideOffset;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(new pc.Vec3(focusPt.x, focusPt.y, focusPt.z));

        if (this.phaseTimerS >= 0.9) {
          // Transition to Phase 3: Ragdoll Aftermath
          this.activePhase = 'RAGDOLL_AFTERMATH';
          this.currentTimeScale = 0.28;
          this.phaseTimerS = 0;
          target.setXRayMode(Boolean(this.shouldRestoreXRayVision?.()));

          if (this.woundTickerEl) {
            this.woundTickerEl.textContent = `NEURO-KINETIC COLLAPSE // RAGDOLL PHYSICS ACTIVE`;
          }
        }
        break;
      }

      case 'RAGDOLL_AFTERMATH': {
        this.currentTimeScale = 0.28;

        // Smoothly orbit camera back as ragdoll collapses
        const t = Math.min(1.0, this.phaseTimerS / 1.6);
        const lateral = Math.sin(0.4 + t * 1.2) * 1.9;
        const backDist = 1.8 + t * 0.6;
        const camX = targetPos.x - fwd.x * backDist + right.x * lateral;
        const camY = Math.max(0.35, targetPos.y + 1.15 + t * 0.25);
        const camZ = targetPos.z - fwd.z * backDist + right.z * lateral;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(new pc.Vec3(targetPos.x, targetPos.y + 0.85, targetPos.z));

        if (this.phaseTimerS >= 1.6) {
          this.completeKillCam();
        }
        break;
      }

      // -----------------------------------------------------------------------
      // 12-GAUGE SHOTGUN ACTION CAM PHASES
      // -----------------------------------------------------------------------
      case 'BUCKSHOT_TRACKING': {
        // Low-angle three-quarter camera watching the 10-pellet cone converge on chest
        const camX = targetPos.x - fwd.x * 2.3 - right.x * 0.85;
        const camY = targetPos.y + 0.65;
        const camZ = targetPos.z - fwd.z * 2.3 - right.z * 0.85;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(new pc.Vec3(targetPos.x, targetPos.y + 1.15, targetPos.z));

        if (this.phaseTimerS >= this.trackingDurationS) {
          this.activePhase = 'IMPACT_FLASH';
          this.currentTimeScale = 0.04;
          this.phaseTimerS = 0;

          // Flash X-Ray silhouette for instant bone/tissue rupture
          target.setXRayMode(true);
          this.applyImpactEffects(report, target, true);

          if (this.woundTickerEl) {
            this.woundTickerEl.textContent = `SHOTGUN OBLITERATION // LAUNCH VELOCITY: +${report.ragdollPlan.launchLiftVelocityMs.toFixed(1)} m/s`;
          }
        }
        break;
      }

      case 'IMPACT_FLASH': {
        if (this.phaseTimerS >= 0.18) {
          this.activePhase = 'RAGDOLL_LAUNCH';
          this.currentTimeScale = 0.42;
          this.phaseTimerS = 0;
          target.setXRayMode(Boolean(this.shouldRestoreXRayVision?.()));
        }
        break;
      }

      case 'RAGDOLL_LAUNCH': {
        // Dramatic low-angle action cam tracking backward flight arc of unified ragdoll
        const camX = targetPos.x - fwd.x * 1.4 - right.x * 1.85;
        const camY = Math.max(0.4, targetPos.y + 0.55);
        const camZ = targetPos.z - fwd.z * 1.4 - right.z * 1.85;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(new pc.Vec3(targetPos.x, targetPos.y + 0.85, targetPos.z));

        if (this.phaseTimerS >= 1.5) {
          this.completeKillCam();
        }
        break;
      }
    }
  }

  /**
   * Skips or immediately cancels the active Kill Cam sequence.
   */
  public skipKillCam(): void {
    if (!this.isActive()) return;

    // Guarantee simulation report & gore FX are applied if skipped before impact phase
    if (!this.shotApplied && this.currentReport && this.currentTarget) {
      const isBuckshot =
        this.currentReport.pelletCount > 1 || this.currentReport.ammoId.includes('BUCK');
      this.applyImpactEffects(this.currentReport, this.currentTarget, isBuckshot);
    }

    this.completeKillCam();
  }

  private completeKillCam(): void {
    this.activePhase = 'IDLE';
    this.currentTimeScale = 1.0;
    this.phaseTimerS = 0;
    this.simTimerS = 0;

    if (this.currentTarget) {
      this.currentTarget.setXRayMode(Boolean(this.shouldRestoreXRayVision?.()));
    }

    // Hide Cinema letterbox and restore HUD reticle / scope layer
    this.overlayEl?.classList.add('hidden');
    this.reticleLayerEl?.classList.remove('hidden');

    // Restore player FPS camera position
    this.cameraEntity.setPosition(
      this.defaultCamPos.x,
      this.defaultCamPos.y,
      this.defaultCamPos.z
    );
    this.cameraEntity.setEulerAngles(
      this.defaultCamRot.x,
      this.defaultCamRot.y,
      this.defaultCamRot.z
    );

    this.currentReport = null;
    this.currentTarget = null;

    if (this.onSequenceCompleteCallback) {
      this.onSequenceCompleteCallback();
    }
  }
}
