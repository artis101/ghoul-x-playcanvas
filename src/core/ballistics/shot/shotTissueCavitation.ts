import {
  AmmoSpec,
  ProjectileState,
  TargetHealthState,
  Vec3Like,
  WoundChannelEvent,
} from '../../../contracts/ballistics.ts';
import { scale } from '../vec3.ts';
import { HitCandidate } from './shotTypes.ts';

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
  bulletDir: Vec3Like
): TissueCavitationResult {
  const col = hit.collider;

  if (col.layerType === 'SOFT_FLESH' || col.layerType.startsWith('ORGAN_')) {
    const maxDiam = ammo.diameterM * ammo.tissueExpansionFactor;
    const expansionProgress = Math.min(1.0, hit.pathLen / 0.11);
    const targetDiam =
      ammo.diameterM * (1.0 + (ammo.tissueExpansionFactor - 1.0) * expansionProgress);
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
  const energyDeposited = Math.min(entryEnergy, energyLossRate * effectiveTissuePathM);

  const exitEnergy = Math.max(0, entryEnergy - energyDeposited);
  const exitSpeed = Math.sqrt((2 * exitEnergy) / ammo.massKg);

  const deltaP = ammo.massKg * (currentSpeed - exitSpeed);
  const impulseMagnitude =
    (deltaP + energyDeposited / 195.0) * ammo.ragdollImpulseMultiplier;
  const impulseVec = scale(bulletDir, impulseMagnitude);

  const pelletSynergy = ammo.pelletCount > 1 ? 1.48 : 1.0;
  const stoppingDamageMult = Math.pow(ammo.tissueExpansionFactor, 1.25) * pelletSynergy;
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
    col.layerType.startsWith('ORGAN_') && energyDeposited >= col.fractureThresholdJ;
  const arterialSevered =
    col.layerType === 'ARTERY_CAROTID_AORTA' && energyDeposited >= col.fractureThresholdJ;

  let physEffect = 'Soft Tissue Cavitation & Laceration';
  let weaponDisarmed = false;

  if (col.layerType === 'ORGAN_BRAIN' && organRuptured) {
    physEffect = 'CNS Cranial Disruption — Instant Neuromuscular Collapse';
  } else if (col.id === 'vol_neck_spine' && boneFractured) {
    physEffect = 'Cervical Spinal Cord Severance — Instant Paralysis';
  } else if (col.layerType === 'ORGAN_HEART' && organRuptured) {
    physEffect = 'Cardiac Ventricular Rupture — Catastrophic BP Loss';
  } else if (arterialSevered) {
    physEffect = `${col.label} Transected — Pulsing Arterial Hemorrhage`;
  } else if (
    (col.layerType === 'ORGAN_LUNG_LEFT' || col.layerType === 'ORGAN_LUNG_RIGHT') &&
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
      col.ghoulZone === 'THIGH_LEFT' ||
      col.ghoulZone === 'KNEE_LEFT' ||
      col.ghoulZone === 'SHIN_LEFT' ||
      col.ghoulZone === 'THIGH_RIGHT' ||
      col.ghoulZone === 'KNEE_RIGHT' ||
      col.ghoulZone === 'SHIN_RIGHT' ||
      col.ghoulZone === 'PELVIS_GROIN';
    const isArm =
      col.ghoulZone === 'UPPER_ARM_LEFT' ||
      col.ghoulZone === 'FOREARM_LEFT' ||
      col.ghoulZone === 'UPPER_ARM_RIGHT' ||
      col.ghoulZone === 'FOREARM_RIGHT';
    if (isLeg) {
      physEffect = `${col.label} Fractured — Structural Leg Collapse`;
    } else if (isArm) {
      physEffect = `${col.label} Shattered — Combatant Disarmed`;
      weaponDisarmed = true;
    } else {
      physEffect = `${col.label} Comminuted Fracture`;
    }
  }

  const isTriggerArmZone = target.isLeftHanded
    ? col.ghoulZone === 'HAND_RIGHT' ||
      col.ghoulZone === 'FOREARM_RIGHT' ||
      col.ghoulZone === 'UPPER_ARM_RIGHT'
    : col.ghoulZone === 'HAND_LEFT' ||
      col.ghoulZone === 'FOREARM_LEFT' ||
      col.ghoulZone === 'UPPER_ARM_LEFT';

  if (isTriggerArmZone && energyDeposited >= 65) {
    weaponDisarmed = true;
  }

  const headgearKnockedOff =
    (col.ghoulZone === 'HEAD_CRANIUM' || col.ghoulZone === 'HEAD_FACE_JAW') &&
    target.headgearIntact &&
    energyDeposited >= 45;

  const permRadiusCm = Math.max(
    0.4,
    proj.currentDiameterM * 100 * 0.5 * ammo.tissueExpansionFactor
  );
  const tempRadiusCm = Math.min(
    14.0,
    permRadiusCm * (currentSpeed / 120.0) * Math.sqrt(ammo.tissueExpansionFactor)
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

  if (exitEnergy < 15.0 || exitSpeed < 40.0) {
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
    physEffect,
    woundEvent,
  };
}
