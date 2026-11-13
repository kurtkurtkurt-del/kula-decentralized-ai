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
const mockLlama = { info: async () => ({ available: true, abi: 'arm64-v8a', fastCores: 4, ramFreeMb: 3000, modelsDir: '/m', freeDiskMb: 9000, workerId: 'me-1', wifiIp: '192.168.1.20' }), workerStatus: async () => null };
jest.mock('@/llm/native', () => ({ get llama() { return mockLlama; }, native: () => mockLlama, hasNative: () => true, GATE_PORT: 50551 }));

import { isPeerQr, myPeerQr, parsePeerQr, peerName, setMyWorkerId, takePeerQr } from '@/llm/peers';
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
  it('refuses another version as old (v1, a future v4); v3 is read since gate v2', () => {
    expect(() => takePeerQr(qr({ v: 1 }))).toThrow('old');
    expect(() => takePeerQr(qr({ v: 4 }))).toThrow('old');
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

describe('parsePeerQr against odd names, ids and hosts (E6, E5)', () => {
  const v3 = { k: 'kula-peer', v: 3, id: 'w-3', name: 'Pixel', host: '192.168.1.40', port: 50551, fp: 'a1'.repeat(32), kind: 'phone' };
  it('gives a string name (the host) for a name that is a number, an object or an array', () => {
    for (const name of [7, {}, []]) {
      const p = parsePeerQr(qr({ name }));
      expect(typeof p.name).toBe('string');
      expect(p.name).toBe('192.168.1.5');
      expect(() => p.name.toLowerCase()).not.toThrow();
    }
  });
  it('refuses an id that is not a string, or longer than 200 chars', () => {
    expect(() => parsePeerQr(qr({ id: 7 }))).toThrow('notPeer');
    expect(() => parsePeerQr(qr({ id: ['w'] }))).toThrow('notPeer');
    expect(() => parsePeerQr(qr({ id: 'w'.repeat(201) }))).toThrow('notPeer');
    expect(parsePeerQr(qr({ id: 'w'.repeat(200) })).id).toHaveLength(200);
  });
  it('refuses a host that is not a string for a code without a relay', () => {
    expect(() => parsePeerQr(qr({ host: 7 }))).toThrow('notPeer');
    expect(() => parsePeerQr(qr({ host: { a: 1 } }))).toThrow('notPeer');
    expect(() => parsePeerQr(JSON.stringify({ ...v3, host: 7 }))).toThrow('notPeer');
  });
  it('cleans a name with line breaks and direction marks, and cuts it to 80 chars', () => {
    const p = parsePeerQr(qr({ name: 'pixel\n\n\u{2713} trust: all clear, nothing to do\u{202e}' }));
    expect(p.name).toBe('pixel \u{2713} trust: all clear, nothing to do');
    expect(parsePeerQr(qr({ name: 'a\u{200b}b\u{2028}c\u{85}d\u{feff}' })).name).toBe('ab c d');
    expect(parsePeerQr(qr({ name: '\n\u{202e}\t' })).name).toBe('192.168.1.5');
    const long = parsePeerQr(qr({ name: '\u{202e}'.repeat(50) + 'x'.repeat(100) })).name;
    expect(long).toBe('x'.repeat(80));
    expect(parsePeerQr(qr({ name: 'Ay\u{15f}e\u{2019}s Pixel 8' })).name).toBe('Ay\u{15f}e\u{2019}s Pixel 8');
  });
  it('reads valid v2 and v3 codes as before', () => {
    expect(parsePeerQr(JSON.stringify(good))).toMatchObject({ id: 'w-1', name: 'MacBook', host: '192.168.1.5', port: 50551, secret: 'ab'.repeat(32), fp: null, kind: 'pc', ram: 16000, bw: 60, relay: null });
    expect(parsePeerQr(JSON.stringify({ ...v3, pin: '1234' }))).toMatchObject({ id: 'w-3', name: 'Pixel', host: '192.168.1.40', port: 50551, fp: 'a1'.repeat(32), pin: '1234', secret: '', relay: null });
    const relayed = parsePeerQr(JSON.stringify({ ...v3, host: undefined, port: undefined, name: undefined, relay: { url: 'https://relay.example', code: '123456' } }));
    expect(relayed).toMatchObject({ name: 'code 123456', host: '', port: 0, relay: { url: 'wss://relay.example', code: '123456' } });
  });
});

describe('peerName: a peer stored before the name was checked (old peers)', () => {
  it('falls back to the host, then the id, for a name that is not a string', () => {
    expect(peerName({ name: 7, host: '10.0.0.5', id: 'w-1' })).toBe('10.0.0.5');
    expect(peerName({ name: {}, id: 'w-1' })).toBe('w-1');
    expect(peerName({ name: [], id: 'w-1' })).toBe('w-1');
    expect(peerName({})).toBe('?');
  });
  it('cleans a string name and cuts it to 80 chars', () => {
    expect(peerName({ name: 'pixel\n\u{202e}8', id: 'w-1' })).toBe('pixel 8');
    const long = peerName({ name: '\u{202e}' + 'x'.repeat(100) + '\n', id: 'w-1' });
    expect(long).toBe('x'.repeat(80));
    expect(peerName({ name: '\n\u{202e}', host: '10.0.0.5', id: 'w-1' })).toBe('10.0.0.5');
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
