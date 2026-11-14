/// <reference types="vite/client" />

export interface DevFlags {
  readonly fast: boolean;
  readonly debug: boolean;
}

const OFF_VALUES = new Set(['0', 'false', 'off']);

function flagOn(params: URLSearchParams, name: string): boolean {
  const value = params.get(name);
  return value !== null && !OFF_VALUES.has(value.toLowerCase());
}

export function parseDevFlags(search: string): DevFlags {
  const params = new URLSearchParams(search);
  return { fast: flagOn(params, 'fast'), debug: flagOn(params, 'debug') };
}

let cachedFlags: DevFlags | null = null;

export function getDevFlags(): DevFlags {
  if (cachedFlags) return cachedFlags;
  const loc = (globalThis as { location?: { search?: unknown } }).location;
  const search = typeof loc?.search === 'string' ? loc.search : '';
  cachedFlags = parseDevFlags(search);
  return cachedFlags;
}

export function isDevBuild(): boolean {
  return import.meta.env?.DEV === true;
}
