import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const CORE = path.join(SRC, 'core');
const CONTRACTS = path.join(SRC, 'contracts');
const ENGINE = path.join(SRC, 'engine');

// AGENTS.md hard ceiling for any source file.
const MAX_LINES = 450;

// Each allow-list maps a repo-relative path to the reason it is exempt. The rule currently holds for
// the whole tree, so every list is empty; an entry may be added only with a stated reason.
const LAYERING_ALLOW_LIST: Readonly<Record<string, string>> = {};
const LINE_LIMIT_ALLOW_LIST: Readonly<Record<string, string>> = {};
// The simulation uses seeded RNGs (src/core/random/seededRng.ts) and the engine passes clocks in.
const NONDETERMINISM_ALLOW_LIST: Readonly<Record<string, string>> = {};

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importSpecifiers(src: string): string[] {
  const code = stripComments(src);
  const patterns = [
    /\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  const specs: string[] = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join('/');
const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + path.sep);
const read = (file: string): string => fs.readFileSync(file, 'utf8');

describe('architecture guards', () => {
  it('src/core and src/contracts stay engine-free', () => {
    expect(listTsFiles(CORE).length).toBeGreaterThan(50);
    expect(listTsFiles(CONTRACTS).length).toBeGreaterThan(5);
    const forbiddenGlobals: Array<[RegExp, string]> = [
      [/\b(?:window|document|navigator)\s*\./, 'browser global access'],
      [/\bnew\s+(?:webkit)?AudioContext\b/, 'AudioContext construction'],
      [/\bHTMLElement\b/, 'HTMLElement reference'],
    ];
    const offenders: string[] = [];
    for (const file of [...listTsFiles(CORE), ...listTsFiles(CONTRACTS)]) {
      if (rel(file) in LAYERING_ALLOW_LIST) continue;
      const text = read(file);
      for (const spec of importSpecifiers(text)) {
        const engineImport = spec.startsWith('.') && isInside(path.resolve(path.dirname(file), spec), ENGINE);
        if (spec === 'playcanvas' || spec.startsWith('playcanvas/') || spec.startsWith('@dimforge/') || engineImport) {
          offenders.push(`${rel(file)}: imports ${spec}`);
        }
      }
      const code = stripComments(text);
      for (const [pattern, what] of forbiddenGlobals) {
        if (pattern.test(code)) offenders.push(`${rel(file)}: ${what}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('src/contracts imports nothing from core or engine', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(CONTRACTS)) {
      for (const spec of importSpecifiers(read(file))) {
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), spec);
        if (isInside(target, CORE) || isInside(target, ENGINE)) offenders.push(`${rel(file)}: imports ${spec}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no src file exceeds 450 lines', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC)) {
      if (rel(file) in LINE_LIMIT_ALLOW_LIST) continue;
      const count = (read(file).match(/\n/g) ?? []).length;
      if (count > MAX_LINES) offenders.push(`${rel(file)}: ${count} lines`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('src/core is deterministic', () => {
    const patterns: Array<[RegExp, string]> = [
      [/\bDate\.now\s*\(/, 'Date.now()'],
      [/\bperformance\.now\s*\(/, 'performance.now()'],
      [/\bMath\.random\s*\(/, 'Math.random()'],
    ];
    const offenders: string[] = [];
    for (const file of listTsFiles(CORE)) {
      if (rel(file) in NONDETERMINISM_ALLOW_LIST) continue;
      const code = stripComments(read(file));
      for (const [pattern, what] of patterns) {
        if (pattern.test(code)) offenders.push(`${rel(file)}: ${what}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
