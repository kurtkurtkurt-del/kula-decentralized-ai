// chatRemote against a fake XMLHttpRequest (5.11.2026): the sse stream from a peer's api
// tunnel, as React Native delivers it: in pieces, a line cut in two, the last bytes in a
// readyState 3 event with an empty readyState 4 after it, an error object in the stream,
// a 409 busy with a json body, and the socket going away. Then chat()'s choice of device
// and load() in its three modes against a fake native module.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
jest.mock('@/data/passport', () => ({ lastPassport: () => ({ device: 'Pixel', mem_bw_read_gbs: 18 }) }));

// the fake native module for load(): one probe answer per host, a tunnel port per peer
const mockNative = {
  probe: {} as Record<string, string | null>,
  loads: [] as unknown[][],
  unloads: 0,
  info: async () => ({ available: true, abi: 'arm64-v8a', fastCores: 4, ramFreeMb: 4000, modelsDir: '/m', freeDiskMb: 9000, workerId: 'me', wifiIp: null }),
  probePeer: async (host: string) => (host in mockNative.probe ? mockNative.probe[host] : 'refused'),
  apiTunnel: async (host: string) => 40000 + Number(host.split('.').pop()),
  loadModel: async (...args: unknown[]) => {
    mockNative.loads.push(args);
    const peers = args[3] as { port: number }[];
    return { loadMs: 10, localLayers: 10, layers: 20, ctx: args[1], split: [{ buffer: 'CPU', mb: 400 }, ...peers.map((_p, i) => ({ buffer: `RPC${i}[127.0.0.1:${5000 + i}]`, mb: 600 }))] };
  },
  unload: async () => { mockNative.unloads++; },
  addListener: () => ({ remove: () => {} }),
  discover: async () => {},
};
jest.mock('@/llm/native', () => ({ get llama() { return mockNative; }, native: () => mockNative, hasNative: () => true, GATE_PORT: 50551 }));

import { chat, chatRemote, engine, load, unload, type Device } from '@/llm/engine';
import { settings, type LocalModel, type Peer } from '@/llm/store';

// ---- the fake xhr -------------------------------------------------------------------------
type Script = { status?: number; steps: string[]; error?: boolean; tail?: boolean };
class FakeXhr {
  static script: Script = { steps: [] };
  static sent: { url: string; body: string; aborted: boolean }[] = [];
  readyState = 0;
  status = 0;
  responseText = '';
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = '';
  private rec = { url: '', body: '', aborted: false };
  open(_m: string, url: string) { this.url = url; }
  setRequestHeader() {}
  abort() { this.rec.aborted = true; }
  send(body: string) {
    this.rec = { url: this.url, body, aborted: false };
    FakeXhr.sent.push(this.rec);
    const s = FakeXhr.script;
    setTimeout(() => {
      if (s.error) return this.onerror?.();
      this.status = s.status ?? 200;
      this.readyState = 2;
      this.onreadystatechange?.();
      for (const piece of s.steps) {
        this.responseText += piece;
        this.readyState = 3;
        this.onreadystatechange?.();
      }
      // RN often fires the final readyState 4 with nothing new in responseText
      this.readyState = 4;
      this.onreadystatechange?.();
    }, 1);
  }
}
const realXhr = globalThis.XMLHttpRequest;
const realFetch = globalThis.fetch;
const fetched: string[] = [];
beforeEach(() => {
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
  globalThis.fetch = (async (url: string) => { fetched.push(String(url)); return { ok: true, text: async () => 'data: {"done":true}\n\n' } as unknown as Response; }) as unknown as typeof fetch;
  FakeXhr.sent = [];
  fetched.length = 0;
  mockStore.clear();
  mockNative.probe = {};
  mockNative.loads = [];
  mockNative.unloads = 0;
});
afterEach(() => {
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = realXhr;
  globalThis.fetch = realFetch;
});

const dev: Device = { id: 'p1', name: 'tablet', local: false, busy: false, apiPort: 41001 };
const line = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const doneLine = line({ done: true, tokens: 3, ms: 30, firstMs: 10, tps: 100 });
const ask = (script: Script) => {
  FakeXhr.script = script;
  const got: string[] = [];
  const p = chatRemote(dev, [{ role: 'user', content: 'hi' }], (t) => got.push(t), { maxTokens: 8, temperature: 0.5, reset: true });
  return { p, got };
};

describe('chatRemote', () => {
  it('posts the request to the tunnel and streams whole events', async () => {
    const { p, got } = ask({ steps: [line({ t: 'hel' }), line({ t: 'lo' }) + doneLine] });
    const r = await p;
    expect(got).toEqual(['hel', 'lo']);
    expect(r).toEqual({ tokens: 3, ms: 30, firstMs: 10, tps: 100, stopped: false, device: 'tablet' });
    expect(FakeXhr.sent[0].url).toBe('http://127.0.0.1:41001/chat');
    expect(JSON.parse(FakeXhr.sent[0].body)).toEqual({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0.5, reset: true });
  });
  it('waits for the rest of a line cut in two, and an event split before its blank line', async () => {
    const one = line({ t: 'merhaba' });
    const { p, got } = ask({ steps: [one.slice(0, 9), one.slice(9, 14), one.slice(14, -1), one.slice(-1), line({ t: ' dünya' }).slice(0, -2), '\n\n' + doneLine] });
    await p;
    expect(got).toEqual(['merhaba', ' dünya']);
  });
  it('resolves when the done event came in the last readyState 3 and readyState 4 brings nothing', async () => {
    const { p } = ask({ steps: [line({ t: 'a' }), doneLine] });
    await expect(p).resolves.toMatchObject({ tokens: 3 });
  });
  it('resolves when everything arrives at once in readyState 4', async () => {
    FakeXhr.script = { steps: [] };
    const got: string[] = [];
    const xhrSend = FakeXhr.prototype.send;
    FakeXhr.prototype.send = function (this: FakeXhr) {
      setTimeout(() => { this.status = 200; this.responseText = line({ t: 'x' }) + doneLine; this.readyState = 4; this.onreadystatechange?.(); }, 1);
    };
    const r = await chatRemote(dev, [], (t) => got.push(t), { maxTokens: 1, temperature: 0 });
    FakeXhr.prototype.send = xhrSend;
    expect(got).toEqual(['x']);
    expect(r.tokens).toBe(3);
  });
  it('skips what is not an event: comments, keep-alives, broken json', async () => {
    const { p, got } = ask({ steps: [': ping\n\n', 'data: {not json\n\n', 'event: x\n\n', line({ t: 'ok' }), doneLine] });
    await p;
    expect(got).toEqual(['ok']);
  });
  it('rejects with the error the peer put in the stream', async () => {
    const { p, got } = ask({ steps: [line({ t: 'par' }), line({ error: 'llama-server: 500' })] });
    await expect(p).rejects.toThrow('llama-server: 500');
    expect(got).toEqual(['par']);
  });
  it('rejects with the http status when the peer is busy (409) and sends no stream', async () => {
    const { p } = ask({ status: 409, steps: ['{"error":"busy"}'] });
    await expect(p).rejects.toThrow('peer http 409');
  });
  it('rejects with the status when the stream ended without a done event', async () => {
    const { p } = ask({ status: 200, steps: [line({ t: 'half' })] });
    await expect(p).rejects.toThrow('peer http 200');
  });
  it('says peer gone when the socket dies, and when it closes with status 0', async () => {
    await expect(ask({ steps: [], error: true }).p).rejects.toThrow('peer gone');
    await expect(ask({ status: 0, steps: [] }).p).rejects.toThrow('peer gone');
  });
  it('stop() aborts the request and knocks on /stop', async () => {
    const { p } = ask({ status: 0, steps: [] });
    p.stop();
    await expect(p).rejects.toThrow('peer gone');
    expect(FakeXhr.sent[0].aborted).toBe(true);
    expect(fetched).toEqual(['http://127.0.0.1:41001/stop']);
  });
});

// ---- chat(): the choice of device ----------------------------------------------------------
const model: LocalModel = { id: 'm', name: 'tiny', file: 'tiny.gguf', path: '/m/tiny.gguf', size: 500 * 1024 * 1024, sha256: null, params_b: 0.6, quant: 'q8', kv_mb_per_1k: 28, ctx_max: 4096, license: null, source: 'catalog', url: 'https://x/tiny.gguf', added_at: '' };
const peer = (n: number, bw = 10): Peer => ({ id: `p${n}`, name: `peer${n}`, host: `10.0.0.${n}`, port: 50551, secret: 'a'.repeat(64), kind: 'phone', ram: 4000, bw, added_at: '' });

describe('chat', () => {
  it('throws nomodel with no devices', async () => {
    await unload();
    expect(() => chat([], () => {}, { maxTokens: 1, temperature: 0 })).toThrow('nomodel');
  });
  it('takes the first free device, marks it busy, and frees it after', async () => {
    mockNative.probe = { '10.0.0.1': null };
    await load(model, 'apart', 1024, [peer(1)]);
    const devs = engine().devices;
    expect(devs.map((d) => d.id)).toEqual(['me', 'p1']);
    devs[0].busy = true; // this phone is in the middle of something: the tablet gets it
    FakeXhr.script = { steps: [line({ t: 'x' }), doneLine] };
    const run = chat([{ role: 'user', content: 'q' }], () => {}, { maxTokens: 1, temperature: 0 });
    expect(devs[1].busy).toBe(true);
    const r = await run;
    expect(r.device).toBe('peer1');
    expect(devs[1].busy).toBe(false);
    // an explicit device wins even when busy
    const again = chat([], () => {}, { maxTokens: 1, temperature: 0, device: 'p1' });
    await again;
    expect(FakeXhr.sent).toHaveLength(2);
  });
});

describe('load', () => {
  it('alone: one device, the model on this phone, the settings remembered', async () => {
    await load(model, 'alone', 2048, []);
    const s = engine();
    expect(s.mode).toBe('alone');
    expect(s.devices).toEqual([{ id: 'me', name: 'Pixel', local: true, busy: false }]);
    expect(s.split).toEqual([{ name: 'Pixel', gb: 0.5 }]);
    expect(s.loading).toBeNull();
    expect(mockNative.loads[0]).toEqual(['/m/tiny.gguf', 2048, 0, [], 1]);
    expect(settings()).toMatchObject({ modelId: 'm', ctx: 2048, lastMode: 'alone' });
  });
  it('apart: a device per peer that answered and loaded, the rest in skipped', async () => {
    mockNative.probe = { '10.0.0.1': null, '10.0.0.2': null, '10.0.0.3': 'NO busy' };
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url));
      const ok = !String(url).includes('40002');
      return { ok: true, text: async () => (ok ? 'data: {"state":"loading"}\n\ndata: {"done":true}\n\n' : 'data: {"error":"checksum mismatch"}\n\n') } as unknown as Response;
    }) as unknown as typeof fetch;
    await load(model, 'apart', 1024, [peer(1), peer(2), peer(3)]);
    const s = engine();
    expect(s.devices.map((d) => d.id)).toEqual(['me', 'p1']);
    expect(s.devices[1]).toMatchObject({ apiPort: 40001, local: false, peer: expect.objectContaining({ id: 'p1' }) });
    expect(s.plan!.skipped.map((b) => `${b.peer.id}:${b.why}`).sort()).toEqual(['p2:checksum mismatch', 'p3:NO busy']);
    expect(fetched.filter((u) => u.endsWith('/load'))).toHaveLength(2);
  });
  it('split: the plan is made, the peers are handed over with their weights and named in the summary', async () => {
    mockNative.probe = { '10.0.0.1': null };
    const big = { ...model, size: 4000 * 1024 * 1024 }; // 4 gb: this phone holds 2800 of 4400
    await load(big, 'split', 1024, [peer(1, 30)]);
    const s = engine();
    expect(s.plan!.used[0].id).toBe('p1');
    const args = mockNative.loads[0];
    expect(args[3]).toEqual([{ host: '10.0.0.1', port: 50551, secret: 'a'.repeat(64), weight: 3000 }]);
    expect(args[4]).toBe(1400);
    expect(s.split.map((x) => x.name)).toEqual(['peer1', 'Pixel']); // the rpc buffer named after the peer, biggest first
    expect(s.devices).toHaveLength(1);
  });
  it('split that does not fit: the error is kept, the model unloaded, and the promise rejects', async () => {
    const huge = { ...model, size: 40000 * 1024 * 1024 };
    await expect(load(huge, 'split', 1024, [])).rejects.toThrow('toobig');
    expect(engine()).toMatchObject({ error: 'toobig', model: null, loading: null });
    expect(mockNative.unloads).toBe(1);
  });
});
