// "see the power" tests (6.11.2026): the code taken the peers page's way, the ping's middle
// time and the pin it spends, the speed test's sum and its "× this phone alone".
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
const mockLinked: string[] = [];
jest.mock('@/data/passport', () => ({
  lastPassport: () => ({ device: 'Pixel' }),
  deviceId: () => 'dev-me',
  linkPassport: (text: string) => {
    if (!text.startsWith('{')) throw new Error('notPassport');
    mockLinked.push(text);
    return {};
  },
}));
const mockProbe = { calls: [] as { id: string; pin: string | null | undefined; channel: string }[], answer: (_id: string): boolean => true };
jest.mock('@/llm/cluster', () => ({
  probeAll: async (list: { id: string; pin?: string | null }[], channel: string) => {
    const p = list[0];
    mockProbe.calls.push({ id: p.id, pin: p.pin, channel });
    return mockProbe.answer(p.id) ? { ok: [{ ...p, pin: null }], bad: [] } : { ok: [], bad: [{ peer: p, why: 'refused' }] };
  },
}));
jest.mock('@/llm/engine', () => ({ chatLocal: () => Promise.reject(new Error('unused')), chatRemote: () => Promise.reject(new Error('unused')) }));
jest.mock('@/llm/native', () => ({ llama: null, native: () => { throw new Error('nonative'); }, hasNative: () => false, GATE_PORT: 50551 }));

import { median, pingPeer, speedTest, takeCode, trialModel } from '@/components/together/tests';
import { peers, type LocalModel, type Peer } from '@/llm/store';
import type { Device } from '@/llm/engine';

const FP = 'a'.repeat(64);
const peer = (id: string, extra: Partial<Peer> = {}): Peer => ({ id, name: id, host: '10.0.0.2', port: 50551, secret: '', fp: FP, pin: '1234', paired_at: null, relay: null, kind: 'phone', ram: null, bw: null, passport: null, added_at: '', last_ok: null, ...extra });

beforeEach(() => {
  mockStore.clear();
  mockLinked.length = 0;
  mockProbe.calls.length = 0;
  mockProbe.answer = () => true;
});

describe('takeCode', () => {
  it('stores a v3 peer qr like the peers page', () => {
    const r = takeCode(JSON.stringify({ k: 'kula-peer', v: 3, id: 'w1', name: 'Galaxy', host: '10.0.0.5', port: 50551, fp: FP, pin: '998877', kind: 'phone' }));
    expect(r).toEqual({ kind: 'peer', name: 'galaxy' });
    expect(peers().map((p) => p.id)).toEqual(['w1']);
    expect(peers()[0].pin).toBe('998877');
  });
  it('links an old passport-only code and refuses junk with its reason', () => {
    expect(takeCode('{"device":"x"}').kind).toBe('passport');
    expect(mockLinked).toHaveLength(1);
    expect(() => takeCode('hello')).toThrow('notPassport');
    expect(() => takeCode(JSON.stringify({ k: 'kula-peer', v: 1, id: 'x', host: 'h', port: 1, secret: 'ab' }))).toThrow('old');
  });
  it('wants a relay before a six digit code', () => {
    expect(() => takeCode('123456')).toThrow('noRelay');
  });
});

describe('ping', () => {
  it('takes the middle of three knocks and spends the pin after the first', async () => {
    let t = 0;
    const steps = [0, 50, 100, 120, 200, 230];
    const r = await pingPeer(peer('p1'), 3, () => steps[t++]);
    expect(r).toEqual({ id: 'p1', ok: true, ms: 30, why: null });
    expect(mockProbe.calls.map((c) => c.pin)).toEqual(['1234', null, null]);
    expect(mockProbe.calls[0].channel).toBe('rpc');
  });
  it('says why a phone did not answer; a far one is asked on api', async () => {
    mockProbe.answer = () => false;
    const r = await pingPeer(peer('p2', { relay: { url: 'wss://r', code: '123456' } }));
    expect(r).toMatchObject({ ok: false, ms: null, why: 'refused' });
    expect(mockProbe.calls[0].channel).toBe('api');
  });
  it('median', () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(3);
  });
});

describe('speed test', () => {
  const dev = (id: string, local: boolean): Device => ({ id, name: id, local, busy: false, tps: 1, busyUntil: 0 });
  it('runs every device at once and adds the speeds', async () => {
    const devices = [dev('me', true), dev('a', false), dev('b', false)];
    const reply = (tps: number) => Promise.resolve({ tokens: 32, ms: 1000, firstMs: 100, tps, stopped: false, device: '' });
    let clock = 0;
    const r = await speedTest(devices, {
      run: { local: () => reply(8), remote: (d) => (d.id === 'a' ? reply(12.04) : Promise.reject(new Error('peer gone'))) },
      now: () => (clock += 1500),
    });
    expect(r.rows.map((x) => [x.id, x.tps, x.error])).toEqual([['me', 8, null], ['a', 12, null], ['b', 0, 'peer gone']]);
    expect(r.total).toBe(20);
    expect(r.alone).toBe(8);
    expect(r.times).toBe(2.5);
    expect(r.tokens).toBe(64);
    expect(r.wallMs).toBe(1500);
    expect(devices[1].tps).toBe(12); // the dispatcher learns the measured speed
  });
  it('has nothing to say alone or with no model', async () => {
    const r = await speedTest([dev('me', true)], { run: { local: () => Promise.resolve({ tokens: 5, ms: 1, firstMs: 1, tps: 9, stopped: false, device: '' }), remote: () => Promise.reject(new Error('x')) } });
    expect(r.times).toBeNull();
    await expect(speedTest([])).rejects.toThrow('nomodel');
  });
  it('picks the running model, else the chosen one, else the first ready', () => {
    const m = (id: string, path: string | null) => ({ id, path }) as unknown as LocalModel;
    const list = [m('a', '/a'), m('b', '/b'), m('c', null)];
    expect(trialModel(list, m('b', '/b'), 'a')?.id).toBe('b');
    expect(trialModel(list, null, 'b')?.id).toBe('b');
    expect(trialModel(list, null, 'c')?.id).toBe('a');
    expect(trialModel([], null, null)).toBeNull();
  });
});
