import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  CharacterTransform,
  InternalBallisticsInput,
  PHYSIOLOGY_CONSTANTS,
} from '../../../contracts/physiology.ts';
import {
  AnatomicalBvh,
  DEFAULT_CHARACTER_TRANSFORM,
  RayIntervalHit,
  transformWorldRayToCharacterLocal,
} from '../../ghoul/bvhVolumes.ts';
import { add, copyVec3, scale } from '../vec3.ts';
import {
  classifyTerminalBehavior,
  computeProjectileLengthM,
  createInitialPlateIntegrityMap,
  ProjectileTerminalBehavior,
} from './projectileBehavior.ts';

export interface MarcherInitialState {
  transform: CharacterTransform;
  stepSizeM: number;
  maxMarchDistanceM: number;
  stretchVelocityThresholdMs: number;
  spitzerFragmentVelocityThresholdMs: number;
  enableArmorPlates: boolean;
  enableHelmet: boolean;
  seed: number;
  plateIntegrityAfter: Record<string, number>;
  entryVelocityMs: number;
  entryEnergyJ: number;
  initialDirLocal: Vec3Like;
  broadphase: RayIntervalHit;
  behavior: ProjectileTerminalBehavior;
  projectileLengthM: number;
  projectileMassKg: number;
  currentDirLocal: Vec3Like;
  currentPosLocal: Vec3Like;
  currentEnergyJ: number;
  currentVelocityMs: number;
  yawAngleDeg: number;
  peakYawAngleDeg: number;
  effectiveCaliberM: number;
  maxStepCount: number;
}

export function initializeMarcherState(
  input: InternalBallisticsInput,
  bvh: AnatomicalBvh
): MarcherInitialState {
  const transform: CharacterTransform = input.characterTransform ?? DEFAULT_CHARACTER_TRANSFORM;
  const config = input.config ?? {};
  const stepSizeM = config.stepSizeM ?? PHYSIOLOGY_CONSTANTS.DEFAULT_RAYMARCH_STEP_M;
  const maxMarchDistanceM = config.maxMarchDistanceM ?? 0.90;
  const stretchVelocityThresholdMs =
    config.stretchVelocityThresholdMs ?? PHYSIOLOGY_CONSTANTS.STRETCH_CAVITY_VELOCITY_THRESHOLD_MS;
  const spitzerFragmentVelocityThresholdMs =
    config.spitzerFragmentVelocityThresholdMs ??
    PHYSIOLOGY_CONSTANTS.SPITZER_FRAGMENT_VELOCITY_THRESHOLD_MS;
  const enableArmorPlates = config.enableArmorPlates ?? true;
  const enableHelmet = config.enableHelmet ?? true;
  const seed = config.deterministicSeed ?? 1337;

  const plateIntegrityAfter = createInitialPlateIntegrityMap(config.initialPlateIntegrity);
  const { ammo } = input;
  const entryVelocityMs = Math.max(0, input.impactVelocityMs);
  const entryEnergyJ = 0.5 * ammo.massKg * entryVelocityMs * entryVelocityMs;

  const { originLocal, directionLocal: initialDirLocal } = transformWorldRayToCharacterLocal(
    input.rayOriginWorld,
    input.rayDirectionWorld,
    transform
  );

  const broadphase = bvh.intersectTier1Broadphase(originLocal, initialDirLocal);
  const behavior = classifyTerminalBehavior(ammo, entryVelocityMs);
  const projectileLengthM = computeProjectileLengthM(ammo, behavior);
  const projectileMassKg = ammo.massKg;

  const currentDirLocal = copyVec3(initialDirLocal);
  const currentPosLocal = add(
    originLocal,
    scale(currentDirLocal, Math.max(0, (broadphase.hit ? broadphase.tMin : 0) - 0.006))
  );

  const yawAngleDeg = config.initialYawAngleDeg ?? 1.5;
  const maxSpanM = Math.min(
    maxMarchDistanceM,
    broadphase.hit ? broadphase.tMax - broadphase.tMin + 0.14 : 0
  );
  const maxStepCount = Math.ceil(maxSpanM / stepSizeM) + 4;

  return {
    transform,
    stepSizeM,
    maxMarchDistanceM,
    stretchVelocityThresholdMs,
    spitzerFragmentVelocityThresholdMs,
    enableArmorPlates,
    enableHelmet,
    seed,
    plateIntegrityAfter,
    entryVelocityMs,
    entryEnergyJ,
    initialDirLocal,
    broadphase,
    behavior,
    projectileLengthM,
    projectileMassKg,
    currentDirLocal,
    currentPosLocal,
    currentEnergyJ: entryEnergyJ,
    currentVelocityMs: entryVelocityMs,
    yawAngleDeg,
    peakYawAngleDeg: yawAngleDeg,
    effectiveCaliberM: ammo.diameterM,
    maxStepCount,
  };
}
