// the brain bench v9 (17 Nov, P2): the far split's estimate, from the probe (before 17 Nov) against
// from the engine's measured link. Each home of synth9.ts is replayed twice through the real senses
// and planner branches on the look's clock: `old` with the looks' linkRttMs and linkAt taken out (the
// planner prices a far worker from the probe's srtt, k 1 until hopFar has 3 answers), `new` as they
// are (1.1 x the measured round trip until hopRtt has 3 answers). On every look with a new answer,
// before the planner sees it, the estimate is planner.ts plan()'s split tps from the notes the
// planner saved so far, and its stated range farRange(); each is scored against the answer:
//  - first: the estimate at the first answer (nothing learned);
//  - after3: the estimate at the first answer at which the fit that prices it (hopFar for old,
//    hopRtt for new) holds 3 ks. The planner learns from the second answer on (the first only marks
//    where the answers stand), so that is the 5th answer.
// Errors are |tps - est| / tps. No clock, no random and no network: the same homes give the same card.
// Nothing here is shipped (tsconfig includes src only).
import { create as makeSenses } from '../../src/godseye/branches/senses.ts';
import { create as makePlanner, plan, farRange } from '../../src/godseye/branches/planner.ts';
import { field } from '../../src/godseye/branches/decide.ts';
import { saneHop, type HopFit } from '../../src/godseye/branches/hop.ts';
import type { BranchCtx, BranchView, Snapshot } from '../../src/godseye/types.ts';
import { START } from './synth.ts';
import { home9, model9, withoutLink, HOMES9, type Scenario9Name, type Truth9 } from './synth9.ts';

/** one variant's scores in one home */
export interface Run9 {
  first: number | null;          // the first estimate's error
  firstIn: boolean | null;       // the first answer inside the first stated range
  firstEst: number | null;
  firstTps: number | null;
  after3: number | null;         // the error once the pricing fit holds 3 ks
  after3At: number | null;       // at which answer (1-based)
  k: number | null;              // the pricing fit's median k at the end (null: under 3 ks)
}
export interface Home9 { name: Scenario9Name; seed: number; home: number; truth: Truth9; old: Run9; new: Run9 }

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
export { median };

/** one home, one variant: the looks through senses and the planner, the estimate scored on each answer.
 *  The planner starts knowing each seat's speed on this model (as from answers before the split), so
 *  the estimate's compute time is the home's C and only the links are scored (as bench3) */
export function runVariant9(name: Scenario9Name, seed: number, home: number, variant: 'old' | 'new'): Run9 {
  const h = home9(name, seed, home);
  const m = model9(name);
  const looks = variant === 'old' ? h.looks.map(withoutLink) : h.looks;
  const clock = { at: START };
  let sensesView: BranchView | null = null;
  const senses = makeSenses({ now: () => clock.at, load: <T>(fb: T): T => fb, save: () => {}, emit: () => {}, peek: () => null });
  const sp = () => ({ [m.file]: { tps: 1000 / h.truth.computeMs, n: 20, at: START } });
  let notes: any = { v: 1, last: m.id, speeds: Object.fromEntries([['local', sp()], ...h.workers.map((w) => [w, sp()])]) };
  const ctx: BranchCtx = {
    now: () => clock.at,
    load: <T>(fb: T): T => (structuredClone(notes) as T) ?? fb,
    save: (d: unknown) => { notes = structuredClone(d); },
    emit: () => {},
    peek: (id: string) => (id === 'senses' ? sensesView : null),
  };
  const planner = makePlanner(ctx);
  const out: Run9 = { first: null, firstIn: null, firstEst: null, firstTps: null, after3: null, after3At: null, k: null };
  const fitOf = (): HopFit | null => saneHop(variant === 'old' ? notes.hopFar : notes.hopRtt);
  let prev: Snapshot | null = null;
  let answers = 0;
  for (const s of looks) {
    clock.at = s.at;
    senses.observe(s, prev);
    sensesView = senses.view();
    const local = s.work.loaded?.devices.find((d) => d.local);
    const was = prev?.work.loaded?.devices.find((d) => d.local);
    if (local && typeof local.tps === 'number' && local.tps > 0 && local.done > (was?.done ?? 0)) {
      answers++;
      const hop = saneHop(notes.hop) ?? undefined;
      const hopFar = saneHop(notes.hopFar) ?? undefined;
      const hopRtt = saneHop(notes.hopRtt) ?? undefined;
      const f = field(s, ctx, new Map(Object.entries(notes.speeds as Record<string, Record<string, { tps: number; n: number; at: number }>>).map(([id, files]) => [id, Object.entries(files).map(([file, x]) => ({ file, tps: x.tps, n: x.n, at: x.at }))])));
      const S = plan(s, f, m, true, hop, hopFar, hopRtt).split;
      const est = S?.tps ?? null;
      const err = est != null ? Math.abs(local.tps - est) / local.tps : null;
      if (answers === 1) {
        const r = S ? farRange(S, hopFar, hopRtt) : null;
        out.first = err;
        out.firstEst = est;
        out.firstTps = local.tps;
        out.firstIn = r ? r.lo <= local.tps && local.tps <= r.hi : null;
      }
      const fit = fitOf();
      if (out.after3 === null && fit && fit.ks.length >= 3) { out.after3 = err; out.after3At = answers; }
    }
    planner.observe(s, prev);
    prev = s;
  }
  const fit = fitOf();
  if (fit && fit.ks.length >= 3) out.k = median(fit.ks);
  return out;
}

/** one scenario and seed: HOMES9 homes, both variants */
export function runBench9(name: Scenario9Name, seed: number): Home9[] {
  const out: Home9[] = [];
  for (let home = 0; home < HOMES9; home++) {
    out.push({ name, seed, home, truth: home9(name, seed, home).truth, old: runVariant9(name, seed, home, 'old'), new: runVariant9(name, seed, home, 'new') });
  }
  return out;
}

/** the medians over a set of homes, per variant: first, after3, and the first range's coverage */
export interface Summary9 { n: number; old: Part9; new: Part9 }
export interface Part9 { first: number | null; after3: number | null; nAfter3: number; cover: number | null }
export function summary9(homes: Home9[]): Summary9 {
  const part = (v: 'old' | 'new'): Part9 => {
    const first = homes.map((h) => h[v].first).filter((x): x is number => x !== null);
    const after3 = homes.map((h) => h[v].after3).filter((x): x is number => x !== null);
    const ins = homes.map((h) => h[v].firstIn).filter((x): x is boolean => x !== null);
    return { first: median(first), after3: median(after3), nAfter3: after3.length, cover: ins.length ? ins.filter((x) => x).length / ins.length : null };
  };
  return { n: homes.length, old: part('old'), new: part('new') };
}

// ---- the words

const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);

/** one row: old and new median errors, first and after 3 answers, and the first range's coverage */
export function summary9Text(label: string, s: Summary9): string {
  const p = (x: Part9) => `first ${pct(x.first)} · after3 ${pct(x.after3)} (n ${x.nAfter3}) · first range holds ${pct(x.cover)}`;
  return `${label}: homes ${s.n} | old (probe) ${p(s.old)} | new (measured link) ${p(s.new)}`;
}
