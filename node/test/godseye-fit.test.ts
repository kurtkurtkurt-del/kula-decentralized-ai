// god's eye, the one fit (src/godseye/branches/fit.ts, P39): which devices a night project would use
// and whether its model fits them under kula's engine shares (LOCAL_SHARE 0.7 of this computer,
// WORKER_SHARE 0.75 of a device). review and the advisor both read it (F1, F2, F6).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { projectDevices, projectFit, implicit } = await import('../src/godseye/branches/fit.ts');
const review = await import('../src/godseye/branches/review.ts');

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 6000, bwGBs: null, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const model = (o: Record<string, unknown> = {}) => ({ id: 'big', name: 'Big', file: 'big.gguf', size: 1e9, quant: 'Q4_K_M', params_b: 1, catalog: true, here: true, needMb: 8700, ...o });
const snap = (o: Record<string, any> = {}): any => ({
  at: 1_000_000, host: { name: 'mac', freeMb: 4000 }, devices: [], models: [], projects: [], ...o,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...(o.work ?? {}) },
});
const project = (o: Record<string, unknown> = {}): any => ({
  id: 'n1', title: 'night run', request: 'summarise the notes of the week', start: 2_000_000, end: 3_000_000,
  state: 'waiting', mode: 'split', model: 'big', peers: ['p1'], ...o,
});

test('f1 split: 4000*0.7 + 6000*0.75 = 7300 < 8700, the engine would throw TooBig', () => {
  const s = snap({ devices: [dev()] });
  const f = projectFit(s, project(), model());
  assert.equal(f.fits, false);
  assert.deepEqual(f.counted.map((c: any) => [c.device.id, c.capMb]), [['p1', 4500]]);
  assert.deepEqual(f.gone, []);
  assert.deepEqual(f.problems, ['Big needs about 8.5 GB, together they offer 7.1 GB']);   // 7300 MB
});

test('f1 here: 6000*0.7 = 4200 < 5000; without llama it cannot run here at all', () => {
  const m = model({ needMb: 5000 });
  const p = project({ mode: 'here', peers: [] });
  let f = projectFit(snap({ host: { name: 'mac', freeMb: 6000 } }), p, m);
  assert.equal(f.fits, false);
  assert.deepEqual(f.problems, ['Big needs about 4.9 GB, this computer has 4.1 GB to spare']);   // 4200 MB
  f = projectFit(snap({ host: { name: 'mac', freeMb: 6000 }, work: { llama: false } }), p, m);
  assert.equal(f.fits, false);
  assert.deepEqual(f.problems, ['this computer cannot run a model itself']);
  assert.equal(projectFit(snap({ host: { name: 'mac', freeMb: null } }), p, m).fits, null, 'free memory here not known: no word');
});

test('f2: a split device away now but expected by the start counts with its memory, and is not gone', () => {
  const s = snap({ devices: [dev(), dev({ id: 'p2', name: 'tab', reachable: false, reason: 'no answer' })] });
  const p = project({ peers: ['p1', 'p2'] });
  const m = model({ needMb: 9000 });
  let f = projectFit(s, p, m, new Set(['p2']));
  assert.equal(f.fits, true);   // 2800 + 4500 + 4500 = 11800
  assert.deepEqual(f.gone, []);
  assert.deepEqual(f.problems, []);
  f = projectFit(s, p, m);
  assert.deepEqual(f.gone, ['p2']);
  assert.equal(f.fits, false);  // 7300
  // a chosen device gone from the book is gone too
  assert.deepEqual(projectFit(s, project({ peers: ['p1', 'x9'] }), m).gone, ['x9']);
});

test('f6: apart with none chosen runs on every device; one line only when no place holds it', () => {
  const s = snap({ devices: [dev(), dev({ id: 'p2', name: 'tab' })] });
  const p = project({ mode: 'apart', peers: [] });
  assert.equal(implicit(p), true);
  let f = projectFit(s, p, model({ needMb: 9000 }));
  assert.equal(f.fits, false);   // 4500, 4500, here 2800
  assert.deepEqual(f.problems, ['Big needs about 8.8 GB, no device offers more than 4.4 GB']);
  assert.deepEqual(f.gone, [], 'never gone for an implicit list');
  f = projectFit(s, p, model({ needMb: 4000 }));
  assert.equal(f.fits, true);
  assert.deepEqual(f.problems, []);
  // with chosen devices: one problem per counted device that cannot hold it, as before
  f = projectFit(snap({ devices: [dev(), dev({ id: 'p2', name: 'tab', ramMb: 2000 })] }), project({ mode: 'apart', peers: ['p1', 'p2'] }), model({ needMb: 4000 }));
  assert.equal(f.fits, true);
  assert.deepEqual(f.problems, ['Big needs about 3.9 GB, tab offers 1.5 GB']);
});

test('phone and split with no device chosen: "no device chosen"; phone with none counted has no fit', () => {
  const s = snap({ devices: [dev()] });
  const f = projectFit(s, project({ mode: 'phone', peers: [] }), model({ needMb: 1000 }));
  assert.equal(f.fits, null);
  assert.deepEqual(f.problems, ['no device chosen']);
  assert.deepEqual(projectFit(s, project({ mode: 'split', peers: [] }), model({ needMb: 1000 })).problems, ['no device chosen']);
});

test('a chosen device not looked at yet (reachable null): the fit is not known, never false', () => {
  const s = snap({ devices: [dev({ reachable: null })] });
  const f = projectFit(s, project(), model());
  assert.equal(f.fits, null);
  assert.deepEqual(f.problems, []);
  // beside a counted device that alone is too small: still not known
  assert.equal(projectFit(snap({ devices: [dev({ ramMb: 1000 }), dev({ id: 'p2', name: 'tab', reachable: null })] }), project({ peers: ['p1', 'p2'] }), model()).fits, null);
  assert.equal(projectFit(snap({ devices: [dev({ ramMb: 1000 }), dev({ id: 'p2', name: 'tab', reachable: null })] }), project({ mode: 'phone', peers: ['p1', 'p2'] }), model()).fits, null);
});

test('unknown memory on a split device: no word; heldHere is counted back (C2)', () => {
  assert.equal(projectFit(snap({ devices: [dev({ ramMb: null })] }), project(), model()).fits, null);
  assert.equal(projectFit(snap({ devices: [dev({ ramMb: 0 })] }), project(), model()).fits, null);
  // 3000 free + 6000 held by the chat model here: (9000)*0.7 = 6300 >= 4000
  const chat = { mode: 'here', model: { id: 'chat', name: 'Chat', file: 'chat.gguf', size: 5e9 }, ctx: 4096, since: 1, devices: [{ id: 'local', name: 'this computer', local: true, busy: false, tps: 10, done: 3 }] };
  const models = [model({ id: 'chat', name: 'Chat', needMb: 6000 }), model({ id: 'night', name: 'Night', needMb: 4000 })];
  const p = project({ mode: 'here', peers: [], model: 'night' });
  assert.equal(projectFit(snap({ host: { name: 'mac', freeMb: 3000 }, models, work: { loaded: chat } }), p, models[1]).fits, true);
  assert.equal(projectFit(snap({ host: { name: 'mac', freeMb: 3000 }, models }), p, models[1]).fits, false);   // 2100
});

test('fit.ts and review.ts name the same devices for the four modes', () => {
  const s = snap({ devices: [dev(), dev({ id: 'p2', name: 'tab' })] });
  const idsOf = (ds: any[]) => ds.map((d) => d?.id ?? null);
  for (const mode of ['here', 'phone', 'apart', 'split']) {
    for (const peers of [[], ['p2'], ['p1', 'gone']]) {
      const p = project({ mode, peers });
      assert.deepEqual(idsOf(projectDevices(p, s)), idsOf(review.projectDevices(p, s)), `${mode} ${JSON.stringify(peers)}`);
    }
  }
});
