// Apart mode without a phone (5.11.2026): the engine's chat() hands a request to the device
// expected to finish first, measures the reply to refine the pick, and when a peer drops
// a request before its first token the request moves to another device and the peer sits
// out. The native module, the peer's api (XHR) and fetch are faked at the edge.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';

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
jest.mock('@/data/passport', () => ({ lastPassport: () => ({ device: 'Pixel 6a', mem_bw_read_gbs: 18 }) }));
jest.mock('expo-device', () => ({ deviceType: 1, DeviceType: { TABLET: 2, DESKTOP: 3 }, osVersion: '15', totalMemory: 8e9 }));

type Listener = (e: unknown) => void;
const mockListeners: Record<string, Set<Listener>> = { onToken: new Set(), onDone: new Set(), onPeerFound: new Set() };
const mockEmit = (ev: string, e: unknown) => mockListeners[ev].forEach((fn) => fn(e));
const mockNative = {
  addListener: (ev: string, fn: Listener) => {
    mockListeners[ev].add(fn);
    return { remove: () => mockListeners[ev].delete(fn) };
  },
  info: async () => ({ ramFreeMb: 4000, workerId: 'me', wifiIp: '10.0.0.1' }),
  loadModel: async () => ({ loadMs: 10, localLayers: 28, layers: 28, ctx: 1024, split: [] }),
  unload: async () => {},
  probePeer: async () => null,
  apiTunnel: async () => 4321,
  generate: () => {
    setTimeout(() => {
      mockEmit('onToken', { id: 1, text: 'local' });
      mockEmit('onDone', { id: 1, tokens: 5, ms: 500, firstMs: 50, tps: 10, stopped: false, error: null });
    }, 1);
    return 1;
  },
  stop: () => {},
};
jest.mock('@/llm/native', () => ({ native: () => mockNative, hasNative: () => true, get llama() { return mockNative; } }));

// the peer's api: /load answers done; /chat behaves as the test says
let peerMode: 'ok' | 'gone' | 'midway' = 'ok';
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => ({ ok: true, status: 200, text: async () => (String(url).endsWith('/load') ? 'data: {"done":true}\n' : ''), json: async () => ({}) });
class FakeXhr {
  readyState = 0;
  status = 200;
  responseText = '';
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  abort() {}
  send() {
    setTimeout(() => {
      if (peerMode === 'gone') return this.onerror?.();
      this.readyState = 3;
      this.responseText = 'data: {"t":"remote"}\n\n';
      this.onreadystatechange?.();
      if (peerMode === 'midway') return this.onerror?.();
      this.responseText += 'data: {"done":true,"tokens":5,"ms":100,"firstMs":20,"tps":50}\n\n';
      this.readyState = 4;
      this.onreadystatechange?.();
    }, 1);
  }
}
(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;

import { chat, engine, load, OUT_MS } from '@/llm/engine';
import type { LocalModel, Peer } from '@/llm/store';

const model: LocalModel = { id: 'qwen3-0.6b-q8', name: 'Qwen3 0.6B', file: 'q.gguf', path: '/m/q.gguf', size: 639446688, sha256: null, params_b: 0.6, quant: 'Q8_0', kv_mb_per_1k: 56, ctx_max: 32768, license: null, source: 'catalog', url: '', added_at: '' };
const pc: Peer = { id: 'mac', name: 'MacBook', host: '10.0.0.5', port: 50551, secret: 'ab'.repeat(32), kind: 'pc', ram: 4000, bw: 68, added_at: '' };
const msgs = (n: number) => [{ role: 'user' as const, content: 'x'.repeat(n * 4) }];

describe('apart mode dispatch in the engine', () => {
  it('loads a copy on the peer and estimates both devices’ speed from their numbers', async () => {
    await load(model, 'apart', 1024, [pc]);
    const devs = engine().devices;
    expect(JSON.stringify(engine().plan?.skipped.map((s) => s.why))).toBe('[]');
    expect(devs.map((d) => d.id)).toEqual(['me', 'mac']);
    expect(devs[1].tps).toBeGreaterThan(devs[0].tps); // 68 GB/s × 0.3 beats 18 × 0.6
  });
  it('sends a long request to the faster peer, a short one to whoever is free, and learns the measured speed', async () => {
    let clock = 0;
    const now = () => clock;
    const r1 = await chat(msgs(1500), () => {}, { maxTokens: 400, temperature: 0, now });
    expect(r1.device).toBe('MacBook');
    expect(engine().devices[1].tps).toBe(50); // measured on that reply
    // the peer is booked for a long one; a short request goes to this phone instead
    const long = chat(msgs(2000), () => {}, { maxTokens: 800, temperature: 0, now });
    const short = await chat(msgs(10), () => {}, { maxTokens: 20, temperature: 0, now });
    expect(short.device).toBe('Pixel 6a');
    await long;
  });
  it('a peer gone before the first token: the request moves here, the peer sits out, then comes back', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    peerMode = 'gone';
    let text = '';
    const r = await chat(msgs(1500), (t) => { text += t; }, { maxTokens: 400, temperature: 0, now });
    expect(r.device).toBe('Pixel 6a');
    expect(text).toBe('local');
    expect(engine().devices[1].out).toBe(true);
    peerMode = 'ok';
    // still out: even a long request stays here
    expect((await chat(msgs(1500), () => {}, { maxTokens: 400, temperature: 0, now })).device).toBe('Pixel 6a');
    clock += OUT_MS + 1;
    expect((await chat(msgs(1500), () => {}, { maxTokens: 400, temperature: 0, now })).device).toBe('MacBook');
    expect(engine().devices[1].out).toBe(false);
  });
  it('a peer that drops midway does not retry (half an answer is already out) and rejects', async () => {
    peerMode = 'midway';
    await expect(chat(msgs(1500), () => {}, { maxTokens: 400, temperature: 0, now: () => 5_000_000 })).rejects.toThrow('peer gone');
    peerMode = 'ok';
  });
});
