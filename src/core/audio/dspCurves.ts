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
