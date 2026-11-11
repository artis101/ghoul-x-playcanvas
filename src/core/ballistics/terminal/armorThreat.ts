import { AmmoSpec } from '../../../contracts/ballistics.ts';
import { Tier1ArmorPlateVolume } from '../../../contracts/physiology.ts';

export function computeEffectivePlateThreatJ(
  plate: Tier1ArmorPlateVolume,
  ammo: AmmoSpec,
  kineticEnergyJ: number
): number {
  if (plate.material === 'CERAMIC_ESAPI_IV') {
    if (ammo.type === 'JHP' || ammo.type === 'BUCKSHOT_00') {
      return kineticEnergyJ * 0.62;
    }
    if (ammo.type === 'AP' && ammo.armorPenetrationFactor >= 2.0) {
      // Dedicated tungsten-carbide sub-caliber penetrator (e.g. M993) concentrates stress on ceramic tile
      return kineticEnergyJ * (ammo.armorPenetrationFactor * 0.64);
    }
    // Standard copper/lead/mild-steel FMJ ball (5.56 M855, 7.62 M80/M118LR): Level IV ceramic defeats 1st round
    return kineticEnergyJ * 0.88;
  }

  if (plate.material === 'UHMWPE_III_PLUS') {
    if (ammo.type === 'AP') {
      return kineticEnergyJ * (ammo.armorPenetrationFactor * 0.82);
    }
    if (ammo.type === 'JHP' || ammo.type === 'BUCKSHOT_00') {
      return kineticEnergyJ * 0.68;
    }
    return kineticEnergyJ * 0.95;
  }

  // Aramid IIIA Helmet Shell: stops pistol/buckshot/fragments, penetrated by rifle FMJ/AP
  if (ammo.type === 'AP' || (ammo.type === 'FMJ' && ammo.diameterM <= 0.0086 && kineticEnergyJ > 1100)) {
    return kineticEnergyJ * Math.max(1.25, ammo.armorPenetrationFactor);
  }
  return kineticEnergyJ * 0.85;
}
