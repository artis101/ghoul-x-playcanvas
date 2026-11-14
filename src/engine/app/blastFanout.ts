import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { BlastEvent } from '../../contracts/destruction.ts';
import type { CombatDirector } from '../combat/combatDirector.ts';
import type { DestructionManager } from '../destruction/destructionManager.ts';
import type { MayhemDirector } from '../fx/mayhemDirector.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';

export interface BlastFanoutPlayer {
  getEyePosition(): Vec3Like;
  applyBump(strength: number): void;
  applyCameraShake(intensityDeg: number, durationS?: number): void;
}

export interface BlastFanoutSystems {
  readonly combatDirector: CombatDirector;
  readonly destructionManager: DestructionManager;
  readonly mayhemDirector: MayhemDirector;
  readonly tacticalAi: TacticalCombatAiSystem;
  readonly fpsController?: BlastFanoutPlayer | null;
}

export interface BlastSourceProfile {
  readonly traumaLabel: string;
  readonly aiAlertRadiusM: number;
  readonly aiAlertStrength: number;
  /** Fireball, light and smoke swirl through MayhemDirector.notifyExternalExplosion. Barrels spawn their own. */
  readonly spawnExplosionFx: boolean;
  readonly bumpGain: number;
  readonly shakeGainDeg: number;
  readonly shakeDurationS: number;
  /** The thump and shake reach this many blast radii from the centre. */
  readonly shakeReachRadii: number;
}

export const BARREL_BLAST_PROFILE: BlastSourceProfile = {
  traumaLabel: 'HAZARD BARREL',
  aiAlertRadiusM: 45.0,
  aiAlertStrength: 0.78,
  spawnExplosionFx: false,
  bumpGain: 1.6,
  shakeGainDeg: 3.2,
  shakeDurationS: 0.5,
  shakeReachRadii: 3,
};

export const GRENADE_BLAST_PROFILE: BlastSourceProfile = {
  traumaLabel: 'M67 FRAG',
  aiAlertRadiusM: 45.0,
  aiAlertStrength: 0.72,
  spawnExplosionFx: true,
  bumpGain: 1.6,
  shakeGainDeg: 3.2,
  shakeDurationS: 0.5,
  shakeReachRadii: 3,
};

/** Every system's share of one blast, dispatched exactly once. */
export function fanOutBlast(systems: BlastFanoutSystems, blast: BlastEvent, profile: BlastSourceProfile): void {
  const { combatDirector, destructionManager, mayhemDirector, tacticalAi } = systems;
  // Destruction goes ahead of queued work, its pieces in planned order, and decals are re-checked
  // against the new holes once the last piece has run. Without a work budget it all runs right here.
  const jobs = [...destructionManager.planBlastJobs(blast)];
  jobs.push(() => mayhemDirector.syncSurfaceBreaches());
  combatDirector.blastWork.deferFirstAll(jobs);
  combatDirector.applyExternalExplosionTrauma(blast, profile.traumaLabel);
  if (profile.spawnExplosionFx) mayhemDirector.notifyExternalExplosion(blast);
  tacticalAi.notifyGunshotOrExplosion(blast.centerWorld, profile.aiAlertRadiusM, profile.aiAlertStrength);
  applyBlastCameraKick(systems.fpsController ?? null, blast, profile);
}

function applyBlastCameraKick(player: BlastFanoutPlayer | null, blast: BlastEvent, profile: BlastSourceProfile): void {
  if (!player) return;
  const eye = player.getEyePosition();
  const c = blast.centerWorld;
  const dist = Math.hypot(eye.x - c.x, eye.y - c.y, eye.z - c.z);
  const near = 1 - dist / Math.max(1, blast.radiusM * profile.shakeReachRadii);
  if (near <= 0) return;
  player.applyBump(near * profile.bumpGain);
  player.applyCameraShake(near * profile.shakeGainDeg, profile.shakeDurationS);
}
