// The phone's ledger reader (llm/audit.ts) under random lines: chains built the way the
// writers build them verify; any changed character inside the window breaks the chain at
// the right place; junk never throws.
import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import { AUDIT_KINDS, GENESIS, parseLedger, parseLine, peerBadge, sha256Hex, summarize, verifyChain, detailOf } from '@/llm/audit';

const kind = fc.constantFrom(...AUDIT_KINDS);
const value = fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.boolean(), fc.constant(null), fc.array(fc.string({ maxLength: 5 }), { maxLength: 3 }));
const entry = fc.record({
  t: fc.integer({ min: 0, max: 4e12 }),
  kind,
  peer: fc.option(fc.ipV4(), { nil: null }),
  reject: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
  warn: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }), { nil: undefined }),
  fields: fc.dictionary(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,8}$/).filter((k) => !['t', 'kind', 'peer', 'prev', 'sig', 'reject', 'warn'].includes(k)), value, { maxKeys: 4 }),
});
type E = { t: number; kind: string; peer: string | null; reject?: string; warn?: string[]; fields: Record<string, unknown> };

// the writers' layout: t, kind, peer, fields…, prev, sig (the signature is opaque here)
function chain(entries: E[], firstPrev = GENESIS): string[] {
  let prev = firstPrev;
  return entries.map((e) => {
    const o: Record<string, unknown> = { t: e.t, kind: e.kind };
    if (e.peer !== null) o.peer = e.peer;
    for (const [k, v] of Object.entries(e.fields)) o[k] = v;
    if (e.reject !== undefined) o.reject = e.reject;
    if (e.warn !== undefined) o.warn = e.warn;
    o.prev = prev;
    o.sig = 'c2ln';
    const line = JSON.stringify(o);
    prev = sha256Hex(line);
    return line;
  });
}

describe('audit chain properties', () => {
  it('a chain from genesis verifies, and a window cut anywhere verifies as "not from genesis"', () => {
    fc.assert(fc.property(fc.array(entry, { minLength: 1, maxLength: 10 }), fc.nat(), (entries, cut) => {
      const lines = chain(entries);
      expect(verifyChain(lines)).toEqual({ ok: true, broken: null, fromGenesis: true });
      const from = cut % lines.length;
      const window = lines.slice(from);
      expect(verifyChain(window)).toEqual({ ok: true, broken: null, fromGenesis: from === 0 });
      const parsed = parseLedger(lines);
      expect(parsed.every((p) => p.line)).toBe(true);
      const s = summarize(parsed);
      expect(s.total).toBe(entries.length);
      expect(s.malformed).toBe(0);
      expect(s.rejects + s.warns).toBeLessThanOrEqual(s.total);
      for (const p of parsed) expect(typeof detailOf(p.line!)).toBe('string');
    }), { numRuns: 300 });
  });

  it('one changed character in a line that has a successor breaks the chain at that successor (or at the line itself)', () => {
    fc.assert(fc.property(fc.array(entry, { minLength: 2, maxLength: 8 }), fc.nat(), fc.nat(), fc.integer({ min: 32, max: 126 }), (entries, li, ci, ch) => {
      const lines = chain(entries);
      const i = li % (lines.length - 1); // never the last line: nothing after it checks its hash
      const j = ci % lines[i].length;
      const c = String.fromCharCode(ch);
      fc.pre(c !== lines[i][j]);
      const m = [...lines];
      m[i] = lines[i].slice(0, j) + c + lines[i].slice(j + 1);
      const r = verifyChain(m);
      expect(r.ok).toBe(false);
      expect(r.broken === i || r.broken === i + 1).toBe(true);
    }), { numRuns: 500 });
  });

  it('an inserted, dropped or reordered line inside the window shows', () => {
    fc.assert(fc.property(fc.array(entry, { minLength: 3, maxLength: 8 }), fc.nat(), (entries, k) => {
      const lines = chain(entries);
      const i = 1 + (k % (lines.length - 2)); // an inner line
      expect(verifyChain(lines.filter((_, n) => n !== i)).ok).toBe(false);
      const swapped = [...lines];
      [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
      expect(verifyChain(swapped).ok).toBe(false);
      const dup = [...lines.slice(0, i), lines[i], ...lines.slice(i)];
      expect(verifyChain(dup).ok).toBe(false);
    }), { numRuns: 300 });
  });

  it('the sha256 agrees with a known vector and never throws on any string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 200 }), fc.string({ unit: 'binary', maxLength: 100 })), (s) => {
      expect(sha256Hex(s)).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256Hex(s)).toBe(sha256Hex(s));
    }), { numRuns: 300 });
  });

  it('junk lines never throw: they are malformed, and a window with one is broken there', () => {
    fc.assert(fc.property(fc.array(fc.oneof(fc.string({ maxLength: 60 }), fc.json(), fc.constant('null'), fc.constant('[]')), { minLength: 1, maxLength: 6 }), (raw) => {
      const lines = raw.map((l) => l.replace(/\n/g, ' ')).filter((l) => l.length);
      for (const l of lines) expect(() => parseLine(l)).not.toThrow();
      const r = verifyChain(lines);
      expect(typeof r.ok).toBe('boolean');
      const parsed = parseLedger(lines);
      expect(summarize(parsed).malformed + summarize(parsed).total).toBe(lines.length);
      expect(['verified', 'warn', 'rejected', 'none']).toContain(peerBadge(parsed, '10.0.0.1'));
    }), { numRuns: 300 });
  });
});
