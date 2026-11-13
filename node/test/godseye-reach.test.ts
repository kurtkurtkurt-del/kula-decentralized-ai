// learning's reach guess, blended (L7 P41): reach.ts's four experts, their blend and interval, the
// exponential weights with a fixed share, the notes check, and the mix carried in learning.ts's
// notes without changing anything learning says.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { freshMix, reachExperts, reachBlend, reachLearn, reachStep, saneMix } = await import('../src/godseye/branches/reach.ts');
const { create } = await import('../src/godseye/branches/learning.ts');

type Mix = ReturnType<typeof freshMix>;

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

/** the worked example: n 3, s 2, t [0,1,1,1], last 1, e 0.6 */
const example = (): Mix => ({ ...freshMix(), n: 3, s: 2, t: [0, 1, 1, 1], last: 1, e: 0.6 });

/** a seeded stream in [0,1) (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('experts by hand: mean, v1, slow, markov', () => {
  const ex = reachExperts(example(), 0.7, 0.3);
  const p = [0.625, 0.7, 0.6, 0.5];
  const c = [4, 5.666667, 39, 3];
  for (let k = 0; k < 4; k++) {
    near(ex.p[k], p[k], 1e-12, `p${k}`);
    near(ex.c[k], c[k], 1e-6, `c${k}`);
  }
  // with no last outcome the markov expert is the mean
  const none = reachExperts({ ...example(), last: null }, 0.7, 0.3);
  assert.equal(none.p[3], none.p[0]);
  assert.equal(none.c[3], none.c[0]);
  // last 0: a = t[1] = 1 of b = t[0] + a = 1, so p 1.5/2, c 2
  const zero = reachExperts({ ...example(), last: 0 }, 0.7, 0.3);
  near(zero.p[3], 0.75, 1e-12, 'markov after 0');
  near(zero.c[3], 2, 1e-12, 'markov c after 0');
});

test('blend: a unit vector gives that expert\'s p and nu = c; uniform weights by hand', () => {
  const ex = reachExperts(example(), 0.7, 0.3);
  for (let k = 0; k < 4; k++) {
    const w = [0, 0, 0, 0];
    w[k] = 1;
    const b = reachBlend(ex, w);
    near(b.q, ex.p[k], 1e-12, `q of expert ${k}`);
    near(b.nu, ex.c[k], 1e-9, `nu of expert ${k}`);
    assert.ok(b.lo <= b.q && b.q <= b.hi, `expert ${k}: ${b.lo} ${b.q} ${b.hi}`);
  }
  // uniform: q = 2.425/4 = 0.60625; V = 0.041836, nu = 0.238711/V - 1 = 4.7059; Wilson at 1.2816
  // gives mid 0.578761 and half 0.250033
  const u = reachBlend(ex, [0.25, 0.25, 0.25, 0.25]);
  near(u.q, 0.60625, 1e-12, 'uniform q');
  near(u.nu, 4.7059, 1e-3, 'uniform nu');
  near(u.lo, 0.32873, 1e-4, 'uniform lo');
  near(u.hi, 0.82879, 1e-4, 'uniform hi');
  assert.ok(0 <= u.lo && u.lo <= u.q && u.q <= u.hi && u.hi <= 1);
  // all experts at certainty: V is 0, nu 1e6
  const sure = reachBlend({ p: [1, 1, 1, 1], c: [5, 5, 5, 5] }, [0.25, 0.25, 0.25, 0.25]);
  assert.equal(sure.nu, 1e6);
  near(sure.hi, 1, 1e-9, 'sure hi');
  assert.ok(sure.lo > 0.999 && sure.lo <= sure.hi);
  // uniform weights over seeded experts: always 0 <= lo <= q <= hi <= 1
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const e = { p: [r(), r(), r(), r()] as [number, number, number, number], c: [1 + 50 * r(), 1 + 50 * r(), 39, 1 + 50 * r()] as [number, number, number, number] };
    const b = reachBlend(e, [0.25, 0.25, 0.25, 0.25]);
    assert.ok(0 <= b.lo && b.lo <= b.q && b.q <= b.hi && b.hi <= 1, `round ${i}: ${b.lo} ${b.q} ${b.hi}`);
    assert.ok(b.nu >= 1 && b.nu <= 1e6);
  }
});

test('learn: the expert nearest the outcome gains, the weights sum to 1, the share keeps a floor', () => {
  const ex = reachExperts(example(), 0.7, 0.3);
  const w = reachLearn([0.25, 0.25, 0.25, 0.25], ex.p, 1);
  assert.ok(w[1] > 0.25 && w[1] === Math.max(...w), `v1 (0.7) gains: ${w}`);
  assert.ok(w[3] < 0.25 && w[3] === Math.min(...w), `markov (0.5) loses: ${w}`);
  near(w.reduce((a, b) => a + b, 0), 1, 1e-12, 'sum');
  // 2000 rounds where expert 0 is always right: the others stay at or above 0.001/4
  let v: number[] = [0.25, 0.25, 0.25, 0.25];
  const r = rng(3);
  for (let i = 0; i < 2000; i++) {
    const y = r() < 0.5 ? 1 : 0;
    v = reachLearn(v, [y, 1 - y, 1 - y, 1 - y], y as 0 | 1);
    near(v.reduce((a, b) => a + b, 0), 1, 1e-12, `sum at ${i}`);
  }
  for (const x of v) assert.ok(x >= 0.001 / 4, `floor: ${v}`);
  assert.ok(v[0] > 0.99, `the right expert leads: ${v}`);
});

test('learn: regret over 500 seeded rounds is at most the best expert\'s + 3.8', () => {
  // bound 2(ln 4 + 500 ln(1/0.999)) = 3.773
  for (const seed of [1, 2, 3]) {
    const r = rng(seed);
    let w: number[] = [0.25, 0.25, 0.25, 0.25];
    let blend = 0;
    const own = [0, 0, 0, 0];
    for (let i = 0; i < 500; i++) {
      // experts of different quality and a regime that changes halfway
      const truth = i < 250 ? 0.85 : 0.3;
      const p: [number, number, number, number] = [truth, r(), 0.5, Math.min(1, Math.max(0, truth + 0.3 * (r() - 0.5)))];
      const y = (r() < truth ? 1 : 0) as 0 | 1;
      const q = reachBlend({ p, c: [10, 10, 10, 10] }, w).q;
      blend += (q - y) ** 2;
      for (let k = 0; k < 4; k++) own[k] += (p[k] - y) ** 2;
      w = reachLearn(w, p, y);
    }
    const best = Math.min(...own);
    assert.ok(blend <= best + 3.8, `seed ${seed}: blend ${blend} best ${best} own ${own}`);
  }
});

test('step by hand: counts, transitions, the slow average, rounded blend', () => {
  const m = { ...example(), w: [0.25, 0.25, 0.25, 0.25] as [number, number, number, number] };
  const ex = reachExperts(m, 0.7, 0.3);
  const next = reachStep(m, ex, 1, 0.79, 0.3);
  assert.equal(next.n, 4);
  assert.equal(next.s, 3);
  assert.deepEqual(next.t, [0, 1, 1, 2]);
  assert.equal(next.last, 1);
  near(next.e, 0.62, 1e-12, 'e');
  assert.deepEqual(next.w, reachLearn(m.w, ex.p, 1));
  const b = reachBlend(reachExperts(next, 0.79, 0.3), next.w);
  assert.equal(next.q, Math.round(b.q * 1e4) / 1e4);
  assert.equal(next.lo, Math.round(b.lo * 1e4) / 1e4);
  assert.equal(next.hi, Math.round(b.hi * 1e4) / 1e4);
  assert.deepEqual(m.t, [0, 1, 1, 1], 'the old mix is not changed');
  // the first outcome: e is the outcome, no transition yet
  const f = freshMix();
  const one = reachStep(f, reachExperts(f, 1, 0.3), 0, 0.7, 0.3);
  assert.equal(one.e, 0);
  assert.deepEqual(one.t, [0, 0, 0, 0]);
  assert.equal(one.last, 0);
  assert.ok(saneMix(one) !== null && saneMix(next) !== null);
});

test('saneMix: what this file wrote comes back, anything else is null', () => {
  const good = reachStep(example(), reachExperts(example(), 0.7, 0.3), 1, 0.79, 0.3);
  assert.deepEqual(saneMix(JSON.parse(JSON.stringify(good))), good);
  assert.deepEqual(saneMix(freshMix()), freshMix());
  const bad: unknown[] = [
    null, 7, 'x', [], {},
    { ...good, t: [0, 1, 1] },
    { ...good, t: [0, 1, 1, 'x'] },
    { ...good, w: [0.5, 0.5, 0] },
    { ...good, w: [0.25, 0.25, 0.25, 0.3] },
    { ...good, w: [0.5, 0.5, 0.5, -0.5] },
    { ...good, n: NaN },
    { ...good, e: NaN },
    { ...good, q: NaN },
    { ...good, w: [NaN, 0.25, 0.25, 0.25] },
    { ...good, s: good.n + 1 },
    { ...good, n: -1 },
    { ...good, t: [0, -1, 1, 2] },
    { ...good, n: 2.5 },
    { ...good, last: 2 },
    { ...good, lo: 0.9, hi: 0.8 },
    { ...good, q: 1.5 },
  ];
  for (const x of bad) assert.equal(saneMix(x), null, JSON.stringify(x));
});

// ---- through learning.ts

const A = '111101111110011111111000011111111111101111111111110111111110';
const B = '110011100111000111101010011100011111000001111111011111001110';
const dv = (id: string, name: string, reachable: boolean, checkedAt: number) => ({
  id, name, kind: 'phone', via: 'wifi', where: '', reachable, reachMs: 12, reason: null, checkedAt, lastOk: null,
  ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null,
});
const look = (t: number, i: number) => ({
  at: t, host: { name: 'mac', freeMb: 4000 }, devices: [dv('a', 'alpha', A[i] === '1', t), dv('b', 'beta', B[i] === '1', t)],
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [],
});
function seat(stored: unknown = null) {
  const s = { t: 0, stored, events: [] as string[] };
  const ctx = {
    now: () => s.t,
    load: <T>(fb: T): T => (s.stored ?? fb) as T,
    save: (d: unknown) => { s.stored = JSON.parse(JSON.stringify(d)); },
    emit: (x: string) => { s.events.push(x); },
    peek: () => null,
  };
  return { s, b: create(ctx as any) };
}
const fields = (r: any) => ({ alpha: r.alpha, fast: r.fast, slow: r.slow, n: r.n, emittedAlpha: r.emittedAlpha, p: r.p, hits: r.hits, at: r.at });

// a run of the code before P41 (learning.ts at 808a50e) on the same 60 looks
const HEAD = {
  a: { alpha: 0.75, fast: 0.329, slow: 0.177, n: 59, emittedAlpha: 0.605, p: 0.25, hits: '11101111110101111111011101111111111100111111111110011111110', at: 3600000 },
  b: { alpha: 0.8, fast: 0.532, slow: 0.369, n: 59, emittedAlpha: 0.605, p: 0.198, hits: '10001101011011011100000101101101111011110111111001111010110', at: 3600000 },
  pa: '1,1,1,1,0.7,0.804,0.882,0.936,0.97,0.988,0.996,0.199,0.04,0.808,0.962,0.992,0.998,1,1,1,1,0.211,0.042,0.008,0.002,0.8,0.96,0.992,0.998,1,1,1,1,1,1,1,1,0.389,0.819,0.964,0.993,0.999,1,1,1,1,1,1,1,1,0.389,0.819,0.964,0.993,0.999,1,1,1,1,0.25',
  stat: 'reachability right 73%',
  gauge: 73,
  rows: [['guesses scored', '118'], ['devices it learns', '2'], ['forecast scored', '0 hours'], ['forecast skill', 'nothing to score yet'], ['forecast calibration', 'not enough scored hours yet (0 of 24)']],
  lines: ['alpha \u{b7} reach right 83% of 59 \u{b7} \u{3b1} 0.75', 'beta \u{b7} reach right 63% of 59 \u{b7} \u{3b1} 0.8'],
  last: { at: 3600000, text: 'guessed beta would answer, it did not; reachability changes, it adapts faster (\u{3b1} 0.8 \u{2192} 0.8)' },
  good: false,
  events: [
    'learning: alpha\'s reachability is changing, it adapts faster (\u{3b1} 0.3 \u{2192} 0.61)',
    'learning: beta\'s reachability is changing, it adapts faster (\u{3b1} 0.3 \u{2192} 0.61)',
  ],
};

test('through learning.ts: the notes gain reach.m, and everything learning says is what it said before', () => {
  const { s, b } = seat();
  const pa: number[] = [];
  for (let i = 0; i < A.length; i++) {
    s.t = 60_000 * (i + 1);
    b.observe(look(s.t, i) as any, null);
    const st = s.stored as any;
    pa.push(st?.devices?.a?.reach?.p);
    if (i === 1) {
      for (const id of ['a', 'b']) {
        const m = st.devices[id].reach.m;
        assert.ok(m && saneMix(m) !== null, `${id} holds a sane m after the second probe`);
        assert.equal(m.n, 1);
      }
    }
  }
  const st = s.stored as any;
  assert.deepEqual(fields(st.devices.a.reach), HEAD.a);
  assert.deepEqual(fields(st.devices.b.reach), HEAD.b);
  assert.equal(pa.join(','), HEAD.pa);
  const v = b.view();
  assert.equal(v.stat, HEAD.stat);
  assert.equal(v.gauge, HEAD.gauge);
  assert.deepEqual(v.rows, HEAD.rows);
  assert.deepEqual(v.lines, HEAD.lines);
  assert.ok(v.note!.endsWith(`): ${HEAD.last.text}`), v.note!);
  assert.deepEqual(st.last, HEAD.last);
  assert.equal(st.good, HEAD.good);
  assert.deepEqual(s.events, HEAD.events);
  // the mix counted every probe after the first and its blend is what reach.ts gives
  const m = saneMix(st.devices.a.reach.m)!;
  assert.equal(m.n, A.length - 1);
  assert.equal(m.s, [...A.slice(1)].filter((c) => c === '1').length);
  assert.equal(m.t.reduce((x, y) => x + y, 0), A.length - 2);
  assert.ok(m.lo <= m.q && m.q <= m.hi);
});

test('through learning.ts: old notes without m get one at the next probe; a bad m is dropped and the device stays', () => {
  const first = seat();
  for (let i = 0; i < 10; i++) { first.s.t = 60_000 * (i + 1); first.b.observe(look(first.s.t, i) as any, null); }
  const saved = first.s.stored as any;
  assert.ok(saved.devices.a.reach.m && saved.devices.b.reach.m);

  // old notes: a has no m, b a bad one (weights not summing to 1)
  const old = JSON.parse(JSON.stringify(saved));
  delete old.devices.a.reach.m;
  old.devices.b.reach.m.w = [1, 0, 0, 0.5];
  const before = { a: fields(old.devices.a.reach), b: fields(old.devices.b.reach) };

  // the same notes with a sane m: what learning says next must not depend on m at all
  const twin = seat(JSON.parse(JSON.stringify(saved)));
  const next = seat(old);
  for (const x of [twin, next]) { x.s.t = 60_000 * 11; x.b.observe(look(x.s.t, 10) as any, null); }

  const st = next.s.stored as any;
  for (const id of ['a', 'b'] as const) {
    assert.ok(st.devices[id], `${id} stays`);
    const m = saneMix(st.devices[id].reach.m);
    assert.ok(m !== null, `${id} has a sane m again`);
    assert.equal(m!.n, 1, `${id}: a fresh mix, one probe`);
    assert.equal(st.devices[id].reach.n, before[id].n + 1);
    assert.deepEqual(fields(st.devices[id].reach), fields((twin.s.stored as any).devices[id].reach));
  }
  assert.deepEqual(next.b.view(), twin.b.view());
  assert.equal(saneMix((twin.s.stored as any).devices.a.reach.m)!.n, 10);
});
