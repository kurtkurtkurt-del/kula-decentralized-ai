// The peer qr under random input (fast-check): make → parse is the identity for v2 and v3;
// dropping or mistyping any field ends in one of the three known errors, never another
// throw; anything over 4 KB is refused before it is parsed.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';
import * as fc from 'fast-check';

const mockStore = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItemSync: (k: string) => mockStore.get(k) ?? null,
    setItemSync: (k: string, v: string) => mockStore.set(k, v),
    removeItemSync: (k: string) => mockStore.delete(k),
    getAllKeysSync: () => [...mockStore.keys()],
  },
}));
jest.mock('expo-device', () => ({ deviceType: 1, DeviceType: { TABLET: 2, DESKTOP: 3 }, osVersion: '15', totalMemory: 8e9 }));
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/offline', () => ({ newId: () => Math.random().toString(36).slice(2), remember: async (_g: string, _k: string, w: () => Promise<unknown>) => w(), must: async (q: Promise<{ data: unknown }>) => (await q).data, send: async () => ({}), outbox: () => {}, invalidate: () => {}, pendingJobs: () => [], useShelf: () => 0 }));
jest.mock('@/llm/native', () => ({ llama: null, native: () => null, hasNative: () => false, GATE_PORT: 50551 }));

import { MAX_QR_BYTES, isPeerQr, makePeerQr, parsePeerQr, setMyWorkerId } from '@/llm/peers';
import type { Passport } from '@/passport/contract';

const hex = (n: number) => fc.stringMatching(new RegExp(`^[0-9a-f]{${n}}$`));
const text = fc.string({ minLength: 1, maxLength: 40, unit: 'grapheme' }).filter((s) => s.trim().length > 0);
const base = fc.record({
  id: fc.stringMatching(/^[a-z0-9-]{1,40}$/),
  name: text,
  host: fc.oneof(fc.ipV4(), fc.stringMatching(/^[a-z][a-z0-9.-]{0,30}$/)),
  port: fc.integer({ min: 1, max: 65535 }),
  kind: fc.constantFrom('phone', 'tablet', 'pc') as fc.Arbitrary<'phone' | 'tablet' | 'pc'>,
  ram: fc.option(fc.integer({ min: 0, max: 1e6 }), { nil: null }),
  bw: fc.option(fc.double({ min: 0, max: 500, noNaN: true }), { nil: null }),
  passport: fc.option(fc.dictionary(fc.stringMatching(/^[a-z_]{1,10}$/), fc.oneof(fc.string({ maxLength: 10 }), fc.integer(), fc.boolean()), { maxKeys: 5 }), { nil: null }),
});
// the passport travels as an opaque object; the test's small dictionaries stand in for one
const v2 = fc.tuple(base, hex(64)).map(([b, secret]) => ({ ...b, passport: b.passport as unknown as Passport | null, secret, fp: undefined, pin: undefined }));
const v3 = fc.tuple(base, hex(64), fc.option(fc.stringMatching(/^[0-9a-f]{4,16}$/), { nil: null })).map(([b, fp, pin]) => ({ ...b, passport: b.passport as unknown as Passport | null, secret: undefined, fp, pin }));

describe('peer qr properties', () => {
  setMyWorkerId('this-very-phone');

  it('make → parse is the identity (v2)', () => {
    fc.assert(fc.property(v2, (q) => {
      const t = makePeerQr(q);
      expect(isPeerQr(t)).toBe(true);
      const p = parsePeerQr(t);
      expect(p).toMatchObject({ id: q.id, name: q.name.slice(0, 64), host: q.host, port: q.port, secret: q.secret, fp: null, pin: null, kind: q.kind, ram: q.ram, bw: q.bw });
      expect(p.passport).toEqual(q.passport ?? null);
    }), { numRuns: 300 });
  });

  it('make → parse is the identity (v3): fingerprint lowercased, pin kept when 4+ chars', () => {
    fc.assert(fc.property(v3, (q) => {
      const t = makePeerQr(q);
      expect(JSON.parse(t).v).toBe(3);
      const p = parsePeerQr(t);
      expect(p).toMatchObject({ id: q.id, host: q.host, port: q.port, secret: '', fp: q.fp.toLowerCase(), pin: q.pin, kind: q.kind });
    }), { numRuns: 300 });
  });

  const fieldNames = ['k', 'v', 'id', 'name', 'host', 'port', 'secret', 'fp', 'pin', 'kind', 'ram', 'bw', 'passport'] as const;
  const junk = fc.oneof(fc.constant(undefined), fc.constant(null), fc.integer(), fc.double(), fc.boolean(), fc.string({ maxLength: 20 }), fc.array(fc.integer(), { maxLength: 3 }), fc.dictionary(fc.string({ maxLength: 4 }), fc.integer(), { maxKeys: 3 }), fc.constant(''), fc.constant(0), fc.constant(-1), fc.constant(65536), fc.constant('50551'));

  it('any field removed or replaced by junk gives notPeer | old | self, or a peer with well typed fields', () => {
    fc.assert(fc.property(fc.oneof(v2, v3), fc.array(fc.tuple(fc.constantFrom(...fieldNames), junk), { minLength: 1, maxLength: 4 }), (q, edits) => {
      const o = JSON.parse(makePeerQr(q)) as Record<string, unknown>;
      for (const [f, val] of edits) { if (val === undefined) delete o[f]; else o[f] = val; }
      const t = JSON.stringify(o);
      let p: ReturnType<typeof parsePeerQr> | null = null;
      try { p = parsePeerQr(t); } catch (e) {
        expect(['notPeer', 'old', 'self']).toContain((e as Error).message);
        return;
      }
      // it read: then every field the tunnel and the list use has the right type
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.name).toBe('string');
      expect(typeof p.host).toBe('string');
      expect(Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535).toBe(true);
      expect(typeof p.secret).toBe('string');
      expect(p.fp === null || /^[0-9a-f]{64}$/.test(p.fp!)).toBe(true);
      expect(p.pin === null || typeof p.pin === 'string').toBe(true);
      expect(['phone', 'tablet', 'pc']).toContain(p.kind);
      expect(p.ram === null || typeof p.ram === 'number').toBe(true);
      expect(p.bw === null || typeof p.bw === 'number').toBe(true);
      expect(p.passport === null || (typeof p.passport === 'object' && !Array.isArray(p.passport))).toBe(true);
    }), { numRuns: 500 });
  });

  it('any text at all: isPeerQr never throws, parsePeerQr throws one of the three', () => {
    fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 200 }), fc.string({ unit: 'binary', maxLength: 100 }), fc.json()), (t) => {
      expect(typeof isPeerQr(t)).toBe('boolean');
      try { parsePeerQr(t); } catch (e) { expect(['notPeer', 'old', 'self']).toContain((e as Error).message); }
    }), { numRuns: 500 });
  });

  it('refuses anything over 4 KB before parsing it', () => {
    fc.assert(fc.property(v3, fc.integer({ min: MAX_QR_BYTES + 1, max: MAX_QR_BYTES * 4 }), (q, n) => {
      const o = JSON.parse(makePeerQr(q));
      o.name = 'x'.repeat(n);
      const t = JSON.stringify(o);
      expect(t.length).toBeGreaterThan(MAX_QR_BYTES);
      expect(isPeerQr(t)).toBe(false);
      expect(() => parsePeerQr(t)).toThrow('notPeer');
    }), { numRuns: 20 });
    // and a real-sized one with a passport still fits
    const big = makePeerQr({ id: 'w', name: 'n', host: '10.0.0.1', port: 1, fp: 'a'.repeat(64), pin: '1234', kind: 'pc', passport: { schema: 'passport/0.3', device: 'Pixel', notes: 'y'.repeat(1500) } as unknown as Passport });
    expect(big.length).toBeLessThan(MAX_QR_BYTES);
    expect(() => parsePeerQr(big)).not.toThrow();
  });

  // regressions from the property above (5.11.2026): these all read as peers before
  it('regression: a string port, an object name and a non-object passport are refused or dropped', () => {
    const q = JSON.parse(makePeerQr({ id: 'w', name: 'n', host: '10.0.0.1', port: 50551, secret: 'ab'.repeat(32), kind: 'pc' }));
    expect(() => parsePeerQr(JSON.stringify({ ...q, port: '50551' }))).toThrow('notPeer');
    expect(() => parsePeerQr(JSON.stringify({ ...q, port: 0 }))).toThrow('notPeer');
    expect(() => parsePeerQr(JSON.stringify({ ...q, port: 70000 }))).toThrow('notPeer');
    expect(() => parsePeerQr(JSON.stringify({ ...q, port: 1.5 }))).toThrow('notPeer');
    expect(() => parsePeerQr(JSON.stringify({ ...q, id: 7 }))).toThrow('notPeer');
    expect(() => parsePeerQr(JSON.stringify({ ...q, host: ['a'] }))).toThrow('notPeer');
    expect(parsePeerQr(JSON.stringify({ ...q, name: { a: 1 } })).name).toBe('10.0.0.1');
    expect(parsePeerQr(JSON.stringify({ ...q, ram: 'lots', bw: [1] })).ram).toBeNull();
    expect(parsePeerQr(JSON.stringify({ ...q, passport: [1, 2] })).passport).toBeNull();
    expect(parsePeerQr(JSON.stringify({ ...q, passport: 'x' })).passport).toBeNull();
  });
});
