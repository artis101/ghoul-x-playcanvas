/**
 * Shared blast-wave falloff for destructible walls, so every material reads the
 * same local energy at the same distance and only their break thresholds differ.
 */
export const BLAST_REACH_SCALE = 1.08;
export const BLAST_FALLOFF_EXPONENT = 1.35;

/** Local blast energy (J) at `distM` from the blast center. */
export function blastLocalEnergyJ(peakEnergyJ: number, blastRadiusM: number, distM: number): number {
  const reachM = blastRadiusM * BLAST_REACH_SCALE;
  if (peakEnergyJ <= 0 || reachM <= 0 || distM >= reachM) return 0;
  return peakEnergyJ * Math.pow(Math.max(0, 1 - distM / reachM), BLAST_FALLOFF_EXPONENT);
}

/** Farthest distance (m) from the blast center at which local energy still reaches `thresholdJ`. */
export function blastReachForEnergyM(peakEnergyJ: number, blastRadiusM: number, thresholdJ: number): number {
  const reachM = blastRadiusM * BLAST_REACH_SCALE;
  if (peakEnergyJ <= 0 || reachM <= 0 || thresholdJ >= peakEnergyJ) return 0;
  return reachM * (1 - Math.pow(Math.max(0, thresholdJ) / peakEnergyJ, 1 / BLAST_FALLOFF_EXPONENT));
}
