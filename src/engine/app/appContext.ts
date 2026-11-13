import type * as pc from 'playcanvas';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { HudController } from '../hudController.ts';
import type { CombatAudioEngine } from '../audio/combatAudioEngine.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import type { MayhemDirector } from '../fx/mayhemDirector.ts';
import type { DestructionManager } from '../destruction/destructionManager.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { ArenaBuilder } from '../world/arenaBuilder.ts';
import type { FpsController } from '../player/fpsController.ts';
import type { ArsenalManager } from '../player/arsenalManager.ts';
import type { CombatDirector } from '../combat/combatDirector.ts';
import type { CinematicFrame } from './cinematicFrame.ts';

export interface IGhoulXApp {
  readonly canvas: HTMLCanvasElement;
  readonly app: pc.Application;
  readonly rapierWorld: RapierPhysicsWorld;
  readonly materials: EngineMaterialPalette;
  readonly hudController: HudController;
  readonly combatAudio: CombatAudioEngine;
  readonly glbRegistry: GlbModelRegistry;
  readonly mayhemDirector: MayhemDirector;
  readonly destructionManager: DestructionManager;
  readonly tacticalAi: TacticalCombatAiSystem;
  readonly fxManager: GoreAndBallisticsFxManager;
  readonly arenaBuilder: ArenaBuilder;
  readonly fpsController: FpsController;
  readonly cinematicFrame: CinematicFrame;
  readonly arsenalManager: ArsenalManager;
  readonly combatDirector: CombatDirector;
  totalElapsedTimeS: number;
}
