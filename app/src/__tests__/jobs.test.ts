// The job sources' edges (5.11.2026): ServerJobs is not yet and says so, the demo pile
// keeps the newest 500 results, clearResults empties them, and a corrupt store reads as empty.
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

import { DEMO_UNITS, DemoJobs, SYSTEM, ServerJobs, clearResults, storedResults, type Unit } from '@/night/jobs';

const unit = (i: number): Unit => ({ id: `u${i}`, type: 'summarise', prompt: `u${i}`, maxTokens: 40 });
beforeEach(() => mockStore.clear());

describe('ServerJobs', () => {
  it('is not yet, in both directions', async () => {
    const s = new ServerJobs('c-1');
    expect(s.contributionId).toBe('c-1');
    await expect(s.next()).rejects.toThrow('notyet');
    await expect(s.done()).rejects.toThrow('notyet');
    expect((s as { retry?: unknown }).retry).toBeUndefined();
  });
});

describe('DemoJobs', () => {
  it('counts what is left, puts a retried unit at the front, and ends with null for good', async () => {
    const d = new DemoJobs([unit(1), unit(2)]);
    expect(d.left()).toBe(2);
    const a = (await d.next())!;
    await d.retry(a);
    expect(d.left()).toBe(2);
    expect((await d.next())!.id).toBe('u1');
    expect((await d.next())!.id).toBe('u2');
    expect(await d.next()).toBeNull();
    expect(await d.next()).toBeNull();
    expect(d.left()).toBe(0);
  });
  it('keeps the newest 500 results, with the unit’s kind and a timestamp', async () => {
    const d = new DemoJobs([]);
    for (let i = 0; i < 503; i++) await d.done(unit(i), { text: 't', device: 'me', tokens: 1, ms: 2 });
    const all = storedResults();
    expect(all).toHaveLength(500);
    expect(all[0].id).toBe('u3');
    expect(all[499]).toMatchObject({ id: 'u502', type: 'summarise', text: 't', device: 'me', tokens: 1, ms: 2 });
    expect(Date.parse(all[499].at)).toBeGreaterThan(0);
    clearResults();
    expect(storedResults()).toEqual([]);
  });
  it('reads a corrupt store as empty and writes over it', async () => {
    mockStore.set('night.results', '{not json');
    expect(storedResults()).toEqual([]);
    await new DemoJobs([]).done(unit(1), { text: 't', device: 'me', tokens: 1, ms: 2 });
    expect(storedResults()).toHaveLength(1);
  });
  it('has a system line per kind and uses the whole bundled list by default', async () => {
    expect(Object.keys(SYSTEM).sort()).toEqual(['classify', 'summarise', 'translate']);
    expect(new DemoJobs().left()).toBe(DEMO_UNITS.length);
  });
});
