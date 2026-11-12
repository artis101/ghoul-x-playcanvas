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
  // Balanced L/R Haas energy so centered gunshots stay dead-center while preserving stereo width
  const earlyTaps: ReadonlyArray<readonly [number, number, number]> = [
    [4.2, 0.34, 0.35],   // Concrete floor bounce
    [9.8, 0.17, 0.33],   // Near right stall pillar (balances Haas precedence)
    [13.6, 0.44, 0.18],  // Left bay wall
    [17.4, 0.18, 0.44],  // Right bay wall
    [26.8, 0.28, 0.29],  // Overhead steel roof truss
    [41.5, 0.24, 0.15],  // Mid-range concrete baffle L
    [46.9, 0.15, 0.24],  // Mid-range concrete baffle R
    [74.0, 0.19, 0.20],  // Downrange shooting stall echo
    [118.5, 0.14, 0.14], // 42m concrete backstop slapback
  ];

  const smearLen = Math.max(3, Math.floor(sampleRate * 0.00035));
  for (const [ms, gL, gR] of earlyTaps) {
    const idx = Math.floor((ms * 0.001) * sampleRate);
    if (idx >= 0 && idx < length) {
      for (let k = 0; k < smearLen && idx + k < length; k++) {
        const w = k === 0 ? 1.0 : Math.exp(-k * 0.85) * 0.45;
        leftOut[idx + k] += gL * w;
        rightOut[idx + k] += gR * w;
      }
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
