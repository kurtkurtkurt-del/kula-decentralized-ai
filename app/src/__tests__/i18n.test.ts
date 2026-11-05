// The dictionary as a whole (5.11.2026): every key in all three languages, the same
// {placeholders} in each, no empty strings and no stray upper case at the start; every key
// the code asks for with t('…') / tn('…') / tx('…') is there (a scan of src/, not the type
// checker: tx takes any string), and the keys nobody asks for are listed, not failed on,
// since some are reached through a prefix built at runtime (tx('day.' + …)).
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { dict } from '@/i18n/dict';
import { langs } from '@/i18n/core';

type Entry = Record<string, string>;
const table = dict as Record<string, Entry>;
const keys = Object.keys(table);
const src = join(__dirname, '..');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === '__tests__' || name === 'vendor' || name === 'i18n') continue;
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(name)) yield p;
  }
}
const files = [...walk(src)].map((p) => ({ path: relative(src, p), text: readFileSync(p, 'utf8') }));

// what the code asks for: literal keys, count roots (tn), and the prefixes of template keys
const literal = new Map<string, string[]>(); // key → files
const counted = new Map<string, string[]>(); // tn root → files
const prefixes = new Map<string, string[]>(); // 'peers.kind.' → files
const quoted = new Set<string>(); // every 'a.b' string in the code: tables of keys (OfflineBar's KIND, AuthContext's errors)
for (const f of files) {
  for (const m of f.text.matchAll(/\b(t|tx|tn)\(\s*'([^']+)'/g)) {
    if (m[2].endsWith('.')) continue; // tx('day.' + x): a prefix, taken below
    const bag = m[1] === 'tn' ? counted : literal;
    bag.set(m[2], [...(bag.get(m[2]) ?? []), f.path]);
  }
  for (const m of f.text.matchAll(/['"]([a-z][\w-]*(?:\.[\w-]+)+)['"]/g)) quoted.add(m[1]);
  // tx('day.' + x) and t(`peers.kind.${p.kind}`): the fixed start of the key
  for (const m of f.text.matchAll(/\b(t|tx|tn)\(\s*(?:'([^'$]+\.)'\s*\+|`([^`$]+\.)\$\{)/g)) {
    const p = m[2] ?? m[3];
    prefixes.set(p, [...(prefixes.get(p) ?? []), f.path]);
  }
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('the dictionary', () => {
  it('has every key in en, de and tr, none empty', () => {
    const missing: string[] = [];
    for (const k of keys) for (const l of langs) if (typeof table[k][l] !== 'string' || !table[k][l].trim()) missing.push(`${k}.${l}`);
    expect(missing).toEqual([]);
  });
  it('uses the same {placeholders} in the three languages', () => {
    const off: string[] = [];
    for (const k of keys) {
      const en = placeholders(table[k].en);
      for (const l of langs) if (placeholders(table[k][l]).join() !== en.join()) off.push(`${k}: en {${en}} vs ${l} {${placeholders(table[k][l])}}`);
    }
    expect(off).toEqual([]);
  });
  it('keeps the lower-case voice (a key may start upper only when all three do)', () => {
    const loud = keys.filter((k) => langs.some((l) => /^[A-ZÇĞİÖŞÜÄÖÜ]/.test(table[k][l])) && !langs.every((l) => /^[A-ZÇĞİÖŞÜÄÖÜ]/.test(table[k][l])));
    expect(loud).toEqual([]);
  });
  it('counts with {n} in both forms of every one/other pair', () => {
    // a pair is a root with both .one and .other; combine.one and offline.kind.other alone are plain keys
    const pairs = keys.filter((k) => k.endsWith('.one') && `${k.slice(0, -4)}.other` in table).map((k) => k.slice(0, -4));
    expect(pairs.length).toBeGreaterThan(5);
    const bare = pairs.flatMap((r) => [`${r}.one`, `${r}.other`]).filter((k) => langs.some((l) => !table[k][l].includes('{n}')));
    expect(bare).toEqual([]);
  });
});

describe('the code and the dictionary', () => {
  it('scanned the screens', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(literal.size).toBeGreaterThan(200);
  });
  it('finds every literal key the code asks for', () => {
    const missing = [...literal].filter(([k]) => !(k in table)).map(([k, where]) => `${k} (${[...new Set(where)].join(', ')})`);
    expect(missing).toEqual([]);
  });
  it('finds .one and .other for every tn() root', () => {
    const missing = [...counted].filter(([k]) => !(`${k}.other` in table) || !(`${k}.one` in table)).map(([k, where]) => `${k} (${where.join(', ')})`);
    expect(missing).toEqual([]);
  });
  it('has at least one key behind every runtime prefix', () => {
    const empty = [...prefixes].filter(([p]) => !keys.some((k) => k.startsWith(p))).map(([p, where]) => `${p} (${where.join(', ')})`);
    expect(empty).toEqual([]);
  });
  it('lists the keys nobody asks for (a report, not a failure)', () => {
    const asked = (k: string) =>
      literal.has(k) ||
      quoted.has(k) ||
      [...counted].some(([r]) => k === `${r}.one` || k === `${r}.other`) ||
      [...prefixes].some(([p]) => k.startsWith(p));
    const unused = keys.filter((k) => !asked(k));
    console.log(`i18n: ${keys.length} keys, ${literal.size} asked for by name, ${prefixes.size} prefixes; ${unused.length} not asked for:\n  ${unused.join('\n  ')}`);
    expect(unused.length).toBeLessThan(keys.length / 3); // a ceiling, so a dictionary nobody reads is noticed
  });
});
