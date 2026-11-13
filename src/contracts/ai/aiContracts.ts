import type { Vec3Like } from '../ballistics.ts';
import type { VocalTraumaCue } from '../physiology/entityStateTypes.ts';

export type ActiveFiringHand = 'RIGHT' | 'LEFT';

export type EnemyFireMode = 'AGGRESSIVE_LETHAL' | 'CINEMATIC_SUPPRESSION';

export type AiBarkCategory =
  | 'CONTACT'
  | 'FLANKING'
  | 'SUPPRESSING'
  | 'RELOADING_COVER'
  | 'SIDEARM_TRANSITION'
  | 'ALLY_DOWN'
  | 'WOUNDED_TRAUMA'
  | 'BERSERKER_CHARGE'
  | 'HORROR_SHOCK'
  | 'TACTICAL_CALLOUT';

export type BrutalKillRewardKind =
  | 'CRANIAL_POP'
  | 'DECAPITATION'
  | 'SURGICAL_SEVER'
  | 'CLEAN_SEVER'
  | 'EVISCERATED'
  | 'MULTI_KILL_BLAST'
  | 'STANDARD_KILL';

export interface AiBarkPayload {
  readonly speakerId: string;
  readonly callsign: string;
  readonly category: AiBarkCategory;
  readonly text: string;
  readonly worldPos: Vec3Like;
  readonly isRadio: boolean;
  readonly vocalCue?: VocalTraumaCue;
  readonly durationS: number;
}

export type PlayerNearMissGrazeKind =
  | 'HELMET_DEFLECT'
  | 'NECK_ARTERIAL_GRAZE'
  | 'LAST_CHANCE_GATE';

export interface PlayerNearMissGrazePayload {
  readonly kind: PlayerNearMissGrazeKind;
  readonly side: 'RIGHT' | 'LEFT';
  readonly attackerId: string;
  readonly hitPointWorld: Vec3Like;
  readonly tinnitusIntensity: number;
  readonly tinnitusDurationS: number;
  readonly bleedRateHpPerSec: number;
  readonly helmetPopped: boolean;
}

export type PlayerSurvivalPhase =
  | { readonly kind: 'DEAD' }
  | { readonly kind: 'BLEEDING_URGENT'; readonly hpPerSec: number; readonly remainingS: number }
  | { readonly kind: 'RECOVERING_DELAY'; readonly quietElapsedS: number }
  | { readonly kind: 'REGENERATING' }
  | { readonly kind: 'FULL_HEALTH' };

export type HealthGateState =
  | { readonly kind: 'READY' }
  | {
      readonly kind: 'INVULNERABLE_WINDOW';
      readonly remainingS: number;
      readonly gateReady: boolean;
    }
  | { readonly kind: 'RECHARGING'; readonly quietElapsedS: number };

export type ArterialBleedState =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'BLEEDING'; readonly hpPerSec: number; readonly remainingS: number };

export interface PlayerCombatVitals {
  health: number;
  maxHealth: number;
  armor: number;
  maxArmor: number;
  damageEnabled: boolean;
  timeSinceLastHitS: number;
  invulnerabilityRemainingS: number;
  healthGateReady?: boolean;
  helmetIntact?: boolean;
  urgentBleedHpPerSec?: number;
  urgentBleedRemainingS?: number;
  survivalPhase?: PlayerSurvivalPhase;
  healthGate?: HealthGateState;
  arterialBleed?: ArterialBleedState;
}
