// god's eye, the faster-split card on the learned range (L11 P59a): with a learned hop (3 ks or more,
// a range) and every speed answered, the card shows when the range's low end reaches the fastest
// place alone (and the guess is above it); without one it is the point, S.tps >= A.tps * GAIN, as before.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-planner-low-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const planner = await import('../src/godseye/branches/planner.ts');
const decide = await import('../src/godseye/branches/decide.ts');
const hop = await import('../src/godseye/branches/hop.ts');

// ---- copied from godseye-hop-wire.test.ts:19-71
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
const peekOf = (peeks: Record<string, any>) => ({ peek: (id: string) => peeks[id] ?? null });
const near = (a: number, b: number, eps: number, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

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

// ---- fixture Z: 4000 MB, 4 GB (readGb 4.2); host 8000 free (cap 5600); one worker p1 on wifi, ram 4000 (cap 3000)
// measured on Z's file, n 5: local 3.5 tok/s (14.7 GB/s), p1 6 (25.2 GB/s). Alone: only this computer holds it, 3.5.
// Split (strict): p1 takes 3000 MB, local 1000: computeMs = 0.75 x 4200 / 25.2 + 0.25 x 4200 / 14.7
//   = 125 + 71.4286 = 196.4286 ms.
// Z (p1 srtt 160, k 0.5): hop 80 -> 276.4286 ms -> raw 3.6176, S.tps 3.6; the point needs 3.5 x 1.15 = 4.025: no.
//   errs [.01 .01 .01 .02]: q .02, lo 3.6176 / 1.02 = 3.5467 >= 3.5: the card.
//   errs [.1 .2 .3 .4]:     q .4,  lo 3.6176 / 1.4  = 2.5840: no card.
//   errs [.01 .02 .03 .05]: q .05, lo 3.6176 / 1.05 = 3.4453: strict no. Loose (SLACK 1.05): p1 takes 3150 MB,
//     local 850: 131.25 + 60.7143 + 80 = 271.9643 ms -> raw 3.6769, lo 3.5018, x 1.05 = 3.6769 >= 3.5 and
//     S.tps 3.7 x 1.05 > 3.5: the card.
//   no fit (k prior 1, or 2 ks): hop 160 -> 356.4286 ms -> 2.8: no card. (plan() with no fit at all
//     prices each link at HOP_MS 10: 4.8, the card; the branch always hands its fit.)
// Z2 (p1 srtt 20, k 0.5): hop 10 -> 206.4286 ms -> raw 4.8443, S.tps 4.8.
//   errs [.1 .2 .3 .4]: lo 4.8443 / 1.4 = 3.4602 < 3.5: no card, though the point (4.8 >= 4.025) says yes.
//   no fit: 4.8 (HOP_MS 10), the card.
const Z = model('z', 'Z', 4000, 4 * GB);
const SZ = snap({ devices: [dev({ ramMb: 4000 })], models: [Z] });
const MEASURED = (p1 = true) => new Map<string, any[]>([
  ['local', [{ file: Z.file, tps: 3.5, n: 5 }]], ...(p1 ? [['p1', [{ file: Z.file, tps: 6, n: 5 }]] as [string, any[]]] : []),
]);
const SPEEDS = () => ({ local: { [Z.file]: { tps: 3.5, n: 5, at: AT } }, p1: { [Z.file]: { tps: 6, n: 5, at: AT } } });
const senses = (srtt: number) => ({ senses: { hints: [{ id: 'p1', link: { srtt, rttvar: srtt / 10 } }] } });
const fieldOf = (peeks: Record<string, any>, s: any = SZ, m = MEASURED()) => decide.field(s, peekOf(peeks) as any, m);
const ZF = () => fieldOf(senses(160));
const Z2F = () => fieldOf(senses(20));
const ID = `planner:split:${Z.id}`;
const splitCard = (cards: any[]) => cards.find((c) => c.id === ID);
const fit = (errs: number[], ks = [0.5, 0.5, 0.5]) => ({ ks, errs });
const TIGHT = fit([0.01, 0.01, 0.01, 0.02]);
const WIDE = fit([0.1, 0.2, 0.3, 0.4]);
const shape = (t: string) => t.replace(/\d+(\.\d+)?/g, '#');

test('splitFaster: the low end with the guess above, else the point', () => {
  assert.equal(planner.splitFaster(4, null, 3.5, 1.15), false);
  assert.equal(planner.splitFaster(4.1, null, 3.5, 1.15), true);
  assert.equal(planner.splitFaster(3.6, 3.55, 3.5, 1.15), true);
  assert.equal(planner.splitFaster(3.6, 3.45, 3.5, 1.15), false);
  assert.equal(planner.splitFaster(5, 3.4, 3.5, 1.15), false);
  assert.equal(planner.splitFaster(3.5, 3.5, 3.5, 1.15), false);
  assert.equal(planner.splitFaster(3.6, 3.4, 3.5, 1.05, 1.05), true);
});

test('fixture Z: the numbers worked by hand', () => {
  const S = planner.plan(SZ, ZF(), Z as any, true, TIGHT).split!;
  near(S.chain!.computeMs, 196.4286, 1e-3);
  assert.equal(S.tps, 3.6);
  near(hop.chainTps(S.chain!.computeMs, S.chain!.links, 0.5), 3.6176, 1e-3);
  const A = planner.plan(SZ, ZF(), Z as any, true, TIGHT).alone!;
  assert.equal(A.tps, 3.5);
  near(planner.lowEnd(S, A, TIGHT)!, 3.5467, 1e-3);
  near(planner.lowEnd(S, A, WIDE)!, 2.5840, 1e-3);
  const S2 = planner.plan(SZ, Z2F(), Z as any, true, WIDE).split!;
  near(hop.chainTps(S2.chain!.computeMs, S2.chain!.links, 0.5), 4.8443, 1e-3);
  near(planner.lowEnd(S2, A, WIDE)!, 3.4602, 1e-3);
});

test('Z without a learned range: the point, as before (no card)', () => {
  for (const h of [hop.freshHop(), fit([0.01, 0.01], [0.5, 0.5])]) {
    const r = planner.plan(SZ, ZF(), Z as any, true, h);
    assert.equal(r.split!.tps, 2.8);
    assert.equal(planner.lowEnd(r.split!, r.alone!, h), null);
    assert.equal(splitCard(r.cards), undefined, JSON.stringify(h));
  }
});

test('Z with a tight range: the card, shaped as the point card of Z2', () => {
  const c = splitCard(planner.plan(SZ, ZF(), Z as any, true, TIGHT).cards);
  assert.ok(c, 'the card');
  const z2 = splitCard(planner.plan(SZ, Z2F(), Z as any, true).cards);
  assert.ok(z2, 'Z2 without a fit: the card');
  assert.equal(c.id, z2.id);
  assert.deepEqual(c.action, z2.action);
  assert.equal(shape(c.title), shape(z2.title));
  assert.equal(c.title, 'Z would run faster split over mac and pixel: ~3.6 tok/s; alone here on mac ~3.5');
  for (const k of ['kind', 'weight', 'label'] as const) assert.equal(c[k], z2[k], k);
});

test('a wide range: no card, on Z and on Z2 (where the point would say yes)', () => {
  assert.equal(splitCard(planner.plan(SZ, ZF(), Z as any, true, WIDE).cards), undefined, 'Z');
  assert.equal(splitCard(planner.plan(SZ, Z2F(), Z as any, true, WIDE).cards), undefined, 'Z2');
});

test('a middling range: strict says no, loose (SLACK) keeps it', () => {
  const H = fit([0.01, 0.02, 0.03, 0.05]);
  assert.equal(splitCard(planner.plan(SZ, ZF(), Z as any, true, H).cards), undefined, 'strict');
  assert.ok(splitCard(planner.plan(SZ, ZF(), Z as any, false, H).cards), 'loose');
});

test('a seat estimated from its bandwidth: no low end, the point rules', () => {
  // p1 not measured, bwGBs 42: 42 x EFF 0.6 = 25.2 GB/s, the very speed it was measured at above
  const s = snap({ devices: [dev({ ramMb: 4000, bwGBs: 42 })], models: [Z] });
  const f = fieldOf(senses(160), s, MEASURED(false));
  assert.equal(f.seats.find((x) => x.id === 'p1')!.speed!.from, 'bandwidth');
  const r = planner.plan(s, f, Z as any, true, TIGHT);
  assert.equal(r.split!.tps, 3.6);
  assert.equal(planner.lowEnd(r.split!, r.alone!, TIGHT), null);
  // the same look without a range (same k, no errs) and with no learned k: the same cards (none)
  assert.deepEqual(r.cards, planner.plan(s, f, Z as any, true, fit([])).cards);
  assert.deepEqual(r.cards, planner.plan(s, f, Z as any, true, hop.freshHop()).cards);
  assert.equal(splitCard(r.cards), undefined);
});

test('Z without senses: no chain, the cards of plan without a fit', () => {
  const f = fieldOf({});
  for (const h of [TIGHT, WIDE]) assert.deepEqual(planner.plan(SZ, f, Z as any, true, h).cards, planner.plan(SZ, f, Z as any, true).cards);
  assert.ok(splitCard(planner.plan(SZ, f, Z as any, true).cards), 'HOP_MS: 4.8, the point card');
});

test('a model that fits only split: its card is there with any fit, the same but for its why', () => {
  // 7000 MB: the host's cap 5600 and p1's 3000 hold it only together
  const W = model('w', 'W', 7000, 7 * GB);
  const s = snap({ devices: [dev({ ramMb: 4000 })], models: [W] });
  const f = decide.field(s, peekOf(senses(160)) as any, new Map([['local', [{ file: W.file, tps: 2, n: 5 }]], ['p1', [{ file: W.file, tps: 3, n: 5 }]]]));
  const base = planner.plan(s, f, W as any, true).cards.find((c: any) => c.id === `planner:split:${W.id}`)!;
  assert.ok(base.title.includes('fits only split'), base.title);
  const strip = (c: any) => ({ ...c, why: undefined });
  for (const h of [hop.freshHop(), fit([0.01, 0.01], [0.5, 0.5]), TIGHT, WIDE, fit([1, 1, 1, 1.5])]) {
    const c = planner.plan(s, f, W as any, true, h).cards.find((x: any) => x.id === base.id);
    assert.deepEqual(strip(c), strip(base), JSON.stringify(h));
  }
});

test('the branch on Z with the tight range in its notes: the card after SHOW looks', () => {
  const b = branch(senses(160), { v: 1, last: Z.id, speeds: SPEEDS(), hop: TIGHT });
  const v = b.look(SZ, decide.SHOW);
  const c = v.suggestions.find((x: any) => x.id === ID);
  assert.ok(c, JSON.stringify(v.suggestions));
  assert.ok(c.why.endsWith('likely 3.5\u{2013}3.7 tok/s (8 in 10).'), c.why);
  // with the wide range in its notes: none
  const w = branch(senses(160), { v: 1, last: Z.id, speeds: SPEEDS(), hop: WIDE }).look(SZ, decide.SHOW);
  assert.equal(w.suggestions.find((x: any) => x.id === ID), undefined);
});
