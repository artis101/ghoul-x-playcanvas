import * as pc from 'playcanvas';
import type { GhoulZoneId } from '../../contracts/ballistics.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { ChildSocketStump } from './types.ts';

export function createStumpAssembly(
  name: string,
  meatDiameter: number,
  boneLen: number,
  dirY: number,
  materials: EngineMaterialPalette
): pc.Entity {
  const root = new pc.Entity(name);

  const meatCap = new pc.Entity('MeatCap');
  meatCap.addComponent('render', {
    type: 'cylinder',
    material: materials.goreStumpMat,
  });
  meatCap.setLocalScale(meatDiameter, 0.032, meatDiameter);
  root.addChild(meatCap);

  const boneShaft = new pc.Entity('ProtrudingCorticalBone');
  boneShaft.addComponent('render', {
    type: 'cylinder',
    material: materials.exposedBoneMat,
  });
  const boneDiam = meatDiameter * 0.34;
  boneShaft.setLocalScale(boneDiam, boneLen, boneDiam);
  boneShaft.setLocalPosition(0, dirY * (boneLen * 0.45), 0);
  root.addChild(boneShaft);

  return root;
}

export function buildProximalLimbStump(
  zone: GhoulZoneId,
  zoneNode: pc.Entity,
  materials: EngineMaterialPalette
): pc.Entity | undefined {
  const specs: Partial<Record<GhoulZoneId, { radius: number; boneLen: number; dirY: number }>> = {
    HEAD_CRANIUM: { radius: 0.095, boneLen: 0.05, dirY: -1 },
    NECK_CERVICAL: { radius: 0.088, boneLen: 0.048, dirY: -1 },
    UPPER_ARM_LEFT: { radius: 0.095, boneLen: 0.065, dirY: 1 },
    UPPER_ARM_RIGHT: { radius: 0.095, boneLen: 0.065, dirY: 1 },
    FOREARM_LEFT: { radius: 0.082, boneLen: 0.055, dirY: 1 },
    FOREARM_RIGHT: { radius: 0.082, boneLen: 0.055, dirY: 1 },
    HAND_LEFT: { radius: 0.065, boneLen: 0.04, dirY: 1 },
    HAND_RIGHT: { radius: 0.065, boneLen: 0.04, dirY: 1 },
    THIGH_LEFT: { radius: 0.135, boneLen: 0.075, dirY: 1 },
    THIGH_RIGHT: { radius: 0.135, boneLen: 0.075, dirY: 1 },
    KNEE_LEFT: { radius: 0.11, boneLen: 0.06, dirY: 1 },
    KNEE_RIGHT: { radius: 0.11, boneLen: 0.06, dirY: 1 },
    SHIN_LEFT: { radius: 0.1, boneLen: 0.06, dirY: 1 },
    SHIN_RIGHT: { radius: 0.1, boneLen: 0.06, dirY: 1 },
    FOOT_LEFT: { radius: 0.085, boneLen: 0.045, dirY: 1 },
    FOOT_RIGHT: { radius: 0.085, boneLen: 0.045, dirY: 1 },
  };

  const spec = specs[zone];
  if (!spec) return undefined;

  const root = createStumpAssembly(`${zone}_ProximalStump`, spec.radius, spec.boneLen, spec.dirY, materials);
  root.enabled = false;
  zoneNode.addChild(root);
  return root;
}

export function buildDistalParentSocketStumps(
  zone: GhoulZoneId,
  zoneNode: pc.Entity,
  materials: EngineMaterialPalette
): ChildSocketStump[] {
  const socketDefs: Partial<
    Record<
      GhoulZoneId,
      Array<{ childZone: GhoulZoneId; offset: [number, number, number]; radius: number; boneLen: number; dirY: number }>
    >
  > = {
    TORSO_UPPER_THORAX: [{ childZone: 'NECK_CERVICAL', offset: [0, 0.205, 0], radius: 0.115, boneLen: 0.065, dirY: 1 }],
    NECK_CERVICAL: [{ childZone: 'HEAD_CRANIUM', offset: [0, 0.085, 0], radius: 0.115, boneLen: 0.065, dirY: 1 }],
    SHOULDER_LEFT: [{ childZone: 'UPPER_ARM_LEFT', offset: [-0.045, -0.085, 0], radius: 0.11, boneLen: 0.065, dirY: -1 }],
    SHOULDER_RIGHT: [{ childZone: 'UPPER_ARM_RIGHT', offset: [0.045, -0.085, 0], radius: 0.11, boneLen: 0.065, dirY: -1 }],
    UPPER_ARM_LEFT: [{ childZone: 'FOREARM_LEFT', offset: [0, -0.245, 0], radius: 0.092, boneLen: 0.06, dirY: -1 }],
    UPPER_ARM_RIGHT: [{ childZone: 'FOREARM_RIGHT', offset: [0, -0.245, 0], radius: 0.092, boneLen: 0.06, dirY: -1 }],
    FOREARM_LEFT: [{ childZone: 'HAND_LEFT', offset: [0, -0.235, 0], radius: 0.074, boneLen: 0.05, dirY: -1 }],
    FOREARM_RIGHT: [{ childZone: 'HAND_RIGHT', offset: [0, -0.235, 0], radius: 0.074, boneLen: 0.05, dirY: -1 }],
    PELVIS_GROIN: [
      { childZone: 'THIGH_LEFT', offset: [-0.115, -0.085, 0], radius: 0.145, boneLen: 0.075, dirY: -1 },
      { childZone: 'THIGH_RIGHT', offset: [0.115, -0.085, 0], radius: 0.145, boneLen: 0.075, dirY: -1 },
    ],
    THIGH_LEFT: [{ childZone: 'KNEE_LEFT', offset: [0, -0.345, 0], radius: 0.125, boneLen: 0.07, dirY: -1 }],
    THIGH_RIGHT: [{ childZone: 'KNEE_RIGHT', offset: [0, -0.345, 0], radius: 0.125, boneLen: 0.07, dirY: -1 }],
    KNEE_LEFT: [{ childZone: 'SHIN_LEFT', offset: [0, -0.075, 0], radius: 0.11, boneLen: 0.065, dirY: -1 }],
    KNEE_RIGHT: [{ childZone: 'SHIN_RIGHT', offset: [0, -0.075, 0], radius: 0.11, boneLen: 0.065, dirY: -1 }],
    SHIN_LEFT: [{ childZone: 'FOOT_LEFT', offset: [0, -0.205, 0], radius: 0.092, boneLen: 0.055, dirY: -1 }],
    SHIN_RIGHT: [{ childZone: 'FOOT_RIGHT', offset: [0, -0.205, 0], radius: 0.092, boneLen: 0.055, dirY: -1 }],
  };

  const list = socketDefs[zone];
  if (!list) return [];

  const result: ChildSocketStump[] = [];
  for (const item of list) {
    const node = createStumpAssembly(
      `${zone}_Socket_${item.childZone}`,
      item.radius,
      item.boneLen,
      item.dirY,
      materials
    );
    node.setLocalPosition(item.offset[0], item.offset[1], item.offset[2]);
    node.enabled = false;
    zoneNode.addChild(node);
    result.push({ childZone: item.childZone, node });
  }
  return result;
}
