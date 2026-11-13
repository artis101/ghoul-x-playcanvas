import type * as pc from 'playcanvas';
import type { AmmoSpec, ShotSimulationReport, Vec3Like } from '../../contracts/ballistics.ts';
import type { InternalBallisticsReport } from '../../contracts/physiology.ts';
import { copyVec3, normalize, scale, sub, vec3 } from '../../core/ballistics/vec3.ts';
import { applyShotReportToTarget } from '../../core/ballistics/solver.ts';
import { marchInternalBallistics } from '../../core/ballistics/rayMarchTerminal.ts';
import type { AnatomicalBvh } from '../../core/ghoul/bvhVolumes.ts';
import type { PhysiologyEcsSystem } from '../../core/physiology/physiologySystem.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { HudController } from '../hudController.ts';
import type { MayhemDirector } from '../fx/mayhemDirector.ts';
import type { TacticalCombatAiSystem, BrutalKillRewardKind } from '../ai/tacticalCombatAi.ts';
import type { CombatAudioEngine, GoreImpactAudioKind } from '../audio/combatAudioEngine.ts';
import { SYNTHETIC_SHRAPNEL_AMMO } from './combatTargetConfigs.ts';
import { syncPhysiologyToHealthState } from './physiologySyncAdapter.ts';
import { startTerminalCountdown } from '../../core/physiology/physiologyVariance.ts';

export interface ImpactDispatcherContext {
  app?: pc.AppBase | null;
  physiologySystem: PhysiologyEcsSystem;
  anatomicalBvh: AnatomicalBvh;
  hudController: HudController;
  fxManager: GoreAndBallisticsFxManager;
  mayhemDirector: MayhemDirector | null;
  tacticalAi: TacticalCombatAiSystem | null;
  combatAudio: CombatAudioEngine | null;
  getViewerPosVec3: () => Vec3Like;
  lastHitClockByTarget?: Map<string, number>;
  lastUpdateClockS?: number;
}

export function classifyBrutalFeatFromReport(
  report: ShotSimulationReport
): Exclude<BrutalKillRewardKind, 'STANDARD_KILL' | 'MULTI_KILL_BLAST'> | null {
  if (report.dismembermentEvents.some((d) => d.zone === 'NECK_CERVICAL')) {
    return 'DECAPITATION';
  }
  if (report.dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP')) {
    return 'CRANIAL_POP';
  }
  if (report.dismembermentEvents.some((d) => d.goreMode === 'EVISCERATED')) {
    return 'EVISCERATED';
  }
  if (report.dismembermentEvents.some((d) => d.goreMode === 'CLEAN_SEVER')) {
    const isSurgicalJoint = report.combatantEffects.some((e) => e.startsWith('JOINT SHATTERED'));
    return isSurgicalJoint ? 'SURGICAL_SEVER' : 'CLEAN_SEVER';
  }
  return null;
}

export function applyImpactFxAndState(
  target: GhoulMannequinEntity,
  report: ShotSimulationReport,
  weaponLabel: string,
  ctx: ImpactDispatcherContext,
  ammoForInternalMarch?: AmmoSpec
): InternalBallisticsReport | null {
  const hs = target.healthState;
  const wasAlive = hs.alive;

  applyShotReportToTarget(hs, report);

  let internalReport: InternalBallisticsReport | null = null;
  const physio = ctx.physiologySystem.getEntity(hs.targetId);
  if (physio) {
    const aiAgent = ctx.tacticalAi?.getAgent(hs.targetId);
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
    // The organ march must agree with how the round behaved in the outer wound: a tumbling round
    // tears more (more effective energy), an icepick less.
    const variance = report.terminalVariance;
    const varianceSpeedScale = variance ? Math.sqrt(variance.depositScale) : 1;
    const marchSpeedMs = Math.max(
      60,
      (primaryWound ? primaryWound.entryVelocityMs : report.impactSpeedMs) * varianceSpeedScale
    );

    internalReport = marchInternalBallistics(
      {
        ammo: marchAmmo,
        rayOriginWorld: marchOrigin,
        rayDirectionWorld: marchDir,
        impactVelocityMs: marchSpeedMs,
        characterTransform: { positionWorld: copyVec3(hs.worldPosition), yawRad: hs.yawRad },
        config: {
          enableArmorPlates: hs.hasChestArmor && hs.chestArmorIntegrity > 0.05,
          enableHelmet: hs.headgearIntact && (hs.archetype === 'HEAVY_ENFORCER' || hs.archetype === 'MILITIA_GUNNER'),
          initialPlateIntegrity: physio.plateIntegrity,
        },
      },
      ctx.anatomicalBvh
    );

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
            characterTransform: { positionWorld: copyVec3(hs.worldPosition), yawRad: hs.yawRad },
            config: {
              enableArmorPlates: hs.hasChestArmor && hs.chestArmorIntegrity > 0.05,
              enableHelmet: hs.headgearIntact && (hs.archetype === 'HEAVY_ENFORCER' || hs.archetype === 'MILITIA_GUNNER'),
              initialPlateIntegrity: physio.plateIntegrity,
            },
          },
          ctx.anatomicalBvh
        );
      }
    }

    // A round that skated off a rib never reached the organs; only the outer wound counts.
    const skatedOffRib = variance?.ribGlance === true;
    if (internalReport.hitOuterShell && !skatedOffRib) {
      ctx.physiologySystem.applyBallisticTrauma(hs.targetId, internalReport);
      for (const ot of internalReport.organTrauma) {
        if (ot.directCrushLacerated || ot.stretchCavitationRuptured) hs.rupturedOrgans.add(ot.organId);
      }
      for (const bt of internalReport.boneTrauma) {
        if (bt.fractured) hs.fracturedBones.add(bt.boneId);
      }
    }
    if (report.delayedLethality && hs.alive) {
      startTerminalCountdown(physio, report.delayedLethality.delayS, report.delayedLethality.cause);
    }
    syncPhysiologyToHealthState(physio, hs, ctx.tacticalAi);
  }

  if (report.woundEvents.length > 0) {
    ctx.lastHitClockByTarget?.set(hs.targetId, ctx.lastUpdateClockS ?? 0);
  }

  const isLethalNow = !hs.alive;
  const armorOnly = report.woundEvents.length > 0 && report.woundEvents.every((w) => w.armorStopped);
  ctx.hudController.triggerHitmarker(isLethalNow ? 'LETHAL' : armorOnly ? 'ARMOR' : 'NORMAL');
  ctx.hudController.pushCombatFeed(report, weaponLabel, hs.name, wasAlive, hs.alive);
  ctx.mayhemDirector?.processShotSimulationReport(report);

  if (ctx.tacticalAi) {
    const primaryZone = report.woundEvents[0]?.ghoulZone ?? report.ragdollPlan.primaryHitZone ?? undefined;
    ctx.tacticalAi.notifyEnemyHit(hs, {
      hitZone: primaryZone,
      energyDepositedJ: report.totalEnergyDepositedJ,
      externalAccuracyMultiplier: physio?.readability.aiAccuracyMultiplier,
    });

    const brutalFeat = wasAlive ? classifyBrutalFeatFromReport(report) : null;
    if (brutalFeat) ctx.tacticalAi.notifyWitnessedBrutality(hs, brutalFeat);
  }

  if (ctx.combatAudio) {
    const listenerPos = ctx.getViewerPosVec3();
    const impactPos = report.woundEvents[0]?.entryPointWorld ?? hs.ragdollBones.TORSO_UPPER_THORAX?.position ?? hs.worldPosition;
    let goreKind: GoreImpactAudioKind = 'FLESH_HIT';
    if (report.dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP')) goreKind = 'CRANIAL_POP';
    else if (report.dismembermentEvents.length > 0) goreKind = 'LIMB_SEVER';
    else if (armorOnly) goreKind = 'ARMOR_SPARK';
    else if (report.woundEvents.some((w) => w.boneShattered || w.boneFractured)) goreKind = 'BONE_SHATTER';
    else if (report.woundEvents.some((w) => w.arterialSevered) || physio?.readability.bleedVisualProfile.kind === 'ARTERIAL_PULSING_JET') goreKind = 'ARTERIAL_SPURT';
    ctx.combatAudio.playGoreImpact(goreKind, impactPos, listenerPos);

    if (hs.alive && physio) {
      const vocal = physio.readability.vocalCue;
      if (vocal === 'SHARP_GASP' || vocal === 'WET_HEMOTHORAX_COUGH' || vocal === 'PAIN_GRUNT') {
        ctx.combatAudio.playVocalTraumaCue(vocal, impactPos, listenerPos);
      }
    }
  }

  // One bullet crosses several tissue layers; bleed once per body zone it passes, not once per layer.
  const bledZones = new Set<string>();
  for (const w of report.woundEvents) {
    if (w.armorStopped) {
      ctx.fxManager.spawnArmorImpactSparks(w.entryPointWorld, w.entryNormalWorld);
    } else {
      if (!bledZones.has(w.ghoulZone)) {
        bledZones.add(w.ghoulZone);
        ctx.fxManager.spawnBloodBurst(w.entryPointWorld, w.impactDirectionWorld, w.energyDepositedJ, 6);
        if (w.exitEnergyJ > 140) {
          ctx.fxManager.spawnBloodBurst(w.exitPointWorld, w.impactDirectionWorld, w.energyDepositedJ * 0.85, 5);
        }
      }
      if (w.boneShattered) {
        ctx.fxManager.spawnBoneShatterSparks(w.entryPointWorld, w.impactDirectionWorld);
      }
    }
  }

  for (const dism of report.dismembermentEvents) {
    ctx.fxManager.spawnDismembermentGibs(dism);
    ctx.fxManager.attachArterialFountain(hs, dism);
  }

  return internalReport;
}
