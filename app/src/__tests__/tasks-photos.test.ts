// A project's photos at night (10.11.2026, tasks/seen.ts): read once by the chosen vision
// model before the run, kept until the photos change, in every step's prompt marked as the
// vision model's; without a vision model the photos are kept, the run goes on the text
// alone, and the run (so the morning report) says the photos were not read.
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

import type { BrainEntry } from '@/llm/brainlog';
import { readAllPhotos, readTaskPhotos, type SeenDeps } from '@/tasks/seen';
import { seenFor, stepMessages } from '@/tasks/prompts';
import { recordStep, startRun } from '@/tasks/run';
import type { Task } from '@/tasks/types';

const task = (patch: Partial<Task> = {}): Task => ({
  id: 't1', title: 'my plant', prompt: 'why are the leaves yellow?', photos: ['file:///p/1.jpg', 'file:///p/2.jpg'], form: 'list', length: 'short',
  from: '23:00', to: '07:00', days: 'every', depth: 'careful', modelId: null, chargeOnly: true, active: true,
  run: null, last: null, lastDoneKey: null, finished: false, runs: 0, createdAt: 1, updatedAt: 1, ...patch,
});

let saved: Task[] = [];
let logged: BrainEntry[] = [];
let asked: { uris: string[]; question: string }[] = [];
const deps = (describe: SeenDeps['describe']): SeenDeps => ({ describe, save: (t) => saved.push(t), log: (e) => logged.push(e), now: () => 500 });
const reads: SeenDeps['describe'] = async (uris, question) => {
  asked.push({ uris, question });
  return { text: 'photo 1: a monstera, lower leaves yellow\nphoto 2: wet soil, a saucer full of water', by: 'SmolVLM 500M', n: uris.length };
};
const none: SeenDeps['describe'] = async () => {
  throw new Error('novision');
};

beforeEach(() => {
  saved = [];
  logged = [];
  asked = [];
});

describe('reading a project\'s photos', () => {
  it('reads them once with the question, keeps the reading on the project, logs it', async () => {
    const t = await readTaskPhotos(task(), deps(reads));
    expect(asked).toEqual([{ uris: ['file:///p/1.jpg', 'file:///p/2.jpg'], question: 'why are the leaves yellow?' }]);
    expect(t.seen).toEqual({ photos: ['file:///p/1.jpg', 'file:///p/2.jpg'], text: expect.stringContaining('monstera'), by: 'SmolVLM 500M', at: 500 });
    expect(saved).toEqual([t]);
    expect(logged.map((e) => e.key)).toEqual(['brain.vision.task']);
    // read already: not again
    expect(await readTaskPhotos(t, deps(reads))).toBe(t);
    expect(asked).toHaveLength(1);
  });
  it('reads them again when the photos changed; none, nothing to read', async () => {
    const t = await readTaskPhotos(task(), deps(reads));
    const changed = { ...t, photos: ['file:///p/1.jpg', 'file:///p/3.jpg'] };
    expect(seenFor(changed)).toBeNull();
    await readTaskPhotos(changed, deps(reads));
    expect(asked).toHaveLength(2);
    expect(await readTaskPhotos(task({ photos: [] }), deps(reads))).toEqual(task({ photos: [] }));
    expect(asked).toHaveLength(2);
  });
  it('without a vision model: the project is unchanged, the brain log says it runs on the text alone', async () => {
    const t = task();
    expect(await readTaskPhotos(t, deps(none))).toBe(t);
    expect(saved).toEqual([]);
    expect(logged).toEqual([expect.objectContaining({ key: 'brain.vision.none', vars: { title: 'my plant' }, tone: 'warn' })]);
  });
  it('the night reads every due project, one after the other', async () => {
    expect(await readAllPhotos([task(), task({ id: 't2', photos: [] }), task({ id: 't3' })], deps(reads))).toBe(2);
  });
});

describe('the steps with photos', () => {
  it('read photos: every step carries the vision model\'s reading, marked as its', async () => {
    const t = await readTaskPhotos(task(), deps(reads));
    const draft = stepMessages(t, [], 0, { thinking: false });
    expect(draft[1].content).toContain('SmolVLM 500M, a vision model on this phone');
    expect(draft[1].content).toContain('saucer full of water');
    expect(draft[1].content).not.toContain('cannot see');
    const critique = stepMessages(t, [{ name: 'draft', text: 'water less', tokens: 3, ms: 1, at: 1 }], 1, { thinking: false });
    expect(critique[1].content).toContain('saucer full of water');
  });
  it('unread photos: named as unseen, as before', () => {
    expect(stepMessages(task(), [], 0, { thinking: false })[1].content).toContain('2 photos you cannot see');
  });
  it('the run and its answer say who read the photos, or that nobody could', async () => {
    const read = await readTaskPhotos(task(), deps(reads));
    let r = startRun(read, 'k', 10);
    expect(r.run!.photos).toEqual({ n: 2, by: 'SmolVLM 500M' });
    for (let i = 0; i < 3; i++) r = recordStep(r, { text: `step ${i}`, tokens: 5, ms: 10 }, 20 + i, 'k').task;
    expect(r.last!.photos).toEqual({ n: 2, by: 'SmolVLM 500M' });
    const unread = startRun(task(), 'k', 10);
    expect(unread.run!.photos).toEqual({ n: 2, by: null });
    expect(startRun(task({ photos: [] }), 'k', 10).run!.photos).toBeUndefined();
  });
});
