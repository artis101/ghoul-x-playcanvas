import * as pc from 'playcanvas';
import { stepRagdollPhysics } from '../../core/ballistics/solver.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import type { Vec3Like } from '../../contracts/ballistics.ts';
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
import { OffhandSidearmSync } from './offhandSidearmSync.ts';
import { HudTargetTracker } from './hudTargetTracker.ts';
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
  enableXRayInspector: boolean;
  lastHitClockByTarget: Map<string, number>;
  isLineOfSightBlocked?: (from: Vec3Like, to: Vec3Like) => boolean;
  grenadeSweepInterceptor?: GrenadeSweepInterceptor;
  onExplosionBlast?: (center: Vec3Like, radius: number, impulse: number, energy: number) => void;
  applyExternalExplosionTrauma: (blast: any, label: string) => number;
  getViewerPosVec3: () => Vec3Like;
}

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
      ctx.applyExternalExplosionTrauma(
        { centerWorld: center, radiusM: GRENADE_BLAST_RADIUS_M, peakImpulseNs: GRENADE_PEAK_IMPULSE_NS, peakEnergyJ: GRENADE_PEAK_ENERGY_J },
        'M67 FRAG'
      );
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
      playerFwd
    );
  }

  for (const t of ctx.targets) {
    const hs = t.healthState;
    let effectiveDt = dt;
    if ((hs.hitstopRemainingS ?? 0) > 0) {
      hs.hitstopRemainingS = Math.max(0, (hs.hitstopRemainingS ?? 0) - dt);
      effectiveDt = 0;
    }
    stepRagdollPhysics(hs, effectiveDt, 0.0);
    t.syncFromHealthState(effectiveDt, totalElapsedTimeS, ctx.tacticalAi?.isGuarding(hs.targetId));
    let rig = ctx.offhandSidearmRigs.get(hs.targetId);
    if (!rig) {
      rig = createOffhandSidearmRig(t, ctx.glbRegistry);
      ctx.offhandSidearmRigs.set(hs.targetId, rig);
    }
    if (ctx.offhandSync.sync(t, viewerPos, rig, ctx.tacticalAi, ctx.fxManager)) {
      t.syncPoseAttachments();
    }
  }

  ctx.hudTargetTracker.projectTargets(
    ctx.targets, camera ?? null, hud, ctx.physiologySystem, ctx.lastEngagedTarget,
    viewerPos, totalElapsedTimeS, ctx.losCacheEpoch, ctx.enableXRayInspector,
    ctx.lastHitClockByTarget, ctx.isLineOfSightBlocked
  );
}
