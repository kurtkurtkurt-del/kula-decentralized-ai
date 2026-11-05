// docs/SECURITY.md on the app side: the worker secret comes from the os generator, a v3
// qr carries no secret, and a scanned qr is checked before anything is stored.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';
import nodeCrypto from 'node:crypto';

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
jest.mock('@/lib/offline', () => ({ newId: () => 'id', remember: async (_g: string, _k: string, w: () => Promise<unknown>) => w(), must: async (q: Promise<{ data: unknown }>) => (await q).data, send: async () => ({}), outbox: () => {}, invalidate: () => {}, pendingJobs: () => [], useShelf: () => 0 }));
const mockGetRandomBytes = jest.fn((n: number) => new Uint8Array(nodeCrypto.randomBytes(n)));
jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => mockGetRandomBytes(n), randomUUID: () => 'uuid' }));

import { randomHex } from '@/llm/random';
import { makePeerQr, parsePeerQr } from '@/llm/peers';

describe('worker secret', () => {
  it('comes from the os generator, 32 bytes of lowercase hex, never the same twice', () => {
    const a = randomHex(32);
    const b = randomHex(32);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(mockGetRandomBytes).toHaveBeenCalledWith(32);
    // every byte value survives the hex step (no nibble is dropped or clamped)
    mockGetRandomBytes.mockImplementationOnce(() => new Uint8Array([0, 15, 16, 255]));
    expect(randomHex(4)).toBe('000f10ff');
  });
});

describe('peer qr', () => {
  const base = { id: 'w1', name: 'pc', host: '10.0.0.2', port: 50551, kind: 'pc' as const, ram: 1000, bw: 10 };
  it('a v3 qr carries the fingerprint and code and no secret, even when one is known', () => {
    const text = makePeerQr({ ...base, secret: 'ab'.repeat(32), fp: 'cd'.repeat(32), pin: '0123456789abcdef' });
    const o = JSON.parse(text);
    expect(o.v).toBe(3);
    expect(o.secret).toBeUndefined();
    expect(o.fp).toBe('cd'.repeat(32));
    expect(o.pin).toBe('0123456789abcdef');
  });
  it('a v3 qr without a 64-hex fingerprint, or a v2 qr with a short secret, is not a peer', () => {
    expect(() => parsePeerQr(JSON.stringify({ k: 'kula-peer', v: 3, ...base, fp: 'zz' }))).toThrow('notPeer');
    expect(() => parsePeerQr(JSON.stringify({ k: 'kula-peer', v: 2, ...base, secret: 'abc' }))).toThrow('notPeer');
    expect(() => parsePeerQr(JSON.stringify({ k: 'kula-peer', v: 1, ...base, secret: 'ab'.repeat(16) }))).toThrow('old');
    const p = parsePeerQr(JSON.stringify({ k: 'kula-peer', v: 3, ...base, fp: 'CD'.repeat(32), pin: '0123456789abcdef' }));
    expect(p.fp).toBe('cd'.repeat(32));
    expect(p.secret).toBe('');
  });
});
