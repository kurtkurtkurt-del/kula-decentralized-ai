// the brain bench v2 (L6 P32): the three numbers bench v1 did not have. A stream of looks is fed
// to the senses, learning and connections branches (the eye's order), each on its own ctx on the
// look's clock with an eager seat (every save kept as JSON, tagged with the look index). A guess
// counts only when its notes were saved at the look before; otherwise the reading is `skipped`.
//  - speed interval: learning's speed est and its last errs (|tps-est|/tps) give a split-conformal
//    80% interval, the exact inversion of learning's own error: q = the r-th smallest err with
//    r = ceil(0.8(m+1)), lo = est/(1+q), hi = est/(1-q) (open when q >= 1); no interval when r > m.
//    Scored with cover, width and the Winkler score, beside a fixed [est/1.2, est/0.8].
//  - reach: learning's reach.p against the outcome, beside the last outcome and the running mean.
//  - link latency: on each new ok reading, connections' usual ms of the via's kind, senses' srtt
//    and the last ms; how far off each is, and how many readings after the shift look each takes
//    to come within 20% of the new base.
// No clock, no random and no network: the same looks give the same scorecard. Nothing here is
// shipped (tsconfig includes src only).
import { fromSnapshots, snapshotOf, type BenchLook } from './bench.ts';
import { create as makeSenses } from '../../src/godseye/branches/senses.ts';
import { create as makeLearning } from '../../src/godseye/branches/learning.ts';
import { create as makeConnections, usualMs } from '../../src/godseye/branches/connections.ts';
import type { Branch, BranchCtx, Snapshot } from '../../src/godseye/types.ts';

export { fromSnapshots };

// ---- the seats

interface Seat { branch: Branch; saved: { i: number; json: string } | null; parsed: { i: number; notes: any } | null }

function seat(make: (ctx: BranchCtx) => Branch, clock: { at: number; i: number }): Seat {
  const s = { saved: null, parsed: null } as unknown as Seat;
  const ctx: BranchCtx = {
    now: () => clock.at,
    load: <T>(fallback: T): T => fallback,
    save: (data: unknown) => { s.saved = { i: clock.i, json: JSON.stringify(data) }; },
    emit: () => {},
    peek: () => null,
  };
  s.branch = make(ctx);
  return s;
}

/** the notes a seat saved at the look before look i, parsed once per save; null otherwise */
function before(s: Seat, i: number): any {
  const sv = s.saved;
  if (sv === null || sv.i !== i - 1) return null;
  if (s.parsed === null || s.parsed.i !== sv.i) s.parsed = { i: sv.i, notes: JSON.parse(sv.json) };
  return s.parsed.notes;
}

/** connections' link kind of a via (the same rule as its kindOf) */
function kindOf(x: unknown): string {
  if (typeof x !== 'string') return 'other';
  const k = x.slice(0, 20).toLowerCase();
  return /^[a-z0-9-]+$/.test(k) ? k : 'other';
}

// ---- the scorecard

export interface IntervalScore { cover80: number | null; relWidth: number | null; score: number | null }
export interface SpeedInterval extends IntervalScore {
  n: number;            // answers with an interval
  skipped: number;      // answers with no notes from the look before, or too few errs for one
  open: number;         // intervals with no upper end (q >= 1); left out of relWidth and score
  fixed: IntervalScore; // [est/1.2, est/0.8] on the same answers
}
export interface ReachScore {
  n: number; skipped: number;
  brier: number | null; brierNaive: number | null; brierBase: number | null;
  hit: number | null; hitNaive: number | null;
}
export interface Off { pctOff: number | null; mae: number | null }
export interface LatencyScore {
  n: number; skipped: number;
  connections: Off; senses: Off; naive: Off;
  lag: { connections: number | null; senses: number | null };
}
export interface Scorecard2 {
  looks: number;
  speed: Record<string, SpeedInterval>;
  reach: Record<string, ReachScore>;
  latency: Record<string, LatencyScore>;
}

class IntervalTally {
  n = 0; closed = 0; cover = 0; width = 0; wink = 0;
  add(tps: number, est: number, lo: number, hi: number): void {
    this.n++;
    if (lo <= tps && tps <= hi) this.cover++;
    if (!Number.isFinite(hi)) return;
    this.closed++;
    this.width += (hi - lo) / est;
    this.wink += ((hi - lo) + 10 * Math.max(0, lo - tps) + 10 * Math.max(0, tps - hi)) / tps;
  }
  score(): IntervalScore {
    return {
      cover80: this.n ? this.cover / this.n : null,
      relWidth: this.closed ? this.width / this.closed : null,
      score: this.closed ? this.wink / this.closed : null,
    };
  }
}

class OffTally {
  n = 0; off = 0; abs = 0;
  add(x: number, g: number): void { this.n++; this.off += Math.abs(x - g) / x; this.abs += Math.abs(x - g); }
  score(): Off { return { pctOff: this.n ? this.off / this.n : null, mae: this.n ? this.abs / this.n : null }; }
}

/** the split-conformal 80% interval from learning's est and errs; null when there are too few errs */
export function interval(est: number, errs: number[]): { lo: number; hi: number } | null {
  const m = errs.length;
  const r = Math.ceil(0.8 * (m + 1));
  if (m === 0 || r > m) return null;
  const q = [...errs].sort((a, b) => a - b)[r - 1];
  return { lo: est / (1 + q), hi: q >= 1 ? Infinity : est / (1 - q) };
}

export interface Bench2Opts { shiftAt?: number; shiftTo?: number }

/** the stream of looks through senses, learning and connections, scored. lag counts the ok
 *  readings at or after look shiftAt (default 720) before a guess is within 20% of shiftTo
 *  (default 260); null when it never is. */
export function runBench2(looks: Iterable<BenchLook>, opts: Bench2Opts = {}): Scorecard2 {
  const shiftAt = opts.shiftAt ?? 720;
  const shiftTo = opts.shiftTo ?? 260;
  const clock = { at: 0, i: 0 };
  let seats: { senses: Seat; learning: Seat; connections: Seat } | null = null;

  const speed = new Map<string, { n: number; skipped: number; open: number; conf: IntervalTally; fixed: IntervalTally }>();
  const reach = new Map<string, { n: number; skipped: number; sq: number; sqNaive: number; sqBase: number; hit: number; hitNaive: number; last: number | null; sum: number; count: number }>();
  const lat = new Map<string, { n: number; skipped: number; c: OffTally; s: OffTally; v: OffTally; last: number | null; lagC: number | null; lagS: number | null; afterC: number; afterS: number }>();
  const get = <V>(m: Map<string, V>, id: string, fresh: () => V): V => {
    let v = m.get(id);
    if (v === undefined) { v = fresh(); m.set(id, v); }
    return v;
  };

  let prev: Snapshot | null = null;
  let i = 0;
  for (const look of looks) {
    clock.at = look.at;
    clock.i = i;
    seats ??= { senses: seat(makeSenses, clock), learning: seat(makeLearning, clock), connections: seat(makeConnections, clock) };
    const now = snapshotOf(look.at, look.facts);

    // the guesses are read before the look is shown to any branch
    if (prev !== null) {
      const ln = before(seats.learning, i);
      const sn = before(seats.senses, i);
      const cn = before(seats.connections, i);

      // speed: each device that finished a new answer in an apart (not split) load
      const L = now.work.loaded;
      if (L !== null && L.mode !== 'split') {
        const prevDone = new Map((prev.work.loaded?.devices ?? []).map((x) => [x.id, x.done]));
        for (const x of L.devices) {
          const p = prevDone.get(x.id);
          if (p === undefined || !(x.done > p) || typeof x.tps !== 'number' || !(x.tps > 0)) continue;
          const t = get(speed, x.id, () => ({ n: 0, skipped: 0, open: 0, conf: new IntervalTally(), fixed: new IntervalTally() }));
          const sp = ln?.devices?.[x.id]?.speed;
          const iv = sp && typeof sp.est === 'number' && Array.isArray(sp.errs) ? interval(sp.est, sp.errs) : null;
          if (iv === null) { t.skipped++; continue; }
          t.n++;
          if (!Number.isFinite(iv.hi)) t.open++;
          t.conf.add(x.tps, sp.est, iv.lo, iv.hi);
          t.fixed.add(x.tps, sp.est, sp.est / 1.2, sp.est / 0.8);
        }
      }

      const prevAt = new Map(prev.devices.map((d) => [d.id, d.checkedAt]));
      for (const d of now.devices) {
        if (typeof d.reachable !== 'boolean' || d.checkedAt === null || prevAt.get(d.id) === d.checkedAt) continue;

        // reach: learning's p against this new reading
        const y = d.reachable ? 1 : 0;
        const r = get(reach, d.id, () => ({ n: 0, skipped: 0, sq: 0, sqNaive: 0, sqBase: 0, hit: 0, hitNaive: 0, last: null as number | null, sum: 0, count: 0 }));
        const p = ln?.devices?.[d.id]?.reach?.p;
        if (typeof p === 'number' && r.last !== null) {
          const base = r.sum / r.count;
          r.n++;
          r.sq += (p - y) ** 2;
          r.sqNaive += (r.last - y) ** 2;
          r.sqBase += (base - y) ** 2;
          if ((p >= 0.5 ? 1 : 0) === y) r.hit++;
          if (r.last === y) r.hitNaive++;
        } else r.skipped++;
        r.last = y;
        r.sum += y;
        r.count++;

        // link latency: a new ok reading against the three guesses
        if (d.reachable !== true || typeof d.reachMs !== 'number' || !(d.reachMs > 0)) continue;
        const ms = d.reachMs;
        const l = get(lat, d.id, () => ({ n: 0, skipped: 0, c: new OffTally(), s: new OffTally(), v: new OffTally(), last: null as number | null, lagC: null as number | null, lagS: null as number | null, afterC: 0, afterS: 0 }));
        const kind = kindOf(d.via);
        const pair = Array.isArray(cn?.dev) ? cn.dev.find((e: unknown) => Array.isArray(e) && e[0] === d.id) : undefined;
        const st = Array.isArray(pair?.[1]?.k) ? pair[1].k.find((e: unknown) => Array.isArray(e) && e[0] === kind)?.[1] : undefined;
        const ok = typeof st?.ring === 'string' ? [...st.ring].filter((c) => c === '1').length : 0;
        const cg = ok > 0 && Array.isArray(st.ms) ? usualMs(st.ms.slice(-ok)) : null;
        const sg = sn?.dev?.[d.id]?.srtt;
        const sGuess = typeof sg === 'number' ? sg : null;
        if (i >= shiftAt) {
          const near = (g: number | null): boolean => g !== null && Math.abs(g - shiftTo) <= 0.2 * shiftTo;
          if (l.lagC === null) { if (near(cg)) l.lagC = l.afterC; else l.afterC++; }
          if (l.lagS === null) { if (near(sGuess)) l.lagS = l.afterS; else l.afterS++; }
        }
        if (cg !== null && sGuess !== null && l.last !== null) {
          l.n++;
          l.c.add(ms, cg);
          l.s.add(ms, sGuess);
          l.v.add(ms, l.last);
        } else l.skipped++;
        l.last = ms;
      }
    }

    // the eye's order: senses, learning, connections
    for (const s of [seats.senses, seats.learning, seats.connections]) s.branch.observe(now, prev);
    prev = now;
    i++;
  }

  const out: Scorecard2 = { looks: i, speed: {}, reach: {}, latency: {} };
  for (const [id, t] of speed) out.speed[id] = { n: t.n, skipped: t.skipped, open: t.open, ...t.conf.score(), fixed: t.fixed.score() };
  for (const [id, r] of reach) {
    const m = (x: number): number | null => (r.n ? x / r.n : null);
    out.reach[id] = { n: r.n, skipped: r.skipped, brier: m(r.sq), brierNaive: m(r.sqNaive), brierBase: m(r.sqBase), hit: m(r.hit), hitNaive: m(r.hitNaive) };
  }
  for (const [id, l] of lat) {
    out.latency[id] = { n: l.n, skipped: l.skipped, connections: l.c.score(), senses: l.s.score(), naive: l.v.score(), lag: { connections: l.lagC, senses: l.lagS } };
  }
  return out;
}

// ---- the words

const r6 = (x: number | null): string => (x === null ? '-' : String(Math.round(x * 1e6) / 1e6));
const off = (o: Off): string => `pctOff ${r6(o.pctOff)} mae ${r6(o.mae)}`;
const iv = (s: IntervalScore): string => `cover80 ${r6(s.cover80)} · relWidth ${r6(s.relWidth)} · score ${r6(s.score)}`;

/** one block per node and device, every number rounded to 1e-6 */
export function scorecard2Text(name: string, sc: Scorecard2): string {
  const lines = [`${name} · ${sc.looks} looks`];
  for (const [id, s] of Object.entries(sc.speed)) {
    lines.push(`  speed interval ${id}: n ${s.n} · skipped ${s.skipped} · open ${s.open} · ${iv(s)} | fixed ${iv(s.fixed)}`);
  }
  for (const [id, r] of Object.entries(sc.reach)) {
    lines.push(`  reach ${id}: n ${r.n} · skipped ${r.skipped} · brier ${r6(r.brier)} · brierNaive ${r6(r.brierNaive)} · brierBase ${r6(r.brierBase)} · hit ${r6(r.hit)} · hitNaive ${r6(r.hitNaive)}`);
  }
  for (const [id, l] of Object.entries(sc.latency)) {
    lines.push(`  latency ${id}: n ${l.n} · skipped ${l.skipped} · connections ${off(l.connections)} · senses ${off(l.senses)} · naive ${off(l.naive)} · lag connections ${r6(l.lag.connections)} senses ${r6(l.lag.senses)}`);
  }
  return lines.join('\n');
}
