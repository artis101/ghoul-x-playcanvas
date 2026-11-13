export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function computeImpactEnergyGain(energyJ: number): number {
  if (!Number.isFinite(energyJ) || energyJ <= 0) {
    return 0.25;
  }
  const normalized = Math.log10(Math.max(10, energyJ)) / 3.05;
  return clampNumber(normalized, 0.25, 1.35);
}
