// 6 planner: where the model sits, and why; and where it would sit better. It only suggests, as
// cards the person may tap (kula's engine then loads); it never loads anything itself.
// The model it thinks about: the loaded one, else the one loaded last (its notes). For it, from one
// look (decide.ts): alone on the fastest place it fits, apart on every place that holds a copy,
// split over this computer and the devices near it. Cards:
//   split   the model fits only split, or split is faster than the fastest place alone (both speeds known):
//           with a learned range (3 split answers, every speed answered, not estimated from bandwidth)
//           when the range's low end reaches the place alone and the guess is above it, else GAIN faster
//   apart   two or more places hold a copy and it is not loaded apart on all of them: n answers at once
//   alone   it is split, and one place alone is GAIN faster (a warning, with the load that fixes it)
//   barred  a device holding part of a split should rest or is not trusted: split without it
// A device that limits or trust says no to is never suggested. Speeds come from the tok/s each device
// really answered with (kept here, from every look with a model loaded, never from a split, where
// the tok/s is the whole chain's), else its measured bandwidth; this computer has none until a model
// ran here, and then a card quotes no number for it. Each card holds SHOW looks before it shows and
// goes HIDE looks after its reason went, with SLACK on every threshold, so it does not flap.
// The links' cost is the one thing taken from a split (L9 P49, hop.ts): each split answer, with the
// chain of the look before (its compute time from the seats' own speeds, senses' srtt of its links),
// gives one k; split() prices a worker's link at k times its srtt (the prior k = 1 before 3 answers),
// and the split card's why ends with the range it is likely in; that range's low end is the faster-split
// card's rule (L11 P59a, splitFaster). Speeds are still never taken from a split.
// Far workers (anchor network, P3; decide.ts isFar: straight over the internet or through an anchor)
// have their own fit, hopFar: a split answer whose chain has a far worker teaches only hopFar (its near
// links go into the compute time at the near k), a near chain only hop. Until hopFar has 3 answers
// split() prices a far link at k = 1 (the pessimistic end: the probe's ms is about 4 round trips) and
// says the range up to k = 0.25; after, at hopFar's k with its 80% range. A split with a far worker
// uses that range, not the near one: lowEnd is null for it (the point rule on the pessimistic tps) and
// the split cards end with the far range sentence instead of hopWords. Far estimates are not used as
// facts (VERDICT 1, DO 2): no faster-split card while the far fit is assumed and a far worker has no
// link (farGuessed: its 150/300 ms is a constant, not a pessimistic end); and a loaded far split with no
// live tok/s warns "alone is faster" only when alone reaches the range's high end (k 0.25) × GAIN, not
// its k = 1 end (with a live tok/s, as before). One more card:
//   far     a split would use a far worker and alone or apart exists: the far split's likely range
//           beside apart (or alone), with a far link's missed probes when they reach 20%; action null,
//           the person chooses (weight 1)
// Notes: the last model, the speeds (at most 40 devices × 8 files, each with `at`, when it was last
// folded), the hop fit and the far hop fit `hopFar` (hop.ts; a file without it loads with a fresh
// one), saved at most once a minute. A 9th file pushes out the device's file with the oldest `at`, a
// 41st device the device whose newest `at` is oldest (never this computer, never the one just written).
import type { Branch, BranchCtx, BranchView, EyeModel, Snapshot, Suggestion } from '../types.js';
import { hhmm } from './util.js';
import { GAIN, SLACK, Steady, alone, apart, cardId, field, gb1, isFar, loadedChain, modelOf, names, seatName, split, tpsOn, tpsWord, type Field, type Measured, type Place, type Seat } from './decide.js';
import { chainTps, freshHop, hopInterval, hopK, hopStep, saneHop, type HopFit } from './hop.js';

const MODE_WORD: Record<string, string> = { phone: 'on the phone', apart: 'apart', split: 'split', here: 'here' };
const DEVICES_KEPT = 40;
const FILES_KEPT = 8;
const TPS_MAX = 100_000;
const AT_MAX = 8.64e15;            // the last ms a Date can hold
const EWMA = 0.3;                  // a new answer's weight in a device's average speed
const SAVE_EVERY_MS = 60_000;

const LOSS_SAID = 0.2;             // a far link's missed probe share (upper end) the far card names
interface Notes { v: 1; last: string | null; speeds: Record<string, Record<string, { tps: number; n: number; at: number }>>; hop?: HopFit; hopFar?: HopFit }

const okAt = (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= AT_MAX;

/** the notes as loaded; an entry without a usable `at` gets `now`, the time they were loaded */
function sane(x: unknown, now: number): Notes {
  const n = x as Partial<Notes> | null;
  const out: Notes = { v: 1, last: typeof n?.last === 'string' ? n.last.slice(0, 200) : null, speeds: Object.create(null) };
  if (n?.v !== 1 || !n.speeds || typeof n.speeds !== 'object') return out;
  for (const [id, files] of Object.entries(n.speeds).slice(0, DEVICES_KEPT)) {
    if (!files || typeof files !== 'object' || id.length > 200) continue;
    const f: Notes['speeds'][string] = Object.create(null);
    for (const [file, sp] of Object.entries(files).slice(0, FILES_KEPT)) {
      if (sp && typeof sp.tps === 'number' && sp.tps > 0 && sp.tps <= TPS_MAX && typeof sp.n === 'number' && sp.n >= 1) f[file] = { tps: sp.tps, n: Math.floor(sp.n), at: okAt(sp.at) ? sp.at : now };
    }
    out.speeds[id] = f;
  }
  const hop = saneHop(n.hop);
  if (hop) out.hop = hop;
  const hopFar = saneHop(n.hopFar);
  if (hopFar) out.hopFar = hopFar;
  return out;
}

/** the seats the loaded model sits on now, as decide.ts names them ("local" for this computer) */
export function seatedIds(s: Snapshot): Set<string> {
  const L = s.work.loaded;
  if (!L) return new Set();
  return new Set([...L.devices.map((d) => (d.local ? 'local' : d.id)), ...(L.parts ?? []).filter((p) => p.mb > 0).map((p) => (p.local ? 'local' : p.id))]);
}

const where = (s: Snapshot, x: Seat) => (x.local ? `here on ${seatName(s, x)}` : `on ${x.name}`);
const from = (xs: Seat[]) => (xs.some((x) => x.speed?.from === 'bandwidth') ? 'estimated from memory bandwidth' : 'from the speeds they answered with');

const r1 = (x: number) => Math.round(x * 10) / 10;

/** words for the end of a split card's why: how the links' cost is known and, once it can, the 80%
 *  range of the chain's tok/s; '' without a fit or a chain. The faster-split rule reads the same range
 *  through lowEnd. '' for a split with a far worker: farWords says its range */
export function hopWords(S: Place, hop: HopFit | undefined): string {
  if (!hop || !S.chain || S.far) return '';
  const W = hop.errs.length;
  const raw = chainTps(S.chain.computeMs, S.chain.links, hopK(hop));
  const iv = hopInterval(raw, hop.errs);
  if (hop.ks.length < 3) return ` the links' cost is assumed (one usual round trip per worker per token): ${W} of 3 split answers watched.`;
  if (!iv) return ` the links' cost is learned from the last ${W} split answers watched; no range yet.`;
  if (Number.isFinite(iv.hi)) return ` the links' cost is learned from the last ${W} split answers watched: likely ${r1(iv.lo)}\u{2013}${r1(iv.hi)} tok/s (8 in 10).`;
  return ` the links' cost is learned from the last ${W} split answers watched: likely ${r1(iv.lo)} tok/s or more (8 in 10).`;
}

/** is the split faster than the place alone: with the range's low end `lo`, when lo reaches it and the
 *  guess est is above it (so the title never says "~3.5 tok/s; alone ~3.5"), each within slack; without
 *  one, the point, est GAIN (gain) faster */
export function splitFaster(est: number, lo: number | null, alone: number, gain: number, slack = 1): boolean {
  return lo !== null ? lo * slack >= alone && est * slack > alone : est >= alone * gain;
}

/** the low end of the split's 80% range, or null when there is none to trust: no fit, no chain, fewer
 *  than 3 ks, no range yet, or a seat of the split or of the place alone estimated from its bandwidth
 *  (bench5 measured the rule with true speeds only), or a split with a far worker (its tps is the far
 *  estimate, the near fit's range does not hold for it) */
export function lowEnd(S: Place, A: Place, hop: HopFit | undefined): number | null {
  if (!hop || !S.chain || hop.ks.length < 3 || S.far) return null;
  if ([...S.seats, ...A.seats].some((x) => x.speed?.from === 'bandwidth')) return null;
  const iv = hopInterval(chainTps(S.chain.computeMs, S.chain.links, hopK(hop)), hop.errs);
  return iv ? iv.lo : null;
}

/** the far split's likely tok/s: while assumed, split()'s lo (k 1) to hi (k 0.25); once hopFar is
 *  learned, the 80% range around the estimate at its k (lo = hi when there is no range yet); null
 *  without a far worker */
export function farRange(S: Place, hopFar: HopFit | undefined): { lo: number; hi: number } | null {
  if (!S.far) return null;
  if (S.far.assumed || !hopFar) return { lo: S.far.lo, hi: S.far.hi };
  return hopInterval(S.far.lo, hopFar.errs) ?? { lo: S.far.lo, hi: S.far.lo };
}

/** a split whose far cost is a guess, not an end: assumed (hopFar not learned) and a far worker
 *  without a link, priced at FAR_HOP_MS (a constant, not a pessimistic end); no faster-split card */
export const farGuessed = (S: Place): boolean => !!S.far?.assumed && S.seats.some((x) => !x.local && isFar(x) && !x.link);

const rangeWord = (r: { lo: number; hi: number }) =>
  r1(r.lo) === r1(r.hi) ? `~${r1(r.lo)} tok/s` : Number.isFinite(r.hi) ? `${r1(r.lo)}\u{2013}${r1(r.hi)} tok/s` : `${r1(r.lo)} tok/s or more`;
const farHow = (S: Place, hopFar: HopFit | undefined) =>
  S.far!.assumed ? `assumed from probes, ${Math.min(3, hopFar?.ks.length ?? 0)} of 3 far split answers watched` : `learned from the last ${hopFar?.errs.length ?? 0} far split answers watched`;

/** the range sentence a split card with a far worker ends with; '' without one */
export function farWords(s: Snapshot, S: Place, hopFar: HopFit | undefined): string {
  const r = farRange(S, hopFar);
  if (!r) return '';
  const far = S.seats.filter((x) => !x.local && isFar(x));
  return ` far devices: split likely ${rangeWord(r)}; each token waits about one round trip to each far worker (${names(far.map((x) => ({ name: seatName(s, x) })))}), ${farHow(S, hopFar)}.`;
}

/** the planner's cards for one model in one look; strict to show, loose (SLACK) to stay; with a hop
 *  fit the split prices its near links with the fit's k, with a far fit of 3 answers or more its far
 *  links with that fit's k (else 1) */
export function plan(s: Snapshot, f: Field, m: EyeModel, strict: boolean, hop?: HopFit, hopFar?: HopFit): { cards: Suggestion[]; alone: Place | null; apart: Place | null; split: Place | null } {
  const slack = strict ? 1 : SLACK;
  const gain = strict ? GAIN : 1 + (GAIN - 1) / 3;
  const L = s.work.loaded && (s.work.loaded.model.id === m.id || s.work.loaded.model.file === m.file) ? s.work.loaded : null;
  const kFar = hopFar && hopFar.ks.length >= 3 ? hopK(hopFar) : undefined;
  const A = alone(f, m, slack), P = apart(f, m, slack), S = split(f, m, slack, hop ? hopK(hop) : undefined, kFar);
  const cards: Suggestion[] = [];
  const seated = seatedIds(s);
  const tonight = (xs: Seat[]) => xs.filter((x) => x.tonight?.guess === 'unlikely').map((x) => ` ${x.name} is unlikely to be there tonight (forecast ${Math.round(x.tonight!.p * 100)}%).`).join('');

  // split: when nothing else holds it, or when it is clearly faster than the fastest place alone
  if (S && L?.mode !== 'split' && !s.work.loading) {
    const biggest = Math.max(0, ...f.seats.map((x) => x.capMb));
    if (!A) {
      cards.push({
        id: cardId('planner', 'split', m.id), kind: 'suggest', weight: 2, action: S.action, label: 'load split',
        title: `${m.name} fits only split: ${names(S.seats.map((x) => ({ name: seatName(s, x) })))} together hold it`,
        why: `it needs about ${gb1(m.needMb)}; the most one place offers is ${gb1(biggest)}. split, ${tpsWord(S.tps)}${S.tps ? ` (${from(S.seats)})` : ''}.${tonight(S.seats)}${hopWords(S, hop)}${farWords(s, S, hopFar)}`,
      });
    } else if (S.tps != null && A.tps != null && !farGuessed(S) && splitFaster(S.tps, lowEnd(S, A, hop), A.tps, gain, slack)) {
      cards.push({
        id: cardId('planner', 'split', m.id), kind: 'suggest', weight: 2, action: S.action, label: 'load split',
        title: `${m.name} would run faster split over ${names(S.seats.map((x) => ({ name: seatName(s, x) })))}: ~${S.tps} tok/s; alone ${where(s, A.seats[0])} ~${A.tps}`,
        why: `the layers go to the fastest device first; each token crosses ${S.seats.length - 1} link${S.seats.length === 2 ? '' : 's'} (${from([...S.seats, ...A.seats])}).${tonight(S.seats)}${hopWords(S, hop)}${farWords(s, S, hopFar)}`,
      });
    }
  }

  // far: a split would use a far worker and the model also runs alone or apart: the person chooses
  const fr = S ? farRange(S, hopFar) : null;
  if (S && fr && (A || P)) {
    const far = S.seats.filter((x) => !x.local && isFar(x));
    const lossy = far.filter((x) => typeof x.loss === 'number' && x.loss >= LOSS_SAID)
      .map((x) => ` ${x.name}'s link missed up to ${Math.round(x.loss! * 100)}% of probes: a split stops when one worker drops.`).join('');
    cards.push({
      id: cardId('planner', 'far', m.id), kind: 'suggest', weight: 1, action: null,
      title: `far devices: split likely ${rangeWord(fr)}, ${P ? `apart ${tpsWord(P.tps)} each` : `alone ${tpsWord(A!.tps)} ${where(s, A!.seats[0])}`}`,
      why: `each token waits about one round trip to each far worker (${names(far.map((x) => ({ name: seatName(s, x) })))}). ${farHow(S, hopFar)}. ${P ? `apart keeps each answer on one device, ${P.seats.length} at once.` : 'alone keeps each answer on one device.'}${lossy} you choose.`,
    });
  }

  // apart: every place that holds a copy answers one prompt at a time, all at once
  if (P && !s.work.loading && (!L || L.mode === 'phone' || L.mode === 'here' || (L.mode === 'apart' && P.seats.some((x) => !seated.has(x.id))))) {
    const more = L?.mode === 'apart' ? P.seats.filter((x) => !seated.has(x.id)) : [];
    const each = P.seats.map((x) => `${seatName(s, x)} ${tpsWord(tpsOn(x, m))}`).join(', ');
    cards.push({
      id: cardId('planner', 'apart', m.id), kind: 'suggest', weight: more.length ? 1 : 2, action: P.action, label: 'load apart',
      title: more.length
        ? `add ${names(more)}: apart on ${P.seats.length} places answers ${P.seats.length} at once`
        : `apart would answer ${P.seats.length} at once: ${names(P.seats.map((x) => ({ name: seatName(s, x) })))} each hold ${m.name}`,
      why: `each runs its own copy (needs about ${gb1(m.needMb)}) and the fastest free one takes each prompt: ${each}.${tonight(P.seats)}`,
    });
  }

  // alone: loaded split while one place alone is clearly faster
  if (L?.mode === 'split' && A) {
    const live = L.devices.find((d) => d.local)?.tps ?? L.devices[0]?.tps ?? null;
    const measuredNow = live != null && live > 0;
    // no live tps and the far links only assumed: the split's tps is the k = 1 end, so compare at hi
    const assumed = !measuredNow && S?.far?.assumed ? S.far : null;
    const now = measuredNow ? live : S?.tps ?? null;
    const bar = assumed ? assumed.hi : now;
    if (now != null && bar != null && A.tps != null && A.tps >= bar * gain) {
      cards.push({
        id: cardId('planner', 'alone', m.id), kind: 'warn', weight: 2, action: A.action, label: 'load alone',
        title: `split is slower than ${seatName(s, A.seats[0])} alone for ${m.name}`,
        why: `split answers ${assumed ? `at about ${rangeWord(assumed)} (its far links assumed from probes)` : `${measuredNow ? 'at' : 'at about'} ${Math.round(now * 10) / 10} tok/s${measuredNow ? ' (measured)' : ''}`}; ${where(s, A.seats[0])} alone it would at ~${A.tps} (${from(A.seats)}), with no link to cross.`,
      });
    }
  }

  // barred: a device in the split that limits or trust says no to
  if (L?.mode === 'split') {
    for (const b of f.barred) {
      if (!seated.has(b.id) || b.id === 'local') continue;
      const without = S && !S.seats.some((x) => x.id === b.id) ? S : null;
      cards.push({
        id: cardId('planner', 'barred', b.id), kind: 'warn', weight: 3, action: without?.action ?? null, ...(without ? { label: 'split without it' } : {}),
        title: `${b.name} holds part of ${m.name} but ${b.why}`,
        why: without ? `split again without it: ${names(without.seats.map((x) => ({ name: seatName(s, x) })))} hold it, ${tpsWord(without.tps)}.` : 'the others do not hold the model without it: stop it, or wait.',
      });
    }
  }
  return { cards, alone: A, apart: P, split: S };
}

export function create(ctx: BranchCtx): Branch {
  const notes = sane(ctx.load<unknown>(null), ctx.now());
  let snap: Snapshot | null = null;
  let subject: EyeModel | null = null;
  let look: ReturnType<typeof plan> | null = null;
  let f: Field | null = null;
  let shown: Suggestion[] = [];
  const steady = new Steady();
  // device|file → the load's since and its answer count when last seen, this run only, for the loaded
  // file only: a reload (a new since) folds its first answer; a since that moves with the count unchanged does not
  const lastDone = new Map<string, { since: number; done: number }>();
  let dirty = false;
  let savedAt = Number.NEGATIVE_INFINITY;
  let fit: HopFit = notes.hop ?? freshHop();
  let fitFar: HopFit = notes.hopFar ?? freshHop();
  let chainWas: ReturnType<typeof loadedChain> = null;   // the loaded split's chain in the look before
  let seen: { key: string; done: number } | null = null;   // the split's answers when last seen

  const measured = (): Map<string, Measured[]> =>
    new Map(Object.entries(notes.speeds).map(([id, files]) => [id, Object.entries(files).map(([file, x]) => ({ file, tps: x.tps, n: x.n, at: x.at }))]));

  /** a device's answer speed on the loaded model, folded in when its answer count grew */
  function learn(s: Snapshot) {
    const at = okAt(s.at) ? s.at : ctx.now();
    // an `at` later than the look comes back to the look's time
    for (const files of Object.values(notes.speeds)) for (const sp of Object.values(files)) if (sp.at > at) { sp.at = at; dirty = true; }
    const L = s.work.loaded;
    if (!L || L.mode === 'split' || !L.model.file) return;
    const wrote = new Set<string>();
    const newest = (files: Notes['speeds'][string]) => Math.max(Number.NEGATIVE_INFINITY, ...Object.values(files).map((x) => x.at));
    for (const d of L.devices) {
      if (!(typeof d.tps === 'number' && d.tps > 0 && d.tps <= TPS_MAX)) continue;
      const id = d.local ? 'local' : d.id;
      const key = `${id}|${L.model.file}`;
      const was = lastDone.get(key);
      lastDone.set(key, { since: L.since, done: d.done });
      if (was !== undefined && (was.since === L.since ? d.done <= was.done : d.done === was.done)) continue;
      if (!notes.speeds[id] && Object.keys(notes.speeds).length >= DEVICES_KEPT) {
        // a new device pushes out the one measured longest ago: never this computer, never one just written
        let out: string | null = null;
        for (const [k, files] of Object.entries(notes.speeds)) if (k !== 'local' && !wrote.has(k) && (out == null || newest(files) < newest(notes.speeds[out]))) out = k;
        if (out == null) continue;
        delete notes.speeds[out];
      }
      const files = (notes.speeds[id] ??= Object.create(null) as Notes['speeds'][string]);
      const sp = files[L.model.file];
      if (sp) { sp.tps = Math.round((sp.tps + EWMA * (d.tps - sp.tps)) * 100) / 100; sp.n++; sp.at = at; }
      else {
        // a new file pushes out the device's file folded longest ago
        if (Object.keys(files).length >= FILES_KEPT) {
          let out: string | null = null;
          for (const [k, x] of Object.entries(files)) if (out == null || x.at < files[out].at) out = k;
          if (out != null) delete files[out];
        }
        files[L.model.file] = { tps: d.tps, n: 1, at };
      }
      wrote.add(id);
      dirty = true;
    }
    // marks for the loaded file only (nothing loaded clears nothing: a flap folds nothing twice)
    for (const key of lastDone.keys()) if (!key.endsWith('|' + L.model.file)) lastDone.delete(key);
  }

  /** a split's answer teaches the hop: when its answers grew since the look before, the chain of the
   *  look before and the measured tok/s give one k (hop.ts). A chain with a far worker teaches only
   *  hopFar, its near links counted into the compute time at the near k; a near chain only hop */
  function watch(s: Snapshot, fl: Field) {
    const chainNow = subject ? loadedChain(s, fl, subject) : null;
    const L = s.work.loaded;
    if (L && L.mode === 'split') {
      const d = L.devices.find((x) => x.local) ?? L.devices[0];
      const key = L.model.file + '|' + L.since;
      if (d && typeof d.tps === 'number' && d.tps > 0 && d.tps <= TPS_MAX && Number.isFinite(d.done)) {
        if (seen?.key === key && d.done > seen.done && chainWas) {
          const farOf = chainWas.far;
          if (farOf) {
            const kNear = hopK(fit);
            let computeMs = chainWas.computeMs;
            const links: typeof chainWas.links = [];
            chainWas.links.forEach((l, i) => { if (farOf[i]) links.push(l); else computeMs += kNear * l.srtt; });
            const next = hopStep(fitFar, computeMs, links, d.tps);
            if (next !== fitFar) { fitFar = next; notes.hopFar = fitFar; dirty = true; }
          } else {
            const next = hopStep(fit, chainWas.computeMs, chainWas.links, d.tps);
            if (next !== fit) { fit = next; notes.hop = fit; dirty = true; }
          }
        }
        seen = { key, done: d.done };
      }
    } else seen = null;
    chainWas = chainNow;
  }

  return {
    id: 'planner',
    observe(now) {
      snap = now;
      learn(now);
      const L = now.work.loaded;
      const id = L ? (modelOf(now, L.model.id) ?? modelOf(now, L.model.file))?.id ?? null : null;
      if (id && id !== notes.last) { notes.last = id; dirty = true; }
      subject = L ? modelOf(now, L.model.id) ?? modelOf(now, L.model.file) : now.work.loading ? null : modelOf(now, notes.last);
      f = field(now, ctx, measured());
      watch(now, f);
      look = subject ? plan(now, f, subject, true, fit, fitFar) : null;
      const loose = subject ? plan(now, f, subject, false, fit, fitFar).cards : [];
      shown = steady.step(look?.cards ?? [], loose);
      const t = ctx.now();
      if (dirty && t - savedAt >= SAVE_EVERY_MS) { ctx.save(notes); savedAt = t; dirty = false; }
    },
    view(): BranchView {
      const w = snap?.work;
      const L = w?.loaded;
      const rows: [string, string][] = [];
      if (L) rows.push(['model', L.model.name], ['mode', MODE_WORD[L.mode] ?? L.mode], ['context', `${L.ctx} tokens`], ['since', hhmm(L.since)]);
      if (w?.loading) rows.push(['loading', w.loading.line || w.loading.model]);
      const s = snap;
      const thinks: string[] = [];
      if (s && subject && look && f) {
        const m = subject;
        if (!L) rows.push(['thinking about', `${m.name} (loaded last)`]);
        const say = (p: Place | null, what: string) => (p ? `${what}: ${names(p.seats.map((x) => ({ name: seatName(s, x) })))} · ${tpsWord(p.tps)}` : `${what}: no`);
        thinks.push(say(look.alone, 'alone'), say(look.apart, 'apart'), say(look.split, 'split'));
        for (const x of f.seats) rows.push([seatName(s, x), `${gb1(x.capMb)} for a model · ${x.speed ? `${x.speed.gbs.toFixed(1)} GB/s ${x.speed.from === 'measured' ? 'measured' : 'from its bandwidth'}` : 'speed not measured yet'}${x.tonight && x.tonight.guess !== 'unknown' ? ` · tonight ${x.tonight.guess}` : ''}`]);
        for (const b of f.barred) thinks.push(`${b.name} left out: ${b.why}`);
      }
      if (fit.ks.length > 0) rows.push(['link cost', fit.ks.length >= 3 ? `k ${hopK(fit).toFixed(2)} \u{d7} the usual round trip, from ${fit.ks.length} split answers` : `not learned yet: ${fit.ks.length} of 3 split answers`]);
      const parts = (L?.parts ?? []).map((p) => `${p.name}: ${p.layers} layers · ${p.mb} MB${p.local ? ' · main device' : ''}`);
      const ideas = shown.length;
      // the speeds it learned, for the branches after it (peek)
      const hints = Object.entries(notes.speeds).map(([id, files]) => ({ id, tps: Object.entries(files).map(([file, x]) => ({ file, tps: x.tps, n: x.n, at: x.at })) }));
      return {
        built: true,
        stat: w?.loading ? `loading ${w.loading.model}` : L ? `${MODE_WORD[L.mode] ?? L.mode} · ${L.model.name}${ideas ? ` · ${ideas} idea${ideas === 1 ? '' : 's'}` : ''}` : `nothing planned${ideas ? ` · ${ideas} idea${ideas === 1 ? '' : 's'}` : ''}`,
        gauge: null,
        rows,
        lines: [...shown.map((c) => `${c.kind === 'warn' ? 'warning' : 'idea'}: ${c.title}`), ...thinks, ...parts, ...(w?.plan ?? [])],
        note: subject ? 'suggestions only: a tap asks kula to load; the planner never does.' : L || w?.loading ? undefined : 'nothing loaded and nothing loaded before: once a model ran, the planner says where it sits best.',
        suggestions: shown,
        hints,
      };
    },
  };
}
