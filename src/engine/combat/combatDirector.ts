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
import type { BlastEvent } from '../../contracts/destruction.ts';
import type {
  InternalBallisticsReport,
  PhysiologicalEntityState,
} from '../../contracts/physiology.ts';
import {
  vec3,
  copyVec3,
  add,
  sub,
  scale,
  cross,
  dot,
  length,
  normalize,
  distance,
  deterministicConeSpread,
} from '../../core/ballistics/vec3.ts';
import { DEFAULT_ENVIRONMENT } from '../../core/ballistics/weapons.ts';
import {
  ALL_GHOUL_ZONES,
  GHOUL_ZONE_HIERARCHY,
  LEFT_HANDED_PROBABILITY,
  createTargetHealthState,
  getSubtreeZones,
} from '../../core/ghoul/anatomy.ts';
import {
  simulateShot,
  applyShotReportToTarget,
  stepRagdollPhysics,
} from '../../core/ballistics/solver.ts';
import { getDefaultAnatomicalBvh, AnatomicalBvh } from '../../core/ghoul/bvhVolumes.ts';
import { marchInternalBallistics } from '../../core/ballistics/rayMarchTerminal.ts';
import { PhysiologyEcsSystem } from '../../core/physiology/physiologySystem.ts';
import { EngineMaterialPalette } from '../materials.ts';
import { GhoulMannequinEntity } from '../mannequin.ts';
import { GoreAndBallisticsFxManager } from '../goreFx.ts';
import { VascularBloodFxEmitter } from '../gore/vascularBloodFx.ts';
import { HudController, ProjectedTargetTriageEntry } from '../hudController.ts';
import type { MayhemDirector } from '../fx/mayhemDirector.ts';
import {
  isArmChainIntactAndFunctional,
  type ActiveFiringHand,
  type BrutalKillRewardKind,
  type TacticalCombatAiSystem,
} from '../ai/tacticalCombatAi.ts';
import type {
  CombatAudioEngine,
  GoreImpactAudioKind,
} from '../audio/combatAudioEngine.ts';
import type {
  CombatantGlbInstance,
  GlbModelRegistry,
  WeaponAssetId,
  WeaponGlbInstance,
} from '../assets/glbLoader.ts';

export interface RangeTargetConfig {
  id: string;
  name: string;
  archetype: EnemyArchetypeId;
  position: { x: number; y: number; z: number };
  yawDeg: number;
}

/**
 * 7 Tactical Breaching Arena Hostiles stationed across CQB lanes, destructible R6 wood walls,
 * marching/Voronoi glass galleries, instanced masonry brick barriers, Voronoi fractured concrete
 * cover (paired with red hazard barrels), and 42m sniper overwatch.
 */
export const TARGET_CONFIGS: RangeTargetConfig[] = [
  {
    id: 'target_0',
    name: 'NYC SKINHEAD PUNK (5m CQB)',
    archetype: 'SKINHEAD_PUNK',
    position: { x: 0.9, y: 0, z: -5.2 },
    yawDeg: 0,
  },
  {
    id: 'target_1',
    name: 'SHOOT-HOUSE BREACHER (8m WOOD)',
    archetype: 'MILITIA_GUNNER',
    position: { x: -2.3, y: 0, z: -8.35 },
    yawDeg: 6,
  },
  {
    id: 'target_2',
    name: 'WEST GALLERY SENTRY (8m GLASS)',
    archetype: 'SKINHEAD_PUNK',
    position: { x: -5.5, y: 0, z: -7.9 },
    yawDeg: 14,
  },
  {
    id: 'target_3',
    name: 'EAST GALLERY GUNNER (8m VORONOI)',
    archetype: 'MILITIA_GUNNER',
    position: { x: 5.5, y: 0, z: -8.1 },
    yawDeg: -14,
  },
  {
    id: 'target_4',
    name: 'MASONRY BUNKER GUARD (14m BRICK)',
    archetype: 'MILITIA_GUNNER',
    position: { x: -3.8, y: 0, z: -13.75 },
    yawDeg: 10,
  },
  {
    id: 'target_5',
    name: 'KOSOVO HEAVY ENFORCER (15m CONCRETE)',
    archetype: 'HEAVY_ENFORCER',
    position: { x: 2.3, y: 0, z: -14.85 },
    yawDeg: -8,
  },
  {
    id: 'target_6',
    name: 'SPETSNAZ SNIPER (42m OVERWATCH)',
    archetype: 'SNIPER_OPERATIVE',
    position: { x: 0.4, y: 0, z: -42.0 },
    yawDeg: 0,
  },
];

const SYNTHETIC_SHRAPNEL_AMMO: AmmoSpec = {
  id: 'comp_b_shrapnel',
  name: 'HE Steel Shrapnel',
  caliber: '6mm Fragment',
  type: 'FMJ',
  massKg: 0.0042,
  diameterM: 0.0062,
  muzzleVelocityMs: 560,
  dragCoefficient: 0.42,
  tissueExpansionFactor: 1.2,
  armorPenetrationFactor: 1.15,
  pelletCount: 1,
  spreadRadians: 0,
  ragdollImpulseMultiplier: 1.25,
  goreFactor: 1.35,
};

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

export interface CombatDirectorSubsystems {
  mayhemDirector?: MayhemDirector | null;
  tacticalAi?: TacticalCombatAiSystem | null;
  combatAudio?: CombatAudioEngine | null;
  glbRegistry?: GlbModelRegistry | null;
  isLineOfSightBlocked?: (fromWorld: Vec3Like, toWorld: Vec3Like) => boolean;
}

interface ActiveFragGrenade {
  entity: pc.Entity;
  fusePinLed: pc.Entity;
  glbInstance: WeaponGlbInstance | null;
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

interface OffhandSidearmRig {
  targetId: string;
  holderEntity: pc.Entity;
  glbInstance: WeaponGlbInstance | null;
  isGlbModel: boolean;
  wasHeldLastFrame: boolean;
  lastHand: ActiveFiringHand | null;
  clonedMaterials: pc.StandardMaterial[];
}

interface RestArmBoneFrame {
  restPos: pc.Vec3;
  restRot: pc.Quat;
  restRotInv: pc.Quat;
}

function basisVectorsToQuat(
  right: Vec3Like,
  up: Vec3Like,
  forward: Vec3Like,
  tmpMat: pc.Mat4,
  outQuat: pc.Quat
): pc.Quat {
  const d = tmpMat.data;
  d[0] = right.x;
  d[1] = right.y;
  d[2] = right.z;
  d[3] = 0;

  d[4] = up.x;
  d[5] = up.y;
  d[6] = up.z;
  d[7] = 0;

  d[8] = forward.x;
  d[9] = forward.y;
  d[10] = forward.z;
  d[11] = 0;

  d[12] = 0;
  d[13] = 0;
  d[14] = 0;
  d[15] = 1;

  outQuat.setFromMat4(tmpMat);
  return outQuat;
}

const REST_ARM_BONE_FRAMES: ReadonlyMap<GhoulZoneId, RestArmBoneFrame> = (() => {
  const refState = createTargetHealthState('__sidearm_rest_ref__', 'RestRef', vec3(0, 0, 0), 0);
  const mat = new pc.Mat4();
  const map = new Map<GhoulZoneId, RestArmBoneFrame>();
  for (const zone of ALL_GHOUL_ZONES) {
    const b = refState.ragdollBones[zone];
    const restRot = basisVectorsToQuat(
      b.basisRight,
      b.basisUp,
      b.basisForward,
      mat,
      new pc.Quat()
    );
    const restRotInv = restRot.clone().invert();
    map.set(zone, {
      restPos: new pc.Vec3(b.position.x, b.position.y, b.position.z),
      restRot,
      restRotInv,
    });
  }
  return map;
})();

export class CombatDirector {
  public static readonly TARGET_CONFIGS: readonly RangeTargetConfig[] = TARGET_CONFIGS;
  public readonly TARGET_CONFIGS: readonly RangeTargetConfig[] = TARGET_CONFIGS;

  public targets: GhoulMannequinEntity[] = [];
  public lastEngagedTarget: GhoulMannequinEntity | null = null;
  public environment: EnvironmentState = { ...DEFAULT_ENVIRONMENT };
  public enableXRayInspector = false;

  public readonly anatomicalBvh: AnatomicalBvh;
  public readonly physiologySystem: PhysiologyEcsSystem;
  public readonly vascularFx: VascularBloodFxEmitter;
  public lastInternalBallisticsReport: InternalBallisticsReport | null = null;

  /**
   * Optional Wave 2 destructible cover ray interceptor (wood/glass/brick/concrete walls + barrels).
   */
  public environmentRayInterceptor?: EnvironmentRayInterceptor;

  /**
   * Optional breach-aware visual line-of-sight query used to occlude floating world-space HUD bars behind solid walls.
   */
  public isLineOfSightBlocked?: (fromWorld: Vec3Like, toWorld: Vec3Like) => boolean;

  /**
   * Optional Wave 2 radial explosion blast callback for destructible cover subsystems.
   */
  public onExplosionBlast?: ExplosionBlastHandler;

  /**
   * Optional first-person camera blast shake callback.
   */
  public onCameraShake?: CameraShakeCallback;

  private mayhemDirector: MayhemDirector | null = null;
  private tacticalAi: TacticalCombatAiSystem | null = null;
  private combatAudio: CombatAudioEngine | null = null;
  private glbRegistry: GlbModelRegistry | null = null;

  private readonly app: pc.AppBase;
  private readonly materials: EngineMaterialPalette;
  private readonly fxManager: GoreAndBallisticsFxManager;
  private readonly hudController: HudController;

  private readonly activeGrenades: ActiveFragGrenade[] = [];
  private readonly activeBlastFlashes: ActiveBlastFlashFx[] = [];
  private readonly offhandSidearmRigs = new Map<string, OffhandSidearmRig>();
  private readonly lastHitClockByTarget = new Map<string, number>();
  private lastUpdateClockS = 0;
  private grenadeCooldownS = 0;

  private readonly blastFireballMat: pc.StandardMaterial;
  private readonly proceduralM9NitrideMat: pc.StandardMaterial;
  private readonly proceduralM9GripMat: pc.StandardMaterial;
  private readonly scratchWorldPt = new pc.Vec3();
  private readonly scratchScreenPt = new pc.Vec3();
  private readonly scratchBodyScreenPt = new pc.Vec3();
  private readonly lastViewerWorldPos = new pc.Vec3(0, 1.62, 0);
  private readonly scratchSidearmMat4 = new pc.Mat4();
  private readonly scratchSidearmQuat = new pc.Quat();
  private readonly scratchRagQuat = new pc.Quat();
  private readonly scratchDeltaQuat = new pc.Quat();
  private readonly scratchWorldQuat = new pc.Quat();
  private readonly scratchOffsetVec = new pc.Vec3();
  private readonly scratchRotOffsetVec = new pc.Vec3();

  constructor(
    app: pc.AppBase,
    materials: EngineMaterialPalette,
    fxManager: GoreAndBallisticsFxManager,
    hudController: HudController,
    onCameraShake?: CameraShakeCallback,
    subsystems?: CombatDirectorSubsystems
  ) {
    this.app = app;
    this.materials = materials;
    this.fxManager = fxManager;
    this.hudController = hudController;
    this.onCameraShake = onCameraShake;

    this.anatomicalBvh = getDefaultAnatomicalBvh();
    this.physiologySystem = new PhysiologyEcsSystem(8);
    this.vascularFx = new VascularBloodFxEmitter(app, materials);

    if (subsystems) {
      this.connectSubsystems(subsystems);
    }

    this.blastFireballMat = new pc.StandardMaterial();
    this.blastFireballMat.name = 'fragBlastFireballMat';
    this.blastFireballMat.diffuse = new pc.Color(1.0, 0.52, 0.12);
    this.blastFireballMat.emissive = new pc.Color(1.0, 0.45, 0.08);
    this.blastFireballMat.opacity = 0.72;
    this.blastFireballMat.blendType = pc.BLEND_NORMAL;
    this.blastFireballMat.depthWrite = false;
    this.blastFireballMat.cull = pc.CULLFACE_NONE;
    this.blastFireballMat.update();

    this.proceduralM9NitrideMat = new pc.StandardMaterial();
    this.proceduralM9NitrideMat.name = 'berettaM9DarkNitrideMat';
    this.proceduralM9NitrideMat.diffuse = new pc.Color(0.14, 0.15, 0.17);
    this.proceduralM9NitrideMat.useMetalness = true;
    this.proceduralM9NitrideMat.metalness = 0.86;
    this.proceduralM9NitrideMat.gloss = 0.62;
    this.proceduralM9NitrideMat.update();

    this.proceduralM9GripMat = new pc.StandardMaterial();
    this.proceduralM9GripMat.name = 'berettaM9PolymerGripMat';
    this.proceduralM9GripMat.diffuse = new pc.Color(0.08, 0.085, 0.095);
    this.proceduralM9GripMat.useMetalness = true;
    this.proceduralM9GripMat.metalness = 0.12;
    this.proceduralM9GripMat.gloss = 0.28;
    this.proceduralM9GripMat.update();
  }

  public connectSubsystems(subsystems: CombatDirectorSubsystems): void {
    if (subsystems.mayhemDirector !== undefined) {
      this.mayhemDirector = subsystems.mayhemDirector;
    }
    if (subsystems.tacticalAi !== undefined) {
      this.tacticalAi = subsystems.tacticalAi;
    }
    if (subsystems.combatAudio !== undefined) {
      this.combatAudio = subsystems.combatAudio;
    }
    if (subsystems.glbRegistry !== undefined) {
      this.glbRegistry = subsystems.glbRegistry;
      if (this.glbRegistry && this.targets.length > 0) {
        this.upgradeTargetsWithGlb(this.glbRegistry);
      }
    }
    if (subsystems.isLineOfSightBlocked !== undefined) {
      this.isLineOfSightBlocked = subsystems.isLineOfSightBlocked;
    }
  }

  /**
   * Live-upgrades all active `GhoulMannequinEntity` combatants with the rigged `ghoul_combatant.glb`
   * hierarchy once async asset streaming completes.
   */
  public upgradeTargetsWithGlb(glbRegistry: GlbModelRegistry): number {
    this.glbRegistry = glbRegistry;
    let upgraded = 0;
    for (const target of this.targets) {
      if (target.attachCombatantGlb(glbRegistry)) {
        upgraded++;
      }
      const existingRig = this.offhandSidearmRigs.get(target.healthState.targetId);
      if (existingRig && !existingRig.isGlbModel) {
        this.destroySingleSidearmRig(existingRig);
        this.offhandSidearmRigs.delete(target.healthState.targetId);
      }
    }
    return upgraded;
  }

  public notifyGlbPreloadFailed(): void {
    this.glbRegistry = null;
    for (const target of this.targets) {
      target.allowProceduralFallback();
    }
  }

  public getTargetPhysiology(targetId: string): PhysiologicalEntityState | undefined {
    return this.physiologySystem.getEntity(targetId);
  }

  public spawnAllTargets(): void {
    const oldTargets = this.targets;
    const nextTargets: GhoulMannequinEntity[] = [];

    this.clearLiveGrenadesAndFlashes();
    this.destroyOffhandSidearmRigs();
    this.lastHitClockByTarget.clear();
    this.fxManager.clearAll();
    this.vascularFx.clearAll();
    this.physiologySystem.reset();
    this.lastInternalBallisticsReport = null;

    for (const cfg of TARGET_CONFIGS) {
      const yawRad = (cfg.yawDeg * Math.PI) / 180;
      const isLeftHanded = Math.random() < LEFT_HANDED_PROBABILITY;
      const healthState = createTargetHealthState(
        cfg.id,
        cfg.name,
        vec3(cfg.position.x, cfg.position.y, cfg.position.z),
        yawRad,
        cfg.archetype,
        isLeftHanded
      );

      const enableHelmet =
        cfg.archetype === 'HEAVY_ENFORCER' || cfg.archetype === 'MILITIA_GUNNER';
      const physioState = this.physiologySystem.registerEntity({
        entityId: cfg.id,
        alertnessState: 'UNSUSPECTING',
        dominantHand: isLeftHanded ? 'RIGHT' : 'LEFT',
        enableArmorPlates: healthState.hasChestArmor,
        enableHelmet,
      });

      this.vascularFx.bindEntity(physioState, () => ({
        positionWorld: copyVec3(healthState.worldPosition),
        yawRad: healthState.yawRad,
      }));

      const mannequin = new GhoulMannequinEntity(
        this.app,
        healthState,
        this.materials,
        this.fxManager,
        this.glbRegistry
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

    if (this.tacticalAi) {
      this.tacticalAi.registerWaveTargets(
        this.targets.map((t) => t.healthState),
        false
      );
    }
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

  private getViewerPosVec3(): Vec3Like {
    return vec3(
      this.lastViewerWorldPos.x,
      this.lastViewerWorldPos.y,
      this.lastViewerWorldPos.z
    );
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

  /**
   * Synchronizes decoupled 8 Hz `PhysiologicalEntityState` hemodynamics, oxygenation,
   * limb motor nerve status, and Class-IV exsanguination / hypoxia arrest onto `TargetHealthState`.
   */
  private syncPhysiologyToHealthState(
    physio: PhysiologicalEntityState,
    hs: TargetHealthState
  ): void {
    // Keep GHOUL distal-amputation bleed rates reflected in PhysiologyEcsSystem
    if (hs.bloodLossRateMlPerSec > physio.baseBleedRateMlPerSec) {
      physio.baseBleedRateMlPerSec = hs.bloodLossRateMlPerSec;
    }

    // If GHOUL killed the target instantly (e.g., CRANIAL_POP or massive trauma), mark physio dead
    if (!hs.alive && physio.alive) {
      physio.alive = false;
      physio.conscious = false;
      if (physio.causeOfDeath === 'NONE') {
        physio.causeOfDeath =
          hs.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP'
            ? 'CNS_BRAINSTEM_DESTRUCTION'
            : 'CARDIAC_DESTRUCTION';
      }
      physio.heartRateBpm = 0;
      physio.meanArterialPressureMmHg = 0;
      physio.systolicBpMmHg = 0;
      physio.diastolicBpMmHg = 0;
      physio.effectiveBleedRateMlPerSec = 0;
      return;
    }

    // Conversely, if PhysiologyEcsSystem killed the target (brainstem/cardiac rupture, Class IV exsanguination, or hypoxic arrest)
    if (!physio.alive && hs.alive) {
      hs.alive = false;
      hs.currentHp = 0;
      hs.consciousness = 0;
      hs.heartRateBpm = 0;
      hs.systolicBpMmHg = 0;
      if (!hs.isRagdollActive) {
        hs.isRagdollActive = true;
      }
    }

    if (physio.biologicalTicksExecuted > 0 || physio.vascularWounds.length > 0) {
      hs.bloodVolumeMl = Math.min(hs.bloodVolumeMl, physio.bloodVolumeMl);
    }
    hs.bloodLossRateMlPerSec = Math.max(
      hs.bloodLossRateMlPerSec,
      physio.effectiveBleedRateMlPerSec > 0
        ? physio.effectiveBleedRateMlPerSec
        : physio.baseBleedRateMlPerSec
    );
    hs.systolicBpMmHg = physio.systolicBpMmHg;
    hs.heartRateBpm = physio.heartRateBpm;
    hs.oxygenSaturationPct = Math.round(physio.oxygenSaturationPct);
    hs.painShock = Math.max(hs.painShock, physio.painShockLevel);

    if (!physio.conscious) {
      const aiAgent = this.tacticalAi?.getAgent(hs.targetId);
      if (
        physio.neurogenicShockCollapsed &&
        hs.alive &&
        aiAgent &&
        aiAgent.neurogenicShockTimerS <= 0 &&
        physio.bloodVolumeMl > 2650 &&
        physio.oxygenSaturationPct >= 58
      ) {
        physio.neurogenicShockCollapsed = false;
        physio.conscious = true;
        physio.alertnessState = 'COMBAT_ALERT';
        physio.adrenalineLevel = Math.max(physio.adrenalineLevel, 0.92);
        hs.consciousness = Math.max(hs.consciousness, 0.52);
      } else {
        hs.consciousness = Math.min(hs.consciousness, 0.18);
      }
    }

    if (!physio.leftLegFunctional) hs.leftLegFunctional = false;
    if (!physio.rightLegFunctional) hs.rightLegFunctional = false;
    if (!physio.leftArmFunctional) hs.leftArmFunctional = false;
    if (!physio.rightArmFunctional) hs.rightArmFunctional = false;
    if (physio.weaponDropped) {
      hs.weaponDropped = true;
      hs.primaryArmDisarmed = true;
    }

    if (!hs.isRagdollActive && hs.alive) {
      if (physio.readability.immediatePostureReaction === 'DIAPHRAGM_DROP_KNEEL') {
        hs.posture = 'GUT_HURT';
      } else if (physio.readability.immediatePostureReaction === 'LEG_COLLAPSE_PRONE') {
        hs.posture = 'LEG_BUCKLED';
      }
    }
  }

  private applyImpactFxAndState(
    target: GhoulMannequinEntity,
    report: ShotSimulationReport,
    weaponLabel: string,
    ammoForInternalMarch?: AmmoSpec
  ): void {
    this.lastEngagedTarget = target;
    const hs = target.healthState;
    this.lastHitClockByTarget.set(hs.targetId, this.lastUpdateClockS);
    const wasAlive = hs.alive;

    applyShotReportToTarget(hs, report);

    // Sub-stepped Two-Tier Anatomical BVH Internal Ballistics + Decoupled Physiology Trauma!
    const physio = this.physiologySystem.getEntity(hs.targetId);
    if (physio) {
      const aiAgent = this.tacticalAi?.getAgent(hs.targetId);
      if (aiAgent && aiAgent.state !== 'PATROL_GUARD') {
        physio.alertnessState = 'COMBAT_ALERT';
        physio.adrenalineLevel = Math.max(physio.adrenalineLevel, aiAgent.adrenaline);
      }

      const primaryWound = report.woundEvents[0];
      const marchAmmo = ammoForInternalMarch ?? SYNTHETIC_SHRAPNEL_AMMO;
      const marchDir = primaryWound
        ? normalize(primaryWound.impactDirectionWorld)
        : normalize(report.aimDirectionWorld);
      const marchOrigin = primaryWound
        ? sub(primaryWound.entryPointWorld, scale(marchDir, 0.35))
        : report.originWorld;
      const marchSpeedMs = Math.max(
        60,
        primaryWound ? primaryWound.entryVelocityMs : report.impactSpeedMs
      );

      let internalReport = marchInternalBallistics(
        {
          ammo: marchAmmo,
          rayOriginWorld: marchOrigin,
          rayDirectionWorld: marchDir,
          impactVelocityMs: marchSpeedMs,
          characterTransform: {
            positionWorld: copyVec3(hs.worldPosition),
            yawRad: hs.yawRad,
          },
          config: {
            enableArmorPlates: hs.hasChestArmor && hs.chestArmorIntegrity > 0.05,
            enableHelmet:
              hs.headgearIntact &&
              (hs.archetype === 'HEAVY_ENFORCER' || hs.archetype === 'MILITIA_GUNNER'),
            initialPlateIntegrity: physio.plateIntegrity,
          },
        },
        this.anatomicalBvh
      );

      // If an outer-edge GHOUL hitbox graze skimmed 1cm outside the tighter Tier-1 BVH shell,
      // align through the struck zone's anatomical bone axis so 100% of confirmed hits couple into BVH!
      if (!internalReport.hitOuterShell && primaryWound) {
        const bonePos = hs.ragdollBones[primaryWound.ghoulZone]?.position;
        if (bonePos) {
          const nudgedEntry = vec3(
            (primaryWound.entryPointWorld.x + bonePos.x) * 0.5,
            (primaryWound.entryPointWorld.y + bonePos.y) * 0.5,
            (primaryWound.entryPointWorld.z + bonePos.z) * 0.5
          );
          internalReport = marchInternalBallistics(
            {
              ammo: marchAmmo,
              rayOriginWorld: sub(nudgedEntry, scale(marchDir, 0.35)),
              rayDirectionWorld: marchDir,
              impactVelocityMs: marchSpeedMs,
              characterTransform: {
                positionWorld: copyVec3(hs.worldPosition),
                yawRad: hs.yawRad,
              },
              config: {
                enableArmorPlates: hs.hasChestArmor && hs.chestArmorIntegrity > 0.05,
                enableHelmet:
                  hs.headgearIntact &&
                  (hs.archetype === 'HEAVY_ENFORCER' || hs.archetype === 'MILITIA_GUNNER'),
                initialPlateIntegrity: physio.plateIntegrity,
              },
            },
            this.anatomicalBvh
          );
        }
      }
      this.lastInternalBallisticsReport = internalReport;

      if (internalReport.hitOuterShell) {
        this.physiologySystem.applyBallisticTrauma(hs.targetId, internalReport);
        for (const ot of internalReport.organTrauma) {
          if (ot.directCrushLacerated || ot.stretchCavitationRuptured) {
            hs.rupturedOrgans.add(ot.organId);
          }
        }
        for (const bt of internalReport.boneTrauma) {
          if (bt.fractured) {
            hs.fracturedBones.add(bt.boneId);
          }
        }
      }

      this.syncPhysiologyToHealthState(physio, hs);
    }

    const isLethalNow = !hs.alive;
    const armorOnly =
      report.woundEvents.length > 0 && report.woundEvents.every((w) => w.armorStopped);

    this.hudController.triggerHitmarker(
      isLethalNow ? 'LETHAL' : armorOnly ? 'ARMOR' : 'NORMAL'
    );
    this.hudController.pushCombatFeed(
      report,
      weaponLabel,
      hs.name,
      wasAlive,
      hs.alive
    );

    // Wall & floor directional blood splatter decals + CRANIAL_POP Kill-Punch micro-dilation
    this.mayhemDirector?.processShotSimulationReport(report);

    // Notify Tactical Combat AI of trauma, stagger, leg-cripple crawl, and brutal kill siphon
    if (this.tacticalAi) {
      const primaryZone =
        report.woundEvents[0]?.ghoulZone ?? report.ragdollPlan.primaryHitZone ?? undefined;
      this.tacticalAi.notifyEnemyHit(hs, {
        hitZone: primaryZone,
        energyDepositedJ: report.totalEnergyDepositedJ,
        externalAccuracyMultiplier: physio?.readability.aiAccuracyMultiplier,
      });

      if (wasAlive && !hs.alive) {
        let rewardKind: BrutalKillRewardKind = 'STANDARD_KILL';
        if (report.dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP')) {
          rewardKind = 'CRANIAL_POP';
        } else if (report.dismembermentEvents.some((d) => d.goreMode === 'EVISCERATED')) {
          rewardKind = 'EVISCERATED';
        } else if (report.dismembermentEvents.some((d) => d.goreMode === 'CLEAN_SEVER')) {
          rewardKind = 'CLEAN_SEVER';
        }
        this.tacticalAi.grantBrutalKillReward(rewardKind);
      }
    }

    // 3D Spatial Gore Foley & Formant Vocal Trauma Cues
    if (this.combatAudio) {
      const listenerPos = this.getViewerPosVec3();
      const impactPos =
        report.woundEvents[0]?.entryPointWorld ??
        hs.ragdollBones.TORSO_UPPER_THORAX?.position ??
        hs.worldPosition;

      let goreKind: GoreImpactAudioKind = 'FLESH_HIT';
      if (report.dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP')) {
        goreKind = 'CRANIAL_POP';
      } else if (report.dismembermentEvents.length > 0) {
        goreKind = 'LIMB_SEVER';
      } else if (armorOnly) {
        goreKind = 'ARMOR_SPARK';
      } else if (report.woundEvents.some((w) => w.boneShattered || w.boneFractured)) {
        goreKind = 'BONE_SHATTER';
      } else if (
        report.woundEvents.some((w) => w.arterialSevered) ||
        physio?.readability.bleedVisualProfile.kind === 'ARTERIAL_PULSING_JET'
      ) {
        goreKind = 'ARTERIAL_SPURT';
      }
      this.combatAudio.playGoreImpact(goreKind, impactPos, listenerPos);

      if (hs.alive && physio) {
        const vocal = physio.readability.vocalCue;
        if (
          vocal === 'SHARP_GASP' ||
          vocal === 'WET_HEMOTHORAX_COUGH' ||
          vocal === 'PAIN_GRUNT'
        ) {
          this.combatAudio.playVocalTraumaCue(vocal, impactPos, listenerPos);
        }
      }
    }

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
      this.fxManager.attachArterialFountain(hs, dism);
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
    let effectiveAmmo: AmmoSpec = ammo;
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
        effectiveAmmo = {
          ...ammo,
          muzzleVelocityMs: preIntercept.remainingSpeedMs,
        };
        const attenuatedReport = simulateShot(
          weapon,
          effectiveAmmo,
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

    this.applyImpactFxAndState(target, report, weapon.codeName, effectiveAmmo);

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
          let collatAmmo = baseResidualAmmo;
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
              collatAmmo = { ...baseResidualAmmo, muzzleVelocityMs: residualSpeedMs };
              collatReport = simulateShot(
                weapon,
                collatAmmo,
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
            this.applyImpactFxAndState(
              collateral.target,
              collatReport,
              weapon.codeName,
              collatAmmo
            );
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
            this.applyImpactFxAndState(cr.target, attenReport, weapon.codeName, attenAmmo);
          }
          continue;
        }
      }

      this.applyImpactFxAndState(cr.target, cr.report, weapon.codeName, ammo);
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

    let glbInstance: WeaponGlbInstance | null = null;
    if (this.glbRegistry && this.glbRegistry.isLoaded('frag_grenade')) {
      try {
        glbInstance = this.glbRegistry.instantiateWeapon('frag_grenade');
        glbInstance.playFire(1.0);
        grenadeRoot.addChild(glbInstance.rootEntity);
      } catch {
        glbInstance = null;
      }
    }

    if (!glbInstance) {
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
    }

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
      glbInstance,
      position: new pc.Vec3(spawnPos.x, spawnPos.y, spawnPos.z),
      velocity: new pc.Vec3(throwVel.x, throwVel.y, throwVel.z),
      angularVelocity: new pc.Vec3(8.5, 5.2, -6.4),
      fuseRemainingS: 1.6,
      blinkTimerS: 0,
    });

    this.hudController.pushSystemToast('M67 FRAG', 'LIVE GRENADE OUT (1.6S)');
  }

  /**
   * Shared high-explosive GHOUL + BVH physiology blast pipeline used by both thrown M67 Frag Grenades
   * and detonating Red Hazard Barrels! Returns the number of newly killed combatants.
   */
  public applyExternalExplosionTrauma(
    blast: BlastEvent,
    sourceLabel = 'HAZARD BARREL'
  ): number {
    const center = blast.centerWorld;
    const blastRadiusM = blast.radiusM;
    const peakImpulseNs = blast.peakImpulseNs;
    const peakEnergyJ = blast.peakEnergyJ;

    // 1. Visual Fireball, Shockwave Ring & Shrapnel Sparks
    this.spawnBlastVisualFx(center, blastRadiusM);
    this.fxManager.spawnArmorImpactSparks(add(center, vec3(0, 0.12, 0)), vec3(0, 1, 0));
    this.fxManager.spawnBoneShatterSparks(add(center, vec3(0, 0.18, 0)), vec3(0, 1, 0));

    // 2. 3D Catastrophic Explosion Audio (with <= 4.5m ear-ringing tinnitus!)
    if (this.combatAudio) {
      const intensity = Math.min(2.0, Math.max(0.75, peakEnergyJ / 6000));
      this.combatAudio.playExplosion(center, this.getViewerPosVec3(), intensity);
    }

    // 3. Camera Shake Attenuated by Viewer Distance
    if (this.onCameraShake) {
      const viewerDist = distance(center, this.getViewerPosVec3());
      if (viewerDist < 34.0) {
        const proximity = Math.max(0.12, 1 - viewerDist / 34.0);
        this.onCameraShake(4.2 * proximity * proximity + 0.55, 0.44);
      }
    }

    // 4. GHOUL Anatomical Shrapnel Trauma, BVH Organ/Vascular Laceration & 3D Ragdoll Launch
    let newlyKilledCount = 0;

    for (const target of this.targets) {
      const hs = target.healthState;
      const wasAlive = hs.alive;
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
      this.applyImpactFxAndState(target, blastReport, sourceLabel, SYNTHETIC_SHRAPNEL_AMMO);

      if (wasAlive && !hs.alive) {
        newlyKilledCount++;
      }

      if (distM < 4.5 && hs.isRagdollActive) {
        const closeLift = (1 - distM / 4.5) * 2.55;
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

    if (newlyKilledCount >= 2) {
      this.tacticalAi?.grantBrutalKillReward('MULTI_KILL_BLAST');
      this.mayhemDirector?.bulletTime.triggerKillPunch('MULTI_KILL_BLAST', 0.35);
    }

    return newlyKilledCount;
  }

  private detonateFragGrenade(center: Vec3Like): void {
    const blastRadiusM = 7.5;
    const peakImpulseNs = 940.0;
    const peakEnergyJ = 4400.0;

    const killedCount = this.applyExternalExplosionTrauma(
      {
        centerWorld: center,
        radiusM: blastRadiusM,
        peakImpulseNs,
        peakEnergyJ,
      },
      'M67 FRAG'
    );

    // Wave 2 Destructible Cover & Sympathetic Barrel Chain-Reaction Hook
    this.onExplosionBlast?.(center, blastRadiusM, peakImpulseNs, peakEnergyJ);
    void killedCount;
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

    const energyScale = Math.min(2.2, Math.max(1.0, peakEnergyJ / 4400.0));
    const totalDamageHp = 245.0 * falloff * (0.75 + 0.25 * energyScale);
    const totalEnergyJ = peakEnergyJ * falloff;
    const isCloseLethal = distM < 3.5;
    const isLethalKill = isCloseLethal || totalDamageHp >= hs.currentHp;

    const exposedZones: GhoulZoneId[] = [
      'TORSO_LOWER_ABDOMEN',
      'TORSO_UPPER_THORAX',
      'THIGH_LEFT',
      'THIGH_RIGHT',
      'SHIN_LEFT',
      'SHIN_RIGHT',
      'KNEE_LEFT',
      'KNEE_RIGHT',
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
      .slice(0, distM < 4.2 ? 5 : 3);

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
        entryVelocityMs: Math.max(240, 620 * falloff),
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
        boneShattered: distM < 3.2,
        organRuptured:
          distM < 3.2 && (z === 'TORSO_LOWER_ABDOMEN' || z === 'TORSO_UPPER_THORAX'),
        limbSensoryShock: true,
        limbSevered: false,
        arterialSevered: distM < 3.8,
        deflectionAngleDeg: 0,
        physiologicalEffect: 'High-explosive fragmentation trauma',
      });
    }

    const dismembermentEvents: DismembermentEvent[] = [];
    const newlySeveredZones: GhoulZoneId[] = [];

    if (distM < 3.4) {
      const candidateLimbs: GhoulZoneId[] =
        distM < 2.2
          ? ['KNEE_LEFT', 'SHIN_RIGHT', 'FOREARM_LEFT']
          : ['SHIN_LEFT', 'SHIN_RIGHT'];
      const maxSevers = distM < 2.2 ? 2 : 1;

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

      if (distM < 2.3 && hs.zoneGoreMode.TORSO_LOWER_ABDOMEN !== 'EVISCERATED') {
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
      impactSpeedMs: Math.max(240, 650 * falloff),
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
        launchLiftVelocityMs: Math.min(1.35, 1.45 * falloff),
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
      shatteredBones: distM < 3.8 ? ['Tibia & Fibula (Blast Fracture)'] : [],
      rupturedOrgans: distM < 3.2 ? ['Pulmonary Blast Overpressure'] : [],
      combatantEffects: ['HE FRAGMENTATION BLAST'],
      headgearKnockedOff: distM < 5.6,
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
      g.glbInstance?.destroy();
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
    this.lastUpdateClockS = totalElapsedTimeS;
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
      g.velocity.mulScalar(Math.max(0.96, 1 - dt * 0.35));

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
        g.angularVelocity.mulScalar(0.65);
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
        g.glbInstance?.destroy();
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

    // 3. Step Decoupled 8 Hz Physiology ECS + Systolic Pulsed Arterial/Venous Blood FX
    this.physiologySystem.update(dt);
    for (const t of this.targets) {
      const physio = this.physiologySystem.getEntity(t.healthState.targetId);
      if (physio) {
        this.syncPhysiologyToHealthState(physio, t.healthState);
      }
    }
    this.vascularFx.update(dt);

    // 4. Step Tactical Hostile AI (cover peeking, burst tracers, trauma-degraded aim, player vitals)
    if (this.tacticalAi) {
      this.tacticalAi.update(
        dt,
        this.targets.map((t) => t.healthState),
        this.getViewerPosVec3()
      );
    }

    // 5. Step 3D Articulated PBD Ragdoll Physics, Sync Combatants & Pose Off-Hand Backup Handguns
    const viewerWorldPos = this.getViewerPosVec3();
    for (const t of this.targets) {
      stepRagdollPhysics(t.healthState, dt, 0.0);
      t.syncFromHealthState(dt, totalElapsedTimeS);
      this.syncOffhandBackupSidearm(t, viewerWorldPos);
    }

    // 6. Project 3D Enemy Health Bars, Triage & Live Physiological Vitals onto HUD Overlay
    if (camera) {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
      const cx = vw * 0.5;
      const cy = vh * 0.5;
      const viewerPos = this.getViewerPosVec3();
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
        const bodyPos = chestNode?.position ?? add(hs.worldPosition, vec3(0, 1.25, 0));
        const yLift = hs.isRagdollActive ? 0.30 : 0.28;

        this.scratchWorldPt.set(anchorPos.x, anchorPos.y + yLift, anchorPos.z);
        camera.worldToScreen(this.scratchWorldPt, this.scratchScreenPt);

        const onScreen =
          this.scratchScreenPt.z > 0 &&
          this.scratchScreenPt.x >= -90 &&
          this.scratchScreenPt.x <= vw + 90 &&
          this.scratchScreenPt.y >= -60 &&
          this.scratchScreenPt.y <= vh + 60;

        const occludedByCover =
          !this.enableXRayInspector &&
          this.isLineOfSightBlocked !== undefined &&
          this.isLineOfSightBlocked(viewerPos, anchorPos) &&
          this.isLineOfSightBlocked(viewerPos, bodyPos);

        const lastHitClock = this.lastHitClockByTarget.get(hs.targetId);
        const recentlyWallbanged =
          lastHitClock !== undefined &&
          totalElapsedTimeS - lastHitClock >= -1e-4 &&
          totalElapsedTimeS - lastHitClock <= 0.8;

        const visible = onScreen && (!occludedByCover || recentlyWallbanged);

        entries.push({
          state: hs,
          screenX: this.scratchScreenPt.x,
          screenY: this.scratchScreenPt.y,
          visible,
        });

        this.scratchWorldPt.set(bodyPos.x, bodyPos.y, bodyPos.z);
        camera.worldToScreen(this.scratchWorldPt, this.scratchBodyScreenPt);
        if (!occludedByCover && this.scratchBodyScreenPt.z > 0) {
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
      const focusedPhysio = focusedState
        ? this.physiologySystem.getEntity(focusedState.targetId) ?? null
        : null;
      hudController.updateTriageOverlays(entries, focusedState, focusedPhysio);
    }
  }

  private setEntityWorldBasis(
    entity: pc.Entity,
    right: Vec3Like,
    up: Vec3Like,
    forward: Vec3Like
  ): void {
    basisVectorsToQuat(
      right,
      up,
      forward,
      this.scratchSidearmMat4,
      this.scratchSidearmQuat
    );
    entity.setLocalRotation(this.scratchSidearmQuat);
  }

  private applyPosedArmBoneToGlbJoint(
    glb: CombatantGlbInstance,
    zone: GhoulZoneId
  ): void {
    const boneNode = glb.boneNodes.get(zone);
    const bind = glb.boneBindPoses.get(zone);
    const rest = REST_ARM_BONE_FRAMES.get(zone);
    if (!boneNode || !bind || !rest) return;

    const boneState = this.targets.find((t) => t.combatantGlb === glb)?.healthState.ragdollBones[zone];
    if (!boneState) return;

    basisVectorsToQuat(
      boneState.basisRight,
      boneState.basisUp,
      boneState.basisForward,
      this.scratchSidearmMat4,
      this.scratchRagQuat
    );

    this.scratchDeltaQuat.mul2(this.scratchRagQuat, rest.restRotInv);
    this.scratchWorldQuat.mul2(this.scratchDeltaQuat, bind.modelRot);

    this.scratchOffsetVec.sub2(bind.modelPos, rest.restPos);
    this.scratchDeltaQuat.transformVector(this.scratchOffsetVec, this.scratchRotOffsetVec);

    boneNode.setPosition(
      boneState.position.x + this.scratchRotOffsetVec.x,
      boneState.position.y + this.scratchRotOffsetVec.y,
      boneState.position.z + this.scratchRotOffsetVec.z
    );
    boneNode.setRotation(this.scratchWorldQuat);
  }

  private buildProceduralBerettaM9Entity(): pc.Entity {
    const pistolRoot = new pc.Entity('ProceduralBerettaM9');

    // Oriented with barrel along -Z, top sights along +Y, ejection port along +X (matches GLB weapon convention!)
    const slide = new pc.Entity('M9_Slide');
    slide.addComponent('render', {
      type: 'box',
      material: this.proceduralM9NitrideMat,
      castShadows: true,
      receiveShadows: true,
    });
    slide.setLocalPosition(0, 0.022, -0.055);
    slide.setLocalScale(0.028, 0.032, 0.195);
    pistolRoot.addChild(slide);

    const barrel = new pc.Entity('M9_Barrel');
    barrel.addComponent('render', {
      type: 'cylinder',
      material: this.proceduralM9NitrideMat,
      castShadows: false,
      receiveShadows: true,
    });
    barrel.setLocalPosition(0, 0.024, -0.145);
    barrel.setLocalEulerAngles(90, 0, 0);
    barrel.setLocalScale(0.013, 0.055, 0.013);
    pistolRoot.addChild(barrel);

    const grip = new pc.Entity('M9_Grip');
    grip.addComponent('render', {
      type: 'box',
      material: this.proceduralM9GripMat,
      castShadows: true,
      receiveShadows: true,
    });
    grip.setLocalPosition(0, -0.036, 0.012);
    grip.setLocalEulerAngles(-14, 0, 0);
    grip.setLocalScale(0.026, 0.098, 0.044);
    pistolRoot.addChild(grip);

    const triggerGuard = new pc.Entity('M9_TriggerGuard');
    triggerGuard.addComponent('render', {
      type: 'box',
      material: this.proceduralM9NitrideMat,
      castShadows: false,
      receiveShadows: false,
    });
    triggerGuard.setLocalPosition(0, -0.008, -0.028);
    triggerGuard.setLocalScale(0.014, 0.024, 0.046);
    pistolRoot.addChild(triggerGuard);

    const frontSight = new pc.Entity('M9_FrontSight');
    frontSight.addComponent('render', {
      type: 'box',
      material: this.proceduralM9GripMat,
      castShadows: false,
      receiveShadows: false,
    });
    frontSight.setLocalPosition(0, 0.041, -0.14);
    frontSight.setLocalScale(0.006, 0.008, 0.012);
    pistolRoot.addChild(frontSight);

    return pistolRoot;
  }

  private ensureOffhandSidearmRig(target: GhoulMannequinEntity): OffhandSidearmRig {
    const id = target.healthState.targetId;
    const existing = this.offhandSidearmRigs.get(id);
    if (existing) {
      return existing;
    }

    const holderEntity = new pc.Entity('OffhandBackupHandgun_M9');
    holderEntity.enabled = false;
    target.rootEntity.addChild(holderEntity);

    let glbInstance: WeaponGlbInstance | null = null;
    let isGlbModel = false;
    const clonedMaterials: pc.StandardMaterial[] = [];

    if (this.glbRegistry) {
      // 1. Primary attempt: instantiate `weapon_beretta_m9` directly if registered in GlbModelRegistry
      try {
        glbInstance = this.glbRegistry.instantiateWeapon(
          'weapon_beretta_m9' as WeaponAssetId,
          {
            castShadows: true,
            receiveShadows: true,
          }
        );
        if (glbInstance.animComponent) {
          glbInstance.animComponent.playing = false;
        }
        holderEntity.addChild(glbInstance.rootEntity);
        isGlbModel = true;
      } catch {
        glbInstance = null;
      }

      // 2. Live GLB pistol fallback: compact dark-nitride M9-proportioned handgun from loaded pistol GLB
      if (!glbInstance && this.glbRegistry.isLoaded('silver_talon_50ae')) {
        try {
          glbInstance = this.glbRegistry.instantiateWeapon('silver_talon_50ae', {
            castShadows: true,
            receiveShadows: true,
          });
          if (glbInstance.animComponent) {
            glbInstance.animComponent.playing = false;
          }
          glbInstance.rootEntity.setLocalScale(0.76, 0.78, 0.76);
          const renders = glbInstance.rootEntity.findComponents('render') as pc.RenderComponent[];
          for (const rc of renders) {
            for (const mi of rc.meshInstances) {
              if (mi.material instanceof pc.StandardMaterial) {
                const darkM9Mat = mi.material.clone();
                darkM9Mat.diffuse = new pc.Color(0.14, 0.15, 0.17);
                darkM9Mat.metalness = Math.min(0.86, darkM9Mat.metalness);
                darkM9Mat.gloss = 0.58;
                darkM9Mat.update();
                mi.material = darkM9Mat;
                clonedMaterials.push(darkM9Mat);
              }
            }
          }
          holderEntity.addChild(glbInstance.rootEntity);
          isGlbModel = true;
        } catch {
          glbInstance = null;
        }
      }
    }

    // 3. Compact dark-metallic procedural Beretta M9 fallback (headless / pre-stream)
    if (!glbInstance) {
      const procM9 = this.buildProceduralBerettaM9Entity();
      holderEntity.addChild(procM9);
    }

    const rig: OffhandSidearmRig = {
      targetId: id,
      holderEntity,
      glbInstance,
      isGlbModel,
      wasHeldLastFrame: false,
      lastHand: null,
      clonedMaterials,
    };
    this.offhandSidearmRigs.set(id, rig);
    return rig;
  }

  /**
   * Synchronizes 3D off-hand Beretta M9 handgun visibility, dynamic single-arm IK aiming pose
   * (`UPPER_ARM_*` -> `FOREARM_*` -> `HAND_*`), and dropped backup pistol physics right after
   * `t.syncFromHealthState(...)`.
   */
  private syncOffhandBackupSidearm(
    target: GhoulMannequinEntity,
    viewerWorldPos: Vec3Like
  ): void {
    const hs = target.healthState;
    const sidearmState = this.tacticalAi?.getSidearmVisualState(hs.targetId);
    const hand: ActiveFiringHand | null = sidearmState?.hand ?? null;
    const armIntact = hand !== null && isArmChainIntactAndFunctional(hs, hand);
    const notAirborneRagdoll = !(hs.isRagdollActive && hs.posture === 'AIRBORNE_RAGDOLL');

    const shouldShowSidearm =
      Boolean(sidearmState?.visible) &&
      hs.alive &&
      hs.currentHp > 0 &&
      armIntact &&
      notAirborneRagdoll;

    const existingRig = this.offhandSidearmRigs.get(hs.targetId);

    if (!shouldShowSidearm) {
      if (existingRig) {
        if (existingRig.wasHeldLastFrame) {
          existingRig.wasHeldLastFrame = false;
          const dropZone: GhoulZoneId =
            existingRig.lastHand === 'LEFT' ? 'HAND_LEFT' : 'HAND_RIGHT';
          const handBone = hs.ragdollBones[dropZone];
          const glbHandNode = target.combatantGlb?.boneNodes.get(dropZone);
          const dropPos = glbHandNode
            ? vec3(
                glbHandNode.getPosition().x,
                glbHandNode.getPosition().y,
                glbHandNode.getPosition().z
              )
            : handBone.position;
          this.fxManager.spawnDroppedWeaponProp(
            'SKINHEAD_PUNK',
            dropPos,
            handBone.velocity
          );
        }
        existingRig.holderEntity.enabled = false;
      }
      return;
    }

    const activeHand = hand!;
    const rig = this.ensureOffhandSidearmRig(target);
    rig.holderEntity.enabled = true;
    rig.wasHeldLastFrame = true;
    rig.lastHand = activeHand;

    const upperArmZone: GhoulZoneId =
      activeHand === 'LEFT' ? 'UPPER_ARM_LEFT' : 'UPPER_ARM_RIGHT';
    const forearmZone: GhoulZoneId =
      activeHand === 'LEFT' ? 'FOREARM_LEFT' : 'FOREARM_RIGHT';
    const handZone: GhoulZoneId =
      activeHand === 'LEFT' ? 'HAND_LEFT' : 'HAND_RIGHT';
    const handTipAuxId = activeHand === 'LEFT' ? 'HAND_TIP_LEFT' : 'HAND_TIP_RIGHT';
    const sideSign = activeHand === 'LEFT' ? -1 : 1;

    // Anchor upper-arm shoulder socket from animated GLB joint when upright, else ragdoll bone
    let pUpper = copyVec3(hs.ragdollBones[upperArmZone].position);
    if (target.combatantGlb && !hs.isRagdollActive) {
      const glbUpper = target.combatantGlb.boneNodes.get(upperArmZone);
      const bindUpper = target.combatantGlb.boneBindPoses.get(upperArmZone);
      const restUpper = REST_ARM_BONE_FRAMES.get(upperArmZone);
      if (glbUpper && bindUpper && restUpper) {
        const pAnim = glbUpper.getPosition();
        const qAnim = glbUpper.getRotation();
        const bindInv = bindUpper.modelRot.clone().invert();
        this.scratchDeltaQuat.mul2(qAnim, bindInv);
        this.scratchOffsetVec.sub2(bindUpper.modelPos, restUpper.restPos);
        this.scratchDeltaQuat.transformVector(
          this.scratchOffsetVec,
          this.scratchRotOffsetVec
        );
        pUpper = vec3(
          pAnim.x - this.scratchRotOffsetVec.x,
          pAnim.y - this.scratchRotOffsetVec.y,
          pAnim.z - this.scratchRotOffsetVec.z
        );
      }
    }

    const charFwd = vec3(Math.sin(hs.yawRad), 0, Math.cos(hs.yawRad));
    const charRight = vec3(-Math.cos(hs.yawRad), 0, Math.sin(hs.yawRad));

    const aimTarget = sidearmState?.aimTargetWorld ?? vec3(
      viewerWorldPos.x,
      viewerWorldPos.y - 0.16,
      viewerWorldPos.z
    );
    let rawAimDir = normalize(sub(aimTarget, pUpper));
    if (length(rawAimDir) < 1e-4) {
      rawAimDir = charFwd;
    }

    // Clamp pitch & horizontal twist relative to torso so the off-hand arm poses naturally without hyperextension
    const clampedY = Math.max(-0.52, Math.min(0.52, rawAimDir.y));
    let horizDir = vec3(rawAimDir.x, 0, rawAimDir.z);
    if (length(horizDir) < 1e-4) {
      horizDir = charFwd;
    } else {
      horizDir = normalize(horizDir);
      if (dot(horizDir, charFwd) < 0.25) {
        horizDir = normalize(add(scale(charFwd, 0.72), scale(horizDir, 0.28)));
      }
    }
    const aimDir = normalize(
      vec3(horizDir.x * Math.sqrt(1 - clampedY * clampedY), clampedY, horizDir.z * Math.sqrt(1 - clampedY * clampedY))
    );

    const drawProgress = Math.max(0, Math.min(1, sidearmState?.drawProgress ?? 1.0));
    const smoothDraw = drawProgress * drawProgress * (3 - 2 * drawProgress);
    const holsterDir = normalize(
      add(scale(charFwd, 0.26), vec3(charRight.x * sideSign * 0.22, -0.86, charRight.z * sideSign * 0.22))
    );
    const armAimDir = normalize(
      add(scale(holsterDir, 1 - smoothDraw), scale(aimDir, smoothDraw))
    );

    const upperLenM = 0.26;
    const forearmLenM = 0.25;
    const elbowDir = normalize(
      add(
        armAimDir,
        vec3(charRight.x * sideSign * 0.12, -0.14, charRight.z * sideSign * 0.12)
      )
    );
    const pForearm = add(pUpper, scale(elbowDir, upperLenM));
    const wristGoal = add(pUpper, scale(armAimDir, upperLenM + forearmLenM - 0.015));
    const forearmDir = normalize(sub(wristGoal, pForearm));
    const pHand = add(pForearm, scale(forearmDir, forearmLenM));

    const worldUp = vec3(0, 1, 0);
    const computeSegmentBasis = (segFwd: Vec3Like) => {
      let r = cross(worldUp, segFwd);
      if (length(r) < 1e-4) r = vec3(1, 0, 0);
      r = normalize(r);
      const u = normalize(cross(segFwd, r));
      return { right: r, up: u, forward: segFwd };
    };

    const upperBasis = computeSegmentBasis(elbowDir);
    const forearmBasis = computeSegmentBasis(forearmDir);
    const handBasis = computeSegmentBasis(armAimDir);

    const applyBoneState = (
      zone: GhoulZoneId,
      pos: Vec3Like,
      basis: { right: Vec3Like; up: Vec3Like; forward: Vec3Like }
    ) => {
      const b = hs.ragdollBones[zone];
      b.position = copyVec3(pos);
      b.prevPosition = copyVec3(pos);
      b.basisRight = basis.right;
      b.basisUp = basis.up;
      b.basisForward = basis.forward;
    };

    applyBoneState(upperArmZone, pUpper, upperBasis);
    applyBoneState(forearmZone, pForearm, forearmBasis);
    applyBoneState(handZone, pHand, handBasis);

    const tipAux = hs.auxParticles[handTipAuxId];
    if (tipAux && tipAux.componentId === 'BODY') {
      tipAux.position = add(pHand, scale(armAimDir, 0.09));
      tipAux.prevPosition = copyVec3(tipAux.position);
    }

    // Pose 3D skeletal arm nodes (`combatantGlb` or custom `Bone_*` hierarchy + `Zone_*` bundles)
    if (target.combatantGlb) {
      this.applyPosedArmBoneToGlbJoint(target.combatantGlb, upperArmZone);
      this.applyPosedArmBoneToGlbJoint(target.combatantGlb, forearmZone);
      this.applyPosedArmBoneToGlbJoint(target.combatantGlb, handZone);
      target.combatantGlb.rootEntity.syncHierarchy();
    } else {
      for (const z of [upperArmZone, forearmZone, handZone] as const) {
        const customBone = target.rootEntity.findByName(`Bone_${z}`);
        if (customBone instanceof pc.Entity) {
          const b = hs.ragdollBones[z];
          customBone.setPosition(b.position.x, b.position.y, b.position.z);
          basisVectorsToQuat(
            b.basisRight,
            b.basisUp,
            b.basisForward,
            this.scratchSidearmMat4,
            this.scratchSidearmQuat
          );
          customBone.setRotation(this.scratchSidearmQuat);
        }
      }
    }

    for (const z of [upperArmZone, forearmZone, handZone] as const) {
      const zoneNode = target.rootEntity.findByName(`Zone_${z}`);
      if (zoneNode instanceof pc.Entity) {
        const b = hs.ragdollBones[z];
        zoneNode.setLocalPosition(b.position.x, b.position.y, b.position.z);
        this.setEntityWorldBasis(zoneNode, b.basisRight, b.basisUp, b.basisForward);
      }
    }

    // Mount Beretta M9 in the posed off-hand (`-Z` barrel forward along `armAimDir`!)
    let gripPos = pHand;
    if (target.combatantGlb) {
      const glbHand = target.combatantGlb.boneNodes.get(handZone);
      if (glbHand) {
        const gp = glbHand.getPosition();
        gripPos = vec3(gp.x, gp.y, gp.z);
      }
    }

    const zBack = scale(armAimDir, -1);
    let xRight = cross(worldUp, zBack);
    if (length(xRight) < 1e-4) xRight = vec3(1, 0, 0);
    xRight = normalize(xRight);
    const yUp = normalize(cross(zBack, xRight));

    rig.holderEntity.setLocalPosition(
      gripPos.x + armAimDir.x * 0.042,
      gripPos.y + 0.012,
      gripPos.z + armAimDir.z * 0.042
    );
    this.setEntityWorldBasis(rig.holderEntity, xRight, yUp, zBack);
  }

  private destroySingleSidearmRig(rig: OffhandSidearmRig): void {
    if (rig.glbInstance) {
      rig.glbInstance.destroy();
      rig.glbInstance = null;
    }
    for (const m of rig.clonedMaterials) {
      m.destroy();
    }
    rig.clonedMaterials.length = 0;
    rig.holderEntity.destroy();
  }

  private destroyOffhandSidearmRigs(): void {
    for (const rig of this.offhandSidearmRigs.values()) {
      this.destroySingleSidearmRig(rig);
    }
    this.offhandSidearmRigs.clear();
  }

  public destroy(): void {
    this.clearLiveGrenadesAndFlashes();
    this.destroyOffhandSidearmRigs();
    this.lastHitClockByTarget.clear();
    for (const t of this.targets) {
      t.destroy();
    }
    this.targets.length = 0;
    this.physiologySystem.reset();
    this.vascularFx.destroy();
    this.blastFireballMat.destroy();
    this.proceduralM9NitrideMat.destroy();
    this.proceduralM9GripMat.destroy();
  }
}
