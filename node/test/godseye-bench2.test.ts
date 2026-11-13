// the brain bench v2 (L6 P32): every scenario of test/brain-bench/synth2.ts through the senses,
// learning and connections branches, scored by test/brain-bench/bench2.ts and printed as a
// scorecard: learning's speed interval, its reachability guess, and the link latency guesses.
// The thresholds below are the design's predictions; a scenario is never tuned to pass them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runBench2, fromSnapshots, scorecard2Text } = await import('./brain-bench/bench2.ts');
const { scenario2, SCENARIOS2, reachRate } = await import('./brain-bench/synth2.ts');

type Card = ReturnType<typeof runBench2>;
type Name = (typeof SCENARIOS2)[number];

const run = (name: Name, seed: number): Card => runBench2(fromSnapshots(scenario2(name, seed)), { rate: (id: string) => reachRate(name, id) });

// seed 1 of every scenario, run once and shared by the tests below
const cards = new Map<Name, Card>();
const card = (name: Name): Card => {
  let c = cards.get(name);
  if (c === undefined) { c = run(name, 1); cards.set(name, c); }
  return c;
};

test('the scorecard v2 of every scenario, seed 1', () => {
  for (const name of SCENARIOS2) console.log(scorecard2Text(`${name} seed 1`, card(name)));
});

test('1: the same seed gives the same scorecard, another seed another one', () => {
  for (const name of SCENARIOS2) {
    assert.deepStrictEqual(run(name, 1), card(name), `${name}: seed 1 twice`);
    assert.notDeepStrictEqual(run(name, 2), card(name), `${name}: seed 2`);
  }
});

test('2: speed, p2\'s 80% interval covers about 80%', () => {
  const s = card('speed').speed;
  console.log(`p1 interval: ${JSON.stringify(s.p1)}`);
  const p2 = s.p2;
  assert.ok(p2.n >= 300, `n ${p2.n}`);
  assert.ok((p2.cover80 as number) >= 0.70 && (p2.cover80 as number) <= 0.92, `cover80 ${p2.cover80}`);
});

test('3: reach, steady: the guess is no worse than the last outcome', () => {
  const r = card('reach').reach;
  console.log(`bursty reach: ${JSON.stringify(r.bursty)}`);
  const s = r.steady;
  assert.ok(s.n >= 1000, `n ${s.n}`);
  assert.ok((s.brier as number) <= (s.brierNaive as number), `brier ${s.brier} vs brierNaive ${s.brierNaive}`);
});

test('4: far, near: connections is no further off than the last ms; far is scored and finite', () => {
  const l = card('far').latency;
  console.log(`far lag: ${JSON.stringify(l.far.lag)} · near lag: ${JSON.stringify(l.near.lag)}`);
  const near = l.near;
  assert.ok((near.connections.pctOff as number) <= (near.naive.pctOff as number), `connections ${near.connections.pctOff} vs naive ${near.naive.pctOff}`);
  const far = l.far;
  assert.ok(far.n >= 1000, `n ${far.n}`);
  for (const k of ['connections', 'senses', 'naive'] as const) {
    for (const v of [far[k].pctOff, far[k].mae]) assert.ok(typeof v === 'number' && Number.isFinite(v), `far ${k} ${v}`);
  }
});

// ---- L7 P41: learning's reach guess, blended (reach.ts), beside today's guess (v1)

// seed 1's v1 reach rows, copied at full precision from a run of the code before P41
// (they round to node-test6.log:262-267); the blend must leave them exactly as they were
const V1_REACH = {
  steady: { scen: 'reach', brier: 0.06142583866481221, brierNaive: 0.10152990264255911, brierBase: 0.050341654963075744, hit: 0.933240611961057 },
  bursty: { scen: 'reach', brier: 0.08613162239221132, brierNaive: 0.09596662030598054, brierBase: 0.11190376704322665, hit: 0.8963838664812239 },
  far: { scen: 'far', brier: 0.030357214881780538, brierNaive: 0.0584144645340751, brierBase: 0.029073585466893596, hit: 0.9700973574408901 },
} as const;
type ReachId = keyof typeof V1_REACH;
const row = (id: ReachId) => card(V1_REACH[id].scen).reach[id];
const num = (x: number | null): number => { assert.ok(typeof x === 'number' && Number.isFinite(x), `not a number: ${x}`); return x as number; };
const said = (id: ReachId): string => {
  const r = row(id);
  return `${id}: brier ${r.brier} brierBase ${r.brierBase} brierNaive ${r.brierNaive} hit ${r.hit} | brierBlend ${r.brierBlend} hitBlend ${r.hitBlend} cover80 ${r.cover80} width80 ${r.width80} experts ${JSON.stringify(r.experts)}`;
};

test('P41: the blend\'s rows, seed 1 and seed 2 (printed)', () => {
  for (const seed of [1, 2]) {
    for (const [id, v] of Object.entries(V1_REACH)) {
      const r = (seed === 1 ? card(v.scen) : run(v.scen, 2)).reach[id];
      console.log(`seed ${seed} ${id}: v1 brier ${r.brier} \u{b7} blend ${r.brierBlend} \u{b7} hit ${r.hit} / ${r.hitBlend} \u{b7} cover80 ${r.cover80} width80 ${r.width80} \u{b7} experts mean ${r.experts[0]} v1 ${r.experts[1]} slow ${r.experts[2]} markov ${r.experts[3]}`);
    }
  }
});

test('P41: the v1 columns are what they were before the blend', () => {
  for (const id of Object.keys(V1_REACH) as ReachId[]) {
    const r = row(id);
    const v = V1_REACH[id];
    for (const k of ['brier', 'brierNaive', 'brierBase', 'hit'] as const) {
      assert.ok(Math.abs(num(r[k]) - v[k]) <= 1e-9, `${id} ${k}: ${r[k]} vs ${v[k]}`);
    }
    // the v1 expert is today's guess itself
    assert.ok(Math.abs(num(r.experts[1]) - v.brier) <= 1e-12, `${id} v1 expert ${r.experts[1]} vs ${v.brier}`);
  }
});

test('P41 R1: steady, the blend beats today\'s guess and is within 0.004 of the running mean', () => {
  const r = row('steady');
  assert.ok(num(r.brierBlend) < num(r.brier), said('steady'));
  assert.ok(num(r.brierBlend) <= num(r.brierBase) + 0.004, said('steady'));
});

test('P41 R2: bursty, the blend is within 0.004 of today\'s guess and no worse than the last outcome', () => {
  const r = row('bursty');
  assert.ok(num(r.brierBlend) <= num(r.brier) + 0.004, said('bursty'));
  assert.ok(num(r.brierBlend) <= num(r.brierNaive), said('bursty'));
});

test('P41 R3: far, the blend is within 0.004 of today\'s guess and of the running mean', () => {
  const r = row('far');
  assert.ok(num(r.brierBlend) <= num(r.brier) + 0.004, said('far'));
  assert.ok(num(r.brierBlend) <= num(r.brierBase) + 0.004, said('far'));
});

test('P41 R4: the blend\'s hits are at most 0.01 below today\'s', () => {
  for (const id of Object.keys(V1_REACH) as ReachId[]) {
    const r = row(id);
    assert.ok(num(r.hitBlend) >= num(r.hit) - 0.01, said(id));
  }
});

test('P41 R5 (prediction): the 80% interval holds the true rate at least 70% of the looks on steady and far', () => {
  for (const id of ['steady', 'far'] as const) {
    const r = row(id);
    assert.ok(num(r.cover80) >= 0.70, said(id));
    assert.ok(num(r.width80) > 0, said(id));
  }
  assert.equal(row('bursty').cover80, null);
});
