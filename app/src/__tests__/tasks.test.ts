// Projects, the person's own night work (5.11.2026): the store on the phone (create, read,
// update, delete, run again), when a project is due (its own hours, its nights, done once
// per night, the plug), the estimate before saving, and the morning's list.
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

import { createTask, deleteTask, getTask, listTasks, runAgain, saveTask, updateTask } from '@/tasks/store';
import { doneSince, dueTasks, isDue, nextStart, nightOk, stateOf, windowMinutes } from '@/tasks/schedule';
import { estimate } from '@/tasks/estimate';
import type { Task, TaskInput } from '@/tasks/types';

const input = (patch: Partial<TaskInput> = {}): TaskInput => ({ title: 'garden plan', prompt: 'plan my balcony garden for spring', photos: [], form: 'plan', length: 'medium', from: '23:00', to: '07:00', days: 'every', depth: 'careful', modelId: null, chargeOnly: true, ...patch });
// 5 November 2026 is a thursday
const at = (h: number, m = 0, day = 5) => new Date(2026, 10, day, h, m);
const task = (patch: Partial<Task> = {}): Task => ({ ...input(), id: 't1', active: true, run: null, last: null, lastDoneKey: null, finished: false, runs: 0, createdAt: 1, updatedAt: 1, ...patch });

beforeEach(() => mockStore.clear());

describe('the project store', () => {
  it('creates, reads, updates and deletes on the phone', () => {
    expect(listTasks()).toEqual([]);
    const a = createTask(input(), 100);
    const b = createTask(input({ title: 'letter' }), 200, 'given-id');
    expect(b.id).toBe('given-id');
    expect(listTasks().map((t) => t.title)).toEqual(['garden plan', 'letter']);
    expect(getTask(a.id)).toMatchObject({ title: 'garden plan', active: true, run: null, last: null, runs: 0, createdAt: 100 });
    expect(updateTask(a.id, { title: 'balcony', depth: 'very' }, 300)).toMatchObject({ id: a.id, title: 'balcony', depth: 'very', updatedAt: 300 });
    expect(getTask(a.id)?.title).toBe('balcony');
    expect(updateTask('nope', { title: 'x' })).toBeNull();
    saveTask({ ...getTask(b.id)!, runs: 3 });
    expect(getTask(b.id)?.runs).toBe(3);
    deleteTask(a.id);
    expect(listTasks().map((t) => t.id)).toEqual(['given-id']);
    // it lives in the kv-store only, under one key
    expect([...mockStore.keys()]).toEqual(['tasks.list']);
  });

  it('reads a broken store as empty', () => {
    mockStore.set('tasks.list', '{nope');
    expect(listTasks()).toEqual([]);
    mockStore.set('tasks.list', '{"a":1}');
    expect(listTasks()).toEqual([]);
  });

  it('"run again tonight" keeps the note, clears the night mark and opens a once-project', () => {
    const t = createTask(input({ days: 'once' }), 1);
    saveTask({ ...t, finished: true, lastDoneKey: '2026-11-05' });
    expect(runAgain(t.id, '  shorter, with examples ', 2)).toMatchObject({ note: 'shorter, with examples', finished: false, lastDoneKey: null, active: true });
    expect(runAgain(t.id, '   ', 3)?.note).toBeUndefined();
  });
});

describe('when a project runs', () => {
  it('runs in its own hours, across midnight too', () => {
    const t = task();
    expect(isDue(t, at(22, 59), true)).toBe(false);
    expect(isDue(t, at(23, 0), true)).toBe(true);
    expect(isDue(t, at(3, 0, 6), true)).toBe(true);
    expect(isDue(t, at(7, 0, 6), true)).toBe(false);
    const day = task({ from: '13:00', to: '15:30' });
    expect(isDue(day, at(14, 0), true)).toBe(true);
    expect(isDue(day, at(15, 30), true)).toBe(false);
    expect(windowMinutes('23:00', '07:00')).toBe(480);
    expect(windowMinutes('13:00', '15:30')).toBe(150);
  });

  it('asks for the plug only when it says so, and not when switched off', () => {
    expect(isDue(task(), at(23, 30), false)).toBe(false);
    expect(isDue(task({ chargeOnly: false }), at(23, 30), false)).toBe(true);
    expect(isDue(task({ active: false }), at(23, 30), true)).toBe(false);
  });

  it('runs once per night: the night it was finished in is skipped, the next one is not', () => {
    const t = task({ lastDoneKey: '2026-11-05' });
    expect(isDue(t, at(23, 30), true)).toBe(false);
    expect(isDue(t, at(2, 0, 6), true)).toBe(false); // still the night of the 5th
    expect(isDue(t, at(23, 30, 6), true)).toBe(true);
  });

  it('weekdays are the windows that open monday to friday; once is once', () => {
    const wd = task({ days: 'weekdays' });
    expect(nightOk(wd, '2026-11-06')).toBe(true); // friday
    expect(nightOk(wd, '2026-11-07')).toBe(false); // saturday
    expect(isDue(wd, at(23, 30, 6), true)).toBe(true); // friday night
    expect(isDue(wd, at(2, 0, 7), true)).toBe(true); // still friday's night, after midnight
    expect(isDue(wd, at(23, 30, 7), true)).toBe(false); // saturday night
    expect(isDue(wd, at(23, 30, 9), true)).toBe(true); // monday night
    const once = task({ days: 'once' });
    expect(isDue(once, at(23, 30), true)).toBe(true);
    expect(isDue({ ...once, finished: true }, at(23, 30, 6), true)).toBe(false);
  });

  it('puts a run already begun first, then the oldest', () => {
    const a = task({ id: 'a', createdAt: 1 });
    const b = task({ id: 'b', createdAt: 2, run: { id: 'r', key: '2026-11-05', startedAt: 0, steps: [] } });
    const c = task({ id: 'c', createdAt: 3, from: '01:00', to: '05:00' });
    const off = task({ id: 'off', createdAt: 0, active: false });
    expect(dueTasks([a, b, c, off], at(23, 30), true).map((t) => t.id)).toEqual(['b', 'a']);
    expect(dueTasks([a, b, c, off], at(2, 0, 6), true).map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('knows when it runs next', () => {
    expect(nextStart(task(), at(12, 0))).toEqual(at(23, 0));
    expect(nextStart(task(), at(2, 0, 6))).toEqual(at(2, 0, 6)); // open now
    expect(nextStart(task({ lastDoneKey: '2026-11-05' }), at(2, 0, 6))).toEqual(at(23, 0, 6));
    expect(nextStart(task({ days: 'weekdays' }), at(12, 0, 7))).toEqual(at(23, 0, 9)); // saturday noon: the next weekday night is monday's
    expect(nextStart(task({ days: 'once', finished: true }), at(12, 0))).toBeNull();
    expect(nextStart(task({ active: false }), at(12, 0))).toBeNull();
  });

  it('names a row: running, begun, ready, waiting, off, finished', () => {
    const step = { name: 'draft' as const, text: 'x', tokens: 1, ms: 1, at: 1 };
    const done = { runId: 'r', at: 5, key: 'k', answer: 'a', steps: [step], tokens: 1, seconds: 1 };
    expect(stateOf(task(), 't1')).toBe('running');
    expect(stateOf(task({ run: { id: 'r', key: 'k', startedAt: 0, steps: [step] } }), null)).toBe('started');
    expect(stateOf(task({ last: done }), null)).toBe('ready');
    expect(stateOf(task(), null)).toBe('waiting');
    expect(stateOf(task({ active: false }), null)).toBe('off');
    expect(stateOf(task({ days: 'once', finished: true, last: done }), null)).toBe('finished');
  });
});

describe('the morning report', () => {
  it('lists the projects whose answer came in, newest first', () => {
    const done = (id: string, atMs: number) => task({ id, last: { runId: 'r', at: atMs, key: 'k', answer: 'an answer', steps: [], tokens: 9, seconds: 1 } });
    const list = [done('old', 100), task({ id: 'none' }), done('new', 900), done('mid', 500)];
    expect(doneSince(list, 400).map((t) => t.id)).toEqual(['new', 'mid']);
    expect(doneSince(list, 0).map((t) => t.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('the estimate', () => {
  const base = { tps: 10, from: '23:00', to: '07:00', depth: 'quick' as const, length: 'medium' as const, thinking: false, promptChars: 400, now: at(12, 0) };

  it('says how many words and when it is done, from the window opening', () => {
    const e = estimate(base);
    expect(e.kind).toBe('fits');
    if (e.kind === 'unknown') throw new Error();
    expect(e.words).toBe(900); // 1200 tokens × 0.75
    expect(e.steps).toBe(1);
    expect(e.startAt).toEqual(at(23, 0));
    // 1200 tokens at 10 tok/s + the prompt read 6× faster + the step's overhead
    expect(e.seconds).toBe(Math.round(1200 / 10 + 180 / 60 + 4));
    expect(e.doneAt.getTime()).toBe(at(23, 0).getTime() + e.seconds * 1000);
    expect(e.windowSeconds).toBe(8 * 3600);
  });

  it('starts now when the window is open, and counts only what is left of it', () => {
    const e = estimate({ ...base, now: at(6, 0, 6) });
    if (e.kind === 'unknown') throw new Error();
    expect(e.startAt).toEqual(at(6, 0, 6));
    expect(e.windowSeconds).toBe(3600);
  });

  it('grows with the depth and with thinking', () => {
    const q = estimate(base);
    const c = estimate({ ...base, depth: 'careful' });
    const v = estimate({ ...base, depth: 'very' });
    const think = estimate({ ...base, depth: 'careful', thinking: true });
    if (q.kind === 'unknown' || c.kind === 'unknown' || v.kind === 'unknown' || think.kind === 'unknown') throw new Error();
    expect([q.steps, c.steps, v.steps]).toEqual([1, 3, 5]);
    expect(c.seconds).toBeGreaterThan(q.seconds);
    expect(v.seconds).toBeGreaterThan(c.seconds);
    expect(think.tokens).toBe(c.tokens + 3 * 1024);
  });

  it("says when it won't finish in the window", () => {
    expect(estimate({ ...base, tps: 0.5, depth: 'very', length: 'long', from: '02:00', to: '03:00' }).kind).toBe('over');
    expect(estimate({ ...base, tps: 0.5, depth: 'quick', length: 'short', from: '02:00', to: '03:00' }).kind).toBe('fits');
  });

  it('cannot say without a speed', () => {
    expect(estimate({ ...base, tps: null })).toEqual({ kind: 'unknown' });
    expect(estimate({ ...base, tps: 0 })).toEqual({ kind: 'unknown' });
  });
});
