import { triggerSide } from '../../ghoul/anatomy/handedness.ts';
import {
  AmmoSpec,
  ProjectileState,
  TargetHealthState,
  Vec3Like,
  WoundChannelEvent,
} from '../../../contracts/ballistics.ts';
import { scale } from '../vec3.ts';
import { HitCandidate } from './shotTypes.ts';
import { WEAPON_DROP_CHANCE, rollsWeaponDrop } from '../../combatant/weaponDropRoll.ts';
import {
  PelletVariance,
  depositScaleAtDepth,
  jitterThreshold,
  rollsRibGlance,
} from './terminalVariance.ts';
import { pelletExpansionAtSpeed, pelletPatternSynergy } from './buckshotRangeFalloff.ts';

export interface TissueCavitationResult {
  layerDamage: number;
  energyDeposited: number;
  impulseMagnitude: number;
  impulseVec: Vec3Like;
  boneFractured: boolean;
  boneShattered: boolean;
  organRuptured: boolean;
  arterialSevered: boolean;
  headgearKnockedOff: boolean;
  weaponDisarmed: boolean;
  /** The round skated off a rib and went no deeper. */
  ribGlance: boolean;
  physEffect: string;
  woundEvent: WoundChannelEvent;
}

export function evaluateTissueCavitation(
  proj: ProjectileState,
  ammo: AmmoSpec,
  target: TargetHealthState,
  hit: HitCandidate,
  currentSpeed: number,
  entryEnergy: number,
  bulletDir: Vec3Like,
  variance?: PelletVariance,
  tissueDepthM = 0,
  /** Speed the pellet struck the body at; buckshot deforms less the slower it lands. */
  impactSpeedMs = currentSpeed
): TissueCavitationResult {
  const col = hit.collider;
  const expansion = pelletExpansionAtSpeed(ammo, impactSpeedMs);

  if (col.layerType === 'SOFT_FLESH' || col.layerType.startsWith('ORGAN_')) {
    const maxDiam = ammo.diameterM * expansion;
    const expansionProgress = Math.min(1.0, hit.pathLen / 0.11);
    const targetDiam =
      ammo.diameterM * (1.0 + (expansion - 1.0) * expansionProgress);
    proj.currentDiameterM = Math.min(maxDiam, Math.max(proj.currentDiameterM, targetDiam));
  }

  const diamRatio = proj.currentDiameterM / ammo.diameterM;
  const resistanceBase = 1550 * col.stoppingPowerFactor * (col.densityKgM3 / 1000);
  const penetrationMultiplier =
    col.layerType === 'CORTICAL_BONE'
      ? 1.0 / Math.pow(ammo.armorPenetrationFactor, 1.45)
      : Math.pow(diamRatio, 2.2);
  const energyLossRate = resistanceBase * penetrationMultiplier;
  const effectiveTissuePathM =
    col.id === 'vol_thorax_ribcage' ? Math.min(hit.pathLen, 0.055) : hit.pathLen;
  const depthScale = variance ? depositScaleAtDepth(variance, tissueDepthM) : 1;
  const ribGlance = variance ? rollsRibGlance(variance, col.id, entryEnergy) : false;
  const energyDeposited = ribGlance
    ? Math.min(entryEnergy, entryEnergy * (0.08 + variance!.rng() * 0.12))
    : Math.min(entryEnergy, energyLossRate * effectiveTissuePathM * depthScale);
  const organThresholdJ = variance ? jitterThreshold(variance, col.fractureThresholdJ) : col.fractureThresholdJ;

  const exitEnergy = Math.max(0, entryEnergy - energyDeposited);
  const exitSpeed = Math.sqrt((2 * exitEnergy) / ammo.massKg);

  const deltaP = ammo.massKg * (currentSpeed - exitSpeed);
  const impulseMagnitude =
    (deltaP + energyDeposited / 195.0) * ammo.ragdollImpulseMultiplier;
  const impulseVec = scale(bulletDir, impulseMagnitude);

  // A tight pattern's overlapping channels hit harder; downrange the pellets are separate wounds.
  const pelletSynergy = pelletPatternSynergy(ammo, proj.distanceTraveledM);
  const stoppingDamageMult = Math.pow(expansion, 1.25) * pelletSynergy;
  const layerDamage =
    (energyDeposited / 36.0) * col.vitalityMultiplier * stoppingDamageMult;

  const highEnergyBonePerforation =
    col.layerType === 'CORTICAL_BONE' &&
    entryEnergy >= col.fractureThresholdJ * 3.5 &&
    hit.pathLen >= 0.025;
  const boneFractured =
    col.layerType === 'CORTICAL_BONE' &&
    (energyDeposited >= col.fractureThresholdJ || highEnergyBonePerforation);
  const boneShattered =
    boneFractured &&
    (energyDeposited >= col.fractureThresholdJ * 1.8 ||
      ammo.goreFactor >= 2.2 ||
      entryEnergy >= col.fractureThresholdJ * 6.0);
  const organRuptured =
    col.layerType.startsWith('ORGAN_') && energyDeposited >= organThresholdJ;
  const arterialSevered =
    col.layerType === 'ARTERY_CAROTID_AORTA' && energyDeposited >= organThresholdJ;

  let physEffect = 'Soft Tissue Cavitation & Laceration';
  let weaponDisarmed = false;

  if (ribGlance) {
    physEffect = 'Round Skated Off a Rib — Lucky';
  } else if (col.layerType === 'ORGAN_BRAIN' && organRuptured) {
    physEffect = 'CNS Cranial Disruption — Instant Neuromuscular Collapse';
  } else if (col.id === 'vol_neck_spine' && boneFractured) {
    physEffect = 'Cervical Spinal Cord Severance — Instant Paralysis';
  } else if (col.layerType === 'ORGAN_HEART' && organRuptured) {
    physEffect = 'Cardiac Ventricular Rupture — Catastrophic BP Loss';
  } else if (arterialSevered) {
    physEffect = `${col.label} Transected — Pulsing Arterial Hemorrhage`;
  } else if (
    (col.layerType === 'ORGAN_LUNG_RIGHT' || col.layerType === 'ORGAN_LUNG_LEFT') &&
    organRuptured
  ) {
    physEffect = `${col.label} Perforation — Tension Pneumothorax`;
  } else if (
    (col.layerType === 'ORGAN_STOMACH_GUT' || col.layerType === 'ORGAN_LIVER') &&
    organRuptured
  ) {
    physEffect = `${col.label} Hydrostatic Rupture — Visceral Shock`;
  } else if (boneFractured) {
    const isLeg =
      col.ghoulZone === 'THIGH_RIGHT' ||
      col.ghoulZone === 'KNEE_RIGHT' ||
      col.ghoulZone === 'SHIN_RIGHT' ||
      col.ghoulZone === 'THIGH_LEFT' ||
      col.ghoulZone === 'KNEE_LEFT' ||
      col.ghoulZone === 'SHIN_LEFT' ||
      col.ghoulZone === 'PELVIS_GROIN';
    const isArm =
      col.ghoulZone === 'UPPER_ARM_RIGHT' ||
      col.ghoulZone === 'FOREARM_RIGHT' ||
      col.ghoulZone === 'UPPER_ARM_LEFT' ||
      col.ghoulZone === 'FOREARM_LEFT';
    if (isLeg) {
      physEffect = `${col.label} Fractured — Structural Leg Collapse`;
    } else if (isArm) {
      // A broken arm hurts but does not open the hand; they keep fighting with it.
      physEffect = `${col.label} Fractured — Fighting Through It`;
    } else {
      physEffect = `${col.label} Comminuted Fracture`;
    }
  }

  const trigger = triggerSide(target.isLeftHanded);
  // Only a hit to the hand on the grip, or a forearm shattered so the hand cannot close, can make a
  // combatant let go of the gun, and even then usually they hang on. Hits higher up are fought through.
  const hitGripHand = col.ghoulZone === `HAND_${trigger}` && energyDeposited >= 30;
  const shatteredGripForearm = col.ghoulZone === `FOREARM_${trigger}` && boneShattered;
  const dropChance = hitGripHand ? WEAPON_DROP_CHANCE.GRIP_HAND_HIT : WEAPON_DROP_CHANCE.SHATTERED_GRIP_ARM;
  if ((hitGripHand || shatteredGripForearm) && rollsWeaponDrop(variance ? variance.rng() : null, dropChance)) {
    weaponDisarmed = true;
    physEffect = `${col.label} Hit — Weapon Knocked From Grip`;
  }

  const headgearKnockedOff =
    (col.ghoulZone === 'HEAD_CRANIUM' || col.ghoulZone === 'HEAD_FACE_JAW') &&
    target.headgearIntact &&
    energyDeposited >= 45;

  const permRadiusCm = Math.max(
    0.4,
    proj.currentDiameterM * 100 * 0.5 * expansion
  );
  const tempRadiusCm = Math.min(
    14.0,
    permRadiusCm * (currentSpeed / 120.0) * Math.sqrt(expansion)
  );

  const woundEvent: WoundChannelEvent = {
    colliderId: col.id,
    label: col.label,
    ghoulZone: col.ghoulZone,
    layerType: col.layerType,
    entryPointWorld: hit.entryWorld,
    exitPointWorld: hit.exitWorld,
    entryNormalWorld: hit.normalWorld,
    localEntryOffset: hit.localEntryOffset,
    localExitOffset: hit.localExitOffset,
    impactDirectionWorld: bulletDir,
    pathLengthM: hit.pathLen,
    entryVelocityMs: currentSpeed,
    exitVelocityMs: exitSpeed,
    entryEnergyJ: entryEnergy,
    exitEnergyJ: exitEnergy,
    energyDepositedJ: energyDeposited,
    impulseTransferredNs: impulseMagnitude,
    permanentCavityRadiusCm: permRadiusCm,
    temporaryStretchCavityRadiusCm: tempRadiusCm,
    armorStopped: false,
    bluntTraumaJ: 0,
    boneFractured,
    boneShattered,
    organRuptured,
    limbSensoryShock: energyDeposited > 130,
    limbSevered: false,
    arterialSevered,
    deflectionAngleDeg: 1.2 * (col.layerType === 'CORTICAL_BONE' ? 3.5 : 1.0),
    physiologicalEffect: physEffect,
  };

  proj.penetratedLayers++;
  proj.kineticEnergyJ = exitEnergy;
  proj.velocity = scale(bulletDir, exitSpeed);

  // A round that skates off a rib leaves the chest along the ribcage instead of going deeper.
  if (ribGlance || exitEnergy < 15.0 || exitSpeed < 40.0) {
    proj.alive = false;
  }

  return {
    layerDamage,
    energyDeposited,
    impulseMagnitude,
    impulseVec,
    boneFractured,
    boneShattered,
    organRuptured,
    arterialSevered,
    headgearKnockedOff,
    weaponDisarmed,
    ribGlance,
    physEffect,
    woundEvent,
  };
}
