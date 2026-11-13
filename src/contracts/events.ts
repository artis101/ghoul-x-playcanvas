import type { AmmoSpec, GhoulZoneId, Vec3Like, WeaponSpec } from './ballistics.ts';
import type {
  AiBarkCategory,
  AiBarkPayload,
  BrutalKillRewardKind,
  EnemyFireMode,
  PlayerCombatVitals,
  PlayerNearMissGrazeKind,
  PlayerNearMissGrazePayload,
} from './ai/aiContracts.ts';
import type { BlastEvent } from './destruction.ts';
import type {
  AssetLoadProgressEvent,
  PreloadPhaseId,
  PreloadProgressCallback,
  PreloadProgressSnapshot,
} from './preloader.ts';

export type {
  AiBarkCategory,
  AiBarkPayload,
  AssetLoadProgressEvent,
  BrutalKillRewardKind,
  EnemyFireMode,
  PlayerCombatVitals,
  PlayerNearMissGrazeKind,
  PlayerNearMissGrazePayload,
  PreloadPhaseId,
  PreloadProgressCallback,
  PreloadProgressSnapshot,
};

export interface WeaponFiredPayload {
  weapon: WeaponSpec;
  ammo: AmmoSpec;
  eyeVec: Vec3Like;
  aimVec: Vec3Like;
  muzzleVec: Vec3Like;
}

export interface WeaponSwitchedPayload {
  weapon: WeaponSpec;
  index: number;
}

export interface WeaponAmmoCyclePayload {
  weaponId: string;
  ammo: AmmoSpec;
}

export interface WeaponReloadStartPayload {
  weapon: WeaponSpec;
  durationS: number;
}

export interface PlayerDamagePayload {
  damage: number;
  source: string;
  vitals: PlayerCombatVitals;
}

export interface PlayerShakePayload {
  intensityDeg: number;
  durationS: number;
}

export interface CombatShotFiredPayload {
  weapon: WeaponSpec;
  ammo: AmmoSpec;
  origin: Vec3Like;
  direction: Vec3Like;
}

export interface CombatTargetHitPayload {
  targetId: string;
  zoneId: GhoulZoneId;
  damage: number;
  isLethal: boolean;
}

export interface CombatWaveEventPayload {
  waveIndex: number;
}

export interface DestructionWallBreachedPayload {
  wallId: string;
  breachVersion: number;
}

export interface FxCasingBouncePayload {
  position: Vec3Like;
  isShotgunHull: boolean;
}

export interface FxSurfaceImpactPayload {
  position: Vec3Like;
  normal: Vec3Like;
  surface: string;
  energyJ: number;
}

export interface HudToastPayload {
  tag: string;
  message: string;
}

export interface HudKillfeedPayload {
  subject: string;
  tag: string;
  outcome: string;
  isLethal: boolean;
}

export interface HudScopeOverlayPayload {
  active: boolean;
  zoom?: number;
  range?: number;
  dropCm?: number;
}

export interface AppEventMap {
  'weapon:fired': WeaponFiredPayload;
  'weapon:switched': WeaponSwitchedPayload;
  'weapon:ammo_cycle': WeaponAmmoCyclePayload;
  'weapon:reload_start': WeaponReloadStartPayload;
  'player:damage': PlayerDamagePayload;
  'player:near_miss_graze': PlayerNearMissGrazePayload;
  'player:shake': PlayerShakePayload;
  'ai:bark': AiBarkPayload;
  'combat:shot_fired': CombatShotFiredPayload;
  'combat:target_hit': CombatTargetHitPayload;
  'combat:wave_spawn': CombatWaveEventPayload;
  'combat:wave_cleared': CombatWaveEventPayload;
  'destruction:blast': BlastEvent;
  'destruction:wall_breached': DestructionWallBreachedPayload;
  'fx:casing_bounce': FxCasingBouncePayload;
  'fx:surface_impact': FxSurfaceImpactPayload;
  'hud:toast': HudToastPayload;
  'hud:killfeed': HudKillfeedPayload;
  'hud:vitals_updated': { vitals: PlayerCombatVitals };
  'hud:scope_overlay': HudScopeOverlayPayload;
  'preloader:progress': PreloadProgressSnapshot;
  'preloader:complete': { totalElapsedMs: number; compiledShaders: number; loadedAssets: number };
  'preloader:error': { phase: PreloadPhaseId; message: string };
}
