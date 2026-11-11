import {
  AmmoSpec,
  ProjectileState,
  Vec3Like,
  WoundChannelEvent,
} from '../../../contracts/ballistics.ts';
import { scale } from '../vec3.ts';
import { HitCandidate } from './shotTypes.ts';

export interface ArmorInteractionResult {
  stopped: boolean;
  bluntDamageHp: number;
  energyDeposited: number;
  impulseMagnitude: number;
  impulseVec: Vec3Like;
  headgearKnockedOff: boolean;
  effectMessage: string;
  woundEvent?: WoundChannelEvent;
}

export function evaluateArmorInteraction(
  proj: ProjectileState,
  ammo: AmmoSpec,
  hit: HitCandidate,
  currentSpeed: number,
  entryEnergy: number,
  bulletDir: Vec3Like
): ArmorInteractionResult {
  const col = hit.collider;
  const armorRatingFactor = ammo.armorPenetrationFactor * Math.pow(currentSpeed / 520, 0.85);
  const defeatedArmor = armorRatingFactor >= 1.15;

  if (!defeatedArmor) {
    const bluntTraumaJ = entryEnergy * 0.18;
    const bluntDamageHp = bluntTraumaJ / 16.0;
    const impulseMag =
      (ammo.massKg * currentSpeed + entryEnergy / 220.0) * ammo.ragdollImpulseMultiplier;
    const impulseVec = scale(bulletDir, impulseMag);

    let headgearKnockedOff = false;
    let effectMessage = 'NIJ IIIA Kevlar Stopped Projectile — Blunt Rib Trauma';
    if (col.ghoulZone === 'HEAD_CRANIUM' && entryEnergy > 180) {
      headgearKnockedOff = true;
      effectMessage = 'PASGT Helmet Deflected Round — Helmet Knocked Off!';
    }

    const armorWound: WoundChannelEvent = {
      colliderId: col.id,
      label: col.label,
      ghoulZone: col.ghoulZone,
      layerType: col.layerType,
      entryPointWorld: hit.entryWorld,
      exitPointWorld: hit.entryWorld,
      entryNormalWorld: hit.normalWorld,
      localEntryOffset: hit.localEntryOffset,
      localExitOffset: hit.localEntryOffset,
      impactDirectionWorld: bulletDir,
      pathLengthM: 0.015,
      entryVelocityMs: currentSpeed,
      exitVelocityMs: 0,
      entryEnergyJ: entryEnergy,
      exitEnergyJ: 0,
      energyDepositedJ: entryEnergy,
      impulseTransferredNs: impulseMag,
      permanentCavityRadiusCm: 0.8,
      temporaryStretchCavityRadiusCm: 2.5,
      armorStopped: true,
      bluntTraumaJ,
      boneFractured: false,
      boneShattered: false,
      organRuptured: false,
      limbSensoryShock: bluntTraumaJ > 65,
      limbSevered: false,
      arterialSevered: false,
      deflectionAngleDeg: 0,
      physiologicalEffect: 'Stopped by Kevlar Armor (Backface Blunt Trauma)',
    };

    proj.alive = false;

    return {
      stopped: true,
      bluntDamageHp,
      energyDeposited: entryEnergy,
      impulseMagnitude: impulseMag,
      impulseVec,
      headgearKnockedOff,
      effectMessage,
      woundEvent: armorWound,
    };
  } else {
    const armorEnergyCost = Math.min(entryEnergy * 0.22, 260 / ammo.armorPenetrationFactor);
    const exitE = Math.max(0, entryEnergy - armorEnergyCost);
    const exitSpd = Math.sqrt((2 * exitE) / ammo.massKg);
    proj.kineticEnergyJ = exitE;
    proj.velocity = scale(bulletDir, exitSpd);

    return {
      stopped: false,
      bluntDamageHp: 0,
      energyDeposited: armorEnergyCost,
      impulseMagnitude: 0,
      impulseVec: { x: 0, y: 0, z: 0 },
      headgearKnockedOff: false,
      effectMessage: `${col.label} Perforated by ${ammo.caliber}`,
    };
  }
}
