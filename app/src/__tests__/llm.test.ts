// The models layer without a phone: the catalog's shape, the fit arithmetic, the split
// planner's shares, and the peer qr. The native module is absent here (as in Expo Go), so
// everything that needs it is mocked at the edge.
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
jest.mock('expo-device', () => ({ deviceType: 1, DeviceType: { TABLET: 2, DESKTOP: 3 }, osVersion: '15', totalMemory: 8e9 }));
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/offline', () => ({ newId: () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2), remember: async (_g: string, _k: string, w: () => Promise<unknown>) => w(), must: async (q: Promise<{ data: unknown }>) => (await q).data, send: async () => ({}), outbox: () => {}, invalidate: () => {}, pendingJobs: () => [], useShelf: () => 0 }));

import { CATALOG } from '@/llm/catalog';
import { fitOn, fitTogether, needMb, haveMb } from '@/llm/fit';
import { probeAll, REMOTE_NO_SPLIT } from '@/llm/cluster';
import { isPeerQr, isRelayCode, isRemote, learnPeer, makePeerQr, parsePeerQr, parseRelayCode, takePeerQr } from '@/llm/peers';
import { peerRelay, peerTls } from '@/llm/cluster';
import { peers, rememberPeer, saveSettings } from '@/llm/store';
import type { Passport } from '@/passport/contract';

const phone = (over: Partial<Passport> = {}): Passport => ({
  schema: 'passport/0.3', device: 'Pixel 6a', soc: 'Tensor', android: '15', ram_total_gb: 6, ram_free_gb: 3.2, app_mem_cap_mb: 512,
  cpu_cores: 8, cpu_max_ghz: 2.8, mem_bw_gbs: 14, gflops: 40, storage_free_gb: 20, battery_pct: 80, charging: true,
  largest_model_q4: '~3B', est_tps: 6, measured_at: '2026-11-04T00:00:00Z', device_id: 'dev-1', kind: 'phone', mem_bw_read_gbs: 18,
  budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 2.1, q4_k_m_b: 3, q3_k_s_b: 4, q8_0_b: 1 }, ...over,
});

describe('the catalog', () => {
  it('has verified single files with a checksum, a size and an https url', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(8);
    const ids = new Set<string>();
    for (const m of CATALOG) {
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.size).toBeGreaterThan(100e6);
      expect(m.file.endsWith('.gguf')).toBe(true);
      expect(m.file).not.toMatch(/-of-/);
      expect(m.kv_mb_per_1k).toBeGreaterThan(0);
      expect(m.blurb.tr && m.blurb.de && m.blurb.en).toBeTruthy();
    }
  });
});

describe('fit', () => {
  const small = CATALOG.find((m) => m.id === 'qwen3-0.6b-q8')!;
  const big = CATALOG.find((m) => m.id === 'qwen2.5-7b-q4')!;
  it('needs more than the file and less than twice it at 2k context', () => {
    const mb = needMb({ size: small.size, kv_mb_per_1k: small.kv_mb_per_1k, ctx: 2048 });
    expect(mb).toBeGreaterThan(small.size / 1048576);
    expect(mb).toBeLessThan((small.size / 1048576) * 2);
  });
  it('reads the budget when the passport has one, free ram otherwise', () => {
    expect(haveMb(phone())).toBe(Math.round(2.1 * 1024));
    expect(haveMb(phone({ budget: undefined, ram_free_gb: 3 }))).toBe(Math.round(3 * 1024 * 0.8));
    expect(haveMb(null)).toBe(0);
  });
  it('a 0.6B fits a 6 gb phone, a 7B does not, and together two phones hold more', () => {
    const f = fitOn(phone(), { size: small.size, kv_mb_per_1k: small.kv_mb_per_1k, ctx: 2048 });
    expect(f.verdict).toBe('fits');
    expect(f.maxCtx).toBeGreaterThanOrEqual(2048);
    expect(f.tps!.high).toBeGreaterThan(f.tps!.low);
    const b = fitOn(phone(), { size: big.size, kv_mb_per_1k: big.kv_mb_per_1k, ctx: 2048 });
    expect(b.verdict).toBe('no');
    const t = fitTogether([phone(), phone({ device: 'S24', device_id: 'dev-2', budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 4, q4_k_m_b: 7, q3_k_s_b: 8, q8_0_b: 3 } })], { size: big.size, kv_mb_per_1k: big.kv_mb_per_1k, ctx: 2048 });
    expect(t.haveMb).toBeGreaterThan(b.haveMb);
    expect(t.shares.length).toBe(2);
    expect(t.shares.map((s) => s.name).sort()).toEqual(['Pixel 6a', 'S24']);
  });
});

describe('the planner without a phone', () => {
  it('skips every peer as nonative instead of handing llama an unreachable endpoint', async () => {
    const r = await probeAll([{ id: 'p', name: 'x', host: '10.0.0.9', port: 50551, secret: 'a'.repeat(64), kind: 'phone', ram: 3000, bw: 10, added_at: '' }]);
    expect(r.ok).toEqual([]);
    expect(r.bad[0].why).toBe('nonative');
  });
});

describe('the peer qr', () => {
  const qr = { k: 'kula-peer', v: 2, id: 'w-1', name: 'MacBook', host: '192.168.1.5', port: 50551, secret: 'ab'.repeat(32), kind: 'pc', ram: 16000, bw: 60 };
  it('tells a peer code from a passport code', () => {
    expect(isPeerQr(JSON.stringify(qr))).toBe(true);
    expect(isPeerQr(JSON.stringify(phone()))).toBe(false);
    expect(isPeerQr('hello')).toBe(false);
  });
  it('remembers the peer, newest first, once per id', () => {
    takePeerQr(JSON.stringify(qr));
    takePeerQr(JSON.stringify({ ...qr, host: '192.168.1.6' }));
    expect(peers().filter((p) => p.id === 'w-1')).toHaveLength(1);
    expect(peers()[0].host).toBe('192.168.1.6');
    expect(peers()[0].kind).toBe('pc');
  });
  it('refuses what it should', () => {
    expect(() => takePeerQr('{}')).toThrow('notPeer');
    expect(() => takePeerQr(JSON.stringify({ ...qr, v: 1 }))).toThrow('old');
    expect(() => takePeerQr(JSON.stringify({ ...qr, v: 4 }))).toThrow('old');
    expect(() => takePeerQr(JSON.stringify({ ...qr, secret: 'short' }))).toThrow('notPeer');
  });

  // v3 (gate protocol v2): the certificate fingerprint and a one-time pairing code instead of the secret
  const fp = 'AB'.repeat(32);
  const qr3 = { k: 'kula-peer', v: 3, id: 'w-3', name: 'MacBook', host: '192.168.1.7', port: 50551, fp, pin: '0123456789abcdef', kind: 'pc', ram: 16000, bw: 60 };
  it('reads a v3 code: fingerprint lowercased, pin kept until paired, no secret', () => {
    expect(isPeerQr(JSON.stringify(qr3))).toBe(true);
    const p = parsePeerQr(JSON.stringify(qr3));
    expect(p.fp).toBe(fp.toLowerCase());
    expect(p.pin).toBe('0123456789abcdef');
    expect(p.secret).toBe('');
    expect(p.kind).toBe('pc');
    expect(peerTls(p)).toEqual({ fp: fp.toLowerCase(), pin: '0123456789abcdef' });
    // a v3 code without a code (already paired, or shown after the code was spent) still reads
    expect(parsePeerQr(JSON.stringify({ ...qr3, pin: undefined })).pin).toBeNull();
    // a v2 peer has no tls side
    expect(peerTls(parsePeerQr(JSON.stringify(qr)))).toBeNull();
  });
  it('refuses a v3 code with a bad fingerprint', () => {
    expect(() => parsePeerQr(JSON.stringify({ ...qr3, fp: 'abc' }))).toThrow('notPeer');
    expect(() => parsePeerQr(JSON.stringify({ ...qr3, fp: undefined }))).toThrow('notPeer');
  });
  it('makes v3 when there is a fingerprint and v2 otherwise, and either reads back', () => {
    const base = { id: 'me', name: 'phone', host: '10.0.0.2', port: 50551, kind: 'phone' as const, ram: 3000, bw: 14, passport: null };
    const v3 = JSON.parse(makePeerQr({ ...base, secret: 'cd'.repeat(32), fp: fp.toLowerCase(), pin: 'deadbeefdeadbeef' }));
    expect(v3.v).toBe(3);
    expect(v3.fp).toBe(fp.toLowerCase());
    expect(v3.pin).toBe('deadbeefdeadbeef');
    expect(v3.secret).toBeUndefined();
    const v2 = JSON.parse(makePeerQr({ ...base, secret: 'cd'.repeat(32) }));
    expect(v2.v).toBe(2);
    expect(v2.secret).toBe('cd'.repeat(32));
    expect('fp' in v2).toBe(false);
    for (const q of [v2, v3]) expect(() => parsePeerQr(JSON.stringify(q))).not.toThrow();
  });
});

// peers far away (docs/RELAY.md): v3 with a relay, a code typed by hand, and the planner
describe('a peer far away', () => {
  const fp = 'cd'.repeat(32);
  const far = { k: 'kula-peer', v: 3, id: 'w-far', name: 'berlin', host: '10.9.9.9', port: 50551, fp, pin: 'feedfacefeedface', relay: { url: 'https://relay.example/ws', code: '123456' }, kind: 'phone' };
  it('reads a v3 code with a relay, even without a lan address, and never a relayed v2', () => {
    expect(isPeerQr(JSON.stringify(far))).toBe(true);
    const p = parsePeerQr(JSON.stringify(far));
    expect(p.relay).toEqual({ url: 'wss://relay.example/ws', code: '123456' });
    expect(isRemote(p)).toBe(true);
    expect(peerTls(p)).toEqual({ fp, pin: 'feedfacefeedface' });
    expect(peerRelay(p)).toEqual({ url: 'wss://relay.example/ws', code: '123456' });
    const noAddress = parsePeerQr(JSON.stringify({ ...far, host: undefined, port: undefined }));
    expect(noAddress.host).toBe('');
    expect(noAddress.relay?.code).toBe('123456');
    expect(() => parsePeerQr(JSON.stringify({ k: 'kula-peer', v: 2, id: 'x', host: 'h', port: 1, secret: 'ab'.repeat(32), relay: far.relay }))).toThrow('notPeer');
    expect(parsePeerQr(JSON.stringify({ ...far, relay: { url: 'wss://r', code: '12' } })).relay).toBeNull();
    // the qr this phone makes carries its relay only in v3
    const base = { id: 'me', name: 'phone', host: '10.0.0.2', port: 50551, kind: 'phone' as const, ram: 3000, bw: 14, passport: null, relay: { url: 'wss://r.example', code: '654321' } };
    expect(JSON.parse(makePeerQr({ ...base, fp, pin: 'deadbeefdeadbeef' })).relay).toEqual(base.relay);
    expect('relay' in JSON.parse(makePeerQr({ ...base, secret: 'cd'.repeat(32) }))).toBe(false);
  });
  it('takes a relay code typed by hand once the relay is set, learns the certificate later', () => {
    expect(isRelayCode('123456')).toBe(true);
    expect(isRelayCode('123456 0123456789ABCDEF')).toBe(true);
    expect(isRelayCode('12345')).toBe(false);
    expect(() => parseRelayCode('123456', '')).toThrow('noRelay');
    const p = parseRelayCode('123456 0123456789ABCDEF', 'https://relay.example');
    expect(p.relay).toEqual({ url: 'wss://relay.example', code: '123456' });
    expect(p.fp).toBe('');
    expect(p.pin).toBe('0123456789abcdef');
    expect(peerTls(p)).toEqual({ fp: '', pin: '0123456789abcdef' });
    expect(parseRelayCode('123456', 'wss://relay.example').pin).toBeNull();
    saveSettings({ relayUrl: 'wss://from.settings' });
    expect(parseRelayCode('222222').relay?.url).toBe('wss://from.settings');
    rememberPeer(p);
    learnPeer(p, fp);
    const kept = peers().find((x) => x.id === 'relay:123456')!;
    expect(kept.fp).toBe(fp);
    expect(kept.pin).toBeNull();
    expect(kept.paired_at).toBeTruthy();
  });
  it('is left out of a split before any probe, with its own reason, and is probed for apart', async () => {
    const p = parsePeerQr(JSON.stringify(far));
    const near = { id: 'n', name: 'x', host: '10.0.0.9', port: 50551, secret: 'a'.repeat(64), kind: 'phone' as const, ram: 3000, bw: 10, added_at: '' };
    const r = await probeAll([p, near], 'rpc');
    expect(r.ok).toEqual([]);
    expect(r.bad.map((b) => [b.peer.id, b.why])).toEqual([['w-far', REMOTE_NO_SPLIT], ['n', 'nonative']]);
    const a = await probeAll([p], 'api');
    expect(a.bad[0].why).toBe('nonative');
  });
});
