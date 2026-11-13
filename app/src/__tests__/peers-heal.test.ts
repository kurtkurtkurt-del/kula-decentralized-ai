// P42 (13.11.2026): the stored peer list is healed on every read. A peer saved by an older
// build can hold a non-string name, a bad field, or the list may not be a list at all; peers()
// hands back only known keys with sane values and writes nothing.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockStore = new Map<string, string>();
const mockWrites: string[] = [];
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItemSync: (k: string) => mockStore.get(k) ?? null,
    setItemSync: (k: string, v: string) => {
      mockWrites.push(k);
      mockStore.set(k, v);
    },
    removeItemSync: (k: string) => mockStore.delete(k),
    getAllKeysSync: () => [...mockStore.keys()],
  },
}));
jest.mock('expo-device', () => ({ deviceType: 1, DeviceType: { TABLET: 2, DESKTOP: 3 }, osVersion: '15', totalMemory: 8e9 }));
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/offline', () => ({ newId: () => Math.random().toString(36).slice(2), remember: async (_g: string, _k: string, w: () => Promise<unknown>) => w(), must: async (q: Promise<{ data: unknown }>) => (await q).data, send: async () => ({}), outbox: () => {}, invalidate: () => {}, pendingJobs: () => [], useShelf: () => 0 }));
const mockLlama = { info: async () => ({ available: true, workerId: 'me-1', wifiIp: '192.168.1.20', ramFreeMb: 3000 }), workerStatus: async () => null };
jest.mock('@/llm/native', () => ({ get llama() { return mockLlama; }, native: () => mockLlama, hasNative: () => true, GATE_PORT: 50551 }));

import { cleanName, parsePeerQr, parseRelayCode, peerName, setMyWorkerId } from '@/llm/peers';
import { healPeers, peers, touchPeer } from '@/llm/store';

const KEY = 'llm.peers';
const store = (v: unknown) => mockStore.set(KEY, JSON.stringify(v));
const base = { id: 'w-1', name: 'Mac', host: '10.0.0.5', port: 50551, secret: '', kind: 'pc', ram: 1, bw: 2, added_at: '2026-11-01T00:00:00.000Z' };
const one = (over: Record<string, unknown>) => healPeers([{ ...base, ...over }])[0];

beforeEach(() => {
  mockStore.clear();
  mockWrites.length = 0;
  setMyWorkerId('me-1');
});

describe('healPeers', () => {
  it('gives back a list parsePeerQr and parseRelayCode made unchanged', () => {
    const v2 = parsePeerQr(JSON.stringify({ k: 'kula-peer', v: 2, id: 'w-2', name: 'MacBook', host: '192.168.1.5', port: 50551, secret: 'ab'.repeat(32), kind: 'pc', ram: 16000, bw: 60 }));
    const v3 = parsePeerQr(JSON.stringify({ k: 'kula-peer', v: 3, id: 'w-3', name: 'Pixel', host: '192.168.1.40', port: 50551, fp: 'a1'.repeat(32), pin: '1234', kind: 'phone', relay: { url: 'https://relay.example', code: '123456' } }));
    const code = parseRelayCode('654321 0123456789abcdef', 'wss://relay.example');
    expect(v3.relay).toEqual({ url: 'wss://relay.example', code: '123456' });
    const list = [v2, v3, code];
    store(list);
    expect(peers()).toEqual(list);
  });

  it('a stored value that is no list reads as none', () => {
    for (const v of [{}, 'x', null]) {
      store(v);
      expect(peers()).toEqual([]);
    }
  });

  it('drops entries that are no object, have no usable id, repeat an id, or come ninth', () => {
    const long = 'a'.repeat(201);
    expect(healPeers([null, 7, [], { name: 'a' }, { ...base, id: long }])).toEqual([]);
    const two = healPeers([{ ...base, name: 'first' }, { ...base, name: 'second' }]);
    expect(two).toHaveLength(1);
    expect(two[0].name).toBe('first');
    const nine = healPeers(Array.from({ length: 9 }, (_, i) => ({ ...base, id: `w-${i}` })));
    expect(nine.map((p) => p.id)).toEqual(['w-0', 'w-1', 'w-2', 'w-3', 'w-4', 'w-5', 'w-6', 'w-7']);
  });

  it('a bad name becomes the host; a name with controls and overrides comes back clean and short', () => {
    expect(healPeers([{ id: 'w-1', name: 7, host: '10.0.0.5' }])[0].name).toBe('10.0.0.5');
    const name = one({ name: `Ev\u{a}il\u{202e}gpj.exe ${'x'.repeat(100)}` }).name;
    expect(name).not.toMatch(/[\u{a}\u{202e}]/u);
    expect(name.startsWith('Ev ilgpj.exe')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(80);
  });

  it('a bad field becomes its empty value', () => {
    expect(one({ port: 'x' }).port).toBe(0);
    expect(one({ kind: 'tv' }).kind).toBe('phone');
    expect(one({ ram: NaN }).ram).toBeNull();
    expect(one({ fp: 'zz' }).fp).toBeNull();
    expect(one({ fp: '' }).fp).toBe('');
    expect(one({ relay: { url: 'ftp://x', code: '1' } }).relay).toBeNull();
    expect(one({ passport: 'x' }).passport).toBeNull();
    expect(one({ added_at: 5 }).added_at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('keeps known keys only', () => {
    expect(Object.keys(one({ evil: 1 }))).not.toContain('evil');
  });
});

describe('peers() on the store', () => {
  it('reading writes nothing; touchPeer stores the healed list', () => {
    const raw = [{ ...base, name: 7, junk: true }, null, { ...base, id: 'w-9', port: 'x' }];
    store(raw);
    const healed = peers();
    expect(mockWrites).toEqual([]);
    expect(healed.map((p) => p.id)).toEqual(['w-1', 'w-9']);
    touchPeer('w-1', { last_ok: '2026-11-13T00:00:00.000Z' });
    const stored = JSON.parse(mockStore.get(KEY)!);
    expect(stored).toEqual(healed.map((p) => (p.id === 'w-1' ? { ...p, last_ok: '2026-11-13T00:00:00.000Z' } : p)));
    expect(stored[0].name).toBe('10.0.0.5');
    expect(stored[1].port).toBe(0);
  });
});

describe('the names still come from peers', () => {
  it('peerName and cleanName import from @/llm/peers', () => {
    expect(typeof peerName).toBe('function');
    expect(typeof cleanName).toBe('function');
    expect(peerName({ name: 7, host: '', id: 'w-1' })).toBe('w-1');
    expect(cleanName(' a\u{200b}b ')).toBe('ab');
  });
});
