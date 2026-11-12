// 1 senses: every device, is it there, how much memory, how fast it answers — and, from the
// probe readings alone, how quickly it usually answers, whether its link is flapping, and whether
// the engine has stopped looking at it. A reading is new when the engine's checkedAt changes (the
// engine probes about every 15 s, the eye looks every 5 s); the last 30 new readings are kept per
// device. The latency is robust: the median and MAD spot a spike, RFC 6298 smooths the usual
// range (SRTT ± 4 * RTTVAR, its low end floored at 0, shown as "usually X ms (lo–hi)"), and a
// Nagios-style weighted count of ups and downs decides flapping with hysteresis; a stale line
// does not say flapping, and ten usual gaps without a new reading clear the flag; while a link
// flaps the feed gets its one "is flapping" line, not an up/down line per flip. A device the
// current load works on (work.loaded.devices or parts) is not probed by the engine: it reads "in
// use", never stale. The stat and gauge count a device active only when its look is fresh or it is
// in use; a stale one is "not checked lately". Its notes are
// one small json (ctx.save), bounded and saved at most once a minute; the view lists 40 device
// lines at most and then how many it left out.
// Every value taken from the snapshot is checked first: a reading only enters the notes when the
// ok is a boolean and checkedAt is a usable time, so this branch never writes notes its own
// read-back would throw away, and no NaN or absurd number reaches the view. A shown number also has
// a plausible ceiling: a latency up to 10 minutes, free memory up to 4 TB, a bandwidth of 0.01 to
// 10 000 GB/s, a silence up to a year ("over a year ago" after that); anything beyond is left out.
import type { Branch, BranchCtx, EyeDevice, Snapshot } from '../types.js';
import { active, gb, pct } from './util.js';

const READINGS_MAX = 30;                 // new readings kept per device
const OK_MIN = 5;                        // ok readings with a ms before a latency is shown
const OUTLIER_SIGMAS = 3.5;              // |ms - median| over this many sigmas is an outlier
const MAD_SCALE = 1.4826;                // MAD to sigma for normally distributed noise
const FLAP_LOOKS = 21;                   // the flapping window: up to 20 places to change
const FLAP_MIN_READINGS = 8;             // fewer readings than this: no flap change yet
const FLAP_START = 0.30;                 // change at or over this starts flapping
const FLAP_END = 0.15;                   // change at or under this ends it (hysteresis)
const FLAP_QUIET_GAPS = 10;              // no new reading for ten usual gaps: not flapping any more
const GAP_DEFAULT_MS = 15_000;           // the probe gap assumed until three real gaps exist
const GAP_MIN_MS = 5_000;
const GAP_MAX_MS = 120_000;
const STALE_GAPS = 3;                    // stale after three usual gaps without a new reading
const MAX_DEVICES = 40;
const NAME_MAX = 80;                     // a name longer than this is cut in the notes and the line
const DEVICE_MAX = 200;                  // an id longer than this is not one of ours
const REASON_MAX = 120;                  // a reason longer than this is cut in the view
const TIME_MAX = 8.64e15;                // the largest ms a date can hold (ECMAScript)
const MS_MAX = 600_000;                  // no probe waits ten minutes: a longer latency is no measurement
const RAM_MAX_MB = 4 * 1024 * 1024;      // 4 TB: more free memory than that is not shown
const BW_MIN_GBS = 0.01;                 // a bandwidth is shown to two decimals
const BW_MAX_GBS = 10_000;
const AGO_MAX_S = 365 * 86_400;          // a silence longer than a year is shown as "over a year"
const SAVE_EVERY_MS = 60_000;

/** one probe, as the engine saw it: when it looked, did it answer, how long it took. */
export interface Reading { at: number; ok: boolean; ms: number | null }

interface DevNotes {
  name: string;
  seen: number;                  // ms, the last snapshot at it was in (for the 40 device cap)
  r: Reading[];                  // the last new readings, oldest first
  srtt: number | null;           // RFC 6298 smoothed round trip
  rttvar: number | null;         // RFC 6298 variation
  flapping: boolean;             // its link is flapping now
}
export interface SensesNotes { v: 1; dev: Record<string, DevNotes> }

/** a time this branch may keep: finite, not negative, date-sized */
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= TIME_MAX;

/** a latency (or its smooth) this branch may keep and show: 0 to 10 minutes */
const isMs = (x: unknown): x is number => isTime(x) && x <= MS_MAX;

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

/** a device god's eye can name and key: only a non-string or empty id, an id over 200 chars,
 *  or a non-string name is skipped. a long name is a real device, cut when it is shown. */
function usable(d: unknown): d is EyeDevice {
  if (!isObject(d)) return false;
  const x = d as unknown as EyeDevice;
  return typeof x.id === 'string' && x.id.length > 0 && x.id.length <= DEVICE_MAX && typeof x.name === 'string';
}

/** the name in lines, rows and the feed; a device without one goes by its id */
const shownName = (d: EyeDevice) => (d.name.trim() || d.id).slice(0, NAME_MAX);

/** the feed line for a device whose answer changed: it answers again, or it stopped, with its
 *  reason cut. called only when reachable is a boolean. */
function flipLine(d: EyeDevice): string {
  if (d.reachable === true) return `${shownName(d)} answers again`;
  const reason = typeof d.reason === 'string' && d.reason ? `: ${d.reason.slice(0, REASON_MAX)}` : '';
  return `${shownName(d)} stopped answering${reason}`;
}

/** the reach word, built here from validated values so a bad reachMs or reason cannot reach the
 *  view. good values read exactly as util's reachWord does. withMs is false for a stale device:
 *  its last latency is not a current number. */
function reachOf(d: EyeDevice, withMs: boolean): string {
  if (d.reachable !== true && d.reachable !== false) return 'not checked yet';
  if (d.reachable) return withMs && isMs(d.reachMs) ? `reachable · ${Math.round(d.reachMs)} ms` : 'reachable';
  const reason = typeof d.reason === 'string' ? d.reason.slice(0, REASON_MAX) : 'no answer';
  return `not reachable: ${reason}`;
}

/** the middle value, or the mean of the two middle ones; null for none. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/** the median distance from the median; null for none. */
export function mad(xs: number[]): number | null {
  const m = median(xs);
  if (m == null) return null;
  return median(xs.map((x) => Math.abs(x - m)));
}

/** one RFC 6298 step. the first sample: SRTT = R, RTTVAR = R / 2. then
 *  RTTVAR = 3/4 * RTTVAR + 1/4 * |SRTT - R| and SRTT = 7/8 * SRTT + 1/8 * R, RTTVAR first. */
export function rfc6298(srtt: number | null, rttvar: number | null, r: number): { srtt: number; rttvar: number } {
  if (srtt == null || rttvar == null) return { srtt: r, rttvar: r / 2 };
  const v = 0.75 * rttvar + 0.25 * Math.abs(srtt - r);
  const s = 0.875 * srtt + 0.125 * r;
  return { srtt: s, rttvar: v };
}

/** nagios-style flap change over the last 21 readings: the sum of the weights of the places
 *  where ok changed / the sum of the weights of the places that exist. place i (0 = oldest) has
 *  weight 0.8 + 0.4 * i/19, so a recent change weighs more. fewer than 8 readings: null. */
export function flapChange(oks: boolean[]): number | null {
  const w = oks.slice(-FLAP_LOOKS);
  if (w.length < FLAP_MIN_READINGS) return null;
  let changed = 0;
  let total = 0;
  for (let i = 0; i < w.length - 1; i++) {
    const weight = 0.8 + 0.4 * (i / 19);
    total += weight;
    if (w[i] !== w[i + 1]) changed += weight;
  }
  return total > 0 ? changed / total : null;
}

/** the usual probe gap: the median of the positive gaps (a clock that went backwards leaves a
 *  negative one, ignored), 15 s until three exist, clamped to 5–120 s. */
export function usualGap(gaps: number[]): number {
  const good = gaps.filter((g) => Number.isFinite(g) && g > 0);
  const m = good.length >= STALE_GAPS ? median(good) : null;
  return Math.min(GAP_MAX_MS, Math.max(GAP_MIN_MS, m ?? GAP_DEFAULT_MS));
}

/** is the last probe too old? a device is stale when at - checkedAt > 3 * its usual gap. a time
 *  that is not usable means no staleness is judged, so a null, NaN or absurd clock never invents
 *  a silence. */
export function isStale(at: number | null, checkedAt: number | null, gaps: number[]): boolean {
  if (!isTime(at) || !isTime(checkedAt)) return false;
  return at - checkedAt > STALE_GAPS * usualGap(gaps);
}

/** the gaps between consecutive readings; a backward clock step leaves a negative one, and
 *  usualGap is the one place that filters to the positive ones. */
function gapsOf(r: Reading[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < r.length; i++) out.push(r[i].at - r[i - 1].at);
  return out;
}

/** keep 40 devices: those in this look first, then the ones seen last, so a device that is here
 *  never goes in favour of one that is not. true when something went.
 *  after a backward clock step every absent device's seen ties, so the cap falls back to
 *  insertion order. */
function trim(dev: Record<string, DevNotes>, present?: Set<string>): boolean {
  const ids = Object.keys(dev);
  if (ids.length <= MAX_DEVICES) return false;
  const here = (id: string) => (present?.has(id) ? 1 : 0);
  ids.sort((a, b) => here(b) - here(a) || dev[b].seen - dev[a].seen);
  for (const id of ids.slice(MAX_DEVICES)) delete dev[id];
  return true;
}

/** the ids of the other devices the current load works on: work.loaded.devices (local entries left
 *  out) and work.loaded.parts. the engine does not probe a device in use, so its checkedAt ages
 *  while it answers; such a device is "in use", not stale. */
function inUseIds(s: Snapshot | null): Set<string> {
  const out = new Set<string>();
  const w = s && isObject(s.work) ? s.work : null;
  const L = w && isObject(w.loaded) ? w.loaded : null;
  if (!L) return out;
  for (const list of [L.devices, L.parts] as unknown[]) {
    if (!Array.isArray(list)) continue;
    for (const x of list) {
      if (!isObject(x) || x.local === true) continue;
      if (typeof x.id === 'string' && x.id.length > 0 && x.id.length <= DEVICE_MAX) out.add(x.id);
    }
  }
  return out;
}

/** a null prototype: a device id from the snapshot must not reach Object.prototype */
const fresh = (): SensesNotes => ({ v: 1, dev: Object.create(null) as Record<string, DevNotes> });

function goodReading(x: unknown): x is Reading {
  if (!isObject(x)) return false;
  return isTime(x.at) && typeof x.ok === 'boolean' && (x.ms == null || isMs(x.ms));
}

function goodDev(x: unknown): x is DevNotes {
  if (!isObject(x)) return false;
  const d = x as unknown as DevNotes;
  return typeof d.name === 'string' && isTime(d.seen)
    && Array.isArray(d.r) && d.r.every(goodReading)
    && (d.srtt == null || isMs(d.srtt)) && (d.rttvar == null || isMs(d.rttvar))
    && typeof d.flapping === 'boolean';
}

/** notes read back from disk, or fresh ones when they are not what this file wrote: a wrong
 *  shape or a NaN, negative or absurd number anywhere throws the whole file away (never a throw).
 *  the dev map is rebuilt with a null prototype; an empty or long key is dropped and names are
 *  cut to 80. */
function sane(raw: unknown): SensesNotes {
  try {
    const n = raw as SensesNotes;
    if (!n || typeof n !== 'object' || n.v !== 1 || !n.dev || typeof n.dev !== 'object' || Array.isArray(n.dev)) return fresh();
    const dev: Record<string, DevNotes> = Object.create(null);
    for (const [id, d] of Object.entries(n.dev)) {
      if (id.length === 0 || id.length > DEVICE_MAX) continue;   // no id or too long: not one of ours
      if (!goodDev(d)) return fresh();
      d.name = d.name.slice(0, NAME_MAX);
      if (d.r.length > READINGS_MAX) d.r = d.r.slice(-READINGS_MAX);
      dev[id] = d;
    }
    trim(dev);
    return { v: 1, dev };
  } catch { return fresh(); }
}

export function create(ctx: BranchCtx): Branch {
  const notes = sane(ctx.load<unknown>(null));
  let snap: Snapshot | null = null;
  let savedAt = ctx.now();
  let dirty = false;

  /** take in one new reading: the usual range, then flapping, both from the window alone. */
  function add(dev: EyeDevice, n: DevNotes, reading: Reading) {
    n.r.push(reading);
    if (n.r.length > READINGS_MAX) n.r.splice(0, n.r.length - READINGS_MAX);

    // latency: a spike is left out of the smooth, so one slow answer does not move the usual.
    // over 3.5 sigma from the median is a spike; when MAD is 0 (identical looks) sigma is 0, so
    // the floor is 3.5 * max(1 ms, 5% of the median). a lasting shift is not a spike: the third
    // outlier in a row on the same side of the median, and every one after it, enters the smooth
    // (the first two stay out), so the usual follows a link that really got slower or faster.
    if (reading.ok && reading.ms != null) {
      const oks = n.r.filter((r) => r.ok && r.ms != null).map((r) => r.ms as number);
      let spike = false;
      if (oks.length >= OK_MIN) {
        const m = median(oks) as number;
        const sigma = MAD_SCALE * (mad(oks) as number);
        const slack = sigma > 0 ? OUTLIER_SIGMAS * sigma : OUTLIER_SIGMAS * Math.max(1, 0.05 * m);
        // +1 or -1 for an outlier above or below the median, 0 for an ordinary reading
        const side = (x: number) => (Math.abs(x - m) > slack ? Math.sign(x - m) : 0);
        const s = side(reading.ms);
        spike = s !== 0 && !(side(oks[oks.length - 2]) === s && side(oks[oks.length - 3]) === s);
      }
      if (!spike) {
        const s = rfc6298(n.srtt, n.rttvar, reading.ms);
        n.srtt = s.srtt;
        n.rttvar = s.rttvar;
      }
    }

    // flapping: the weighted ups and downs of the last 21 readings, with hysteresis
    const change = flapChange(n.r.map((r) => r.ok));
    if (!n.flapping && change != null && change >= FLAP_START) {
      n.flapping = true;
      const w = n.r.slice(-FLAP_LOOKS);
      let changes = 0;
      for (let i = 1; i < w.length; i++) if (w[i].ok !== w[i - 1].ok) changes++;
      ctx.emit(`${shownName(dev)} is flapping: its link went up and down ${changes} times in the last ${w.length} looks`);
    } else if (n.flapping && change != null && change <= FLAP_END) {
      n.flapping = false;
      ctx.emit(`${shownName(dev)} stopped flapping`);
    }
  }

  return {
    id: 'senses',
    observe(now, before) {
      // a snapshot of null or a string is not a look: no field of it may be read before this check
      const s: Snapshot | null = isObject(now) ? now : null;
      snap = s;
      const at = s && isTime(s.at) ? s.at : null;          // the look's time, if it has a usable one
      let changed = false;
      // a devices field that is null or not an array counts as empty
      const devices = s && Array.isArray(s.devices) ? s.devices : [];
      const earlier = before && Array.isArray(before.devices) ? before.devices : [];
      // one pass over the earlier look: the up/down lines are per device, not a find each time
      const earlierById = new Map<string, EyeDevice>();
      for (const x of earlier) {
        if (isObject(x) && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= DEVICE_MAX && !earlierById.has(x.id)) {
          earlierById.set(x.id, x as unknown as EyeDevice);
        }
      }
      const present = new Set<string>();                   // the ids in this look, for the 40 cap
      let held = 0;                                        // present devices that already hold notes
      // a device that answered before and does not now (or the other way round) is worth a line
      for (const d of devices) {
        if (!usable(d)) continue;
        if (!present.has(d.id)) {
          present.add(d.id);
          if (notes.dev[d.id]) held++;
        }
        const was = earlierById.get(d.id);
        // a flapping link already has its one "is flapping" line: no up/down line on every flip
        if (was && typeof d.reachable === 'boolean' && was.reachable !== d.reachable && !notes.dev[d.id]?.flapping) ctx.emit(flipLine(d));
      }
      for (const d of devices) {
        if (!usable(d)) continue;
        // a reading needs a real ok and a usable probe time, or the notes would not survive
        if (typeof d.reachable !== 'boolean' || !isTime(d.checkedAt)) continue;
        const name = shownName(d);
        let n: DevNotes | undefined = notes.dev[d.id];
        if (!n) {
          // 40 present devices already hold notes: one more would be created and dropped again on
          // every look, and that drop marks the notes changed and saves every minute
          if (held >= MAX_DEVICES) continue;
          // no usable at: the probe's own time is a valid time to remember it by
          n = { name, seen: at ?? d.checkedAt, r: [], srtt: null, rttvar: null, flapping: false };
          notes.dev[d.id] = n;
          changed = true;
          held++;
        } else {
          if (n.name !== name) { n.name = name; changed = true; }
          if (at != null) n.seen = at;                     // for the 40 cap; not worth a save alone
        }
        const last = n.r[n.r.length - 1];
        if (last && last.at === d.checkedAt) continue;     // the eye looked again: not a new probe
        // a nonsense reachMs is no measurement: kept as null so the notes stay valid
        const ms = isMs(d.reachMs) ? d.reachMs : null;
        add(d, n, { at: d.checkedAt, ok: d.reachable, ms });
        changed = true;
      }
      // a seen ahead of this look came from a clock that ran ahead: bring it back and save the
      // fix, so a device that left then does not outrank every one that leaves later
      if (at != null) {
        for (const id in notes.dev) {
          if (notes.dev[id].seen > at) {
            notes.dev[id].seen = at;
            changed = true;
          }
        }
      }
      if (trim(notes.dev, present)) changed = true;
      // a link that is no longer probed keeps its last verdict for ever: after ten usual gaps
      // without a new reading it is not flapping any more, and the feed says so once
      if (at != null) {
        for (const id in notes.dev) {
          const n = notes.dev[id];
          const last = n.r[n.r.length - 1];
          if (!n.flapping || !last || at - last.at <= FLAP_QUIET_GAPS * usualGap(gapsOf(n.r))) continue;
          n.flapping = false;
          changed = true;
          ctx.emit(`${n.name} stopped flapping`);
        }
      }
      dirty = dirty || changed;
      // data time is the snapshot's; only save pacing uses this computer's clock
      const t = ctx.now();
      if (t < savedAt) savedAt = t;                        // a backward clock must not stop saving
      if (dirty && t - savedAt >= SAVE_EVERY_MS) { ctx.save(notes); savedAt = t; dirty = false; }
    },
    view() {
      const s: Snapshot | null = isObject(snap) ? snap : null;
      const at = s && isTime(s.at) ? s.at : null;
      const devs = (s && Array.isArray(s.devices) ? s.devices : []).filter(usable);
      const inUse = inUseIds(s);
      const seen = devs.map((d) => {
        const n = notes.dev[d.id] ?? null;
        const used = inUse.has(d.id);
        const stale = !used && isStale(at, d.checkedAt, n ? gapsOf(n.r) : []);
        const oks = n ? n.r.filter((r) => r.ok && r.ms != null).length : 0;
        const usual = !stale && n && n.srtt != null && n.rttvar != null && oks >= OK_MIN ? n : null;
        const bits: string[] = [shownName(d), reachOf(d, !stale)];
        if (usual) {
          const srtt = usual.srtt as number;
          const rttvar = usual.rttvar as number;
          // lo = max(0, SRTT - 4 * RTTVAR), hi = SRTT + 4 * RTTVAR
          const lo = Math.round(Math.max(0, srtt - 4 * rttvar));
          const hi = Math.round(srtt + 4 * rttvar);
          bits.push(`usually ${Math.round(srtt)} ms (${lo}–${hi})`);
        } else if (!stale && n && n.r.length) {
          bits.push('not enough looks yet');
        }
        if (used) bits.push('in use');
        if (n?.flapping && !stale) bits.push('flapping');   // stale readings keep no verdict
        if (stale) {
          const ago = Math.round(((at as number) - (d.checkedAt as number)) / 1000);   // stale: at is past checkedAt
          bits.push(`stale: last looked at ${ago <= AGO_MAX_S ? `${ago} s` : 'over a year'} ago`);
        }
        if (typeof d.ramMb === 'number' && d.ramMb > 0 && d.ramMb <= RAM_MAX_MB) bits.push(`${gb(d.ramMb)} free`);
        if (typeof d.bwGBs === 'number' && d.bwGBs >= BW_MIN_GBS && d.bwGBs <= BW_MAX_GBS) bits.push(`${Math.round(d.bwGBs * 100) / 100} GB/s`);
        return { d, n, stale, line: bits.join(' · ') };
      });
      const flapping = seen.filter((x) => x.n?.flapping && !x.stale).map((x) => shownName(x.d));
      const stale = seen.filter((x) => x.stale).map((x) => shownName(x.d));
      // active: answered the last look, and that look is fresh or the device is in use. a stale
      // device is "not checked lately", never active from an old probe
      const on = seen.filter((x) => !x.stale && active(x.d)).length;
      const lately = stale.length ? ` · ${stale.length} not checked lately` : '';
      const lines = seen.slice(0, MAX_DEVICES).map((x) => x.line);
      if (seen.length > MAX_DEVICES) lines.push(`and ${seen.length - MAX_DEVICES} more`);
      return {
        built: true,
        stat: devs.length ? `${on} of ${devs.length} devices active${lately}` : 'no device yet',
        gauge: devs.length ? pct(on, devs.length) : null,
        rows: [
          ['devices', String(devs.length)],
          ['flapping', flapping.length ? flapping.join(', ') : 'none'],
          ['stale', stale.length ? stale.join(', ') : 'none'],
        ],
        lines,
        note: devs.length ? undefined : 'no device yet. devices (top right) adds one.',
        what: 'keeps the last 30 probe readings of every device and says how quickly it usually answers, whether its link is flapping, and whether it has gone quiet.',
      };
    },
  };
}
