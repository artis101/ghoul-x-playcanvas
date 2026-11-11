import * as pc from 'playcanvas';
import type { CharacterTransform, PhysiologicalEntityState, VesselKind } from '../../../contracts/physiology.ts';

export interface VascularBloodMaterials {
  readonly arterialJetMat: pc.StandardMaterial;
  readonly arterialPoolMat: pc.StandardMaterial;
  readonly venousOozeMat: pc.StandardMaterial;
  readonly venousPoolMat: pc.StandardMaterial;
}

export interface ActiveVascularParticle {
  readonly entity: pc.Entity;
  readonly vesselKind: VesselKind;
  readonly position: pc.Vec3;
  readonly velocity: pc.Vec3;
  ageS: number;
  readonly maxLifeS: number;
}

export interface ActiveVascularFloorPool {
  readonly entity: pc.Entity;
  readonly vesselKind: VesselKind;
  readonly centerX: number;
  readonly centerZ: number;
  currentRadiusM: number;
  targetRadiusM: number;
  growthRateMPerSec: number;
}

export interface ActiveVascularMistPuff {
  readonly entity: pc.Entity;
  readonly position: pc.Vec3;
  readonly velocity: pc.Vec3;
  ageS: number;
  readonly maxLifeS: number;
  readonly startScale: number;
  readonly endScale: number;
}

export interface BoundPhysiologyEmitter {
  readonly state: PhysiologicalEntityState;
  readonly getTransform?: () => CharacterTransform;
  readonly woundTimers: Map<string, number>;
}
