// god's eye, the deciding branches as suggestion makers (11.11.2026): planner, executor and models
// from hand-made looks. Each card only on real evidence, steady over noisy looks, and every card
// one the eye accepts (cleanCard). The eye never acts: the cards only carry what a tap would ask.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-decide-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye, cleanCard } = await import('../src/godseye/index.ts');
const planner = await import('../src/godseye/branches/planner.ts');
const executor = await import('../src/godseye/branches/executor.ts');
const models = await import('../src/godseye/branches/models.ts');
const decide = await import('../src/godseye/branches/decide.ts');

const GB = 1024 * 1024 * 1024;
const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 6000, bwGBs: null, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null, ...o,
});
const model = (id: string, name: string, needMb: number, size: number, o: Record<string, unknown> = {}) => ({
  id, name, file: `${id}.gguf`, size, quant: 'Q4_K_M', params_b: null, catalog: true, here: false, needMb, ...o,
});
const QWEN17 = model('qwen3-1.7b', 'Qwen3 1.7B', 1800, 1.1 * GB);
const GEMMA = model('gemma3-4b', 'Gemma 3 4B', 3400, 2.5 * GB);
const BIG = model('qwen3-14b', 'Qwen3 14B', 9500, 8.4 * GB);
const TINY = model('qwen3-0.6b', 'Qwen3 0.6B', 800, 0.45 * GB, { here: true });
const SMOLVLM = model('smolvlm-500m', 'SmolVLM 500M', 900, 0.5 * GB, { vision: true });
const AT = new Date(2026, 10, 11, 15, 0).getTime();
const snap = (o: Record<string, any> = {}): any => ({
  at: AT, host: { name: 'mac', freeMb: 8000 },
  devices: [dev(), dev({ id: 'p2', name: 'galaxy' })],
  models: [QWEN17, GEMMA, BIG, TINY],
  projects: [],
  ...o,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...(o.work ?? {}) },
});
const loaded = (m: any, mode: string, devices: any[], o: Record<string, unknown> = {}) => ({ mode, model: { id: m.id, name: m.name, file: m.file, size: m.size }, ctx: 4096, since: AT - 60_000, devices, ...o });
const here = (tps: number | null, done = 3, busy = false) => ({ id: 'local', name: 'this computer', local: true, busy, tps, done });
const on = (id: string, name: string, tps: number | null, done = 3, busy = false) => ({ id, name, local: false, busy, tps, done });

/** one branch with a fake ctx: peeks are the other branches' views, notes start as given */
function branch(make: any, peeks: Record<string, any> = {}, notes: unknown = null) {
  const fed: string[] = [];
  let kept: unknown = notes;
  const b = make({
    now: () => 0,
    load: <T,>(fb: T): T => (kept as T) ?? fb,
    save: (d: unknown) => { kept = structuredClone(d); },
    emit: (t: string) => { fed.push(t); },
    peek: (id: string) => peeks[id] ?? null,
  });
  /** n looks at the same snapshot (or one per call of a function), the view after the last */
  const look = (s: any, n = decide.SHOW) => { for (let i = 0; i < n; i++) b.observe(typeof s === 'function' ? s(i) : s, null); return b.view(); };
  return { look, fed, notes: () => kept, peeks };
}
const ids = (v: any) => (v.suggestions ?? []).map((c: any) => c.id);
/** every card a branch shows is one the eye takes as it is, under that branch's name */
function accepted(v: any, id: string) {
  for (const c of v.suggestions ?? []) {
    assert.ok(c.id.startsWith(`${id}:`), c.id);
    const clean = cleanCard(c);
    assert.ok(clean, `the eye drops ${c.id}`);
    assert.deepEqual(clean!.action, c.action);
  }
}
/** a small seeded noise, the same every run */
function noise(seed = 7) { let x = seed; return (amp: number) => { x = (x * 1103515245 + 12345) % 2147483648; return 1 + ((x / 2147483648) * 2 - 1) * amp; }; }

// ---- planner

test('planner: split over the mac and a faster tablet beats the mac alone, both speeds known: a load split card', () => {
  const tablet = dev({ id: 't1', name: 'tablet', kind: 'phone', via: 'cable', ramMb: 3000, bwGBs: 70 });
  const s = snap({ host: { name: 'mac', freeMb: 4600 }, devices: [tablet], work: { loaded: loaded(GEMMA, 'here', [here(8.8)]) } });
  const { look } = branch(planner.create);
  const v = look(s);
  const c = v.suggestions.find((x: any) => x.id === 'planner:split:gemma3-4b');
  assert.ok(c, ids(v).join());
  assert.match(c.title, /^Gemma 3 4B would run faster split over mac and tablet: ~1\d(\.\d)? tok\/s; alone here on mac ~8\.8$/);
  assert.deepEqual(c.action, { do: 'load', model: 'gemma3-4b', mode: 'split', devices: ['t1'] });
  assert.match(c.why, /estimated from memory bandwidth/);
  accepted(v, 'planner');
  assert.match(v.stat, /^here · Gemma 3 4B · 1 idea$/);
  assert.ok(v.rows.some(([k, x]: string[]) => k === 'mac' && /GB\/s measured/.test(x)));
  assert.ok(v.hints.some((h: any) => h.id === 'local' && h.tps[0].file === 'gemma3-4b.gguf'), 'the speeds go to the others');
});

test('planner: a model that fits no place alone but this computer and a device together: fits only split, speed not measured yet', () => {
  const s = snap({ host: { name: 'mac', freeMb: 9000 }, devices: [dev({ ramMb: 6000 })], models: [BIG] });
  const { look } = branch(planner.create, {}, { v: 1, last: 'qwen3-14b', speeds: {} });
  const v = look(s);
  const c = v.suggestions.find((x: any) => x.id === 'planner:split:qwen3-14b');
  assert.match(c.title, /^Qwen3 14B fits only split: mac and pixel together hold it$/);
  assert.match(c.why, /speed not measured yet/);
  assert.deepEqual(c.action, { do: 'load', model: 'qwen3-14b', mode: 'split', devices: ['p1'] });
  assert.ok(!/tok\/s/.test(c.title), 'no number without a measurement');
  assert.equal(v.note, 'suggestions only: a tap asks kula to load; the planner never does.');
});

test('planner: loaded on one phone while two hold it: apart answers two at once; a device limits or trust says no to is never suggested', () => {
  const s = snap({ work: { loaded: loaded(GEMMA, 'phone', [on('p1', 'pixel', 9)]), llama: false } });
  let v = branch(planner.create).look(s);
  const c = v.suggestions.find((x: any) => x.id === 'planner:apart:gemma3-4b');
  assert.match(c.title, /^apart would answer 2 at once: pixel and galaxy each hold Gemma 3 4B$/);
  assert.deepEqual(c.action, { do: 'load', model: 'gemma3-4b', mode: 'apart', devices: ['p1', 'p2'] });
  accepted(v, 'planner');

  v = branch(planner.create, { limits: { hints: [{ id: 'p2', no: 'should rest (limits)' }] } }).look(s);
  assert.deepEqual(ids(v), [], 'galaxy should rest: one place left, no apart');
  assert.ok(v.lines.includes('galaxy left out: should rest (limits)'));
  const bad = { report: { devices: [{ id: 'p2', name: 'galaxy', verdict: 'bad', checks: [{ k: 'cert', ok: false, text: 'the certificate is not the pinned one' }], refused: '', accept: false }] } };
  v = branch(planner.create, { trust: bad }).look(s);
  assert.deepEqual(ids(v), []);
  assert.ok(v.lines.some((l: string) => /galaxy left out: trust says no: the certificate is not the pinned one/.test(l)));
});

test('planner: split while the mac alone is clearly faster: a warning with the load that fixes it; unknown speeds say nothing', () => {
  const s = snap({ host: { name: 'mac', freeMb: 6000 }, devices: [dev({ ramMb: 3000 })], work: { loaded: loaded(GEMMA, 'split', [here(4, 5)], { parts: [{ id: 'local', name: 'this computer', local: true, mb: 2000, layers: 20 }, { id: 'p1', name: 'pixel', local: false, mb: 1400, layers: 14 }] }) } });
  // the mac answered Gemma at 12 tok/s when it ran it alone (the planner's notes)
  const { look } = branch(planner.create, {}, { v: 1, last: 'gemma3-4b', speeds: { local: { 'gemma3-4b.gguf': { tps: 12, n: 6 } } } });
  const v = look(s);
  const c = v.suggestions.find((x: any) => x.id === 'planner:alone:gemma3-4b');
  assert.equal(c.kind, 'warn');
  assert.equal(c.title, 'split is slower than mac alone for Gemma 3 4B');
  assert.match(c.why, /^split answers at 4 tok\/s \(measured\); here on mac alone it would at ~12/);
  assert.deepEqual(c.action, { do: 'load', model: 'gemma3-4b', mode: 'here', devices: [] });
  // the split's own tok/s never becomes the mac's speed
  assert.deepEqual(look(s, 1).hints, [{ id: 'local', tps: [{ file: 'gemma3-4b.gguf', tps: 12, n: 6 }] }]);
  // no speed for the mac: nothing to compare, no card
  assert.deepEqual(ids(branch(planner.create).look(s)), []);
});

test('planner: thin evidence gives no card: nothing loaded before, a device without its free memory, a model still loading', () => {
  assert.deepEqual(ids(branch(planner.create).look(snap())), []);
  const v = branch(planner.create).look(snap());
  assert.equal(v.stat, 'nothing planned');
  assert.match(v.note, /once a model ran, the planner says where it sits best/);
  const s = snap({ devices: [dev({ ramMb: null }), dev({ id: 'p2', name: 'galaxy', ramMb: null })], work: { loaded: loaded(GEMMA, 'phone', [on('p1', 'pixel', 9)]), llama: false } });
  assert.deepEqual(ids(branch(planner.create).look(s)), [], 'no free memory known: no apart');
  const loading = snap({ work: { loading: { mode: 'apart', model: 'Gemma 3 4B', since: AT, line: 'downloading' } } });
  assert.deepEqual(ids(branch(planner.create, {}, { v: 1, last: 'gemma3-4b', speeds: {} }).look(loading)), []);
});

test('planner: a card needs three looks to show and four to go', () => {
  const s = snap({ work: { loaded: loaded(GEMMA, 'phone', [on('p1', 'pixel', 9)]), llama: false } });
  const { look } = branch(planner.create);
  assert.deepEqual(ids(look(s, 2)), []);
  assert.deepEqual(ids(look(s, 1)), ['planner:apart:gemma3-4b']);
  const gone = { ...s, devices: [dev()] };
  assert.deepEqual(ids(look(gone, 3)), ['planner:apart:gemma3-4b'], 'still there after three looks without its reason');
  assert.deepEqual(ids(look(gone, 1)), []);
});

test('planner: no flapping over 50 noisy looks: memory hovering at the fit line and a noisy tok/s', () => {
  const n = noise();
  const tablet = dev({ id: 't1', name: 'tablet', kind: 'phone', via: 'cable', ramMb: 3000, bwGBs: 70 });
  // galaxy's free memory hovers right where Gemma fits it (3400 / 0.75 = 4533 MB), the mac's tok/s ±10%
  const s = (i: number) => snap({
    host: { name: 'mac', freeMb: Math.round(4600 * n(0.04)) },
    devices: [dev({ ramMb: Math.round(4533 * n(0.03)) }), dev({ id: 'p2', name: 'galaxy', ramMb: Math.round(4533 * n(0.03)) }), tablet],
    work: { loaded: loaded(GEMMA, 'here', [here(Math.round(88 * n(0.1)) / 10, 3 + i)]) },
  });
  const { look } = branch(planner.create);
  const seen: string[][] = [];
  for (let i = 0; i < 50; i++) seen.push(ids(look(s(i), 1)).sort());
  for (const id of new Set(seen.flat())) {
    const flips = seen.slice(1).filter((x, i) => x.includes(id) !== seen[i].includes(id)).length;
    assert.ok(flips <= 1, `${id} flipped ${flips} times`);
  }
  assert.ok(seen[49].includes('planner:split:gemma3-4b'));
});

// ---- executor

test('executor: in apart mode a device at under a third of the fastest one\'s tok/s: leave it out; too few answers say nothing', () => {
  const s = snap({ work: { loaded: loaded(GEMMA, 'apart', [here(14, 6), on('p1', 'pixel', 12, 5), on('p2', 'galaxy', 3, 3)]) } });
  const v = branch(executor.create).look(s);
  const c = v.suggestions.find((x: any) => x.id === 'executor:slow:p2');
  assert.equal(c.title, 'galaxy answers at ~3 tok/s, this computer at ~14');
  assert.deepEqual(c.action, { do: 'load', model: 'gemma3-4b', mode: 'apart', devices: ['p1'] });
  assert.match(c.why, /about 5× longer/);
  accepted(v, 'executor');
  const thin = snap({ work: { loaded: loaded(GEMMA, 'apart', [on('p1', 'pixel', 12, 5), on('p2', 'galaxy', 3, 1)]) } });
  assert.deepEqual(ids(branch(executor.create).look(thin)), [], 'one answer is not a speed yet');
  assert.deepEqual(ids(branch(executor.create).look({ ...s, work: { ...s.work, loaded: { ...s.work.loaded, mode: 'phone', devices: [on('p2', 'galaxy', 3, 3)] } } })), []);
});

test('executor: a device that keeps dropping out gets a look-again card; one failed check is not enough', () => {
  const s = (i: number) => snap({
    devices: [dev({ checkedAt: 100 + i, reachable: i % 2 === 0, reason: i % 2 === 0 ? null : 'timed out' }), dev({ id: 'p2', name: 'galaxy', checkedAt: 100 + i })],
    work: { loaded: loaded(GEMMA, 'apart', [on('p1', 'pixel', 9), on('p2', 'galaxy', 9)]) },
  });
  const { look } = branch(executor.create);
  let v = look(s, 3);
  assert.deepEqual(ids(v), [], 'one failure among three checks');
  v = look((i: number) => s(i + 3), 6);
  const c = v.suggestions.find((x: any) => x.id === 'executor:failing:p1');
  assert.equal(c.title, 'pixel keeps dropping out');
  assert.match(c.why, /^\d of its last \d+ checks found it unreachable \(last: timed out\)/);
  assert.deepEqual(c.action, { do: 'probe', devices: ['p1'] });
  assert.ok(v.lines.some((l: string) => /^pixel · .* checks failed$/.test(l)));
  accepted(v, 'executor');
});

test('executor: a device idle for two minutes while another answered: look again; a short window says nothing', () => {
  const s = (i: number) => snap({ work: { chatting: 1, loaded: loaded(GEMMA, 'apart', [on('p1', 'pixel', 9, 10 + i, i % 5 !== 0), on('p2', 'galaxy', 4, 2, false)]) } });
  const { look } = branch(executor.create);
  assert.deepEqual(ids(look(s, 20)), [], 'twenty looks are not a window yet');
  const v = look((i: number) => s(20 + i), 10);
  const c = v.suggestions.find((x: any) => x.id === 'executor:idle:p2');
  assert.equal(c.title, 'galaxy waited while pixel answered');
  assert.deepEqual(c.action, { do: 'probe', devices: ['p2'] });
  accepted(v, 'executor');
});

test('executor: limits says a device should rest: leave it out in apart, the limits page otherwise', () => {
  const peeks = { limits: { hints: [{ id: 'p2', no: 'should rest (limits)' }] } };
  let v = branch(executor.create, peeks).look(snap({ work: { loaded: loaded(GEMMA, 'apart', [on('p1', 'pixel', 9), on('p2', 'galaxy', 9)]) } }));
  let c = v.suggestions.find((x: any) => x.id === 'executor:rest:p2');
  assert.equal(c.title, 'galaxy should rest (limits)');
  assert.equal(c.weight, 3);
  assert.deepEqual(c.action, { do: 'load', model: 'gemma3-4b', mode: 'apart', devices: ['p1'] });
  v = branch(executor.create, peeks).look(snap({ work: { loaded: loaded(GEMMA, 'phone', [on('p2', 'galaxy', 9)]) } }));
  c = v.suggestions.find((x: any) => x.id === 'executor:rest:p2');
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'limits' });
  accepted(v, 'executor');
});

test('executor: no flapping over 50 looks of a tok/s hovering near a third', () => {
  const n = noise(3);
  const s = (i: number) => snap({ work: { loaded: loaded(GEMMA, 'apart', [on('p1', 'pixel', 12, 9), on('p2', 'galaxy', Math.round(40 * n(0.12)) / 10, 3 + (i >> 3))]) } });
  const { look } = branch(executor.create);
  const seen: boolean[] = [];
  for (let i = 0; i < 50; i++) seen.push(ids(look(s(i), 1)).includes('executor:slow:p2'));
  assert.ok(seen.slice(1).filter((x, i) => x !== seen[i]).length <= 1, seen.map(Number).join(''));
});

// ---- models

test('models: nothing loaded: the biggest model that fits a place; loaded: a clearly bigger one that fits the same places', () => {
  let v = branch(models.create).look(snap({ work: { llama: false } }));
  let c = v.suggestions.find((x: any) => x.id === 'models:pick:gemma3-4b');
  assert.equal(c.title, 'Gemma 3 4B is the biggest model that fits pixel');
  assert.deepEqual(c.action, { do: 'load', model: 'gemma3-4b', mode: 'phone', devices: ['p1'] });
  assert.match(c.why, /speed not measured yet/);
  // the planner already has a card for that model: no second one
  v = branch(models.create, { planner: { suggestions: [{ id: 'planner:apart:gemma3-4b' }] } }).look(snap({ work: { llama: false } }));
  assert.ok(!ids(v).includes('models:pick:gemma3-4b'));

  v = branch(models.create).look(snap({ work: { llama: false, loaded: loaded(QWEN17, 'apart', [on('p1', 'pixel', 18), on('p2', 'galaxy', 17)]) } }));
  c = v.suggestions.find((x: any) => x.id === 'models:bigger:gemma3-4b');
  assert.equal(c.title, 'Gemma 3 4B fits where Qwen3 1.7B runs now');
  assert.deepEqual(c.action, { do: 'load', model: 'gemma3-4b', mode: 'apart', devices: ['p1', 'p2'] });
  accepted(v, 'models');
  // galaxy has too little: Gemma does not fit every place, no card
  v = branch(models.create).look(snap({ devices: [dev(), dev({ id: 'p2', name: 'galaxy', ramMb: 3000 })], work: { llama: false, loaded: loaded(QWEN17, 'apart', [on('p1', 'pixel', 18), on('p2', 'galaxy', 17)]) } }));
  assert.deepEqual(ids(v), []);
});

test('models: a catalog model clearly bigger than anything here that fits this computer: fetch', () => {
  // pixel runs Qwen3 1.7B and has no room for more; the mac has
  const s = snap({ devices: [dev({ ramMb: 2600 })], host: { name: 'mac', freeMb: 7000 }, work: { loaded: loaded(QWEN17, 'phone', [on('p1', 'pixel', 15)]) } });
  const v = branch(models.create).look(s);
  const c = v.suggestions.find((x: any) => x.id === 'models:fetch:gemma3-4b');
  assert.equal(c.title, 'Gemma 3 4B would fit mac and is not here yet');
  assert.deepEqual(c.action, { do: 'fetch', model: 'gemma3-4b' });
  assert.match(c.why, /the biggest here is Qwen3 0.6B/);
  assert.ok(!ids(v).some((x: string) => x.startsWith('models:bigger')), 'pixel holds nothing bigger');
  accepted(v, 'models');
  // already here: nothing to fetch
  const v2 = branch(models.create).look({ ...s, models: [QWEN17, { ...GEMMA, here: true }, BIG, TINY] });
  assert.ok(!ids(v2).some((x: string) => x.startsWith('models:fetch')));
});

test('models: memory dropped since the load and the model no longer fits this computer: a smaller one; a small dip says nothing', () => {
  const at = (freeMb: number) => snap({ devices: [], host: { name: 'mac', freeMb }, models: [QWEN17, { ...GEMMA, here: true }, BIG, TINY], work: { loaded: loaded(GEMMA, 'here', [here(9)]) } });
  const { look } = branch(models.create);
  look(at(6000), 1);                          // at load: 6000 free + 3400 held
  assert.deepEqual(ids(look(at(5200))), [], 'a dip that still fits');
  const v = look(at(500));
  const c = v.suggestions.find((x: any) => x.id === 'models:tight:local');
  assert.equal(c.kind, 'warn');
  assert.equal(c.title, 'Gemma 3 4B no longer fits mac: 3.8 GB free now, 9.2 GB when it loaded');
  assert.deepEqual(c.action, { do: 'load', model: 'qwen3-1.7b', mode: 'here', devices: [] });
  accepted(v, 'models');
});

test('models: photos that nothing here could see: fetch the smallest model that sees photos; none without such photos', () => {
  const s = (photos: any, list = [QWEN17, GEMMA, SMOLVLM]) => snap({ devices: [], models: list, work: { photos } });
  let v = branch(models.create).look(s({ n: 2, unseen: 1, at: AT - 60_000 }));
  const c = v.suggestions.find((x: any) => x.id === 'models:vision:smolvlm-500m');
  assert.match(c.title, /^photos came but nothing here sees them: fetch SmolVLM 500M/);
  assert.deepEqual(c.action, { do: 'fetch', model: 'smolvlm-500m' });
  assert.equal(c.weight, 3);
  accepted(v, 'models');
  v = branch(models.create).look(s({ n: 2, unseen: 0, at: AT - 60_000 }));
  assert.ok(!ids(v).some((x: string) => x.startsWith('models:vision')));
  v = branch(models.create).look(s({ n: 2, unseen: 1, at: AT - 60_000 }, [QWEN17, GEMMA, { ...SMOLVLM, here: true }]));
  assert.ok(!ids(v).some((x: string) => x.startsWith('models:vision')), 'one is here already');
  v = branch(models.create).look(s(undefined));
  assert.ok(!ids(v).some((x: string) => x.startsWith('models:vision')), 'no photo count: no evidence');
  // remembered across a restart, a week at most
  const b = branch(models.create);
  b.look(s({ n: 1, unseen: 1, at: AT - 60_000 }));
  const again = branch(models.create, {}, b.notes()).look(s({ n: 0, unseen: 0, at: null }));
  assert.ok(ids(again).includes('models:vision:smolvlm-500m'));
  const later = branch(models.create, {}, b.notes()).look({ ...s({ n: 0, unseen: 0, at: null }), at: AT + 8 * 24 * 3600_000 });
  assert.ok(!ids(later).includes('models:vision:smolvlm-500m'));
});

// ---- the whole eye

test('field: a stranger\'s device (world) is barred, never a seat; home, circle and no ring stay seats', () => {
  const s = snap({ devices: [
    dev({ id: 'w1', name: 'stranger', ring: 'world' }),
    dev({ id: 'w2', name: 'odd ring', ring: 'nearby' }),   // a ring word kula does not know is treated as world
    dev({ id: 'h1', name: 'mine', ring: 'home' }),
    dev({ id: 'c1', name: 'friend', ring: 'circle' }),
    dev({ id: 'n1', name: 'old pairing' }),
  ] });
  const f = decide.field(s, { peek: () => null });
  const seats = f.seats.map((x: any) => x.id);
  assert.ok(!seats.includes('w1') && !seats.includes('w2'), seats.join());
  for (const id of ['h1', 'c1', 'n1', 'local']) assert.ok(seats.includes(id), id);
  assert.deepEqual(f.barred.filter((x: any) => x.id === 'w1' || x.id === 'w2').map((x: any) => x.why), ["a stranger's device (world)", "a stranger's device (world)"]);
  // a split over the strangers' phones is never suggested: only world devices besides this computer
  const only = snap({ host: { name: 'mac', freeMb: 4600 }, devices: [dev({ id: 'w1', name: 'stranger', ring: 'world', ramMb: 6000, bwGBs: 70 })], work: { loaded: loaded(GEMMA, 'here', [here(8.8, 3)]) } });
  assert.deepEqual(decide.field(only, { peek: () => null }).seats.map((x: any) => x.id), ['local']);
});

test('the eye with the real branches: cards from planner, executor and models reach the panel, each accepted; the eye loads nothing', () => {
  const tablet = dev({ id: 't1', name: 'tablet', kind: 'phone', via: 'cable', ramMb: 3000, bwGBs: 70 });
  let i = 0;
  const s = () => snap({ host: { name: 'mac', freeMb: 4600 }, devices: [tablet], work: { loaded: loaded(GEMMA, 'here', [here(8.8, 3 + i++)]), photos: { n: 1, unseen: 1, at: AT } }, models: [QWEN17, GEMMA, BIG, TINY, SMOLVLM] });
  const eye = new GodsEye({ snapshot: s, dir: path.join(HOME, 'eye') });
  for (let k = 0; k < 8; k++) eye.tick();
  const cards = eye.view().cards;
  const got = cards.map((c) => c.id);
  assert.ok(got.includes('planner:split:gemma3-4b'), got.join());
  assert.ok(got.includes('models:vision:smolvlm-500m'), got.join());
  for (const c of cards) assert.ok(cleanCard(c));
  // the view carries no hints (they are for the branches, through peek)
  assert.ok(eye.view().branches.every((b) => !('hints' in b)));
  // the advisor points at the one to do first, under its own id
  assert.ok(got.some((x) => x.startsWith('advisor:first:')), got.join());
});
