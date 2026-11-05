// A project's run (5.11.2026): the steps of each depth with a fake chat (what each step is
// shown, the thinking taken out, the answer and the work kept), a run cut in the middle and
// resumed from the next step, the night's job source (projects before the demo units, only
// in their own hours and nights, one step at a time per project, a finished night marked),
// the scheduler's own night for them, and the real worker keeping their tokens off the card.
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
jest.mock('expo-battery', () => ({ BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 }, getBatteryStateAsync: async () => 2, getBatteryLevelAsync: async () => 1, addBatteryStateListener: () => ({ remove() {} }), addBatteryLevelListener: () => ({ remove() {} }) }));
jest.mock('expo-network', () => ({ NetworkStateType: { WIFI: 'WIFI' }, getNetworkStateAsync: async () => ({ type: 'WIFI', isConnected: true }), addNetworkStateListener: () => ({ remove() {} }) }));
jest.mock('@/data/passport', () => ({ lastPassport: () => null }));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: async () => ({ data: null, error: null }), auth: { onAuthStateChange: () => {} } }, DEMO: true }));
jest.mock('@/llm/native', () => ({ llama: { keepScreenOn: async () => {} }, hasNative: () => true, native: () => { throw new Error('nonative'); } }));
const model = { id: 'qwen3-1.7b', name: 'qwen3 1.7b', file: 'q.gguf', path: '/m/q.gguf', size: 1.2e9, sha256: null, params_b: 1.7, quant: 'q4', kv_mb_per_1k: 112, ctx_max: 32768, license: null, source: 'catalog', url: '', added_at: '' };
const mockModels = { list: [model, { ...model, id: 'small', name: 'small', size: 4e8 }] };
const mockLoaded = { ids: [] as string[], ctx: [] as number[] };
jest.mock('@/llm/store', () => ({
  settings: () => ({ modelId: null, ctx: 2048, temperature: 0.7, maxTokens: 512, lastMode: 'alone' }),
  localById: (id: string) => mockModels.list.find((m) => m.id === id) ?? null,
  localModels: () => mockModels.list,
  peers: () => [],
}));
const mockChats: { messages: { role: string; content: string }[]; maxTokens: number; temperature: number }[] = [];
jest.mock('@/llm/engine', () => ({
  load: async (m: { id: string }, _mode: string, ctx: number) => { mockLoaded.ids.push(m.id); mockLoaded.ctx.push(ctx); },
  unload: async () => {},
  engine: () => ({ devices: [{ id: 'me', name: 'this phone', local: true, busy: false }], load: { ctx: 8192 } }),
  chat: (messages: { role: string; content: string }[], onToken: (t: string) => void, opts: { maxTokens: number; temperature: number }) => {
    mockChats.push({ messages, maxTokens: opts.maxTokens, temperature: opts.temperature });
    const p = new Promise((resolve) => setTimeout(() => {
      const text = messages[0].content.includes('reviewer') ? 'too long; add examples' : 'a garden plan';
      onToken(text);
      resolve({ tokens: 50, ms: 1000, firstMs: 5, tps: 50, stopped: false, device: 'this phone' });
    }, 1)) as Promise<unknown> & { stop: () => void };
    p.stop = () => {};
    return p;
  },
}));

import type { Message } from '@/llm/native';
import { DemoJobs, FirstOf, type Unit } from '@/night/jobs';
import { LlamaWorker } from '@/night/LlamaWorker';
import { evaluate, type Facts } from '@/night/conditions';
import type { NightStatus } from '@/night/NightWorker';
import { OWN_SLUG, Scheduler, type Deps, type Worker } from '@/night/scheduler';
import { ProjectJobs, type TaskDeps } from '@/tasks/jobs';
import { stepMessages } from '@/tasks/prompts';
import { recordStep, runPipeline, startRun, type ChatFn } from '@/tasks/run';
import { createTask, getTask, listTasks, saveTask } from '@/tasks/store';
import type { BrainEntry } from '@/llm/brainlog';
import type { Depth, Task, TaskInput } from '@/tasks/types';
import type { NightRules } from '@/data/settings';

const input = (patch: Partial<TaskInput> = {}): TaskInput => ({ title: 'garden', prompt: 'plan my balcony garden', photos: [], form: 'plan', length: 'short', from: '23:00', to: '07:00', days: 'every', depth: 'careful', modelId: null, chargeOnly: true, ...patch });
const at = (h: number, m = 0, day = 5) => new Date(2026, 10, day, h, m).getTime();
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(2);
};

// a chat that answers by what it is asked: a critique to a reviewer, a draft or a final
// otherwise, with a <think> part in front as qwen3 writes it
function fakeChat(log: Message[][], opts: { failAt?: number } = {}): ChatFn {
  return (messages, onToken) => {
    log.push(messages);
    const n = log.length;
    const p = (async () => {
      if (opts.failAt === n) throw new Error('device gone');
      const sys = messages[0].content;
      const user = messages[messages.length - 1].content;
      const text = sys.includes('reviewer') ? `CRITIQUE ${n}` : user.includes('the critique') ? `VERSION ${n}` : `DRAFT ${n}`;
      onToken('<think>let me see</think>');
      onToken(text);
      return { tokens: 10 * n, ms: 1000 * n };
    })();
    return p;
  };
}
const deps = (chat: ChatFn, more: Partial<Parameters<typeof runPipeline>[1]> = {}) => ({ chat, thinking: false, key: 'now', doneKey: null, load: getTask, save: saveTask, now: () => 5000, ...more });

beforeEach(() => {
  mockStore.clear();
  mockChats.length = 0;
  mockLoaded.ids = [];
  mockLoaded.ctx = [];
});

describe('the pipeline, for each depth', () => {
  it.each([
    ['quick', ['answer'], ['DRAFT 1']],
    ['careful', ['draft', 'critique', 'final'], ['DRAFT 1', 'CRITIQUE 2', 'VERSION 3']],
    ['very', ['draft', 'critique', 'revise', 'critique2', 'final'], ['DRAFT 1', 'CRITIQUE 2', 'VERSION 3', 'CRITIQUE 4', 'VERSION 5']],
  ] as [Depth, string[], string[]][])('%s: runs its steps and keeps the answer and the work', async (depth, names, texts) => {
    const t = createTask(input({ depth }), 1);
    const log: Message[][] = [];
    const out = await runPipeline(t.id, deps(fakeChat(log)));
    expect(log).toHaveLength(names.length);
    expect(out?.run).toBeNull();
    expect(out?.last?.steps.map((s) => s.name)).toEqual(names);
    expect(out?.last?.steps.map((s) => s.text)).toEqual(texts); // the thinking is taken out
    expect(out?.last?.answer).toBe(texts[texts.length - 1]);
    expect(out?.last?.tokens).toBe(names.reduce((a, _, i) => a + 10 * (i + 1), 0));
    expect(out?.runs).toBe(1);
    expect(getTask(t.id)?.last?.answer).toBe(texts[texts.length - 1]);
    // run now does not mark the night: the project still runs in its hours tonight
    expect(out?.lastDoneKey).toBeNull();
  });

  it('shows the critique the draft, and the final the draft and the critique', async () => {
    const t = createTask(input({ depth: 'careful', form: 'list', length: 'long' }), 1);
    const log: Message[][] = [];
    await runPipeline(t.id, deps(fakeChat(log)));
    expect(log[0][0].content).toContain('Answer as a list');
    expect(log[0][0].content).toContain('1600 words');
    expect(log[0][1].content).toContain('plan my balcony garden');
    expect(log[1][0].content).toContain('reviewer');
    expect(log[1][1].content).toContain('DRAFT 1');
    expect(log[2][1].content).toContain('DRAFT 1');
    expect(log[2][1].content).toContain('CRITIQUE 2');
    expect(log[2][1].content).toContain('final');
  });

  it('turns thinking on for a thinking model, with room for it, and carries the note and the photos', () => {
    const t = { ...createTask(input({ photos: ['file:///a.jpg', 'file:///b.jpg'] }), 1) };
    const m = stepMessages(t, [], 0, { thinking: true, note: 'shorter please' });
    expect(m[1].content.endsWith(' /think')).toBe(true);
    expect(m[1].content).toContain('A note for this run: shorter please');
    expect(m[1].content).toContain('2 photos you cannot see');
    expect(stepMessages(t, [], 0, { thinking: false })[1].content).not.toContain('/think');
  });

  it('resumes a run cut after a step: the steps done are kept and not asked again', async () => {
    const t = createTask(input({ depth: 'careful' }), 1);
    const first: Message[][] = [];
    let cut = false;
    const half = await runPipeline(t.id, deps(fakeChat(first), { onRecorded: () => { cut = true; }, stopped: () => cut }));
    expect(first).toHaveLength(1);
    expect(half?.run?.steps.map((s) => s.name)).toEqual(['draft']);
    expect(getTask(t.id)?.run?.steps).toHaveLength(1); // saved: an app restart finds it
    const second: Message[][] = [];
    const out = await runPipeline(t.id, deps(fakeChat(second)));
    expect(second).toHaveLength(2);
    expect(second[0][1].content).toContain('DRAFT 1'); // the critique reads the stored draft
    expect(out?.last?.steps.map((s) => s.text)).toEqual(['DRAFT 1', 'CRITIQUE 1', 'VERSION 2']);
    expect(out?.last?.runId).toBe(half?.run?.id);
  });

  it('a failing step keeps what was done and throws', async () => {
    const t = createTask(input({ depth: 'careful' }), 1);
    await expect(runPipeline(t.id, deps(fakeChat([], { failAt: 2 })))).rejects.toThrow('device gone');
    expect(getTask(t.id)?.run?.steps.map((s) => s.name)).toEqual(['draft']);
  });

  it('a finished night run marks the night, uses up the note and finishes a once-project', () => {
    let t: Task = { ...createTask(input({ depth: 'quick', days: 'once' }), 1), note: 'with examples' };
    t = startRun(t, '2026-11-05', 10, 'qwen3');
    expect(t.run?.note).toBe('with examples');
    const { task, finished } = recordStep(t, { text: 'done', tokens: 5, ms: 2000 }, 20, '2026-11-05');
    expect(finished).toBe(true);
    expect(task).toMatchObject({ run: null, note: undefined, lastDoneKey: '2026-11-05', finished: true, runs: 1 });
    expect(task.last).toMatchObject({ answer: 'done', note: 'with examples', model: 'qwen3', seconds: 2, key: '2026-11-05' });
  });
});

// the projects as the night's job source, with the clock and the plug in hand
function source(world: { now: number; charging: boolean }, log: BrainEntry[] = [], finished: Task[] = []) {
  const d: TaskDeps = { list: listTasks, load: getTask, save: saveTask, now: () => world.now, charging: () => world.charging, thinking: () => false, model: () => 'small', log: (e) => log.push(e), onFinished: (t) => finished.push(t) };
  return new ProjectJobs(d);
}
const result = (text: string) => ({ text, device: 'this phone', tokens: 7, ms: 500 });

describe("the projects' job source", () => {
  it('hands out a step only in the project\'s own hours, its nights, on charge', async () => {
    createTask(input({ from: '01:00', to: '03:00', depth: 'quick' }), 1);
    const world = { now: at(23, 30), charging: true };
    const src = source(world);
    expect(await src.next()).toBeNull(); // the night is open, the project's hours are not
    world.now = at(1, 30, 6);
    world.charging = false;
    expect(await src.next()).toBeNull(); // only on charge
    world.charging = true;
    const u = await src.next();
    expect(u).toMatchObject({ type: 'project', own: true, temperature: 0.7 });
    expect(u?.messages?.[1].content).toContain('plan my balcony garden');
  });

  it('one step of a project at a time; the next one after the step before is done; the night is marked', async () => {
    const a = createTask(input({ depth: 'careful' }), 1);
    const b = createTask(input({ title: 'letter', depth: 'quick' }), 2);
    const world = { now: at(23, 30), charging: true };
    const log: BrainEntry[] = [];
    const finished: Task[] = [];
    const src = source(world, log, finished);
    const u1 = (await src.next())!;
    expect(u1.id.startsWith(`task:${a.id}:`)).toBe(true);
    const u2 = (await src.next())!; // a's draft is out: the next project
    expect(u2.id.startsWith(`task:${b.id}:`)).toBe(true);
    expect(await src.next()).toBeNull(); // both are out
    await src.done(u2, result('dear friend'));
    expect(getTask(b.id)).toMatchObject({ run: null, lastDoneKey: '2026-11-05', last: { answer: 'dear friend' } });
    expect(finished.map((t) => t.id)).toEqual([b.id]);
    await src.done(u1, result('DRAFT'));
    const u3 = (await src.next())!;
    expect(u3.messages?.[0].content).toContain('reviewer');
    expect(u3.messages?.[1].content).toContain('DRAFT');
    // a step that could not finish goes back: the same step comes out again
    await src.retry(u3);
    const again = (await src.next())!;
    expect(again.id).toBe(u3.id);
    await src.done(again, result('CRIT'));
    const u4 = (await src.next())!;
    await src.done(u4, result('FINAL'));
    expect(getTask(a.id)).toMatchObject({ run: null, lastDoneKey: '2026-11-05', last: { answer: 'FINAL' } });
    expect(await src.next()).toBeNull(); // both done for this night
    world.now = at(23, 30, 6);
    expect((await src.next())?.id.startsWith(`task:${a.id}:`)).toBe(true); // the next night
    expect(log.map((e) => e.key)).toEqual(['brain.task.start', 'brain.task.start', 'brain.task.step.answer', 'brain.task.done', 'brain.task.step.draft', 'brain.task.step.critique', 'brain.task.step.final', 'brain.task.done', 'brain.task.start']);
  });

  it('a step of a project deleted or run again under it is dropped', async () => {
    const a = createTask(input({ depth: 'careful' }), 1);
    const src = source({ now: at(23, 30), charging: true });
    const u = (await src.next())!;
    saveTask({ ...getTask(a.id)!, run: null });
    await src.done(u, result('late'));
    expect(getTask(a.id)?.run).toBeNull();
    expect(getTask(a.id)?.last).toBeNull();
  });

  it('comes before the demo units on the night\'s pile', async () => {
    createTask(input({ depth: 'quick' }), 1);
    const demo: Unit[] = [{ id: 'd1', type: 'classify', prompt: 'x', maxTokens: 4 }];
    const pile = new FirstOf([source({ now: at(23, 30), charging: true }), new DemoJobs(demo)]);
    const first = (await pile.next())!;
    expect(first.type).toBe('project');
    const second = (await pile.next())!;
    expect(second.id).toBe('d1');
    expect(await pile.next()).toBeNull();
    await pile.done(first, result('ok')); // goes back to the projects
    expect(listTasks()[0].last?.answer).toBe('ok');
  });
});

describe('the real worker with a project', () => {
  it('loads the project\'s model with a larger context, sends its messages, keeps its tokens off the card', async () => {
    createTask(input({ depth: 'careful' }), 1);
    const src = source({ now: Date.now(), charging: true });
    const w = new LlamaWorker({ source: (_k, slug) => (slug === OWN_SLUG ? src : new DemoJobs([])), prefer: () => 'small', ctx: () => 8192, idleMs: 2 });
    // its hours: all day for this test
    saveTask({ ...listTasks()[0], from: '00:00', to: '23:59' });
    w.start(OWN_SLUG, 5, 'k');
    await until(() => w.status().state === 'done');
    expect(mockLoaded.ids).toEqual(['small']);
    expect(mockLoaded.ctx[0]).toBe(2048); // no passport: what fits is not known, the setting stays
    expect(mockChats).toHaveLength(3);
    expect(mockChats[0].temperature).toBe(0.7);
    expect(mockChats[1].messages[0].content).toContain('reviewer');
    expect(w.status()).toMatchObject({ tokens: 0, units: 0, ownUnits: 3, ownTokens: 150 });
    expect(listTasks()[0].last?.answer).toBe('a garden plan');
  });
});

// ---- the scheduler's own night
const rules: NightRules = { from: '23:00', to: '07:30', wifiOnly: true, chargeOnly: true, minBattery: 30 };
class FakeWorker implements Worker {
  s: NightStatus = { state: 'idle', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0 };
  starts: string[] = [];
  start(slug: string) {
    this.starts.push(slug);
    this.s = { state: 'running', slug, startedAt: 0, tokens: 0, seconds: 0, kwh: 0, tps: 0, ownUnits: 0 };
  }
  stop() {
    if (this.s.state === 'running') this.s = { ...this.s, state: 'done' };
  }
  reset() {
    this.s = { state: 'idle', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0 };
  }
  wait(reason: NonNullable<NightStatus['reason']>) {
    if (this.s.state !== 'running') this.s = { ...this.s, state: 'waiting', reason };
  }
  status() {
    return this.s;
  }
  subscribe() {
    return () => {};
  }
}
function night() {
  const world = { now: at(21, 0), slug: null as string | null, own: true, charging: true, held: false };
  const worker = new FakeWorker();
  const calls = { starts: 0, ends: 0, reports: 0 };
  const facts = (): Facts => ({ now: new Date(world.now), charging: world.charging, net: 'wifi', batteryPct: 90, hot: false, wanted: true, hasProject: !!world.slug, hasPassport: true, projectWindow: world.own });
  const d: Deps = {
    worker: () => worker,
    verdict: async () => evaluate(facts(), rules),
    project: async () => world.slug,
    rules: () => rules,
    now: () => world.now,
    tps: () => 5,
    watts: () => null,
    store: { get: (k) => mockStore.get(k) ?? null, set: (k, v) => mockStore.set(k, v), del: (k) => mockStore.delete(k) },
    startNight: async () => ({ id: `c${++calls.starts}`, jobId: 'j', at: world.now }),
    endNight: async () => { calls.ends++; },
    sendReport: async () => { calls.reports++; return true; },
    notify: { show: () => {}, hide: () => {} },
    hold: () => world.held,
  };
  return { world, worker, calls, sch: new Scheduler(d) };
}

describe("the scheduler's own night", () => {
  it('a project due in its own hours opens a night with no server, no card, no report', async () => {
    const { world, worker, calls, sch } = night();
    expect(evaluate({ now: new Date(world.now), charging: true, net: 'none', batteryPct: 90, hot: false, wanted: false, hasProject: false, hasPassport: true, projectWindow: true }, rules)).toMatchObject({ ok: false, own: true });
    expect(await sch.tick()).toBe('running');
    expect(worker.starts).toEqual([OWN_SLUG]);
    expect(sch.open()).toMatchObject({ slug: OWN_SLUG, id: null });
    // the projects ran dry: the night ends, nothing went to the server
    worker.s = { ...worker.s, state: 'done', ownUnits: 3 };
    world.own = false;
    expect(await sch.tick()).toBe('waiting');
    expect(sch.open()).toBeNull();
    expect(calls).toEqual({ starts: 0, ends: 0, reports: 0 });
    expect(sch.doneKey()).toBeNull(); // the network's night is not marked done
  });

  it('ends when the plug comes out, and the network night still starts later', async () => {
    const { world, worker, calls, sch } = night();
    world.slug = 'beyin';
    await sch.tick();
    expect(worker.starts).toEqual([OWN_SLUG]);
    worker.s = { ...worker.s, ownUnits: 1 };
    world.charging = false;
    expect(await sch.tick()).toBe('waiting');
    expect(sch.open()).toBeNull();
    world.charging = true;
    world.own = false;
    world.now = at(23, 0);
    expect(await sch.tick()).toBe('running');
    expect(worker.starts).toEqual([OWN_SLUG, 'beyin']);
    expect(calls.starts).toBe(1);
  });

  it('inside the network window the network night runs (the projects go first on its pile)', async () => {
    const { world, worker, sch } = night();
    world.slug = 'beyin';
    world.now = at(23, 30);
    expect(await sch.tick()).toBe('running');
    expect(worker.starts).toEqual(['beyin']);
  });

  it('rests after an own night that got nothing done, and waits while run-now holds the model', async () => {
    const { world, worker, sch } = night();
    world.held = true;
    expect(await sch.tick()).toBe('waiting');
    expect(worker.starts).toEqual([]);
    world.held = false;
    await sch.tick();
    worker.s = { ...worker.s, state: 'done' }; // drained with nothing done (no model, say)
    await sch.tick();
    expect(worker.starts).toEqual([OWN_SLUG]);
    world.now += 5 * 60_000;
    await sch.tick();
    expect(worker.starts).toEqual([OWN_SLUG]);
    world.now += 6 * 60_000;
    await sch.tick();
    expect(worker.starts).toEqual([OWN_SLUG, OWN_SLUG]);
  });
});
