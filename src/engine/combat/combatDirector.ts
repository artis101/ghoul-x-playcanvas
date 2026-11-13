import * as pc from 'playcanvas';
import { AmmoSpec, EnvironmentState, Vec3Like, WeaponSpec } from '../../contracts/ballistics.ts';
import type { BlastEvent } from '../../contracts/destruction.ts';
import type { InternalBallisticsReport, PhysiologicalEntityState } from '../../contracts/physiology.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import { DEFAULT_ENVIRONMENT } from '../../core/ballistics/weapons.ts';
import { getDefaultAnatomicalBvh, AnatomicalBvh } from '../../core/ghoul/bvhVolumes.ts';
import { PhysiologyEcsSystem } from '../../core/physiology/physiologySystem.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import { GhoulMannequinEntity } from '../mannequin.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import { VascularBloodFxEmitter } from '../gore/vascularBloodFx.ts';
import type { HudController } from '../hudController.ts';
import type { MayhemDirector } from '../fx/mayhemDirector.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import type { CombatAudioEngine } from '../audio/combatAudioEngine.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import { RangeTargetConfig, TARGET_CONFIGS } from './combatTargetConfigs.ts';
import {
  ActiveBlastFlashFx, CameraShakeCallback, CombatDirectorSubsystems,
  EnvironmentRayInterceptor, EnvironmentRayInterceptResult, ExplosionBlastHandler,
} from './combatTypes.ts';
import { ActiveFragGrenade, type GrenadeSweepInterceptor } from './fragGrenadeTypes.ts';
import { spawnLiveFragGrenade } from './fragGrenadeSpawner.ts';
import { createBlastFireballMaterial, spawnBlastVisualFx } from './blastVisualFx.ts';
import { routeExternalExplosionTrauma } from './externalExplosionRouter.ts';
import { routeWeaponFire } from './weaponBallisticsRouter.ts';
import { SniperRangefinder } from './sniperRangefinder.ts';
import { HudTargetTracker } from './hudTargetTracker.ts';
import { destroyOffhandSidearmRig } from './offhandSidearmRig.ts';
import { OffhandSidearmSync } from './offhandSidearmSync.ts';
import { type OffhandSidearmRig } from './offhandSidearmTypes.ts';
import { spawnCombatTargets } from './combatTargetSpawner.ts';
import { stepCombatDirectorLoop } from './combatDirectorLoop.ts';

export { TARGET_CONFIGS };
export type { RangeTargetConfig };
export type {
  EnvironmentRayInterceptor,
  EnvironmentRayInterceptResult,
  ExplosionBlastHandler,
  CameraShakeCallback,
  CombatDirectorSubsystems,
};

export class CombatDirector {
  public static readonly TARGET_CONFIGS: readonly RangeTargetConfig[] = TARGET_CONFIGS;
  public readonly TARGET_CONFIGS: readonly RangeTargetConfig[] = TARGET_CONFIGS;

  public targets: GhoulMannequinEntity[] = [];
  public lastEngagedTarget: GhoulMannequinEntity | null = null;
  public environment: EnvironmentState = { ...DEFAULT_ENVIRONMENT };

  public readonly anatomicalBvh: AnatomicalBvh = getDefaultAnatomicalBvh();
  public readonly physiologySystem: PhysiologyEcsSystem = new PhysiologyEcsSystem();
  public readonly vascularFx: VascularBloodFxEmitter;
  public lastInternalBallisticsReport: InternalBallisticsReport | null = null;

  public environmentRayInterceptor?: EnvironmentRayInterceptor;
  public grenadeSweepInterceptor?: GrenadeSweepInterceptor;
  public isLineOfSightBlocked?: (fromWorld: Vec3Like, toWorld: Vec3Like) => boolean;
  public onExplosionBlast?: ExplosionBlastHandler;
  public onCameraShake?: CameraShakeCallback;

  private mayhemDirector: MayhemDirector | null = null;
  private tacticalAi: TacticalCombatAiSystem | null = null;
  private combatAudio: CombatAudioEngine | null = null;
  private getPlayerEyePosition?: CombatDirectorSubsystems['getPlayerEyePosition'];
  private glbRegistry: GlbModelRegistry | null = null;

  private readonly activeGrenades: ActiveFragGrenade[] = [];
  private readonly activeBlastFlashes: ActiveBlastFlashFx[] = [];
  private readonly offhandSidearmRigs = new Map<string, OffhandSidearmRig>();
  private readonly lastHitClockByTarget = new Map<string, number>();
  private losCacheEpoch = 1;
  private lastUpdateClockS = 0;
  private grenadeCooldownS = 0;

  private readonly blastFireballMat: pc.StandardMaterial = createBlastFireballMaterial();
  private readonly sniperRangefinder = new SniperRangefinder();
  private readonly hudTargetTracker = new HudTargetTracker();
  private readonly offhandSync = new OffhandSidearmSync();

  public constructor(
    private readonly app: pc.AppBase,
    private readonly materials: EngineMaterialPalette,
    private readonly fxManager: GoreAndBallisticsFxManager,
    private readonly hudController: HudController,
    glbRegistry?: GlbModelRegistry,
    subsystems?: CombatDirectorSubsystems
  ) {
    this.glbRegistry = glbRegistry || null;
    this.vascularFx = new VascularBloodFxEmitter(app, materials);
    if (subsystems) this.connectSubsystems(subsystems);
  }

  public connectSubsystems(s: CombatDirectorSubsystems): void {
    if (s.mayhemDirector) this.mayhemDirector = s.mayhemDirector;
    if (s.tacticalAi) this.tacticalAi = s.tacticalAi;
    if (s.combatAudio) this.combatAudio = s.combatAudio;
    if (s.glbRegistry) this.glbRegistry = s.glbRegistry;
    if (s.getPlayerEyePosition) this.getPlayerEyePosition = s.getPlayerEyePosition;
    if (s.isLineOfSightBlocked) this.isLineOfSightBlocked = s.isLineOfSightBlocked;
  }

  public getTargetPhysiology(targetId: string): PhysiologicalEntityState | undefined {
    return this.physiologySystem.getEntity(targetId);
  }

  public spawnAllTargets(): void {
    for (const t of this.targets) t.destroy();
    this.targets = [];
    this.physiologySystem.reset();
    this.vascularFx.clearAll();
    this.targets = spawnCombatTargets(this.app, this.materials, this.fxManager, this.glbRegistry, this.physiologySystem, this.tacticalAi);
  }

  /** Materials this director only puts on screen mid-fight, for the preloader's shader warm-up. */
  public get warmupMaterials(): pc.Material[] { return [this.blastFireballMat]; }

  public areAllTargetsDown(): boolean {
    return this.targets.length > 0 && this.targets.every((t) => !t.healthState.alive);
  }

  private getViewerPosVec3(): Vec3Like {
    return this.getPlayerEyePosition?.() ?? vec3(0, 1.62, 0);
  }

  public fireWeapon(weapon: WeaponSpec, ammo: AmmoSpec, origin: Vec3Like, aimDir: Vec3Like): void {
    this.losCacheEpoch++;
    this.lastInternalBallisticsReport = routeWeaponFire(weapon, ammo, origin, aimDir, this.targets, this.environment, this.fxManager, this.environmentRayInterceptor, {
      app: this.app,
      physiologySystem: this.physiologySystem,
      anatomicalBvh: this.anatomicalBvh,
      hudController: this.hudController,
      fxManager: this.fxManager,
      mayhemDirector: this.mayhemDirector,
      tacticalAi: this.tacticalAi,
      combatAudio: this.combatAudio,
      getViewerPosVec3: () => this.getViewerPosVec3(),
      lastHitClockByTarget: this.lastHitClockByTarget,
      lastUpdateClockS: this.lastUpdateClockS,
    }) ?? null;
  }

  public throwFragGrenade(origin: Vec3Like, aimDir: Vec3Like): void {
    if (this.grenadeCooldownS > 0) return;
    this.grenadeCooldownS = 0.32;
    this.activeGrenades.push(spawnLiveFragGrenade(origin, aimDir, this.glbRegistry, this.fxManager.fxRoot));
    this.hudController.pushSystemToast('M67 FRAG', 'LIVE GRENADE OUT (1.6S)');
  }

  public applyExternalExplosionTrauma(blast: BlastEvent, sourceLabel = 'HAZARD BARREL'): number {
    this.losCacheEpoch++;
    return routeExternalExplosionTrauma(
      blast, sourceLabel, this.targets, this.fxManager, this.combatAudio, this.tacticalAi,
      this.onCameraShake, () => this.getViewerPosVec3(),
      (c, r) => spawnBlastVisualFx(c, r, this.app, this.materials, this.blastFireballMat, this.activeBlastFlashes),
      {
        app: this.app,
        physiologySystem: this.physiologySystem,
        anatomicalBvh: this.anatomicalBvh,
        hudController: this.hudController,
        fxManager: this.fxManager,
        mayhemDirector: this.mayhemDirector,
        tacticalAi: this.tacticalAi,
        combatAudio: this.combatAudio,
        getViewerPosVec3: () => this.getViewerPosVec3(),
      }
    );
  }

  public updateSniperRangefinder(weapon: WeaponSpec, ammo: AmmoSpec, origin: Vec3Like, aimDir: Vec3Like, hud: HudController): void {
    this.sniperRangefinder.update(weapon, ammo, origin, aimDir, hud, this.targets, this.environment, this.lastUpdateClockS);
  }

  public update(dt: number, totalElapsedTimeS: number, camera: pc.CameraComponent | null | undefined, hud: HudController): void {
    this.lastUpdateClockS = totalElapsedTimeS;
    if (this.grenadeCooldownS > 0) this.grenadeCooldownS -= dt;
    stepCombatDirectorLoop({
      activeGrenades: this.activeGrenades, activeBlastFlashes: this.activeBlastFlashes,
      targets: this.targets, physiologySystem: this.physiologySystem, vascularFx: this.vascularFx,
      tacticalAi: this.tacticalAi, offhandSidearmRigs: this.offhandSidearmRigs,
      offhandSync: this.offhandSync, hudTargetTracker: this.hudTargetTracker,
      glbRegistry: this.glbRegistry, fxManager: this.fxManager,
      lastEngagedTarget: this.lastEngagedTarget, losCacheEpoch: this.losCacheEpoch,
      lastHitClockByTarget: this.lastHitClockByTarget,
      isLineOfSightBlocked: this.isLineOfSightBlocked,
      grenadeSweepInterceptor: this.grenadeSweepInterceptor,
      onExplosionBlast: this.onExplosionBlast,
      applyExternalExplosionTrauma: (b, l) => this.applyExternalExplosionTrauma(b, l),
      getViewerPosVec3: () => this.getViewerPosVec3(),
    }, dt, totalElapsedTimeS, camera, hud, this.environment);
  }

  public destroy(): void {
    this.activeGrenades.forEach((g) => { g.glbInstance?.destroy(); g.entity.destroy(); });
    this.activeGrenades.length = 0;
    this.activeBlastFlashes.forEach((bf) => bf.root.destroy());
    this.activeBlastFlashes.length = 0;
    this.offhandSidearmRigs.forEach(destroyOffhandSidearmRig);
    this.offhandSidearmRigs.clear();
    this.targets.forEach((t) => t.destroy());
    this.targets.length = 0;
    this.vascularFx.clearAll();
    this.blastFireballMat.destroy();
  }
}
