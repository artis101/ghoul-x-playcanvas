import type { AudioBufferLike, AudioContextLike } from './contracts.ts';
import { clampNumber } from './audioMath.ts';

export interface PrebakedNoiseBuffers<TBuffer extends AudioBufferLike = AudioBufferLike> {
  whiteBuf: TBuffer;
  pinkBuf: TBuffer;
  crackleBuf: TBuffer;
}

function smoothLoopSeam(data: Float32Array, fadeSamples = 128): void {
  const len = data.length;
  const n = Math.min(fadeSamples, Math.floor(len * 0.12));
  if (n < 4) return;
  // Smoothly blend the tail toward zero and fade in the head over `n` samples
  // so `loop = true` buffer wrap-arounds never emit a step discontinuity click.
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    data[i] *= w;
    data[len - 1 - i] *= w;
  }
}

export function createPrebakedNoiseBuffers<TBuffer extends AudioBufferLike>(
  ctx: AudioContextLike<TBuffer>,
): PrebakedNoiseBuffers<TBuffer> {
  const sr = Math.max(8000, ctx.sampleRate || 44100);

  const whiteLen = Math.max(64, Math.floor(sr * 1.5));
  const whiteBuf = ctx.createBuffer(1, whiteLen, sr);
  const whiteData = whiteBuf.getChannelData(0);

  const pinkLen = Math.max(64, Math.floor(sr * 2.0));
  const pinkBuf = ctx.createBuffer(1, pinkLen, sr);
  const pinkData = pinkBuf.getChannelData(0);

  const crackleLen = Math.max(64, Math.floor(sr * 1.5));
  const crackleBuf = ctx.createBuffer(1, crackleLen, sr);
  const crackleData = crackleBuf.getChannelData(0);

  let prng = 0x6d2b79f5;
  const fastSigned = (): number => {
    prng ^= prng << 13;
    prng ^= prng >>> 17;
    prng ^= prng << 5;
    return ((prng >>> 0) / 0xffffffff) * 2 - 1;
  };

  for (let i = 0; i < whiteLen; i++) {
    whiteData[i] = fastSigned() * 0.85;
  }
  smoothLoopSeam(whiteData);

  // Paul Kellet 1/f pink noise filter for warm low-mid blast & muzzle body
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < pinkLen; i++) {
    const w = fastSigned();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.17;
    b6 = w * 0.115926;
    pinkData[i] = clampNumber(pink, -0.95, 0.95);
  }
  smoothLoopSeam(pinkData);

  // Bandlimited micro-grain texture buffer for wood splinters, debris, and bone crunch
  // (avoids dense single-sample square discontinuities that sound like digital static crackle)
  let grainEnv = 0;
  let grainLp = 0;
  const grainDecay = Math.exp(-1.0 / Math.max(2.5, sr * 0.00045));
  for (let i = 0; i < crackleLen; i++) {
    const r = fastSigned();
    if (Math.abs(r) > 0.945 && grainEnv < 0.25) {
      grainEnv = 0.55 + (Math.abs(r) - 0.945) * 6.5;
    } else {
      grainEnv *= grainDecay;
    }
    const raw = r * (0.12 + grainEnv * 0.72);
    grainLp += 0.52 * (raw - grainLp);
    crackleData[i] = clampNumber(grainLp, -0.92, 0.92);
  }
  smoothLoopSeam(crackleData);

  return { whiteBuf, pinkBuf, crackleBuf };
}
