/**
 * Standard Mach drag multiplier model (realistic transonic drag rise between Mach 0.85 and 1.3).
 */
export function computeMachDragMultiplier(mach: number): number {
  if (mach < 0.75) {
    return 1.0;
  } else if (mach < 1.0) {
    const t = (mach - 0.75) / 0.25;
    return 1.0 + 1.6 * (t * t);
  } else if (mach < 1.35) {
    const t = (mach - 1.0) / 0.35;
    return 2.6 - 0.7 * t;
  } else if (mach < 2.5) {
    const t = (mach - 1.35) / 1.15;
    return 1.9 - 0.5 * t;
  } else {
    return 1.35;
  }
}
