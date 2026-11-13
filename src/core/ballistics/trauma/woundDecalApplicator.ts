import {
  ShotSimulationReport,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { transitionTargetLifecycle } from '../lifecycle/targetLifecycleFsm.ts';
import { copyVec3, vec3 } from '../vec3.ts';
import { getArchetypeLoadout } from '../../ghoul/anatomy/archetypeLoadout.ts';

export function applyWoundsAndDecals(
  target: TargetHealthState,
  report: ShotSimulationReport
): { rightLegShotEnergyJ: number; leftLegShotEnergyJ: number } {
  const loadout = getArchetypeLoadout(target.archetype);
  target.currentHp = Math.max(0, target.currentHp - report.totalDamageHp);
  if (report.isLethalKill || target.currentHp <= 0) {
    transitionTargetLifecycle(target, { kind: 'LETHAL_DEATH' });
  }

  if (report.headgearKnockedOff) target.headgearIntact = false;
  if (report.weaponDisarmed) {
    transitionTargetLifecycle(target, { kind: 'PRIMARY_ARM_DISARM' });
  } else if (!target.alive) {
    target.weaponDropped = true;
  }

  for (const b of report.shatteredBones) target.fracturedBones.add(b);
  for (const o of report.rupturedOrgans) target.rupturedOrgans.add(o);

  let rightLegShotEnergyJ = 0;
  let leftLegShotEnergyJ = 0;

  for (const w of report.woundEvents) {
    if (!w.armorStopped) {
      const isRL = w.ghoulZone === 'THIGH_RIGHT' || w.ghoulZone === 'KNEE_RIGHT' || w.ghoulZone === 'SHIN_RIGHT' || w.ghoulZone === 'FOOT_RIGHT';
      const isLL = w.ghoulZone === 'THIGH_LEFT' || w.ghoulZone === 'KNEE_LEFT' || w.ghoulZone === 'SHIN_LEFT' || w.ghoulZone === 'FOOT_LEFT';
      if (isRL) rightLegShotEnergyJ += w.energyDepositedJ;
      else if (isLL) leftLegShotEnergyJ += w.energyDepositedJ;
    }

    if (w.armorStopped) {
      if (w.ghoulZone === 'HEAD_CRANIUM') {
        target.helmetArmorIntegrity = Math.max(0, target.helmetArmorIntegrity - loadout.helmetWearPerStop);
        if (target.helmetArmorIntegrity <= 5) target.headgearIntact = false;
      } else {
        target.chestArmorIntegrity = Math.max(0, target.chestArmorIntegrity - loadout.plateWearPerStop);
      }
    } else {
      if (w.layerType === 'SOFT_FLESH' || w.layerType === 'CORTICAL_BONE') {
        target.zoneCumulativeDamageJ[w.ghoulZone] = (target.zoneCumulativeDamageJ[w.ghoulZone] || 0) + w.energyDepositedJ * 0.55;
      }
      if (w.layerType === 'SOFT_FLESH') {
        const loss = Math.min(85, w.energyDepositedJ / 4.5);
        target.zoneIntegrity[w.ghoulZone] = Math.max(5, target.zoneIntegrity[w.ghoulZone] - loss);
        if (target.zoneGoreMode[w.ghoulZone] === 'INTACT' && w.energyDepositedJ > 25) {
          target.zoneGoreMode[w.ghoulZone] = 'LACERATED';
        }
        target.bloodLossRateMlPerSec += 2.2;
      }
    }

    if (w.arterialSevered) target.bloodLossRateMlPerSec += w.ghoulZone === 'NECK_CERVICAL' ? 140 : 52;
    if (w.layerType === 'ORGAN_HEART' && w.organRuptured) {
      target.bloodLossRateMlPerSec += 220;
      target.heartRateBpm = 0;
      target.systolicBpMmHg = 25;
    }
    if ((w.layerType === 'ORGAN_LUNG_RIGHT' || w.layerType === 'ORGAN_LUNG_LEFT') && w.organRuptured) {
      target.oxygenSaturationPct = Math.max(40, target.oxygenSaturationPct - 28);
      target.bloodLossRateMlPerSec += 26;
    }

    if (w.boneFractured) {
      if (w.ghoulZone === 'THIGH_RIGHT' || w.ghoulZone === 'KNEE_RIGHT' || w.ghoulZone === 'SHIN_RIGHT') target.rightLegFunctional = false;
      if (w.ghoulZone === 'THIGH_LEFT' || w.ghoulZone === 'KNEE_LEFT' || w.ghoulZone === 'SHIN_LEFT') target.leftLegFunctional = false;
      if (w.ghoulZone === 'PELVIS_GROIN') {
        target.rightLegFunctional = false;
        target.leftLegFunctional = false;
      }
      // Only a shattered arm stops working; a cracked bone is fought through. Losing the gun is
      // decided by the shot itself (a hit on the grip hand), reported as weaponDisarmed above.
      if (w.boneShattered && (w.ghoulZone === 'UPPER_ARM_RIGHT' || w.ghoulZone === 'FOREARM_RIGHT')) {
        target.rightArmFunctional = false;
      }
      if (w.boneShattered && (w.ghoulZone === 'UPPER_ARM_LEFT' || w.ghoulZone === 'FOREARM_LEFT')) {
        target.leftArmFunctional = false;
      }
    }

    if ((w.layerType === 'SOFT_FLESH' || w.armorStopped) && target.surfaceWounds.length < 28) {
      target.surfaceWounds.push({
        id: `sw_${target.surfaceWounds.length}_${w.ghoulZone}`,
        zone: w.ghoulZone,
        localOffset: copyVec3(w.localEntryOffset),
        localNormal: vec3(0, 0, 1),
        radiusM: w.armorStopped ? 0.018 : Math.min(0.042, Math.max(0.014, (w.permanentCavityRadiusCm / 100) * 1.8)),
        isExit: false,
        armorDent: w.armorStopped,
      });

      if (!w.armorStopped && w.exitEnergyJ > 25 && target.surfaceWounds.length < 28) {
        target.surfaceWounds.push({
          id: `sw_exit_${target.surfaceWounds.length}_${w.ghoulZone}`,
          zone: w.ghoulZone,
          localOffset: copyVec3(w.localExitOffset),
          localNormal: vec3(0, 0, -1),
          radiusM: Math.min(0.055, Math.max(0.022, (w.permanentCavityRadiusCm / 100) * 2.6)),
          isExit: true,
          armorDent: false,
        });
      }
    }
  }

  return { rightLegShotEnergyJ, leftLegShotEnergyJ };
}
