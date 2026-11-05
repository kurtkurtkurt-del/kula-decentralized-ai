// chatLocal against a fake native module (5.11.2026): a generation that ends in an error
// must reject, so the night's loop (LlamaWorker) and the chat screen see it. Before this
// the error was thrown inside the event listener and the promise stayed open for good.
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
jest.mock('@/data/passport', () => ({ lastPassport: () => null }));
jest.mock('expo-device', () => ({ deviceType: 1, DeviceType: { TABLET: 2, DESKTOP: 3 }, osVersion: '15', totalMemory: 8e9 }));

type Listener = (e: unknown) => void;
const listeners: Record<string, Set<Listener>> = { onToken: new Set(), onDone: new Set() };
const emit = (ev: string, e: unknown) => listeners[ev].forEach((fn) => fn(e));
const fakeNative = {
  addListener: (ev: string, fn: Listener) => {
    listeners[ev].add(fn);
    return { remove: () => listeners[ev].delete(fn) };
  },
  generate: () => {
    setTimeout(() => {
      emit('onToken', { id: 7, text: 'hel' });
      emit('onDone', { id: 7, tokens: 1, ms: 3, firstMs: 1, tps: 10, stopped: false, error: nextError });
    }, 1);
    return 7;
  },
  stop: () => {},
};
let nextError: string | null = null;
jest.mock('@/llm/native', () => ({ native: () => fakeNative, hasNative: () => true, llama: fakeNative }));

import { chatLocal } from '@/llm/engine';

describe('chatLocal', () => {
  it('resolves with the stats and streams the tokens', async () => {
    nextError = null;
    const got: string[] = [];
    const r = await chatLocal([{ role: 'user', content: 'hi' }], (t) => got.push(t), { maxTokens: 4, temperature: 0 });
    expect(got).toEqual(['hel']);
    expect(r.tokens).toBe(1);
    expect(listeners.onDone.size).toBe(0);
  });
  it('rejects when the native side reports an error, and lets go of its listeners', async () => {
    nextError = 'decode failed';
    await expect(chatLocal([{ role: 'user', content: 'hi' }], () => {}, { maxTokens: 4, temperature: 0 })).rejects.toThrow('decode failed');
    expect(listeners.onDone.size).toBe(0);
  });
});
