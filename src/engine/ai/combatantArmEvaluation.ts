import { triggerSide } from '../../core/ghoul/anatomy/handedness.ts';
import type { EnemyArchetypeId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { ActiveFiringHand, CombatantResolveProfile } from './tacticalAiTypes.ts';

export function hashCombatantTargetId(targetId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < targetId.length; i++) {
    h ^= targetId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function isArmChainIntactAndFunctional(
  hs: TargetHealthState,
  hand: ActiveFiringHand
): boolean {
  if (hand === 'RIGHT') {
    return (
      hs.rightArmFunctional &&
      !hs.severedZones.has('HAND_RIGHT') &&
      !hs.severedZones.has('FOREARM_RIGHT') &&
      !hs.severedZones.has('UPPER_ARM_RIGHT') &&
      !hs.severedZones.has('SHOULDER_RIGHT')
    );
  }
  return (
    hs.leftArmFunctional &&
    !hs.severedZones.has('HAND_LEFT') &&
    !hs.severedZones.has('FOREARM_LEFT') &&
    !hs.severedZones.has('UPPER_ARM_LEFT') &&
    !hs.severedZones.has('SHOULDER_LEFT')
  );
}

export function getPreferredPrimaryHand(hs: TargetHealthState): ActiveFiringHand {
  return triggerSide(hs.isLeftHanded);
}

export function selectIntactFiringHand(
  hs: TargetHealthState,
  preferred: ActiveFiringHand
): ActiveFiringHand | null {
  const rightIntact = isArmChainIntactAndFunctional(hs, 'RIGHT');
  const leftIntact = isArmChainIntactAndFunctional(hs, 'LEFT');
  if (preferred === 'RIGHT' && rightIntact) return 'RIGHT';
  if (preferred === 'LEFT' && leftIntact) return 'LEFT';
  if (rightIntact) return 'RIGHT';
  if (leftIntact) return 'LEFT';
  return null;
}

export function wrapAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function approachAngleRad(current: number, target: number, maxStep: number): number {
  const diff = wrapAngleRad(target - current);
  if (Math.abs(diff) <= maxStep) {
    return wrapAngleRad(target);
  }
  return wrapAngleRad(current + Math.sign(diff) * maxStep);
}

export function yawToward(from: Vec3Like, to: Vec3Like, fallbackYaw: number): number {
  const x = to.x - from.x;
  const z = to.z - from.z;
  return Math.hypot(x, z) > 1e-3 ? Math.atan2(x, z) : fallbackYaw;
}

export function resolveDefaultCombatantProfile(
  targetId: string,
  archetype: EnemyArchetypeId
): { resolveProfile: CombatantResolveProfile; carriesBackupSidearm: boolean } {
  if (archetype === 'HEAVY_ENFORCER' || archetype === 'SNIPER_OPERATIVE') {
    return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
  }

  switch (targetId) {
    case 'target_0':
      return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: false };
    case 'target_1':
      return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: true };
    case 'target_2':
      return { resolveProfile: 'PANICKED_SCRAPPER', carriesBackupSidearm: false };
    case 'target_3':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
    case 'target_4':
      return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
    case 'hostile_alpha':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
    default:
      break;
  }

  const h = hashCombatantTargetId(targetId);
  if (archetype === 'SKINHEAD_PUNK') {
    return {
      resolveProfile: h % 2 === 0 ? 'FANATIC_BERSERKER' : 'PANICKED_SCRAPPER',
      carriesBackupSidearm: false,
    };
  }

  const bucket = h % 4;
  if (bucket === 1) {
    return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
  }
  if (bucket === 2) {
    return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: false };
  }
  if (bucket === 3) {
    return { resolveProfile: 'PANICKED_SCRAPPER', carriesBackupSidearm: false };
  }
  return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
}
