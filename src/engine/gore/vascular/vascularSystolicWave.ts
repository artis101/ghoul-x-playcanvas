/**
 * Pure helper computing instantaneous systolic pulse intensity [0..1] synced to `heartRateBpm`.
 */
export function evaluateSystolicPulseWave(elapsedTimeS: number, heartRateBpm: number): number {
  if (heartRateBpm <= 0) return 0;
  const freqHz = heartRateBpm / 60;
  const phase = ((elapsedTimeS * freqHz) % 1 + 1) % 1;
  // Crisp systolic ejection peak over first 26% of cardiac cycle followed by dicrotic diastolic decay
  if (phase < 0.26) {
    return Math.sin((phase / 0.26) * Math.PI * 0.5);
  }
  return Math.exp(-(phase - 0.26) * 4.6);
}
