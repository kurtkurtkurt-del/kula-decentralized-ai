// 8 trust and verification (10.11.2026): the cluster's security report, one screen. For every
// device: is the link tls with the certificate pinned, does the certificate it shows match the pin
// and name the key that signs its ledger, would it still take the old plain-text protocol, what its
// gate refused today, and does its signed ledger hold together, line by line, with what was seen
// before. On top, one answer: all clear, or what to look at.
//
// It checks what it can check and believes nothing else: the certificate is hashed here, the key id
// is computed here, every ledger line's chain and signature is verified here. What a device says
// about itself without proof (its own "my ledger is ok", where its key lives, its refusal counts)
// is shown as the device's word. No prompts, no answers: only who connected and whether it was let in.
//
// Joining (13.11.2026, G1): the engine checks every link as the lines pass and calls a broken one a
// ledger that started over. Here, new lines whose first one does not follow the last line verified,
// with that line gone from the window, are a gap: nothing in them is checked and the ledger is never
// ok ("could not be joined") until the person accepts carrying on from there. Every device in the
// snapshot keeps its notes; only devices that left are dropped past the cap (G10).
//
// Two newer checks: a ledger that reports fewer lines than the largest count seen (lines removed on
// the device; kept red until the person accepts it), and a burst of refusals against the device's
// own usual rate at the same hour of day (burst.ts: a Gamma-Poisson belief per hour of day and a
// CUSUM for a rate that stays raised, L10 P55); a replay and many wrong codes still come first.
// Both only watch and report, as always.
//
// Owner-blind (11.11.2026): can this device's owner read the jobs it runs? A phone proves it cannot
// with its keystore's attestation (attest.ts checked it when it came: a hardware key, a locked
// bootloader, green verified boot, the official kula app); a computer cannot prove it. One line per
// device, informational for now: it never turns the verdict red or grey. A device in the running
// cluster (or holding layers of a split) that fails it gets a warning card. A phone that sends no
// proof fails it (a phone can make one); a friend's (circle) device that cannot say gets the card too.
// It remembers the newest proof that held (P60, G3): a device that proved once counts as a phone, so
// answering as a computer fails it, and a fall from a proof that held to a failure is said once.
import type { Branch, BranchCtx, EyeDevice, EyeTrust, Snapshot, Suggestion, TrustCheck, TrustReport, Verdict } from '../types.js';
import type { EyeKey, EyeKeys } from '../platform.js';
import { fromBase64, sha256Hex } from '../hash.js';
import { hhmm, pct } from './util.js';
import { cardId } from './decide.js';
import { burstStep, freshBurst, saneBurst, nbTail, NEED, STRATUM_NEED, B0, MIN_K, TAIL_P, type BurstFit } from './burst.js';

// the signatures and the certificate's subject come from the platform (ctx.keys: node:crypto on a
// computer, platform.ts); the hashes are plain TypeScript and the same everywhere
const sha = (s: string | Uint8Array) => sha256Hex(s);
const SIG_TAIL = /,"sig":"([A-Za-z0-9+/=]*)"\}$/;
// refusals that mean someone tried a code or a proof that was not theirs
const GUESSES = new Set(['wrong pin', 'wrong secret', 'bad proof']);
export const GUESS_LIMIT = 5;
const HOUR = 3_600_000;        // a burst window: one hour of the answer's own clock
const MAX_DEVICES = 40;        // devices kept in the notes beyond those in the snapshot (never dropped)
const ABSURD = 8.64e15;        // ms: a time past this is absurd, nothing is taken in
const COUNT_MAX = 1e9;         // ledger lines: a count past this is absurd, ignored
const DAY_CAP = 10_000;        // a day's refusals per reason: past this a reason is capped
const PER_ANSWER = 10_000;     // refusals one answer counts into the hour at most
const K_MAX = 9999;            // the burst K shown at most
const LAMBDA_MAX = 9999.9;     // the usual rate shown at most
const ATTEST_STALE = 26 * HOUR; // an owner-blind proof older than this is not taken as today's
/** checks shown but never counted in a verdict: the device's word (its key's place), and owner-blind for now */
const INFO = new Set(['key', 'owner-blind']);
const firstBad = (cs: TrustCheck[]) => cs.find((c) => c.ok === false && !INFO.has(c.k))!;
/** the hour of day (UTC) a window starting at `start` stands for: the one holding its middle */
const hourOf = (start: number) => Math.floor((start + HOUR / 2) / HOUR) % 24;

/** a device id the notes can take as a key: a non-empty string of at most 200 chars */
const okId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200;
/** a device name the view and feed can show: a short string, or a plain stand-in */
const devName = (d: EyeDevice) => (typeof d.name === 'string' && d.name.length > 0 && d.name.length <= 200 ? d.name : 'a device');

/** the day's refusals as a clean map of whole numbers: short reason words, finite positive counts
 *  capped at a day's cap. a count past the cap is capped, never dropped: dropping it would turn a
 *  busy reason into silence, or into a false burst when the day ages back under the cap */
const cleanDay = (day: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (day && typeof day === 'object') {
    for (const [w, n] of Object.entries(day as Record<string, unknown>).slice(0, 1000)) {
      if (typeof w !== 'string' || !w || w.length > 200) continue;
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
        const f = Math.floor(n);          // whole refusals only: 2.9 is 2, never a fraction
        if (f > 0) out[w] = Math.min(f, DAY_CAP);
      }
    }
  }
  return out;
};
const dayTotal = (day: Record<string, number>) => Object.values(day).reduce((a, n) => a + n, 0);

/** P(X >= k) for X ~ Poisson(lambda): p = 1 - e^-lambda * sum_{i=0}^{k-1} lambda^i / i!. The terms
 *  are worked in logs and scaled by the largest one, so a lambda past ~710 cannot overflow the sum
 *  (unscaled, the terms would be beyond the double's reach and the tail would come out NaN). */
export function poissonTail(k: number, lambda: number): number {
  if (k <= 0) return 1;
  if (!(lambda > 0) || !Number.isFinite(lambda)) return 0;
  const logL = Math.log(lambda);
  const n = Math.floor(lambda);
  let m = 0;                                    // the largest log term sits at i = floor(lambda)
  for (let i = 1; i <= Math.min(k - 1, n); i++) m += logL - Math.log(i);
  let sum = Math.exp(-m);                       // i = 0: lambda^0 / 0!, scaled
  let lt = 0;
  for (let i = 1; i < k; i++) {
    lt += logL - Math.log(i);
    const term = Math.exp(lt - m);
    if (i > n && term <= sum * Number.EPSILON) break;   // the rest cannot change the double
    sum += term;
  }
  const p = 1 - Math.exp(-lambda + m + Math.log(sum));
  return Math.min(1, Math.max(0, p));
}

/** the middle value of xs sorted; the mean of the two middle ones when the count is even */
export function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** What the branch keeps per device (its notes file): how far the ledger was verified, the largest
 *  count it reported, and the refusal hours. The new fields get defaults when an older notes file
 *  does not have them. */
interface Seen {
  head: string | null;          // sha256 of the last ledger line verified
  verified: number;             // lines verified since first seen
  since: number;                // when the first line was verified
  at: number;                   // the trust answer last taken in (its `at`)
  restartSeen: number | null;   // the restartedAt already taken in
  fault: string | null;         // a ledger fault, kept until the person says they know
  faultAt: number | null;
  faultLine: string | null;     // sha256 of the line that failed, to step past it once accepted
  gap: boolean;                 // the new lines could not be joined to the ones seen before
  held: { h: string; why: string } | null;  // a line fault waiting behind the started-over fault
  seen: number;                 // ms (this computer's clock) of its last look, for the cap
  count: number;                // the largest ledger line count the device reported (0: none yet)
  shrunkTo: number | null;      // the smaller count to adopt once the person accepts the fault
  rejAt: number;                // the newest refusal time taken in (the answer's clock); -1: none yet
  rejTotal: number;             // the last rejectsDay total taken in
  win: { start: number; k: number };  // the running hour: refusals since `start` (the answer that opened it)
  burst: BurstFit;              // what each hour of the day usually holds, and the CUSUM (burst.ts)
  lastBurst: number;            // the last finished hour's refusals when it was a burst; 0: it was not
  lastUsual: number;            // that hour of day's usual rate when the last finished hour was a burst
  rising: boolean;              // the CUSUM said the rate went up over the last finished hours
  shorterRestart: boolean;      // the shorter fault was raised while a restart was still unconsumed
  proved: number;               // the `at` of the newest owner-blind proof that held; 0: none
  provedDown: boolean;          // it proved before and its check fails now (said once)
}
type Notes = Record<string, Seen>;
const fresh = (): Seen => ({ head: null, verified: 0, since: 0, at: 0, restartSeen: null, fault: null, faultAt: null, faultLine: null, gap: false, held: null, seen: 0, count: 0, shrunkTo: null, rejAt: -1, rejTotal: 0, win: { start: 0, k: 0 }, burst: freshBurst(), lastBurst: 0, lastUsual: 0, rising: false, shorterRestart: false, proved: 0, provedDown: false });

/** notes read back from disk, rebuilt as a null-prototype object so a device id like "__proto__"
 *  stays a key and never a prototype, or fresh notes when the file is not what this branch wrote:
 *  a field that is missing or not a finite number gets its default, so notes from an older branch
 *  still load. */
function sane(x: unknown): Notes {
  const out: Notes = Object.create(null);
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  const nnum = (n: unknown, d: number): number => (typeof n === 'number' && Number.isFinite(n) ? n : d);
  for (const [id, s] of Object.entries(x)) {
    if (typeof id !== 'string' || !id || id.length > 200) continue;   // not a device id: dropped
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const v = s as Seen;
    v.head = typeof v.head === 'string' ? v.head : null;
    v.verified = Math.floor(Math.min(Math.max(0, nnum(v.verified, 0)), COUNT_MAX));
    v.since = Math.min(nnum(v.since, 0), ABSURD);
    v.at = Math.min(nnum(v.at, 0), ABSURD);
    v.restartSeen = Number.isFinite(v.restartSeen) ? v.restartSeen : null;
    v.fault = typeof v.fault === 'string' ? v.fault : null;
    v.faultAt = Number.isFinite(v.faultAt) ? v.faultAt : null;
    v.faultLine = typeof v.faultLine === 'string' ? v.faultLine : null;
    v.gap = v.gap === true;
    const hd = v.held;
    v.held = hd && typeof hd === 'object' && !Array.isArray(hd) && typeof hd.h === 'string' && typeof hd.why === 'string'
      ? { h: hd.h, why: hd.why } : null;
    v.seen = Math.min(nnum(v.seen, 0), ABSURD);
    v.count = Math.floor(Math.min(Math.max(0, nnum(v.count, 0)), COUNT_MAX));
    v.shrunkTo = Number.isFinite(v.shrunkTo) && v.shrunkTo! >= 0 && v.shrunkTo! <= COUNT_MAX ? Math.floor(v.shrunkTo!) : null;
    v.rejAt = Math.min(nnum(v.rejAt, -1), ABSURD);
    v.rejTotal = Math.floor(Math.max(0, nnum(v.rejTotal, 0)));
    const w = v.win;
    v.win = w && typeof w === 'object' && !Array.isArray(w) && Number.isFinite(w.start) && Number.isFinite(w.k)
      ? { start: Math.min(Math.max(0, w.start), ABSURD), k: Math.floor(Math.max(0, w.k)) } : { start: 0, k: 0 };
    // an older notes file kept its finished hours without their hour of day: it learns again
    v.burst = saneBurst(v.burst) ?? freshBurst();
    delete (v as { hist?: unknown }).hist;
    v.lastBurst = Math.floor(Math.min(Math.max(0, nnum(v.lastBurst, 0)), COUNT_MAX));
    v.lastUsual = Number.isFinite(v.lastUsual) ? Math.min(Math.max(0, v.lastUsual), LAMBDA_MAX) : 0;
    v.rising = v.rising === true;
    v.shorterRestart = v.shorterRestart === true;
    v.proved = Math.min(Math.max(0, nnum(v.proved, 0)), ABSURD);
    v.provedDown = v.provedDown === true;
    out[id] = v;
  }
  return out;
}

/** Why a ledger line does not hold, or null: json, its prev (when one is expected) and its signature. */
export function lineProblem(line: string, key: EyeKey, expectPrev: string | null): string | null {
  let obj: { prev?: unknown };
  try { obj = JSON.parse(line); } catch { return 'not a ledger line'; }
  if (expectPrev !== null && obj.prev !== expectPrev) return 'the chain is broken (a line was changed, dropped or put in)';
  const m = SIG_TAIL.exec(line);
  if (!m) return 'a line has no signature';
  let ok = false;
  try { ok = key.verify(line.slice(0, m.index), m[1]) === true; } catch {}
  return ok ? null : 'a signature does not match the device key';
}

/** The certificate the device shows: the one pinned (kula compared it with the pin, which stays
 *  out of the snapshot), and naming the key that signs its ledger, worked out here. */
export function identityCheck(t: EyeTrust, keys: EyeKeys | null | undefined): TrustCheck {
  const k = 'identity';
  if (!t.cert || !t.pub || !t.id) return { k, ok: null, text: 'it did not show its certificate' };
  if (t.certPinned === null) return { k, ok: null, text: 'nothing pinned here to compare its certificate with' };
  if (!t.certPinned) return { k, ok: false, text: 'the certificate it shows is not the one pinned from its qr' };
  let keyId = '';
  try { keyId = sha(fromBase64(t.pub)).slice(0, 32); } catch {}
  if (keyId !== t.id.toLowerCase()) return { k, ok: false, text: 'its ledger key is not the device it claims to be' };
  if (!keys) return { k, ok: null, text: 'its certificate cannot be read here' };
  let cn: string | null = null;
  try { cn = /CN=([0-9a-fA-F]{32})/.exec(keys.certSubject(t.cert) ?? '')?.[1]?.toLowerCase() ?? null; } catch {}
  if (cn !== keyId) return { k, ok: false, text: 'its certificate names another device than its ledger key' };
  return { k, ok: true, text: `certificate matches the pin and names its ledger key (${keyId.slice(0, 8)}…)` };
}

/** Owner-blind: what the device's last proof showed (attest.ts), as kula's engine kept it. The
 *  snapshot is not trusted: a field out of shape is no proof. */
export function ownerBlindCheck(d: Pick<EyeDevice, 'kind'>, t: EyeTrust, now: number, proved = 0): TrustCheck {
  const k = 'owner-blind';
  // a device that proved once (proved: the `at` of its newest proof that held) can make one: a phone
  const phone = d.kind === 'phone' || proved > 0;
  const a = t.attest as unknown;
  if (a == null || typeof a !== 'object') return { k, ok: null, text: phone ? 'not asked yet whether its owner can read jobs' : 'a computer cannot prove this' };
  const x = a as { at?: unknown; ok?: unknown; text?: unknown };
  if (typeof x.at !== 'number' || !Number.isFinite(x.at) || (x.ok !== true && x.ok !== false && x.ok !== null) || typeof x.text !== 'string' || !x.text || x.text.length > 300) {
    return { k, ok: null, text: 'its last proof could not be read' };
  }
  const stale = now - x.at > ATTEST_STALE || x.at > now + HOUR;
  if (x.ok !== null && stale) return { k, ok: null, text: `its last proof is from ${day(x.at)}: not asked again since` };
  // a phone that answers as a computer would, or leaves the proof out, shows nothing (G3)
  if (x.ok === null && !stale && phone) {
    return { k, ok: false, text: d.kind === 'phone' ? 'it sent no proof (a phone can make one): nothing shows its owner cannot read jobs' : 'it sent no proof, though it has before: nothing shows its owner cannot read jobs' };
  }
  return { k, ok: x.ok as boolean | null, text: x.text };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** a whole number a line shows: floored, so 40.7 lines is 40, never a fraction */
const fmt = (n: number) => String(Math.floor(n));
const STARTOVER = 'its ledger started over';   // the started-over fault's prefix, for keeping it

export function create(ctx: BranchCtx): Branch {
  const notes: Notes = sane(ctx.load<unknown>({}));
  let snap: Snapshot | null = null;
  let report: TrustReport | null = null;
  const said = new Map<string, Verdict>();
  // each device's last window, line -> its sha256 (A8): only lines not in the last answer are
  // hashed again. Keyed by the whole line, so a line changed by one byte is a new line and hashed;
  // rebuilt from this answer's lines every time, so it never holds more than one window per device.
  // Memory only: nothing here is a verdict, and losing it costs one full hash of the window.
  const hashed = new Map<string, Map<string, string>>();
  function hashesOf(id: string, lines: string[]): string[] {
    const was = hashed.get(id);
    const now = new Map<string, string>();
    const out = lines.map((l) => {
      let h = now.get(l) ?? was?.get(l);
      if (h === undefined) h = sha(l);
      now.set(l, h);
      return h;
    });
    hashed.set(id, now);
    return out;
  }

  // a new answer (t.at changed, no t.error, a sane clock): the device's new ledger lines, joined to
  // the last one verified and checked one by one, the ledger length, then the refusals into their
  // hour. The snapshot is not trusted: every field is validated or coerced first.
  function takeIn(d: EyeDevice, t: EyeTrust, s: Seen): boolean {
    if (t.error || typeof t.at !== 'number' || !Number.isFinite(t.at) || t.at < 0 || t.at > ABSURD || t.at === s.at) return false;
    const prevAt = s.at;          // the answer before this one, for the gap check below
    s.at = t.at;
    const name = devName(d);
    const restartedAt = typeof t.restartedAt === 'number' && Number.isFinite(t.restartedAt) && t.restartedAt >= 0 ? t.restartedAt : null;
    const lines = Array.isArray(t.lines) ? t.lines.filter((l) => typeof l === 'string') : [];   // a missing window is none
    const hashes = hashesOf(d.id, lines);
    const countIn = typeof t.count === 'number' && Number.isFinite(t.count) && t.count >= 0 && t.count <= COUNT_MAX
      ? Math.floor(t.count) : null;   // whole lines only: 40.7 is 40; null: this answer carries no usable count
    const restart = restartedAt != null && restartedAt !== s.restartSeen;
    // the "started over" fault is raised only when the verified head is really gone from the lines:
    // a restart flag alone is the device's word and never lowers the remembered count by itself
    const startedOver = restart && !!s.head && !hashes.includes(s.head);
    let key: EyeKey | null = null;
    try { key = t.pub && ctx.keys ? ctx.keys.key(t.pub) : null; } catch {
      // no key, no checks: the restart stays unconsumed, so the next answer that can be checked
      // raises the started-over fault instead of it being lost
    }
    let lineFault = false;
    if (key) {
      let start = 0;
      let expect: string | null = null;
      if (s.head) {
        const i = hashes.indexOf(s.head);
        if (i >= 0) { start = i + 1; expect = s.head; s.gap = false; }
        else if (startedOver) {
          // the started-over fault is the alarm for the shorter ledger too: the remembered count
          // comes down here, to this answer's count when it has one and to nothing when it does
          // not, so the same restart cannot raise "got shorter" once both faults are accepted.
          // a restart flag alone never reaches this: startedOver needs the verified head really gone
          const replacingShorter = s.shorterRestart;
          s.shorterRestart = false;
          s.fault = `${STARTOVER} at ${hhmm(restartedAt!)} (cleared on the device, or rewritten)`;
          s.faultAt = restartedAt; s.faultLine = null; s.shrunkTo = null; s.held = null;
          s.count = countIn ?? 0;
          s.verified = 0; s.since = ctx.now();
          s.gap = false;          // the new chain is followed from here: nothing left to join
          // the verdict-change line tells the feed when the device only turns red now; a started-over
          // that replaces a shorter fault for the same unconsumed restart was already said once
          if (!replacingShorter && (said.get(d.id) === 'bad' || !said.has(d.id))) ctx.emit(`${name}: ${s.fault}`);
        } else if (lines.length && lineProblem(lines[0], key, s.head) === null) {
          // the window's first line follows the head: joined, checked from there
          expect = s.head; s.gap = false;
        } else if (lines.length) {
          // the head left the window and nothing joins the new lines to it (the engine checks every
          // link as lines pass, but after its own restart it keeps only the last answer). nothing is
          // checked: the head and the count verified stay, and the ledger is never ok until the
          // person accepts carrying on from here
          if (!s.gap) ctx.emit(`${name}: its ledger could not be joined to the lines checked before`);
          s.gap = true;
          start = lines.length;
        }
      }
      if (restartedAt != null) s.restartSeen = restartedAt;
      for (let i = start; i < lines.length; i++) {
        const why = lineProblem(lines[i], key, i === start ? expect : hashes[i - 1]);
        if (why) {
          if (s.fault != null && s.fault.startsWith(STARTOVER)) {
            // the started-over fault stays until the person accepts it; a line fault waits behind it
            if (!s.held) s.held = { h: hashes[i], why };
          } else if (s.faultLine !== hashes[i]) {
            s.fault = why; s.faultAt = ctx.now(); s.faultLine = hashes[i]; s.shrunkTo = null; s.shorterRestart = false; ctx.emit(`${name}: its ledger: ${why}`);
          }
          lineFault = true;
          break;
        }
        if (!s.since) s.since = ctx.now();
        s.head = hashes[i];
        s.verified++;
      }
    }
    // the remembered count is a high-water mark on purpose: it must not re-anchor by itself, because
    // a ledger that reports fewer lines is the fault itself; only accept, or the one answer whose
    // "started over" fault was really raised, lowers it. an absurd count is ignored rather than
    // remembered, and an unaccepted line fault is kept: the shorter fault waits until it is accepted.
    if (!lineFault && countIn !== null) {
      const n = countIn;
      if (n >= s.count) { if (n > s.count) s.count = n; s.shrunkTo = null; }
      else if (s.shrunkTo == null && s.faultLine == null) {
        // the fault text keeps the numbers from the moment it was raised: no new feed line per new line
        s.shrunkTo = n;
        const shorter = `its ledger got shorter: ${fmt(s.count)} lines before, ${fmt(n)} now (lines were removed)`;
        if (s.fault !== shorter) {
          s.fault = shorter; s.faultAt = ctx.now(); s.faultLine = null;
          // no usable key leaves a restart unconsumed: the started-over fault will be about the same
          // event, so it replaces this text later without a second feed line
          s.shorterRestart = restart && !key;
          // the verdict-change line already tells the feed when the device only turns red now;
          // a device that was red before needs the line here, so the feed says it once
          if (said.get(d.id) === 'bad' || !said.has(d.id)) ctx.emit(`${name}: ${shorter}`);
        }
      }
    }
    // refusals, counted into hours of the answer's own clock
    const rejects = cleanDay(t.rejectsDay);
    const total = dayTotal(rejects);
    const rts: number[] = [];
    // the list is the last few anyway; only sane times count, so a far-forward one cannot stick
    for (const r of (Array.isArray(t.rejectsLast) ? t.rejectsLast : []).slice(-1000)) {
      if (r && typeof r === 'object' && typeof r.t === 'number' && Number.isFinite(r.t) && r.t >= 0 && r.t <= ABSURD) rts.push(r.t);
    }
    const newest = rts.length ? rts.reduce((a, x) => (x > a ? x : a), 0) : -1;
    if (s.rejAt < 0) {
      // the first answer: only remember, so the next one counts what came after
      s.rejAt = newest >= 0 ? newest : 0;
      s.rejTotal = total;
      s.win = { start: t.at, k: 0 };
    } else if (t.at - prevAt > HOUR || prevAt - t.at > HOUR) {
      // a gap in the looks (the computer was away, the phone asleep, or the clock jumped either
      // way): the refusals in between cannot be placed into any hour; re-anchor only and count
      // nothing, learn nothing. the finished hour before the gap is too old to call the rate still
      // raised: the burst and the rise end here (the hours in between were not seen, so the CUSUM
      // starts again), and a quiet look after the gap must not be red
      s.rejAt = newest >= 0 ? newest : s.rejAt;
      s.rejTotal = total;
      s.win = { start: t.at, k: 0 };
      s.lastBurst = 0;
      s.lastUsual = 0;
      s.rising = false;
      s.burst = { ...s.burst, s: 0 };
    } else {
      const rolledBack = newest >= 0 && s.rejAt - newest > HOUR;   // the device's clock went back: re-anchor
      // count only entries proven to lie in the running hour: newer than the watermark and not older
      // than the hour before this answer; the day's total stands in only when the looks are close
      const listed = rolledBack ? 0 : rts.filter((x) => x > s.rejAt && x > t.at - HOUR).length;
      // the list keeps only the last few; when the day's total says more happened, believe the total.
      // one answer counts at most PER_ANSWER, so a lying device cannot blow the hour up
      const nfresh = Math.min(Math.max(listed, Math.max(0, total - s.rejTotal)), PER_ANSWER);
      s.rejAt = newest >= 0 ? (rolledBack ? newest : Math.max(s.rejAt, newest)) : s.rejAt;
      s.rejTotal = total;
      if (t.at - s.win.start >= HOUR || s.win.start - t.at > HOUR) {
        // the hour closed, or the answer's clock went back past its start: the finished hour is
        // held against its own hour of day and learned (burst.ts; a flagged hour teaches little).
        // a burst is remembered with that hour's usual, so the check stays red until a finished
        // hour is quiet. then the window re-anchors
        const r = burstStep(s.burst, hourOf(s.win.start), Math.min(s.win.k, PER_ANSWER));
        s.burst = r.fit;
        s.lastBurst = r.tail ? s.win.k : 0;
        s.lastUsual = r.tail ? Math.min(r.usual, LAMBDA_MAX) : 0;
        s.rising = r.rise;
        s.win = { start: t.at, k: 0 };
      }
      s.win.k += nfresh;
    }
    // owner-blind's memory: the newest proof that held, and a fall from it said once. ok null (a
    // stale proof, one that cannot be read, not asked yet) is not the device's fall: nothing changes
    const ob = ownerBlindCheck(d, t, ctx.now(), s.proved);
    if (ob.ok === true) {
      s.proved = Math.min((t.attest as { at: number }).at, ABSURD);
      s.provedDown = false;
    } else if (ob.ok === false && s.proved > 0 && !s.provedDown) {
      s.provedDown = true;
      ctx.emit(`${name}: it proved before (${day(s.proved)}) that its owner cannot read jobs, and no longer does: ${ob.text}`);
    }
    return true;
  }

  function deviceReport(d: EyeDevice): TrustReport['devices'][number] {
    // a bad id gets a throwaway, nothing stored (the view still shows the device)
    const s = okId(d.id) ? (notes[d.id] ??= fresh()) : fresh();
    s.seen = ctx.now();           // for the cap: the devices not seen for the longest go first
    const t = d.trust && typeof d.trust === 'object' ? d.trust : null;
    const name = devName(d);
    const tls = d.tls === true;
    const reason = typeof d.reason === 'string' && d.reason.length > 0 && d.reason.length <= 200 ? d.reason : null;
    const err = typeof t?.error === 'string' && t.error.length > 0 && t.error.length <= 200 ? t.error : null;
    const rejects = cleanDay(t?.rejectsDay);
    const checks: TrustCheck[] = [];
    let unchecked = false;        // it reports ledger lines, none verified here: its ledger null counts
    checks.push(tls
      ? { k: 'pinned', ok: true, text: 'certificate pinned from its qr' }
      : { k: 'pinned', ok: false, text: 'older pairing: a shared secret, no certificate. pair it again with its qr' });
    checks.push(!tls
      ? { k: 'encrypted', ok: false, text: 'prompts and answers cross the network in plain text' }
      : t?.v1 === true
        ? { k: 'encrypted', ok: false, text: 'tls on this link, but it still accepts the old plain-text protocol' }
        : { k: 'encrypted', ok: true, text: 'tls 1.3, both sides show a certificate' });
    const answered = !!t && !t.error;
    if (!answered) {
      checks.push({ k: 'identity', ok: null, text: err ? `not checked: ${err}` : d.reachable === false ? `not checked: not reachable${reason ? ` (${reason})` : ''}` : 'not checked yet' });
    } else {
      let ident: TrustCheck;
      try { ident = identityCheck(t!, ctx.keys); } catch { ident = { k: 'identity', ok: null, text: 'it did not show a proper certificate' }; }
      checks.push(ident);
      const refused = Object.entries(rejects).sort((a, b) => b[1] - a[1]);
      const guesses = refused.filter(([w]) => GUESSES.has(w)).reduce((a, [, n]) => a + n, 0);
      const replays = rejects.replay ?? 0;
      const words = refused.map(([w, n]) => `${w} ×${n}`).join(', ');
      // the running hour is held against what this hour of the day usually holds (burst.ts), once
      // enough hours were taken in and this hour of day was seen often enough
      const f = s.burst;
      const h = hourOf(s.win.start);
      const kIn = Math.min(s.win.k, PER_ANSWER);
      const usual = Math.min(f.a[h] / f.b[h], LAMBDA_MAX);
      const known = f.n >= NEED && f.b[h] - B0 >= STRATUM_NEED;
      // the running hour is a burst when it is far into the negative binomial tail of its usual
      const burst = known && kIn >= MIN_K && nbTail(kIn, f.a[h], f.b[h]) < TAIL_P;
      // a burst hour just finished: the rate has not been shown to come back down, so stay red
      const stillBurst = !burst && s.lastBurst > 0;
      // several finished hours each a little high: the CUSUM says the rate went up
      const rising = !burst && !stillBurst && s.rising;
      const learning = f.n < NEED
        ? ` (still learning what is usual: ${fmt(f.n)} of ${NEED} hours)`
        : known ? '' : ' (still learning what is usual at this hour of day)';
      checks.push(replays > 0
        ? { k: 'refused', ok: false, text: `someone replayed a recorded handshake (${plural(replays, 'time')} today); it was refused` }
        : guesses >= GUESS_LIMIT
          ? { k: 'refused', ok: false, text: `${guesses} wrong codes today: someone may be guessing. all were refused` }
          : burst
            ? { k: 'refused', ok: false, text: `${fmt(Math.min(s.win.k, K_MAX))} refusals in the last hour, at this hour of day it usually sees about ${usual.toFixed(1)}: unusual. all were refused` }
            : stillBurst
              ? { k: 'refused', ok: false, text: `refusals still above its usual: ${fmt(Math.min(s.lastBurst, K_MAX))} in the last finished hour, at that hour of day usually about ${s.lastUsual.toFixed(1)}` }
              : rising
                ? { k: 'refused', ok: false, text: 'refusals have been running above its usual for the last hours. all were refused' }
                : { k: 'refused', ok: true, text: (refused.length ? `refused today: ${words}` : 'nothing refused today') + learning });
      const hasCount = typeof t!.count === 'number' && Number.isFinite(t!.count) && t!.count >= 0 && t!.count <= COUNT_MAX;
      const reported = hasCount ? Math.floor(t!.count as number) : 0;
      // a device that says (or once said) it has lines but never handed one over that held here is
      // not checked, and must not pass as "every ledger holds". a device with no lines at all (count
      // 0 or none) stays exempt, and so does one whose chain holds here but that stopped saying its length
      // a gap is not checked either: lines came that nothing joins to the ones verified before
      unchecked = s.gap || (!s.head && (reported > 0 || (!hasCount && s.count > 0)));
      checks.push(s.fault
        ? { k: 'ledger', ok: false, text: s.fault }
        : t!.self === 'broken'
          ? { k: 'ledger', ok: false, text: 'the device says its own ledger is broken' }
          : s.gap
            ? { k: 'ledger', ok: null, text: `its ledger could not be joined to the ${plural(s.verified, 'line')} checked before: lines came while this computer was not looking. accept to carry on from here` }
            : !hasCount && s.count > 0
              ? { k: 'ledger', ok: null, text: `it stopped reporting its ledger length (${fmt(s.count)} lines before)` }
              : s.head
                ? { k: 'ledger', ok: true, text: `${plural(s.verified, 'line')} checked here since ${day(s.since)}: the chain and every signature hold` }
                : reported > 0
                  ? { k: 'ledger', ok: null, text: `it reports ${plural(reported, 'line')}, none checked here yet` }
                  : { k: 'ledger', ok: null, text: 'no ledger lines yet' });
      checks.push(t!.store === 'keystore'
        ? { k: 'key', ok: true, text: 'its key is in the phone’s keystore and cannot be copied out' }
        : { k: 'key', ok: null, text: t!.store === 'file' ? 'its key is in a file on the device' : 'it did not say where its key is' });
      checks.push(ownerBlindCheck(d, t!, ctx.now(), s.proved));
    }
    // the key's place is the device's word, not checked, and owner-blind is informational for now:
    // neither turns a device red or green
    const counted = checks.filter((c) => !INFO.has(c.k));
    const verdict: Verdict = counted.some((c) => c.ok === false) ? 'bad' : !answered || counted.some((c) => c.ok === null && (c.k !== 'ledger' || unchecked)) ? 'unknown' : 'ok';
    const rd = answered ? dayTotal(rejects) : 0;
    return { id: d.id, name, verdict, checks, refused: rd ? `${rd} refused today` : '', accept: !!s.fault || (answered && s.gap) };
  }

  function build(now: Snapshot): TrustReport {
    // the snapshot is not trusted: a missing host or device list is none
    const h = now.host && typeof now.host === 'object' ? now.host : { name: 'this computer', freeMb: null, ledger: null };
    const hl = h.ledger && typeof h.ledger === 'object' && typeof h.ledger.count === 'number' && Number.isFinite(h.ledger.count)
      ? h.ledger : null;
    const hlProblem = hl && typeof hl.problem === 'string' && hl.problem.length <= 200 ? hl.problem : null;
    const host: TrustCheck[] = [hl == null
      ? { k: 'ledger', ok: null, text: 'this computer keeps no ledger yet (it has not shared itself)' }
      : hl.ok
        ? { k: 'ledger', ok: true, text: `its own ledger: ${plural(hl.count, 'line')}, the chain and every signature hold` }
        : { k: 'ledger', ok: false, text: `its own ledger is broken${hlProblem ? `: ${hlProblem}` : ''}` }];
    const devices = (Array.isArray(now.devices) ? now.devices.filter((d): d is EyeDevice => !!d && typeof d === 'object') : []).map(deviceReport);
    const bad = devices.filter((d) => d.verdict === 'bad');
    const hostBad = host.some((c) => c.ok === false);
    const waiting = devices.filter((d) => d.verdict === 'unknown');
    let verdict: Verdict;
    let headline: string;
    if (bad.length || hostBad) {
      verdict = 'bad';
      const first = bad[0] ? `${bad[0].name}: ${firstBad(bad[0].checks).text}` : `this computer: ${host.find((c) => c.ok === false)!.text}`;
      const n = bad.length + (hostBad ? 1 : 0);
      headline = n > 1 ? `${n} things to look at. first, ${first}` : first;
    } else if (!devices.length) {
      verdict = 'unknown'; headline = 'no devices to check yet';
    } else if (waiting.length) {
      verdict = 'unknown'; headline = `not checked yet: ${waiting.map((d) => d.name).join(', ')}`;
    } else {
      verdict = 'ok';
      headline = `${plural(devices.length, 'device')}: every link pinned and encrypted, every ledger holds`;
    }
    for (const d of devices) {
      const was = said.get(d.id);
      if (was && was !== d.verdict && d.verdict === 'bad') {
        // every check that turned red says its line once, so a burst and a shorter ledger in the
        // same look both reach the feed
        for (const c of d.checks) if (c.ok === false && !INFO.has(c.k)) ctx.emit(`${d.name}: ${c.text}`);
      }
      if (was === 'bad' && d.verdict === 'ok') ctx.emit(`${d.name}: all clear again`);
      said.set(d.id, d.verdict);
    }
    return { verdict, headline, at: now.at, host: { name: typeof h.name === 'string' && h.name ? h.name : 'this computer', checks: host }, devices };
  }

  // the notes stay bounded: past MAX_DEVICES, devices that are not in this snapshot go, the longest
  // unseen first. a device in this snapshot is never dropped (G10): wiped notes would let it start its
  // ledger over unseen. the guard bounds the snapshot's list, so the notes stay bounded too
  function trim(current: Set<string>) {
    const ids = Object.keys(notes);
    if (ids.length > MAX_DEVICES) {
      const gone = ids.filter((id) => !current.has(id)).sort((a, b) => notes[a].seen - notes[b].seen);
      for (const id of gone.slice(0, Math.min(gone.length, ids.length - MAX_DEVICES))) delete notes[id];
    }
    // the last verdict said is kept only for devices the notes keep or the snapshot shows
    for (const id of [...said.keys()]) if (!(id in notes) && !current.has(id)) said.delete(id);
  }
  // a device the notes no longer keep keeps no hashes either
  function trimHashes() {
    for (const id of hashed.keys()) if (!(id in notes)) hashed.delete(id);
  }

  // a warning card for each device running the loaded model (or holding layers of a split) whose
  // owner could read its jobs, or that cannot show otherwise and is a friend's (the circle ring)
  function ownerBlindCards(): Suggestion[] {
    const loaded = snap?.work && typeof snap.work === 'object' ? snap.work.loaded : null;
    const running = new Set((Array.isArray(loaded?.devices) ? loaded!.devices : []).filter((x) => x && !x.local && okId(x.id)).map((x) => x.id));
    for (const p of Array.isArray(loaded?.parts) ? loaded!.parts : []) {
      if (p && typeof p === 'object' && !p.local && okId(p.id) && typeof p.mb === 'number' && p.mb > 0) running.add(p.id);
    }
    const rings = new Map<string, unknown>();
    for (const x of Array.isArray(snap?.devices) ? snap!.devices : []) if (x && typeof x === 'object' && okId(x.id)) rings.set(x.id, x.ring);
    const out: Suggestion[] = [];
    for (const d of report?.devices ?? []) {
      if (!running.has(d.id)) continue;
      const c = d.checks.find((x) => x.k === 'owner-blind');
      if (!c || !(c.ok === false || (c.ok === null && rings.get(d.id) === 'circle'))) continue;
      out.push({
        id: cardId('trust', 'owner-blind', d.id), kind: 'warn', weight: 1,
        title: c.ok === false ? `${d.name} could read the jobs it runs` : `${d.name} has not shown that its owner cannot read the jobs it runs`,
        why: `${c.text}. Prompts reach it in plain text, so only give it work you would show its owner.`,
        action: { do: 'open', panel: 'branch', branch: 'trust' }, label: 'look',
      });
    }
    return out;
  }

  return {
    id: 'trust',
    observe(now) {
      snap = now;
      // the snapshot is not trusted: a broken device list is none, a broken entry is skipped
      const devs = Array.isArray(now.devices) ? now.devices.filter((d): d is EyeDevice => !!d && typeof d === 'object') : [];
      let changed = false;
      for (const d of devs) {
        if (!d.trust || !okId(d.id)) continue;   // nothing to take in, or no key the notes can take
        changed = takeIn(d, d.trust, (notes[d.id] ??= fresh())) || changed;
      }
      report = build(now);
      trim(new Set(devs.map((d) => d.id)));
      trimHashes();
      if (changed) ctx.save(notes);
    },
    act(action, arg) {
      if (action !== 'accept') return null;
      const s = notes[arg];
      if (s && !s.fault && s.gap) {
        // the person carries on from here (only their tap): the next answer is checked from its
        // first line. the count high-water mark stays, so a shorter ledger is still caught
        s.gap = false; s.head = null; s.verified = 0; s.since = 0;
        ctx.save(notes);
        if (snap) report = build(snap);
        return 'noted';
      }
      if (!s?.fault) return null;
      // the person knows (they cleared the ledger on the phone, say): carry on from here
      if (s.held) {
        // the line fault that was waiting behind the started-over fault comes forward, with its line
        s.fault = s.held.why; s.faultAt = ctx.now(); s.faultLine = s.held.h; s.held = null; s.shorterRestart = false;
        const d = snap?.devices.find((x) => okId(x.id) && x.id === arg);
        ctx.emit(`${d ? devName(d) : arg}: its ledger: ${s.fault}`);
      } else {
        if (s.shrunkTo != null) { s.count = s.shrunkTo; s.shrunkTo = null; }
        if (s.faultLine) s.head = s.faultLine;
        s.fault = null; s.faultAt = null; s.faultLine = null; s.shorterRestart = false;
      }
      ctx.save(notes);
      if (snap) report = build(snap);
      return 'noted';
    },
    view() {
      const devs = snap?.devices ?? [];
      if (!report || !devs.length) return { built: true, stat: 'nothing to check', gauge: null, rows: [], lines: [], report: report ?? undefined };
      const ok = report.devices.filter((d) => d.verdict === 'ok').length;
      const bad = report.devices.filter((d) => d.verdict === 'bad').length + (report.host.checks.some((c) => c.ok === false) ? 1 : 0);
      return {
        built: true,
        stat: report.verdict === 'ok' ? `all clear · ${plural(devs.length, 'device')}` : report.verdict === 'bad' ? `${plural(bad, 'thing')} to look at` : 'not checked yet',
        gauge: pct(ok, devs.length),
        rows: [],
        lines: report.devices.map((d) => `${d.name} · ${d.verdict === 'ok' ? 'all clear' : d.verdict === 'bad' ? firstBad(d.checks).text : 'not checked yet'}`),
        note: 'nothing private goes into these checks: no prompts, no answers, only who connected and whether it was let in.',
        report,
        suggestions: ownerBlindCards(),
      };
    },
  };
}
