// god's eye, the hop wired (L9 P49): the planner prices a split's links from senses' srtt and the
// learned k (hop.ts), learns k from the split's own answers, and says the range in the split card's
// why. Words only: no new card, hint or feed line, and no rule reads the range.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-hop-wire-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { cleanCard } = await import('../src/godseye/index.ts');
const planner = await import('../src/godseye/branches/planner.ts');
const decide = await import('../src/godseye/branches/decide.ts');
const hop = await import('../src/godseye/branches/hop.ts');

// ---- copied from godseye-decide.test.ts:19-43
const GB = 1024 * 1024 * 1024;
const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 6000, bwGBs: null, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null, ...o,
});
const model = (id: string, name: string, needMb: number, size: number, o: Record<string, unknown> = {}) => ({
  id, name, file: `${id}.gguf`, size, quant: 'Q4_K_M', params_b: null, catalog: true, here: false, needMb, ...o,
});
const AT = new Date(2026, 10, 11, 15, 0).getTime();
const snap = (o: Record<string, any> = {}): any => ({
  at: AT, host: { name: 'mac', freeMb: 8000 },
  devices: [dev(), dev({ id: 'p2', name: 'galaxy' })],
  models: [],
  projects: [],
  ...o,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...(o.work ?? {}) },
});
const loaded = (m: any, mode: string, devices: any[], o: Record<string, unknown> = {}) => ({ mode, model: { id: m.id, name: m.name, file: m.file, size: m.size }, ctx: 4096, since: AT - 60_000, devices, ...o });
const here = (tps: number | null, done = 3, busy = false) => ({ id: 'local', name: 'this computer', local: true, busy, tps, done });
const on = (id: string, name: string, tps: number | null, done = 3, busy = false) => ({ id, name, local: false, busy, tps, done });

// ---- fixture X: 6000 MB, 4 GB (readGb 4.2); host 8000 free (cap 5600); p1 wifi and p2 internet, 4000 each (cap 3000)
const X = model('x', 'X', 6000, 4 * GB);
const P1 = { srtt: 20, rttvar: 2 };
const P2 = { srtt: 200, rttvar: 20 };
const S0 = snap({ devices: [dev({ ramMb: 4000 }), dev({ id: 'p2', name: 'galaxy', via: 'internet', ramMb: 4000 })], models: [X] });
// measured on X's file: local 2, p1 6, p2 5 tok/s (n 5): GB/s 8.4, 25.2, 21
const MEASURED = () => new Map<string, any[]>([
  ['local', [{ file: X.file, tps: 2, n: 5 }]], ['p1', [{ file: X.file, tps: 6, n: 5 }]], ['p2', [{ file: X.file, tps: 5, n: 5 }]],
]);
const SPEEDS = () => ({ local: { [X.file]: { tps: 2, n: 5, at: AT } }, p1: { [X.file]: { tps: 6, n: 5, at: AT } }, p2: { [X.file]: { tps: 5, n: 5, at: AT } } });
const senses = (hints: unknown[] = [{ id: 'p1', link: P1 }, { id: 'p2', link: P2 }]) => ({ senses: { hints } });
const peekOf = (peeks: Record<string, any>) => ({ peek: (id: string) => peeks[id] ?? null });
const fieldX = (peeks: Record<string, any> = senses(), s: any = S0) => decide.field(s, peekOf(peeks) as any, MEASURED());
const noLink = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'link' ? undefined : v)));
const near = (a: number, b: number, eps: number, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);
const seatIds = (p: any) => p.seats.map((x: any) => x.id);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** the planner with a fake ctx whose now() moves 61 s per call (so every look may save) */
function branch(peeks: Record<string, any> = {}, notes: unknown = null) {
  let t = AT;
  let kept: unknown = notes;
  const b = planner.create({
    now: () => (t += 61_000),
    load: <T,>(fb: T): T => (kept as T) ?? fb,
    save: (d: unknown) => { kept = structuredClone(d); },
    emit: () => {},
    peek: (id: string) => peeks[id] ?? null,
  } as any);
  const look = (s: any, n = 1) => { for (let i = 0; i < n; i++) b.observe(s, null); return b.view(); };
  return { look, notes: () => kept as any };
}
const splitX = (done: number, tps: number | null = 2.9, o: Record<string, unknown> = {}) => snap({
  ...S0,
  work: {
    loaded: loaded(X, 'split', [here(tps, done), on('p1', 'pixel', null, done)], {
      parts: [{ id: 'local', name: 'this computer', local: true, mb: 3000, layers: 18 }, { id: 'p1', name: 'pixel', local: false, mb: 3000, layers: 18 }], ...o,
    }),
  },
});
const row = (v: any) => (v.rows as [string, string][]).find((r) => r[0] === 'link cost')?.[1];

test('linksOf: only a sane link passes, a missing rttvar is 0, no senses gives an empty map', () => {
  const m = decide.linksOf(peekOf(senses([
    { id: 'a', link: { srtt: 20, rttvar: 2 } },
    { id: 'b', link: { srtt: NaN, rttvar: 1 } },
    { id: 'c', link: { srtt: 0, rttvar: 1 } },
    { id: 'd', link: { srtt: 700000, rttvar: 1 } },
    { id: 'e' },
    { id: 'f', link: { srtt: 30 } },
    { link: { srtt: 5, rttvar: 1 } },
  ])) as any);
  assert.deepEqual([...m.entries()], [['a', { srtt: 20, rttvar: 2 }], ['f', { srtt: 30, rttvar: 0 }]]);
  assert.equal(decide.linksOf(peekOf({}) as any).size, 0);
});

test('field: a seat gets a link only from senses, never the local seat', () => {
  const bare = fieldX({});
  for (const x of bare.seats) assert.equal('link' in x, false, x.id);
  const f = fieldX();
  assert.deepEqual(f.seats.find((x) => x.id === 'p1')!.link, { srtt: 20, rttvar: 2 });
  assert.deepEqual(f.seats.find((x) => x.id === 'p2')!.link, { srtt: 200, rttvar: 20 });
  assert.equal('link' in f.seats.find((x) => x.local)!, false);
});

test('split without k: as before, links or not', () => {
  // two seats: 2100/25.2 + 2100/8.4 = 333.333 + 10 = 343.3 ms; three: 83.333 + 100 = 183.333 + 20 = 203.3 ms -> 4.9
  const p = decide.split(fieldX(), X)!;
  assert.deepEqual(seatIds(p), ['local', 'p1', 'p2']);
  assert.equal(p.tps, 4.9);
  assert.equal('chain' in p, false);
  assert.deepEqual(noLink(p), noLink(decide.split(fieldX({}), X)));
});

test('split with k: the links cost k x srtt and the chain is said', () => {
  // k 1: two seats 333.333 + 20 = 353.3 ms (2.8); three 183.333 + 220 = 403.3 (2.5)
  const a = decide.split(fieldX(), X, 1, 1)!;
  assert.deepEqual(seatIds(a), ['local', 'p1']);
  assert.equal(a.tps, 2.8);
  near(a.chain!.computeMs, 1000 / 3, 1e-3);
  assert.deepEqual(a.chain!.links, [P1]);
  // k 0.5: two 343.3, three 183.333 + 110 = 293.3 ms (3.4)
  const b = decide.split(fieldX(), X, 1, 0.5)!;
  assert.deepEqual(seatIds(b), ['local', 'p1', 'p2']);
  assert.equal(b.tps, 3.4);
  near(b.chain!.computeMs, 550 / 3, 1e-3);
  assert.deepEqual(b.chain!.links, [P1, P2]);
  for (const k of [0, NaN, -1, Infinity]) assert.deepEqual(decide.split(fieldX(), X, 1, k), decide.split(fieldX(), X), String(k));
});

test('split with k and a worker without a link: HOP_MS for it, no chain', () => {
  const f = fieldX(senses([{ id: 'p1', link: P1 }]));
  // three seats: 183.333 + 1 x 20 + 10 = 213.3 ms; two: 333.333 + 20 = 353.3 ms: three win
  const three = 1000 / (550 / 3 + 20 + decide.HOP_MS);
  const two = 1000 / (1000 / 3 + 20);
  assert.ok(three > two);
  const p = decide.split(f, X, 1, 1)!;
  assert.deepEqual(seatIds(p), ['local', 'p1', 'p2']);
  assert.equal(p.tps, r1(three));
  assert.equal(p.tps, 4.7);
  assert.equal('chain' in p, false);
});

test('loadedChain: the loaded split as split() would say it, else null', () => {
  const s = splitX(3);
  const c = decide.loadedChain(s, fieldX(senses(), s), X)!;
  near(c.computeMs, 1000 / 3, 1e-3);
  assert.deepEqual(c.links, [P1]);
  // local 1000, p1 3000: 0.25 x 4200 / 8.4 + 0.75 x 4200 / 25.2 = 125 + 125
  const s2 = splitX(3, 2.9, { parts: [{ id: 'local', name: 'this computer', local: true, mb: 1000, layers: 9 }, { id: 'p1', name: 'pixel', local: false, mb: 3000, layers: 27 }] });
  near(decide.loadedChain(s2, fieldX(senses(), s2), X)!.computeMs, 250, 1e-3);
  // p1 barred by a limits hint
  assert.equal(decide.loadedChain(s, fieldX({ ...senses(), limits: { hints: [{ id: 'p1', no: 'it should rest' }] } }, s), X), null);
  // p1 without a link
  assert.equal(decide.loadedChain(s, fieldX(senses([{ id: 'p2', link: P2 }]), s), X), null);
  // mode apart
  const ap = splitX(3);
  ap.work.loaded.mode = 'apart';
  assert.equal(decide.loadedChain(ap, fieldX(senses(), ap), X), null);
  // another model
  const Y = model('y', 'Y', 6000, 4 * GB);
  assert.equal(decide.loadedChain(s, fieldX(senses(), s), Y), null);
  // local speed unknown
  const m = MEASURED();
  m.delete('local');
  assert.equal(decide.loadedChain(s, decide.field(s, peekOf(senses()) as any, m), X), null);
});

test('watching a split: each answer that grew gives one k, saved in the notes', () => {
  const preset = { v: 1, last: X.id, speeds: SPEEDS() };
  const b = branch(senses(), structuredClone(preset));
  b.look(splitX(3));
  assert.equal(b.notes().hop, undefined, 'look 1: first sighting');
  b.look(splitX(4));
  // k = (1000 / 2.9 - 333.333) / 20 = 0.5747; est = 1000 / 353.333 = 2.830, err = |2.9 - 2.830| / 2.9 = 0.0241
  const h1 = b.notes().hop;
  assert.equal(h1.ks.length, 1);
  near(h1.ks[0], 0.5747, 1e-3);
  near(h1.ks[0], (1000 / 2.9 - 1000 / 3) / 20, 1e-9);
  assert.equal(h1.errs.length, 1);
  near(h1.errs[0], 0.0241, 1e-3);
  assert.equal(row(b.look(splitX(4))), 'not learned yet: 1 of 3 split answers', 'done unchanged: no step');
  assert.equal(b.notes().hop.ks.length, 1);
  b.look(splitX(5));
  assert.equal(b.notes().hop.ks.length, 2, 'done 5: a second k');
  b.look(splitX(6, 2.9, { since: AT - 30_000 }));
  assert.equal(b.notes().hop.ks.length, 2, 'a new since: first sighting');
  assert.deepEqual(b.notes().speeds, preset.speeds, 'speeds gain nothing from a split');

  // created again from the saved notes: the same fit, and it goes on from there
  const saved = b.notes().hop;
  const again = branch(senses(), structuredClone(b.notes()));
  assert.equal(row(again.look(splitX(3))), 'not learned yet: 2 of 3 split answers');
  again.look(splitX(4));
  const h3 = again.notes().hop;
  assert.deepEqual(h3.ks.slice(0, 2), saved.ks);
  assert.deepEqual(h3.errs.slice(0, 2), saved.errs);
  assert.equal(h3.ks.length, 3);
  assert.equal(row(again.look(splitX(4))), `k ${hop.hopK(h3).toFixed(2)} \u{d7} the usual round trip, from 3 split answers`);
  assert.equal(row(again.look(splitX(4))), 'k 0.57 \u{d7} the usual round trip, from 3 split answers');

  // a hop of another shape in the notes: fresh
  const odd = branch(senses(), { ...structuredClone(preset), hop: { ks: ['x'], errs: [] } });
  assert.equal(row(odd.look(splitX(3))), undefined);
  odd.look(splitX(4));
  assert.equal(odd.notes().hop.ks.length, 1);
});

test('watching: no step without a tok/s, without senses, or when not split', () => {
  const preset = () => ({ v: 1, last: X.id, speeds: SPEEDS() });
  const a = branch(senses(), preset());
  a.look(splitX(3));
  a.look(splitX(4, null));
  assert.equal(a.notes().hop, undefined, 'tps null');
  const b = branch({}, preset());
  b.look(splitX(3));
  b.look(splitX(4));
  assert.equal(b.notes().hop, undefined, 'no senses peek');
  const c = branch(senses(), preset());
  const apartX = (done: number) => { const s = splitX(done); s.work.loaded.mode = 'apart'; return s; };
  c.look(apartX(3));
  c.look(apartX(4));
  assert.equal(c.notes().hop, undefined, 'mode apart');
});

test('the split card says how the links cost is known, and the range once it can', () => {
  const s = S0;   // nothing loaded, X loaded last
  const notes = (h?: unknown) => ({ v: 1, last: X.id, speeds: SPEEDS(), ...(h ? { hop: h } : {}) });
  const cardOf = (v: any) => v.suggestions.find((c: any) => c.id === `planner:split:${X.id}`);
  const f = fieldX(senses(), s);
  const without = planner.plan(s, f, X as any, true).cards;

  // an empty fit: the prior k, words only
  const e = cardOf(branch(senses(), notes()).look(s, decide.SHOW));
  assert.ok(e.why.endsWith(` the links' cost is assumed (one usual round trip per worker per token): 0 of 3 split answers watched.`), e.why);
  assert.equal(e.id, without[0].id);
  // the prior k = 1 prices p2's 200 ms link: the two-seat split wins (choice c)
  assert.deepEqual(e.action.devices, ['p1']);

  // three ks of 0.5 and four errs: the range, q = the 4th smallest err = 0.4
  const H = { ks: [0.5, 0.5, 0.5], errs: [0.1, 0.2, 0.3, 0.4] };
  const c = cardOf(branch(senses(), notes(H)).look(s, decide.SHOW));
  const S = planner.plan(s, f, X as any, true, H).split!;
  const raw = hop.chainTps(S.chain!.computeMs, S.chain!.links, 0.5);
  near(raw, 1000 / (550 / 3 + 110), 1e-9);
  assert.ok(c.why.endsWith(`likely ${r1(raw / 1.4)}\u{2013}${r1(raw / 0.6)} tok/s (8 in 10).`), c.why);
  assert.ok(c.why.endsWith(`learned from the last 4 split answers watched: likely 2.4\u{2013}5.7 tok/s (8 in 10).`), c.why);
  assert.equal(c.id, without[0].id);
  assert.deepEqual(c.action, without[0].action);

  // an err of 1 or more at the quantile: no top
  const o = cardOf(branch(senses(), notes({ ks: [0.5, 0.5, 0.5], errs: [1, 1, 1, 1.5] })).look(s, decide.SHOW));
  assert.ok(o.why.endsWith(`likely ${r1(raw / 2.5)} tok/s or more (8 in 10).`), o.why);

  for (const card of [e, c, o]) assert.deepEqual(cleanCard(card), card);

  // without senses: byte for byte the card of before
  const bare = cardOf(branch({}, notes(H)).look(s, decide.SHOW));
  const before = planner.plan(s, fieldX({}, s), X as any, true).cards[0];
  assert.equal(bare.title, before.title);
  assert.equal(bare.why, before.why);
});

test('view: the link cost row only once a k was learned', () => {
  const b = branch(senses(), { v: 1, last: X.id, speeds: SPEEDS() });
  assert.equal(row(b.look(S0)), undefined);
});
