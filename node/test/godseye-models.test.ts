// god's eye, branch 10 models: its load cards say what a tap would really do (P15, D7 and P8 note a).
// An apart load that leaves this computer out says here:false (kula's engine runs this computer in
// apart unless told so); a card that loads a model not on this computer says it is fetched first,
// and the memory warning prefers a smaller model that is already here. Cards only; nothing runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const models = await import('../src/godseye/branches/models.ts');

const AT = 1_000_000;
const dev = (o: Record<string, unknown> = {}): any => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachedBy: 'lan',
  reachable: true, reachMs: 12, reason: null, checkedAt: AT, lastOk: null, ramMb: 6000, bwGBs: null,
  gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null, ...o,
});
const model = (o: Record<string, unknown> = {}): any => ({
  id: 'm', name: 'M', file: 'm.gguf', size: 1e9, quant: 'Q4_K_M', params_b: 1, catalog: true, here: true, needMb: 1000, ...o,
});
const snap = (o: Record<string, any> = {}): any => ({
  at: AT, host: { name: 'mac', freeMb: 8000 }, devices: [], models: [], projects: [], ...o,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...(o.work ?? {}) },
});
const local = { id: 'local', name: 'mac', local: true, busy: false, tps: null, done: 0 };
const loaded = (mode: string, m: any, devices: any[]) => ({ mode, model: { id: m.id, name: m.name, file: m.file, size: m.size }, ctx: 4096, since: 1, devices });

/** a models branch and a look function: each look moves the clock 5 s */
function branch() {
  let t = AT;
  const b = models.create({ now: () => t, load: <T,>(f: T): T => f, save: () => {}, emit: () => {}, peek: () => null } as any);
  const look = (s: any) => { t += 5000; s.at = t; b.observe(s, null); };
  return { b, look, card: (id: string) => b.view().suggestions.find((x: any) => x.id === id) };
}

test('loaded apart on a phone with no row for this computer: bigger and tight cards keep this computer out', () => {
  const small = model({ id: 'small', name: 'Small', file: 's.gguf', needMb: 2000 });
  const big = model({ id: 'big', name: 'Big', file: 'b.gguf', needMb: 3000 });
  const tiny = model({ id: 'tiny', name: 'Tiny', file: 't.gguf', needMb: 800 });
  const work = { loaded: loaded('apart', small, [{ id: 'p1', name: 'pixel', local: false, busy: false, tps: null, done: 0 }]) };
  const { look, card } = branch();
  for (let i = 0; i < 4; i++) look(snap({ devices: [dev()], models: [small, big, tiny], work }));
  const bigger = card('models:bigger:big');
  assert.ok(bigger, 'no bigger card');
  assert.deepEqual(bigger.action, { do: 'load', model: 'big', mode: 'apart', devices: ['p1'], here: false });
  // the phone's memory drops: Small no longer fits it, Tiny does
  for (let i = 0; i < 4; i++) look(snap({ devices: [dev({ ramMb: 2000 })], models: [small, big, tiny], work }));
  const tight = card('models:tight:p1');
  assert.ok(tight, 'no tight card');
  assert.deepEqual(tight.action, { do: 'load', model: 'tiny', mode: 'apart', devices: ['p1'], here: false });
});

test('loaded apart with this computer in it: no here:false (this computer stays in by default)', () => {
  const small = model({ id: 'small', name: 'Small', file: 's.gguf', needMb: 2000 });
  const big = model({ id: 'big', name: 'Big', file: 'b.gguf', needMb: 3000 });
  const work = { loaded: loaded('apart', small, [local, { id: 'p1', name: 'pixel', local: false, busy: false, tps: null, done: 0 }]) };
  const { look, card } = branch();
  for (let i = 0; i < 4; i++) look(snap({ devices: [dev()], models: [small, big], work }));
  const bigger = card('models:bigger:big');
  assert.ok(bigger, 'no bigger card');
  assert.deepEqual(bigger.action, { do: 'load', model: 'big', mode: 'apart', devices: ['p1'] });
});

test('a bigger model not on this computer: the card says it is fetched first and how big it is (D7)', () => {
  const cur = model({ id: 'small', name: 'Small', file: 's.gguf', size: 2e9, needMb: 2500 });
  const big = model({ id: 'big', name: 'Qwen3 30B-A3B', file: 'q.gguf', size: 18.5e9, needMb: 19000, here: false });
  const { look, card } = branch();
  for (let i = 0; i < 4; i++) look(snap({ host: { name: 'mac', freeMb: 30000 }, models: [cur, big], work: { loaded: loaded('here', cur, [local]) } }));
  const c = card('models:bigger:big');
  assert.ok(c, 'no bigger card');
  assert.deepEqual(c.action, { do: 'load', model: 'big', mode: 'here', devices: [] });
  assert.match(c.why, /it is fetched first \(17\.2 GB\)/);
});

test('a bigger model already here says nothing about fetching', () => {
  const cur = model({ id: 'small', name: 'Small', file: 's.gguf', size: 2e9, needMb: 2500 });
  const big = model({ id: 'big', name: 'Big', file: 'b.gguf', size: 4e9, needMb: 4500 });
  const { look, card } = branch();
  for (let i = 0; i < 4; i++) look(snap({ host: { name: 'mac', freeMb: 30000 }, models: [cur, big], work: { loaded: loaded('here', cur, [local]) } }));
  const c = card('models:bigger:big');
  assert.ok(c, 'no bigger card');
  assert.doesNotMatch(c.why, /fetch/);
});

/** loaded here at 4 GB free, then this computer's memory drops to 1 GB free: Mid no longer fits */
function tightHere(smaller: any[]) {
  const mid = model({ id: 'mid', name: 'Mid', file: 'mid.gguf', size: 5e9, needMb: 6000 });
  const all = [mid, ...smaller];
  const work = { loaded: loaded('here', mid, [local]) };
  const { look, card } = branch();
  look(snap({ host: { name: 'mac', freeMb: 4000 }, models: all, work }));
  for (let i = 0; i < 4; i++) look(snap({ host: { name: 'mac', freeMb: 1000 }, models: all, work }));
  return card('models:tight:local');
}

test('memory dropped here: the warning prefers a smaller model already on this computer', () => {
  const away = model({ id: 'away', name: 'Away', file: 'a.gguf', size: 3e9, needMb: 4500, here: false });
  const tiny = model({ id: 'tiny', name: 'Tiny', file: 't.gguf', size: 0.6e9, needMb: 1000 });
  const c = tightHere([away, tiny]);
  assert.ok(c, 'no tight card');
  assert.deepEqual(c.action, { do: 'load', model: 'tiny', mode: 'here', devices: [] });
  assert.doesNotMatch(c.why, /fetch/);
});

test('memory dropped here and only a model not here fits: the warning says it is fetched first', () => {
  const away = model({ id: 'away', name: 'Away', file: 'a.gguf', size: 3e9, needMb: 4500, here: false });
  const c = tightHere([away]);
  assert.ok(c, 'no tight card');
  assert.deepEqual(c.action, { do: 'load', model: 'away', mode: 'here', devices: [] });
  assert.match(c.why, /Away \(4\.4 GB\) fits; it is fetched first \(2\.8 GB\)/);
});
