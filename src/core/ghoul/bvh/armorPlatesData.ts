import { Tier1ArmorPlateVolume } from '../../../contracts/physiology.ts';
import { vec3 } from '../../ballistics/vec3.ts';

// ============================================================================
// TIER-1 EXACT ARMOR GEOMETRY (Swimmer/ESAPI Plates + Ops Helmet)
// Exposes Axillary/Armpit (|x| > 0.125, y in [1.31, 1.48]) and
// Supraclavicular/Collarbone (y in [1.465, 1.53]) anatomical gaps!
// ============================================================================
export const TIER1_ARMOR_PLATES: readonly Tier1ArmorPlateVolume[] = [
  {
    id: 'FRONT_ESAPI_PLATE',
    label: 'Front Thoracic Swimmer-Cut ESAPI Level IV Ceramic Plate',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'CERAMIC_ESAPI_IV',
    shape: 'OBB',
    localCenter: vec3(0, 1.32, 0.132),
    halfExtents: vec3(0.125, 0.14, 0.013), // x in [-0.125, 0.125], y in [1.18, 1.46]
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    swimmerCutCornerFraction: 0.22,
    thicknessM: 0.026,
    densityKgM3: 2850,
    maxStopEnergyJ: 4400,
    backfaceBluntTransferRatio: 0.095,
    degradationPerKilojoule: 0.22,
  },
  {
    id: 'BACK_ESAPI_PLATE',
    label: 'Rear Thoracic ESAPI Level IV Ceramic Plate',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'CERAMIC_ESAPI_IV',
    shape: 'OBB',
    localCenter: vec3(0, 1.32, -0.132),
    halfExtents: vec3(0.125, 0.14, 0.013), // x in [-0.125, 0.125], y in [1.18, 1.46]
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    swimmerCutCornerFraction: 0.16,
    thicknessM: 0.026,
    densityKgM3: 2850,
    maxStopEnergyJ: 4400,
    backfaceBluntTransferRatio: 0.095,
    degradationPerKilojoule: 0.22,
  },
  {
    id: 'SIDE_SAPI_LEFT',
    label: 'Left Cummerbund 6x6 Side SAPI Plate (Lower Flank)',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'UHMWPE_III_PLUS',
    shape: 'OBB',
    localCenter: vec3(-0.184, 1.22, 0.0),
    halfExtents: vec3(0.011, 0.070, 0.075), // y in [1.15, 1.29] — leaves upper armpit open!
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    thicknessM: 0.022,
    densityKgM3: 1850,
    maxStopEnergyJ: 2650,
    backfaceBluntTransferRatio: 0.12,
    degradationPerKilojoule: 0.28,
  },
  {
    id: 'SIDE_SAPI_RIGHT',
    label: 'Right Cummerbund 6x6 Side SAPI Plate (Lower Flank)',
    ghoulZone: 'TORSO_UPPER_THORAX',
    material: 'UHMWPE_III_PLUS',
    shape: 'OBB',
    localCenter: vec3(0.184, 1.22, 0.0),
    halfExtents: vec3(0.011, 0.070, 0.075), // y in [1.15, 1.29] — leaves upper armpit open!
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    thicknessM: 0.022,
    densityKgM3: 1850,
    maxStopEnergyJ: 2650,
    backfaceBluntTransferRatio: 0.12,
    degradationPerKilojoule: 0.28,
  },
  {
    id: 'HELMET_BALLISTIC_SHELL',
    label: 'High-Cut Aramid Ballistic Helmet Shell',
    ghoulZone: 'HEAD_CRANIUM',
    material: 'ARAMID_HELMET_IIIA',
    shape: 'SPHERE',
    localCenter: vec3(0, 1.735, -0.005),
    halfExtents: vec3(0.108, 0.082, 0.114),
    basisRight: vec3(1, 0, 0),
    basisUp: vec3(0, 1, 0),
    basisForward: vec3(0, 0, 1),
    thicknessM: 0.009,
    densityKgM3: 1440,
    maxStopEnergyJ: 950,
    backfaceBluntTransferRatio: 0.18,
    degradationPerKilojoule: 0.45,
  },
];
