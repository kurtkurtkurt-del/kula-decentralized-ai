// The model store against a fake file list (5.11.2026): reconcile after a reinstall or a
// manual delete, a download the app was killed in (its .part), and the download events.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';

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

type File = { name: string; path: string; size: number; partial: boolean };
type Listener = (e: unknown) => void;
const mockDisk = {
  files: [] as File[],
  deleted: [] as string[],
  started: [] as string[],
  cancelled: [] as string[],
  onDownload: new Set<Listener>(),
  info: async () => ({ available: true, abi: 'arm64-v8a', fastCores: 4, ramFreeMb: 3000, modelsDir: '/data/models', freeDiskMb: 9000, workerId: 'me', wifiIp: null }),
  listModels: async () => mockDisk.files,
  deleteFile: async (p: string) => { mockDisk.deleted.push(p); return true; },
  download: async (id: string) => { mockDisk.started.push(id); },
  cancelDownload: async (id: string) => { mockDisk.cancelled.push(id); },
  addListener: (_ev: string, fn: Listener) => {
    mockDisk.onDownload.add(fn);
    return { remove: () => mockDisk.onDownload.delete(fn) };
  },
};
jest.mock('@/llm/native', () => ({ get llama() { return mockDisk; }, native: () => mockDisk, hasNative: () => true, GATE_PORT: 50551 }));

import { CATALOG } from '@/llm/catalog';
import { cancelDownload, describe as describeModel, downloadOf, forgetModel, initStore, localById, localModels, reconcileModels, rememberModel, retryDownload, saveSettings, saveShare, settings, startDownload, useDownloads, useLocalModels, usePeers, useSettings, useShare, type LocalModel } from '@/llm/store';

const cat = CATALOG[0];
const local = (over: Partial<LocalModel> = {}): LocalModel => ({ ...describeModel(cat), path: `/data/models/${cat.file}`, added_at: '2026-11-05T00:00:00Z', ...over });
const emit = (e: unknown) => mockDisk.onDownload.forEach((fn) => fn(e));

beforeEach(async () => {
  mockStore.clear();
  mockDisk.files = [];
  mockDisk.deleted = [];
  mockDisk.started = [];
  mockDisk.cancelled = [];
  // the module keeps its downloads map between tests: drain it (subscribed by initStore)
  await initStore();
  for (const d of [cat, CATALOG[1]]) emit({ id: d.id, got: 0, total: 0, state: 'cancelled', error: null });
});

describe('reconcile', () => {
  it('drops a model whose file is gone and keeps the one still there', async () => {
    rememberModel(local());
    rememberModel(local({ id: 'gone', file: 'gone.gguf', path: '/data/models/gone.gguf' }));
    mockDisk.files = [{ name: cat.file, path: `/data/models/${cat.file}`, size: cat.size, partial: false }];
    await reconcileModels();
    expect(localModels().map((m) => m.id)).toEqual([cat.id]);
  });
  it('does not count a half file as the model', async () => {
    rememberModel(local());
    mockDisk.files = [{ name: `${cat.file}.part`, path: '', size: 1000, partial: true }];
    await reconcileModels();
    expect(localModels()).toEqual([]);
  });
  it('shows a half catalog file as an interrupted download, so retry can continue it', async () => {
    mockDisk.files = [{ name: `${cat.file}.part`, path: '', size: 12345, partial: true }];
    await reconcileModels();
    const d = downloadOf(cat.id);
    expect(d).toMatchObject({ id: cat.id, got: 12345, total: cat.size, state: 'error', error: 'interrupted' });
    expect(d!.model.url).toContain('huggingface.co');
    // a second reconcile does not reset what is known about it
    await reconcileModels();
    expect(downloadOf(cat.id)!.got).toBe(12345);
  });
  it('ignores a half file nobody in the catalog knows', async () => {
    mockDisk.files = [{ name: 'mystery.gguf.part', path: '', size: 5, partial: true }];
    await reconcileModels();
    expect(downloadOf('mystery')).toBeNull();
  });
  it('survives a file list that cannot be read', async () => {
    rememberModel(local());
    const list = mockDisk.listModels;
    mockDisk.listModels = async () => { throw new Error('io'); };
    await reconcileModels();
    mockDisk.listModels = list;
    expect(localModels()).toEqual([]); // no files seen: nothing kept, as after a reinstall
  });
});

describe('downloads', () => {
  it('runs from start to done and then remembers the model under the models dir', async () => {
    await initStore();
    await startDownload(describeModel(cat));
    expect(mockDisk.started).toEqual([cat.id]);
    expect(downloadOf(cat.id)!.state).toBe('running');
    emit({ id: cat.id, got: 10, total: cat.size, state: 'running', error: null });
    expect(downloadOf(cat.id)!.got).toBe(10);
    emit({ id: cat.id, got: cat.size, total: cat.size, state: 'done', error: null });
    expect(downloadOf(cat.id)).toBeNull();
    expect(localById(cat.id)).toMatchObject({ path: `/data/models/${cat.file}`, source: 'catalog' });
  });
  it('keeps an error with its text; retry starts the same model again', async () => {
    await startDownload(describeModel(cat));
    emit({ id: cat.id, got: 5, total: 0, state: 'error', error: 'no space' });
    expect(downloadOf(cat.id)).toMatchObject({ state: 'error', error: 'no space', total: cat.size });
    await retryDownload(cat.id);
    expect(mockDisk.started).toEqual([cat.id, cat.id]);
    expect(downloadOf(cat.id)!.state).toBe('running');
  });
  it('retry of something unknown starts a catalog model, and nothing for a stranger', async () => {
    await retryDownload(CATALOG[1].id);
    expect(mockDisk.started).toEqual([CATALOG[1].id]);
    await retryDownload('nope');
    expect(mockDisk.started).toEqual([CATALOG[1].id]);
  });
  it('cancel tells the native side and forgets the entry', async () => {
    await startDownload(describeModel(cat));
    await cancelDownload(cat.id);
    expect(mockDisk.cancelled).toEqual([cat.id]);
    expect(downloadOf(cat.id)).toBeNull();
    emit({ id: cat.id, got: 0, total: 0, state: 'error', error: 'late' }); // an event after the cancel is ignored
    expect(downloadOf(cat.id)).toBeNull();
  });
});

describe('forgetModel', () => {
  it('deletes the file, drops the entry and clears the choice when it was chosen', async () => {
    rememberModel(local());
    saveSettings({ modelId: cat.id });
    await forgetModel(cat.id);
    expect(mockDisk.deleted).toEqual([`/data/models/${cat.file}`]);
    expect(localModels()).toEqual([]);
    expect(settings().modelId).toBeNull();
  });
  it('leaves another choice alone and does nothing for an unknown id', async () => {
    rememberModel(local());
    saveSettings({ modelId: 'other' });
    await forgetModel('nope');
    expect(mockDisk.deleted).toEqual([]);
    expect(localModels()).toHaveLength(1);
    expect(settings().modelId).toBe('other');
  });
});

describe('the hooks', () => {
  // a screen that reads every store hook; each render is noted outside the component
  const seen: unknown[][] = [];
  const note = (row: unknown[]) => { seen.push(row); };
  function Screen({ onRender }: { onRender: (row: unknown[]) => void }) {
    onRender([useLocalModels().length, useDownloads().length, useSettings().ctx, usePeers().length, useShare()?.name ?? null]);
    return null;
  }
  it('re-render on every write and let go on unmount', async () => {
    seen.length = 0;
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(createElement(Screen, { onRender: note })); });
    expect(seen.at(-1)).toEqual([0, 0, 2048, 0, null]);
    await act(async () => { rememberModel(local()); });
    expect(seen.at(-1)).toEqual([1, 0, 2048, 0, null]);
    await act(async () => { saveSettings({ ctx: 1024 }); saveShare({ secret: 'x', name: 'mine', port: 1 }); });
    expect(seen.at(-1)).toEqual([1, 0, 1024, 0, 'mine']);
    await act(async () => { await startDownload(describeModel(CATALOG[1])); });
    expect(seen.at(-1)).toEqual([1, 1, 1024, 0, 'mine']);
    const n = seen.length;
    await act(async () => { r.unmount(); });
    await act(async () => { rememberModel(local({ id: 'later' })); });
    expect(seen.length).toBe(n);
  });
});
