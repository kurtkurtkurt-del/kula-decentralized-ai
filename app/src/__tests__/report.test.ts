// The morning report's sums and the pile that survives a stop (night-2).
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockStore = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItemSync: (k: string) => mockStore.get(k) ?? null,
    setItemSync: (k: string, v: string) => mockStore.set(k, v),
    removeItemSync: (k: string) => mockStore.delete(k),
  },
}));

import { accuracy, buildReport, compare, lastReport, markSent, REPORT_KEEP, reports, saveReport, segmentOf, type Segment } from '@/night/report';
import { ResumableJobs, readQueue } from '@/night/queue';
import { storedResults, type Unit } from '@/night/jobs';

const H = 3600_000;
const seg = (p: Partial<Segment> = {}): Segment => ({ startedAt: 0, endedAt: H, tokens: 36000, kwh: 0.004, units: 300, checked: 40, wrong: 4, devices: [{ id: 'me', name: 'this phone', tokens: 24000, units: 200 }, { id: 'p1', name: 'tablet', tokens: 12000, units: 100 }], model: 'tiny', real: true, ...p });

beforeEach(() => mockStore.clear());

describe('the report', () => {
  it('adds the segments up: time without the pauses, tokens, units, checks, per device', () => {
    const r = buildReport('2026-11-05', 'beyin', [seg(), seg({ startedAt: 2 * H, endedAt: 3 * H, checked: 0, wrong: 0, devices: [{ id: 'me', name: 'this phone', tokens: 36000, units: 300 }] })]);
    expect(r).toMatchObject({ id: '2026-11-05', slug: 'beyin', startedAt: 0, endedAt: 3 * H, seconds: 7200, segments: 2, tokens: 72000, units: 600, checked: 40, wrong: 4, tps: 10, kwh: 0.008, model: 'tiny', real: true, sent: false });
    expect(r.devices).toEqual([
      { id: 'me', name: 'this phone', tokens: 60000, units: 500, tps: 8.3 },
      { id: 'p1', name: 'tablet', tokens: 12000, units: 100, tps: 1.7 },
    ]);
    expect(accuracy(r)).toBeCloseTo(0.9);
    expect(accuracy({ checked: 0, wrong: 0 })).toBeNull();
  });
  it('counts the energy as hours × measured watts, or 3 W when nothing was measured', () => {
    expect(buildReport('k', 's', [seg()])).toMatchObject({ wh: 3, watts: 3, measured: false });
    expect(buildReport('k', 's', [seg()], 4.5)).toMatchObject({ wh: 4.5, watts: 4.5, measured: true });
    expect(buildReport('k', 's', [seg()], 0)).toMatchObject({ wh: 3, measured: false });
    expect(buildReport('k', 's', [seg({ endedAt: 0.5 * H }), seg({ startedAt: 2 * H, endedAt: 2.5 * H })], 2)).toMatchObject({ wh: 2, seconds: 3600 });
  });
  it('is empty but whole with no segment', () => {
    expect(buildReport('k', 's', [])).toMatchObject({ seconds: 0, tokens: 0, units: 0, tps: 0, wh: 0, devices: [], model: null, real: false });
  });
  it('turns a worker status into a segment', () => {
    const s = segmentOf({ state: 'done', slug: 'beyin', startedAt: 100, tokens: 50, seconds: 10, kwh: 0.001, tps: 5, real: true, units: 4, checked: 1, wrong: 0, model: 'tiny', devices: [] }, 10_100);
    expect(s).toEqual({ startedAt: 100, endedAt: 10_100, tokens: 50, kwh: 0.001, units: 4, checked: 1, wrong: 0, devices: [], model: 'tiny', real: true });
    expect(segmentOf({ state: 'done', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0 }, 5)).toMatchObject({ startedAt: 5, units: 0, real: false, model: null });
  });
  it('compares a night with the nights before it', () => {
    const a = buildReport('2026-11-03', 's', [seg({ units: 100, tokens: 18000 })]);
    const b = buildReport('2026-11-04', 's', [seg({ units: 200, tokens: 36000 })]);
    const c = buildReport('2026-11-05', 's', [seg({ units: 300, tokens: 54000 }), seg({ startedAt: H, endedAt: 2 * H, units: 0, tokens: 0 })]);
    expect(compare(a, [])).toBeNull();
    expect(compare(c, [a, b, c])).toEqual({ nights: 2, units: 150, tps: 0, wh: 3, seconds: 3600, best: true }); // 7.5 tok/s against 5 and 10
    expect(compare(a, [b])).toMatchObject({ units: -100, best: false });
  });
  it('keeps the reports on the phone, one per night, the newest last, no more than the cap', () => {
    for (let i = 1; i <= REPORT_KEEP + 5; i++) saveReport(buildReport(`2026-01-${String(i).padStart(2, '0')}`, 's', [seg()]));
    expect(reports()).toHaveLength(REPORT_KEEP);
    expect(lastReport()!.id).toBe(`2026-01-${REPORT_KEEP + 5}`);
    saveReport({ ...lastReport()!, units: 1 });
    expect(reports()).toHaveLength(REPORT_KEEP);
    expect(lastReport()!.units).toBe(1);
    markSent(lastReport()!.id);
    expect(lastReport()!.sent).toBe(true);
  });
});

const unit = (i: number): Unit => ({ id: `u${i}`, type: 'classify', prompt: `u${i}`, maxTokens: 4 });
const units = Array.from({ length: 5 }, (_, i) => unit(i + 1));
const result = { text: 'x', device: 'me', tokens: 1, ms: 1 };

describe('the pile on the phone', () => {
  it('hands out the units in order and writes every move to the store', async () => {
    const q = new ResumableJobs('n1', units);
    expect(q.left()).toBe(5);
    const a = (await q.next())!;
    const b = (await q.next())!;
    expect([a.id, b.id]).toEqual(['u1', 'u2']);
    expect(readQueue()).toEqual({ key: 'n1', left: ['u3', 'u4', 'u5'], taken: ['u1', 'u2'], done: 0 });
    await q.done(a, result);
    expect(readQueue()).toMatchObject({ taken: ['u2'], done: 1 });
    expect(storedResults()).toHaveLength(1);
    await q.retry(b);
    expect(readQueue()).toMatchObject({ left: ['u2', 'u3', 'u4', 'u5'], taken: [] });
  });
  it('continues the same night where it stopped, with what was in flight first', async () => {
    const q = new ResumableJobs('n1', units);
    await q.done((await q.next())!, result); // u1 done
    await q.next(); // u2 in flight when the plug comes out
    await q.next(); // u3 too
    const again = new ResumableJobs('n1', units);
    expect(again.left()).toBe(4);
    expect(readQueue()).toMatchObject({ key: 'n1', left: ['u2', 'u3', 'u4', 'u5'], taken: [], done: 1 });
    expect((await again.next())!.id).toBe('u2');
  });
  it('starts over for another night, and forgets ids that are no longer in the list', async () => {
    const q = new ResumableJobs('n1', units);
    await q.next();
    const other = new ResumableJobs('n2', units);
    expect(other.left()).toBe(5);
    expect(readQueue()!.key).toBe('n2');
    mockStore.set('night.queue', JSON.stringify({ key: 'n3', left: ['u1', 'gone'], taken: ['u9'], done: 3 }));
    const third = new ResumableJobs('n3', units);
    expect(third.left()).toBe(1);
    expect((await third.next())!.id).toBe('u1');
    expect(await third.next()).toBeNull();
  });
});
