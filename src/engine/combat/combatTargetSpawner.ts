import * as pc from 'playcanvas';
import { vec3 } from '../../core/ballistics/vec3.ts';
import { createTargetHealthState } from '../../core/ghoul/anatomy.ts';
import type { PhysiologyEcsSystem } from '../../core/physiology/physiologySystem.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import { GhoulMannequinEntity } from '../mannequin.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import { TARGET_CONFIGS } from './combatTargetConfigs.ts';

export function spawnCombatTargets(
  app: pc.AppBase,
  materials: EngineMaterialPalette,
  fxManager: GoreAndBallisticsFxManager,
  glbRegistry: GlbModelRegistry | null,
  physiologySystem: PhysiologyEcsSystem,
  tacticalAi: TacticalCombatAiSystem | null
): GhoulMannequinEntity[] {
  const targets: GhoulMannequinEntity[] = [];

  for (const cfg of TARGET_CONFIGS) {
    const isSouthpaw = cfg.archetype === 'SNIPER_OPERATIVE' || cfg.id === 'target_6';
    const hs = createTargetHealthState(
      cfg.id,
      cfg.name,
      vec3(cfg.position.x, cfg.position.y, cfg.position.z),
      (cfg.yawDeg * Math.PI) / 180,
      cfg.archetype,
      isSouthpaw
    );
    hs.hitstopRemainingS = 0;
    const mannequin = new GhoulMannequinEntity(
      app,
      hs,
      materials,
      fxManager,
      glbRegistry || undefined
    );
    app.root.addChild(mannequin.rootEntity);
    targets.push(mannequin);

    physiologySystem.registerEntity({
      entityId: cfg.id,
      enableArmorPlates: cfg.archetype === 'HEAVY_ENFORCER',
      alertnessState: 'COMBAT_ALERT',
    });
  }

  if (tacticalAi) {
    tacticalAi.registerWaveTargets(targets.map((t) => t.healthState));
  }

  return targets;
}
