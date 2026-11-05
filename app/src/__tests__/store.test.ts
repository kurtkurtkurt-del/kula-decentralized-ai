// The model store with a mockNative native module: a split download runs part by part and is
// one record at the end, reconcile keeps a split model only when every part is there,
// deleting unloads first, "delete unused" spares the chosen and the running one, and the
// search history keeps five.
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

type DlEvent = { id: string; got: number; total: number; state: string; error: string | null };
const disk: { name: string; size: number; partial: boolean }[] = [];
const started: { id: string; url: string; name: string; sha256: string | null; size: number }[] = [];
const deleted: string[] = [];
let onDownload: ((e: DlEvent) => void) | null = null;
const mockNative = {
  info: async () => ({ available: true, abi: 'arm64-v8a', fastCores: 4, ramFreeMb: 3000, modelsDir: '/data/models', freeDiskMb: 20000, workerId: 'w', wifiIp: null }),
  listModels: async () => disk.map((f) => ({ ...f, path: `/data/models/${f.name}` })),
  download: async (id: string, url: string, name: string, sha256: string | null, size: number) => { started.push({ id, url, name, sha256, size }); },
  cancelDownload: async () => {},
  deleteFile: async (p: string) => { deleted.push(p); return true; },
  ggufMeta: async () => ({ arch: 'qwen3', layers: '36', heads: '32', heads_kv: '8', key_len: '128', value_len: '128', ctx: '40960' }),
  addListener: (_e: string, fn: (e: DlEvent) => void) => { onDownload = fn; return { remove() {} }; },
};
// getters: the mock is hoisted above the const, so the module must be read when used, not when mocked
jest.mock('@/llm/native', () => ({ get llama() { return mockNative; }, hasNative: () => true, native: () => mockNative, GATE_PORT: 50551 }));

import { CATALOG } from '@/llm/catalog';
import { downloadOf, forgetModel, forgetUnused, hfHistory, initStore, localModels, partsOf, readMeta, reconcileModels, registerEngine, rememberModel, rememberQuery, saveSettings, settings, startDownload, unusedModels, usedBytes, type Download, type LocalModel, type ModelDraft } from '@/llm/store';

const sha = (c: string) => c.repeat(64);
const split: ModelDraft = {
  id: 'hf:o/r/big-Q8_0-00001-of-00002.gguf', name: 'big Q8_0', file: 'big-Q8_0-00001-of-00002.gguf', size: 300, sha256: sha('a'),
  parts: [{ file: 'big-Q8_0-00001-of-00002.gguf', size: 200, sha256: sha('a') }, { file: 'big-Q8_0-00002-of-00002.gguf', size: 100, sha256: sha('b') }],
  params_b: 8, quant: 'Q8_0', kv_mb_per_1k: 256, ctx_max: 8192, license: 'mit', source: 'hf', url: 'https://huggingface.co/o/r/resolve/main/big-Q8_0-00001-of-00002.gguf',
};
const single = (id: string, size = 10): LocalModel => ({ id, name: id, file: `${id}.gguf`, path: `/data/models/${id}.gguf`, size, sha256: null, params_b: 1, quant: 'Q4_K_M', kv_mb_per_1k: 32, ctx_max: 4096, license: null, source: 'hf', url: 'u', added_at: '' });
const fire = (e: Partial<DlEvent> & { id: string; state: string }) => onDownload?.({ got: 0, total: 0, error: null, ...e });

beforeEach(() => {
  mockStore.clear();
  disk.length = 0;
  started.length = 0;
  deleted.length = 0;
});

describe('a split download', () => {
  it('fetches the parts one after another under "<id>#<n>", each with its own sha256, and keeps one record', async () => {
    await initStore();
    await startDownload(split);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ id: `${split.id}#0`, name: 'big-Q8_0-00001-of-00002.gguf', sha256: sha('a'), size: 200 });
    fire({ id: `${split.id}#0`, got: 150, total: 200, state: 'running' });
    expect(localModels()).toHaveLength(0);
    fire({ id: `${split.id}#0`, got: 200, total: 200, state: 'done' });
    await Promise.resolve();
    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({ id: `${split.id}#1`, name: 'big-Q8_0-00002-of-00002.gguf', sha256: sha('b'), size: 100, url: 'https://huggingface.co/o/r/resolve/main/big-Q8_0-00002-of-00002.gguf' });
    expect(localModels()).toHaveLength(0);
    fire({ id: `${split.id}#1`, got: 100, total: 100, state: 'done' });
    const m = localModels()[0];
    expect(localModels()).toHaveLength(1);
    expect(m.path).toBe('/data/models/big-Q8_0-00001-of-00002.gguf'); // llama.cpp finds the rest
    expect(m.size).toBe(300);
    expect(partsOf(m)).toHaveLength(2);
  });
  it('a single file keeps its plain id and one part', async () => {
    await initStore();
    const { parts: _p, ...one } = { ...split, id: 'hf:o/r/one.gguf', file: 'one.gguf', size: 50, parts: undefined };
    await startDownload(one as ModelDraft);
    expect(started[0].id).toBe('hf:o/r/one.gguf');
    expect(partsOf(one)).toEqual([{ file: 'one.gguf', size: 50, sha256: sha('a') }]);
    fire({ id: 'hf:o/r/one.gguf', got: 50, total: 50, state: 'done' });
    expect(localModels()[0].id).toBe('hf:o/r/one.gguf');
  });
});

describe('reconcile', () => {
  it('keeps a split model only while every part is on disk', async () => {
    rememberModel({ ...split, path: '/data/models/big-Q8_0-00001-of-00002.gguf', added_at: '' });
    rememberModel(single('a'));
    disk.push({ name: 'big-Q8_0-00001-of-00002.gguf', size: 200, partial: false }, { name: 'big-Q8_0-00002-of-00002.gguf', size: 100, partial: false }, { name: 'a.gguf', size: 10, partial: false });
    await reconcileModels();
    expect(localModels().map((m) => m.id).sort()).toEqual(['a', split.id].sort());
    disk.splice(1, 1); // the second part goes
    await reconcileModels();
    expect(localModels().map((m) => m.id)).toEqual(['a']);
    disk.length = 0;
    await reconcileModels();
    expect(localModels()).toEqual([]);
  });
  it('shows a catalog download the app was killed in as interrupted', async () => {
    disk.push({ name: `${CATALOG[0].file}.part`, size: 5, partial: true });
    await reconcileModels();
    const d = downloadOf(CATALOG[0].id) as Download | null;
    expect(d).toMatchObject({ state: 'error', error: 'interrupted', got: 5, part: 0, parts: 1 });
  });
});

describe('deleting', () => {
  it('unloads a running model first and removes every part', async () => {
    const order: string[] = [];
    registerEngine({ beforeForget: async (id) => { order.push(`unload ${id}`); }, runningId: () => null });
    rememberModel({ ...split, path: '/data/models/big-Q8_0-00001-of-00002.gguf', added_at: '' });
    saveSettings({ modelId: split.id });
    await forgetModel(split.id);
    expect(order).toEqual([`unload ${split.id}`]);
    expect(deleted).toEqual(['/data/models/big-Q8_0-00001-of-00002.gguf', '/data/models/big-Q8_0-00002-of-00002.gguf']);
    expect(localModels()).toEqual([]);
    expect(settings().modelId).toBeNull();
  });
  it('"delete unused" spares the chosen and the running one and says what went', async () => {
    registerEngine({ beforeForget: async () => {}, runningId: () => 'run' });
    rememberModel(single('run', 100));
    rememberModel(single('chosen', 200));
    rememberModel(single('old1', 300));
    rememberModel(single('old2', 400));
    saveSettings({ modelId: 'chosen' });
    expect(usedBytes()).toBe(1000);
    expect(unusedModels().map((m) => m.id).sort()).toEqual(['old1', 'old2']);
    expect(await forgetUnused()).toEqual({ n: 2, bytes: 700 });
    expect(localModels().map((m) => m.id).sort()).toEqual(['chosen', 'run']);
    expect(deleted.sort()).toEqual(['/data/models/old1.gguf', '/data/models/old2.gguf']);
  });
});

describe('the header on the record', () => {
  it('overwrites the guessed kv and ctx once, then leaves the record alone', async () => {
    rememberModel(single('q'));
    const m = await readMeta('q');
    expect(m).toMatchObject({ layers: 36, kv_mb_per_1k: 144, ctx_max: 40960, arch: 'qwen3', meta_read: true });
    mockNative.ggufMeta = async () => { throw new Error('should not be read twice'); };
    expect(await readMeta('q')).toMatchObject({ kv_mb_per_1k: 144 });
  });
});

describe('search history', () => {
  it('keeps the last five, newest first, once each, lower-cased', () => {
    for (const q of ['Qwen3', 'llama', 'gemma', 'phi', 'smol', 'mistral']) rememberQuery(q);
    expect(hfHistory()).toEqual(['mistral', 'smol', 'phi', 'gemma', 'llama']);
    rememberQuery('gemma ');
    expect(hfHistory()).toEqual(['gemma', 'mistral', 'smol', 'phi', 'llama']);
    rememberQuery('   ');
    expect(hfHistory()).toHaveLength(5);
  });
});
