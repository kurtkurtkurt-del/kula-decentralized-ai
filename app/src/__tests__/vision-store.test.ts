// Vision models in the store (10.11.2026): the catalog's vision entries, the download of both
// files (model, then mmproj, each with its own sha256), the record, reconcile and delete, and
// the "vision model" setting.
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
type Call = { id: string; url: string; name: string; sha256: string | null; size: number };
const mockDisk = {
  files: [] as File[],
  deleted: [] as string[],
  calls: [] as Call[],
  onDownload: new Set<Listener>(),
  info: async () => ({ available: true, abi: 'arm64-v8a', fastCores: 4, ramFreeMb: 3000, modelsDir: '/data/models', freeDiskMb: 9000, workerId: 'me', wifiIp: null }),
  listModels: async () => mockDisk.files,
  deleteFile: async (p: string) => { mockDisk.deleted.push(p); return true; },
  download: async (id: string, url: string, name: string, sha256: string | null, size: number) => { mockDisk.calls.push({ id, url, name, sha256, size }); },
  cancelDownload: async () => {},
  addListener: (_ev: string, fn: Listener) => {
    mockDisk.onDownload.add(fn);
    return { remove: () => mockDisk.onDownload.delete(fn) };
  },
};
jest.mock('@/llm/native', () => ({ get llama() { return mockDisk; }, native: () => mockDisk, hasNative: () => true, GATE_PORT: 50551 }));
jest.mock('@/data/passport', () => ({ lastPassport: () => null }));

import { CATALOG, isVision } from '@/llm/catalog';
import { bytesOf, describe as describeModel, downloadOf, filesOf, forgetModel, initStore, localModels, mmprojPath, partsOf, reconcileModels, rememberModel, saveSettings, settings, startDownload, type LocalModel } from '@/llm/store';
import { chosenVision, visionModels } from '@/llm/vision';
import { bestModel } from '@/tasks/models';

const emit = (e: unknown) => mockDisk.onDownload.forEach((fn) => fn(e));
const vision = CATALOG.filter(isVision);
const small = vision.find((m) => m.id === 'smolvlm-500m-q8')!;
const mid = vision.find((m) => m.id === 'smolvlm2-2.2b-q4')!;
const local = (c: (typeof CATALOG)[number]): LocalModel => ({ ...describeModel(c), path: `/data/models/${c.file}`, added_at: '2026-11-10T00:00:00Z' });

beforeEach(async () => {
  mockStore.clear();
  mockDisk.files = [];
  mockDisk.deleted = [];
  mockDisk.calls = [];
  await initStore();
});

describe('the catalog\'s vision models', () => {
  it('has three, each with an mmproj from its own repo: a real sha256, a size, a gguf', () => {
    expect(vision.map((m) => m.id)).toEqual(['smolvlm-500m-q8', 'smolvlm2-2.2b-q4', 'gemma3-4b']);
    for (const m of vision) {
      expect(m.mmproj!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.mmproj!.sha256).not.toBe(m.sha256);
      expect(m.mmproj!.size).toBeGreaterThan(50e6);
      expect(m.mmproj!.file).toMatch(/^mmproj-.*\.gguf$/);
    }
    // the text models carry none
    expect(CATALOG.filter((m) => !isVision(m)).every((m) => m.mmproj === undefined)).toBe(true);
  });
  it('keeps size and sha256 the model file\'s; the files and the bytes count the mmproj too', () => {
    const d = describeModel(mid);
    expect(d.size).toBe(1112602656);
    expect(partsOf(d)).toEqual([{ file: mid.file, size: mid.size, sha256: mid.sha256 }]);
    expect(filesOf(d).map((f) => f.file)).toEqual([mid.file, mid.mmproj!.file]);
    expect(bytesOf(d)).toBe(1112602656 + 592523200);
    expect(mmprojPath({ path: `/data/models/${mid.file}`, mmproj: d.mmproj })).toBe(`/data/models/${mid.mmproj!.file}`);
    expect(mmprojPath({ path: '/data/models/x.gguf', mmproj: null })).toBeNull();
  });
});

describe('downloading a vision model', () => {
  it('fetches the model, then the mmproj from the same repo, each checked by its own sha256; one record at the end', async () => {
    await startDownload(describeModel(small));
    expect(mockDisk.calls).toHaveLength(1);
    expect(mockDisk.calls[0]).toMatchObject({ id: `${small.id}#0`, name: small.file, sha256: small.sha256, size: small.size });
    expect(downloadOf(small.id)!.total).toBe(small.size + small.mmproj!.size);
    emit({ id: `${small.id}#0`, got: small.size, total: small.size, state: 'done', error: null });
    await Promise.resolve();
    expect(mockDisk.calls).toHaveLength(2);
    expect(mockDisk.calls[1]).toMatchObject({ id: `${small.id}#1`, name: small.mmproj!.file, sha256: small.mmproj!.sha256, size: small.mmproj!.size });
    expect(mockDisk.calls[1].url).toBe(`https://huggingface.co/${small.repo}/resolve/main/${small.mmproj!.file}`);
    expect(localModels()).toEqual([]); // not before the mmproj passed too
    emit({ id: `${small.id}#1`, got: small.mmproj!.size, total: small.mmproj!.size, state: 'done', error: null });
    expect(localModels().map((m) => m.id)).toEqual([small.id]);
    expect(localModels()[0].mmproj).toEqual(small.mmproj);
    expect(downloadOf(small.id)).toBeNull();
  });
  it('a model without its mmproj on disk is not kept; a half mmproj resumes as the second file', async () => {
    rememberModel(local(small));
    mockDisk.files = [{ name: small.file, path: '', size: small.size, partial: false }, { name: `${small.mmproj!.file}.part`, path: '', size: 1000, partial: true }];
    await reconcileModels();
    expect(localModels()).toEqual([]);
    expect(downloadOf(small.id)).toMatchObject({ part: 1, parts: 2, got: small.size + 1000, error: 'interrupted' });
  });
  it('deleting it deletes both files', async () => {
    rememberModel(local(small));
    await forgetModel(small.id);
    expect(mockDisk.deleted).toEqual([`/data/models/${small.file}`, `/data/models/${small.mmproj!.file}`]);
  });
});

describe('the vision model setting', () => {
  it('none on the phone: none chosen', () => {
    rememberModel(local(CATALOG[0]));
    expect(visionModels()).toEqual([]);
    expect(chosenVision()).toBeNull();
  });
  it('unset: the smallest vision model on the phone; set: that one, kept in the settings', () => {
    rememberModel(local(mid));
    rememberModel(local(small));
    rememberModel(local(CATALOG[0]));
    expect(visionModels().map((m) => m.id)).toEqual([small.id, mid.id]);
    expect(settings().visionModelId).toBeNull();
    expect(chosenVision()!.id).toBe(small.id);
    saveSettings({ visionModelId: mid.id });
    expect(JSON.parse(mockStore.get('llm.settings')!).visionModelId).toBe(mid.id);
    expect(chosenVision()!.id).toBe(mid.id);
  });
  it('a chosen model that is gone, or that cannot see, falls back to the smallest; deleting it clears the setting', async () => {
    rememberModel(local(small));
    rememberModel(local(mid));
    saveSettings({ visionModelId: CATALOG[0].id });
    expect(chosenVision()!.id).toBe(small.id);
    saveSettings({ visionModelId: mid.id });
    await forgetModel(mid.id);
    expect(settings().visionModelId).toBeNull();
    expect(chosenVision()!.id).toBe(small.id);
  });
});

describe('automatic picks', () => {
  it('a project or a night picks a text model over a vision model; a vision model only when it is all there is', () => {
    rememberModel(local(CATALOG.find((m) => m.id === 'gemma3-4b')!));
    rememberModel(local(CATALOG[0]));
    expect(bestModel()!.id).toBe(CATALOG[0].id);
    mockStore.clear();
    rememberModel(local(small));
    expect(bestModel()!.id).toBe(small.id);
  });
});
