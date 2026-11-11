import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { add, cross, dot, length, normalize, scale, sub, vec3 } from '../../ballistics/vec3.ts';

export function solveTwoBoneIk(
  shoulder: Vec3Like,
  elbow: Vec3Like,
  wrist: Vec3Like,
  goal: Vec3Like
): { elbow: Vec3Like; wrist: Vec3Like } | null {
  const upperLength = length(sub(elbow, shoulder));
  const lowerLength = length(sub(wrist, elbow));
  const reach = sub(goal, shoulder);
  const distance = length(reach);
  if (Math.min(upperLength, lowerLength, distance) < 1e-4) return null;

  const forward = scale(reach, 1 / distance);
  const clamped = Math.max(
    Math.abs(upperLength - lowerLength) + 1e-4,
    Math.min(distance, upperLength + lowerLength - 1e-4)
  );
  const elbowOffset = sub(elbow, shoulder);
  let pole = sub(elbowOffset, scale(forward, dot(elbowOffset, forward)));
  if (length(pole) < 1e-4) {
    const axis = Math.abs(forward.y) < 0.95 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    pole = cross(forward, cross(scale(axis, -1), forward));
  }

  const along = (clamped * clamped + upperLength * upperLength - lowerLength * lowerLength) / (2 * clamped);
  const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
  return {
    elbow: add(add(shoulder, scale(forward, along)), scale(normalize(pole), height)),
    wrist: add(shoulder, scale(forward, clamped)),
  };
}
