import type { TargetHealthState } from '../../contracts/ballistics.ts';
import {
  applyArmamentStateToRuntime,
  reconcileEnemyArmamentState,
} from '../../core/ai/enemyArmamentFsm.ts';
import {
  beginMagazineReload,
  createEnemyMagazine,
  type EnemyMagazineState,
  isMagazineDry,
  isMagazineReloading,
  resolveEnemyGunHandling,
  stepMagazineReload,
  wantsTacticalReload,
} from '../../core/ai/enemyGunHandling.ts';
import { cancelActiveBurst } from '../../core/ai/weaponBurstFsm.ts';
import { FALLBACK_RELOAD_S } from '../../core/ballistics/weapons/weaponHandling.ts';
import { ARCHETYPE_TUNING, BACKUP_SIDEARM_WEAPON_ID } from './archetypeTuning.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';

/** Seconds without sight of the player before a fighter counts itself out of contact. */
const OUT_OF_CONTACT_S = 1.5;

/** The magazine of the gun the agent is holding, filled on first use. */
export function getAgentMagazine(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  usingSidearm: boolean
): EnemyMagazineState {
  if (usingSidearm) {
    agent.sidearmMagazine ??= createEnemyMagazine(resolveEnemyGunHandling(BACKUP_SIDEARM_WEAPON_ID));
    return agent.sidearmMagazine;
  }
  agent.primaryMagazine ??= createEnemyMagazine(
    resolveEnemyGunHandling(ARCHETYPE_TUNING[hs.archetype].primaryWeaponId)
  );
  return agent.primaryMagazine;
}

/** True while the long gun has been shot empty with nothing left to load: not worth picking up. */
export function isPrimaryShotDry(agent: EnemyAiAgentRuntime): boolean {
  return agent.primaryMagazine !== undefined && isMagazineDry(agent.primaryMagazine);
}

export function isAgentReloading(agent: EnemyAiAgentRuntime): boolean {
  const state = reconcileEnemyArmamentState(agent);
  const m = state.kind === 'SIDEARM_ACTIVE' ? agent.sidearmMagazine : agent.primaryMagazine;
  return m !== undefined && isMagazineReloading(m);
}

/**
 * Runs the gun in hand once a frame: counts a reload down, starts one when the magazine is
 * empty or, out of contact, half spent, and gives up a gun with nothing left to feed it. An
 * empty long gun is dropped so the backup pistol comes out; an empty pistol is thrown away.
 */
export function stepAgentMagazine(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  ctx: TacticalFsmContext
): void {
  if (!hs.alive || agent.state === 'PATROL_GUARD') return;
  const armament = reconcileEnemyArmamentState(agent);
  if (armament.kind === 'DISARMED' || armament.kind === 'SIDEARM_DRAWING') return;
  const usingSidearm = armament.kind === 'SIDEARM_ACTIVE';
  if (!usingSidearm && hs.weaponDropped) return;

  const m = getAgentMagazine(hs, agent, usingSidearm);
  if (isMagazineReloading(m)) {
    stepMagazineReload(m, dt);
    return;
  }

  const inContact = agent.isPeekingOut && (agent.timeWithoutLosS ?? 0) < OUT_OF_CONTACT_S;
  const needsReload = m.mag <= 0 ? m.reserve > 0 : !inContact && wantsTacticalReload(m);
  if (needsReload) {
    const durationS = ctx.burstCtx.playReloadVisual?.(hs.targetId, usingSidearm) ?? FALLBACK_RELOAD_S;
    if (beginMagazineReload(m, durationS)) {
      cancelActiveBurst(agent);
      ctx.onAgentReloadStart?.(hs, agent);
    }
    return;
  }

  if (!isMagazineDry(m)) return;
  cancelActiveBurst(agent);
  if (usingSidearm) {
    applyArmamentStateToRuntime(agent, { kind: 'DISARMED', sidearmDropped: true });
  } else if (!hs.isRagdollActive) {
    // The armament state machine sees the gun gone and draws the pistol, if there is one.
    hs.weaponDropped = true;
  }
}
