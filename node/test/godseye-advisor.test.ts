// god's eye, the advisor branch (src/godseye/branches/advisor.ts): which model, which devices,
// which night, from hand-made snapshots. It only suggests; it says a new top once it holds.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-advisor-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye } = await import('../src/godseye/index.ts');
const { create } = await import('../src/godseye/branches/advisor.ts');

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 4000, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const model = (id: string, needMb: number, o: Record<string, unknown> = {}) => ({
  id, name: id, file: `${id}.gguf`, size: needMb * 900_000, quant: 'Q4_K_M', params_b: null, catalog: true, here: false, needMb, ...o,
});
const NOON = new Date(2026, 10, 8, 12, 0).getTime();
const EVENING = new Date(2026, 10, 8, 21, 0).getTime();
const snap = (o: Record<string, any> = {}): any => ({
  at: NOON, host: { name: 'mac', freeMb: 4000 },
  devices: [dev(), dev({ id: 'p2', name: 'galaxy' })],
  models: [model('Qwen3 4B', 2500), model('Big 14B', 9000), model('Tiny 0.6B', 800)],
  projects: [],
  ...o,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: false, ...(o.work ?? {}) },
});

/** one branch, a fake ctx */
function branch(peeks: Record<string, any> = {}) {
  const fed: string[] = [];
  let notes: unknown = null;
  const b = create({
    now: () => 0,
    load: <T,>(fb: T): T => (notes as T) ?? fb,
    save: (d: unknown) => { notes = d; },
    emit: (t: string) => { fed.push(t); },
    peek: (id: string) => peeks[id] ?? null,
  } as any);
  const look = (s: any) => { b.observe(s, null); return b.view(); };
  return { look, fed, notes: () => notes };
}

test('two phones that each fit the same model: apart with it, 2× the answers; the biggest model nobody fits is left out', () => {
  const v = branch().look(snap());
  assert.equal(v.built, true);
  assert.equal(v.stat, 'try Qwen3 4B apart on 2 devices');
  assert.match(v.lines[0], /Qwen3 4B apart on pixel and galaxy: .*2× the answers at once/);
  assert.ok(!v.lines.some((l) => /Big 14B/.test(l)), 'no split without this computer');
  assert.equal(v.gauge, 0);
  assert.deepEqual(v.rows[0], ['pixel', 'Qwen3 4B · 2.4 GB of 2.9 GB']);
});

test('one model per device: the biggest whose need fits 75% of its free memory; an unreachable or pairing device does not count', () => {
  const v = branch().look(snap({ devices: [dev({ ramMb: 6000 }), dev({ id: 'p2', name: 'galaxy', ramMb: 2000 }), dev({ id: 'p3', name: 'old', reachable: false }), dev({ id: 'p4', name: 'new', waitingPair: true })] }));
  assert.equal(v.stat, 'try Qwen3 4B on pixel');
  assert.deepEqual(v.rows.map((r) => r[0]), ['pixel', 'galaxy']);
  assert.match(v.rows[1][1], /^Tiny 0.6B/);
  assert.match(v.lines[1], /^Tiny 0.6B apart on pixel and galaxy/, 'the biggest that both fit comes second');
});

test('split only for a clearly bigger model that fits nowhere alone but fits all together, led by this computer; it says slower per answer', () => {
  const s = snap({ host: { name: 'mac', freeMb: 6000 }, devices: [dev({ ramMb: 4000 }), dev({ id: 'p2', name: 'galaxy', ramMb: 4000 })], work: { llama: true } });
  const v = branch().look(s);
  const split = v.lines.find((l) => /split/.test(l));
  assert.match(split!, /Big 14B split across pixel, galaxy and this computer: fits no device alone .*slower per answer/);
  // only a little bigger than what fits alone: no split
  const v2 = branch().look({ ...s, models: [model('Qwen3 4B', 2500), model('Mid', 3200)] });
  assert.ok(!v2.lines.some((l) => /split/.test(l)));
  // a relay device is never part of a split
  const v3 = branch().look({ ...s, devices: [dev(), dev({ id: 'p2', name: 'galaxy', via: 'relay' })] });
  assert.ok(!v3.lines.some((l) => /split/.test(l)), 'pixel + this computer alone do not hold 9 GB');
});

test('this computer joins apart only with the file here; it runs a catalog model alone too', () => {
  const s = snap({ host: { name: 'mac', freeMb: 20000 }, devices: [dev()], work: { llama: true } });
  let v = branch().look(s);
  assert.equal(v.stat, 'try Big 14B here');
  assert.ok(!v.lines.some((l) => /apart/.test(l)), 'Qwen3 4B is not on this computer');
  v = branch().look({ ...s, models: [model('Qwen3 4B', 2500, { here: true }), model('Big 14B', 9000)] });
  assert.match(v.lines.join('\n'), /Qwen3 4B apart on pixel and this computer/);
});

test('what is loaded vs the suggestion: an idle device the model fits, a bigger model that fits; the gauge is the share of memory in use', () => {
  const loaded = (id: string, devices: any[], mode = 'phone') => ({ mode, model: { id, name: id, file: `${id}.gguf`, size: 1 }, ctx: 4096, since: NOON, devices });
  let v = branch().look(snap({ work: { loaded: loaded('Qwen3 4B', [{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 9, done: 3 }]) } }));
  assert.equal(v.stat, 'add 1 device apart');
  assert.match(v.lines[0], /galaxy is reachable and idle and Qwen3 4B fits it/);
  assert.equal(v.gauge, Math.round((2500 / 8000) * 100));

  v = branch().look(snap({ work: { loaded: loaded('Tiny 0.6B', [{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 9, done: 3 }, { id: 'p2', name: 'galaxy', local: false, busy: false, tps: 9, done: 3 }], 'apart') } }));
  assert.equal(v.stat, 'a bigger model fits: Qwen3 4B');
  assert.equal(v.gauge, Math.round((1600 / 8000) * 100));

  v = branch().look(snap({ work: { loaded: loaded('Qwen3 4B', [{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 9, done: 3 }, { id: 'p2', name: 'galaxy', local: false, busy: false, tps: 9, done: 3 }], 'apart') } }));
  assert.equal(v.stat, 'keep Qwen3 4B as it is');
});

test('night: a waiting project whose device is gone or whose model does not fit comes first; a ready one is said; in the evening one is suggested', () => {
  const proj = (o: Record<string, unknown> = {}) => ({ id: 'n1', title: 'essay', request: 'write', start: new Date(2026, 10, 8, 23, 0).getTime(), end: new Date(2026, 10, 9, 6, 0).getTime(), state: 'waiting', mode: 'apart', model: 'Qwen3 4B', peers: ['p1', 'p2'], ...o });
  let v = branch().look(snap({ projects: [proj({ peers: ['p1', 'p3'] })] }));
  assert.equal(v.stat, 'night project: p3 not reachable now');
  v = branch().look(snap({ projects: [proj({ model: 'Big 14B' })] }));
  assert.match(v.stat, /night project: Big 14B needs about 8.8 GB, pixel offers 2.9 GB/);
  v = branch().look(snap({ projects: [proj()] }));
  assert.equal(v.stat, 'try Qwen3 4B apart on 2 devices');
  assert.match(v.lines[1], /night project essay at 23:00: its 2 devices answer now and Qwen3 4B fits/);

  v = branch().look(snap({ at: EVENING }));
  assert.match(v.lines.join('\n'), /it is evening and the devices are idle: plan a night project, with Qwen3 4B apart on pixel and galaxy/);
  v = branch().look(snap());
  assert.ok(!v.lines.some((l) => /evening/.test(l)));
});

test('the others are quoted when lit, never needed', () => {
  const v = branch({ forecast: { built: true, stat: 'pixel free at 23:00' }, limits: { built: false, stat: 'not built yet' } }).look(snap());
  assert.ok(v.lines.includes('forecast says: pixel free at 23:00'));
  assert.ok(!v.lines.some((l) => /limits says/.test(l)));
});

test('a feed line only when the top suggestion changes and holds a second look; remembered across a restart', () => {
  const dir = path.join(HOME, 'eye');
  let s = snap();
  const eye = new GodsEye({ snapshot: () => s, dir });
  const said = () => eye.view().events.filter((e) => e.branch === 'advisor').map((e) => e.text);
  eye.tick();
  assert.deepEqual(said(), []);
  eye.tick();
  eye.tick();
  eye.tick();
  assert.equal(said().length, 1);
  assert.match(said()[0], /^advisor: Qwen3 4B apart on pixel and galaxy/);
  assert.equal(eye.view().branches.find((b) => b.id === 'advisor')!.built, true);

  s = snap({ devices: [dev()] });             // galaxy left for one look only
  eye.tick();
  s = snap();
  eye.tick();
  eye.tick();
  assert.equal(said().length, 1);

  s = snap({ devices: [dev()] });
  eye.tick();
  eye.tick();
  assert.equal(said().length, 2);
  assert.match(said()[0], /^advisor: Qwen3 4B on pixel/);
  const notes = JSON.parse(fs.readFileSync(path.join(dir, 'advisor.json'), 'utf8'));
  assert.ok(JSON.stringify(notes).length < 200);

  const again = new GodsEye({ snapshot: () => s, dir });
  again.tick();
  again.tick();
  assert.equal(again.view().events.filter((e) => e.branch === 'advisor').length, 0);
});
