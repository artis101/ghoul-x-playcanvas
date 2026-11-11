import { clampNumber } from './audioMath.ts';

/**
 * Synthesizes a realistic stereo Indoor Shooting-Range / Concrete Warehouse
 * Impulse Response (`ConvolverNode` buffer):
 * - Discrete early reflections off concrete floor, side walls, steel ceiling trusses, and 45m backstop
 * - Decorrelated stereo exponentially-decaying diffuse tail with progressive air-absorption damping
 */
export function synthesizeWarehouseImpulseResponse(
  leftOut: Float32Array,
  rightOut: Float32Array,
  sampleRate: number,
  decaySeconds = 1.55,
  seed = 0x9e3779b9,
): void {
  const length = Math.min(leftOut.length, rightOut.length);
  if (length === 0 || sampleRate <= 0) {
    return;
  }

  leftOut.fill(0);
  rightOut.fill(0);

  // Early concrete & steel truss slapback reflections (timeMs, gainL, gainR)
  const earlyTaps: ReadonlyArray<readonly [number, number, number]> = [
    [4.2, 0.42, 0.39],   // Concrete floor bounce
    [13.6, 0.54, 0.18],  // Left bay wall
    [17.4, 0.19, 0.52],  // Right bay wall
    [26.8, 0.34, 0.36],  // Overhead steel roof truss
    [41.5, 0.31, 0.16],  // Mid-range concrete baffle L
    [46.9, 0.15, 0.30],  // Mid-range concrete baffle R
    [74.0, 0.23, 0.25],  // Downrange shooting stall echo
    [118.5, 0.17, 0.16], // 42m concrete backstop slapback
  ];

  for (const [ms, gL, gR] of earlyTaps) {
    const idx = Math.floor((ms * 0.001) * sampleRate);
    if (idx >= 0 && idx < length) {
      leftOut[idx] += gL;
      rightOut[idx] += gR;
    }
  }

  let state = (seed >>> 0) || 0x12345678;
  const nextSigned = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff) * 2 - 1;
  };

  const tau = Math.max(0.15, decaySeconds / 4.2);
  let lpL = 0;
  let lpR = 0;

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // Slight pre-delay fade-in over first 6ms into exponentially decaying warehouse tail
    const preDelayEnv = Math.min(1.0, t / 0.006);
    const decayEnv = Math.exp(-t / tau) * preDelayEnv;

    // Progressive high-frequency air damping as reverberation bounces downrange
    const dampAlpha = clampNumber(0.58 - 0.44 * Math.min(1.0, t / decaySeconds), 0.10, 0.65);

    const rawL = nextSigned();
    const rawR = nextSigned();
    lpL += dampAlpha * (rawL - lpL);
    lpR += dampAlpha * (rawR - lpR);

    leftOut[i] += lpL * decayEnv * 0.34;
    rightOut[i] += lpR * decayEnv * 0.34;
  }
}
