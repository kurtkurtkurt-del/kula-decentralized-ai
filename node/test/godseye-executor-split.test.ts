// god's eye, executor in a split (F4, 13.11.2026): kula's engine opens a split with no peers, so
// work.loaded.devices is this computer alone and the workers are only in work.loaded.parts. Every
// token crosses every part: a part that keeps failing its checks gets the "keeps dropping out" card,
// the host answering again forgets its misses, and a healthy split looks exactly as before. A part
// that should rest gets no executor card: the planner's barred card says "split without it".
import { test } from 'node:test';
import assert from 'node:assert/strict';

const executor = await import('../src/godseye/branches/executor.ts');
const limits = await import('../src/godseye/branches/limits.ts');
const planner = await import('../src/godseye/branches/planner.ts');
const decide = await import('../src/godseye/branches/decide.ts');

const dev = (o: Record<string, unknown> = {}): any => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachedBy: 'lan',
  reachable: true, reachMs: 12, reason: null, checkedAt: 1_000_000, lastOk: null, ramMb: 6000, bwGBs: null,
  gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null, ...o,
});
const M = { id: 'm', name: 'M', file: 'm.gguf', size: 1e9, quant: 'Q4_K_M', params_b: 1, catalog: true, here: true, needMb: 6000 };
const snap = (o: Record<string, any> = {}): any => ({
  at: 1_000_000, host: { name: 'mac', freeMb: 8000 }, devices: [], models: [M], projects: [], ...o,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...(o.work ?? {}) },
});
const HOST_PART = { id: 'local', name: 'this computer', local: true, mb: 4000, layers: 16 };
const P1_PART = { id: 'p1', name: 'pixel', local: false, mb: 4000, layers: 16 };
const split = (busy: boolean, done = 3, parts: any[] = [HOST_PART, P1_PART], devices?: any[]) => ({
  mode: 'split', model: { id: 'm', name: 'M', file: 'm.gguf', size: 1e9 }, ctx: 4096, since: 500_000,
  devices: devices ?? [{ id: 'local', name: 'mac', local: true, busy, tps: 6, done }],
  parts,
});

function branch(make: any, peeks: Record<string, any> = {}) {
  let t = 0;
  const fed: string[] = [];
  const b = make({
    now: () => t,
    load: <T,>(fb: T): T => fb,
    save: () => {},
    emit: (x: string) => { fed.push(x); },
    peek: (id: string) => peeks[id] ?? null,
  });
  return { b, fed, set: (ms: number) => { t = ms; } };
}
const ids = (v: any) => (v.suggestions ?? []).map((c: any) => c.id);

/** six failed checks of p1, 15 s apart, while the split answers */
function failSix(b: any, parts?: any[], devices?: any[]) {
  let t = 1_000_000;
  for (let i = 0; i < 6; i++) {
    t += 15_000;
    b.observe(snap({ at: t, devices: [dev({ reachable: false, reason: 'timeout', checkedAt: t })], work: { loaded: split(true, 3, parts, devices) } }), null);
  }
  return t;
}

test('a split worker that fails six checks 15 s apart gets the "keeps dropping out" card, with a line', () => {
  const { b } = branch(executor.create);
  failSix(b);
  const v = b.view();
  const c = v.suggestions.find((x: any) => x.id === 'executor:failing:p1');
  assert.ok(c, `cards: ${JSON.stringify(ids(v))}`);
  assert.deepEqual(c.action, { do: 'probe', devices: ['p1'] });
  assert.equal(c.label, 'look again');
  assert.equal(c.title, 'pixel keeps dropping out');
  assert.equal(c.why, '6 of its last 6 checks found it unreachable (last: timeout); it holds part of M and every token crosses it: an answer may stall or fail.');
  assert.ok(v.lines.includes('pixel \u{b7} holds 16 layers of the split \u{b7} 6 of its last 6 checks failed'), v.lines.join('\n'));
});

test('the host answering again forgets the part\'s failed checks, and the card goes (C4 for parts)', () => {
  const { b } = branch(executor.create);
  let t = failSix(b);
  assert.ok(ids(b.view()).includes('executor:failing:p1'));
  // the host's answer count grows: every token crossed p1, so it answered
  for (let i = 0; i < decide.HIDE; i++) {
    t += 5_000;
    b.observe(snap({ at: t, devices: [dev({ reachable: false, reason: 'timeout', checkedAt: 1_090_000 })], work: { loaded: split(true, 4 + i) } }), null);
  }
  const v = b.view();
  assert.deepEqual(ids(v), []);
  assert.ok(!v.lines.some((l: string) => /layers of the split/u.test(l)), v.lines.join('\n'));
});

test('a healthy split shows exactly today\'s lines and no card', () => {
  const { b } = branch(executor.create);
  let t = 1_000_000;
  for (let i = 0; i < 3; i++) {
    t += 5_000;
    b.observe(snap({ at: t, devices: [dev({ checkedAt: t })], work: { loaded: split(true) } }), null);
  }
  const v = b.view();
  assert.deepEqual(ids(v), []);
  assert.deepEqual(v.lines, ['mac \u{b7} answering now \u{b7} 6 tok/s \u{b7} 3 answers \u{b7} busy in 100% of the last 3 looks']);
  assert.equal(v.stat, '1 answering \u{b7} 3 answers');
});

test('a part with no memory, a local part, and a part that is also a device of the load add nothing', () => {
  const parts = [HOST_PART, { ...P1_PART, mb: 0 }, { id: 'p3', name: 'tab', local: true, mb: 2000, layers: 8 }, { id: 'p4', name: 'moto', local: false, mb: 2000, layers: 8 }];
  const devices = [{ id: 'local', name: 'mac', local: true, busy: true, tps: 6, done: 3 }, { id: 'p4', name: 'moto', local: false, busy: true, tps: 6, done: 3 }];
  assert.deepEqual(executor.partsOf(split(true, 3, parts, devices)), []);
  assert.deepEqual(executor.partsOf({ ...split(true), mode: 'apart' }), [], 'only a split has parts');
  assert.deepEqual(executor.partsOf(split(true)), [{ id: 'p1', name: 'pixel', mb: 4000, layers: 16 }]);

  const { b } = branch(executor.create);
  let t = 1_000_000;
  for (let i = 0; i < 6; i++) {
    t += 15_000;
    const failing = (id: string) => dev({ id, name: id, reachable: false, reason: 'timeout', checkedAt: t });
    b.observe(snap({ at: t, devices: [failing('p1'), failing('p3'), failing('p4')], work: { loaded: split(true, 3, parts, devices) } }), null);
  }
  const v = b.view();
  assert.deepEqual(ids(v), ['executor:failing:p4'], 'p4 once, as a device of the load; p1 (no memory) and p3 (local) nothing');
  assert.ok(!v.lines.some((l: string) => /layers of the split/u.test(l)), v.lines.join('\n'));
});

test('a part limits says should rest gets no executor card; the host\'s own rest card is as today', () => {
  const peeks = { limits: { hints: [{ id: 'p1', no: 'should rest (limits)' }, { id: 'local', no: 'should rest (limits)' }] } };
  const { b } = branch(executor.create, peeks);
  let t = 1_000_000;
  for (let i = 0; i < decide.SHOW; i++) {
    t += 5_000;
    b.observe(snap({ at: t, devices: [dev({ checkedAt: t })], work: { loaded: split(true) } }), null);
  }
  const v = b.view();
  assert.deepEqual(ids(v), ['executor:rest:local']);
  const c = v.suggestions[0];
  assert.equal(c.title, 'mac should rest (limits)');
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'limits' });
  assert.equal(c.why, 'it is the one answering M; nothing is stopped by the brain.');
});

test('chain: limits sees the part working 25 busy minutes, and the real planner bars it: split without it', () => {
  const lim = branch(limits.create);
  let t = 1_000_000;
  for (let i = 0; i <= 25 * 6; i++) {           // 10 s looks, busy throughout
    t += 10_000; lim.set(t);
    lim.b.observe(snap({ at: t, devices: [dev({ checkedAt: t })], work: { loaded: split(true) } }), null);
  }
  const lv = lim.b.view();
  assert.ok(lv.hints.some((h: any) => h.id === 'p1'), JSON.stringify(lv.hints));

  const pl = branch(planner.create, { limits: lv });
  let v: any = null;
  for (let i = 0; i < decide.SHOW; i++) {
    t += 5_000;
    pl.b.observe(snap({ at: t, devices: [dev({ checkedAt: t })], work: { loaded: split(true) } }), null);
    v = pl.b.view();
  }
  const c = v.suggestions.find((x: any) => x.id === 'planner:barred:p1');
  assert.ok(c, `cards: ${JSON.stringify(ids(v))}`);
  assert.equal(c.title, 'pixel holds part of M but should rest (limits)');
});
