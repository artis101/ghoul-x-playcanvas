import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantTriageStatus } from '../../core/ballistics/solver.ts';

export interface ProjectedTargetTriageEntry {
  state: TargetHealthState;
  screenX: number;
  screenY: number;
  visible: boolean;
}

export interface WorldTriagePlateDom {
  root: HTMLDivElement;
  triageLabel: HTMLSpanElement;
  hpNum: HTMLSpanElement;
  hpFill: HTMLDivElement;
  armorTrack: HTMLDivElement;
  armorFill: HTMLDivElement;
  barkPill?: HTMLDivElement;
  lastVisible: number;
  lastXTenths: number;
  lastYTenths: number;
  lastDead: number;
  lastStatus: string;
  lastStatusTag: string;
  lastHpClamped: number;
  lastHpTenths: number;
  lastArmorTenths: number;
  lastBark: string | null;
}

export function formatTriageLabel(status: CombatantTriageStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'HEALTHY';
    case 'WOUNDED':
      return 'WOUNDED';
    case 'MORTALLY_WOUNDED':
      return 'MORTALLY WOUNDED';
    case 'DEAD':
      return 'DEAD';
  }
}

export function triageColorClass(status: CombatantTriageStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'triage-healthy';
    case 'WOUNDED':
      return 'triage-wounded';
    case 'MORTALLY_WOUNDED':
      return 'triage-mortally-wounded';
    case 'DEAD':
      return 'triage-dead';
  }
}

export function triageCardClass(status: CombatantTriageStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'card-healthy';
    case 'WOUNDED':
      return 'card-wounded';
    case 'MORTALLY_WOUNDED':
      return 'card-mortally-wounded';
    case 'DEAD':
      return 'card-dead';
  }
}

export function queryEl(id: string): HTMLElement | null {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
    return null;
  }
  return document.getElementById(id);
}
