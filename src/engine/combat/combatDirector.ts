import * as pc from 'playcanvas';
import {
  WeaponSpec,
  AmmoSpec,
  EnvironmentState,
  EnemyArchetypeId,
  ShotSimulationReport,
  TrajectorySample,
  Vec3Like,
  WoundChannelEvent,
  DismembermentEvent,
  GhoulZoneId,
  TargetHealthState,
} from '../../contracts/ballistics.ts';
import {
  vec3,
  copyVec3,
  add,
  sub,
  scale,
  length,
  normalize,
  distance,
  deterministicConeSpread,
} from '../../core/ballistics/vec3.ts';
import { DEFAULT_ENVIRONMENT } from '../../core/ballistics/weapons.ts';
import {
  ALL_GHOUL_ZONES,
  GHOUL_ZONE_HIERARCHY,
  createTargetHealthState,
  getSubtreeZones,
} from '../../core/ghoul/anatomy.ts';
import {
  simulateShot,
  applyShotReportToTarget,
  stepRagdollPhysics,
} from '../../core/ballistics/solver.ts';
import { EngineMaterialPalette } from '../materials.ts';
import { GhoulMannequinEntity } from '../mannequin.ts';
import { GoreAndBallisticsFxManager } from '../goreFx.ts';
import { HudController, ProjectedTargetTriageEntry } from '../hudController.ts';

export interface RangeTargetConfig {
  id: string;
  name: string;
  archetype: EnemyArchetypeId;
  position: { x: number; y: number; z: number };
  yawDeg: number;
}

export const TARGET_CONFIGS: RangeTargetConfig[] = [
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

export interface EnvironmentRayInterceptResult {
  remainingEnergyJ: number;
  remainingSpeedMs: number;
  blocked: boolean;
}

export type EnvironmentRayInterceptor = (
  origin: Vec3Like,
  dir: Vec3Like,
  maxDistM: number,
  energyJ: number,
  speedMs: number,
  caliberDiameterM: number,
  isAp: boolean
) => EnvironmentRayInterceptResult;

export type ExplosionBlastHandler = (
  center: Vec3Like,
  radiusM: number,
  peakImpulseNs: number,
  peakEnergyJ: number
) => void;

export type CameraShakeCallback = (intensityDeg: number, durationS: number) => void;

interface ActiveFragGrenade {
  entity: pc.Entity;
  fusePinLed: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  angularVelocity: pc.Vec3;
  fuseRemainingS: number;
  blinkTimerS: number;
}

interface ActiveBlastFlashFx {
  root: pc.Entity;
  fireball: pc.Entity;
  shockRing: pc.Entity;
  elapsedS: number;
  durationS: number;
  maxRadiusM: number;
}

export class CombatDirector {
  public static readonly TARGET_CONFIGS: readonly RangeTargetConfig[] = TARGET_CONFIGS;
  public readonly TARGET_CONFIGS: readonly RangeTargetConfig[] = TARGET_CONFIGS;

  public targets: GhoulMannequinEntity[] = [];
  public lastEngagedTarget: GhoulMannequinEntity | null = null;
  public environment: EnvironmentState = { ...DEFAULT_ENVIRONMENT };
  public enableXRayInspector = false;

  /**
   * Optional Wave 2 destructible cover ray interceptor (wood/glass/brick/concrete walls).
   */
  public environmentRayInterceptor?: EnvironmentRayInterceptor;

  /**
   * Optional Wave 2 radial explosion blast callback for destructible cover subsystems.
   */
  public onExplosionBlast?: ExplosionBlastHandler;

  /**
   * Optional first-person camera blast shake callback.
   */
  public onCameraShake?: CameraShakeCallback;

  private readonly app: pc.AppBase;
  private readonly materials: EngineMaterialPalette;
  private readonly fxManager: GoreAndBallisticsFxManager;
  private readonly hudController: HudController;

  private readonly activeGrenades: ActiveFragGrenade[] = [];
  private readonly activeBlastFlashes: ActiveBlastFlashFx[] = [];
  private grenadeCooldownS = 0;

  private readonly blastFireballMat: pc.StandardMaterial;
  private readonly scratchWorldPt = new pc.Vec3();
  private readonly scratchScreenPt = new pc.Vec3();
  private readonly scratchBodyScreenPt = new pc.Vec3();
  private readonly lastViewerWorldPos = new pc.Vec3(0, 1.62, 0);

  constructor(
    app: pc.AppBase,
    materials: EngineMaterialPalette,
    fxManager: GoreAndBallisticsFxManager,
    hudController: HudController,
    onCameraShake?: CameraShakeCallback
  ) {
    this.app = app;
    this.materials = materials;
    this.fxManager = fxManager;
    this.hudController = hudController;
    this.onCameraShake = onCameraShake;

    this.blastFireballMat = new pc.StandardMaterial();
    this.blastFireballMat.name = 'fragBlastFireballMat';
    this.blastFireballMat.diffuse = new pc.Color(1.0, 0.52, 0.12);
    this.blastFireballMat.emissive = new pc.Color(1.0, 0.45, 0.08);
    this.blastFireballMat.opacity = 0.72;
    this.blastFireballMat.blendType = pc.BLEND_NORMAL;
    this.blastFireballMat.depthWrite = false;
    this.blastFireballMat.cull = pc.CULLFACE_NONE;
    this.blastFireballMat.update();
  }

  public spawnAllTargets(): void {
    const oldTargets = this.targets;
    const nextTargets: GhoulMannequinEntity[] = [];

    this.clearLiveGrenadesAndFlashes();
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
    this.lastEngagedTarget = null;
  }

  public setXRayMode(enabled: boolean): void {
    this.enableXRayInspector = enabled;
    for (const t of this.targets) {
      t.setXRayMode(enabled);
    }
  }

  public areAllTargetsDown(): boolean {
    return this.targets.length > 0 && this.targets.every((t) => !t.healthState.alive);
  }

  private findBestTargetHit(
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    origin: Vec3Like,
    aimDir: Vec3Like,
    excludeTargets?: Set<GhoulMannequinEntity>
  ): { target: GhoulMannequinEntity; report: ShotSimulationReport } | null {
    if (this.targets.length === 0) return null;

    let bestHit: { target: GhoulMannequinEntity; report: ShotSimulationReport } | null = null;
    let bestImpactTime = Infinity;

    for (let i = 0; i < this.targets.length; i++) {
      const candidate = this.targets[i];
      if (excludeTargets?.has(candidate)) continue;

      const candReport = simulateShot(
        weapon,
        ammo,
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
      weapon,
      ammo,
      origin,
      aimDir,
      fallback.healthState,
      this.environment
    );
    return { target: fallback, report: fbReport };
  }

  private truncateTrajectorySamples(
    samples: TrajectorySample[],
    origin: Vec3Like,
    maxDistM: number
  ): TrajectorySample[] {
    if (samples.length <= 2) return samples;
    const out: TrajectorySample[] = [];
    for (const s of samples) {
      out.push(s);
      if (distance(origin, s.position) >= maxDistM) {
        break;
      }
    }
    return out.length >= 2 ? out : samples.slice(0, 2);
  }

  private buildSyntheticFlightSamples(
    origin: Vec3Like,
    normDir: Vec3Like,
    speedMs: number,
    massKg: number,
    distM: number
  ): TrajectorySample[] {
    const safeSpeed = Math.max(60, speedMs);
    const flightS = distM / safeSpeed;
    const midPos = add(origin, scale(normDir, distM * 0.5));
    const endPos = add(origin, scale(normDir, distM));
    const ke = 0.5 * massKg * safeSpeed * safeSpeed;
    const mach = safeSpeed / this.environment.speedOfSoundMs;
    const vel = scale(normDir, safeSpeed);
    return [
      {
        timeS: 0,
        position: copyVec3(origin),
        velocity: copyVec3(vel),
        speedMs: safeSpeed,
        mach,
        kineticEnergyJ: ke,
        dropM: 0,
        windDriftM: 0,
      },
      {
        timeS: flightS * 0.5,
        position: midPos,
        velocity: copyVec3(vel),
        speedMs: safeSpeed,
        mach,
        kineticEnergyJ: ke,
        dropM: 0,
        windDriftM: 0,
      },
      {
        timeS: flightS,
        position: endPos,
        velocity: copyVec3(vel),
        speedMs: safeSpeed,
        mach,
        kineticEnergyJ: ke,
        dropM: 0,
        windDriftM: 0,
      },
    ];
  }

  private applyImpactFxAndState(
    target: GhoulMannequinEntity,
    report: ShotSimulationReport,
    weaponLabel: string
  ): void {
    this.lastEngagedTarget = target;
    const wasAlive = target.healthState.alive;
    applyShotReportToTarget(target.healthState, report);
    const isLethalNow = !target.healthState.alive;
    const armorOnly =
      report.woundEvents.length > 0 && report.woundEvents.every((w) => w.armorStopped);

    this.hudController.triggerHitmarker(
      isLethalNow ? 'LETHAL' : armorOnly ? 'ARMOR' : 'NORMAL'
    );
    this.hudController.pushCombatFeed(
      report,
      weaponLabel,
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

  public fireWeapon(
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    origin: Vec3Like,
    aimDir: Vec3Like
  ): void {
    const normAim = normalize(aimDir);
    const muzzleSpeedMs = ammo.muzzleVelocityMs;
    const muzzleEnergyJ = 0.5 * ammo.massKg * muzzleSpeedMs * muzzleSpeedMs;
    const isAp = ammo.type === 'AP' || ammo.armorPenetrationFactor >= 1.35;

    if (ammo.pelletCount > 1) {
      this.fireMultiPelletShot(weapon, ammo, origin, normAim, muzzleEnergyJ, muzzleSpeedMs, isAp);
      return;
    }

    const match = this.findBestTargetHit(weapon, ammo, origin, normAim);

    if (!match || !match.report.hitTarget) {
      // No GHOUL target hit: trace full downrange ray against destructible cover stations
      if (this.environmentRayInterceptor) {
        this.environmentRayInterceptor(
          origin,
          normAim,
          150.0,
          muzzleEnergyJ,
          muzzleSpeedMs,
          ammo.diameterM,
          isAp
        );
      }
      const samples =
        match && match.report.trajectorySamples.length > 1
          ? match.report.trajectorySamples
          : this.buildSyntheticFlightSamples(origin, normAim, muzzleSpeedMs, ammo.massKg, 85.0);
      this.fxManager.spawnFlyingProjectile(samples, false);
      return;
    }

    let { target, report } = match;
    const hitDistM =
      report.woundEvents.length > 0
        ? distance(origin, report.woundEvents[0].entryPointWorld)
        : report.targetDistanceM;

    if (this.environmentRayInterceptor) {
      const preIntercept = this.environmentRayInterceptor(
        origin,
        normAim,
        hitDistM,
        muzzleEnergyJ,
        muzzleSpeedMs,
        ammo.diameterM,
        isAp
      );

      if (
        preIntercept.blocked ||
        preIntercept.remainingSpeedMs <= 25 ||
        preIntercept.remainingEnergyJ <= 10
      ) {
        const stoppedSamples = this.truncateTrajectorySamples(
          report.trajectorySamples,
          origin,
          hitDistM
        );
        this.fxManager.spawnFlyingProjectile(stoppedSamples, false);
        return;
      }

      if (preIntercept.remainingSpeedMs < muzzleSpeedMs * 0.98) {
        const attenuatedAmmo: AmmoSpec = {
          ...ammo,
          muzzleVelocityMs: preIntercept.remainingSpeedMs,
        };
        const attenuatedReport = simulateShot(
          weapon,
          attenuatedAmmo,
          origin,
          normAim,
          target.healthState,
          this.environment
        );
        if (!attenuatedReport.hitTarget) {
          if (attenuatedReport.trajectorySamples.length > 1) {
            this.fxManager.spawnFlyingProjectile(attenuatedReport.trajectorySamples, false);
          }
          return;
        }
        report = attenuatedReport;
      }
    }

    if (report.trajectorySamples.length > 1) {
      this.fxManager.spawnFlyingProjectile(report.trajectorySamples, false);
    }

    this.applyImpactFxAndState(target, report, weapon.codeName);

    // Over-penetration collateral pass: high-penetration AP/FMJ rounds exiting a body
    // continue downrange into destructible walls and lined-up combatants!
    if (report.woundEvents.length > 0) {
      const lastWound = report.woundEvents[report.woundEvents.length - 1];
      if (
        !lastWound.armorStopped &&
        lastWound.exitEnergyJ > 160 &&
        lastWound.exitVelocityMs > 90
      ) {
        const excluded = new Set<GhoulMannequinEntity>([target]);
        const exitDir = normalize(lastWound.impactDirectionWorld);
        const exitOrigin = add(lastWound.exitPointWorld, scale(exitDir, 0.06));
        let residualSpeedMs = lastWound.exitVelocityMs;
        let residualEnergyJ = lastWound.exitEnergyJ;

        const baseResidualAmmo: AmmoSpec = {
          ...ammo,
          muzzleVelocityMs: residualSpeedMs,
          spreadRadians: 0,
        };
        const collateral = this.findBestTargetHit(
          weapon,
          baseResidualAmmo,
          exitOrigin,
          exitDir,
          excluded
        );

        if (collateral && collateral.report.hitTarget) {
          const collatDistM =
            collateral.report.woundEvents.length > 0
              ? distance(exitOrigin, collateral.report.woundEvents[0].entryPointWorld)
              : collateral.report.targetDistanceM;

          let collatReport = collateral.report;
          let collatBlocked = false;

          if (this.environmentRayInterceptor) {
            const betweenIntercept = this.environmentRayInterceptor(
              exitOrigin,
              exitDir,
              collatDistM,
              residualEnergyJ,
              residualSpeedMs,
              ammo.diameterM,
              isAp
            );
            if (
              betweenIntercept.blocked ||
              betweenIntercept.remainingSpeedMs <= 25 ||
              betweenIntercept.remainingEnergyJ <= 10
            ) {
              collatBlocked = true;
            } else if (betweenIntercept.remainingSpeedMs < residualSpeedMs * 0.98) {
              residualSpeedMs = betweenIntercept.remainingSpeedMs;
              residualEnergyJ = betweenIntercept.remainingEnergyJ;
              collatReport = simulateShot(
                weapon,
                { ...baseResidualAmmo, muzzleVelocityMs: residualSpeedMs },
                exitOrigin,
                exitDir,
                collateral.target.healthState,
                this.environment
              );
              if (!collatReport.hitTarget) {
                collatBlocked = true;
              }
            }
          }

          if (!collatBlocked) {
            this.applyImpactFxAndState(collateral.target, collatReport, weapon.codeName);
          }
        } else if (this.environmentRayInterceptor) {
          this.environmentRayInterceptor(
            exitOrigin,
            exitDir,
            120.0,
            residualEnergyJ,
            residualSpeedMs,
            ammo.diameterM,
            isAp
          );
        }
      }
    }
  }

  private fireMultiPelletShot(
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    origin: Vec3Like,
    normAim: Vec3Like,
    perPelletEnergyJ: number,
    muzzleSpeedMs: number,
    isAp: boolean
  ): void {
    const pelletCount = Math.max(1, ammo.pelletCount);

    if (this.targets.length === 0) {
      for (let pIdx = 0; pIdx < pelletCount; pIdx++) {
        const pelletDir = deterministicConeSpread(normAim, ammo.spreadRadians, pIdx, pelletCount);
        this.environmentRayInterceptor?.(
          origin,
          pelletDir,
          80.0,
          perPelletEnergyJ,
          muzzleSpeedMs,
          ammo.diameterM,
          isAp
        );
        const samples = this.buildSyntheticFlightSamples(
          origin,
          pelletDir,
          muzzleSpeedMs,
          ammo.massKg,
          45.0
        );
        this.fxManager.spawnFlyingProjectile(samples, true);
      }
      return;
    }

    const candidateReports = this.targets.map((cand) => ({
      target: cand,
      report: simulateShot(weapon, ammo, origin, normAim, cand.healthState, this.environment),
    }));

    const basePelletCount = candidateReports[0].report.pelletResults.length;
    const blockedPellets = new Set<number>();
    let speedRatioSum = 0;
    let unblockedCount = 0;

    for (let pIdx = 0; pIdx < basePelletCount; pIdx++) {
      let chosenSamples = candidateReports[0].report.pelletResults[pIdx].trajectorySamples;
      let earliestHitS = Infinity;
      let earliestHitDistM = 80.0;

      for (const cr of candidateReports) {
        const pr = cr.report.pelletResults[pIdx];
        if (pr && pr.hitTarget && pr.trajectorySamples.length > 0) {
          const hitTime = pr.trajectorySamples[pr.trajectorySamples.length - 1].timeS;
          if (hitTime < earliestHitS) {
            earliestHitS = hitTime;
            chosenSamples = pr.trajectorySamples;
            if (pr.impactPointWorld) {
              earliestHitDistM = distance(origin, pr.impactPointWorld);
            }
          }
        }
      }

      if (this.environmentRayInterceptor) {
        const pelletDir = deterministicConeSpread(
          normAim,
          ammo.spreadRadians,
          pIdx,
          basePelletCount
        );
        const intercept = this.environmentRayInterceptor(
          origin,
          pelletDir,
          earliestHitDistM,
          perPelletEnergyJ,
          muzzleSpeedMs,
          ammo.diameterM,
          isAp
        );
        if (
          intercept.blocked ||
          intercept.remainingSpeedMs <= 25 ||
          intercept.remainingEnergyJ <= 8
        ) {
          blockedPellets.add(pIdx);
        } else {
          speedRatioSum += intercept.remainingSpeedMs / Math.max(1, muzzleSpeedMs);
          unblockedCount++;
        }
      }

      this.fxManager.spawnFlyingProjectile(chosenSamples, true);
    }

    for (const cr of candidateReports) {
      if (!cr.report.hitTarget) continue;

      if (this.environmentRayInterceptor) {
        const anyPelletReachedTarget = cr.report.pelletResults.some(
          (pr, idx) => pr.hitTarget && !blockedPellets.has(idx)
        );
        if (!anyPelletReachedTarget) {
          continue;
        }
        const avgRatio = unblockedCount > 0 ? speedRatioSum / unblockedCount : 1.0;
        if (avgRatio < 0.96) {
          const attenAmmo: AmmoSpec = {
            ...ammo,
            muzzleVelocityMs: muzzleSpeedMs * avgRatio,
          };
          const attenReport = simulateShot(
            weapon,
            attenAmmo,
            origin,
            normAim,
            cr.target.healthState,
            this.environment
          );
          if (attenReport.hitTarget) {
            this.applyImpactFxAndState(cr.target, attenReport, weapon.codeName);
          }
          continue;
        }
      }

      this.applyImpactFxAndState(cr.target, cr.report, weapon.codeName);
    }
  }

  public throwFragGrenade(origin: Vec3Like, aimDir: Vec3Like): void {
    if (this.grenadeCooldownS > 0) return;
    this.grenadeCooldownS = 0.32;

    const normAim = normalize(aimDir);
    const spawnPos = add(add(origin, scale(normAim, 0.48)), vec3(0, -0.08, 0));
    const throwVel = add(scale(normAim, 14.8), vec3(0, 2.65, 0));

    const grenadeRoot = new pc.Entity('LiveFragGrenade');
    grenadeRoot.setPosition(spawnPos.x, spawnPos.y, spawnPos.z);

    const body = new pc.Entity('GrenadeBody');
    body.addComponent('render', {
      type: 'sphere',
      material: this.materials.tacticalOlive,
      castShadows: true,
    });
    body.setLocalScale(0.095, 0.115, 0.095);
    grenadeRoot.addChild(body);

    const neck = new pc.Entity('GrenadeSpoonNeck');
    neck.addComponent('render', {
      type: 'box',
      material: this.materials.bootsDark,
    });
    neck.setLocalScale(0.032, 0.048, 0.044);
    neck.setLocalPosition(0, 0.062, 0);
    grenadeRoot.addChild(neck);

    const fusePinLed = new pc.Entity('GrenadeFuseLed');
    fusePinLed.addComponent('render', {
      type: 'sphere',
      material: this.materials.arteryMat,
    });
    fusePinLed.setLocalScale(0.028, 0.028, 0.028);
    fusePinLed.setLocalPosition(0, 0.09, 0);
    grenadeRoot.addChild(fusePinLed);

    this.fxManager.fxRoot.addChild(grenadeRoot);

    this.activeGrenades.push({
      entity: grenadeRoot,
      fusePinLed,
      position: new pc.Vec3(spawnPos.x, spawnPos.y, spawnPos.z),
      velocity: new pc.Vec3(throwVel.x, throwVel.y, throwVel.z),
      angularVelocity: new pc.Vec3(8.5, 5.2, -6.4),
      fuseRemainingS: 1.6,
      blinkTimerS: 0,
    });

    this.hudController.pushSystemToast('M67 FRAG', 'LIVE GRENADE OUT (1.6S)');
  }

  private detonateFragGrenade(center: Vec3Like): void {
    const blastRadiusM = 7.5;
    const peakImpulseNs = 940.0;
    const peakEnergyJ = 4400.0;

    // 1. Visual Fireball, Shockwave Ring & Shrapnel Sparks
    this.spawnBlastVisualFx(center, blastRadiusM);
    this.fxManager.spawnArmorImpactSparks(add(center, vec3(0, 0.12, 0)), vec3(0, 1, 0));
    this.fxManager.spawnBoneShatterSparks(add(center, vec3(0, 0.18, 0)), vec3(0, 1, 0));

    // 2. Camera Shake Attenuated by Viewer Distance
    if (this.onCameraShake) {
      const viewerDist = distance(
        center,
        vec3(this.lastViewerWorldPos.x, this.lastViewerWorldPos.y, this.lastViewerWorldPos.z)
      );
      if (viewerDist < 34.0) {
        const proximity = Math.max(0.12, 1 - viewerDist / 34.0);
        this.onCameraShake(4.2 * proximity * proximity + 0.55, 0.44);
      }
    }

    // 3. Wave 2 Destructible Cover Blast Hook (Brick / Concrete / Glass / Wood)
    this.onExplosionBlast?.(center, blastRadiusM, peakImpulseNs, peakEnergyJ);

    // 4. GHOUL Anatomical Shrapnel Trauma, Dismemberment & 3D Ragdoll Launch
    for (const target of this.targets) {
      const hs = target.healthState;
      const pelvisPos = hs.ragdollBones.PELVIS_GROIN.position;
      const distM = distance(center, pelvisPos);
      if (distM > blastRadiusM) continue;

      const blastReport = this.buildFragBlastReportForTarget(
        hs,
        center,
        distM,
        blastRadiusM,
        peakImpulseNs,
        peakEnergyJ
      );
      this.applyImpactFxAndState(target, blastReport, 'M67 FRAG');

      // Add extra upward/radial concussive lift on very close blasts (< 4.0m)
      if (distM < 4.0 && hs.isRagdollActive) {
        const closeLift = (1 - distM / 4.0) * 2.35;
        const rawOut = sub(pelvisPos, center);
        const horizOut = vec3(rawOut.x, 0, rawOut.z);
        const outDir = length(horizOut) > 1e-3 ? normalize(horizOut) : vec3(0, 0, -1);
        for (const z of ALL_GHOUL_ZONES) {
          const b = hs.ragdollBones[z];
          if (b.componentId === 'BODY') {
            b.velocity.x += outDir.x * closeLift * 1.15;
            b.velocity.y += closeLift;
            b.velocity.z += outDir.z * closeLift * 1.15;
          }
        }
      }
    }
  }

  private buildFragBlastReportForTarget(
    hs: TargetHealthState,
    blastCenter: Vec3Like,
    distM: number,
    blastRadiusM: number,
    peakImpulseNs: number,
    peakEnergyJ: number
  ): ShotSimulationReport {
    const falloff = Math.pow(Math.max(0.05, 1 - distM / blastRadiusM), 1.3);
    const pelvisPos = hs.ragdollBones.PELVIS_GROIN.position;
    const rawDelta = sub(pelvisPos, blastCenter);
    const horizDelta = vec3(rawDelta.x, 0, rawDelta.z);
    const horizDir = length(horizDelta) > 1e-3 ? normalize(horizDelta) : vec3(0, 0, -1);
    const blastDir = normalize(vec3(horizDir.x, 0.45, horizDir.z));

    const totalDamageHp = 245.0 * falloff;
    const totalEnergyJ = peakEnergyJ * falloff;
    const isCloseLethal = distM < 3.5;
    const isLethalKill = isCloseLethal || totalDamageHp >= hs.currentHp;

    const exposedZones: GhoulZoneId[] = [
      'SHIN_LEFT',
      'SHIN_RIGHT',
      'KNEE_LEFT',
      'KNEE_RIGHT',
      'THIGH_LEFT',
      'THIGH_RIGHT',
      'TORSO_LOWER_ABDOMEN',
      'TORSO_UPPER_THORAX',
    ];
    const woundEvents: WoundChannelEvent[] = [];
    const zoneImpulses: Partial<Record<GhoulZoneId, Vec3Like>> = {};

    const shrapnelZones = exposedZones
      .filter((z) => !hs.severedZones.has(z))
      .sort(
        (a, b) =>
          distance(blastCenter, hs.ragdollBones[a].position) -
          distance(blastCenter, hs.ragdollBones[b].position)
      )
      .slice(0, distM < 3.8 ? 5 : 3);

    for (const z of shrapnelZones) {
      const bonePos = hs.ragdollBones[z].position;
      const segDir = normalize(sub(bonePos, blastCenter));
      const wEnergy = (totalEnergyJ / Math.max(1, shrapnelZones.length)) * 0.45;
      const wImpulse = (peakImpulseNs * falloff) / Math.max(1, shrapnelZones.length);

      zoneImpulses[z] = scale(segDir, wImpulse * 0.55);

      woundEvents.push({
        colliderId: `frag_shrapnel_${z}`,
        label: GHOUL_ZONE_HIERARCHY[z].label,
        ghoulZone: z,
        layerType: 'SOFT_FLESH',
        entryPointWorld: copyVec3(bonePos),
        exitPointWorld: add(bonePos, scale(segDir, 0.08)),
        entryNormalWorld: scale(segDir, -1),
        localEntryOffset: vec3(0, 0, 0.03),
        localExitOffset: vec3(0, 0, -0.03),
        impactDirectionWorld: segDir,
        pathLengthM: 0.08,
        entryVelocityMs: 580 * falloff,
        exitVelocityMs: 0,
        entryEnergyJ: wEnergy,
        exitEnergyJ: 0,
        energyDepositedJ: wEnergy,
        impulseTransferredNs: wImpulse,
        permanentCavityRadiusCm: 2.2 * falloff + 0.6,
        temporaryStretchCavityRadiusCm: 5.5 * falloff,
        armorStopped: false,
        bluntTraumaJ: 0,
        boneFractured: distM < 4.8,
        boneShattered: distM < 3.0,
        organRuptured: distM < 2.8 && z === 'TORSO_LOWER_ABDOMEN',
        limbSensoryShock: true,
        limbSevered: false,
        arterialSevered: distM < 3.4,
        deflectionAngleDeg: 0,
        physiologicalEffect: 'High-explosive fragmentation trauma',
      });
    }

    const dismembermentEvents: DismembermentEvent[] = [];
    const newlySeveredZones: GhoulZoneId[] = [];

    if (distM < 3.3) {
      // Closest intact lower limb gets blown clean off by ground-level frag blast!
      const candidateLimbs: GhoulZoneId[] =
        distM < 2.0
          ? ['KNEE_LEFT', 'SHIN_RIGHT', 'FOREARM_LEFT']
          : ['SHIN_LEFT', 'SHIN_RIGHT'];
      const maxSevers = distM < 2.0 ? 2 : 1;

      for (const limbZone of candidateLimbs) {
        if (dismembermentEvents.length >= maxSevers) break;
        if (hs.severedZones.has(limbZone)) continue;

        const bone = hs.ragdollBones[limbZone];
        const subtree = getSubtreeZones(limbZone);
        for (const sz of subtree) newlySeveredZones.push(sz);

        const limbOut = normalize(add(sub(bone.position, blastCenter), vec3(0, 0.65, 0)));
        dismembermentEvents.push({
          zone: limbZone,
          parentZone: GHOUL_ZONE_HIERARCHY[limbZone].parent,
          goreMode: 'CLEAN_SEVER',
          detachedSubtree: subtree,
          stumpWorldPosition: copyVec3(bone.position),
          arterialSprayDirection: scale(limbOut, -1),
          severedLimbVelocity: scale(limbOut, 5.8 + Math.random() * 2.4),
          severedLimbAngularVelocity: vec3(
            (Math.random() - 0.5) * 18,
            (Math.random() - 0.5) * 18,
            (Math.random() - 0.5) * 18
          ),
          gibCount: 7,
        });
      }

      if (distM < 2.1 && hs.zoneGoreMode.TORSO_LOWER_ABDOMEN !== 'EVISCERATED') {
        const gutPos = hs.ragdollBones.TORSO_LOWER_ABDOMEN.position;
        dismembermentEvents.push({
          zone: 'TORSO_LOWER_ABDOMEN',
          parentZone: 'PELVIS_GROIN',
          goreMode: 'EVISCERATED',
          detachedSubtree: [],
          stumpWorldPosition: copyVec3(gutPos),
          arterialSprayDirection: copyVec3(blastDir),
          severedLimbVelocity: scale(blastDir, 4.2),
          severedLimbAngularVelocity: vec3(6, 4, -5),
          gibCount: 9,
        });
      }
    }

    const willEnableRagdoll = hs.isRagdollActive || isLethalKill || distM < 5.8;
    const netRootImpulseWorld = scale(blastDir, peakImpulseNs * falloff * 0.68);
    const primaryHitZone: GhoulZoneId = shrapnelZones[0] || 'TORSO_LOWER_ABDOMEN';

    return {
      shotId: `frag_${Date.now()}_${hs.targetId}`,
      weaponId: 'm67_frag_grenade',
      ammoId: 'comp_b_shrapnel',
      originWorld: copyVec3(blastCenter),
      aimDirectionWorld: blastDir,
      targetDistanceM: distM,
      pelletCount: shrapnelZones.length,
      muzzleEnergyJ: peakEnergyJ,
      impactSpeedMs: 650 * falloff,
      impactEnergyJ: totalEnergyJ,
      flightTimeAtImpactS: 0,
      bulletDropAtImpactCm: 0,
      windDriftAtImpactCm: 0,
      hitTarget: true,
      targetId: hs.targetId,
      pelletResults: [],
      woundEvents,
      totalEnergyDepositedJ: totalEnergyJ,
      totalDamageHp,
      isLethalKill,
      ragdollPlan: {
        willEnableRagdoll,
        activationTimeS: 0,
        primaryHitZone,
        netRootImpulseWorld,
        launchLiftVelocityMs: Math.min(1.25, 1.35 * falloff),
        estimatedLaunchDistanceM: 3.4 * falloff,
        zoneImpulses,
        netTorqueWorld: vec3(blastDir.z * -45 * falloff, 18 * falloff, blastDir.x * 45 * falloff),
        dismembermentEvents,
      },
      triggerXRayKillCam: false,
      xRayFocusZone: primaryHitZone,
      xRayHighlightPointWorld: copyVec3(pelvisPos),
      severedZones: newlySeveredZones,
      dismembermentEvents,
      shatteredBones: distM < 3.6 ? ['Tibia & Fibula (Blast Fracture)'] : [],
      rupturedOrgans: distM < 2.8 ? ['Pulmonary Blast Overpressure'] : [],
      combatantEffects: ['HE FRAGMENTATION BLAST'],
      headgearKnockedOff: distM < 5.4,
      weaponDisarmed: distM < 6.0,
      trajectorySamples: [],
    };
  }

  private spawnBlastVisualFx(center: Vec3Like, blastRadiusM: number): void {
    const root = new pc.Entity('FragBlastFx');
    root.setPosition(center.x, Math.max(0.08, center.y), center.z);

    const flashLight = new pc.Entity('FragBlastLight');
    flashLight.addComponent('light', {
      type: 'omni',
      color: new pc.Color(1.0, 0.68, 0.25),
      intensity: 4.5,
      range: blastRadiusM * 2.2,
      castShadows: false,
    });
    flashLight.setLocalPosition(0, 0.45, 0);
    root.addChild(flashLight);

    const fireball = new pc.Entity('FragFireballSphere');
    fireball.addComponent('render', {
      type: 'sphere',
      material: this.blastFireballMat,
      castShadows: false,
    });
    fireball.setLocalScale(0.35, 0.35, 0.35);
    root.addChild(fireball);

    const shockRing = new pc.Entity('FragShockwaveRing');
    shockRing.addComponent('render', {
      type: 'cylinder',
      material: this.materials.shockwaveRingMat,
      castShadows: false,
    });
    shockRing.setLocalPosition(0, 0.04, 0);
    shockRing.setLocalScale(0.5, 0.02, 0.5);
    root.addChild(shockRing);

    this.app.root.addChild(root);

    this.activeBlastFlashes.push({
      root,
      fireball,
      shockRing,
      elapsedS: 0,
      durationS: 0.28,
      maxRadiusM: Math.min(4.6, blastRadiusM * 0.62),
    });
  }

  private clearLiveGrenadesAndFlashes(): void {
    for (const g of this.activeGrenades) {
      g.entity.destroy();
    }
    this.activeGrenades.length = 0;

    for (const bf of this.activeBlastFlashes) {
      bf.root.destroy();
    }
    this.activeBlastFlashes.length = 0;
  }

  public updateSniperRangefinder(
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    origin: Vec3Like,
    aimDir: Vec3Like,
    hudController: HudController
  ): void {
    const match = this.findBestTargetHit(weapon, ammo, origin, aimDir);
    if (match) {
      const zoom = weapon.scopeZoomLevels[0] || 4.0;
      hudController.setScopeOverlay(
        true,
        zoom,
        match.report.targetDistanceM,
        match.report.bulletDropAtImpactCm
      );
    }
  }

  public update(
    dt: number,
    totalElapsedTimeS: number,
    camera: pc.CameraComponent | undefined | null,
    hudController: HudController
  ): void {
    if (this.grenadeCooldownS > 0) {
      this.grenadeCooldownS = Math.max(0, this.grenadeCooldownS - dt);
    }

    if (camera?.entity) {
      this.lastViewerWorldPos.copy(camera.entity.getPosition());
    }

    // 1. Step Live Thrown Frag Grenades (1.6s Fuse + Floor Bounce at y = 0.05)
    for (let i = this.activeGrenades.length - 1; i >= 0; i--) {
      const g = this.activeGrenades[i];
      g.fuseRemainingS -= dt;
      g.blinkTimerS += dt;

      g.velocity.y += this.environment.gravity.y * dt;
      g.velocity.scale(Math.max(0.96, 1 - dt * 0.35));

      g.position.x += g.velocity.x * dt;
      g.position.y += g.velocity.y * dt;
      g.position.z += g.velocity.z * dt;

      if (g.position.x < -9.0) {
        g.position.x = -9.0;
        g.velocity.x = Math.abs(g.velocity.x) * 0.45;
      } else if (g.position.x > 9.0) {
        g.position.x = 9.0;
        g.velocity.x = -Math.abs(g.velocity.x) * 0.45;
      }

      if (g.position.y <= 0.05) {
        g.position.y = 0.05;
        if (Math.abs(g.velocity.y) > 0.45) {
          g.velocity.y = -g.velocity.y * 0.42;
        } else {
          g.velocity.y = 0;
        }
        g.velocity.x *= 0.68;
        g.velocity.z *= 0.68;
        g.angularVelocity.scale(0.65);
      }

      g.entity.setPosition(g.position.x, g.position.y, g.position.z);
      g.entity.rotate(
        g.angularVelocity.x * dt * 45,
        g.angularVelocity.y * dt * 45,
        g.angularVelocity.z * dt * 45
      );

      const blinkPeriod = g.fuseRemainingS < 0.45 ? 0.06 : 0.14;
      g.fusePinLed.enabled = Math.floor(g.blinkTimerS / blinkPeriod) % 2 === 0;

      if (g.fuseRemainingS <= 0) {
        const detCenter = vec3(g.position.x, g.position.y, g.position.z);
        g.entity.destroy();
        this.activeGrenades.splice(i, 1);
        this.detonateFragGrenade(detCenter);
      }
    }

    // 2. Step Expanding Explosion Fireballs & Shockwave Rings
    for (let i = this.activeBlastFlashes.length - 1; i >= 0; i--) {
      const bf = this.activeBlastFlashes[i];
      bf.elapsedS += dt;
      const t = Math.min(1, bf.elapsedS / bf.durationS);
      const fireScale = 0.4 + bf.maxRadiusM * Math.pow(t, 0.55) * (1 - t * 0.35);
      const ringScale = 0.6 + bf.maxRadiusM * 2.1 * t;
      bf.fireball.setLocalScale(fireScale, fireScale * 0.85, fireScale);
      bf.shockRing.setLocalScale(ringScale, 0.02, ringScale);

      if (bf.elapsedS >= bf.durationS) {
        bf.root.destroy();
        this.activeBlastFlashes.splice(i, 1);
      }
    }

    // 3. Step 3D Articulated PBD Ragdoll Physics & Sync PS1/PS2 Combatants
    for (const t of this.targets) {
      stepRagdollPhysics(t.healthState, dt, 0.0);
      t.syncFromHealthState(dt, totalElapsedTimeS);
    }

    // 4. Project 3D Enemy Health Bars & Triage Status onto HUD Overlay
    if (camera) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const cx = vw * 0.5;
      const cy = vh * 0.5;
      const entries: ProjectedTargetTriageEntry[] = [];
      let aimedTarget: GhoulMannequinEntity | null = null;
      let bestCrosshairDist = 165;

      for (const t of this.targets) {
        const hs = t.healthState;
        const headPopped = hs.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';
        const headNode = hs.ragdollBones.HEAD_CRANIUM;
        const neckNode = hs.ragdollBones.NECK_CERVICAL;
        const chestNode = hs.ragdollBones.TORSO_UPPER_THORAX;

        const anchorPos = headPopped
          ? neckNode?.position ?? hs.worldPosition
          : headNode?.position ?? hs.worldPosition;
        const yLift = hs.isRagdollActive ? 0.30 : 0.28;

        this.scratchWorldPt.set(anchorPos.x, anchorPos.y + yLift, anchorPos.z);
        camera.worldToScreen(this.scratchWorldPt, this.scratchScreenPt);

        const visible =
          this.scratchScreenPt.z > 0 &&
          this.scratchScreenPt.x >= -90 &&
          this.scratchScreenPt.x <= vw + 90 &&
          this.scratchScreenPt.y >= -60 &&
          this.scratchScreenPt.y <= vh + 60;

        entries.push({
          state: hs,
          screenX: this.scratchScreenPt.x,
          screenY: this.scratchScreenPt.y,
          visible,
        });

        const bodyPos = chestNode?.position ?? anchorPos;
        this.scratchWorldPt.set(bodyPos.x, bodyPos.y, bodyPos.z);
        camera.worldToScreen(this.scratchWorldPt, this.scratchBodyScreenPt);
        if (this.scratchBodyScreenPt.z > 0) {
          const dx = this.scratchBodyScreenPt.x - cx;
          const dy = this.scratchBodyScreenPt.y - cy;
          const distPx = Math.hypot(dx, dy);
          const headDistPx = Math.hypot(
            this.scratchScreenPt.x - cx,
            this.scratchScreenPt.y + 28 - cy
          );
          const minDist = Math.min(distPx, headDistPx);
          if (minDist < bestCrosshairDist) {
            bestCrosshairDist = minDist;
            aimedTarget = t;
          }
        }
      }

      const focusedState = aimedTarget?.healthState ?? this.lastEngagedTarget?.healthState ?? null;
      hudController.updateTriageOverlays(entries, focusedState);
    }
  }
}
