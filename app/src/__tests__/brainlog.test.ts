// The brain tab's decisions log (llm/brainlog.ts): the pure parts (append, tally, counts,
// what a plan says) and the log on the phone (note, noteUnit, clear, kept across a reload).
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

import { append, brainLog, clearBrainLog, countOf, KEEP, latest, note, noteUnit, planEntries, tally, whyKey, type BrainEntry } from '@/llm/brainlog';
import type { Plan } from '@/llm/cluster';
import type { Peer } from '@/llm/store';
import { dict } from '@/i18n/dict';
import { redirectSystemPath } from '@/app/+native-intent';
import { lcg, starsFor } from '@/components/NightNetwork';

const e = (at: number, p: Partial<BrainEntry> = {}): BrainEntry => ({ at, kind: 'plan', key: 'brain.plan.alone', vars: { model: 'm' }, tone: 'info', ...p });
const peer = (id: string, name: string): Peer => ({ id, name, host: `10.0.0.${id}`, port: 50052, secret: 's', kind: 'phone', ram: 4096, bw: 10, added_at: '2026-11-05T00:00:00Z' });
const keys = dict as Record<string, { en: string }>;

beforeEach(() => {
  mockStore.clear();
  clearBrainLog();
});

describe('the decisions log, pure', () => {
  it('appends at the end and drops the oldest past keep', () => {
    let list: BrainEntry[] = [];
    for (let i = 0; i < 7; i++) list = append(list, e(i), 5);
    expect(list.map((x) => x.at)).toEqual([2, 3, 4, 5, 6]);
    expect(append([e(1)], [e(2), e(3)]).map((x) => x.at)).toEqual([1, 2, 3]);
  });
  it('shows the newest first', () => {
    expect(latest([e(1), e(2), e(3)], 2).map((x) => x.at)).toEqual([3, 2]);
  });
  it('counts warnings, failures and kinds', () => {
    const c = countOf([e(1), e(2, { tone: 'warn', kind: 'skip' }), e(3, { tone: 'bad', kind: 'error' }), e(4, { tone: 'warn', kind: 'skip' })]);
    expect(c).toEqual({ total: 4, warn: 2, bad: 1, byKind: { plan: 1, skip: 2, error: 1 } });
  });
  it('folds a night’s units into one running line per device', () => {
    let list: BrainEntry[] = [e(0, { kind: 'night', key: 'brain.night.start' })];
    list = tally(list, 1, 'phone', { n: 1, tokens: 10, right: 1 });
    list = tally(list, 2, 'tablet', { n: 1, tokens: 5, right: 0 });
    list = tally(list, 3, 'phone', { n: 1, tokens: 12, right: 0 });
    expect(list).toHaveLength(3);
    expect(list[1]).toMatchObject({ at: 3, kind: 'unit', vars: { device: 'phone', n: 2, tokens: 22, right: 1 } });
    expect(list[2]).toMatchObject({ vars: { device: 'tablet', n: 1, tokens: 5 } });
    // something else in between starts a new line for the same device
    list = append(list, e(4, { kind: 'out', key: 'brain.out', tone: 'warn' }));
    list = tally(list, 5, 'phone', { n: 1, tokens: 1, right: 0 });
    expect(list).toHaveLength(5);
    expect(list[4]).toMatchObject({ vars: { device: 'phone', n: 1, tokens: 1 } });
  });
  it('names the probe’s reasons it knows, keeps the rest as they came', () => {
    expect(whyKey('remote')).toEqual({ key: 'brain.why.remote' });
    expect(whyKey('nonative')).toEqual({ key: 'brain.why.nonative' });
    expect(whyKey('connect timed out')).toEqual({ key: 'brain.why.timeout' });
    expect(whyKey('ECONNREFUSED')).toEqual({ key: 'brain.why.unreachable' });
    expect(whyKey('bad secret')).toEqual({ key: 'brain.why.auth' });
    expect(whyKey('odd')).toEqual({ raw: 'odd' });
  });
});

describe('what a plan says', () => {
  const split: Plan = {
    mode: 'split', localMb: 2048, fitsAlone: false, totalMb: 6144, needMb: 5120,
    used: [{ ...peer('1', 'Pixel'), assignedMb: 1536 }],
    skipped: [{ peer: peer('2', 'Far Tab'), why: 'remote' }, { peer: peer('3', 'Odd'), why: 'weird answer' }],
    aloneFaster: true,
    est: { perTokenMs: 400, tps: 2.5, loadS: 30, hops: 1, netMsPerToken: 100 },
    estAlone: { perTokenMs: 200, tps: 5, loadS: 10, hops: 0, netMsPerToken: 0 },
  };
  it('alone: one line', () => {
    expect(planEntries(1, 'qwen', 'alone', null)).toEqual([{ at: 1, kind: 'plan', key: 'brain.plan.alone', vars: { model: 'qwen' }, tone: 'info' }]);
  });
  it('split: who holds how much, alone would be faster, who was left out and why', () => {
    const out = planEntries(1, 'qwen', 'split', split, [], 'My Phone');
    expect(out[0]).toMatchObject({ key: 'brain.plan.split', vars: { model: 'qwen', n: 2, need: 5, total: 6 }, detail: '2 gb · my phone  ·  1.5 gb · pixel' });
    expect(out[1]).toMatchObject({ key: 'brain.plan.aloneFaster', detail: '2.5 vs 5 tok/s', tone: 'warn' });
    expect(out[2]).toMatchObject({ kind: 'skip', key: 'brain.why.remote', vars: { name: 'far tab' } });
    expect(out[3]).toMatchObject({ kind: 'skip', key: 'brain.why.other', vars: { name: 'odd', why: 'weird answer' } });
  });
  it('split worth it: the expectation instead of the warning', () => {
    const out = planEntries(1, 'qwen', 'split', { ...split, aloneFaster: false, skipped: [] });
    expect(out.map((x) => x.key)).toEqual(['brain.plan.split', 'brain.plan.expect']);
    expect(out[1].vars).toEqual({ tps: 2.5, load: 30, hops: 1 });
  });
  it('apart: every device with its expected speed', () => {
    const plan: Plan = { mode: 'apart', used: [], skipped: [], localMb: 0, fitsAlone: true, totalMb: 0, needMb: 0 };
    const out = planEntries(1, 'qwen', 'apart', plan, [{ name: 'Me', tps: 6.04 }, { name: 'Tab', tps: 3 }]);
    expect(out).toEqual([{ at: 1, kind: 'plan', key: 'brain.plan.apart', vars: { model: 'qwen', n: 2 }, detail: 'me ~6 tok/s  ·  tab ~3 tok/s', tone: 'info' }]);
  });
  it('every key a plan can say is in the dictionary', () => {
    const said = [...planEntries(1, 'q', 'split', split), ...planEntries(1, 'q', 'split', { ...split, aloneFaster: false, fitsAlone: true, used: [] })].map((x) => x.key);
    for (const k of said) expect(keys[k]?.en).toBeTruthy();
  });
});

describe('the log on the phone', () => {
  it('notes, folds units, keeps the newest KEEP, clears', () => {
    note(e(1));
    noteUnit(2, 'phone', 10, true);
    noteUnit(3, 'phone', 10, false);
    expect(brainLog()).toHaveLength(2);
    expect(brainLog()[1].vars).toMatchObject({ n: 2, tokens: 20, right: 1 });
    for (let i = 0; i < KEEP + 10; i++) note(e(10 + i));
    expect(brainLog()).toHaveLength(KEEP);
    clearBrainLog();
    expect(brainLog()).toEqual([]);
  });
});

describe('the links kula shares', () => {
  it('open the project and the coop invitation', () => {
    expect(redirectSystemPath({ path: 'https://x.github.io/pasaport/explore/project/index.html?slug=village-teacher', initial: true })).toBe('/project/village-teacher');
    expect(redirectSystemPath({ path: 'https://x.github.io/pasaport/g/?c=ab12cd', initial: false })).toBe('/coops/join?c=AB12CD');
    expect(redirectSystemPath({ path: '/models', initial: false })).toBe('/models');
  });
});

describe('the night picture', () => {
  it('is the same on every render, different per seed, stars in the sky only', () => {
    expect(starsFor(7)).toEqual(starsFor(7));
    expect(starsFor(7)).not.toEqual(starsFor(8));
    for (const s of starsFor(3)) expect(s.y).toBeLessThan(640 * 0.56);
    const r = lcg(1);
    for (let i = 0; i < 50; i++) expect(r()).toBeLessThan(1);
  });
});
