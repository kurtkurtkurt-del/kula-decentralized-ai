// god's eye, the advisor branch (src/godseye/branches/advisor.ts): the one or two things worth
// doing first, from the other branches' views and the night projects. It only suggests; it says a
// new first card once in the feed, and remembers it across a restart.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-advisor-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye, cleanCard } = await import('../src/godseye/index.ts');
const { create, bestHour, nightProblems } = await import('../src/godseye/branches/advisor.ts');

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 4000, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const model = (id: string, needMb: number, o: Record<string, unknown> = {}) => ({
  id, name: id, file: `${id}.gguf`, size: needMb * 900_000, quant: 'Q4_K_M', params_b: null, catalog: true, here: false, needMb, ...o,
});
const NOON = new Date(2026, 10, 8, 12, 0).getTime();
const AFTERNOON = new Date(2026, 10, 8, 15, 0).getTime();
const LATE = new Date(2026, 10, 8, 23, 0).getTime();
const snap = (o: Record<string, any> = {}): any => ({
  at: NOON, host: { name: 'mac', freeMb: 4000 },
  devices: [dev(), dev({ id: 'p2', name: 'galaxy' }), dev({ id: 'p3', name: 'tablet' })],
  models: [model('Qwen3 4B', 2500), model('Big 14B', 9000), model('Tiny 0.6B', 800)],
  projects: [],
  ...o,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: false, ...(o.work ?? {}) },
});
const proj = (o: Record<string, unknown> = {}) => ({ id: 'n1', title: 'essay', request: 'write', start: new Date(2026, 10, 8, 23, 0).getTime(), end: new Date(2026, 10, 9, 6, 0).getTime(), state: 'waiting', mode: 'apart', model: 'Qwen3 4B', peers: ['p1', 'p2'], ...o });
// the forecast's word on tonight: the chance per hour 22..06
const night = (id: string, hours: number[], guess = 'likely') => ({ id, tonight: { guess, p: hours.reduce((a, b) => a + b, 0) / hours.length, hours } });
const FORECAST = { built: true, stat: '3 devices · tonight 3 likely', hints: [
  night('p1', [0.2, 0.5, 0.7, 0.8, 0.8, 0.8, 0.7, 0.5, 0.3]),
  night('p2', [0.1, 0.3, 0.5, 0.7, 0.9, 0.7, 0.6, 0.4, 0.2]),
  night('p3', [0.6, 0.6, 0.6, 0.65, 0.6, 0.6, 0.6, 0.6, 0.6]),
] };

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
  const look = (s: any, n = 3) => { for (let i = 0; i < n; i++) b.observe(s, null); return b.view(); };
  return { look, fed, notes: () => notes };
}
const ids = (v: any) => (v.suggestions ?? []).map((c: any) => c.id);
const accepted = (v: any) => { for (const c of v.suggestions ?? []) { assert.ok(c.id.startsWith('advisor:')); assert.ok(cleanCard(c), c.id); } };

test('tonight: the hour most devices are likely there, said in the afternoon; not late, not without the forecast, not with a project planned', () => {
  let v = branch({ forecast: FORECAST }).look(snap({ at: AFTERNOON }));
  const c = v.suggestions.find((x: any) => x.id === 'advisor:tonight');
  assert.equal(c.title, 'tonight 3 devices are likely free: plan the project for 02:00');
  assert.match(c.why, /pixel, galaxy and tablet there at 02:00/);
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'forecast' });
  assert.deepEqual(v.rows[0], ['tonight', '3 of 3 devices likely there tonight']);
  accepted(v);

  assert.deepEqual(ids(branch({ forecast: FORECAST }).look(snap({ at: LATE }))), [], 'the night is already here');
  v = branch({ forecast: { built: true, stat: 'still learning', hints: FORECAST.hints.map((h) => ({ ...h, tonight: { ...h.tonight, guess: 'unknown' } })) } }).look(snap({ at: AFTERNOON }));
  assert.deepEqual(ids(v), []);
  assert.deepEqual(v.rows[0], ['tonight', 'not measured yet: the forecast is still learning']);
  assert.deepEqual(ids(branch().look(snap({ at: AFTERNOON }))), [], 'no forecast at all');
  assert.ok(!ids(branch({ forecast: FORECAST }).look(snap({ at: AFTERNOON, projects: [proj()] }))).includes('advisor:tonight'));
  // only one device likely at any hour: not worth a plan
  assert.equal(bestHour(snap(), new Map([['p1', [0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7]]]))!.n, 1);
  assert.deepEqual(ids(branch({ forecast: { hints: [FORECAST.hints[0]] } }).look(snap({ at: AFTERNOON }))), []);
});

test('night: a waiting project whose device is gone or whose model does not fit is a warning; a ready one is a line', () => {
  let v = branch().look(snap({ devices: [dev(), dev({ id: 'p2', name: 'galaxy', reachable: false })], projects: [proj()] }));
  let c = v.suggestions.find((x: any) => x.id === 'advisor:night:n1');
  assert.equal(c.kind, 'warn');
  assert.equal(c.title, 'the night project at 23:00 would not start well: galaxy not reachable now');
  assert.deepEqual(c.action, { do: 'probe', devices: ['p2'] });
  accepted(v);
  v = branch().look(snap({ projects: [proj({ model: 'Big 14B' })] }));
  c = v.suggestions.find((x: any) => x.id === 'advisor:night:n1');
  assert.match(c.title, /Big 14B needs about 8.8 GB, pixel offers 2.9 GB/);
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'review' });
  v = branch().look(snap({ projects: [proj()] }));
  assert.deepEqual(ids(v), []);
  assert.ok(v.lines.some((l: string) => /night project essay at 23:00: its 2 devices answer now and Qwen3 4B fits/.test(l)));
});

test('first: of the others\' cards the one that matters most, said plainly, under the advisor\'s own id; one card alone needs no advice', () => {
  const planner = { built: true, stat: 'x', suggestions: [{ id: 'planner:split:Qwen3_4B', kind: 'suggest', weight: 2, title: 'Qwen3 4B would run faster split', why: 'w', action: { do: 'load', model: 'Qwen3 4B', mode: 'split', devices: ['p1'] } }] };
  const models = { built: true, stat: 'x', suggestions: [{ id: 'models:fetch:Big_14B', kind: 'suggest', weight: 1, title: 'Big 14B would fit mac', why: 'w', action: { do: 'fetch', model: 'Big 14B' } }] };
  const executor = { built: true, stat: 'x', suggestions: [{ id: 'executor:failing:p2', kind: 'warn', weight: 2, title: 'galaxy keeps dropping out', why: 'w', action: { do: 'probe', devices: ['p2'] } }] };
  let v = branch({ planner, models }).look(snap());
  let c = v.suggestions.find((x: any) => x.id.startsWith('advisor:first:'));
  assert.equal(c.id, 'advisor:first:planner:split:Qwen3_4B');
  assert.equal(c.title, 'first: load Qwen3 4B split on pixel');
  assert.match(c.why, /^of the 2 cards the brain shows now, this one matters most: Qwen3 4B would run faster split \(planner\)\. then: Big 14B would fit mac \(models\)\.$/);
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'planner' });
  accepted(v);
  // a warning of the same weight comes first
  v = branch({ planner, models, executor }).look(snap());
  c = v.suggestions.find((x: any) => x.id.startsWith('advisor:first:'));
  assert.equal(c.title, 'first: look at galaxy again');
  assert.ok(v.lines.includes('executor: galaxy keeps dropping out'));
  assert.deepEqual(ids(branch({ planner }).look(snap())), []);
  // a branch's card under another's name is not taken
  assert.deepEqual(ids(branch({ planner, models: { suggestions: [{ ...models.suggestions[0], id: 'planner:spoof' }] } }).look(snap())), []);
});

test('first: privacy before health before speed; a weight-1 privacy warning beats a weight-2 speed card (C5)', () => {
  const trust = { built: true, stat: 'x', suggestions: [{ id: 'trust:owner-blind:p1', kind: 'warn', weight: 1, title: 'pixel could read the jobs it runs', why: 'its bootloader is unlocked', action: { do: 'open', panel: 'branch', branch: 'trust' } }] };
  const planner = { built: true, stat: 'x', suggestions: [{ id: 'planner:alone:m', kind: 'warn', weight: 2, title: 'M answers faster on pixel alone', why: 'apart is slower', action: { do: 'load', model: 'm', mode: 'phone', devices: ['p1'] } }] };
  const limits = { built: true, stat: 'x', suggestions: [{ id: 'limits:hot:p1', kind: 'warn', weight: 1, title: 'pixel is hot', why: 'w', action: null }] };
  let v = branch({ trust, planner }).look(snap());
  let c = v.suggestions.find((x: any) => x.id.startsWith('advisor:first:'));
  assert.equal(c.id, 'advisor:first:trust:owner-blind:p1');
  assert.match(c.why, /this one matters most: pixel could read the jobs it runs \(trust\)\. then: M answers faster on pixel alone \(planner\)\.$/);
  // health (limits) before speed, privacy before health
  v = branch({ planner, limits }).look(snap());
  assert.equal(v.suggestions.find((x: any) => x.id.startsWith('advisor:first:')).id, 'advisor:first:limits:hot:p1');
  v = branch({ planner, limits, trust }).look(snap());
  assert.equal(v.suggestions.find((x: any) => x.id.startsWith('advisor:first:')).id, 'advisor:first:trust:owner-blind:p1');
});

test('night: a device away now but likely there by the start hour is a line, not a warning (C8)', () => {
  const TEN = new Date(2026, 10, 8, 22, 0).getTime();
  const away = [dev({ reachable: false, reason: 'timeout' }), dev({ id: 'p2', name: 'galaxy' })];
  const p = proj({ title: 'summaries', start: TEN, mode: 'phone', peers: ['p1'] });
  const fc = (hours: number[], guess = 'likely') => ({ forecast: { built: true, stat: 'x', hints: [night('p1', hours, guess)] } });
  const nightCard = (v: any) => v.suggestions.find((x: any) => x.id === 'advisor:night:n1');
  const HIGH = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.8, 0.5];
  // at noon, pixel is at work; the forecast has it home at 22:00 with 90 %
  let v = branch(fc(HIGH)).look(snap({ devices: away, projects: [p] }));
  assert.equal(nightCard(v), undefined);
  assert.ok(v.lines.some((l: string) => l === 'night project summaries at 22:00: pixel not here now, likely by 22:00.'), v.lines.join(' | '));
  // under LIKELY at that hour: the card as today
  v = branch(fc([0.5, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9])).look(snap({ devices: away, projects: [p] }));
  assert.equal(nightCard(v).title, 'the night project at 22:00 would not start well: pixel not reachable now');
  assert.equal(nightCard(v).weight, 3);
  // the forecast does not know: the card as today
  v = branch(fc(HIGH, 'unknown')).look(snap({ devices: away, projects: [p] }));
  assert.ok(nightCard(v));
  assert.ok(nightCard(branch().look(snap({ devices: away, projects: [p] }))), 'no forecast at all');
  // less than an hour to the start: the card as today
  v = branch(fc(HIGH)).look(snap({ at: new Date(2026, 10, 8, 21, 30).getTime(), devices: away, projects: [p] }));
  assert.deepEqual(nightCard(v).action, { do: 'probe', devices: ['p1'] });
  // a start hour outside the night's hours is unknown: the card as today
  v = branch(fc(HIGH)).look(snap({ devices: away, projects: [proj({ start: new Date(2026, 10, 8, 20, 0).getTime(), mode: 'phone', peers: ['p1'] })] }));
  assert.ok(nightCard(v));
  // two away, only pixel likely back: the card names galaxy alone and probes galaxy alone
  const both = { forecast: { built: true, stat: 'x', hints: [night('p1', HIGH), night('p2', [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2])] } };
  v = branch(both).look(snap({ devices: [dev({ reachable: false }), dev({ id: 'p2', name: 'galaxy', reachable: false })], projects: [proj({ start: TEN, peers: ['p1', 'p2'] })] }));
  assert.equal(nightCard(v).title, 'the night project at 22:00 would not start well: galaxy not reachable now');
  assert.deepEqual(nightCard(v).action, { do: 'probe', devices: ['p2'] });
  assert.ok(v.lines.some((l: string) => /: pixel not here now, likely by 22:00\.$/.test(l)));
  accepted(v);
});

test('night: a model that fits once the model loaded here goes is no problem (C2: heldHere counted back)', () => {
  const s = snap({
    host: { name: 'mac', freeMb: 3000 },
    models: [model('chat', 6000), model('night', 4000)],
    work: { llama: true, loaded: { mode: 'here', model: { id: 'chat', name: 'chat', file: 'chat.gguf', size: 5e9 }, ctx: 4096, since: 1, devices: [{ id: 'local', name: 'this computer', local: true, busy: false, tps: 10, done: 3 }] } },
  });
  const p = proj({ mode: 'here', model: 'night', peers: [] });
  assert.deepEqual(nightProblems(s, p).problems, []);
  // nothing loaded: 3000 MB free is too little for it, as before
  assert.equal(nightProblems(snap({ host: { name: 'mac', freeMb: 3000 }, models: s.models, work: { llama: true } }), p).problems.length, 1);
});

test('at most two cards, never one of another branch\'s ids; the others are quoted when lit', () => {
  const planner = { built: true, stat: 'x', suggestions: [{ id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: null }, { id: 'planner:b', kind: 'suggest', title: 'b', why: 'w', action: null }] };
  const v = branch({ planner, forecast: FORECAST, limits: { built: false, stat: 'not built yet' } }).look(snap({ at: AFTERNOON, devices: [dev(), dev({ id: 'p2', name: 'galaxy', reachable: false }), dev({ id: 'p3', name: 'tablet' })], projects: [proj()] }));
  assert.equal(v.suggestions.length, 2);
  assert.ok(v.suggestions.every((c: any) => c.id.startsWith('advisor:')));
  assert.ok(v.lines.includes('forecast says: 3 devices · tonight 3 likely'));
  assert.ok(!v.lines.some((l: string) => /limits says/.test(l)));
  assert.equal(v.stat, v.suggestions[0].title);
  assert.equal(branch().look(snap()).stat, 'nothing to suggest');
});

test('a feed line when the first card changes, once it held; remembered across a restart', () => {
  const dir = path.join(HOME, 'eye');
  let s = snap({ devices: [dev(), dev({ id: 'p2', name: 'galaxy', reachable: false })], projects: [proj()] });
  const eye = new GodsEye({ snapshot: () => s, dir });
  const said = () => eye.view().events.filter((e) => e.branch === 'advisor').map((e) => e.text);
  eye.tick();
  eye.tick();
  assert.deepEqual(said(), []);
  eye.tick();
  eye.tick();
  assert.deepEqual(said(), ['advisor: the night project at 23:00 would not start well: galaxy not reachable now']);
  assert.ok(eye.view().cards.some((c) => c.id === 'advisor:night:n1'));

  s = snap({ projects: [proj()] });           // galaxy back for one look only
  eye.tick();
  s = snap({ devices: [dev(), dev({ id: 'p2', name: 'galaxy', reachable: false })], projects: [proj()] });
  eye.tick();
  eye.tick();
  assert.equal(said().length, 1, 'one look away is no new card');
  const notes = JSON.parse(fs.readFileSync(path.join(dir, 'advisor.json'), 'utf8'));
  assert.ok(JSON.stringify(notes).length < 200);

  const again = new GodsEye({ snapshot: () => s, dir });
  for (let i = 0; i < 5; i++) again.tick();
  assert.equal(again.view().events.filter((e) => e.branch === 'advisor').length, 0);
});

// P39 (F2, F6): the advisor's night fit is review's (fit.ts)
test('night: a split device the forecast has back by 22:00 brings its memory with it: a line, no card (P39, F2)', () => {
  const TEN = new Date(2026, 10, 8, 22, 0).getTime();
  const fc = { forecast: { built: true, stat: 'x', hints: [night('p2', [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9])] } };
  const s = snap({
    host: { name: 'mac', freeMb: 4000 }, work: { llama: true },
    devices: [dev({ ramMb: 6000 }), dev({ id: 'p2', name: 'galaxy', ramMb: 6000, reachable: false, reason: 'no answer' })],
    projects: [proj({ start: TEN, mode: 'split', model: 'Big 14B', peers: ['p1', 'p2'] })],
  });
  // with galaxy: 4000*0.7 + 6000*0.75 + 6000*0.75 = 11800 >= 9000; without it 7300 would have said "too big"
  const v = branch(fc).look(s);
  assert.equal(v.suggestions.find((x: any) => x.id.startsWith('advisor:night:')), undefined, JSON.stringify(v.suggestions));
  assert.ok(v.lines.includes('night project essay at 22:00: galaxy not here now, likely by 22:00.'), v.lines.join(' | '));
  assert.ok(v.lines.includes('night project essay at 22:00: its other 1 device answer now and Big 14B fits.'), v.lines.join(' | '));
});

test('night: apart with no device chosen and a model no place holds is a card, not "its no devices ... fits" (P39, F6)', () => {
  const s = (needMb: number) => snap({
    host: { name: 'mac', freeMb: 4000 }, work: { llama: true },
    devices: [dev({ ramMb: 6000 }), dev({ id: 'p2', name: 'galaxy', ramMb: 6000 })],
    models: [model('Big', needMb)],
    projects: [proj({ mode: 'apart', model: 'Big', peers: [] })],
  });
  let v = branch().look(s(9000));
  const c = v.suggestions.find((x: any) => x.id === 'advisor:night:n1');
  assert.equal(c.title, 'the night project at 23:00 would not start well: Big needs about 8.8 GB, no device offers more than 4.4 GB');
  assert.equal(c.weight, 3);
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'review' });
  accepted(v);
  v = branch().look(s(4000));
  assert.deepEqual(ids(v), []);
  assert.ok(v.lines.includes('night project essay at 23:00: its 2 devices answer now and Big fits.'), v.lines.join(' | '));
});

test('night: a here project that fits says this computer runs it (P39)', () => {
  const v = branch().look(snap({ host: { name: 'mac', freeMb: 8000 }, work: { llama: true }, projects: [proj({ mode: 'here', peers: [] })] }));
  assert.deepEqual(ids(v), []);
  assert.ok(v.lines.includes('night project essay at 23:00: this computer runs it and Qwen3 4B fits.'), v.lines.join(' | '));
});
