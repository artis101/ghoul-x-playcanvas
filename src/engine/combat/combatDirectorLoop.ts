import * as pc from 'playcanvas';
import { stepRagdollPhysics } from '../../core/ballistics/solver.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { BlastEvent } from '../../contracts/destruction.ts';
import type { PhysiologyEcsSystem } from '../../core/physiology/physiologySystem.ts';
import type { VascularBloodFxEmitter } from '../gore/vascularBloodFx.ts';
import type { HudController } from '../hudController.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import type { ActiveFragGrenade, GrenadeSweepInterceptor } from './fragGrenadeTypes.ts';
import type { ActiveBlastFlashFx } from './combatTypes.ts';
import type { OffhandSidearmRig } from './offhandSidearmTypes.ts';
import { stepActiveGrenades } from './fragGrenadePhysics.ts';
import { stepBlastFlashes } from './blastVisualFx.ts';
import { syncPhysiologyToHealthState } from './physiologySyncAdapter.ts';
import { createOffhandSidearmRig } from './offhandSidearmRig.ts';
import { playWeaponReloadClip } from '../mannequin/combatantWeaponMount.ts';
import { OffhandSidearmSync } from './offhandSidearmSync.ts';
import type { CombatantAimPose } from '../mannequin/combatantAnimController.ts';
import { primaryAimPose } from '../mannequin/combatantWeaponPoseMap.ts';
import { sidearmAimClip } from '../mannequin/combatantWoundedPhaseClips.ts';
import { HudTargetTracker } from './hudTargetTracker.ts';
import { setEnemyBarrelReader, weaponBarrelPose } from '../ai/enemyFireSolution.ts';
import { setCombatantAimTarget } from '../mannequin/combatantAimDelta.ts';
import { GRENADE_BLAST_RADIUS_M, GRENADE_PEAK_ENERGY_J, GRENADE_PEAK_IMPULSE_NS } from './fragGrenadeTypes.ts';

export interface CombatDirectorLoopContext {
  activeGrenades: ActiveFragGrenade[];
  activeBlastFlashes: ActiveBlastFlashFx[];
  targets: GhoulMannequinEntity[];
  physiologySystem: PhysiologyEcsSystem;
  vascularFx: VascularBloodFxEmitter;
  tacticalAi: TacticalCombatAiSystem | null;
  offhandSidearmRigs: Map<string, OffhandSidearmRig>;
  offhandSync: OffhandSidearmSync;
  hudTargetTracker: HudTargetTracker;
  glbRegistry: GlbModelRegistry | null;
  fxManager: GoreAndBallisticsFxManager;
  lastEngagedTarget: GhoulMannequinEntity | null;
  losCacheEpoch: number;
  lastHitClockByTarget: Map<string, number>;
  isLineOfSightBlocked?: (from: Vec3Like, to: Vec3Like) => boolean;
  grenadeSweepInterceptor?: GrenadeSweepInterceptor;
  onExplosionBlast?: (center: Vec3Like, radius: number, impulse: number, energy: number) => void;
  onGrenadeBlast?: (blast: BlastEvent) => void;
  applyExternalExplosionTrauma: (blast: any, label: string) => number;
  getViewerPosVec3: () => Vec3Like;
}

// Combatants whose aim point is currently published, so a removed one can be cleared.
const publishedAimIds = new Set<string>();

export function stepCombatDirectorLoop(
  ctx: CombatDirectorLoopContext,
  dt: number,
  totalElapsedTimeS: number,
  camera: pc.CameraComponent | null | undefined,
  hud: HudController,
  environment: any
): void {
  stepActiveGrenades(
    ctx.activeGrenades,
    dt,
    environment,
    (center) => {
      const blast: BlastEvent = {
        centerWorld: center,
        radiusM: GRENADE_BLAST_RADIUS_M,
        peakImpulseNs: GRENADE_PEAK_IMPULSE_NS,
        peakEnergyJ: GRENADE_PEAK_ENERGY_J,
      };
      if (ctx.onGrenadeBlast) {
        ctx.onGrenadeBlast(blast);
        return;
      }
      ctx.applyExternalExplosionTrauma(blast, 'M67 FRAG');
      ctx.onExplosionBlast?.(center, GRENADE_BLAST_RADIUS_M, GRENADE_PEAK_IMPULSE_NS, GRENADE_PEAK_ENERGY_J);
    },
    ctx.grenadeSweepInterceptor
  );

  stepBlastFlashes(ctx.activeBlastFlashes, dt);
  ctx.physiologySystem.update(dt);

  for (const t of ctx.targets) {
    const physio = ctx.physiologySystem.getEntity(t.healthState.targetId);
    if (physio) syncPhysiologyToHealthState(physio, t.healthState, ctx.tacticalAi);
  }
  ctx.vascularFx.update(dt);

  const viewerPos = ctx.getViewerPosVec3();
  if (ctx.tacticalAi) {
    const states = ctx.targets.map((t) => t.healthState);
    const playerFwd = camera?.entity
      ? vec3(camera.entity.forward.x, camera.entity.forward.y, camera.entity.forward.z)
      : undefined;
    // Enemy shots leave from the gun the player sees: the AI reads each held gun's muzzle and
    // barrel (as posed last frame, i.e. on screen now) for the fire gate and the shot line.
    setEnemyBarrelReader((targetId, usingSidearm) => {
      if (usingSidearm) {
        const rig = ctx.offhandSidearmRigs.get(targetId);
        return rig?.holderEntity.enabled ? weaponBarrelPose(rig.glbInstance?.rootEntity) : null;
      }
      const target = ctx.targets.find((t) => t.healthState.targetId === targetId);
      return weaponBarrelPose(target?.heldWeaponEntity);
    });
    try {
      ctx.tacticalAi.update(
        dt,
        states,
        viewerPos,
        (targetId, usingSidearm) => {
          if (usingSidearm) {
            const rig = ctx.offhandSidearmRigs.get(targetId);
            if (!rig?.holderEntity.enabled) return undefined;
            rig.glbInstance?.playFire?.();
            return rig.glbInstance?.muzzleNode?.getPosition();
          }
          return ctx.targets.find((target) => target.healthState.targetId === targetId)?.playWeaponFire();
        },
        playerFwd,
        (targetId, usingSidearm) =>
          usingSidearm
            ? playWeaponReloadClip(ctx.offhandSidearmRigs.get(targetId)?.glbInstance)
            : ctx.targets.find((target) => target.healthState.targetId === targetId)?.playWeaponReload()
      );
    } finally {
      setEnemyBarrelReader(null);
    }
  }

  const liveIds = new Set<string>();
  for (const t of ctx.targets) {
    const hs = t.healthState;
    liveIds.add(hs.targetId);
    let effectiveDt = dt;
    if ((hs.hitstopRemainingS ?? 0) > 0) {
      hs.hitstopRemainingS = Math.max(0, (hs.hitstopRemainingS ?? 0) - dt);
      effectiveDt = 0;
    }
    stepRagdollPhysics(hs, effectiveDt, 0.0);
    const agent = ctx.tacticalAi?.getAgent(hs.targetId);
    const sidearm = ctx.tacticalAi?.getSidearmVisualState(hs.targetId);
    const alive = hs.alive && hs.currentHp > 0;
    let aim: CombatantAimPose | undefined;
    // A dead or dying body aims nothing. A pistol held with no support hand left (arm lost or
    // dead) is aimed one-handed, and on one knee while the body is in its kneel-and-fire phase.
    if (alive && sidearm?.visible && sidearm.hand) {
      aim = { clip: sidearmAimClip(hs, sidearm.hand), hand: sidearm.hand };
    } else if (
      alive &&
      !hs.weaponDropped &&
      agent?.state === 'ALERTED_ENGAGING' &&
      (agent.isPeekingOut || agent.inFiringPosition)
    ) {
      // Raised whenever the AI shoots from here, not only when peeking: the aim clip brings the
      // aim delta (and its sway and recoil) with it, and without it the fire gate rarely opens.
      // The weapon pose map picks the clip: the long-gun aim, or the Desert Eagle two-handed or,
      // with the support arm gone, one-handed (combatantWeaponPoseMap.ts).
      aim = primaryAimPose(hs);
    }
    // Publish the point the AI aims at, so the aim delta turns the barrel onto it and the fire
    // gate (barrel within spread of the chest) can open. Cleared when not aiming or dead.
    const aimPoint = aim && alive && agent ? agent.lastAimTargetWorld : null;
    setCombatantAimTarget(hs.targetId, aimPoint);
    if (aimPoint) publishedAimIds.add(hs.targetId);
    else publishedAimIds.delete(hs.targetId);
    t.syncFromHealthState(effectiveDt, totalElapsedTimeS, agent?.state === 'PATROL_GUARD', aim);
    let rig = ctx.offhandSidearmRigs.get(hs.targetId);
    if (!rig) {
      rig = createOffhandSidearmRig(t, ctx.glbRegistry);
      ctx.offhandSidearmRigs.set(hs.targetId, rig);
    }
    if (ctx.offhandSync.sync(t, viewerPos, rig, ctx.tacticalAi, ctx.fxManager, effectiveDt)) {
      t.syncPoseAttachments();
    }
  }
  for (const id of publishedAimIds) {
    if (liveIds.has(id)) continue;
    setCombatantAimTarget(id, null);
    publishedAimIds.delete(id);
  }

  ctx.hudTargetTracker.projectTargets(
    ctx.targets, camera ?? null, hud, ctx.physiologySystem, ctx.lastEngagedTarget,
    viewerPos, totalElapsedTimeS, ctx.losCacheEpoch,
    ctx.lastHitClockByTarget, ctx.isLineOfSightBlocked
  );
}
