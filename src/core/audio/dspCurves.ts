/**
 * Generates a smooth symmetric soft-clipping `tanh` waveshaper transfer curve
 * so heavy 28Hz-90Hz shockwaves and .50 AE blasts saturate warmly without harsh digital clipping.
 */
export function createSoftClipCurve(drive: number, samples = 512): Float32Array {
  const count = Math.max(8, Math.floor(samples));
  const curve = new Float32Array(count);
  const effectiveDrive = Math.max(0.1, drive);
  const norm = Math.tanh(effectiveDrive);
  for (let i = 0; i < count; i++) {
    const x = (i * 2) / (count - 1) - 1;
    curve[i] = Math.tanh(x * effectiveDrive) / norm;
  }
  return curve;
}

/**
 * Generates a transparent C1-continuous brickwall soft-limiter curve for a pre-scaled
 * master signal (`x = signal / headroomRange`, default ±4.0 -> ±12 dBFS).
 * Strictly unity-linear (`y = s`) up to `linearThreshold`, then smoothly saturates to `±ceiling`
 * so multi-pellet impacts and sub-millisecond gunshot peaks never hard-clip the DAC.
 */
export function createMasterLimiterCurve(
  headroomRange = 4.0,
  linearThreshold = 0.65,
  ceiling = 0.97,
  samples = 1025,
): Float32Array {
  const count = Math.max(65, Math.floor(samples) | 1);
  const curve = new Float32Array(count);
  const range = Math.max(1.0, headroomRange);
  const knee = Math.max(0.1, Math.min(0.9, linearThreshold));
  const cap = Math.max(knee + 0.05, Math.min(0.995, ceiling));
  const span = cap - knee;

  for (let i = 0; i < count; i++) {
    const x = (i * 2) / (count - 1) - 1;
    const s = x * range;
    const absS = Math.abs(s);
    if (absS <= knee) {
      curve[i] = s;
    } else {
      const compressed = knee + span * Math.tanh((absS - knee) / span);
      curve[i] = s < 0 ? -compressed : compressed;
    }
  }
  return curve;
}
