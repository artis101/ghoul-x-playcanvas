import type { BlastEvent } from '../../contracts/destruction.ts';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import { add, distance, length, normalize, sub, vec3 } from '../../core/ballistics/vec3.ts';
import { ALL_GHOUL_ZONES } from '../../core/ghoul/anatomy.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { CombatAudioEngine } from '../audio/combatAudioEngine.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import type { CameraShakeCallback } from './combatTypes.ts';
import { SYNTHETIC_SHRAPNEL_AMMO } from './combatTargetConfigs.ts';
import { buildFragBlastReportForTarget } from './fragBlastCalculator.ts';
import { applyImpactFxAndState, type ImpactDispatcherContext } from './impactDamageDispatcher.ts';

export function routeExternalExplosionTrauma(
  blast: BlastEvent,
  sourceLabel: string,
  targets: GhoulMannequinEntity[],
  fxManager: GoreAndBallisticsFxManager,
  combatAudio: CombatAudioEngine | null,
  tacticalAi: TacticalCombatAiSystem | null,
  onCameraShake: CameraShakeCallback | undefined,
  getViewerPosVec3: () => Vec3Like,
  spawnBlastFx: (center: Vec3Like, radius: number) => void,
  impactCtx: ImpactDispatcherContext,
  /** Runs each body's share of the blast. The default does it on the spot; a queue may spread it. */
  defer: (job: () => void) => void = (job) => job()
): number {
  const center = blast.centerWorld;
  const blastRadiusM = blast.radiusM;
  const peakImpulseNs = blast.peakImpulseNs;
  const peakEnergyJ = blast.peakEnergyJ;

  spawnBlastFx(center, blastRadiusM);
  fxManager.spawnArmorImpactSparks(add(center, vec3(0, 0.12, 0)), vec3(0, 1, 0));
  fxManager.spawnBoneShatterSparks(add(center, vec3(0, 0.18, 0)), vec3(0, 1, 0));

  if (combatAudio) {
    const intensity = Math.min(2.0, Math.max(0.75, peakEnergyJ / 6000));
    combatAudio.playExplosion(center, getViewerPosVec3(), intensity);
  }

  if (onCameraShake) {
    const viewerDist = distance(center, getViewerPosVec3());
    if (viewerDist < 34.0) {
      const proximity = Math.max(0.12, 1 - viewerDist / 34.0);
      onCameraShake(4.2 * proximity * proximity + 0.55, 0.44);
    }
  }

  let newlyKilledCount = 0;
  let lastKilledHs: GhoulMannequinEntity['healthState'] | null = null;
  for (const target of targets) defer(() => {
    const hs = target.healthState;
    const wasAlive = hs.alive;
    const pelvisPos = hs.ragdollBones.PELVIS_GROIN.position;
    const distM = distance(center, pelvisPos);
    if (distM > blastRadiusM) return;

    const blastReport = buildFragBlastReportForTarget(hs, center, distM, blastRadiusM, peakImpulseNs, peakEnergyJ);
    applyImpactFxAndState(target, blastReport, sourceLabel, impactCtx, SYNTHETIC_SHRAPNEL_AMMO);

    if (wasAlive && !hs.alive) {
      newlyKilledCount++;
      lastKilledHs = hs;
    }

    if (distM < 4.5 && hs.isRagdollActive) {
      const corpseScale = wasAlive ? 1.0 : 0.28;
      const closePush = (1 - distM / 4.5) * 1.15 * corpseScale;
      const closeLift = wasAlive ? (1 - distM / 4.5) * 0.38 : 0.0;
      const rawOut = sub(pelvisPos, center);
      const horizOut = vec3(rawOut.x, 0, rawOut.z);
      const outDir = length(horizOut) > 1e-3 ? normalize(horizOut) : vec3(0, 0, -1);
      const maxBlastBoneSpeed = wasAlive ? 4.4 : 2.8;
      for (const z of ALL_GHOUL_ZONES) {
        const b = hs.ragdollBones[z];
        if (b.componentId === 'BODY') {
          b.velocity.x += outDir.x * closePush;
          b.velocity.y = Math.min(wasAlive ? 0.55 : 0.15, b.velocity.y + closeLift);
          b.velocity.z += outDir.z * closePush;
          const spd = length(b.velocity);
          if (spd > maxBlastBoneSpeed) {
            b.velocity.x *= maxBlastBoneSpeed / spd;
            b.velocity.y *= maxBlastBoneSpeed / spd;
            b.velocity.z *= maxBlastBoneSpeed / spd;
          }
        }
      }
    }
  });

  defer(() => {
    if (newlyKilledCount >= 2 && lastKilledHs) {
      tacticalAi?.notifyWitnessedBrutality(lastKilledHs, 'MULTI_KILL_BLAST');
    }
  });

  // Kills so far: all of them when nothing was deferred, none yet when the work was queued.
  return newlyKilledCount;
}
