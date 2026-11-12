import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { MayhemDirector } from '../fx/mayhemDirector.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import type { CombatAudioEngine } from '../audio/combatAudioEngine.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';

export interface EnvironmentRayInterceptResult {
  remainingEnergyJ: number;
  remainingSpeedMs: number;
  blocked: boolean;
  stoppedDistanceM?: number;
  ricochetOriginWorld?: Vec3Like;
  ricochetDirWorld?: Vec3Like;
  ricochetSpeedMs?: number;
  ricochetEnergyJ?: number;
  ricochetSurface?: string;
}

export type EnvironmentRayInterceptor = (
  origin: Vec3Like,
  dir: Vec3Like,
  maxDistM: number,
  energyJ: number,
  speedMs: number,
  caliberDiameterM: number,
  isAp: boolean,
  armorPenetrationFactor?: number
) => EnvironmentRayInterceptResult;

export type ExplosionBlastHandler = (
  center: Vec3Like,
  radiusM: number,
  peakImpulseNs: number,
  peakEnergyJ: number
) => void;

export type CameraShakeCallback = (intensityDeg: number, durationS: number) => void;

export interface CombatDirectorSubsystems {
  mayhemDirector?: MayhemDirector | null;
  tacticalAi?: TacticalCombatAiSystem | null;
  combatAudio?: CombatAudioEngine | null;
  glbRegistry?: GlbModelRegistry | null;
  isLineOfSightBlocked?: (fromWorld: Vec3Like, toWorld: Vec3Like) => boolean;
  getCoverBreachVersion?: () => number;
  getPlayerEyePosition?: () => Vec3Like;
}

export interface ActiveBlastFlashFx {
  root: pc.Entity;
  fireball: pc.Entity;
  shockRing: pc.Entity;
  elapsedS: number;
  durationS: number;
  maxRadiusM: number;
}
