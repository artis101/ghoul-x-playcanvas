import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { createPrimaryArmedState } from '../../core/ai/enemyArmamentFsm.ts';
import { createCooldownBurstState } from '../../core/ai/weaponBurstFsm.ts';
import { copyVec3, vec3 } from '../../core/ballistics/vec3.ts';
import { placeRestSkeleton } from '../../core/ghoul/anatomy/restSkeletonPlacement.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import type {
  CombatantResolveProfile,
  EnemyAiAgentRuntime,
  TacticalCoverStation,
} from './tacticalAiTypes.ts';
import { resolveDefaultCombatantProfile } from './archetypeTuning.ts';
import { getPreferredPrimaryHand } from './combatantArmEvaluation.ts';
import type { PeekPlanCacheEntry } from './tacticalCoverFinder.ts';

export function createAgentRuntime(
  hs: TargetHealthState,
  index: number,
  deployToCoverStations: boolean,
  coverStations: readonly TacticalCoverStation[],
  resolveProfileOverrides: ReadonlyMap<string, CombatantResolveProfile>,
  hardenedSidearmOverrides: ReadonlyMap<string, boolean>
): EnemyAiAgentRuntime {
  let coverSpec: TacticalCoverStation | undefined;

  if (deployToCoverStations) {
    coverSpec = coverStations[index % coverStations.length];
    if (coverSpec) {
      hs.worldPosition = copyVec3(coverSpec.coverAnchorWorld);
      hs.yawRad = (coverSpec.guardYawDeg * Math.PI) / 180;
      // Moved to its station: carry the hit skeleton along until the animated body poses it.
      placeRestSkeleton(hs);
    }
  } else {
    let bestDist = 2.2;
    for (const st of coverStations) {
      const d = Math.hypot(
        hs.worldPosition.x - st.coverAnchorWorld.x,
        hs.worldPosition.z - st.coverAnchorWorld.z
      );
      if (d <= bestDist) {
        bestDist = d;
        coverSpec = st;
      }
    }
  }

  const defaults = resolveDefaultCombatantProfile(hs.targetId, hs.archetype);
  const resolveProfile =
    resolveProfileOverrides.get(hs.targetId) ??
    hs.resolveProfile ??
    defaults.resolveProfile;
  // Everyone carries the backup handgun unless a lab or test explicitly takes it away.
  const carriesBackupSidearm = hardenedSidearmOverrides.get(hs.targetId) ?? defaults.carriesBackupSidearm;

  hs.resolveProfile = resolveProfile;
  hs.combatantStatusTag = null;

  const anchor = copyVec3(hs.worldPosition);
  const peekSign: -1 | 1 = coverSpec
    ? coverSpec.peekSign
    : hs.worldPosition.x < 0
      ? 1
      : -1;

  const primaryHand = getPreferredPrimaryHand(hs);
  const initialCooldownS = 0.65 + (index % 4) * 0.35;

  return {
    targetId: hs.targetId,
    state: hs.alive ? 'PATROL_GUARD' : 'DEAD',
    triageStatus: computeCombatantTriageStatus(hs),
    resolveProfile,
    carriesBackupSidearm,

    coverAnchorWorld: anchor,
    peekSign,
    peekStrideM: coverSpec?.peekStrideM ?? 0.95,
    guardBaseYawRad: hs.yawRad,

    adrenaline: 0.05,
    suppression: 0,
    neurogenicShockTimerS: 0,
    staggerTimerS: 0,

    peekCycleTimerS: (index * 0.73) % 2.4,
    isPeekingOut: false,
    currentLateralOffsetM: 0,
    berserkerAdvanceOffsetM: 0,

    activeFiringHand: primaryHand,
    sidearmDrawTimerS: 0,
    sidearmDrawing: false,
    sidearmActive: false,
    sidearmDropped: false,

    burstShotsRemaining: 0,
    burstInterShotTimerS: 0,
    fireCooldownTimerS: initialCooldownS,
    tracerSeedCounter: 100 + index * 37,
    completedBurstCount: 0,

    lastObservedHp: hs.currentHp,
    lastSpreadMultiplier: 1.0,
    lastAimAccuracyMultiplier: 1.0,
    clutchingWound: false,
    lastAimTargetWorld: vec3(0, 1.5, 0),

    fireMode: 'AGGRESSIVE_LETHAL',
    isOffScreen: false,
    alertReactionTimerS: 0,
    hasFiredWarningShot: false,
    timeWithoutLosS: 0,

    armamentState: createPrimaryArmedState(primaryHand),
    burstState: createCooldownBurstState(initialCooldownS),
    shockState: { kind: 'CLEAR' },
  };
}

export function registerWaveTargetsInternal(
  targets: readonly TargetHealthState[],
  agents: Map<string, EnemyAiAgentRuntime>,
  peekPlanCache: Map<string, PeekPlanCacheEntry>,
  resolveProfileOverrides: ReadonlyMap<string, CombatantResolveProfile>,
  hardenedSidearmOverrides: ReadonlyMap<string, boolean>,
  coverStations: readonly TacticalCoverStation[],
  deployToCoverStations = false
): void {
  agents.clear();
  peekPlanCache.clear();
  for (let i = 0; i < targets.length; i++) {
    const hs = targets[i];
    agents.set(
      hs.targetId,
      createAgentRuntime(hs, i, deployToCoverStations, coverStations, resolveProfileOverrides, hardenedSidearmOverrides)
    );
  }
}
