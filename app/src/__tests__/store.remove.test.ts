// Removing a download (6.11.2026): the user paused a download, pressed ×, and the row stayed.
// The native cancel keeps the .part (for resume) and the models tab reconciles on every change
// of the list, which read the .part back in as "interrupted". Now × removes the row at once,
// deletes the half file, and a reconcile in between cannot bring it back.
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

type File = { name: string; path: string; size: number; partial: boolean };
type Listener = (e: unknown) => void;
const mockDisk = {
  files: [] as File[],
  deleted: [] as string[],
  cancelled: [] as string[],
  cancelFails: false,
  onDownload: new Set<Listener>(),
  // reconcile runs while the cancel is still on its way, as the models tab's effect does
  duringCancel: null as null | (() => Promise<void>),
  info: async () => ({ available: true, abi: 'arm64-v8a', fastCores: 4, ramFreeMb: 3000, modelsDir: '/data/models', freeDiskMb: 9000, workerId: 'me', wifiIp: null }),
  listModels: async () => mockDisk.files,
  deleteFile: async (p: string) => {
    mockDisk.deleted.push(p);
    mockDisk.files = mockDisk.files.filter((f) => `/data/models/${f.name}` !== p);
    return true;
  },
  download: async () => {},
  cancelDownload: async (id: string) => {
    mockDisk.cancelled.push(id);
    if (mockDisk.duringCancel) await mockDisk.duringCancel();
    if (mockDisk.cancelFails) throw new Error('no such download');
  },
  addListener: (_ev: string, fn: Listener) => {
    mockDisk.onDownload.add(fn);
    return { remove: () => mockDisk.onDownload.delete(fn) };
  },
};
jest.mock('@/llm/native', () => ({ get llama() { return mockDisk; }, native: () => mockDisk, hasNative: () => true, GATE_PORT: 50551 }));

import { CATALOG } from '@/llm/catalog';
import { cancelDownload, describe as describeModel, downloadOf, initStore, pauseDownload, reconcileModels, startDownload, type ModelDraft } from '@/llm/store';

const cat = CATALOG[0];
const emit = (e: unknown) => mockDisk.onDownload.forEach((fn) => fn(e));
const half = (name: string, size = 4096): File => ({ name: `${name}.part`, path: `/data/models/${name}.part`, size, partial: true });

beforeEach(async () => {
  mockStore.clear();
  mockDisk.files = [];
  mockDisk.deleted = [];
  mockDisk.cancelled = [];
  mockDisk.cancelFails = false;
  mockDisk.duringCancel = null;
  await initStore();
});

describe('removing a download', () => {
  it('a paused download goes away, its .part is deleted, and a reconcile does not bring it back', async () => {
    await startDownload(describeModel(cat));
    await pauseDownload(cat.id);
    emit({ id: cat.id, got: 4096, total: cat.size, state: 'cancelled', error: null });
    expect(downloadOf(cat.id)?.state).toBe('paused');
    mockDisk.files = [half(cat.file)];
    // the native side says "nothing running" for a paused one: the row must still go
    mockDisk.cancelFails = true;
    mockDisk.duringCancel = async () => { await reconcileModels(); };
    const gone = cancelDownload(cat.id);
    expect(downloadOf(cat.id)).toBeNull(); // at once, before the native side answers
    await gone;
    expect(downloadOf(cat.id)).toBeNull();
    expect(mockDisk.deleted).toContain(`/data/models/${cat.file}.part`);
    await reconcileModels();
    expect(downloadOf(cat.id)).toBeNull();
  });

  it('an interrupted one (found by reconcile after a kill) can be removed too', async () => {
    mockDisk.files = [half(cat.file)];
    await reconcileModels();
    expect(downloadOf(cat.id)?.error).toBe('interrupted');
    await cancelDownload(cat.id);
    expect(downloadOf(cat.id)).toBeNull();
    await reconcileModels();
    expect(downloadOf(cat.id)).toBeNull();
    expect(mockDisk.files).toEqual([]);
  });

  it('a split model deletes every part it fetched and the one in flight', async () => {
    const split: ModelDraft = { ...describeModel(cat), id: 'hf:a/b', file: 'b-00001-of-00002.gguf', size: 20, parts: [{ file: 'b-00001-of-00002.gguf', size: 10, sha256: null }, { file: 'b-00002-of-00002.gguf', size: 10, sha256: null }], source: 'hf', url: 'https://huggingface.co/a/resolve/main/b-00001-of-00002.gguf' };
    await startDownload(split);
    emit({ id: 'hf:a/b#0', got: 10, total: 10, state: 'done', error: null });
    expect(downloadOf('hf:a/b')?.part).toBe(1);
    await cancelDownload('hf:a/b');
    expect(mockDisk.cancelled).toEqual(['hf:a/b#1']);
    expect(mockDisk.deleted).toEqual(expect.arrayContaining(['/data/models/b-00001-of-00002.gguf', '/data/models/b-00002-of-00002.gguf.part']));
    expect(downloadOf('hf:a/b')).toBeNull();
  });

  it('a late event from the cancelled thread does not revive the row', async () => {
    await startDownload(describeModel(cat));
    await cancelDownload(cat.id);
    emit({ id: cat.id, got: 9, total: cat.size, state: 'running', error: null });
    emit({ id: cat.id, got: 9, total: cat.size, state: 'cancelled', error: null });
    expect(downloadOf(cat.id)).toBeNull();
  });
});
