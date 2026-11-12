import {
  EnemyArchetypeId,
  GhoulZoneId,
  GoreMode,
} from '../../../contracts/ballistics/ghoulZoneContracts';
import { ALL_GHOUL_ZONES } from './ghoulHierarchyTypes';
import {
  AuxParticleId,
  AuxRagdollParticle,
  RagdollBoneState,
  TargetHealthState,
} from '../../../contracts/ballistics/targetHealthContracts';
import { Vec3Like, copyVec3, vec3 } from '../../ballistics/vec3';
import { ALL_AUX_PARTICLES, AUX_PARTICLE_REST_LOCAL } from './ghoulAuxParticles';
import { GHOUL_ZONE_HIERARCHY } from './ghoulHierarchy';
import { buildRagdollConstraints } from './ragdollConstraints';
import { recomputeRagdollBasisVectors } from './ragdollBasis';

/** Realistic ~12.5% human left-handedness (southpaw) incidence within 10–15% range */
export const LEFT_HANDED_PROBABILITY = 0.125;

/**
 * Creates an initialized TargetHealthState with full integrity, PBD ragdoll particles, and archetype gear.
 */
export function createTargetHealthState(
  targetId: string,
  name: string,
  worldPosition: Vec3Like,
  yawRad = 0,
  archetype: EnemyArchetypeId = 'MILITIA_GUNNER',
  isLeftHanded = false
): TargetHealthState {
  const zoneIntegrity: Record<GhoulZoneId, number> = {} as Record<GhoulZoneId, number>;
  const zoneCumulativeDamageJ: Record<GhoulZoneId, number> = {} as Record<GhoulZoneId, number>;
  const zoneGoreMode: Record<GhoulZoneId, GoreMode> = {} as Record<GhoulZoneId, GoreMode>;
  const ragdollBones: Record<GhoulZoneId, RagdollBoneState> = {} as Record<GhoulZoneId, RagdollBoneState>;
  const auxParticles: Record<AuxParticleId, AuxRagdollParticle> = {} as Record<AuxParticleId, AuxRagdollParticle>;

  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  const defaultRight = vec3(cosY, 0, -sinY);
  const defaultForward = vec3(sinY, 0, cosY);

  for (const zone of ALL_GHOUL_ZONES) {
    zoneIntegrity[zone] = 100.0;
    zoneCumulativeDamageJ[zone] = 0.0;
    zoneGoreMode[zone] = 'INTACT';

    const node = GHOUL_ZONE_HIERARCHY[zone];
    const lx = node.jointLocalPos.x;
    const lz = node.jointLocalPos.z;
    const wx = worldPosition.x + (lx * cosY + lz * sinY);
    const wy = worldPosition.y + node.jointLocalPos.y;
    const wz = worldPosition.z + (-lx * sinY + lz * cosY);
    const pos = vec3(wx, wy, wz);

    ragdollBones[zone] = {
      zone,
      position: pos,
      prevPosition: copyVec3(pos),
      velocity: vec3(0, 0, 0),
      angularVelocity: vec3(0, 0, 0),
      rotationEuler: vec3(0, yawRad, 0),
      basisRight: copyVec3(defaultRight),
      basisUp: vec3(0, 1, 0),
      basisForward: copyVec3(defaultForward),
      distalPosition: copyVec3(pos),
      massKg: node.defaultMassKg,
      radiusM: node.collisionRadiusM,
      componentId: 'BODY',
      severed: false,
      goreMode: 'INTACT',
      attachmentState: 'ATTACHED',
      grounded: false,
    };
  }

  for (const auxId of ALL_AUX_PARTICLES) {
    const spec = AUX_PARTICLE_REST_LOCAL[auxId];
    const lx = spec.localPos.x;
    const lz = spec.localPos.z;
    const wx = worldPosition.x + (lx * cosY + lz * sinY);
    const wy = worldPosition.y + spec.localPos.y;
    const wz = worldPosition.z + (-lx * sinY + lz * cosY);
    const pos = vec3(wx, wy, wz);

    auxParticles[auxId] = {
      id: auxId,
      parentZone: spec.parentZone,
      position: pos,
      prevPosition: copyVec3(pos),
      velocity: vec3(0, 0, 0),
      massKg: spec.massKg,
      radiusM: spec.radiusM,
      componentId: 'BODY',
    };
  }

  const hasChestArmor = archetype === 'HEAVY_ENFORCER';
  const hasHelmetArmor = archetype === 'HEAVY_ENFORCER';
  const archetypeBaseHp: Record<EnemyArchetypeId, number> = {
    SKINHEAD_PUNK: 120.0,
    SNIPER_OPERATIVE: 135.0,
    MILITIA_GUNNER: 145.0,
    HEAVY_ENFORCER: 190.0,
  };
  const startingHp = archetypeBaseHp[archetype];

  const state: TargetHealthState = {
    targetId,
    name,
    archetype,
    worldPosition: copyVec3(worldPosition),
    yawRad,
    maxHp: startingHp,
    currentHp: startingHp,
    bleedRateHpPerSec: 0,
    bloodVolumeMl: 5000,
    bloodLossRateMlPerSec: 0,
    systolicBpMmHg: 120,
    heartRateBpm: 78,
    oxygenSaturationPct: 99,
    consciousness: 1.0,
    painShock: 0.0,
    posture: 'COMBAT_READY',
    isLeftHanded,
    leftLegFunctional: true,
    rightLegFunctional: true,
    leftArmFunctional: true,
    rightArmFunctional: true,
    headgearIntact: true,
    weaponDropped: false,
    hasChestArmor,
    chestArmorIntegrity: hasChestArmor ? 100.0 : 0.0,
    hasHelmetArmor,
    helmetArmorIntegrity: hasHelmetArmor ? 100.0 : 0.0,
    activeReaction: {
      type: 'NONE',
      timerS: 0,
      durationS: 0,
      intensity: 0,
      hitDirectionWorld: vec3(0, 0, -1),
      epoch: 0,
    },
    alive: true,
    isRagdollActive: false,
    ragdollPhase: { kind: 'INACTIVE' },
    bodyState: {
      kind: 'STANDING',
      posture: 'COMBAT_READY',
      reaction: null,
      hitstopRemainingS: 0,
    },
    armamentState: 'PRIMARY_READY',
    ragdollRootPosition: copyVec3(worldPosition),
    ragdollRootVelocity: vec3(0, 0, 0),
    ragdollAngularVelocity: vec3(0, 0, 0),
    ragdollBones,
    auxParticles,
    ragdollConstraints: buildRagdollConstraints(),
    zoneIntegrity,
    zoneCumulativeDamageJ,
    zoneGoreMode,
    severedZones: new Set<GhoulZoneId>(),
    fracturedBones: new Set<string>(),
    rupturedOrgans: new Set<string>(),
    surfaceWounds: [],
  };

  recomputeRagdollBasisVectors(state);
  return state;
}
