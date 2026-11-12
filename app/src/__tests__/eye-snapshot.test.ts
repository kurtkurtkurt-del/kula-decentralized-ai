// god's eye on the phone (11.11.2026): the phone's look (src/eye/snapshot.ts), the twin of
// kula-node's godseye-feed. Plain data in the eye's own shape, the guard's way in, no secret of a
// device in it, and the phone's own words for alone, apart and split.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';

// cluster.ts (splitSummary) reaches the store and the native module when required
const mockKv = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: { getItemSync: (k: string) => mockKv.get(k) ?? null, setItemSync: (k: string, v: string) => { mockKv.set(k, v); }, removeItemSync: (k: string) => mockKv.delete(k), getAllKeysSync: () => [...mockKv.keys()] },
}));
jest.mock('@/llm/native', () => ({ llama: null, native: () => null, hasNative: () => false, GATE_PORT: 50551 }));

import { clean } from '@godseye/branches/guard';
import { splitSummary } from '@/llm/cluster';
import { needMb, phoneSnapshot, projectOf, type PhoneInput } from '@/eye/snapshot';
import type { EngineState } from '@/llm/engine';
import type { LocalModel, Peer } from '@/llm/store';
import { freshNote, OLD_WORKER } from '@/llm/trust';
import type { Task } from '@/tasks/types';
import { CATALOG } from '@/llm/catalog';

const AT = new Date(2026, 10, 11, 23, 30).getTime();
const peer = (o: Partial<Peer> = {}): Peer => ({ id: 'p1', name: 'Pixel', host: '192.168.1.40', port: 50551, secret: 'deadbeef'.repeat(4), fp: 'ab'.repeat(32), pin: null, kind: 'phone', ram: 3500, bw: 40, added_at: '2026-11-01T00:00:00Z', ...o });
const model = (o: Partial<LocalModel> = {}): LocalModel => ({ id: 'qwen', name: 'Qwen 3 0.6B', file: 'qwen.gguf', path: '/m/qwen.gguf', size: 500 * 1024 * 1024, sha256: null, params_b: 0.6, quant: 'Q4_K_M', kv_mb_per_1k: 112, ctx_max: 32768, license: null, source: 'hf', url: 'u', added_at: 'x', ...o });
const idle: PhoneInput['engine'] = { model: null, mode: 'alone', loading: null, plan: null, split: [], devices: [], generating: false, load: null };
const input = (o: Partial<PhoneInput> = {}): PhoneInput => ({
  at: AT, name: 'pixel 8', freeMb: 4200, ledger: { ok: true, count: 12, problem: null }, power: { battery: 71, charging: true, hot: false },
  engine: idle, since: { loaded: null, loading: null }, peers: [], reach: {}, trust: {}, models: [], catalog: [], tasks: [], decisions: [], llama: true, ...o,
});

describe('the phone\'s look', () => {
  it('is the eye\'s shape: this phone the host, its memory, ledger, battery and heat', () => {
    const s = phoneSnapshot(input());
    expect(s.at).toBe(AT);
    expect(s.host).toEqual({ name: 'pixel 8', freeMb: 4200, ledger: { ok: true, count: 12, problem: null }, power: { battery: 71, charging: true, hot: false } });
    expect(s.work).toEqual({ loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true });
    // the guard takes it as it is
    expect(clean(structuredClone(s))).toEqual(s);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('a paired device: how it is reached, pinned, its memory; no secret, no pin and no fingerprint in the look', () => {
    const s = phoneSnapshot(input({ peers: [peer(), peer({ id: 'p2', name: 'Far', relay: { url: 'wss://r', code: 'ABCD-1234' }, fp: null, pin: '123456' })] }));
    expect(s.devices[0]).toMatchObject({ id: 'p1', name: 'Pixel', kind: 'phone', via: 'wifi', where: '192.168.1.40:50551', tls: true, waitingPair: false, ramMb: 3500, bwGBs: 40, reachable: null, trust: null });
    expect(s.devices[1]).toMatchObject({ via: 'relay', where: 'a relay', tls: false, waitingPair: true });
    expect(JSON.stringify(s)).not.toMatch(/deadbeef|abab|ABCD-1234|123456/);
  });

  it('reach: the freshest word wins, from the security report, a card\'s probe or the engine', () => {
    const answered = { ...freshNote(), at: AT - 60_000, answered: true };
    const failed = { ...freshNote(), at: AT - 30_000, answered: false, error: 'no answer in time' };
    expect(phoneSnapshot(input({ peers: [peer()], trust: { p1: answered } })).devices[0]).toMatchObject({ reachable: true, checkedAt: AT - 60_000 });
    expect(phoneSnapshot(input({ peers: [peer()], trust: { p1: failed } })).devices[0]).toMatchObject({ reachable: false, reason: 'no answer in time' });
    expect(phoneSnapshot(input({ peers: [peer()], trust: { p1: { ...failed, error: OLD_WORKER } } })).devices[0].reachable).toBe(true);
    const probed = input({ peers: [peer()], trust: { p1: failed }, reach: { p1: { ok: true, at: AT - 1000, why: null } } });
    expect(phoneSnapshot(probed).devices[0]).toMatchObject({ reachable: true, checkedAt: AT - 1000 });
  });

  it('alone is "here", apart names every device and what it holds, split carries the parts', () => {
    const m = model();
    const alone = phoneSnapshot(input({ engine: { ...idle, model: m, mode: 'alone', load: { ctx: 4096 } as EngineState['load'], devices: [{ id: 'me', name: 'pixel 8', local: true, busy: true, tps: 12.5, busyUntil: 0, done: 1, heardAt: AT - 1000 }], generating: true }, since: { loaded: AT - 5000, loading: null } }));
    expect(alone.work.loaded).toMatchObject({ mode: 'here', model: { id: 'qwen', file: 'qwen.gguf' }, ctx: 4096, since: AT - 5000, devices: [{ id: 'me', local: true, busy: true, tps: 12.5 }] });
    expect(alone.work.chatting).toBe(1);

    const p = peer();
    const apart = phoneSnapshot(input({ peers: [p, peer({ id: 'p3', name: 'Idle' })], engine: { ...idle, model: m, mode: 'apart', devices: [{ id: 'me', name: 'pixel 8', local: true, busy: false, tps: 10, busyUntil: 0, done: 0, heardAt: AT - 9000 }, { id: 'p1', name: 'Pixel', local: false, busy: false, tps: 7, busyUntil: 0, peer: p, out: true, done: 0, heardAt: AT - 2000 }] } }));
    expect(apart.work.loaded?.mode).toBe('apart');
    expect(apart.devices.map((d) => d.holds)).toEqual(['qwen.gguf', null]);
    expect(apart.devices[0]).toMatchObject({ reachable: false, reason: 'it dropped a request and sits out' });

    const split = phoneSnapshot(input({ peers: [p], engine: { ...idle, model: m, mode: 'split', split: [{ name: 'pixel 8', gb: 0.3 }, { name: 'Pixel', gb: 0.2 }], plan: { mode: 'split', used: [{ ...p, assignedMb: 200 }], skipped: [{ peer: peer({ id: 'p9', name: 'Gone' }), why: 'no answer' }], localMb: 300, fitsAlone: true, totalMb: 500, needMb: 500, aloneFaster: true } } }));
    expect(split.work.loaded?.parts).toEqual([{ id: 'pixel 8', name: 'pixel 8', local: true, mb: 307, layers: 0 }, { id: 'p1', name: 'Pixel', local: false, mb: 205, layers: 0 }]);
    expect(split.devices[0].holds).toBe('qwen.gguf');
    expect(split.work.plan).toEqual(['1 other device(s) hold a share: Pixel', 'this phone alone would be faster by the estimate', 'Gone was left out: no answer']);

    const loading = phoneSnapshot(input({ engine: { ...idle, model: m, mode: 'split', loading: 'probing' }, since: { loaded: null, loading: AT - 2000 } }));
    expect(loading.work.loaded).toBeNull();
    expect(loading.work.loading).toEqual({ mode: 'split', model: 'Qwen 3 0.6B', since: AT - 2000, line: 'probing' });
  });

  // P6 (A12 + B7): what the engine measured, and when it last heard a device, not the look's own time
  it('a device\'s speed is the measured one with how many answers it came from; no answer yet, no speed', () => {
    const m = model();
    const p = peer();
    const loaded = (devices: EngineState['devices']) => phoneSnapshot(input({ peers: [p], engine: { ...idle, model: m, mode: 'apart', devices } })).work.loaded!;
    const three = loaded([{ id: 'me', name: 'pixel 8', local: true, busy: false, tps: 9, busyUntil: 0, done: 0, heardAt: AT - 90_000 }, { id: 'p1', name: 'Pixel', local: false, busy: false, tps: 14.2, busyUntil: 0, peer: p, done: 3, heardAt: AT - 5_000 }]);
    expect(three.devices[1]).toMatchObject({ id: 'p1', tps: 14.2, done: 3 });
    // an estimate (or a bench) before the first answer is not a measurement: the eye gets null
    expect(three.devices[0]).toMatchObject({ id: 'me', tps: null, done: 0 });
  });

  it('checkedAt is when the engine last heard the device, not the time of the look', () => {
    const p = peer();
    const devices: EngineState['devices'] = [{ id: 'me', name: 'pixel 8', local: true, busy: false, tps: 9, busyUntil: 0, done: 0, heardAt: AT - 90_000 }, { id: 'p1', name: 'Pixel', local: false, busy: false, tps: 14.2, busyUntil: 0, peer: p, done: 3, heardAt: AT - 5_000 }];
    const s = phoneSnapshot(input({ peers: [p], engine: { ...idle, model: model(), mode: 'apart', devices } }));
    expect(s.devices[0]).toMatchObject({ reachable: true, checkedAt: AT - 5_000 });
    // a later look with nothing new heard keeps the same checkedAt: not a new probe
    expect(phoneSnapshot(input({ at: AT + 30_000, peers: [p], engine: { ...idle, model: model(), mode: 'apart', devices } })).devices[0].checkedAt).toBe(AT - 5_000);
    // the engine's word is older than a card's probe: the probe wins
    const probed = phoneSnapshot(input({ peers: [p], reach: { p1: { ok: false, at: AT - 1_000, why: 'no answer' } }, engine: { ...idle, model: model(), mode: 'apart', devices } }));
    expect(probed.devices[0]).toMatchObject({ reachable: false, checkedAt: AT - 1_000 });
  });

  it('models: the catalog with what is here, a model only here, each with kula-node\'s need', () => {
    const c = CATALOG[0];
    const s = phoneSnapshot(input({ catalog: [c], models: [model({ id: c.id, file: c.file }), model()] }));
    expect(s.models).toHaveLength(2);
    expect(s.models[0]).toMatchObject({ id: c.id, catalog: true, here: true, needMb: needMb(c.size + (c.mmproj?.size ?? 0), c.kv_mb_per_1k) });
    expect(s.models[1]).toMatchObject({ id: 'qwen', catalog: false, here: true });
    expect(needMb(1024 * 1024 * 1000, 100)).toBe(Math.round(1000 * 1.05 + 400 + 300));
  });

  it('projects: the person\'s own, with tonight\'s window across midnight, running only inside it', () => {
    const t = { id: 't1', title: 'my notes', prompt: 'sum up', from: '22:00', to: '06:00', active: true, finished: false, run: { id: 'r', key: 'k', startedAt: AT, steps: [] }, modelId: 'qwen' } as unknown as Task;
    const p = projectOf(t, AT);
    expect(p).toMatchObject({ id: 't1', state: 'running', mode: 'here', model: 'qwen', request: 'sum up', done: 0 });
    expect(new Date(p.start).getHours()).toBe(22);
    expect(p.end - p.start).toBe(8 * 3_600_000);
    const morning = new Date(2026, 10, 12, 3, 0).getTime();
    expect(projectOf(t, morning).start).toBe(p.start);   // still the same night
    expect(projectOf(t, new Date(2026, 10, 12, 12, 0).getTime()).state).toBe('paused');
    expect(projectOf({ ...t, active: false }, AT).state).toBe('off');
    expect(projectOf({ ...t, run: null }, AT).state).toBe('waiting');
  });

  // P13 (D1): every branch looks a split's parts up by device id, so the phone keys them by id
  it('split: each peer\'s part carries its device id, this phone\'s part is "local", same names stay apart', () => {
    const a = peer({ id: 'w-7f3a', name: 'Pixel' });
    const b = peer({ id: 'w-91c0', name: 'Pixel', host: '192.168.1.41' });
    const c = peer({ id: 'w-c2d4', name: 'pixel 8', host: '192.168.1.42' }); // named like this phone
    const names = new Map([
      ['127.0.0.1:4001', { id: a.id, name: a.name }],
      ['127.0.0.1:4002', { id: b.id, name: b.name }],
      ['127.0.0.1:4003', { id: c.id, name: c.name }],
    ]);
    const split = splitSummary([
      { buffer: 'CPU', mb: 400 }, { buffer: 'RPC0[127.0.0.1:4001]', mb: 300 },
      { buffer: 'RPC1[127.0.0.1:4002]', mb: 200 }, { buffer: 'RPC2[127.0.0.1:4003]', mb: 100 },
    ], names, 'pixel 8');
    expect(split).toEqual([
      { id: 'local', name: 'pixel 8', gb: 0.4, local: true },
      { id: 'w-7f3a', name: 'Pixel', gb: 0.3, local: false },
      { id: 'w-91c0', name: 'Pixel', gb: 0.2, local: false },
      { id: 'w-c2d4', name: 'pixel 8', gb: 0.1, local: false },
    ]);
    const used = [a, b, c].map((p, i) => ({ ...p, assignedMb: 300 - i * 100 }));
    const s = phoneSnapshot(input({ peers: [a, b, c], engine: { ...idle, model: model(), mode: 'split', split, plan: { mode: 'split', used, skipped: [], localMb: 400, fitsAlone: true, totalMb: 1000, needMb: 1000 } } }));
    const parts = s.work.loaded!.parts!;
    const ids = s.devices.map((d) => d.id);
    for (const p of parts.filter((x) => !x.local)) expect(ids).toContain(p.id);
    expect(parts.filter((x) => x.local)).toEqual([{ id: 'local', name: 'pixel 8', local: true, mb: 410, layers: 0 }]);
    expect(parts.filter((x) => x.name === 'Pixel').map((x) => x.id)).toEqual(['w-7f3a', 'w-91c0']);
    // no peer took a share: this phone's part is still 'local'
    expect(splitSummary([{ buffer: 'CPU', mb: 512 }], new Map<string, { id: string; name: string }>(), 'pixel 8', true)).toEqual([{ id: 'local', name: 'pixel 8', gb: 0.5, local: true }]);
  });

  // P13 (D5): a mixture of experts reads only its active share per token; the speeds depend on it
  it('models: a catalog mixture of experts keeps active_b, a vision model says so', () => {
    const moe = CATALOG.find((c) => c.active_b)!;
    const eyes = CATALOG.find((c) => c.mmproj)!;
    const s = phoneSnapshot(input({ catalog: [moe, eyes, CATALOG.find((c) => !c.active_b && !c.mmproj)!] }));
    expect(s.models[0]).toMatchObject({ id: moe.id, active_b: moe.active_b });
    expect(s.models[1]).toMatchObject({ id: eyes.id, vision: true });
    expect(s.models[2]).toMatchObject({ active_b: null, vision: false });
  });

  // P13 (D6): since is when the engine loaded the model, so a reload between two looks is seen
  it('since follows the engine\'s load time, also for a reload of the same model in the same mode', () => {
    const m = model();
    const at = (loadedAt: number) => phoneSnapshot(input({ at: 5_000_000, engine: { ...idle, model: m, mode: 'alone', load: { ctx: 4096 } as EngineState['load'], loadedAt }, since: { loaded: 1_000_000, loading: null } })).work.loaded!.since;
    expect(at(1_000_000)).toBe(1_000_000);
    expect(at(4_600_000)).toBe(4_600_000);
    // no stamp (an older state): the first look that saw it, as before
    expect(phoneSnapshot(input({ engine: { ...idle, model: m, mode: 'alone' }, since: { loaded: AT - 5000, loading: null } })).work.loaded!.since).toBe(AT - 5000);
  });

  // P23 (scan D M3): this phone's free disk, an observation only (NativeInfo.freeDiskMb)
  it('host: this phone\'s free disk when the look has it; absent stays absent, nonsense is unknown', () => {
    const s = phoneSnapshot(input({ diskFreeMb: 18_250 }));
    expect(s.host.diskFreeMb).toBe(18_250);
    expect(clean(structuredClone(s))).toEqual(s);
    expect('diskFreeMb' in phoneSnapshot(input()).host).toBe(false);
    expect(phoneSnapshot(input({ diskFreeMb: null })).host.diskFreeMb).toBeNull();
    for (const bad of [NaN, Infinity, -5]) expect(phoneSnapshot(input({ diskFreeMb: bad })).host.diskFreeMb).toBeNull();
  });

  // P23: the phone's trust notes keep no ledger lines (llm/trust.ts TrustNote), so a peer's health
  // is not read here; absent (not looked), never null (looked, no reading)
  it('a paired device carries no health on the phone: its notes keep no ledger lines', () => {
    const note = { ...freshNote(), at: AT - 60_000, answered: true, verified: 40, head: 'ab'.repeat(32) };
    const d = phoneSnapshot(input({ peers: [peer()], trust: { p1: note } })).devices[0];
    expect('health' in d).toBe(false);
  });
});
