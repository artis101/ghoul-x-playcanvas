import { GhoulZoneId, Vec3Like } from '../../../contracts/ballistics.ts';
import { BonePoseFrame, CharacterTransform } from '../../../contracts/physiology.ts';
import { add, normalize, scale, sub } from '../../ballistics/vec3.ts';
import { DEFAULT_CHARACTER_TRANSFORM, STANDING_ZONE_PIVOTS } from './bvhTypes.ts';

export function worldPointToCharacterLocal(
  pointWorld: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM
): Vec3Like {
  const dx = pointWorld.x - transform.positionWorld.x;
  const dy = pointWorld.y - transform.positionWorld.y;
  const dz = pointWorld.z - transform.positionWorld.z;
  const cosY = Math.cos(transform.yawRad);
  const sinY = Math.sin(transform.yawRad);
  return {
    x: dx * cosY - dz * sinY,
    y: dy,
    z: dx * sinY + dz * cosY,
  };
}

export function worldDirectionToCharacterLocal(
  dirWorld: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM
): Vec3Like {
  const n = normalize(dirWorld);
  const cosY = Math.cos(transform.yawRad);
  const sinY = Math.sin(transform.yawRad);
  return normalize({
    x: n.x * cosY - n.z * sinY,
    y: n.y,
    z: n.x * sinY + n.z * cosY,
  });
}

export function characterLocalPointToWorld(
  pointLocal: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM,
  ghoulZone?: GhoulZoneId
): Vec3Like {
  if (ghoulZone && transform.bonePoseOverrides) {
    const pose: BonePoseFrame | undefined = transform.bonePoseOverrides[ghoulZone];
    const pivot = STANDING_ZONE_PIVOTS[ghoulZone];
    if (pose && pivot) {
      const offset = sub(pointLocal, pivot);
      return add(
        pose.positionWorld,
        add(
          scale(pose.basisRight, offset.x),
          add(scale(pose.basisUp, offset.y), scale(pose.basisForward, offset.z))
        )
      );
    }
  }
  const cosY = Math.cos(transform.yawRad);
  const sinY = Math.sin(transform.yawRad);
  return {
    x: transform.positionWorld.x + (pointLocal.x * cosY + pointLocal.z * sinY),
    y: transform.positionWorld.y + pointLocal.y,
    z: transform.positionWorld.z + (-pointLocal.x * sinY + pointLocal.z * cosY),
  };
}

export function characterLocalDirectionToWorld(
  dirLocal: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM
): Vec3Like {
  const n = normalize(dirLocal);
  const cosY = Math.cos(transform.yawRad);
  const sinY = Math.sin(transform.yawRad);
  return normalize({
    x: n.x * cosY + n.z * sinY,
    y: n.y,
    z: -n.x * sinY + n.z * cosY,
  });
}

export function transformWorldRayToCharacterLocal(
  originWorld: Vec3Like,
  dirWorld: Vec3Like,
  transform: CharacterTransform = DEFAULT_CHARACTER_TRANSFORM
): { originLocal: Vec3Like; directionLocal: Vec3Like } {
  return {
    originLocal: worldPointToCharacterLocal(originWorld, transform),
    directionLocal: worldDirectionToCharacterLocal(dirWorld, transform),
  };
}
