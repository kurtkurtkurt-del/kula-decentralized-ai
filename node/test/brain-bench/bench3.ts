// the brain bench v3 (L8 P47, depth): the split's hop. A stream of split looks (synth3.ts) is fed
// to the senses branch on its own ctx on the look's clock with an eager seat (every save kept as
// JSON, tagged with the look index). On each new split answer three tok/s guesses are scored
// against the answer's tok/s, all from the scenario's true compute ms (the bench isolates the hop):
//  - fixed: decide.ts today, 1000 / (computeMs + workers * HOP_MS);
//  - prior: hop.ts with k = HOP_PRIOR on senses' srtt of each worker;
//  - learned: hop.ts with the fit's k, and its split-conformal 80% interval.
// The links are senses' srtt and rttvar from the notes saved at the look before; an answer with a
// worker missing from them is `skipped` (scored by nobody, learned from by nobody). After scoring,
// the fit takes the answer in (hopStep). No clock, no random and no network: the same looks give
// the same scorecard. Nothing here is shipped (tsconfig includes src only).
import { fromSnapshots, snapshotOf, type BenchLook } from './bench.ts';
import { create as makeSenses } from '../../src/godseye/branches/senses.ts';
import { HOP_MS } from '../../src/godseye/branches/decide.ts';
import { HOP_PRIOR, chainTps, freshHop, hopInterval, hopK, hopStep, type HopFit, type Link } from '../../src/godseye/branches/hop.ts';
import type { Branch, BranchCtx, Snapshot } from '../../src/godseye/types.ts';

export { fromSnapshots };

// ---- the seat (copied from bench2.ts)

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

// ---- the scorecard

/** how far off a guess was, mean |tps - est| / tps: over the whole run, over the answers at or
 *  after the shift look, and over the first `first` scored answers from the shift look */
export interface Off3 { whole: number | null; after: number | null; first: number | null }
export interface Scorecard3 {
  looks: number;
  n: number;           // answers scored
  skipped: number;     // answers with no links from the look before
  nAfter: number;      // of n, at or after the shift look
  nFirst: number;      // of nAfter, the first ones (at most opts.first)
  fixed: Off3;
  prior: Off3;
  learned: Off3;
  interval: { n: number; skipped: number; open: number; cover80: number | null; width80: number | null };
  k: number;           // hopK of the fit at the end
  fit: HopFit;
}

export interface Bench3Opts { computeMs: number; shiftAt?: number; first?: number }

class Tally {
  n = 0; s = 0;
  add(x: number): void { this.n++; this.s += x; }
  mean(): number | null { return this.n ? this.s / this.n : null; }
}

/** the split looks through senses, the three guesses scored on each new answer */
export function runBench3(looks: Iterable<BenchLook>, opts: Bench3Opts): Scorecard3 {
  const shiftAt = opts.shiftAt ?? 720;
  const firstN = opts.first ?? 100;
  const computeMs = opts.computeMs;
  const clock = { at: 0, i: 0 };
  let senses: Seat | null = null;
  let fit = freshHop();

  const names = ['fixed', 'prior', 'learned'] as const;
  const whole = { fixed: new Tally(), prior: new Tally(), learned: new Tally() };
  const after = { fixed: new Tally(), prior: new Tally(), learned: new Tally() };
  const first = { fixed: new Tally(), prior: new Tally(), learned: new Tally() };
  let n = 0, skipped = 0, nAfter = 0, nFirst = 0;
  const iv = { n: 0, skipped: 0, open: 0, cover: 0, closed: 0, width: 0 };

  let prev: Snapshot | null = null;
  let i = 0;
  for (const look of looks) {
    clock.at = look.at;
    clock.i = i;
    senses ??= seat(makeSenses, clock);
    const now = snapshotOf(look.at, look.facts);

    // the guesses are read before the look is shown to the branch
    const L = now.work.loaded;
    if (prev !== null && L !== null && L.mode === 'split') {
      const local = L.devices.find((x) => x.local);
      const was = prev.work.loaded?.devices.find((x) => x.local);
      if (local !== undefined && was !== undefined && local.done > was.done && typeof local.tps === 'number' && local.tps > 0) {
        const tps = local.tps;
        const sn = before(senses, i);
        const workers = (L.parts ?? []).filter((p) => !p.local).map((p) => p.id);
        const links: Link[] = [];
        for (const id of workers) {
          const d = sn?.dev?.[id];
          if (typeof d?.srtt === 'number' && typeof d?.rttvar === 'number') links.push({ srtt: d.srtt, rttvar: d.rttvar });
        }
        if (workers.length === 0 || links.length !== workers.length) skipped++;
        else {
          const est = {
            fixed: 1000 / (computeMs + workers.length * HOP_MS),
            prior: chainTps(computeMs, links, HOP_PRIOR),
            learned: chainTps(computeMs, links, hopK(fit)),
          };
          const isAfter = i >= shiftAt;
          const isFirst = isAfter && nFirst < firstN;
          n++;
          if (isAfter) nAfter++;
          if (isFirst) nFirst++;
          for (const k of names) {
            const off = Math.abs(tps - est[k]) / tps;
            whole[k].add(off);
            if (isAfter) after[k].add(off);
            if (isFirst) first[k].add(off);
          }
          const band = hopInterval(est.learned, fit.errs);
          if (band === null) iv.skipped++;
          else {
            iv.n++;
            if (band.lo <= tps && tps <= band.hi) iv.cover++;
            if (Number.isFinite(band.hi)) { iv.closed++; iv.width += (band.hi - band.lo) / est.learned; }
            else iv.open++;
          }
          fit = hopStep(fit, computeMs, links, tps);
        }
      }
    }

    senses.branch.observe(now, prev);
    prev = now;
    i++;
  }

  const off = (k: (typeof names)[number]): Off3 => ({ whole: whole[k].mean(), after: after[k].mean(), first: first[k].mean() });
  return {
    looks: i, n, skipped, nAfter, nFirst,
    fixed: off('fixed'), prior: off('prior'), learned: off('learned'),
    interval: { n: iv.n, skipped: iv.skipped, open: iv.open, cover80: iv.n ? iv.cover / iv.n : null, width80: iv.closed ? iv.width / iv.closed : null },
    k: hopK(fit),
    fit,
  };
}

// ---- the words

const r4 = (x: number | null): string => (x === null ? '-' : x.toFixed(4));

/** one row: fixed, prior, learned (whole / after the shift / its first answers), the interval, k */
export function scorecard3Text(name: string, sc: Scorecard3, K?: number): string {
  const o = (x: Off3): string => `${r4(x.whole)} / ${r4(x.after)} / ${r4(x.first)}`;
  return `${name}: n ${sc.n} skipped ${sc.skipped} (after ${sc.nAfter}, first ${sc.nFirst}) | pctOff whole/after/first: fixed ${o(sc.fixed)} | prior ${o(sc.prior)} | learned ${o(sc.learned)} | cover80 ${r4(sc.interval.cover80)} width80 ${r4(sc.interval.width80)} (n ${sc.interval.n}, open ${sc.interval.open}) | k ${r4(sc.k)}${K === undefined ? '' : ` K ${K}`}`;
}
