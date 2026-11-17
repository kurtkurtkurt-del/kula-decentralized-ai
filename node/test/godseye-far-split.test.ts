// god's eye, the far split (anchor network, P3): a worker reached straight over the internet or through
// an anchor (isFar) is priced at kFar (or 1) times its srtt, or 150 / 300 ms without a link; a near
// worker exactly as before. A split with a far worker says its tok/s at the pessimistic end and `far`
// = { lo, hi, assumed } (hi at k 0.25 until hopFar is learned); the planner learns hopFar only from far
// chains and shows planner:far:<model> when alone or apart also exists (action null: you choose).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-far-split-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { cleanCard } = await import('../src/godseye/index.ts');
const planner = await import('../src/godseye/branches/planner.ts');
const decide = await import('../src/godseye/branches/decide.ts');
const hop = await import('../src/godseye/branches/hop.ts');

// ---- copied from godseye-hop-wire.test.ts:19-58
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
const here = (tps: number | null, done = 3) => ({ id: 'local', name: 'this computer', local: true, busy: false, tps, done });
const on = (id: string, name: string, tps: number | null, done = 3) => ({ id, name, local: false, busy: false, tps, done });

// ---- fixture X: 6000 MB, 4 GB (readGb 4.2); host 8000 free (cap 5600); phones 4000 (cap 3000)
// measured on X's file: local 2, p1 6, p2 5 tok/s: GB/s 8.4, 25.2, 21
const X = model('x', 'X', 6000, 4 * GB);
const P1 = { srtt: 20, rttvar: 2 };
const P2 = { srtt: 200, rttvar: 20 };
const MEASURED = () => new Map<string, any[]>([
  ['local', [{ file: X.file, tps: 2, n: 5 }]], ['p1', [{ file: X.file, tps: 6, n: 5 }]], ['p2', [{ file: X.file, tps: 5, n: 5 }]],
]);
const SPEEDS = () => ({ local: { [X.file]: { tps: 2, n: 5, at: AT } }, p1: { [X.file]: { tps: 6, n: 5, at: AT } }, p2: { [X.file]: { tps: 5, n: 5, at: AT } } });
const senses = (hints: unknown[] = [{ id: 'p1', link: P1 }, { id: 'p2', link: P2 }]) => ({ senses: { hints } });
const peekOf = (peeks: Record<string, any>) => ({ peek: (id: string) => peeks[id] ?? null });
const fieldOf = (s: any, peeks: Record<string, any> = senses(), m = MEASURED()) => decide.field(s, peekOf(peeks) as any, m);
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

// only p2, far: host 3000 + p2 3000; c = 0.5 x 4200 / 21 + 0.5 x 4200 / 8.4 = 100 + 250 = 350 ms
const C = 350;
const farOnly = (via: string) => snap({ devices: [dev({ id: 'p2', name: 'galaxy', via, ramMb: 4000 })], models: [X] });

test('near-only fixtures: the same Place with and without kFar, and no far', () => {
  const s = snap({ devices: [dev({ ramMb: 4000 }), dev({ id: 'p2', name: 'galaxy', ramMb: 4000 })], models: [X] });
  for (const peeks of [senses(), senses([{ id: 'p1', link: P1 }]), {}]) {
    const f = fieldOf(s, peeks);
    for (const slack of [1, decide.SLACK]) for (const k of [undefined, 1, 0.5, 0.01, 10]) {
      const base = decide.split(f, X, slack, k);
      assert.ok(base);
      assert.equal('far' in base!, false);
      for (const kFar of [0.25, 1, 3, NaN]) assert.deepEqual(decide.split(f, X, slack, k, kFar), base, `k ${k} kFar ${kFar}`);
    }
  }
});

test('a far seat without a link costs 150 ms (internet) or 300 ms (anchor), whatever k is', () => {
  for (const [via, ms] of [['internet', 150], ['anchor', 300]] as const) {
    const f = fieldOf(farOnly(via), {});
    for (const k of [undefined, 0.5, 4]) {
      const p = decide.split(f, X, 1, k)!;
      assert.deepEqual(seatIds(p), ['local', 'p2'], via);
      assert.equal(p.tps, r1(1000 / (C + ms)), `${via} k ${k}`);
      assert.deepEqual(p.far, { lo: 1000 / (C + ms), hi: 1000 / (C + 0.25 * ms), assumed: true });
      assert.equal('chain' in p, false);
    }
    assert.equal(decide.FAR_HOP_MS[via], ms);
    // a learned kFar prices the assumed round trip too
    const q = decide.split(f, X, 1, undefined, 0.5)!;
    assert.deepEqual(q.far, { lo: 1000 / (C + 0.5 * ms), hi: 1000 / (C + 0.5 * ms), assumed: false });
  }
});

test('a far link of 200 ms: lo = 1000 / (c + 200), hi = 1000 / (c + 50); tps is the pessimistic end', () => {
  const f = fieldOf(farOnly('internet'), senses([{ id: 'p2', link: P2 }]));
  const p = decide.split(f, X, 1, 1)!;
  near(p.chain!.computeMs, C, 1e-9);
  assert.deepEqual(p.chain!.links, [P2]);
  assert.equal(p.far!.lo, 1000 / (C + 200));
  assert.equal(p.far!.hi, 1000 / (C + 50));
  assert.equal(p.far!.assumed, true);
  assert.equal(p.tps, r1(1000 / (C + 200)));
  assert.equal(p.tps, 1.8);
  // the near k does not touch a far link
  assert.deepEqual(decide.split(f, X, 1, 0.1), p);
  // the same over an anchor
  const a = decide.split(fieldOf(farOnly('anchor'), senses([{ id: 'p2', link: P2 }])), X, 1, 1)!;
  assert.deepEqual(a.far, p.far);
  // learned at 0.4: one number, not assumed
  const l = decide.split(f, X, 1, 1, 0.4)!;
  assert.deepEqual(l.far, { lo: 1000 / (C + 80), hi: 1000 / (C + 80), assumed: false });
  assert.equal(l.tps, r1(1000 / (C + 80)));
});

test('a relay is still never a seat of a split', () => {
  const f = fieldOf(farOnly('relay'), senses([{ id: 'p2', link: P2 }]));
  assert.equal(decide.split(f, X, 1, 1), null);
  assert.equal(decide.split(f, X, 1, 1, 0.25), null);
  const s = snap({ devices: [dev({ ramMb: 4000 }), dev({ id: 'p2', name: 'galaxy', via: 'relay', ramMb: 4000 })], models: [X] });
  const p = decide.split(fieldOf(s), X, 1, 1, 0.25)!;
  assert.deepEqual(seatIds(p), ['local', 'p1']);
  assert.equal('far' in p, false);
  assert.equal(decide.isFar({ via: 'relay' }), false);
  assert.equal(decide.isFar({ via: 'wifi' }), false);
  assert.equal(decide.isFar({ via: 'internet' }), true);
  assert.equal(decide.isFar({ via: 'anchor' }), true);
});

// a split loaded over this computer and p2 (far, link 200): chain c 350 and [P2], far [true]
const farSplit = (done: number, tps: number | null, via = 'internet') => snap({
  devices: [dev({ id: 'p2', name: 'galaxy', via, ramMb: 4000 })], models: [X],
  work: {
    loaded: loaded(X, 'split', [here(tps, done), on('p2', 'galaxy', null, done)], {
      parts: [{ id: 'local', name: 'this computer', local: true, mb: 3000, layers: 18 }, { id: 'p2', name: 'galaxy', local: false, mb: 3000, layers: 18 }],
    }),
  },
});

test('loadedChain flags a far link; a near chain is as before', () => {
  const s = farSplit(3, 2.5);
  const c = decide.loadedChain(s, fieldOf(s, senses([{ id: 'p2', link: P2 }])), X)!;
  near(c.computeMs, C, 1e-9);
  assert.deepEqual(c.links, [P2]);
  assert.deepEqual(c.far, [true]);
  const w = farSplit(3, 2.5, 'wifi');
  assert.equal('far' in decide.loadedChain(w, fieldOf(w, senses([{ id: 'p2', link: P2 }])), X)!, false);
});

test('three far answers teach hopFar only: hopK(hop) is unchanged; a near split teaches hop only', () => {
  const preset = () => ({ v: 1, last: X.id, speeds: SPEEDS() });
  const b = branch(senses([{ id: 'p2', link: P2 }]), preset());
  for (let d = 3; d <= 6; d++) b.look(farSplit(d, 2.5));
  const n = b.notes();
  assert.equal(n.hop, undefined);
  assert.equal(hop.hopK(n.hop ?? hop.freshHop()), hop.HOP_PRIOR);
  assert.equal(n.hopFar.ks.length, 3);
  // k = (1000 / 2.5 - 350) / 200 = 0.25
  for (const k of n.hopFar.ks) near(k, 0.25, 1e-9);
  near(hop.hopK(n.hopFar), 0.25, 1e-9);

  const w = branch(senses([{ id: 'p2', link: P2 }]), preset());
  for (let d = 3; d <= 6; d++) w.look(farSplit(d, 2.5, 'wifi'));
  assert.equal(w.notes().hop.ks.length, 3);
  assert.equal(w.notes().hopFar, undefined);

  // a chain with a near and a far worker: the near link goes into the compute time at the near k (1)
  const s3 = (done: number) => snap({
    devices: [dev({ ramMb: 4000 }), dev({ id: 'p2', name: 'galaxy', via: 'internet', ramMb: 4000 })], models: [X],
    work: {
      loaded: loaded(X, 'split', [here(2.5, done), on('p1', 'pixel', null, done), on('p2', 'galaxy', null, done)], {
        parts: [{ id: 'local', name: 'this computer', local: true, mb: 2000, layers: 12 }, { id: 'p1', name: 'pixel', local: false, mb: 2000, layers: 12 }, { id: 'p2', name: 'galaxy', local: false, mb: 2000, layers: 12 }],
      }),
    },
  });
  const m = branch(senses(), preset());
  m.look(s3(3));
  m.look(s3(4));
  const c3 = 1400 / 8.4 + 1400 / 25.2 + 1400 / 21;
  near(m.notes().hopFar.ks[0], (400 - c3 - 20) / 200, 1e-9);
  assert.equal(m.notes().hop, undefined);
});

test('an old notes file without hopFar loads; hopFar survives a reload', () => {
  const b = branch(senses([{ id: 'p2', link: P2 }]), { v: 1, last: X.id, speeds: SPEEDS(), hop: { ks: [0.5], errs: [0.1] } });
  b.look(farSplit(3, 2.5));
  b.look(farSplit(4, 2.5));
  const saved = b.notes();
  assert.deepEqual(saved.hop, { ks: [0.5], errs: [0.1] });
  assert.equal(saved.hopFar.ks.length, 1);
  const again = branch(senses([{ id: 'p2', link: P2 }]), structuredClone(saved));
  again.look(farSplit(3, 2.5));
  again.look(farSplit(4, 2.5));
  assert.deepEqual(again.notes().hopFar.ks.slice(0, 1), saved.hopFar.ks);
  assert.equal(again.notes().hopFar.ks.length, 2);
  // a hopFar of another shape: fresh
  const odd = branch(senses([{ id: 'p2', link: P2 }]), { v: 1, last: X.id, speeds: SPEEDS(), hopFar: { ks: ['x'], errs: [] } });
  odd.look(farSplit(3, 2.5));
  odd.look(farSplit(4, 2.5));
  assert.equal(odd.notes().hopFar.ks.length, 1);
});

// ---- fixture W: 2500 MB, 2 GB (readGb 2.1), each phone holds it; p1 and p2 far (links 200 and 300)
// measured on W: local 2, p1 12, p2 10 tok/s (GB/s 4.2, 25.2, 21). alone: pixel 12; apart: pixel and
// galaxy; split: this computer and pixel, all 2500 MB on pixel: c = 2100 / 25.2 = 83.333 ms
const W = model('w', 'W', 2500, 2 * GB);
const CW = 2100 / 25.2;
const SW = snap({ devices: [dev({ ramMb: 4000, via: 'internet' }), dev({ id: 'p2', name: 'galaxy', via: 'internet', ramMb: 4000 })], models: [W] });
const SPEEDS_W = () => ({ local: { [W.file]: { tps: 2, n: 5, at: AT } }, p1: { [W.file]: { tps: 12, n: 5, at: AT } }, p2: { [W.file]: { tps: 10, n: 5, at: AT } } });
const MEASURED_W = () => new Map<string, any[]>([['local', [{ file: W.file, tps: 2, n: 5 }]], ['p1', [{ file: W.file, tps: 12, n: 5 }]], ['p2', [{ file: W.file, tps: 10, n: 5 }]]]);
const sensesW = () => senses([{ id: 'p1', link: { srtt: 200, rttvar: 20 } }, { id: 'p2', link: { srtt: 300, rttvar: 30 } }]);
const cardOf = (v: any, topic: string, m = W) => v.suggestions.find((c: any) => c.id === `planner:${topic}:${m.id}`);

test('the far card: assumed, then learned', () => {
  const v: any = branch(sensesW(), { v: 1, last: W.id, speeds: SPEEDS_W() }).look(SW, decide.SHOW);
  const c = cardOf(v, 'far');
  assert.ok(c, JSON.stringify(v.suggestions.map((x: any) => x.id)));
  assert.equal(c.kind, 'suggest');
  assert.equal(c.weight, 1);
  assert.equal(c.action, null);
  // lo = 1000 / (83.333 + 200) = 3.53, hi = 1000 / (83.333 + 50) = 7.5
  assert.equal(c.title, 'far devices: split likely 3.5\u{2013}7.5 tok/s, apart ~12 tok/s each');
  assert.equal(c.why, 'each token waits about one round trip to each far worker (pixel). assumed from probes, 0 of 3 far split answers watched. apart keeps each answer on one device, 2 at once. you choose.');
  assert.deepEqual(cleanCard(c), c);
  assert.equal(cardOf(v, 'split'), undefined, 'the pessimistic end is not faster than alone');

  // learned: k 0.25 and four errs (q 0.4): est 1000 / (83.333 + 50) = 7.5, 7.5 / 1.4 to 7.5 / 0.6
  const H = { ks: [0.25, 0.25, 0.25], errs: [0.1, 0.2, 0.3, 0.4] };
  const lv: any = branch(sensesW(), { v: 1, last: W.id, speeds: SPEEDS_W(), hopFar: H }).look(SW, decide.SHOW);
  const l = cardOf(lv, 'far');
  assert.equal(l.title, `far devices: split likely ${r1(7.5 / 1.4)}\u{2013}${r1(7.5 / 0.6)} tok/s, apart ~12 tok/s each`);
  assert.equal(l.title, 'far devices: split likely 5.4\u{2013}12.5 tok/s, apart ~12 tok/s each');
  assert.equal(l.why, 'each token waits about one round trip to each far worker (pixel). learned from the last 4 far split answers watched. apart keeps each answer on one device, 2 at once. you choose.');
  const S = planner.plan(SW, fieldOf(SW, sensesW(), MEASURED_W()), W as any, true, undefined, H).split!;
  assert.equal(S.tps, r1(1000 / (CW + 50)));
  assert.deepEqual(S.far, { lo: 1000 / (CW + 50), hi: 1000 / (CW + 50), assumed: false });
});

test("the far card names a far link's missed probes from 20%", () => {
  const withLoss = (hi: number) => ({ ...sensesW(), connections: { hints: [{ id: 'p1', loss: { hi } }, { id: 'p2', loss: { hi: 0.9 } }] } });
  const c = cardOf(branch(withLoss(0.25), { v: 1, last: W.id, speeds: SPEEDS_W() }).look(SW, decide.SHOW), 'far');
  assert.ok(c.why.endsWith(" 2 at once. pixel's link missed up to 25% of probes: a split stops when one worker drops. you choose."), c.why);
  assert.doesNotMatch(c.why, /galaxy's link/, 'galaxy is not in the split');
  const d = cardOf(branch(withLoss(0.19), { v: 1, last: W.id, speeds: SPEEDS_W() }).look(SW, decide.SHOW), 'far');
  assert.doesNotMatch(d.why, /missed/);
});

test('a split card with a far worker ends with the range sentence, not the near one; no far card without alone or apart', () => {
  const s = farOnly('internet');
  const v: any = branch(senses([{ id: 'p2', link: P2 }]), { v: 1, last: X.id, speeds: SPEEDS() }).look(s, decide.SHOW);
  const c = cardOf(v, 'split', X);
  assert.ok(c, JSON.stringify(v.suggestions.map((x: any) => x.id)));
  assert.ok(c.why.endsWith(' split, ~1.8 tok/s (from the speeds they answered with). far devices: split likely 1.8\u{2013}2.5 tok/s; each token waits about one round trip to each far worker (galaxy), assumed from probes, 0 of 3 far split answers watched.'), c.why);
  assert.doesNotMatch(c.why, /links' cost/);
  assert.equal(cardOf(v, 'far', X), undefined);
});

test('no far seat, no far card', () => {
  const near2 = snap({ devices: [dev({ ramMb: 4000 }), dev({ id: 'p2', name: 'galaxy', ramMb: 4000 })], models: [W] });
  const v: any = branch(sensesW(), { v: 1, last: W.id, speeds: SPEEDS_W() }).look(near2, decide.SHOW);
  assert.equal(cardOf(v, 'far'), undefined);
  assert.ok(cardOf(v, 'apart'), 'the fixture still has apart');
  for (const strict of [true, false]) {
    const r = planner.plan(near2, fieldOf(near2, sensesW(), MEASURED_W()), W as any, strict, hop.freshHop(), hop.freshHop());
    assert.equal(r.cards.some((x: any) => x.id.startsWith('planner:far:')), false);
    assert.ok(r.split);
    assert.equal('far' in r.split!, false);
  }
});

// ---- far estimates are not facts (VERDICT 1, DO 2)
// W loaded split over this computer and pixel (far, link L): lo = 1000 / (CW + L), hi = 1000 / (CW + L / 4);
// alone: pixel 12 tok/s. L 40: lo 8.1, hi 10.7 (× GAIN 12.3 > 12); L 200: lo 3.5, hi 7.5 (× GAIN 8.6 < 12)
const loadedW = (tps: number | null, L: number) => {
  const s = snap({
    devices: [dev({ ramMb: 4000, via: 'internet' }), dev({ id: 'p2', name: 'galaxy', via: 'internet', ramMb: 4000 })], models: [W],
    work: {
      loaded: loaded(W, 'split', [here(tps), on('p1', 'pixel', null)], {
        parts: [{ id: 'local', name: 'this computer', local: true, mb: 0, layers: 0 }, { id: 'p1', name: 'pixel', local: false, mb: 2500, layers: 30 }],
      }),
    },
  });
  const peeks = senses([{ id: 'p1', link: { srtt: L, rttvar: 4 } }, { id: 'p2', link: { srtt: 300, rttvar: 30 } }]);
  return planner.plan(s, fieldOf(s, peeks, MEASURED_W()), W as any, true);
};
const aloneCard = (r: any) => r.cards.find((c: any) => c.id === `planner:alone:${W.id}`);

test('a loaded far split with no live tok/s: "alone is faster" only above the far range high end × GAIN', () => {
  const mid = loadedW(null, 40);
  assert.deepEqual(seatIds(mid.split), ['local', 'p1']);
  assert.ok(mid.split!.far!.assumed);
  near(mid.split!.far!.lo, 1000 / (CW + 40), 1e-9);
  near(mid.split!.far!.hi, 1000 / (CW + 10), 1e-9);
  assert.equal(mid.alone!.tps, 12);
  // alone between lo × GAIN and hi × GAIN: the k = 1 end would warn, the range does not
  assert.ok(12 >= mid.split!.tps! * decide.GAIN && 12 < mid.split!.far!.hi * decide.GAIN);
  assert.equal(aloneCard(mid), undefined);

  const high = loadedW(null, 200);
  const c = aloneCard(high);
  assert.ok(c, JSON.stringify(high.cards.map((x: any) => x.id)));
  assert.equal(c.kind, 'warn');
  assert.equal(c.title, 'split is slower than pixel alone for W');
  assert.equal(c.why, 'split answers at about 3.5\u{2013}7.5 tok/s (its far links assumed from probes); on pixel alone it would at ~12 (from the speeds they answered with), with no link to cross.');
  assert.deepEqual(cleanCard(c), c);
});

test('a loaded far split with a live tok/s: the alone card as before', () => {
  // live 8: 12 >= 8 × GAIN, even though the far range's high end × GAIN is above 12
  const c = aloneCard(loadedW(8, 40));
  assert.ok(c);
  assert.equal(c.why, 'split answers at 8 tok/s (measured); on pixel alone it would at ~12 (from the speeds they answered with), with no link to cross.');
  // live 11: 12 < 11 × GAIN, no card
  assert.equal(aloneCard(loadedW(11, 200)), undefined);
});

// Y: 5000 MB, 4 GB; this computer holds it alone at 1 tok/s; galaxy (far, cap 3000) answers 5 tok/s:
// c = 0.6 × 1000 / 5 + 0.4 × 1000 / 1 = 520 ms; + 150 (internet) = 1.49 tok/s, + 300 (anchor) = 1.22, both ≥ GAIN × 1
const Y = model('y', 'Y', 5000, 4 * GB);
const MEASURED_Y = () => new Map<string, any[]>([['local', [{ file: Y.file, tps: 1, n: 5 }]], ['p2', [{ file: Y.file, tps: 5, n: 5 }]]]);
const fastSplit = (via: string, peeks: Record<string, any>) => {
  const s = snap({ devices: [dev({ id: 'p2', name: 'galaxy', via, ramMb: 4000 })], models: [Y] });
  return planner.plan(s, fieldOf(s, peeks, MEASURED_Y()), Y as any, true);
};
const fasterCard = (r: any) => r.cards.find((c: any) => c.id === `planner:split:${Y.id}`);

test('no faster-split card while the far fit is assumed and a far seat has no link', () => {
  for (const [via, ms] of [['internet', 150], ['anchor', 300]] as const) {
    const r = fastSplit(via, {});
    assert.deepEqual(seatIds(r.split), ['local', 'p2'], via);
    assert.equal(r.split!.tps, r1(1000 / (520 + ms)), via);
    assert.equal(r.alone!.tps, 1);
    assert.ok(r.split!.tps! >= r.alone!.tps! * decide.GAIN, via);
    assert.equal(fasterCard(r), undefined, via);
    assert.equal(planner.farGuessed(r.split!), true);
  }
  // the same split with a link of 150 ms: a pessimistic end, so the card shows
  const l = fastSplit('internet', senses([{ id: 'p2', link: { srtt: 150, rttvar: 10 } }]));
  assert.equal(l.split!.tps, r1(1000 / 670));
  assert.equal(planner.farGuessed(l.split!), false);
  const c = fasterCard(l);
  assert.ok(c, JSON.stringify(l.cards.map((x: any) => x.id)));
  assert.equal(c.title, 'Y would run faster split over mac and galaxy: ~1.5 tok/s; alone here on mac ~1');
  // a learned far fit prices the assumed round trip: not a guess any more
  const H = { ks: [1, 1, 1], errs: [0.1, 0.1, 0.1] };
  const s = snap({ devices: [dev({ id: 'p2', name: 'galaxy', via: 'internet', ramMb: 4000 })], models: [Y] });
  const learned = planner.plan(s, fieldOf(s, {}, MEASURED_Y()), Y as any, true, undefined, H);
  assert.equal(planner.farGuessed(learned.split!), false);
  assert.ok(fasterCard(learned));
});

// Y with galaxy far over a measured link of 100 ms and a learned hopRtt (k 1): the point is
// 1000 / (520 + 100) = 1.61 tok/s, at least alone (1) × GAIN; farRange's lo is 1.61 / (1 + q)
test('a measured far split: the faster-split card needs the far range low end at alone, not only the point (DECISIONS 2 d)', () => {
  const s = snap({ devices: [dev({ id: 'p2', name: 'galaxy', via: 'internet', ramMb: 4000, linkRttMs: 100, linkAt: AT })], models: [Y] });
  const f = () => fieldOf(s, {}, MEASURED_Y());
  // q 0.7: lo 0.95, below alone: no card, though the point is 1.61 >= 1.15
  const wide = { ks: [1, 1, 1], errs: [0.7, 0.7, 0.7, 0.7] };
  const w = planner.plan(s, f(), Y as any, true, undefined, undefined, wide);
  assert.equal(w.split!.far!.link, true);
  assert.equal(w.split!.far!.assumed, false);
  assert.equal(w.split!.tps, r1(1000 / 620));
  assert.ok(w.split!.tps! >= w.alone!.tps! * decide.GAIN);
  assert.ok(planner.farRange(w.split!, undefined, wide)!.lo < w.alone!.tps!);
  assert.equal(fasterCard(w), undefined, JSON.stringify(w.cards.map((x: any) => x.id)));
  // q 0.4: lo 1.15, at or above alone: the card
  const tight = { ks: [1, 1, 1], errs: [0.4, 0.4, 0.4, 0.4] };
  const t = planner.plan(s, f(), Y as any, true, undefined, undefined, tight);
  assert.ok(planner.farRange(t.split!, undefined, tight)!.lo >= t.alone!.tps!);
  assert.ok(fasterCard(t), JSON.stringify(t.cards.map((x: any) => x.id)));
  // assumed (no hopRtt yet): the widened range's lo 1000 / (520 + 116) × 0.94 = 1.48 >= 1: the card
  const a = planner.plan(s, f(), Y as any, true);
  assert.equal(a.split!.far!.assumed, true);
  assert.ok(planner.farRange(a.split!, undefined)!.lo >= a.alone!.tps!);
  assert.ok(fasterCard(a));
  // the probe-priced chain (no measured link) stays as today: the point rule, though its range's lo is below alone
  const p = snap({ devices: [dev({ id: 'p2', name: 'galaxy', via: 'internet', ramMb: 4000 })], models: [Y] });
  const pr = planner.plan(p, fieldOf(p, senses([{ id: 'p2', link: { srtt: 100, rttvar: 10 } }]), MEASURED_Y()), Y as any, true, undefined, wide);
  assert.equal(pr.split!.far!.link, undefined);
  assert.ok(planner.farRange(pr.split!, wide)!.lo < pr.alone!.tps!);
  assert.ok(fasterCard(pr));
});

// ---- the measured link (17 Nov, P2): a far seat with a linkRttMs at most 7 days old is priced from it,
// 1.1 round trips per token in the range 0.95–1.16 while assumed; its own fit hopRtt
const DAY = 24 * 3600_000;
const R = 50;
const farMeasured = (via: string, o: Record<string, unknown> = {}) =>
  snap({ devices: [dev({ id: 'p2', name: 'galaxy', via, ramMb: 4000, linkRttMs: R, linkAt: AT - 3600_000, ...o })], models: [X] });

test('a far seat with a fresh measured link costs 1.1 x its round trip, range 1.16 to 0.95 widened by RTT_NOISE', () => {
  assert.equal(decide.RTT_TRIPS, 1.1);
  assert.equal(decide.RTT_TRIPS_LO, 0.95);
  assert.equal(decide.RTT_TRIPS_HI, 1.16);
  assert.equal(decide.RTT_NOISE, 0.06);
  const N = decide.RTT_NOISE;
  for (const via of ['internet', 'anchor']) {
    // the probe's srtt (P2, 200 ms) is there too: the measured link wins
    for (const peeks of [{}, senses([{ id: 'p2', link: P2 }])]) {
      const f = fieldOf(farMeasured(via), peeks);
      assert.equal(f.seats.find((x: any) => x.id === 'p2').rtt, R);
      for (const k of [undefined, 0.5]) {
        const p = decide.split(f, X, 1, k)!;
        assert.deepEqual(seatIds(p), ['local', 'p2'], via);
        assert.equal(p.tps, r1(1000 / (C + 1.1 * R)), `${via} k ${k}`);
        // while assumed, an answer's own scatter too: the slow end × (1 − N), the fast end × (1 + N)
        assert.deepEqual(p.far, { lo: (1000 / (C + 1.16 * R)) * (1 - N), hi: (1000 / (C + 0.95 * R)) * (1 + N), assumed: true, link: true });
        // a learned probe fit does not price a measured link
        assert.deepEqual(decide.split(f, X, 1, k, 0.25), p);
      }
      // a learned measured-link fit: one number, not assumed
      const q = decide.split(f, X, 1, undefined, 0.25, 1.3)!;
      assert.deepEqual(q.far, { lo: 1000 / (C + 1.3 * R), hi: 1000 / (C + 1.3 * R), assumed: false, link: true });
      assert.equal(q.tps, r1(1000 / (C + 1.3 * R)));
      assert.equal(planner.farGuessed(decide.split(f, X, 1)!), false, 'a measured link is not a guess');
    }
  }
});

test('a measured link older than 7 days, null, or on a near seat changes nothing', () => {
  const probe = decide.split(fieldOf(farOnly('internet'), senses([{ id: 'p2', link: P2 }])), X, 1, 1)!;
  const none = decide.split(fieldOf(farOnly('internet'), {}), X, 1, 1)!;
  for (const o of [{ linkAt: AT - 8 * DAY }, { linkRttMs: null }, { linkRttMs: 0 }, { linkAt: null }, { linkAt: AT + 10 * 60_000 }, { linkRttMs: NaN }]) {
    const fp = fieldOf(farMeasured('internet', o), senses([{ id: 'p2', link: P2 }]));
    assert.equal('rtt' in fp.seats.find((x: any) => x.id === 'p2'), false, JSON.stringify(o));
    assert.deepEqual(decide.split(fp, X, 1, 1), probe, JSON.stringify(o));
    assert.deepEqual(decide.split(fieldOf(farMeasured('internet', o), {}), X, 1, 1), none, JSON.stringify(o));
  }
  // exactly 7 days old is still used
  assert.equal(fieldOf(farMeasured('internet', { linkAt: AT - 7 * DAY }), {}).seats.find((x: any) => x.id === 'p2').rtt, R);
  // a near seat keeps its pricing
  const s = snap({ devices: [dev({ ramMb: 4000, linkRttMs: 5, linkAt: AT }), dev({ id: 'p2', name: 'galaxy', ramMb: 4000, linkRttMs: 7, linkAt: AT })], models: [X] });
  const t = snap({ devices: [dev({ ramMb: 4000 }), dev({ id: 'p2', name: 'galaxy', ramMb: 4000 })], models: [X] });
  for (const k of [undefined, 1, 0.5]) assert.deepEqual(decide.split(fieldOf(s), X, 1, k, 0.25, 2), decide.split(fieldOf(t), X, 1, k), `k ${k}`);
});

test('a split with one measured far link and one probed: no link flag, each priced in its own unit', () => {
  // pixel far by probe (srtt 20), galaxy far with a measured link of 50; each phone cap 3000, host 5600
  const s = snap({ devices: [dev({ via: 'internet', ramMb: 2000 }), dev({ id: 'p2', name: 'galaxy', via: 'anchor', ramMb: 2000, linkRttMs: R, linkAt: AT })], models: [X] });
  const f = fieldOf(s);
  const p = decide.split(f, X, 1, 1)!;
  assert.deepEqual(seatIds(p).sort(), ['local', 'p1', 'p2']);
  const c = p.chain!.computeMs;
  assert.equal(p.far!.link, undefined);
  assert.equal(p.far!.assumed, true);
  near(p.far!.lo, 1000 / (c + 1 * 20 + 1.16 * R), 1e-9);
  near(p.far!.hi, 1000 / (c + 0.25 * 20 + 0.95 * R), 1e-9);
  assert.equal(p.tps, r1(1000 / (c + 20 + 1.1 * R)));
  // the probe fit learned, the measured one not: still assumed
  assert.equal(decide.split(f, X, 1, 1, 0.3)!.far!.assumed, true);
  assert.equal(decide.split(f, X, 1, 1, 0.3, 1)!.far!.assumed, false);
});

// a split loaded over this computer and p2 (far, measured link R, probe srtt 200)
const farSplitR = (done: number, tps: number | null, o: Record<string, unknown> = {}) => snap({
  devices: [dev({ id: 'p2', name: 'galaxy', via: 'anchor', ramMb: 4000, linkRttMs: R, linkAt: AT, ...o })], models: [X],
  work: {
    loaded: loaded(X, 'split', [here(tps, done), on('p2', 'galaxy', null, done)], {
      parts: [{ id: 'local', name: 'this computer', local: true, mb: 3000, layers: 18 }, { id: 'p2', name: 'galaxy', local: false, mb: 3000, layers: 18 }],
    }),
  },
});

test('a chain whose far links are all measured teaches hopRtt only; loadedChain says the round trips', () => {
  const s = farSplitR(3, 2.5);
  const c = decide.loadedChain(s, fieldOf(s, {}), X)!;
  near(c.computeMs, C, 1e-9);
  assert.deepEqual(c.far, [true]);
  assert.deepEqual(c.rtt, [R]);
  assert.deepEqual(c.links, [{ srtt: R, rttvar: 0 }], 'no srtt: the measured link stands in');
  assert.deepEqual(decide.loadedChain(s, fieldOf(s, senses([{ id: 'p2', link: P2 }])), X)!.links, [P2]);

  const preset = () => ({ v: 1, last: X.id, speeds: SPEEDS() });
  const b = branch(senses([{ id: 'p2', link: P2 }]), preset());
  for (let d = 3; d <= 6; d++) b.look(farSplitR(d, 2.5));
  const n = b.notes();
  assert.equal(n.hop, undefined);
  assert.equal(n.hopFar, undefined, 'the probe fit learns nothing from a measured chain');
  assert.equal(n.hopRtt.ks.length, 3);
  // k = (1000 / 2.5 - 350) / 50 = 1
  for (const k of n.hopRtt.ks) near(k, 1, 1e-9);

  // the same chain without a fresh measured link teaches hopFar as before
  const o = branch(senses([{ id: 'p2', link: P2 }]), preset());
  for (let d = 3; d <= 6; d++) o.look(farSplitR(d, 2.5, { linkAt: AT - 8 * DAY }));
  assert.equal(o.notes().hopRtt, undefined);
  for (const k of o.notes().hopFar.ks) near(k, 0.25, 1e-9);

  // a mixed chain (pixel far by probe, galaxy measured): hopFar, galaxy's round trip in the compute at 1.1
  const s3 = (done: number) => snap({
    devices: [dev({ via: 'internet', ramMb: 4000 }), dev({ id: 'p2', name: 'galaxy', via: 'anchor', ramMb: 4000, linkRttMs: R, linkAt: AT })], models: [X],
    work: {
      loaded: loaded(X, 'split', [here(2.5, done), on('p1', 'pixel', null, done), on('p2', 'galaxy', null, done)], {
        parts: [{ id: 'local', name: 'this computer', local: true, mb: 2000, layers: 12 }, { id: 'p1', name: 'pixel', local: false, mb: 2000, layers: 12 }, { id: 'p2', name: 'galaxy', local: false, mb: 2000, layers: 12 }],
      }),
    },
  });
  const m = branch(senses(), preset());
  m.look(s3(3));
  m.look(s3(4));
  const c3 = 1400 / 8.4 + 1400 / 25.2 + 1400 / 21;
  near(m.notes().hopFar.ks[0], (400 - c3 - 1.1 * R) / 20, 1e-9);
  assert.equal(m.notes().hopRtt, undefined);
});

test('the far card says "from the measured link", assumed then learned; hopRtt survives a reload', () => {
  // W over pixel (far, measured 40 ms): c = 83.333; lo 1000 / (c + 46.4) × 0.94, hi 1000 / (c + 38) × 1.06
  const SR = snap({ devices: [dev({ ramMb: 4000, via: 'internet', linkRttMs: 40, linkAt: AT }), dev({ id: 'p2', name: 'galaxy', via: 'internet', ramMb: 4000, linkRttMs: 60, linkAt: AT })], models: [W] });
  const v: any = branch(sensesW(), { v: 1, last: W.id, speeds: SPEEDS_W() }).look(SR, decide.SHOW);
  const c = cardOf(v, 'far');
  assert.ok(c, JSON.stringify(v.suggestions.map((x: any) => x.id)));
  assert.equal(c.title, `far devices: split likely ${r1((1000 / (CW + 46.4)) * 0.94)}\u{2013}${r1((1000 / (CW + 38)) * 1.06)} tok/s, apart ~12 tok/s each`);
  assert.equal(c.title, 'far devices: split likely 7.2\u{2013}8.7 tok/s, apart ~12 tok/s each');
  assert.equal(c.why, 'each token waits about one round trip to each far worker (pixel). from the measured link (about 1.1 round trips per token), 0 of 3 far split answers watched. apart keeps each answer on one device, 2 at once. you choose.');
  assert.deepEqual(cleanCard(c), c);

  // learned: kRtt 1 and four errs (q 0.4): est 1000 / (83.333 + 40) = 8.1, 8.1 / 1.4 to 8.1 / 0.6
  const H = { ks: [1, 1, 1], errs: [0.1, 0.2, 0.3, 0.4] };
  const b = branch(sensesW(), { v: 1, last: W.id, speeds: SPEEDS_W(), hopRtt: H, hopFar: { ks: [9, 9, 9], errs: [0.9] } });
  const l = cardOf(b.look(SR, decide.SHOW), 'far');
  const est = 1000 / (CW + 40);
  assert.equal(l.title, `far devices: split likely ${r1(est / 1.4)}\u{2013}${r1(est / 0.6)} tok/s, apart ~12 tok/s each`);
  assert.equal(l.why, 'each token waits about one round trip to each far worker (pixel). from the measured link, learned from the last 4 far split answers watched. apart keeps each answer on one device, 2 at once. you choose.');
  assert.deepEqual(b.notes()?.hopRtt ?? H, H);
  // the words of a split card with a measured far link
  const S = planner.plan(SR, fieldOf(SR, sensesW(), MEASURED_W()), W as any, true).split!;
  assert.match(planner.farWords(SR, S, undefined), / far devices: split likely 7\.2\u{2013}8\.7 tok\/s; each token waits about one round trip to each far worker \(pixel\), from the measured link \(about 1\.1 round trips per token\), 0 of 3 far split answers watched\.$/u);
  // probes only: the old words
  assert.match(planner.farWords(SW, planner.plan(SW, fieldOf(SW, sensesW(), MEASURED_W()), W as any, true).split!, undefined), /assumed from probes/);

  // an old notes file without hopRtt loads; hopRtt survives a reload
  const preset = { v: 1, last: X.id, speeds: SPEEDS() };
  const r = branch({}, structuredClone(preset));
  r.look(farSplitR(3, 2.5));
  r.look(farSplitR(4, 2.5));
  assert.equal(r.notes().hopRtt.ks.length, 1);
  const again = branch({}, structuredClone(r.notes()));
  again.look(farSplitR(3, 2.5));
  again.look(farSplitR(4, 2.5));
  assert.equal(again.notes().hopRtt.ks.length, 2);
  const odd = branch({}, { ...structuredClone(preset), hopRtt: { ks: [-1], errs: [] } });
  odd.look(farSplitR(3, 2.5));
  odd.look(farSplitR(4, 2.5));
  assert.equal(odd.notes().hopRtt.ks.length, 1);
});
