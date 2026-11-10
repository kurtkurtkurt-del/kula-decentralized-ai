// How a photo is answered (10.11.2026, llm/vision.ts): a chat model that sees photos answers
// directly; a text model gets the chosen vision model's description, marked as its; both in
// RAM when they fit, else the chat model steps aside and comes back; no vision model is a
// clear message. The engine and the native module are fakes.
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
let mockPassport: Record<string, unknown> | null = null;
jest.mock('@/data/passport', () => ({ lastPassport: () => mockPassport }));

type Listener = (e: unknown) => void;
const listeners: Record<string, Set<Listener>> = { onToken: new Set(), onDone: new Set(), onDownload: new Set() };
const emit = (ev: string, e: unknown) => listeners[ev].forEach((fn) => fn(e));
let nextId = 100;
const mockNative = {
  described: [] as { model: string; mmproj: string; ctx: number; images: string[]; maxSide: number; ask: string }[],
  answer: 'a red bicycle against a white wall; a sign reads "NO PARKING".',
  addListener: (ev: string, fn: Listener) => {
    listeners[ev].add(fn);
    return { remove: () => listeners[ev].delete(fn) };
  },
  describeImages: (model: string, mmproj: string, ctx: number, messages: { content: string }[], images: string[], maxSide: number) => {
    const id = nextId++;
    mockNative.described.push({ model, mmproj, ctx, images, maxSide, ask: messages[0].content });
    setTimeout(() => {
      emit('onToken', { id, text: mockNative.answer });
      emit('onDone', { id, tokens: 12, ms: 900, firstMs: 400, tps: 13, stopped: false, error: null, images: images.length });
    }, 1);
    return id;
  },
};
jest.mock('@/llm/native', () => ({ native: () => mockNative, llama: mockNative, hasNative: () => true, GATE_PORT: 50551 }));

const mockEngine = {
  state: { model: null as unknown, mode: 'alone', load: null as unknown, devices: [] as unknown[], vision: false },
  calls: [] as string[],
  visionFails: false,
};
jest.mock('@/llm/engine', () => ({
  engine: () => mockEngine.state,
  load: async (m: { id: string }, mode: string, ctx: number) => {
    mockEngine.calls.push(`load ${m.id} ${mode} ${ctx}`);
    mockEngine.state = { ...mockEngine.state, model: m, mode, load: { ctx }, vision: false };
  },
  unload: async () => {
    mockEngine.calls.push('unload');
    mockEngine.state = { ...mockEngine.state, model: null, load: null, vision: false };
  },
  loadVision: async () => {
    mockEngine.calls.push('loadVision');
    if (mockEngine.visionFails) throw new Error('could not load the mmproj');
    mockEngine.state = { ...mockEngine.state, vision: true };
  },
}));

import { CATALOG, isVision } from '@/llm/catalog';
import { explain } from '@/llm/errors';
import { describe as describeModel, rememberModel, saveSettings, type LocalModel } from '@/llm/store';
import { describePhotos, fitsBoth, photoSide, photoTurn, routePhotos, seenNote, withPhotos } from '@/llm/vision';

const local = (id: string): LocalModel => {
  const c = CATALOG.find((m) => m.id === id)!;
  return { ...describeModel(c), path: `/data/models/${c.file}`, added_at: '2026-11-10T00:00:00Z' };
};
const text = local('qwen2.5-1.5b-q4');
const smol = local('smolvlm-500m-q8');
const gemma = local('gemma3-4b');
const passport = (ramGb: number) => ({ budget: { ram_gb: ramGb }, ram_free_gb: ramGb });
const chatWith = (m: LocalModel, ctx = 2048) => {
  mockEngine.state = { model: m, mode: 'alone', load: { ctx }, devices: [{ id: 'me', local: true }], vision: false };
};
const history = [{ role: 'user' as const, content: 'what does the sign say?' }];

beforeEach(() => {
  mockStore.clear();
  mockNative.described = [];
  mockEngine.calls = [];
  mockEngine.visionFails = false;
  mockEngine.state = { model: null, mode: 'alone', load: null, devices: [], vision: false };
  mockPassport = passport(6);
});

describe('routePhotos (pure)', () => {
  it('a chat model that sees photos answers them itself', () => {
    expect(routePhotos(gemma, smol, false)).toEqual({ kind: 'direct' });
  });
  it('a text model: the vision model describes; swap only when both do not fit', () => {
    expect(routePhotos(text, smol, true)).toEqual({ kind: 'describe', by: smol, swap: false });
    expect(routePhotos(text, smol, false)).toEqual({ kind: 'describe', by: smol, swap: true });
    expect(routePhotos(null, smol, false)).toEqual({ kind: 'describe', by: smol, swap: false });
  });
  it('no vision model: none', () => {
    expect(routePhotos(text, null, true)).toEqual({ kind: 'none' });
  });
});

describe('fitsBoth', () => {
  it('reads the passport: both models, the vision one with its mmproj at a small context', () => {
    expect(fitsBoth(passport(6) as never, text, 2048, smol)).toBe(true);
    expect(fitsBoth(passport(2) as never, text, 2048, smol)).toBe(false);
    expect(fitsBoth(passport(6) as never, text, 2048, gemma)).toBe(false); // 2.5 gb + 0.85 gb encoder
    expect(fitsBoth(null, text, 2048, smol)).toBe(false); // not known: make room
  });
  it('photos get smaller when there are more of them', () => {
    expect([1, 2, 3, 4, 6].map(photoSide)).toEqual([768, 512, 512, 384, 384]);
  });
});

describe('photoTurn', () => {
  it('vision model loaded as the chat model: direct, its mmproj loaded, the photos go with the request', async () => {
    rememberModel(gemma);
    chatWith(gemma);
    const t = await photoTurn(history, ['file:///c/1.jpg']);
    expect(t.route).toBe('direct');
    expect(t.images).toEqual({ uris: ['file:///c/1.jpg'], maxSide: 768 });
    expect(t.messages).toEqual(history);
    expect(t.seen).toBeUndefined();
    expect(mockEngine.calls).toEqual(['loadVision']);
    expect(mockNative.described).toEqual([]);
  });
  it('text model + chosen vision model that fit together: described next to it, the note marked as the vision model\'s', async () => {
    rememberModel(text);
    rememberModel(smol);
    chatWith(text);
    const t = await photoTurn(history, ['file:///c/1.jpg']);
    expect(t.route).toBe('describe');
    expect(mockEngine.calls).toEqual([]); // nothing unloaded
    expect(mockNative.described).toHaveLength(1);
    expect(mockNative.described[0]).toMatchObject({ model: smol.path, mmproj: `/data/models/${smol.mmproj!.file}`, images: ['file:///c/1.jpg'], maxSide: 768 });
    expect(mockNative.described[0].ask).toContain('what does the sign say?');
    expect(t.seen).toEqual({ text: mockNative.answer, by: 'SmolVLM 500M', n: 1 });
    const last = t.messages[t.messages.length - 1].content;
    expect(last).toContain('what does the sign say?');
    expect(last).toContain('SmolVLM 500M, a vision model on this phone');
    expect(last).toContain('NO PARKING');
    expect(t.images).toBeUndefined();
  });
  it('the setting picks the vision model', async () => {
    rememberModel(text);
    rememberModel(smol);
    rememberModel(gemma);
    saveSettings({ visionModelId: gemma.id });
    mockPassport = passport(16);
    chatWith(text);
    const t = await photoTurn(history, ['file:///c/1.jpg']);
    expect(t.seen!.by).toBe('Gemma 3 4B');
    expect(mockNative.described[0].model).toBe(gemma.path);
  });
  it('both do not fit: the chat model steps aside, the vision model reads, the chat model comes back as it was', async () => {
    rememberModel(text);
    rememberModel(smol);
    mockPassport = passport(2);
    chatWith(text, 4096);
    const seen = await describePhotos(['file:///c/1.jpg', 'file:///c/2.jpg']);
    expect(mockEngine.calls).toEqual(['unload', `load ${text.id} alone 4096`]);
    expect(mockNative.described).toHaveLength(2); // one photo at a time
    expect(seen.text).toMatch(/^photo 1: .*\nphoto 2: /);
    expect(seen.n).toBe(2);
  });
  it('the chat model\'s own encoder does not load: the chosen vision model reads it instead', async () => {
    rememberModel(gemma);
    rememberModel(smol);
    chatWith(gemma);
    mockEngine.visionFails = true;
    const t = await photoTurn(history, ['file:///c/1.jpg']);
    expect(t.route).toBe('describe');
    expect(t.seen!.by).toBe('SmolVLM 500M');
  });
  it('no vision model on the phone: a clear message', async () => {
    rememberModel(text);
    chatWith(text);
    await expect(photoTurn(history, ['file:///c/1.jpg'])).rejects.toThrow('novision');
    let said = '';
    await photoTurn(history, ['file:///c/1.jpg']).catch((e) => (said = explain(e)));
    expect(said).toMatch(/download a vision model/);
    expect(mockNative.described).toEqual([]);
  });
});

describe('the conversation as text', () => {
  it('a read photo is the vision model\'s note; an unread one is named as unseen', () => {
    expect(withPhotos('hi', 0)).toBe('hi');
    expect(withPhotos('look', 1, { text: 'a cat', by: 'SmolVLM 500M', n: 1 })).toBe(`look\n\n${seenNote({ text: 'a cat', by: 'SmolVLM 500M', n: 1 })}`);
    expect(withPhotos('look', 2)).toContain('2 photos with this message; you cannot see them');
  });
  it('isVision marks exactly the catalog entries with an mmproj', () => {
    expect(isVision(smol)).toBe(true);
    expect(isVision(text)).toBe(false);
  });
});
