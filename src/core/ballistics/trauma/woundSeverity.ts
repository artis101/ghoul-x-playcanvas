import type { GhoulZoneId, WoundChannelEvent } from '../../../contracts/ballistics.ts';

/**
 * How badly one shot hurt a body part, judged from what the projectile actually did there:
 * how deep it went, how much energy it dumped, how wide a cavity it tore, and whether it opened
 * an artery, burst an organ or broke bone. A buckshot pellet that stops under the skin of the neck
 * and a rifle round that cuts the carotid both "hit the neck", but they are nothing alike.
 */
export type WoundSeverity = 'GRAZE' | 'PENETRATING' | 'CRITICAL';

export interface WoundSeverityReading {
  readonly severity: WoundSeverity;
  readonly depthCm: number;
  readonly energyJ: number;
  readonly arterial: boolean;
  readonly organ: boolean;
  readonly bone: boolean;
}

/** A channel shallower than this, with little energy and nothing vital cut, is a graze. */
const GRAZE_MAX_DEPTH_CM = 4;
const GRAZE_MAX_ENERGY_J = 90;
/** Deep, high-energy channels (through-and-through rifle hits) count as critical on their own. */
const CRITICAL_DEPTH_CM = 18;
const CRITICAL_ENERGY_J = 700;

export function gradeZoneWound(
  zone: GhoulZoneId,
  woundEvents: readonly WoundChannelEvent[],
): WoundSeverityReading {
  let depthCm = 0;
  let energyJ = 0;
  let arterial = false;
  let organ = false;
  let bone = false;
  for (const w of woundEvents) {
    if (w.armorStopped || w.ghoulZone !== zone) continue;
    depthCm += w.pathLengthM * 100;
    energyJ += w.energyDepositedJ;
    arterial ||= w.arterialSevered;
    organ ||= w.organRuptured;
    bone ||= w.boneFractured || w.boneShattered;
  }

  let severity: WoundSeverity = 'PENETRATING';
  if (arterial || organ || (depthCm >= CRITICAL_DEPTH_CM && energyJ >= CRITICAL_ENERGY_J)) {
    severity = 'CRITICAL';
  } else if (!bone && depthCm < GRAZE_MAX_DEPTH_CM && energyJ < GRAZE_MAX_ENERGY_J) {
    severity = 'GRAZE';
  }
  return { severity, depthCm, energyJ, arterial, organ, bone };
}
