import { describe, expect, it } from 'vitest';
import { getDevFlags, parseDevFlags } from '../src/engine/dev/devFlags';

describe('devFlags', () => {
  it('defaults to all off', () => {
    expect(parseDevFlags('')).toEqual({ fast: false, debug: false });
  });

  it('treats a bare flag as on', () => {
    expect(parseDevFlags('?fast').fast).toBe(true);
  });

  it('parses several flags', () => {
    expect(parseDevFlags('?fast=1&debug')).toEqual({ fast: true, debug: true });
  });

  it('treats 0, false and off as disabled', () => {
    expect(parseDevFlags('?fast=0').fast).toBe(false);
    expect(parseDevFlags('?debug=off').debug).toBe(false);
    expect(parseDevFlags('?debug=FALSE').debug).toBe(false);
  });

  it('accepts a query without a leading question mark', () => {
    expect(parseDevFlags('debug=true').debug).toBe(true);
  });

  it('reads flags without throwing outside a browser', () => {
    const flags = getDevFlags();
    expect(typeof flags.fast).toBe('boolean');
    expect(typeof flags.debug).toBe('boolean');
  });
});
