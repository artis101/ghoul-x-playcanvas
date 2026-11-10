import * as pc from 'playcanvas';
import type {
  CombatantPostureState,
  EnemyArchetypeId,
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../../contracts/ballistics.ts';
import {
  add,
  copyVec3,
  cross,
  deterministicConeSpread,
  distance,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from '../../core/ballistics/vec3.ts';
import {
  CombatantTriageStatus,
  computeCombatantTriageStatus,
} from '../../core/ballistics/solver.ts';
import { updateStandingCombatPose } from '../../core/ghoul/anatomy.ts';
import { DESTRUCTION_ZONE_LAYOUT } from '../world/arenaBuilder.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { basisColumnsToQuaternion } from '../fx/mayhemDirector.ts';

// ============================================================================
// Contracts & Tactical Cover Layout
// ============================================================================

export type EnemyTacticalAiState =
  | 'PATROL_GUARD'
  | 'ALERTED_ENGAGING'
  | 'SUPPRESSED_STAGGERED'
  | 'DOWNED_CRAWLING'
  | 'DEAD';

export type BrutalKillRewardKind =
  | 'CRANIAL_POP'
  | 'CLEAN_SEVER'
  | 'EVISCERATED'
  | 'MULTI_KILL_BLAST'
  | 'STANDARD_KILL';

export interface TacticalCoverStation {
  readonly stationId: string;
  readonly coverAnchorWorld: Vec3Like;
  readonly peekSign: -1 | 1;
  readonly peekStrideM: number;
  readonly guardYawDeg: number;
}

/**
 * Tactical hostile cover stations positioned directly behind Wave-2 destructible cover
 * (wood shoot-house wall, marching/Voronoi glass windows, instanced brick wall, Voronoi concrete barrier)
 * and flanking red hazard barrels.
 */
export const TACTICAL_COVER_STATIONS: readonly TacticalCoverStation[] = [
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.woodShootHouseWall.id,
    coverAnchorWorld: { x: -1.65, y: 0, z: -8.35 },
    peekSign: 1,
    peekStrideM: 0.95,
    guardYawDeg: 6,
  },
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.instancedBrickWall.id,
    coverAnchorWorld: { x: -2.95, y: 0, z: -13.75 },
    peekSign: 1,
    peekStrideM: 1.05,
    guardYawDeg: 10,
  },
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.voronoiConcreteWall.id,
    coverAnchorWorld: { x: 1.45, y: 0, z: -14.85 },
    peekSign: -1,
    peekStrideM: 1.1,
    guardYawDeg: -8,
  },
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.glassVoronoiWindow.id,
    coverAnchorWorld: { x: 4.85, y: 0, z: -8.1 },
    peekSign: -1,
    peekStrideM: 0.85,
    guardYawDeg: -14,
  },
];

export interface EnemyTracerFireEvent {
  readonly targetId: string;
  readonly archetype: EnemyArchetypeId;
  readonly muzzleOriginWorld: Vec3Like;
  readonly shotDirectionWorld: Vec3Like;
  readonly impactPointWorld: Vec3Like;
  readonly tracerSpeedMs: number;
  readonly spreadConeRad: number;
  readonly spreadMultiplier: number;
  readonly hitPlayer: boolean;
  readonly blockedByCover: boolean;
  readonly armorChipApplied: number;
  readonly healthDamageApplied: number;
}

export interface PlayerCombatVitals {
  health: number;
  maxHealth: number;
  armor: number;
  maxArmor: number;
  damageEnabled: boolean;
  timeSinceLastHitS: number;
  invulnerabilityRemainingS: number;
}

export interface EnemyAimProfile {
  readonly baseSpreadRad: number;
  readonly spreadMultiplier: number;
  readonly effectiveSpreadRad: number;
  readonly aimAccuracyMultiplier: number;
  readonly canReturnFire: boolean;
  readonly isOneHandedDownedFire: boolean;
  readonly clutchingWound: boolean;
}

export interface EnemyAiAgentRuntime {
  readonly targetId: string;
  state: EnemyTacticalAiState;
  triageStatus: CombatantTriageStatus;
  coverAnchorWorld: Vec3Like;
  peekSign: -1 | 1;
  peekStrideM: number;
  guardBaseYawRad: number;

  adrenaline: number;
  suppression: number;
  neurogenicShockTimerS: number;
  staggerTimerS: number;

  peekCycleTimerS: number;
  isPeekingOut: boolean;
  currentLateralOffsetM: number;

  burstShotsRemaining: number;
  burstInterShotTimerS: number;
  fireCooldownTimerS: number;
  tracerSeedCounter: number;

  lastObservedHp: number;
  lastSpreadMultiplier: number;
  lastAimAccuracyMultiplier: number;
  clutchingWound: boolean;
}

export interface EnemyHitNotification {
  hitZone?: GhoulZoneId;
  energyDepositedJ?: number;
  isTorsoHit?: boolean;
  externalAccuracyMultiplier?: number;
}

export interface TacticalCombatAiOptions {
  app?: pc.Application | null;
  rapierWorld?: RapierPhysicsWorld | null;
  playerDamageEnabled?: boolean;
  initialPlayerHealth?: number;
  initialPlayerArmor?: number;
  /** Sight detection range in meters when player is in front hemisphere (default 30m) */
  sightDetectionRangeM?: number;
  onEnemyFireTracer?: (event: EnemyTracerFireEvent) => void;
  onPlayerDamaged?: (vitals: Readonly<PlayerCombatVitals>, event: EnemyTracerFireEvent) => void;
  onEnemyStateChanged?: (
    targetId: string,
    prevState: EnemyTacticalAiState,
    nextState: EnemyTacticalAiState,
  ) => void;
}

interface ArchetypeCombatTuning {
  readonly baseSpreadRad: number;
  readonly burstCount: number;
  readonly interShotDelayS: number;
  readonly burstCooldownS: number;
  readonly strafeSpeedMs: number;
  readonly tracerSpeedMs: number;
  readonly baseChipDamage: number;
}

const ARCHETYPE_TUNING: Record<EnemyArchetypeId, ArchetypeCombatTuning> = {
  SKINHEAD_PUNK: {
    baseSpreadRad: 0.052,
    burstCount: 4,
    interShotDelayS: 0.11,
    burstCooldownS: 1.55,
    strafeSpeedMs: 2.15,
    tracerSpeedMs: 78,
    baseChipDamage: 4.0,
  },
  MILITIA_GUNNER: {
    baseSpreadRad: 0.038,
    burstCount: 3,
    interShotDelayS: 0.14,
    burstCooldownS: 1.75,
    strafeSpeedMs: 1.85,
    tracerSpeedMs: 92,
    baseChipDamage: 5.0,
  },
  HEAVY_ENFORCER: {
    baseSpreadRad: 0.062,
    burstCount: 2,
    interShotDelayS: 0.34,
    burstCooldownS: 2.05,
    strafeSpeedMs: 1.35,
    tracerSpeedMs: 72,
    baseChipDamage: 6.5,
  },
  SNIPER_OPERATIVE: {
    baseSpreadRad: 0.018,
    burstCount: 1,
    interShotDelayS: 0.25,
    burstCooldownS: 2.65,
    strafeSpeedMs: 1.5,
    tracerSpeedMs: 125,
    baseChipDamage: 8.0,
  },
};

const TORSO_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'TORSO_UPPER_THORAX',
  'TORSO_LOWER_ABDOMEN',
  'PELVIS_GROIN',
]);

export const DOWNED_ONE_HANDED_SPREAD_MULTIPLIER = 4.5;

function wrapAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function approachAngleRad(current: number, target: number, maxStep: number): number {
  const diff = wrapAngleRad(target - current);
  if (Math.abs(diff) <= maxStep) {
    return wrapAngleRad(target);
  }
  return wrapAngleRad(current + Math.sign(diff) * maxStep);
}

// ============================================================================
// TacticalCombatAiSystem
// ============================================================================

/**
 * Turns static GHOUL mannequins into reactive FPS hostiles that guard, alert with adrenaline surge,
 * strafe/peek around destructible cover, fire glowing tracer bursts with fair arcade armor/HP chip,
 * and exhibit authentic physiological/limb trauma degradation (`PATROL_GUARD` neurogenic shock,
 * `DOWNED_CRAWLING` `4.5x` one-handed spread, and helpless wound-clutching when disarmed or mortally wounded).
 */
export class TacticalCombatAiSystem {
  public readonly playerVitals: PlayerCombatVitals;

  public onEnemyFireTracer?: (event: EnemyTracerFireEvent) => void;
  public onPlayerDamaged?: (
    vitals: Readonly<PlayerCombatVitals>,
    event: EnemyTracerFireEvent,
  ) => void;
  public onEnemyStateChanged?: (
    targetId: string,
    prevState: EnemyTacticalAiState,
    nextState: EnemyTacticalAiState,
  ) => void;

  private readonly app: pc.Application | null;
  private readonly rapierWorld: RapierPhysicsWorld | null;
  private readonly sightDetectionRangeM: number;
  private readonly tracerPool: HardwareInstancedPool | null;

  private readonly agents = new Map<string, EnemyAiAgentRuntime>();
  private elapsedClockS = 0;
  private destroyed = false;

  public constructor(options: TacticalCombatAiOptions = {}) {
    this.app = options.app ?? null;
    this.rapierWorld = options.rapierWorld ?? null;
    this.sightDetectionRangeM = Math.max(5, options.sightDetectionRangeM ?? 30.0);
    this.onEnemyFireTracer = options.onEnemyFireTracer;
    this.onPlayerDamaged = options.onPlayerDamaged;
    this.onEnemyStateChanged = options.onEnemyStateChanged;

    const maxHealth = 100;
    const maxArmor = 100;
    this.playerVitals = {
      health: Math.max(1, Math.min(maxHealth, options.initialPlayerHealth ?? 100)),
      maxHealth,
      armor: Math.max(0, Math.min(maxArmor, options.initialPlayerArmor ?? 50)),
      maxArmor,
      damageEnabled: options.playerDamageEnabled ?? true,
      timeSinceLastHitS: 10,
      invulnerabilityRemainingS: 0,
    };

    if (this.app) {
      const dev = this.app.graphicsDevice;
      const boltMesh = pc.Mesh.fromGeometry(dev, new pc.BoxGeometry());
      const tracerMat = new pc.StandardMaterial();
      tracerMat.name = 'enemyGlowingTracerMat';
      tracerMat.diffuse = new pc.Color(1.0, 0.36, 0.08);
      tracerMat.emissive = new pc.Color(1.0, 0.42, 0.1);
      tracerMat.blendType = pc.BLEND_ADDITIVEALPHA;
      tracerMat.opacity = 0.92;
      tracerMat.depthWrite = false;
      tracerMat.cull = pc.CULLFACE_NONE;
      tracerMat.update();

      this.tracerPool = new HardwareInstancedPool(
        this.app,
        boltMesh,
        tracerMat,
        128,
        'EnemyTracerBoltPool',
        false,
      );
    } else {
      this.tracerPool = null;
    }
  }

  public setPlayerDamageEnabled(enabled: boolean): void {
    this.playerVitals.damageEnabled = enabled;
  }

  /**
   * Registers a wave of `TargetHealthState` combatants and optionally repositions them
   * behind tactical destructible cover stations.
   */
  public registerWaveTargets(
    targets: readonly TargetHealthState[],
    deployToCoverStations = false,
  ): void {
    this.agents.clear();

    for (let i = 0; i < targets.length; i++) {
      const hs = targets[i];
      const coverSpec = TACTICAL_COVER_STATIONS[i % TACTICAL_COVER_STATIONS.length];

      if (deployToCoverStations && coverSpec) {
        hs.worldPosition = copyVec3(coverSpec.coverAnchorWorld);
        hs.yawRad = (coverSpec.guardYawDeg * Math.PI) / 180;
        updateStandingCombatPose(hs, this.elapsedClockS);
      }

      const anchor = copyVec3(hs.worldPosition);
      const peekSign: -1 | 1 =
        coverSpec && deployToCoverStations
          ? coverSpec.peekSign
          : hs.worldPosition.x < 0
            ? 1
            : -1;

      const agent: EnemyAiAgentRuntime = {
        targetId: hs.targetId,
        state: hs.alive ? 'PATROL_GUARD' : 'DEAD',
        triageStatus: computeCombatantTriageStatus(hs),
        coverAnchorWorld: anchor,
        peekSign,
        peekStrideM: coverSpec?.peekStrideM ?? 0.95,
        guardBaseYawRad: hs.yawRad,

        adrenaline: 0.05,
        suppression: 0,
        neurogenicShockTimerS: 0,
        staggerTimerS: 0,

        peekCycleTimerS: (i * 0.73) % 2.4,
        isPeekingOut: false,
        currentLateralOffsetM: 0,

        burstShotsRemaining: 0,
        burstInterShotTimerS: 0,
        fireCooldownTimerS: 0.65 + (i % 4) * 0.35,
        tracerSeedCounter: 100 + i * 37,

        lastObservedHp: hs.currentHp,
        lastSpreadMultiplier: 1.0,
        lastAimAccuracyMultiplier: 1.0,
        clutchingWound: false,
      };

      this.agents.set(hs.targetId, agent);
    }
  }

  public getAgent(targetId: string): EnemyAiAgentRuntime | undefined {
    return this.agents.get(targetId);
  }

  /**
   * Alerts nearby `PATROL_GUARD` hostiles when the player fires unsuppressed shots or detonates explosives,
   * triggering their combat adrenaline surge (`adrenaline -> 0.88`).
   */
  public notifyGunshotOrExplosion(
    soundOriginWorld: Vec3Like,
    audibleRadiusM = 38.0,
    suppressionImpulse = 0.22,
  ): void {
    for (const agent of this.agents.values()) {
      if (agent.state === 'DEAD') continue;

      const distM = distance(soundOriginWorld, agent.coverAnchorWorld);
      if (distM > audibleRadiusM) continue;

      const proximity = Math.max(0, 1 - distM / audibleRadiusM);
      agent.suppression = Math.min(1.0, agent.suppression + suppressionImpulse * proximity);

      if (agent.state === 'PATROL_GUARD') {
        agent.adrenaline = Math.max(agent.adrenaline, 0.88);
        this.transitionState(agent, 'ALERTED_ENGAGING');
      } else if (agent.state === 'ALERTED_ENGAGING') {
        agent.adrenaline = Math.min(1.0, agent.adrenaline + 0.14);
        if (agent.suppression >= 0.88 && agent.adrenaline < 0.75) {
          agent.staggerTimerS = Math.max(agent.staggerTimerS, 0.65);
          this.transitionState(agent, 'SUPPRESSED_STAGGERED');
        }
      }
    }
  }

  /**
   * Processes direct ballistic/blast trauma on a specific combatant:
   * - Unsuspecting (`PATROL_GUARD`, low adrenaline) targets struck in the torso suffer immediate
   *   **neurogenic shock stagger** (`SUPPRESSED_STAGGERED`, high `painShock`, dropped `consciousness`).
   * - Already alerted (`ALERTED_ENGAGING`) targets experience an **adrenaline surge** that resists
   *   pure pain knockdown unless biomechanically crippled (`!leftLegFunctional || !rightLegFunctional`)
   *   or mortally wounded!
   */
  public notifyEnemyHit(
    target: TargetHealthState,
    hit: EnemyHitNotification = {},
  ): EnemyTacticalAiState {
    let agent = this.agents.get(target.targetId);
    if (!agent) {
      this.registerWaveTargets([target], false);
      agent = this.agents.get(target.targetId)!;
    }

    agent.lastObservedHp = target.currentHp;
    agent.triageStatus = computeCombatantTriageStatus(target);

    if (!target.alive || target.currentHp <= 0) {
      this.transitionState(agent, 'DEAD');
      return agent.state;
    }

    const hitTorso =
      hit.isTorsoHit === true ||
      (hit.hitZone !== undefined && TORSO_ZONES.has(hit.hitZone));
    const wasUnsuspecting = agent.state === 'PATROL_GUARD' && agent.adrenaline < 0.35;

    // Leg destruction overrides standing posture immediately -> DOWNED_CRAWLING
    if (!target.leftLegFunctional || !target.rightLegFunctional) {
      agent.adrenaline = Math.max(agent.adrenaline, 0.75);
      if (!target.isRagdollActive) {
        target.posture = 'LEG_BUCKLED';
      }
      this.transitionState(agent, 'DOWNED_CRAWLING');
      this.refreshAgentAimMetrics(target, agent, hit.externalAccuracyMultiplier);
      return agent.state;
    }

    if (wasUnsuspecting && hitTorso) {
      // Stage-4 Neurogenic / Vagal Shock Stagger on unsuspecting guard!
      agent.neurogenicShockTimerS = 1.65;
      agent.staggerTimerS = 1.65;
      agent.burstShotsRemaining = 0;
      target.painShock = Math.max(target.painShock, 0.85);
      target.consciousness = Math.min(target.consciousness, 0.42);
      if (!target.isRagdollActive) {
        target.posture =
          hit.hitZone === 'TORSO_LOWER_ABDOMEN' ? 'GUT_HURT' : 'STAGGERED';
      }
      this.transitionState(agent, 'SUPPRESSED_STAGGERED');
    } else {
      // Alerted target gains combat adrenaline surge!
      agent.adrenaline = Math.min(1.0, Math.max(0.88, agent.adrenaline + 0.22));
      agent.suppression = Math.min(1.0, agent.suppression + 0.32);

      const heavyEnergy = (hit.energyDepositedJ ?? 0) >= 850;
      if (
        heavyEnergy ||
        target.painShock - agent.adrenaline * 0.65 > 0.32 ||
        agent.triageStatus === 'MORTALLY_WOUNDED'
      ) {
        agent.staggerTimerS = Math.max(agent.staggerTimerS, 0.55);
        agent.burstShotsRemaining = 0;
        if (!target.isRagdollActive && target.posture === 'COMBAT_READY') {
          target.posture = 'STAGGERED';
        }
        this.transitionState(agent, 'SUPPRESSED_STAGGERED');
      } else if (agent.state === 'PATROL_GUARD') {
        this.transitionState(agent, 'ALERTED_ENGAGING');
      }
    }

    // Alert nearby squadmates within 18m when an ally is shot
    for (const mate of this.agents.values()) {
      if (mate.targetId === target.targetId || mate.state !== 'PATROL_GUARD') {
        continue;
      }
      if (distance(mate.coverAnchorWorld, target.worldPosition) <= 18.0) {
        mate.adrenaline = Math.max(mate.adrenaline, 0.85);
        this.transitionState(mate, 'ALERTED_ENGAGING');
      }
    }

    this.refreshAgentAimMetrics(target, agent, hit.externalAccuracyMultiplier);
    return agent.state;
  }

  /**
   * Computes exact trauma-aware weapon accuracy & fire eligibility from `TargetHealthState`.
   */
  public computeEnemyAimProfile(
    target: TargetHealthState,
    agent?: EnemyAiAgentRuntime,
    externalAccuracyMultiplier?: number,
  ): EnemyAimProfile {
    const tuning = ARCHETYPE_TUNING[target.archetype];
    const triage = computeCombatantTriageStatus(target);

    if (!target.alive || target.currentHp <= 0) {
      return {
        baseSpreadRad: tuning.baseSpreadRad,
        spreadMultiplier: 10.0,
        effectiveSpreadRad: tuning.baseSpreadRad * 10.0,
        aimAccuracyMultiplier: 0,
        canReturnFire: false,
        isOneHandedDownedFire: false,
        clutchingWound: false,
      };
    }

    const bothArmsBroken = !target.leftArmFunctional && !target.rightArmFunctional;
    const isMortallyWounded = triage === 'MORTALLY_WOUNDED';
    const severeHypoxiaOrHypotension =
      target.systolicBpMmHg < 72 ||
      target.oxygenSaturationPct < 74 ||
      target.consciousness < 0.32;

    // Disarmed or mortally wounded enemies clutch wounds / stagger helplessly instead of laser-aiming
    if (target.weaponDropped || bothArmsBroken || isMortallyWounded || severeHypoxiaOrHypotension) {
      return {
        baseSpreadRad: tuning.baseSpreadRad,
        spreadMultiplier: 8.5,
        effectiveSpreadRad: tuning.baseSpreadRad * 8.5,
        aimAccuracyMultiplier: 0.08,
        canReturnFire: false,
        isOneHandedDownedFire: false,
        clutchingWound: true,
      };
    }

    const inNeurogenicOrStagger =
      agent !== undefined &&
      (agent.neurogenicShockTimerS > 0 || agent.state === 'SUPPRESSED_STAGGERED');

    const legCrippled = !target.leftLegFunctional || !target.rightLegFunctional;
    let spreadMultiplier = 1.0;

    // Leg-crippled downed enemies fire one-handed with heavy 4.5x spread cone!
    if (legCrippled || agent?.state === 'DOWNED_CRAWLING') {
      spreadMultiplier *= DOWNED_ONE_HANDED_SPREAD_MULTIPLIER;
    }

    // Single crippled arm degrades stability
    if (!target.leftArmFunctional || !target.rightArmFunctional) {
      spreadMultiplier *= 1.85;
    }

    // Pain shock (buffered partially by combat adrenaline on alerted fighters)
    const adrenalineMitigation = agent ? agent.adrenaline * 0.35 : 0;
    const effectiveShock = Math.max(0, target.painShock - adrenalineMitigation);
    spreadMultiplier *= 1.0 + effectiveShock * 2.4;

    // Blood pressure & oxygenation degradation
    if (target.systolicBpMmHg < 105) {
      spreadMultiplier *= 1.0 + ((105 - target.systolicBpMmHg) / 45) * 1.8;
    }
    if (target.oxygenSaturationPct < 94) {
      spreadMultiplier *= 1.0 + ((94 - target.oxygenSaturationPct) / 25) * 2.0;
    }
    if (target.consciousness < 0.9) {
      spreadMultiplier *= 1.0 + (0.9 - target.consciousness) * 2.6;
    }

    if (externalAccuracyMultiplier !== undefined && externalAccuracyMultiplier > 0) {
      spreadMultiplier *= 1 / Math.max(0.08, Math.min(1.0, externalAccuracyMultiplier));
    }

    const aimAccuracyMultiplier = Math.max(0.08, Math.min(1.0, 1.0 / spreadMultiplier));

    return {
      baseSpreadRad: tuning.baseSpreadRad,
      spreadMultiplier,
      effectiveSpreadRad: tuning.baseSpreadRad * spreadMultiplier,
      aimAccuracyMultiplier,
      canReturnFire: !inNeurogenicOrStagger && agent?.state !== 'PATROL_GUARD',
      isOneHandedDownedFire: legCrippled,
      clutchingWound: false,
    };
  }

  /**
   * Rewards aggressive Soldier-of-Fortune / F.E.A.R. playstyles with armor & HP siphon on brutal kills.
   */
  public grantBrutalKillReward(kind: BrutalKillRewardKind): void {
    const armorGain =
      kind === 'MULTI_KILL_BLAST'
        ? 22
        : kind === 'CRANIAL_POP'
          ? 16
          : kind === 'CLEAN_SEVER' || kind === 'EVISCERATED'
            ? 14
            : 6;
    const hpGain =
      kind === 'MULTI_KILL_BLAST'
        ? 18
        : kind === 'CRANIAL_POP'
          ? 12
          : kind === 'CLEAN_SEVER' || kind === 'EVISCERATED'
            ? 10
            : 4;

    this.playerVitals.armor = Math.min(
      this.playerVitals.maxArmor,
      this.playerVitals.armor + armorGain,
    );
    this.playerVitals.health = Math.min(
      this.playerVitals.maxHealth,
      this.playerVitals.health + hpGain,
    );
  }

  /**
   * Restores player health and boosts armor on clearing a hostile wave.
   */
  public notifyWaveCleared(): void {
    this.playerVitals.health = this.playerVitals.maxHealth;
    this.playerVitals.armor = Math.min(
      this.playerVitals.maxArmor,
      this.playerVitals.armor + 35,
    );
    this.playerVitals.invulnerabilityRemainingS = 0;
  }

  /**
   * Steps all hostile AI state machines, tactical cover peeking/strafing, yaw tracking,
   * enemy burst tracer fire, and player combat vitals regeneration.
   */
  public update(
    dt: number,
    targets: readonly TargetHealthState[],
    playerEyeWorldPos: Vec3Like,
  ): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }

    const stepDt = Math.min(0.1, dt);
    this.elapsedClockS += stepDt;

    this.stepPlayerVitalsRegen(stepDt);

    for (const hs of targets) {
      let agent = this.agents.get(hs.targetId);
      if (!agent) {
        this.registerWaveTargets([hs], false);
        agent = this.agents.get(hs.targetId)!;
      }

      this.stepSingleEnemyAgent(stepDt, hs, agent, playerEyeWorldPos);
    }

    if (this.tracerPool) {
      this.tracerPool.syncFromPhysics(this.rapierWorld, stepDt);
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.agents.clear();
    if (this.tracerPool) {
      this.tracerPool.destroy();
    }
  }

  private stepPlayerVitalsRegen(dt: number): void {
    if (this.playerVitals.invulnerabilityRemainingS > 0) {
      this.playerVitals.invulnerabilityRemainingS = Math.max(
        0,
        this.playerVitals.invulnerabilityRemainingS - dt,
      );
    }
    this.playerVitals.timeSinceLastHitS += dt;

    // Fair FPS breathing recovery after 3.5s out of enemy fire
    if (
      this.playerVitals.timeSinceLastHitS >= 3.5 &&
      this.playerVitals.health < this.playerVitals.maxHealth
    ) {
      this.playerVitals.health = Math.min(
        this.playerVitals.maxHealth,
        this.playerVitals.health + 8.5 * dt,
      );
    }
  }

  private stepSingleEnemyAgent(
    dt: number,
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    playerEyeWorldPos: Vec3Like,
  ): void {
    agent.triageStatus = computeCombatantTriageStatus(hs);

    // 1. Check death / exsanguination first
    if (!hs.alive || hs.currentHp <= 0) {
      agent.burstShotsRemaining = 0;
      this.transitionState(agent, 'DEAD');
      return;
    }

    // Auto-detect unnotified HP drops (e.g. collateral round or shrapnel applied directly to TargetHealthState)
    if (hs.currentHp < agent.lastObservedHp - 0.5) {
      const lostHp = agent.lastObservedHp - hs.currentHp;
      this.notifyEnemyHit(hs, {
        isTorsoHit:
          hs.zoneIntegrity.TORSO_UPPER_THORAX < 99 ||
          hs.zoneIntegrity.TORSO_LOWER_ABDOMEN < 99,
        energyDepositedJ: lostHp * 14,
      });
      if (!hs.alive) {
        return;
      }
    }
    agent.lastObservedHp = hs.currentHp;

    // Decay suppression & adrenaline slowly over combat duration
    agent.suppression = Math.max(0, agent.suppression - 0.24 * dt);
    if (agent.state !== 'PATROL_GUARD') {
      agent.adrenaline = Math.max(0.35, agent.adrenaline - 0.015 * dt);
    }

    // 2. Enforce leg-crippled collapse -> DOWNED_CRAWLING
    const legCrippled = !hs.leftLegFunctional || !hs.rightLegFunctional;
    if (legCrippled && agent.state !== 'DOWNED_CRAWLING') {
      if (!hs.isRagdollActive) {
        hs.posture = 'LEG_BUCKLED';
      }
      this.transitionState(agent, 'DOWNED_CRAWLING');
    }

    // 3. Evaluate aim & trauma state
    const aimProfile = this.refreshAgentAimMetrics(hs, agent);

    // Apply helpless wound-clutching posture if disarmed or mortally wounded
    if (aimProfile.clutchingWound && !hs.isRagdollActive) {
      if (hs.weaponDropped) {
        hs.posture = 'DISARMED';
      } else if (hs.rupturedOrgans.size > 0 || hs.zoneIntegrity.TORSO_LOWER_ABDOMEN < 65) {
        hs.posture = 'GUT_HURT';
      } else if (hs.zoneIntegrity.NECK_CERVICAL < 80) {
        hs.posture = 'THROAT_CLUTCH';
      } else {
        hs.posture = legCrippled ? 'LEG_BUCKLED' : 'STAGGERED';
      }
    }

    const toPlayer = sub(playerEyeWorldPos, hs.worldPosition);
    const horizDist = Math.hypot(toPlayer.x, toPlayer.z);
    const desiredYawRad =
      horizDist > 1e-3 ? Math.atan2(toPlayer.x, toPlayer.z) : hs.yawRad;

    // 4. State-specific movement, posture & combat logic
    switch (agent.state) {
      case 'PATROL_GUARD': {
        // Subtle sentry scan around guardBaseYawRad
        agent.peekCycleTimerS += dt;
        const scanOffset = Math.sin(agent.peekCycleTimerS * 0.9) * 0.22;
        hs.yawRad = approachAngleRad(
          hs.yawRad,
          agent.guardBaseYawRad + scanOffset,
          1.4 * dt,
        );

        // Sight cone & close proximity detection
        const guardFwd = { x: Math.sin(hs.yawRad), y: 0, z: Math.cos(hs.yawRad) };
        const dirToPlayer =
          horizDist > 1e-3
            ? normalize({ x: toPlayer.x, y: 0, z: toPlayer.z })
            : guardFwd;
        const cosAngle = dot(guardFwd, dirToPlayer);

        const spottedInCone =
          horizDist <= this.sightDetectionRangeM &&
          cosAngle >= 0.38 &&
          !this.isSightBlockedBySolidCover(
            add(hs.worldPosition, vec3(0, 1.55, 0)),
            playerEyeWorldPos,
          );

        if (spottedInCone || horizDist <= 6.5) {
          agent.adrenaline = Math.max(agent.adrenaline, 0.88);
          this.transitionState(agent, 'ALERTED_ENGAGING');
        }
        break;
      }

      case 'SUPPRESSED_STAGGERED': {
        if (agent.neurogenicShockTimerS > 0) {
          agent.neurogenicShockTimerS = Math.max(0, agent.neurogenicShockTimerS - dt);
          // Gradually recover consciousness as vagal shock subsides if not bleeding out
          if (agent.neurogenicShockTimerS <= 0 && agent.triageStatus !== 'MORTALLY_WOUNDED') {
            hs.consciousness = Math.max(hs.consciousness, 0.78);
            hs.painShock = Math.min(hs.painShock, 0.45);
            agent.adrenaline = Math.max(agent.adrenaline, 0.82);
          }
        }
        if (agent.staggerTimerS > 0) {
          agent.staggerTimerS = Math.max(0, agent.staggerTimerS - dt);
        }

        // Stagger step slightly back toward cover anchor
        this.moveHorizontalClamped(hs, agent.coverAnchorWorld.x, agent.coverAnchorWorld.z, 0.85 * dt);
        hs.yawRad = approachAngleRad(hs.yawRad, desiredYawRad, 2.2 * dt);

        if (agent.staggerTimerS <= 0 && agent.neurogenicShockTimerS <= 0) {
          if (legCrippled) {
            this.transitionState(agent, 'DOWNED_CRAWLING');
          } else {
            if (!hs.isRagdollActive && !aimProfile.clutchingWound) {
              hs.posture = 'COMBAT_READY';
            }
            this.transitionState(agent, 'ALERTED_ENGAGING');
          }
        }
        break;
      }

      case 'ALERTED_ENGAGING': {
        const tuning = ARCHETYPE_TUNING[hs.archetype];
        agent.peekCycleTimerS += dt;

        // If disarmed or mortally wounded: retreat behind cover clutching wounds instead of peeking!
        if (aimProfile.clutchingWound) {
          agent.isPeekingOut = false;
          const retreatX = agent.coverAnchorWorld.x - agent.peekSign * 0.25;
          const retreatZ = agent.coverAnchorWorld.z - 0.35;
          this.moveHorizontalClamped(hs, retreatX, retreatZ, 0.95 * dt);
          hs.yawRad = approachAngleRad(hs.yawRad, desiredYawRad, 1.8 * dt);
          break;
        }

        // Tactical cover peek & lateral strafe rhythm
        const cyclePeriodS = 3.1;
        const phase = (agent.peekCycleTimerS % cyclePeriodS) / cyclePeriodS;
        agent.isPeekingOut = phase >= 0.26 && phase <= 0.86;

        const targetOffset = agent.isPeekingOut
          ? agent.peekSign *
            (agent.peekStrideM + Math.sin(agent.peekCycleTimerS * 2.4) * 0.28)
          : -agent.peekSign * 0.18;

        const deltaOffset = targetOffset - agent.currentLateralOffsetM;
        const maxStrideStep = tuning.strafeSpeedMs * dt;
        agent.currentLateralOffsetM +=
          Math.abs(deltaOffset) <= maxStrideStep
            ? deltaOffset
            : Math.sign(deltaOffset) * maxStrideStep;

        const goalX = agent.coverAnchorWorld.x + agent.currentLateralOffsetM;
        const goalZ =
          agent.coverAnchorWorld.z + (agent.isPeekingOut ? 0.18 : -0.12);
        this.moveHorizontalClamped(hs, goalX, goalZ, tuning.strafeSpeedMs * dt);

        // Smoothly turn yaw toward player
        hs.yawRad = approachAngleRad(hs.yawRad, desiredYawRad, 5.2 * dt);
        if (!hs.isRagdollActive) {
          hs.posture = 'COMBAT_READY' as CombatantPostureState;
        }

        if (aimProfile.canReturnFire && agent.isPeekingOut) {
          this.stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos);
        }
        break;
      }

      case 'DOWNED_CRAWLING': {
        if (!hs.isRagdollActive && !aimProfile.clutchingWound) {
          hs.posture = 'LEG_BUCKLED';
        }

        // Crawl slowly using functional upper body while turning toward player
        if (hs.leftArmFunctional || hs.rightArmFunctional) {
          const crawlTargetX = agent.coverAnchorWorld.x;
          const crawlTargetZ = agent.coverAnchorWorld.z - 0.3;
          this.moveHorizontalClamped(hs, crawlTargetX, crawlTargetZ, 0.32 * dt);
        }

        hs.yawRad = approachAngleRad(hs.yawRad, desiredYawRad, 2.6 * dt);

        // Leg-crippled fighters still bravely fire one-handed with 4.5x spread cone unless disarmed/mortally wounded!
        if (aimProfile.canReturnFire) {
          this.stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos);
        }
        break;
      }

      case 'DEAD':
        break;
    }

    if (!hs.isRagdollActive && hs.alive) {
      updateStandingCombatPose(hs, this.elapsedClockS);
    }
  }

  private stepWeaponBurstFire(
    dt: number,
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    aimProfile: EnemyAimProfile,
    playerEyeWorldPos: Vec3Like,
  ): void {
    const tuning = ARCHETYPE_TUNING[hs.archetype];

    if (agent.burstShotsRemaining <= 0) {
      agent.fireCooldownTimerS -= dt;
      if (agent.fireCooldownTimerS <= 0) {
        agent.burstShotsRemaining = aimProfile.isOneHandedDownedFire
          ? Math.max(1, Math.ceil(tuning.burstCount * 0.5))
          : tuning.burstCount;
        agent.burstInterShotTimerS = 0;
      }
      return;
    }

    agent.burstInterShotTimerS -= dt;
    if (agent.burstInterShotTimerS > 0) {
      return;
    }

    // Fire one round of the burst
    this.emitEnemyTracerShot(hs, agent, aimProfile, playerEyeWorldPos);

    agent.burstShotsRemaining -= 1;
    if (agent.burstShotsRemaining > 0) {
      agent.burstInterShotTimerS =
        tuning.interShotDelayS * (aimProfile.isOneHandedDownedFire ? 1.45 : 1.0);
    } else {
      agent.fireCooldownTimerS =
        tuning.burstCooldownS * (aimProfile.isOneHandedDownedFire ? 1.35 : 1.0);
    }
  }

  private emitEnemyTracerShot(
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    aimProfile: EnemyAimProfile,
    playerEyeWorldPos: Vec3Like,
  ): void {
    const tuning = ARCHETYPE_TUNING[hs.archetype];

    const handPos = hs.ragdollBones.HAND_RIGHT?.position;
    const muzzleHeight = agent.state === 'DOWNED_CRAWLING' ? 0.62 : 1.32;
    const fwdFromYaw = { x: Math.sin(hs.yawRad), y: 0, z: Math.cos(hs.yawRad) };

    const muzzleOrigin: Vec3Like = handPos
      ? add(handPos, scale(fwdFromYaw, 0.28))
      : {
          x: hs.worldPosition.x + fwdFromYaw.x * 0.38,
          y: hs.worldPosition.y + muzzleHeight,
          z: hs.worldPosition.z + fwdFromYaw.z * 0.38,
        };

    // Aim toward player chest/eye height with trauma-scaled dispersion cone
    const playerChestTarget: Vec3Like = {
      x: playerEyeWorldPos.x,
      y: playerEyeWorldPos.y - 0.18,
      z: playerEyeWorldPos.z,
    };
    const idealDir = normalize(sub(playerChestTarget, muzzleOrigin));
    const seed = agent.tracerSeedCounter++;
    const shotDir = deterministicConeSpread(
      idealDir,
      aimProfile.effectiveSpreadRad,
      (seed % 7) + 1,
      8,
      seed * 31,
    );

    const distToPlayer = Math.max(0.5, distance(muzzleOrigin, playerChestTarget));

    // Check if destructible cover intercepts the hostile round before reaching the player
    let blockedByCover = false;
    let impactPointWorld = add(muzzleOrigin, scale(shotDir, distToPlayer + 4.0));

    if (this.rapierWorld) {
      const hits = this.rapierWorld.castPenetrationRay(
        muzzleOrigin,
        shotDir,
        distToPlayer,
      );
      for (const h of hits) {
        if (h.distanceM > 0.25 && h.surface.penetrationResistanceJ >= 350) {
          blockedByCover = true;
          impactPointWorld = h.pointWorld;
          break;
        }
      }
    }

    // Closest approach of shotDir ray to player torso cylinder (radius 0.36m)
    let hitPlayer = false;
    let armorChipApplied = 0;
    let healthDamageApplied = 0;

    if (!blockedByCover) {
      const toPlayer = sub(playerChestTarget, muzzleOrigin);
      const along = dot(toPlayer, shotDir);
      if (along > 0) {
        const closestPt = add(muzzleOrigin, scale(shotDir, along));
        const missDistM = distance(closestPt, playerChestTarget);
        if (missDistM <= 0.36) {
          hitPlayer = true;
          impactPointWorld = closestPt;

          if (
            this.playerVitals.damageEnabled &&
            this.playerVitals.invulnerabilityRemainingS <= 0
          ) {
            const rawChip = tuning.baseChipDamage;
            if (this.playerVitals.armor > 0) {
              armorChipApplied = Math.min(this.playerVitals.armor, rawChip * 0.7);
              this.playerVitals.armor = Math.max(
                0,
                this.playerVitals.armor - armorChipApplied,
              );
              healthDamageApplied = rawChip * 0.35;
            } else {
              healthDamageApplied = rawChip;
            }

            // Never allow cheap arcade one-shots — keep player at >= 1 HP or fair chip floor
            this.playerVitals.health = Math.max(
              0,
              this.playerVitals.health - healthDamageApplied,
            );
            this.playerVitals.timeSinceLastHitS = 0;
            this.playerVitals.invulnerabilityRemainingS = 0.22;
          }
        }
      }
    }

    if (this.tracerPool) {
      const quat = this.computeTracerOrientationQuat(shotDir);
      const flightDist = distance(muzzleOrigin, impactPointWorld);
      const ttl = Math.max(0.05, Math.min(0.28, flightDist / tuning.tracerSpeedMs));
      this.tracerPool.spawnKinematicParticle(
        muzzleOrigin,
        scale(shotDir, tuning.tracerSpeedMs),
        vec3(0, 0, 0),
        { x: 0.024, y: 0.024, z: 0.95 },
        0,
        0,
        ttl,
        quat,
      );
    }

    const event: EnemyTracerFireEvent = {
      targetId: hs.targetId,
      archetype: hs.archetype,
      muzzleOriginWorld: muzzleOrigin,
      shotDirectionWorld: shotDir,
      impactPointWorld,
      tracerSpeedMs: tuning.tracerSpeedMs,
      spreadConeRad: aimProfile.effectiveSpreadRad,
      spreadMultiplier: aimProfile.spreadMultiplier,
      hitPlayer,
      blockedByCover,
      armorChipApplied,
      healthDamageApplied,
    };

    this.onEnemyFireTracer?.(event);
    if (hitPlayer && (armorChipApplied > 0 || healthDamageApplied > 0)) {
      this.onPlayerDamaged?.(this.playerVitals, event);
    }
  }

  private computeTracerOrientationQuat(shotDir: Vec3Like) {
    const f = normalize(shotDir);
    const upRef = Math.abs(f.y) < 0.98 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    const r = normalize(cross(upRef, f));
    const u = normalize(cross(f, r));
    return basisColumnsToQuaternion(r.x, r.y, r.z, u.x, u.y, u.z, f.x, f.y, f.z);
  }

  private isSightBlockedBySolidCover(eyeOrigin: Vec3Like, targetPoint: Vec3Like): boolean {
    if (!this.rapierWorld) return false;
    const delta = sub(targetPoint, eyeOrigin);
    const dist = length(delta);
    if (dist <= 0.4) return false;

    const dir = scale(delta, 1 / dist);
    const hits = this.rapierWorld.castPenetrationRay(eyeOrigin, dir, dist - 0.25);
    for (const h of hits) {
      // Transparent glass panes do NOT block visual sight!
      if (
        h.surface.material === 'GLASS_MARCHING_256' ||
        h.surface.material === 'GLASS_VORONOI'
      ) {
        continue;
      }
      if (h.distanceM > 0.2) {
        return true;
      }
    }
    return false;
  }

  private moveHorizontalClamped(
    hs: TargetHealthState,
    goalX: number,
    goalZ: number,
    maxStepM: number,
  ): void {
    if (hs.isRagdollActive || maxStepM <= 0) return;

    const clampedGoalX = Math.max(-8.1, Math.min(8.1, goalX));
    const clampedGoalZ = Math.max(-46.0, Math.min(-3.2, goalZ));

    const dx = clampedGoalX - hs.worldPosition.x;
    const dz = clampedGoalZ - hs.worldPosition.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-5) return;

    const step = Math.min(dist, maxStepM);
    const dirX = dx / dist;
    const dirZ = dz / dist;

    if (this.rapierWorld) {
      const waistOrigin = {
        x: hs.worldPosition.x,
        y: hs.worldPosition.y + 0.75,
        z: hs.worldPosition.z,
      };
      const clearanceHits = this.rapierWorld.castPenetrationRay(
        waistOrigin,
        { x: dirX, y: 0, z: dirZ },
        step + 0.42,
      );
      if (clearanceHits.length > 0 && clearanceHits[0].distanceM <= step + 0.42) {
        return;
      }
    }

    hs.worldPosition.x += dirX * step;
    hs.worldPosition.z += dirZ * step;
  }

  private refreshAgentAimMetrics(
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    externalAccuracyMultiplier?: number,
  ): EnemyAimProfile {
    const profile = this.computeEnemyAimProfile(hs, agent, externalAccuracyMultiplier);
    agent.lastSpreadMultiplier = profile.spreadMultiplier;
    agent.lastAimAccuracyMultiplier = profile.aimAccuracyMultiplier;
    agent.clutchingWound = profile.clutchingWound;
    return profile;
  }

  private transitionState(
    agent: EnemyAiAgentRuntime,
    nextState: EnemyTacticalAiState,
  ): void {
    if (agent.state === nextState) return;
    const prev = agent.state;
    agent.state = nextState;
    this.onEnemyStateChanged?.(agent.targetId, prev, nextState);
  }
}
