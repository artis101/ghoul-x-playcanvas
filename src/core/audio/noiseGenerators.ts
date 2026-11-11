import type { AudioBufferLike, AudioContextLike } from './contracts.ts';
import { clampNumber } from './audioMath.ts';

export interface PrebakedNoiseBuffers<TBuffer extends AudioBufferLike = AudioBufferLike> {
  whiteBuf: TBuffer;
  pinkBuf: TBuffer;
  crackleBuf: TBuffer;
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
    whiteData[i] = fastSigned();
  }

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
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.18;
    b6 = w * 0.115926;
    pinkData[i] = clampNumber(pink, -1, 1);
  }

  // High-crest impulsive crackle buffer for wood splinters, debris, and bone crunch
  for (let i = 0; i < crackleLen; i++) {
    const r = fastSigned();
    const gate = Math.abs(r) > 0.72 ? Math.sign(r) * Math.pow(Math.abs(r), 0.45) : r * 0.08;
    crackleData[i] = gate;
  }

  return { whiteBuf, pinkBuf, crackleBuf };
}
