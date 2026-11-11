import { NeuralPlexusVolume } from '../../../contracts/physiology.ts';
import { vec3 } from '../../ballistics/vec3.ts';

// ============================================================================
// TIER-2 NEURAL PLEXUSES (Brachial Plexus C5–T1 Roots to Axillary Cord)
// ============================================================================
export const TIER2_NEURAL_PLEXUSES: readonly NeuralPlexusVolume[] = [
  {
    id: 'BRACHIAL_PLEXUS_LEFT',
    label: 'Left Brachial Plexus Trunk (C5–T1)',
    ghoulZone: 'SHOULDER_LEFT',
    side: 'LEFT',
    capsuleStart: vec3(-0.045, 1.505, -0.005),
    capsuleEnd: vec3(-0.205, 1.415, 0.005),
    capsuleRadiusM: 0.020,
  },
  {
    id: 'BRACHIAL_PLEXUS_RIGHT',
    label: 'Right Brachial Plexus Trunk (C5–T1)',
    ghoulZone: 'SHOULDER_RIGHT',
    side: 'RIGHT',
    capsuleStart: vec3(0.045, 1.505, -0.005),
    capsuleEnd: vec3(0.205, 1.415, 0.005),
    capsuleRadiusM: 0.020,
  },
];
