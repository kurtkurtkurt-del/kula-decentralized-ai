// The offline layer: reads fall back to the shelf, writes wait in order.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

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

let mockNet: ((s: { isConnected: boolean; isInternetReachable: boolean | null }) => void) | null = null;
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: (fn: typeof mockNet) => (mockNet = fn) },
}));

const mockRpc = jest.fn<(...a: unknown[]) => Promise<{ error: unknown }>>();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { onAuthStateChange: jest.fn() },
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: () => ({ delete: () => ({ eq: async () => ({ error: null }) }), update: () => ({ eq: async () => ({ error: null }) }) }),
  },
}));

import { cachedRead, flushShelves, invalidate, isNetworkError, newId, OfflineError, onShelf, pendingJobs, send, startOffline } from '@/lib/offline';

const netDown = () => Object.assign(new Error('Network request failed'), {});
const flushAll = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  startOffline();
});
beforeEach(() => {
  mockRpc.mockReset();
  mockNet?.({ isConnected: true, isInternetReachable: true });
});

describe('isNetworkError', () => {
  it('tells a lost connection from a refusal', () => {
    expect(isNetworkError(new Error('Network request failed'))).toBe(true);
    expect(isNetworkError({ name: 'AuthRetryableFetchError' })).toBe(true);
    expect(isNetworkError(new Error('permission denied for function'))).toBe(false);
  });
});

describe('cachedRead', () => {
  it('stores a good answer and shows it again when the network fails', async () => {
    const first = await cachedRead('deck', 'munchen', async () => [1, 2, 3]);
    expect(first).toEqual({ value: [1, 2, 3], stale: false });
    const again = await cachedRead('deck', 'munchen', async () => {
      throw netDown();
    });
    expect(again).toEqual({ value: [1, 2, 3], stale: true });
  });

  it('says offline when nothing was ever stored', async () => {
    mockNet?.({ isConnected: true, isInternetReachable: true });
    await expect(
      cachedRead('deck', 'never', async () => {
        throw netDown();
      }),
    ).rejects.toBeInstanceOf(OfflineError);
  });

  it('passes a refusal from the server through', async () => {
    await expect(
      cachedRead('deck', 'refused', async () => {
        throw new Error('permission denied');
      }),
    ).rejects.toThrow('permission denied');
  });

  it('drops the oldest entry from a full shelf', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    await cachedRead('small', 'a', async () => 'a', 2);
    now.mockReturnValue(2000);
    await cachedRead('small', 'b', async () => 'b', 2);
    now.mockReturnValue(3000);
    await cachedRead('small', 'c', async () => 'c', 2);
    now.mockRestore();
    flushShelves();
    const shelf = JSON.parse(mockStore.get('cache.out.small') ?? '{}');
    expect(Object.keys(shelf).sort()).toEqual(['b', 'c']);
  });
});

describe('saved copy first', () => {
  it('returns the saved copy at once and refreshes it in the background', async () => {
    await cachedRead('swr', 'k', async () => 'old');
    let told = 0;
    const off = onShelf('swr', () => told++);
    let release: (v: string) => void = () => {};
    const slow = new Promise<string>((r) => (release = r));
    const second = await cachedRead('swr', 'k', () => slow);
    expect(second).toEqual({ value: 'old', stale: true });
    release('new');
    await flushAll();
    expect(told).toBe(1);
    expect((await cachedRead('swr', 'k', () => slow)).value).toBe('new');
    off();
  });

  it('a background answer equal to the saved one tells nobody', async () => {
    await cachedRead('same', 'k', async () => [1]);
    let told = 0;
    const off = onShelf('same', () => told++);
    await cachedRead('same', 'k', async () => [1]);
    await flushAll();
    expect(told).toBe(0);
    off();
  });

  it('waits for the server after invalidate()', async () => {
    await cachedRead('inv', 'k', async () => 'before');
    invalidate('inv');
    expect((await cachedRead('inv', 'k', async () => 'after')).value).toBe('after');
  });

  it('within ttl it does not ask the server at all', async () => {
    await cachedRead('ttl', 'k', async () => 'a');
    const work = jest.fn(async () => 'b');
    await cachedRead('ttl', 'k', work, 1, { ttl: 60_000 });
    expect(work).not.toHaveBeenCalled();
  });
});

describe('send', () => {
  it('goes straight out when online', async () => {
    mockRpc.mockResolvedValue({ error: null });
    await send({ kind: 'swipe', slug: 'x', direction: 'right' });
    expect(mockRpc).toHaveBeenCalledWith('join_set', { p_slug: 'x', p_direction: 'right' });
    expect(mockStore.get('outbox')).toBeUndefined();
  });

  it('queues while offline and sends in order when the connection returns', async () => {
    mockNet?.({ isConnected: false, isInternetReachable: false });
    await send({ kind: 'swipe', slug: 'a', direction: 'right' });
    await send({ kind: 'swipe', slug: 'b', direction: 'left' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(JSON.parse(mockStore.get('outbox') ?? '[]')).toHaveLength(2);

    mockRpc.mockResolvedValue({ error: null });
    mockNet?.({ isConnected: true, isInternetReachable: true });
    await flushAll();
    await flushAll();
    expect(mockRpc.mock.calls.map((c) => (c[1] as { p_slug: string }).p_slug)).toEqual(['a', 'b']);
    expect(mockStore.get('outbox')).toBeUndefined();
  });

  it('drops an operation the server refuses and goes on with the rest', async () => {
    mockNet?.({ isConnected: false, isInternetReachable: false });
    await send({ kind: 'swipe', slug: 'gone', direction: 'right' });
    await send({ kind: 'swipe', slug: 'next', direction: 'right' });
    mockRpc.mockResolvedValueOnce({ error: { message: 'no such night' } }).mockResolvedValue({ error: null });
    mockNet?.({ isConnected: true, isInternetReachable: true });
    await flushAll();
    await flushAll();
    expect(mockRpc.mock.calls.map((c) => (c[1] as { p_slug: string }).p_slug)).toEqual(['gone', 'next']);
    expect(mockStore.get('outbox')).toBeUndefined();
  });

  it('shows waiting jobs and gives each its own id and time', async () => {
    mockNet?.({ isConnected: false, isInternetReachable: false });
    const { queued, job } = await send({ kind: 'swipe', slug: 'w', direction: 'right' });
    expect(queued).toBe(true);
    expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(pendingJobs('swipe').map((j) => j.slug)).toEqual(['w']);
    mockRpc.mockResolvedValue({ error: null });
    mockNet?.({ isConnected: true, isInternetReachable: true });
    await flushAll();
    await flushAll();
    expect(pendingJobs()).toEqual([]);
  });

  it('reads jobs saved by the older outbox (no id, no time)', async () => {
    mockNet?.({ isConnected: false, isInternetReachable: false });
    mockStore.set('outbox', JSON.stringify([{ kind: 'swipe', slug: 'old', direction: 'left', uid: 'out' }]));
    expect(pendingJobs()[0].id).toBeTruthy();
    mockRpc.mockResolvedValue({ error: null });
    mockNet?.({ isConnected: true, isInternetReachable: true });
    await flushAll();
    await flushAll();
    expect(mockRpc).toHaveBeenCalledWith('join_set', { p_slug: 'old', p_direction: 'left' });
  });

  it('makes distinct ids', () => {
    expect(new Set([...Array(200)].map(newId)).size).toBe(200);
  });

  it('a refusal while online is thrown, not queued', async () => {
    mockRpc.mockResolvedValue({ error: { message: 'no such night' } });
    await expect(send({ kind: 'swipe', slug: 'x', direction: 'right' })).rejects.toEqual({ message: 'no such night' });
    expect(mockStore.get('outbox')).toBeUndefined();
  });
});