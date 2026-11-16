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
