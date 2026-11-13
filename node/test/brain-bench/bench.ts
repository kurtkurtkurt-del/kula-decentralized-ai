// the brain bench (L5 P30, depth step 1): every brain node gets a number to be judged by. A stream
// of looks (synthetic, synth.ts, or a recorded black box read back with walk() and replayer()) is
// turned into the facts the box keeps, filled back into a snapshot, and fed to the forecast,
// learning and senses branches, each built with its own create(ctx) on the look's clock. What
// they said is scored against what the looks held:
//  - forecast: its scored hours (view().pairs, gathered every 6000 looks and merged by device and
//    t) as brier against its own prior, against 0.5, a ten-bin calibration, ece and the 80% cover;
//    with opts.rate (the scenario's true chance of each scored hour, synth.ts rateOf) also how
//    often the 80% interval holds that chance (rateCover80), and its mean width (width80);
//    opts.forecast benches another forecast branch (createFixed(V1): the L5 forecast, createV2: the
//    L6 one); opts.pairsEvery reads the pairs more often (the 12-looks-an-hour flip and control
//    runs); skillOf and flipScore cut the pairs into the habit flip's windows (L7 P37);
//  - learning and forecast speed: the tok/s guess in the notes saved the look before, against the
//    tok/s the device then answered with, beside a naive guess (the last tok/s seen);
//  - senses: its feed lines, its flapping lines, its stale row, and the share of new readings that
//    fell inside the usual range of its saved notes.
// No clock, no random and no network: the same looks give the same scorecard. Nothing here is
// shipped (tsconfig includes src only).
import { facts, replayer, type Facts } from '../../src/godseye/boxfacts.ts';
import { openBox } from '../../src/godseye/box.ts';
import { create as makeForecast } from '../../src/godseye/branches/forecast.ts';
import { create as makeLearning } from '../../src/godseye/branches/learning.ts';
import { create as makeSenses } from '../../src/godseye/branches/senses.ts';
import type { Branch, BranchCtx, BranchView, EyeDevice, Snapshot } from '../../src/godseye/types.ts';
import { START, FLIP_AT } from './synth.ts';

export interface BenchLook { at: number; facts: Facts }

export const PAIRS_EVERY = 6000;      // looks between two reads of the forecast's pairs
export const STALE_EVERY = 12;        // looks between two reads of the senses' stale row

// ---- the two sources

/** synthetic snapshots through the box's own whitelist */
export function* fromSnapshots(snaps: Iterable<Snapshot>): Generator<BenchLook> {
  for (const s of snaps) yield { at: s.at, facts: facts(s) };
}

/** a black box read back look by look, read-only: nothing in the dir is written or healed */
export function boxLooks(dir: string): BenchLook[] {
  const box = openBox({ dir, readOnly: true });
  const next = replayer();
  const out: BenchLook[] = [];
  box.walk?.((r) => {
    const look = next(r);
    if (look !== null) out.push({ at: look.at, facts: look.facts });
  });
  return out;
}

/** the facts filled back into a snapshot: what the box does not hold is left plain (no address,
 *  'down' for a reason, no trust, no plan), names come from the device and model lists */
export function snapshotOf(at: number, f: Facts): Snapshot {
  const devName = new Map(f.devices.map((d) => [d.id, d.name]));
  const modelName = new Map(f.models.map((m) => [m.id, m.name]));
  const nameOf = (id: string): string => (id === 'local' ? f.host.name : devName.get(id) ?? id);
  const devices: EyeDevice[] = f.devices.map((d) => ({
    id: d.id, name: d.name, kind: d.kind, via: d.via as EyeDevice['via'], where: '',
    reachable: d.reachable, reachMs: d.reachMs, reason: d.down ? 'down' : null, checkedAt: d.checkedAt,
    lastOk: d.lastOk, ramMb: d.ramMb, bwGBs: d.bwGBs, gpu: d.gpu, tls: d.tls, waitingPair: d.waitingPair,
    plugged: d.plugged, holds: d.holds, trust: null, ring: d.ring as EyeDevice['ring'],
  }));
  const L = f.work.loaded;
  return {
    at,
    host: { name: f.host.name, freeMb: f.host.freeMb, ledger: f.host.ledger ? { ...f.host.ledger, problem: null } : null },
    devices,
    work: {
      loaded: L === null ? null : {
        mode: L.mode,
        model: { id: L.model.id, name: modelName.get(L.model.id) ?? L.model.file, file: L.model.file, size: L.model.size },
        ctx: L.ctx,
        since: L.since,
        devices: L.devices.map((x) => ({ id: x.id, name: nameOf(x.id), local: x.id === 'local', busy: x.busy, tps: x.tps, done: x.done })),
        parts: L.parts.map((p) => ({ id: p.id, name: nameOf(p.id), local: p.id === 'local', mb: p.mb, layers: p.layers })),
      },
      loading: f.work.loading === null ? null : { ...f.work.loading, line: '' },
      chatting: f.work.chatting,
      plan: [],
      decisions: [],
      llama: f.work.llama,
    },
    models: f.models.map((m) => ({ ...m })),
    projects: [],
  };
}

// ---- the scorecard

export interface Bin { n: number; said: number | null; was: number | null }
export interface ForecastScore {
  n: number;
  brier: number | null;
  brier0: number | null;
  brierHalf: number | null;
  skill: number | null;
  bins: Bin[];
  ece: number | null;
  cover80: number | null;         // lo <= x <= hi with x the hour's outcome (kept; it cannot judge a rate's interval)
  rateN: number;                  // pairs whose hour has a known chance (opts.rate)
  rateCover80: number | null;     // the share of those with lo <= rate <= hi
  width80: number | null;         // the mean hi - lo
}
export interface SpeedScore {
  n: number;
  skipped: number;
  pctOff: number | null;
  mae: number | null;
  naive: { pctOff: number | null; mae: number | null };
  interval: null;
}
export interface SensesScore {
  feedLines: number;
  flapLines: number;
  staleLooks: number;
  staleChecks: number;
  band: number | null;
  bandN: number;
}
export interface Scorecard {
  looks: number;
  forecast: ForecastScore;
  learning: SpeedScore;
  forecastSpeed: SpeedScore;
  senses: SensesScore;
}

export type Pair = [number, number, number, number, number, number];   // [t, p, lo, hi, p0, x]

/** the pairs scored; rates[i] (when given) is the true chance of pair i's hour, or null */
export function forecastScore(pairs: Pair[], rates?: (number | null)[]): ForecastScore {
  const n = pairs.length;
  const bins: { n: number; p: number; x: number }[] = Array.from({ length: 10 }, () => ({ n: 0, p: 0, x: 0 }));
  let sq = 0, sq0 = 0, sqHalf = 0, cover = 0, rateN = 0, rateIn = 0, width = 0;
  pairs.forEach(([, p, lo, hi, p0, x], i) => {
    sq += (p - x) ** 2;
    sq0 += (p0 - x) ** 2;
    sqHalf += (0.5 - x) ** 2;
    if (lo <= x && x <= hi) cover++;
    width += hi - lo;
    const r = rates?.[i];
    if (typeof r === 'number') {
      rateN++;
      if (lo <= r && r <= hi) rateIn++;
    }
    const b = bins[Math.min(9, Math.floor(p * 10))];
    b.n++; b.p += p; b.x += x;
  });
  const outBins: Bin[] = bins.map((b) => ({ n: b.n, said: b.n ? b.p / b.n : null, was: b.n ? b.x / b.n : null }));
  const rateCover80 = rateN ? rateIn / rateN : null;
  if (n === 0) return { n, brier: null, brier0: null, brierHalf: null, skill: null, bins: outBins, ece: null, cover80: null, rateN, rateCover80, width80: null };
  let ece = 0;
  for (const b of outBins) if (b.n) ece += (b.n / n) * Math.abs((b.said as number) - (b.was as number));
  const brier = sq / n, brier0 = sq0 / n;
  return {
    n, brier, brier0, brierHalf: sqHalf / n, skill: brier0 > 0 ? 1 - brier / brier0 : null,
    bins: outBins, ece, cover80: cover / n, rateN, rateCover80, width80: width / n,
  };
}

// ---- L7 P37: the habit flip's windows (as the scan's f7 proof)

const DAY_MS = 86_400_000;

/** skill against the device's own rate over the pairs with from < t <= to:
 *  1 - sum (p - x)^2 / sum (p0 - x)^2; null with no pair or a zero baseline */
export function skillOf(pairs: Pair[], from: number, to: number): number | null {
  let a = 0, b = 0, n = 0;
  for (const [t, p, , , p0, x] of pairs) {
    if (!(t > from && t <= to)) continue;
    n++;
    a += (p - x) ** 2;
    b += (p0 - x) ** 2;
  }
  return n === 0 || b === 0 ? null : 1 - a / b;
}

export interface FlipScore { week1: number | null; d3to10: number | null; before: number | null; whole: number | null; lag: number }

/** the flip's windows: week1 (FLIP, FLIP+7 d], d3to10 (FLIP+3 d, FLIP+10 d], before (START+7 d,
 *  FLIP], whole (FLIP, FLIP+28 d]; lag = the first day after the flip from which every 3-day
 *  window's skill is > 0, Infinity when the last one is not */
export function flipScore(pairs: Pair[], start = START, flipAt = FLIP_AT, daysAfter = 28): FlipScore {
  let last = 0;
  for (let d = 0; d + 3 <= daysAfter; d++) {
    const s = skillOf(pairs, flipAt + d * DAY_MS, flipAt + (d + 3) * DAY_MS);
    if (s === null || s <= 0) last = d + 1;
  }
  return {
    week1: skillOf(pairs, flipAt, flipAt + 7 * DAY_MS),
    d3to10: skillOf(pairs, flipAt + 3 * DAY_MS, flipAt + 10 * DAY_MS),
    before: skillOf(pairs, start + 7 * DAY_MS, flipAt),
    whole: skillOf(pairs, flipAt, flipAt + daysAfter * DAY_MS),
    lag: last > daysAfter - 3 ? Infinity : last,
  };
}

class SpeedTally {
  n = 0; skipped = 0; off = 0; abs = 0; naiveOff = 0; naiveAbs = 0;
  add(tps: number, g: number, naive: number): void {
    this.n++;
    this.off += Math.abs(tps - g) / tps;
    this.abs += Math.abs(tps - g);
    this.naiveOff += Math.abs(tps - naive) / tps;
    this.naiveAbs += Math.abs(tps - naive);
  }
  score(): SpeedScore {
    const m = (x: number): number | null => (this.n ? x / this.n : null);
    return { n: this.n, skipped: this.skipped, pctOff: m(this.off), mae: m(this.abs), naive: { pctOff: m(this.naiveOff), mae: m(this.naiveAbs) }, interval: null };
  }
}

/** one branch on the bench: its own ctx on the look's clock, its saves kept as JSON tagged with
 *  the look index, its feed lines collected, no other branch to peek at.
 *
 *  an eager seat writes the JSON copy at the save. a lazy seat (forecast and learning, whose notes
 *  are only read when they come from the look just before) keeps the saved object and copies it
 *  when it is read: that read happens before the branch sees the next look, so nothing has changed
 *  the object since the save, and the copy is the one an eager save would have made. A lazy save
 *  from further back is not readable (its object has moved on) and counts as not from the look
 *  before. This keeps the weekly run from writing 60 000 forecast notes it never reads. */
interface Seat {
  branch: Branch;
  eager: boolean;
  saved: { i: number; json: string | null; data: unknown } | null;
  parsed: { i: number; notes: unknown } | null;
  emits: string[];
}

function seat(make: (ctx: BranchCtx) => Branch, clock: { at: number; i: number }, eager: boolean): Seat {
  const s = { eager, saved: null, parsed: null, emits: [] } as unknown as Seat;
  const ctx: BranchCtx = {
    now: () => clock.at,
    load: <T>(fallback: T): T => fallback,
    save: (data: unknown) => { s.saved = { i: clock.i, json: eager ? JSON.stringify(data) : null, data: eager ? null : data }; },
    emit: (text: string) => { s.emits.push(String(text)); },
    peek: () => null,
  };
  s.branch = make(ctx);
  return s;
}

/** the latest saved notes of a seat at look i (before the branch sees it), parsed once per save;
 *  notes null when a lazy save is older than the look before */
function notesOf(s: Seat, i: number): { i: number; notes: any } | null {
  const sv = s.saved;
  if (sv === null) return null;
  if (s.parsed !== null && s.parsed.i === sv.i) return s.parsed;
  if (sv.json === null && sv.i !== i - 1) return { i: sv.i, notes: null };
  s.parsed = { i: sv.i, notes: JSON.parse(sv.json ?? JSON.stringify(sv.data)) };
  return s.parsed;
}

export interface BenchOpts {
  /** the forecast branch to bench (default: forecast.ts's create) */
  forecast?: BranchMaker;
  /** the true chance that device id was there in the hour a pair at t scored, or null */
  rate?: (id: string, t: number) => number | null;
  /** looks between two reads of the forecast's pairs (default PAIRS_EVERY). The flip and control
   *  runs pass 1200: at 12 looks an hour the default is 500 hours, more than the 200 pairs a device
   *  keeps */
  pairsEvery?: number;
}
export type BranchMaker = (ctx: BranchCtx) => Branch;

/** the stream of looks through the three branches, scored; keep.pairs gets the merged pairs and
 *  keep.ids the device of each, aligned */
export function runBench(looks: Iterable<BenchLook>, keep?: { pairs?: Pair[]; ids?: string[] }, opts?: BenchOpts): Scorecard {
  const clock = { at: 0, i: 0 };
  let seats: { senses: Seat; forecast: Seat; learning: Seat } | null = null;
  const pairs = new Map<string, { id: string; q: Pair }>();
  const gather = (v: BranchView): void => {
    for (const d of v.pairs ?? []) for (const q of d.scored) pairs.set(`${d.id}|${q[0]}`, { id: d.id, q });
  };
  const learning = new SpeedTally();
  const fSpeed = new SpeedTally();
  let staleLooks = 0, staleChecks = 0, bandIn = 0, bandN = 0;
  let before: Snapshot | null = null;
  const pairsEvery = opts?.pairsEvery ?? PAIRS_EVERY;
  let i = 0;
  for (const look of looks) {
    clock.at = look.at;
    clock.i = i;
    seats ??= {
      senses: seat(makeSenses, clock, true),
      forecast: seat(opts?.forecast ?? makeForecast, clock, false),
      learning: seat(makeLearning, clock, false),
    };
    const now = snapshotOf(look.at, look.facts);

    // the guesses are read before the look is shown to any branch
    if (before !== null) {
      const prevLoad = before.work.loaded;
      const L = now.work.loaded;
      if (L !== null && L.mode !== 'split') {
        const prevDone = new Map((prevLoad?.devices ?? []).map((x) => [x.id, x]));
        const ln = notesOf(seats.learning, i);
        const fn = notesOf(seats.forecast, i);
        for (const x of L.devices) {
          const p = prevDone.get(x.id);
          if (p === undefined || !(x.done > p.done) || typeof x.tps !== 'number' || !(x.tps > 0)) continue;
          const naive = typeof p.tps === 'number' && p.tps > 0 ? p.tps : null;
          const lg = ln !== null && ln.i === i - 1 ? ln.notes?.devices?.[x.id]?.speed?.est : undefined;
          if (typeof lg === 'number' && naive !== null) learning.add(x.tps, lg, naive); else learning.skipped++;
          const fg = fn !== null && fn.i === i - 1 ? fn.notes?.dev?.[x.id]?.tps?.[L.model.file]?.avg : undefined;
          if (typeof fg === 'number' && naive !== null) fSpeed.add(x.tps, fg, naive); else fSpeed.skipped++;
        }
      }
      // senses: a new ok reading against the usual range its saved notes held
      const sn = notesOf(seats.senses, i);
      const prevAt = new Map(before.devices.map((d) => [d.id, d.checkedAt]));
      for (const d of now.devices) {
        if (d.reachable !== true || typeof d.reachMs !== 'number' || d.checkedAt === null || prevAt.get(d.id) === d.checkedAt) continue;
        const n = sn?.notes?.dev?.[d.id];
        if (!n || typeof n.srtt !== 'number' || typeof n.rttvar !== 'number') continue;
        bandN++;
        if (d.reachMs >= Math.max(0, n.srtt - 4 * n.rttvar) && d.reachMs <= n.srtt + 4 * n.rttvar) bandIn++;
      }
    }

    // the eye's order: senses, then forecast, then learning
    for (const s of [seats.senses, seats.forecast, seats.learning]) s.branch.observe(now, before);
    if ((i + 1) % STALE_EVERY === 0) {
      staleChecks++;
      const row = seats.senses.branch.view().rows.find(([k]) => k === 'stale');
      if (row !== undefined && row[1] !== 'none') staleLooks++;
    }
    if ((i + 1) % pairsEvery === 0) gather(seats.forecast.branch.view());
    before = now;
    i++;
  }
  if (seats !== null) gather(seats.forecast.branch.view());
  const all = [...pairs.values()].sort((a, b) => a.q[0] - b.q[0]);
  const merged = all.map((e) => e.q);
  if (keep) { keep.pairs = merged; keep.ids = all.map((e) => e.id); }
  const rate = opts?.rate;
  const rates = rate ? all.map((e) => rate(e.id, e.q[0])) : undefined;
  const emits = seats?.senses.emits ?? [];
  return {
    looks: i,
    forecast: forecastScore(merged, rates),
    learning: learning.score(),
    forecastSpeed: fSpeed.score(),
    senses: {
      feedLines: emits.length,
      flapLines: emits.filter((t) => /is flapping/.test(t)).length,
      staleLooks, staleChecks,
      band: bandN ? bandIn / bandN : null,
      bandN,
    },
  };
}

// ---- the words

const r6 = (x: number | null): string => (x === null ? '-' : String(Math.round(x * 1e6) / 1e6));

/** one block per node, every number rounded to 1e-6 */
export function scorecardText(name: string, sc: Scorecard): string {
  const f = sc.forecast;
  const sp = (s: SpeedScore): string =>
    `n ${s.n} · skipped ${s.skipped} · pctOff ${r6(s.pctOff)} · mae ${r6(s.mae)} · naive pctOff ${r6(s.naive.pctOff)} · naive mae ${r6(s.naive.mae)} · interval -`;
  const s = sc.senses;
  return [
    `${name} · ${sc.looks} looks`,
    `  forecast: n ${f.n} · brier ${r6(f.brier)} · brier0 ${r6(f.brier0)} · brierHalf ${r6(f.brierHalf)} · skill ${r6(f.skill)} · ece ${r6(f.ece)} · cover80 ${r6(f.cover80)} · rateCover80 ${r6(f.rateCover80)} (n ${f.rateN}) · width80 ${r6(f.width80)}`,
    `    bins: ${f.bins.map((b, k) => `${k}:${b.n}/${r6(b.said)}/${r6(b.was)}`).join(' ')}`,
    `  learning speed: ${sp(sc.learning)}`,
    `  forecast speed: ${sp(sc.forecastSpeed)}`,
    `  senses: feedLines ${s.feedLines} · flapLines ${s.flapLines} · staleLooks ${s.staleLooks} of ${s.staleChecks} · band ${r6(s.band)} (n ${s.bandN})`,
  ].join('\n');
}
