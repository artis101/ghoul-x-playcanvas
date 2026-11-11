import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { copyVec3, vec3 } from '../../core/ballistics/vec3.ts';
import { updateStandingCombatPose } from '../../core/ghoul/anatomy.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import type {
  CombatantResolveProfile,
  EnemyAiAgentRuntime,
  TacticalCoverStation,
} from './tacticalAiTypes.ts';
import { TACTICAL_COVER_STATIONS } from './tacticalAiTypes.ts';
import { resolveDefaultCombatantProfile } from './archetypeTuning.ts';
import { getPreferredPrimaryHand } from './combatantArmEvaluation.ts';

export function registerWaveTargetsInternal(
  targets: readonly TargetHealthState[],
  agents: Map<string, EnemyAiAgentRuntime>,
  peekPlanCache: Map<string, any>,
  aimExposureCache: Map<string, any>,
  resolveProfileOverrides: Map<string, CombatantResolveProfile>,
  hardenedSidearmOverrides: Map<string, boolean>,
  deployToCoverStations = false,
  elapsedClockS = 0
): void {
  agents.clear();
  peekPlanCache.clear();
  aimExposureCache.clear();

  for (let i = 0; i < targets.length; i++) {
    const hs = targets[i];
    let coverSpec: TacticalCoverStation | undefined;

    if (deployToCoverStations) {
      coverSpec = TACTICAL_COVER_STATIONS[i % TACTICAL_COVER_STATIONS.length];
      if (coverSpec) {
        hs.worldPosition = copyVec3(coverSpec.coverAnchorWorld);
        hs.yawRad = (coverSpec.guardYawDeg * Math.PI) / 180;
        updateStandingCombatPose(hs, elapsedClockS);
      }
    } else {
      let bestDist = 2.2;
      for (const st of TACTICAL_COVER_STATIONS) {
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
    const carriesBackupSidearm =
      hardenedSidearmOverrides.get(hs.targetId) ??
      (resolveProfileOverrides.has(hs.targetId) || hs.resolveProfile !== undefined
        ? resolveProfile === 'HARDENED_VETERAN' || defaults.carriesBackupSidearm
        : defaults.carriesBackupSidearm);

    hs.resolveProfile = resolveProfile;
    hs.combatantStatusTag = null;

    const anchor = copyVec3(hs.worldPosition);
    const peekSign: -1 | 1 = coverSpec
      ? coverSpec.peekSign
      : hs.worldPosition.x < 0
        ? 1
        : -1;

    const primaryHand = getPreferredPrimaryHand(hs);

    const agent: EnemyAiAgentRuntime = {
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

      peekCycleTimerS: (i * 0.73) % 2.4,
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
      fireCooldownTimerS: 0.65 + (i % 4) * 0.35,
      tracerSeedCounter: 100 + i * 37,
      completedBurstCount: 0,

      lastObservedHp: hs.currentHp,
      lastSpreadMultiplier: 1.0,
      lastAimAccuracyMultiplier: 1.0,
      clutchingWound: false,
      lastAimTargetWorld: vec3(0, 1.5, 0),
    };

    agents.set(hs.targetId, agent);
  }
}
