// the gate watch (16.11.2026, P4): this computer's own gate as its own signed ledger saw it
// (Snapshot.host.gate, filled by ui/godseye-feed.ts hostGate from the reject lines it verified),
// the other devices' gates as they say it (their /trust rejectsDay, the device's word), and this
// computer's anchor bytes (Snapshot.host.anchor). trust.ts reads it: one host check `gate`, the
// cards below, and their feed lines. It only watches and says: nothing here bars a device, turns a
// device's verdict, closes a port or switches anything off. Pure: no clock, no ctx.
//
// Every refusal reason is one of four classes (classOf):
//   stranger  no hello, bad hello, tls, no tls, not paired, overloaded, bad channel, bad nonce,
//             no client cert, no v1, pin expired: someone without a pairing knocked. On a port the
//             internet can reach this is scanners, every hour of every day: counted, never alarmed
//   guess     wrong pin, wrong secret, bad proof (GUESSES, the words trust.ts holds a device's own
//             refusals to as well): a code or a proof that was not theirs
//   guard     any reason starting 'rpc guard': a paired device sent the split's rpc a command that
//             can carry code, and the guard (rpcguard.ts) dropped it before llama.cpp saw it
//   other     the rest (a replay, …): counted in the words, never a check or a card here
//
// The burst: each finished hour's `far` count (refusals from a non-private address) goes through
// burst.ts's burstStep unchanged (a Gamma-Poisson belief per UTC hour of day and a CUSUM). Its fit
// lives in trust's notes under the reserved key `~gate` (GATE_KEY), a Seen like a device's: burst =
// the fit, at = the start of the newest finished hour taken in, lastBurst / lastUsual / rising =
// what that hour said. An hour already taken in is never taken in again, so a look repeated or a
// ledger read again teaches nothing twice; finished hours the gate no longer holds (the computer
// was off past 26 hours) were not seen, so the CUSUM starts again, as trust.ts does for a device;
// notes ahead of the ledger's clock by more than an hour (the clock went back) re-anchor and take
// nothing in.
//
// The host check `gate` (trust.ts puts it beside the host's ledger check; absent when the look has
// no host.gate, so an older look's report is the same as before):
//   ok false  a guard refusal in the 26 hours the gate holds (its count and the last why), else
//             GUESS_LIMIT (5) or more guesses in the last 24 hours
//   ok true   calm: "its gate refused N strangers today (no hello ×a, tls ×b) from about M
//             networks: scanners find every open port; none got in", with fewer guesses and the
//             other reasons after it, and "(still learning what is usual: n of 24 hours)" while
//             burst.ts has taken in fewer than NEED hours (or "… at this hour of day" while the
//             running hour's hour of day has less than STRATUM_NEED weight)
// A red host check turns the cluster's verdict red (trust.ts build), never a device's: untrusted()
// (decide.ts) reads the devices only.
//
// The cards (warn; the action only opens the trust branch), weight 3 first:
//   trust:gate-guard        3  at once, while the 26 hours hold a guard refusal
//   trust:rpc-guard:<id>    3  a device's rejectsDay holds a reason starting 'rpc guard' (it answered,
//                              no error); its verdict does not change: it defended itself
//   trust:gate-guess        3  GUESS_LIMIT or more guesses in the last 24 hours
//   trust:gate-burst        2  once known (NEED hours taken in, the hour of day STRATUM_NEED above the
//                              prior): the running hour's far count in the negative binomial tail
//                              (at least MIN_K, P < TAIL_P), or the last finished hour was a tail,
//                              or the CUSUM rose; at any time, learning or not, BACKSTOP (1000) or
//                              more far refusals in the running hour (a backstop, not measured)
//   trust:anchor-cap        2  bytesDay above capDay; it stays while above CAP_STAY (0.95) × capDay
// One feed line when a card comes and one when it goes (gateLines), never one per look.
//
// The uncertainty: none of these thresholds (MIN_K, TAIL_P, the 1000 backstop, 5 guesses) was
// measured against a real router's scanner rate; the burst says only that the far count is unlikely
// for this computer's own usual at that UTC hour of day, not who knocked or why (one loud scanner
// reads the same as a focused try). `nets` counts distinct ipv4 /24 and ipv6 /48 blocks, so it is
// "about": a scanner farm in one block is one network, a carrier-grade nat is many people. A
// device's rpc guard count is its own word; this computer's comes from its own signed ledger.
import type { EyeDevice, Suggestion, TrustCheck } from '../types.js';
import { burstStep, freshBurst, nbTail, NEED, STRATUM_NEED, B0, MIN_K, TAIL_P, type BurstFit } from './burst.js';
import { cardId } from './decide.js';

export type GateClass = 'stranger' | 'guess' | 'guard' | 'other';

/** a refusal by someone with no pairing: scanners and strangers */
export const STRANGERS = new Set(['no hello', 'bad hello', 'tls', 'no tls', 'not paired', 'overloaded', 'bad channel', 'bad nonce', 'no client cert', 'no v1', 'pin expired']);
/** refusals that mean someone tried a code or a proof that was not theirs */
export const GUESSES = new Set(['wrong pin', 'wrong secret', 'bad proof']);
export const GUESS_LIMIT = 5;          // guesses in a day that turn a check red
export const GUARD = 'rpc guard';      // every reason starting with it is the guard's
export const BACKSTOP = 1000;          // far refusals in the running hour: a card even while learning
export const CAP_STAY = 0.95;          // the anchor-cap card stays while bytesDay is above this × capDay
export const GATE_KEY = '~gate';       // the reserved key of the fit in trust's notes
export const GATE_HOURS = 26;          // the hours the gate holds at most

const HOUR = 3_600_000;
const DAY_HOURS = 24;
const ABSURD = 8.64e15;                // ms: a time past this is absurd
const PER_HOUR = 10_000;               // far refusals one hour counts into the fit at most
const COUNT_MAX = 1e9;                 // a count past this is absurd, capped
const K_MAX = 9999;                    // the burst K shown at most
const LAMBDA_MAX = 9999.9;             // the usual rate shown at most
const WORDS = 4;                       // reasons named in the check at most
const WHY_MAX = 200;
/** the hour of day (UTC) a window starting at `start` stands for: the one holding its middle */
const hourOf = (start: number) => Math.floor((start + HOUR / 2) / HOUR) % 24;

export function classOf(reason: string): GateClass {
  if (reason.startsWith(GUARD)) return 'guard';
  if (GUESSES.has(reason)) return 'guess';
  if (STRANGERS.has(reason)) return 'stranger';
  return 'other';
}

/** what the fit keeps (trust.ts maps it to and from the `~gate` Seen) */
export interface GateState { fit: BurstFit; at: number; lastBurst: number; lastUsual: number; rising: boolean }
export const freshGate = (): GateState => ({ fit: freshBurst(), at: 0, lastBurst: 0, lastUsual: 0, rising: false });

/** one hour of the gate, cleaned: its reasons as [word, count] and its far count */
export interface GateHour { start: number; by: [string, number][]; far: number }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const whole = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), COUNT_MAX) : 0);
const isTime = (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= ABSURD;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** the gate's hours, oldest first, the last one running: the snapshot is not trusted, so an hour
 *  without a usable start is dropped, the same start twice is the later one, counts are whole */
export function hoursOf(gate: unknown): GateHour[] {
  if (!isObj(gate) || !Array.isArray(gate.hours)) return [];
  const byStart = new Map<number, GateHour>();
  for (const h of gate.hours.slice(-4 * GATE_HOURS)) {
    if (!isObj(h) || !isTime(h.start)) continue;
    const by: [string, number][] = [];
    if (isObj(h.by)) {
      for (const [w, n] of Object.entries(h.by).slice(0, 100)) {
        const c = whole(n);
        if (w && w.length <= WHY_MAX && c > 0) by.push([w, c]);
      }
    }
    byStart.set(h.start, { start: h.start, by, far: whole(h.far) });
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start).slice(-GATE_HOURS);
}

/** take in every finished hour not taken in yet (all but the last, which is running) */
export function gateStep(st: GateState, hours: GateHour[]): { st: GateState; changed: boolean } {
  if (hours.length < 2) return { st, changed: false };
  const lastDone = hours[hours.length - 2].start;
  if (st.at > hours[hours.length - 1].start + HOUR) {
    // the notes are ahead of the ledger's clock (it went back): re-anchor on the hours shown, take
    // nothing in, and end what the last hour said
    return { st: { fit: { ...st.fit, s: 0 }, at: lastDone, lastBurst: 0, lastUsual: 0, rising: false }, changed: true };
  }
  let s = st;
  let changed = false;
  for (const h of hours.slice(0, -1)) {
    if (h.start <= s.at) continue;
    // hours between the last one taken in and this one were not seen: the CUSUM starts again
    const fit = s.at > 0 && h.start - s.at > HOUR ? { ...s.fit, s: 0 } : s.fit;
    const k = Math.min(h.far, PER_HOUR);
    const r = burstStep(fit, hourOf(h.start), k);
    s = { fit: r.fit, at: h.start, lastBurst: r.tail ? k : 0, lastUsual: r.tail ? Math.min(r.usual, LAMBDA_MAX) : 0, rising: r.rise };
    changed = true;
  }
  return { st: s, changed };
}

/** the last n hours' counts by reason and by class */
function sums(hours: GateHour[], n: number) {
  const by = new Map<string, number>();
  const cls: Record<GateClass, number> = { stranger: 0, guess: 0, guard: 0, other: 0 };
  for (const h of hours.slice(-n)) {
    for (const [w, c] of h.by) {
      const key = w.startsWith(GUARD) ? GUARD : w;
      by.set(key, Math.min((by.get(key) ?? 0) + c, COUNT_MAX));
      cls[classOf(w)] = Math.min(cls[classOf(w)] + c, COUNT_MAX);
    }
  }
  return { by, cls };
}
const wordsOf = (by: Map<string, number>, keep: (w: string) => boolean) =>
  [...by].filter(([w]) => keep(w)).sort((a, b) => b[1] - a[1]).slice(0, WORDS).map(([w, n]) => `${w} ×${n}`).join(', ');

/** the guard refusals the gate holds: their count over the hours (or the listed ones in the window,
 *  whichever is more) and the newest why */
function guardOf(gate: unknown, hours: GateHour[]): { n: number; why: string | null } {
  const counted = sums(hours, GATE_HOURS).cls.guard;
  const from = hours.length ? hours[0].start : Infinity;
  const listed = (isObj(gate) && Array.isArray(gate.guard) ? gate.guard : [])
    .filter((g): g is { t: number; why: unknown } => isObj(g) && isTime(g.t) && g.t >= from)
    .sort((a, b) => a.t - b.t);
  const last = listed.at(-1);
  const why = last && typeof last.why === 'string' && last.why ? last.why.slice(0, WHY_MAX) : null;
  return { n: Math.max(counted, listed.length), why };
}

/** is the running hour's hour of day known to the fit, and what it usually holds */
function runningOf(st: GateState, hours: GateHour[]) {
  const run = hours[hours.length - 1];
  const h = hourOf(run.start);
  const f = st.fit;
  const k = Math.min(run.far, PER_HOUR);
  const known = f.n >= NEED && f.b[h] - B0 >= STRATUM_NEED;
  return { k, known, usual: Math.min(f.a[h] / f.b[h], LAMBDA_MAX), tail: known && k >= MIN_K && nbTail(k, f.a[h], f.b[h]) < TAIL_P };
}

const GUARD_WORDS = 'a paired device sent a command that can carry code; it was dropped before llama.cpp saw it. kula versions that differ can do this by accident';

/** the host check `gate`, or null when the look has no gate */
export function gateCheck(st: GateState, gate: unknown): TrustCheck | null {
  if (!isObj(gate)) return null;
  const k = 'gate';
  const hours = hoursOf(gate);
  if (!hours.length) return { k, ok: null, text: 'its gate has no hours to show yet' };
  const g = guardOf(gate, hours);
  if (g.n > 0) return { k, ok: false, text: `its gate cut a split connection (rpc guard ×${g.n} in the last 26 hours)${g.why ? `: ${g.why}` : ''}` };
  const day = sums(hours, DAY_HOURS);
  if (day.cls.guess >= GUESS_LIMIT) {
    return { k, ok: false, text: `${day.cls.guess} wrong codes today: someone may be guessing. all were refused` };
  }
  const nets = whole(gate.nets);
  const strangers = day.cls.stranger;
  const parts: string[] = [];
  parts.push(strangers > 0
    ? `its gate refused ${plural(strangers, 'stranger')} today (${wordsOf(day.by, (w) => classOf(w) === 'stranger')})${nets > 0 ? ` from about ${plural(nets, 'network')}` : ''}: scanners find every open port; none got in`
    : 'no stranger knocked on its gate today');
  if (day.cls.guess > 0) parts.push(`${plural(day.cls.guess, 'wrong code')} (${wordsOf(day.by, (w) => classOf(w) === 'guess')})`);
  if (day.cls.other > 0) parts.push(`also refused: ${wordsOf(day.by, (w) => classOf(w) === 'other')}`);
  const f = st.fit;
  const r = runningOf(st, hours);
  const learning = f.n < NEED
    ? ` (still learning what is usual: ${f.n} of ${NEED} hours)`
    : r.known ? '' : ' (still learning what is usual at this hour of day)';
  return { k, ok: true, text: parts.join('; ') + learning };
}

/** a card with the feed lines for when it comes and when it goes */
export interface GateCard { card: Suggestion; said: string; gone: string }

const OPEN = { do: 'open', panel: 'branch', branch: 'trust' } as const;
const warn = (id: string, weight: 1 | 2 | 3, title: string, why: string): Suggestion =>
  ({ id, kind: 'warn', weight, title, why, action: { ...OPEN }, label: 'look' });
const gb = (bytes: number) => { const x = bytes / 1e9; return x < 10 ? x.toFixed(2) : x.toFixed(1); };

/** the anchor's bytes against its daily cap: on above the cap, staying on above CAP_STAY × cap */
export function capOn(anchor: unknown, was: boolean): boolean {
  if (!isObj(anchor)) return false;
  const bytes = anchor.bytesDay;
  const cap = anchor.capDay;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return false;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return false;
  return was ? bytes > CAP_STAY * cap : bytes > cap;
}

/** every gate card this look says, weight 3 first. `cap`: the anchor-cap card is on (capOn) */
export function gateCards(st: GateState, gate: unknown, devices: readonly EyeDevice[], anchor: unknown, cap: boolean): GateCard[] {
  const out: GateCard[] = [];
  const hours = isObj(gate) ? hoursOf(gate) : [];
  if (hours.length) {
    const g = guardOf(gate, hours);
    if (g.n > 0) {
      const title = "this computer's gate cut a split connection (rpc guard)";
      out.push({
        card: warn('trust:gate-guard', 3, title, `${plural(g.n, 'time')} in the last 26 hours${g.why ? `, the last: ${g.why}` : ''}. ${GUARD_WORDS}.`),
        said: `${title}: ${g.why ?? 'rpc guard'}`,
        gone: "this computer's gate: no rpc guard refusal left in the last 26 hours",
      });
    }
  }
  for (const d of devices) {
    if (!isObj(d) || typeof d.id !== 'string' || !d.id || d.id.length > 200) continue;
    const t = isObj(d.trust) ? d.trust : null;
    if (!t || t.error || !isObj(t.rejectsDay)) continue;
    let n = 0;
    for (const [w, c] of Object.entries(t.rejectsDay).slice(0, 1000)) if (typeof w === 'string' && w.startsWith(GUARD)) n = Math.min(n + whole(c), COUNT_MAX);
    if (n <= 0) continue;
    const last = (Array.isArray(t.rejectsLast) ? (t.rejectsLast as unknown[]) : [])
      .filter((r): r is { t: number; why: string } => isObj(r) && isTime(r.t) && typeof r.why === 'string' && r.why.startsWith(GUARD))
      .sort((a, b) => a.t - b.t).at(-1);
    const why = last ? last.why.slice(0, WHY_MAX) : null;
    const name = typeof d.name === 'string' && d.name.length > 0 && d.name.length <= 200 ? d.name : 'a device';
    const title = `${name}'s gate cut a split connection (rpc guard)`;
    out.push({
      card: warn(cardId('trust', 'rpc-guard', d.id), 3, title, `${plural(n, 'time')} today${why ? `, the last: ${why}` : ''}. ${GUARD_WORDS}. it defended itself: its verdict does not change.`),
      said: `${title}: ${why ?? 'rpc guard'}`,
      gone: `${name}: no rpc guard refusal in its day any more`,
    });
  }
  if (hours.length) {
    const day = sums(hours, DAY_HOURS);
    if (day.cls.guess >= GUESS_LIMIT) {
      const title = "someone may be guessing codes at this computer's gate";
      out.push({
        card: warn('trust:gate-guess', 3, title, `${day.cls.guess} wrong codes in the last 24 hours (${wordsOf(day.by, (w) => classOf(w) === 'guess')}); all were refused.`),
        said: `${title}: ${day.cls.guess} wrong codes today, all refused`,
        gone: "this computer's gate: fewer than 5 wrong codes in the last 24 hours again",
      });
    }
    const r = runningOf(st, hours);
    const fmt = (n: number) => String(Math.min(Math.floor(n), K_MAX));
    let why: string | null = null;
    if (r.tail || r.k >= BACKSTOP) {
      why = `${fmt(r.k)} knocks from outside the lan in the last hour, ${r.known ? `usually about ${r.usual.toFixed(1)} at this hour of day` : 'still learning what is usual'}; all refused.`;
    } else if (st.lastBurst > 0) {
      why = `${fmt(st.lastBurst)} knocks from outside the lan in the last finished hour, usually about ${st.lastUsual.toFixed(1)} at that hour of day; all refused.`;
    } else if (st.rising) {
      why = 'refusals from outside the lan have been running above the usual for the last hours; all refused.';
    }
    if (why) {
      const title = "more knocking on this computer's gate than usual";
      out.push({
        card: warn('trust:gate-burst', 2, title, `${why} scanners knock on every open port; none got in.`),
        said: `${title}: ${why}`,
        gone: "the knocking on this computer's gate is back to its usual",
      });
    }
  }
  if (cap && isObj(anchor)) {
    const title = 'this anchor carried more than its daily limit';
    const x = `${gb(anchor.bytesDay as number)} of ${gb(anchor.capDay as number)} GB in the last day`;
    out.push({
      card: warn('trust:anchor-cap', 2, title, `${x}, ciphertext only. nothing was switched off.`),
      said: `${title}: ${x}`,
      gone: 'this anchor is back under its daily limit',
    });
  }
  return out.sort((a, b) => (b.card.weight ?? 2) - (a.card.weight ?? 2));
}

/** the feed lines of this look: one when a card comes, one when it goes. `was`: the cards on before,
 *  id → its gone line; returns the lines and the map for the next look */
export function gateLines(was: ReadonlyMap<string, string>, cards: GateCard[]): { lines: string[]; on: Map<string, string> } {
  const on = new Map<string, string>();
  const lines: string[] = [];
  for (const c of cards) {
    if (on.has(c.card.id)) continue;
    on.set(c.card.id, c.gone);
    if (!was.has(c.card.id)) lines.push(c.said);
  }
  for (const [id, gone] of was) if (!on.has(id)) lines.push(gone);
  return { lines, on };
}
