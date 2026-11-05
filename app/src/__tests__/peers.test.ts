// The peer qr against bad input (5.11.2026): what a camera can hand us and what must
// not become a saved peer. On this branch the qr is v2 (gate v1); the v3 qr of the tls
// gate (claude/gate-tls) is refused here as 'old' the same way v1 is: not this version.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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
jest.mock('@/lib/offline', () => ({ newId: () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2), remember: async (_g: string, _k: string, w: () => Promise<unknown>) => w(), must: async (q: Promise<{ data: unknown }>) => (await q).data, send: async () => ({}), outbox: () => {}, invalidate: () => {}, pendingJobs: () => [], useShelf: () => 0 }));
const mockLlama = { info: async () => ({ available: true, abi: 'arm64-v8a', fastCores: 4, ramFreeMb: 3000, modelsDir: '/m', freeDiskMb: 9000, workerId: 'me-1', wifiIp: '192.168.1.20' }) };
jest.mock('@/llm/native', () => ({ get llama() { return mockLlama; }, native: () => mockLlama, hasNative: () => true, GATE_PORT: 50551 }));

import { isPeerQr, myPeerQr, setMyWorkerId, takePeerQr } from '@/llm/peers';
import { peers, share } from '@/llm/store';

const good = { k: 'kula-peer', v: 2, id: 'w-1', name: 'MacBook', host: '192.168.1.5', port: 50551, secret: 'ab'.repeat(32), kind: 'pc', ram: 16000, bw: 60 };
const qr = (over: Record<string, unknown>) => JSON.stringify({ ...good, ...over });

beforeEach(() => {
  mockStore.clear();
  setMyWorkerId('me-1');
});

describe('isPeerQr', () => {
  it('needs valid json with the kind, a host and a secret, nothing else', () => {
    expect(isPeerQr(JSON.stringify(good))).toBe(true);
    expect(isPeerQr('')).toBe(false);
    expect(isPeerQr('{')).toBe(false);
    expect(isPeerQr('null')).toBe(false);
    expect(isPeerQr('42')).toBe(false);
    expect(isPeerQr('"kula-peer"')).toBe(false);
    expect(isPeerQr(qr({ k: 'kula-passport' }))).toBe(false);
    expect(isPeerQr(qr({ secret: 123 }))).toBe(false);
    expect(isPeerQr(qr({ host: undefined }))).toBe(false);
    // the shape test does not look at the version: takePeerQr says 'old'
    expect(isPeerQr(qr({ v: 3 }))).toBe(true);
  });
});

describe('takePeerQr', () => {
  it('refuses garbage as notPeer and saves nothing', () => {
    for (const text of ['', '{', 'null', '[]', '"x"', JSON.stringify({}), JSON.stringify({ k: 'kula-passport', v: 2 })]) {
      expect(() => takePeerQr(text)).toThrow('notPeer');
    }
    expect(peers()).toEqual([]);
  });
  it('refuses another version as old, v1 and v3 alike', () => {
    expect(() => takePeerQr(qr({ v: 1 }))).toThrow('old');
    expect(() => takePeerQr(qr({ v: 3 }))).toThrow('old');
    expect(() => takePeerQr(qr({ v: '2' }))).toThrow('old');
    expect(() => takePeerQr(qr({ v: undefined }))).toThrow('old');
    expect(peers()).toEqual([]);
  });
  it('refuses a missing id, host or port, and a secret that is not 32+ hex bytes', () => {
    expect(() => takePeerQr(qr({ id: '' }))).toThrow('notPeer');
    expect(() => takePeerQr(qr({ host: '' }))).toThrow('notPeer');
    expect(() => takePeerQr(qr({ port: 0 }))).toThrow('notPeer');
    expect(() => takePeerQr(qr({ port: undefined }))).toThrow('notPeer');
    expect(() => takePeerQr(qr({ secret: 'ab'.repeat(15) }))).toThrow('notPeer');
    expect(() => takePeerQr(qr({ secret: 'zz'.repeat(32) }))).toThrow('notPeer');
    expect(() => takePeerQr(qr({ secret: null }))).toThrow('notPeer');
    expect(() => takePeerQr(qr({ secret: ['a'] }))).toThrow('notPeer');
    expect(peers()).toEqual([]);
  });
  it('refuses this phone’s own code as self', () => {
    expect(() => takePeerQr(qr({ id: 'me-1' }))).toThrow('self');
    expect(peers()).toEqual([]);
  });
  it('takes a sound code, upper-case hex too, and fills the gaps', () => {
    const p = takePeerQr(qr({ secret: 'AB'.repeat(32), name: '', kind: 'fridge', ram: undefined, bw: undefined, port: '50551' }));
    expect(p).toMatchObject({ id: 'w-1', name: '192.168.1.5', host: '192.168.1.5', port: 50551, kind: 'phone', ram: null, bw: null, passport: null, last_ok: null });
    expect(typeof p.port).toBe('number');
    expect(peers()).toHaveLength(1);
    expect(takePeerQr(qr({ kind: 'tablet' })).kind).toBe('tablet');
  });
  it('keeps the passport that rides along, and survives one that cannot be linked', () => {
    const passport = { schema: 'passport/0.3', device: 'MacBook', device_id: 'w-1' };
    expect(takePeerQr(qr({ passport })).passport).toEqual(passport);
    expect(() => takePeerQr(qr({ passport: 'not an object' }))).not.toThrow();
  });
  it('keeps at most eight peers, the newest first', () => {
    for (let i = 0; i < 10; i++) takePeerQr(qr({ id: `w-${i}` }));
    expect(peers()).toHaveLength(8);
    expect(peers()[0].id).toBe('w-9');
  });
});

describe('myPeerQr', () => {
  it('makes a v2 code with a fresh 32-byte secret and keeps it for next time', async () => {
    const first = await myPeerQr();
    const o = JSON.parse(first.qr);
    expect(o).toMatchObject({ k: 'kula-peer', v: 2, id: 'me-1', host: '192.168.1.20', port: 50551, kind: 'phone', ram: 3000 });
    expect(o.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(share()).toEqual(first.share);
    const second = await myPeerQr();
    expect(JSON.parse(second.qr).secret).toBe(o.secret);
    // the code reads back as a peer on another phone, and as 'self' on this one
    expect(isPeerQr(first.qr)).toBe(true);
    expect(() => takePeerQr(first.qr)).toThrow('self');
    setMyWorkerId('other');
    expect(takePeerQr(first.qr).id).toBe('me-1');
  });
});
