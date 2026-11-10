import * as pc from 'playcanvas';
import { ShotSimulationReport } from '../contracts/ballistics.ts';
import { applyShotReportToTarget } from '../core/ballistics/solver.ts';
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
  onSequenceComplete?: () => void;
}

/**
 * Class XRayKillCamDirector implements:
 * 1. Sniper Elite X-Ray Kill Cam:
 *    - Phase 1: Slow-motion bullet tracking (timeScale 0.035) following spinning projectile downrange.
 *    - Phase 2: Close-up X-Ray Penetration (timeScale 0.018), translucent anatomy silhouette, bone shatter & organ rupture.
 *    - Phase 3: Slow-motion Ragdoll Aftermath (timeScale 0.28) watching the enemy collapse with spraying arterial fountains.
 * 2. Shotgun Ragdoll Action Cam:
 *    - Pre-calculated muzzle lethality, buckshot swarm tracking (timeScale 0.08), and high-impact Ragdoll Launch Action Cam (timeScale 0.45).
 */
export class XRayKillCamDirector {
  public readonly app: pc.AppBase;
  public readonly cameraEntity: pc.Entity;
  public readonly fxManager: GoreAndBallisticsFxManager;

  private activePhase: KillCamPhase = 'IDLE';
  private phaseTimerS = 0;
  private currentReport: ShotSimulationReport | null = null;
  private currentTarget: GhoulMannequinEntity | null = null;

  // Stored player camera transform to restore after Kill Cam
  private defaultCamPos = new pc.Vec3(0, 1.65, 0);
  private defaultCamRot = new pc.Vec3(0, 0, 0);

  // Time scale applied to game loop during Kill Cam
  private currentTimeScale = 1.0;

  // UI elements
  private overlayEl: HTMLElement | null = null;
  private telemetryEl: HTMLElement | null = null;
  private woundTickerEl: HTMLElement | null = null;
  private onSequenceCompleteCallback?: () => void;

  constructor(options: KillCamDirectorOptions) {
    this.app = options.app;
    this.cameraEntity = options.cameraEntity;
    this.fxManager = options.fxManager;
    this.onSequenceCompleteCallback = options.onSequenceComplete;

    this.overlayEl = document.getElementById('xray-cinema-overlay');
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

  /**
   * Starts a dynamic Kill Cam sequence based on the simulation report.
   */
  public startSequence(
    report: ShotSimulationReport,
    targetEntity: GhoulMannequinEntity
  ): boolean {
    if (this.isActive()) return false;
    if (!report.hitTarget) return false;

    this.currentReport = report;
    this.currentTarget = targetEntity;

    // Cache original player camera transform
    const pos = this.cameraEntity.getPosition();
    const rot = this.cameraEntity.getEulerAngles();
    this.defaultCamPos.set(pos.x, pos.y, pos.z);
    this.defaultCamRot.set(rot.x, rot.y, rot.z);

    // Show Cinema Letterbox Overlay
    if (this.overlayEl) {
      this.overlayEl.classList.remove('hidden');
    }

    if (report.ammoId.includes('BUCKSHOT')) {
      // 12-Gauge Shotgun Ragdoll Launch Action Cam
      this.activePhase = 'BUCKSHOT_TRACKING';
      this.currentTimeScale = 0.08;
      this.phaseTimerS = 0;

      if (this.telemetryEl) {
        this.telemetryEl.textContent = `12G BUCKSHOT // PRE-CALCULATED IMPULSE: ${report.ragdollPlan.netRootImpulseWorld.z.toFixed(0)} N*s | LIFT: +${report.ragdollPlan.launchLiftVelocityMs.toFixed(1)} m/s`;
      }
      if (this.woundTickerEl) {
        this.woundTickerEl.textContent = `PRE-IMPACT TRAUMA LOCKED // 10-PELLET CONE ARRIVAL IN ${report.flightTimeAtImpactS.toFixed(3)}s`;
      }
      return true;
    } else if (report.triggerXRayKillCam || report.isLethalKill) {
      // Sniper Elite X-Ray Kill Cam
      this.activePhase = 'BULLET_TRACKING';
      this.currentTimeScale = 0.035;
      this.phaseTimerS = 0;

      if (this.telemetryEl) {
        this.telemetryEl.textContent = `VEL: ${report.impactSpeedMs.toFixed(0)} m/s | E_k: ${report.impactEnergyJ.toFixed(0)} J | TARGET: ${report.xRayFocusZone || 'VITAL'}`;
      }
      if (this.woundTickerEl) {
        this.woundTickerEl.textContent = `CRITICAL ANATOMICAL PENETRATION CONFIRMED // TIME DILATION ACTIVE`;
      }
      return true;
    }

    return false;
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

    switch (this.activePhase) {
      // -----------------------------------------------------------------------
      // SNIPER ELITE X-RAY KILL CAM PHASES
      // -----------------------------------------------------------------------
      case 'BULLET_TRACKING': {
        this.currentTimeScale = 0.035;

        // Position camera behind and to the side of the bullet path
        const flightTime = report.flightTimeAtImpactS;
        const normTime = Math.min(1.0, this.phaseTimerS / Math.max(0.6, flightTime * 1.5));

        const aimDir = report.aimDirectionWorld;
        const origin = report.originWorld;

        // Interpolate along trajectory
        const curDist = report.targetDistanceM * (0.1 + 0.85 * normTime);
        const bulletX = origin.x + aimDir.x * curDist;
        const bulletY = origin.y + aimDir.y * curDist - (report.bulletDropAtImpactCm / 100) * (normTime * normTime);
        const bulletZ = origin.z + aimDir.z * curDist;

        // Camera trails slightly behind and to the right
        const camX = bulletX + 0.35;
        const camY = bulletY + 0.15;
        const camZ = bulletZ + 0.65;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(new pc.Vec3(bulletX, bulletY, bulletZ - 0.5));

        if (this.phaseTimerS >= 0.75 || normTime >= 0.95) {
          // Transition to Phase 2: X-Ray Penetration
          this.activePhase = 'XRAY_PENETRATION';
          this.currentTimeScale = 0.018;
          this.phaseTimerS = 0;

          // Turn on translucent anatomical X-Ray mode
          target.setXRayMode(true, report.xRayFocusZone);

          // Apply shot report immediately at impact!
          applyShotReportToTarget(target.healthState, report);

          // Spawn entry blood bursts and bone shatter sparks
          for (const wound of report.woundEvents) {
            this.fxManager.spawnBloodBurst(
              wound.entryPointWorld,
              wound.impactDirectionWorld,
              wound.energyDepositedJ,
              16
            );
            if (wound.boneShattered || wound.boneFractured) {
              this.fxManager.spawnBoneShatterSparks(
                wound.entryPointWorld,
                wound.impactDirectionWorld
              );
            }
          }

          // Trigger dismemberment gibs
          for (const dism of report.dismembermentEvents) {
            this.fxManager.spawnDismembermentGibs(dism);
            this.fxManager.attachArterialFountain(target.healthState, dism);
          }

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

        // Camera frames target anatomy at close range (1.3m offset)
        const focusY = report.xRayHighlightPointWorld
          ? report.xRayHighlightPointWorld.y
          : targetPos.y + 1.4;

        const camX = targetPos.x + 0.45;
        const camY = focusY + 0.1;
        const camZ = targetPos.z + 1.25;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(new pc.Vec3(targetPos.x, focusY, targetPos.z));

        if (this.phaseTimerS >= 0.9) {
          // Transition to Phase 3: Ragdoll Aftermath
          this.activePhase = 'RAGDOLL_AFTERMATH';
          this.currentTimeScale = 0.28;
          this.phaseTimerS = 0;
          target.setXRayMode(false);

          if (this.woundTickerEl) {
            this.woundTickerEl.textContent = `NEURO-KINETIC COLLAPSE // RAGDOLL PHYSICS ACTIVE`;
          }
        }
        break;
      }

      case 'RAGDOLL_AFTERMATH': {
        this.currentTimeScale = 0.28;

        // Smoothly orbit camera back as ragdoll hits ground
        const t = Math.min(1.0, this.phaseTimerS / 1.6);
        const camX = targetPos.x + Math.sin(t * 1.5) * 2.2;
        const camY = targetPos.y + 1.2 + t * 0.3;
        const camZ = targetPos.z + 2.2;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(new pc.Vec3(targetPos.x, targetPos.y + 0.8, targetPos.z));

        if (this.phaseTimerS >= 1.6) {
          this.completeKillCam();
        }
        break;
      }

      // -----------------------------------------------------------------------
      // 12-GAUGE SHOTGUN ACTION CAM PHASES
      // -----------------------------------------------------------------------
      case 'BUCKSHOT_TRACKING': {
        this.currentTimeScale = 0.08;

        // Briefly track swarm from low angle
        const camX = targetPos.x - 0.7;
        const camY = targetPos.y + 0.6;
        const camZ = targetPos.z + 2.4;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(new pc.Vec3(targetPos.x, targetPos.y + 1.1, targetPos.z));

        if (this.phaseTimerS >= 0.35) {
          this.activePhase = 'IMPACT_FLASH';
          this.currentTimeScale = 0.04;
          this.phaseTimerS = 0;

          // Flash X-Ray silhouette for instant bone/tissue rupture
          target.setXRayMode(true);
          applyShotReportToTarget(target.healthState, report);

          // Massive blood burst & gibs
          this.fxManager.spawnBloodBurst(
            targetPos,
            report.aimDirectionWorld,
            report.totalEnergyDepositedJ,
            42
          );

          for (const dism of report.dismembermentEvents) {
            this.fxManager.spawnDismembermentGibs(dism);
            this.fxManager.attachArterialFountain(target.healthState, dism);
          }

          if (this.woundTickerEl) {
            this.woundTickerEl.textContent = `SHOTGUN OBLITERATION // LAUNCH VELOCITY: ${report.ragdollPlan.launchLiftVelocityMs.toFixed(1)} m/s`;
          }
        }
        break;
      }

      case 'IMPACT_FLASH': {
        if (this.phaseTimerS >= 0.18) {
          this.activePhase = 'RAGDOLL_LAUNCH';
          this.currentTimeScale = 0.42;
          this.phaseTimerS = 0;
          target.setXRayMode(false);
        }
        break;
      }

      case 'RAGDOLL_LAUNCH': {
        // Dramatic low-angle action cam tracking backward flight arc
        const launchDistEst = report.ragdollPlan.estimatedLaunchDistanceM;
        const camX = targetPos.x - 1.8;
        const camY = Math.max(0.4, targetPos.y + 0.5);
        const camZ = targetPos.z + 1.2;

        this.cameraEntity.setPosition(camX, camY, camZ);
        this.cameraEntity.lookAt(new pc.Vec3(targetPos.x, targetPos.y + 0.6, targetPos.z));

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

    // Guarantee simulation report is applied if skipped early
    if (this.currentReport && this.currentTarget) {
      if (!this.currentTarget.healthState.isRagdollActive && this.currentReport.ragdollPlan.willEnableRagdoll) {
        applyShotReportToTarget(this.currentTarget.healthState, this.currentReport);
      }
    }

    this.completeKillCam();
  }

  private completeKillCam(): void {
    this.activePhase = 'IDLE';
    this.currentTimeScale = 1.0;
    this.phaseTimerS = 0;

    if (this.currentTarget) {
      this.currentTarget.setXRayMode(false);
    }

    // Hide Cinema letterbox
    if (this.overlayEl) {
      this.overlayEl.classList.add('hidden');
    }

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
