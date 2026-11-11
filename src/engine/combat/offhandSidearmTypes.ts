import * as pc from 'playcanvas';
import type { GhoulZoneId } from '../../contracts/ballistics.ts';
import type { WeaponGlbInstance } from '../assets/glbLoader.ts';
import type { ActiveFiringHand } from '../ai/tacticalCombatAi.ts';

export interface OffhandSidearmRig {
  targetId: string;
  holderEntity: pc.Entity;
  glbInstance: WeaponGlbInstance | null;
  isGlbModel: boolean;
  wasHeldLastFrame: boolean;
  lastHand: ActiveFiringHand | null;
  clonedMaterials: pc.StandardMaterial[];
  cachedBoneEntities: Map<GhoulZoneId, pc.Entity | null>;
}
