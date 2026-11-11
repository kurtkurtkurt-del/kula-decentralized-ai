// 9 limits: keep the devices within what they can bear. It only watches and warns, it never stops,
// slows or unloads anything. The snapshot carries no battery and no temperature yet, so the first
// rules use what it has:
//   memory   the loaded model's need against each device's memory: ok, tight (over 80%), over
//   rest     a device answering without a break for longer than 20 minutes should rest; answers per hour
//   night    a night project still running past its end time, and its devices still working then
//   energy   a guess: busy minutes × watts by kind (phone 3 W, pc 15 W), kept per day in its notes
// A feed line is written only when a warning starts or ends, never on every look.
// Every value taken from the snapshot is checked first: a look without a usable at changes nothing,
// a null or wrong-typed field counts as empty or unknown, and a device id, name or project id that
// is not a string or is longer than 200 chars is skipped. Every kept and shown number has a
// plausible ceiling: 100000 Wh per device per day, 100000 minutes for any duration, 4 TB for any
// memory, 100000% for a memory share; a value past its ceiling is capped or shown as "over".
// Notes on disk are one small json ({ v: 1, days }), oldest days dropped, at most 32 names a day,
// validated when read back (a NaN, a negative or a wrong shape gives fresh notes or drops that day,
// never a throw), and saved at most once a minute. A day later than the look's own came from a
// clock that ran ahead: it is dropped only once two looks at least a minute apart agree on the
// earlier day, so one look whose clock is far behind keeps every saved day. A look's own day that
// the notes did not have waits in memory until then and is kept as a past day when the clock comes
// back: with fewer than 14 days saved, a short look far behind leaves one stray earlier day behind.
// Data time is the snapshot's at; only save pacing uses this computer's clock, and a clock that
// jumps backwards or far ahead is survived: every time this branch remembers (last look, run
// start, last busy, an answer in the hour) is re-anchored when it is ahead of the look's at, and
// no duration is ever negative.
import type { Branch, BranchCtx, Snapshot } from '../types.js';
import { gb, hhmm } from './util.js';
import { masked } from './review.js';   // a project's title may hold personal data: shown masked, as review does

export const TIGHT = 0.8;                       // memory use above this share is tight
export const TIGHT_PERCENT = 80;                // the same threshold in whole percent, as it is shown
export const REST_AFTER_MS = 20 * 60_000;       // answering longer than this without a break: should rest
export const BREAK_MS = 60_000;                 // a pause this long counts as a break
export const STEP_MAX_MS = 15_000;              // a gap between looks longer than this is not counted as work
export const WATTS: Record<string, number> = { phone: 3, pc: 15 };
const WATTS_OTHER = 5;

const DAYS_KEPT = 14;
const DEVICES_KEPT = 32;
const SAVE_EVERY_MS = 60_000;
const HOUR = 3_600_000;
const DAY_CONFIRM_MS = 60_000;                  // two looks this far apart on the earlier day agree the clock moved back

/** what this branch keeps and shows is bounded: a device cannot burn more than 100000 Wh in a
 *  day, no duration is shown or kept past 100000 minutes (about 69 days), and no memory shown is
 *  past 4 TB; past those a value is capped or said as "over", never printed as an exponent. */
export const WH_MAX = 100_000;                  // Wh per device per day
export const MINUTES_MAX = 100_000;             // minutes in any stored or shown duration
export const NOTES_V = 1;
const DAY_WH_MAX = WH_MAX * DEVICES_KEPT;       // a day's total, all devices
const ANSWERS_MAX = 1000;                       // answer times kept per device (the last hour)
const ANSWERS_PER_LOOK = 500;                   // answers one look may count
const DONE_MAX = 1_000_000_000;                 // an answer counter past this is not a reading
const NAME_MAX = 80;                            // a name longer than this is cut in the notes and the line
const DEVICE_MAX = 200;                         // an id or name longer than this is not one of ours
const TITLE_MAX = 120;                          // a title is cut before the mask regexes ever see it
const TIME_MAX = 8.64e15;                       // the largest ms a date can hold (ECMAScript)
const RAM_MAX_MB = 4 * 1024 * 1024;             // 4 TB: more memory than that is shown as "over"
const PERCENT_MAX = 100_000;                    // a share past this is shown as "over 100000%"

type Day = { wh: number; busyMin: number; by: Record<string, number> };   // by: device name → Wh
export type Notes = { v: number; days: Record<string, Day> };
type Warn = { text: string; ended: string };
type Mem = { name: string; needMb: number; ramMb: number | null; share: number | null; percent: number; level: 'ok' | 'tight' | 'over' | 'unknown' };

/** a time this branch may keep: finite, not negative, date-sized */
export const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= TIME_MAX;

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** plain fields of a snapshot or of one of its entries; null when it is not an object */
const rawOf = (x: unknown): Record<string, unknown> | null => (isObject(x) ? x : null);

/** a field that should be an array; null or anything else counts as empty */
const arrayOf = (raw: Record<string, unknown> | null, key: string): unknown[] => {
  const v = raw?.[key];
  return Array.isArray(v) ? (v as unknown[]) : [];
};

/** the day key a time falls on, in this computer's time */
export const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** whole minutes of a duration; a duration is never negative */
export const minutesOf = (ms: number): number => Math.round(Math.max(0, ms) / 60_000);

/** minutes as said in a line; past the ceiling it says "over 100000 min" rather than an absurd count */
export const minutesWord = (ms: number): string => {
  const m = minutesOf(ms);
  return m <= MINUTES_MAX ? `${m} min` : `over ${MINUTES_MAX} min`;
};

/** GB as said in a line; past 4 TB it says "over 4096.0 GB" */
export function gbShown(mb: number): string {
  return mb <= RAM_MAX_MB ? gb(mb) : `over ${gb(RAM_MAX_MB)}`;
}

/** a percentage as said in a line; past the ceiling it says "over 100000" */
export function percentWord(percent: number): string {
  return Number.isFinite(percent) && percent <= PERCENT_MAX ? String(percent) : `over ${PERCENT_MAX}`;
}

/** the memory level from the raw share, as it was before the review: over 100% is over, over
 *  80% is tight, 80% exactly is ok. the percent printed beside it is rounded, so 80.3% reads
 *  "(80%) tight" and 100.3% reads "(100%), more than it has": that is the old text and stays. */
export function levelOf(share: number): 'ok' | 'tight' | 'over' {
  return share > 1 ? 'over' : share > TIGHT ? 'tight' : 'ok';
}

/** one look's headroom: the lowest of the heads, clamped to 0..100; no head is full headroom.
 *  a loop, not Math.min(...heads): a huge snapshot must not overflow the call stack. a head of
 *  -Infinity (a share that overflowed) is no headroom, not full headroom; NaN is no head. */
export function gaugeOf(heads: number[]): number {
  let low = Infinity;
  for (const h of heads) if (h < low) low = h;     // NaN is never lower
  if (low === -Infinity) return 0;
  return Number.isFinite(low) ? Math.max(0, Math.min(100, Math.round(low))) : 100;
}

/** busy time × watts as Wh; ms is the counted step between two looks */
export const energyWh = (watts: number, ms: number): number => (watts * ms) / HOUR;

/** the watts of a device by its kind; a strange kind is "other", never a lookup on a plain object */
export function wattsOf(kind: unknown, local: unknown): number {
  if (local === true) return WATTS.pc;
  return kind === 'phone' ? WATTS.phone : kind === 'pc' ? WATTS.pc : WATTS_OTHER;
}

/** a device or part this branch can name and key: only a non-string or empty id, an id or name
 *  over 200 chars, or a non-string name is skipped */
function usableNamed(x: unknown): x is Record<string, unknown> & { id: string; name: string } {
  if (!isObject(x)) return false;
  return typeof x.id === 'string' && x.id.length > 0 && x.id.length <= DEVICE_MAX
    && typeof x.name === 'string' && x.name.length <= DEVICE_MAX;
}

/** the name in lines, rows and the feed; a device without one goes by its id */
const shownName = (d: { id: string; name: string }) => (d.name.trim() || d.id).slice(0, NAME_MAX);

/** the loaded work of a snapshot, if it has one; a null or wrong-typed field counts as none */
function loadedOf(s: Snapshot | null): Record<string, unknown> | null {
  const raw = rawOf(s);
  const work = raw && isObject(raw.work) ? raw.work : null;
  return work && isObject(work.loaded) ? work.loaded : null;
}

/** a null prototype: a day key or a device name from the snapshot must not reach Object.prototype */
const fresh = (): Notes => ({ v: NOTES_V, days: Object.create(null) as Record<string, Day> });

/** notes read back from disk, or fresh ones when they are not what this file wrote: a wrong shape
 *  or version gives fresh notes; a NaN or negative day is dropped; a NaN or negative name value is
 *  dropped; a value past its ceiling is capped. The maps are rebuilt with a null prototype by
 *  iterating, never by assigning a snapshot string as a key of a plain object. */
export function cleanNotes(raw: unknown): Notes {
  const notes = fresh();
  if (!isObject(raw) || (raw.v !== undefined && raw.v !== NOTES_V)) return notes;
  const src = raw.days;
  if (!isObject(src) || Array.isArray(src)) return notes;
  const keys = Object.keys(src).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse().slice(0, DAYS_KEPT);
  for (const k of keys) {
    const v = src[k];
    if (!isObject(v)) continue;
    if (!isNumber(v.wh) || v.wh < 0 || !isNumber(v.busyMin) || v.busyMin < 0) continue;
    const by: Record<string, number> = Object.create(null) as Record<string, number>;
    const rawBy = isObject(v.by) && !Array.isArray(v.by) ? v.by : {};
    let kept = 0;
    for (const [name, w] of Object.entries(rawBy)) {
      if (kept >= DEVICES_KEPT) break;
      if (name.length === 0 || name.length > DEVICE_MAX) continue;
      if (!isNumber(w) || w < 0) continue;
      by[name.slice(0, NAME_MAX)] = Math.min(WH_MAX, w);
      kept++;
    }
    notes.days[k] = { wh: Math.min(DAY_WH_MAX, v.wh), busyMin: Math.min(MINUTES_MAX, v.busyMin), by };
  }
  return notes;
}

export function create(ctx: BranchCtx): Branch {
  const notes = cleanNotes(ctx.load<unknown>(null));
  let dirty = false;
  let savedAt = 0;
  let lastAt: number | null = null;
  let snap: Snapshot | null = null;
  // a day earlier than the saved ones, seen in this run but not yet trusted: the saved days
  // ahead of it are dropped only when a second look, at least a minute later, says the same day
  let pendingDay: string | null = null;
  let pendingSince: number | null = null;
  // the look's own day while it is earlier than the saved days: its energy waits here, out of
  // the notes, until the earlier day is confirmed or the clock comes back to the saved days
  let early: { key: string; day: Day } | null = null;

  // per device, in memory only
  const runStart = new Map<string, number>();           // when its current busy run began
  const lastBusy = new Map<string, number>();           // when it was last seen busy
  const lastDone = new Map<string, number>();           // its answer counter at the last look
  const answers = new Map<string, number[]>();          // when each answer was counted, the last hour

  let warns = new Map<string, Warn>();
  let mems: Mem[] = [];
  let gauge = 100;

  const blankDay = (): Day => ({ wh: 0, busyMin: 0, by: Object.create(null) as Record<string, number> });

  /** the day goes into the notes, and the cap drops the oldest days: the newest 14 stay */
  const storeDay = (k: string, d: Day) => {
    notes.days[k] = d;
    const keys = Object.keys(notes.days).sort().reverse();
    for (const old of keys.slice(DAYS_KEPT)) delete notes.days[old];
  };

  const today = (at: number): Day => {
    const k = dayKey(at);
    let d = notes.days[k];
    if (!d) {
      d = blankDay();
      // today() is only reached when no saved day is later than this look, so the look's own
      // day is the newest key and the oldest days go first
      storeDay(k, d);
    }
    return d;
  };

  function memoryRules(s: Snapshot | null): Mem[] {
    const l = loadedOf(s);
    if (!l) return [];
    const raw = rawOf(s);
    const rawDevices = arrayOf(raw, 'devices');
    const byId = new Map<string, Record<string, unknown>>();
    for (const d of rawDevices) if (usableNamed(d) && !byId.has(d.id)) byId.set(d.id, d);
    const out: Mem[] = [];
    const judge = (name: string, needMb: unknown, ramMb: unknown): Mem => {
      const need = isNumber(needMb) && needMb > 0 ? needMb : 0;
      const ram = isNumber(ramMb) && ramMb > 0 ? ramMb : null;
      if (need <= 0 || ram == null) return { name, needMb: need, ramMb: ram, share: null, percent: 0, level: 'unknown' };
      const share = need / ram;
      const percent = Math.round(share * 100);
      return { name, needMb: need, ramMb: ram, share, percent, level: levelOf(share) };
    };
    const loaded = Array.isArray(l.devices) ? (l.devices as unknown[]) : [];
    if (l.mode === 'split' && Array.isArray(l.parts) && l.parts.length > 0) {
      for (const p of l.parts as unknown[]) {
        if (!usableNamed(p) || p.local === true) continue;
        out.push(judge(shownName(p), p.mb, byId.get(p.id)?.ramMb ?? null));
      }
    } else {
      const modelId = isObject(l.model) && typeof l.model.id === 'string' ? l.model.id : null;
      let need: unknown = 0;
      const models = arrayOf(raw, 'models');
      if (modelId != null) {
        const m = models.find((x) => isObject(x) && x.id === modelId);
        if (isObject(m)) need = m.needMb;
      }
      for (const d of loaded) if (usableNamed(d) && d.local !== true) out.push(judge(shownName(d), need, byId.get(d.id)?.ramMb ?? null));
    }
    return out;
  }

  return {
    id: 'limits',
    observe(now) {
      // a snapshot of null or a string, or one without a usable time, is not a look: it changes
      // nothing (no day key "NaN-NaN-NaN", no re-anchored clock, no warning, no save)
      if (!isObject(now) || !isTime(now.at)) return;
      const raw = now;                      // an object with a usable at; its fields are unknown
      const s = raw as Snapshot;
      snap = s;
      const at = s.at;
      const devices = arrayOf(raw, 'devices');
      const l = loadedOf(s);
      const loaded = l && Array.isArray(l.devices) ? (l.devices as unknown[]) : [];

      // the step since the last look; a look behind it is a clock that stepped back, and the
      // watermark moves back with it so the next look is measured from where the clock is now
      const step = lastAt == null ? 0 : at - lastAt;
      lastAt = at;
      // energy counts only a step of at most 15 s, since a longer gap is not proven work; answers
      // seen across a gap can still be placed in the hour while the gap is under an hour, while a
      // look behind or a gap of an hour or more leaves them unplaceable (placed is 0)
      const counted = step > 0 && step <= STEP_MAX_MS ? step : 0;
      const placed = step > 0 && step < HOUR ? step : 0;

      const next = new Map<string, Warn>();
      const heads: number[] = [];
      const kinds = new Map<string, unknown>();
      for (const d of devices) if (usableNamed(d) && !kinds.has(d.id)) kinds.set(d.id, d.kind);

      // memory
      mems = memoryRules(s);
      for (const m of mems) {
        if (m.share == null) continue;
        heads.push((1 - m.share) * 200);         // 50% used or less: full headroom; 100%: none
        if (m.level !== 'ok') {
          next.set(`mem:${m.name}:${m.level}`, {
            text: `${m.name}: the model needs ${gbShown(m.needMb)} of its ${gbShown(m.ramMb!)} (${percentWord(m.percent)}%), ${m.level === 'over' ? 'more than it has' : 'tight'}`,
            ended: `${m.name}: memory ${m.level === 'over' ? 'no longer over' : 'no longer tight'}`,
          });
        }
      }

      // rest, answers per hour, energy
      // a day later than this look's came from a clock that ran ahead: it is no record of a past
      // today, and left in place it would pre-fill "energy today" when that date arrives. one
      // look far behind is not enough to erase the saved days: they go only when two looks at
      // least a minute apart agree on this earlier day, and until then nothing is dropped and
      // the look's own energy waits in memory
      const todayKey = dayKey(at);
      let later = Object.keys(notes.days).some((key) => key > todayKey);
      if (!later) {
        // no saved day is ahead of this look: an earlier day kept in memory goes into the notes
        // now, the cap dropping the oldest day
        pendingDay = null;
        pendingSince = null;
        if (early) { const e = early; early = null; storeDay(e.key, e.day); if (notes.days[e.key] === e.day) dirty = true; }
      } else if (pendingDay === todayKey && pendingSince != null && at - pendingSince >= DAY_CONFIRM_MS) {
        // two looks at least a minute apart agree on this earlier day: the clock moved back for
        // good, and the days ahead of it are no record of a past today
        for (const key of Object.keys(notes.days)) if (key > todayKey) { delete notes.days[key]; dirty = true; }
        later = false;
        pendingDay = null;
        pendingSince = null;
        if (early) { const e = early; early = null; storeDay(e.key, e.day); dirty = true; }
      } else if (pendingDay !== todayKey) {
        // the first look on this earlier day: remember it, and forget a day kept for another
        // unconfirmed clock (it never reached the notes)
        pendingDay = todayKey;
        pendingSince = at;
        early = null;
      }
      const seen = new Set<string>();
      let day: Day | null = null;
      let persistent = false;                               // whether the day is in the notes
      let byCount = 0;
      const dayNow = (): Day => {
        if (day) return day;
        const saved = notes.days[todayKey];
        if (saved) {
          // the look's own day is already saved: count into it, even while a later day from a
          // clock that ran ahead waits to be confirmed; nothing of it is erased by doing so
          day = saved;
          persistent = true;
        } else if (later) {
          if (!early) early = { key: todayKey, day: blankDay() };
          day = early.day;
        } else {
          day = today(at);
          persistent = true;
        }
        byCount = Object.keys(day.by).length;
        return day;
      };
      for (const d of loaded) {
        if (!usableNamed(d)) continue;
        seen.add(d.id);
        const name = shownName(d);
        const done = typeof d.done === 'number' && Number.isFinite(d.done) && d.done >= 0 ? Math.min(DONE_MAX, d.done) : null;
        const before = lastDone.get(d.id);
        // a counter that is not a count is forgotten: the next usable one starts a new baseline,
        // so the answers in between are not invented as a burst
        if (done == null) lastDone.delete(d.id); else lastDone.set(d.id, done);

        // the answer times from before, with anything stamped ahead of this look brought back so
        // a far-forward clock cannot keep a phantom answer in the hour for years
        const list: number[] = [];
        for (const t of answers.get(d.id) ?? []) {
          if (!isTime(t)) continue;
          const at2 = t > at ? at : t;
          if (at - at2 < HOUR) list.push(at2);
        }
        if (placed > 0 && done != null && before != null) {
          const got = Math.max(0, done - before);
          for (let i = 0; i < Math.min(got, ANSWERS_PER_LOOK); i++) list.push(at);
        }
        answers.set(d.id, list.slice(-ANSWERS_MAX));

        if (d.busy === true) {
          const lb = lastBusy.get(d.id);
          let rs = runStart.get(d.id);
          // a clock that ran ahead left its run start in the future: bring it back to this look,
          // or every duration from here on would be negative
          if (rs != null && rs > at) { rs = at; runStart.set(d.id, at); }
          if (lb == null || at - lb > BREAK_MS || step > STEP_MAX_MS || rs == null) { rs = at; runStart.set(d.id, at); }
          lastBusy.set(d.id, at);
          if (counted) {
            const wh = energyWh(wattsOf(kinds.get(d.id), d.local), counted);
            const dd = dayNow();
            dd.wh += wh;
            dd.busyMin += counted / 60_000;
            const had = dd.by[name] != null;
            if (had || byCount < DEVICES_KEPT) {
              dd.by[name] = (had ? dd.by[name] : 0) + wh;
              if (!had) byCount++;
            }
            // a day kept in memory only is not written yet: saving now would be for nothing
            if (persistent) dirty = true;
          }
        } else if (runStart.has(d.id)) {
          const lb = lastBusy.get(d.id);
          const rs = runStart.get(d.id);
          if (lb != null && rs != null && lb > at) {
            // a clock that ran ahead left lastBusy and the run start in the future: move both
            // back by the same amount, so the break is counted from the corrected clock and the
            // run keeps its length until the break is real
            const back = lb - at;
            lastBusy.set(d.id, at);
            runStart.set(d.id, rs - back);
          } else if (at - (lb ?? 0) > BREAK_MS) {
            runStart.delete(d.id);
          }
        }
        // a run lasts until a real break, so a short pause between answers keeps the warning
        const rs2 = runStart.get(d.id);
        if (rs2 != null) {
          const run = (lastBusy.get(d.id) ?? rs2) - rs2;   // lastBusy is set at or after the run start
          heads.push(100 - (run / REST_AFTER_MS) * 100);
          if (run > REST_AFTER_MS) next.set(`rest:${d.id}`, { text: `${name} should rest: answering for ${minutesWord(run)} without a break`, ended: `${name} had its break` });
        }
      }
      for (const id of [...lastDone.keys()]) if (!seen.has(id)) { lastDone.delete(id); runStart.delete(id); lastBusy.delete(id); answers.delete(id); }

      // night window
      const projects = arrayOf(raw, 'projects');
      for (const p of projects) {
        if (!isObject(p)) continue;
        if (p.state !== 'running' || typeof p.id !== 'string' || p.id.length === 0 || p.id.length > DEVICE_MAX) continue;
        if (!isTime(p.end) || !(at > p.end)) continue;
        const title = masked(typeof p.title === 'string' ? p.title.slice(0, TITLE_MAX) : '');
        heads.push(0);
        next.set(`night:${p.id}`, { text: `night project "${title}" still running ${minutesWord(at - p.end)} past its end at ${hhmm(p.end)}`, ended: `night project "${title}" is no longer past its end` });
        const peersHere = new Set<string>();
        for (const id of Array.isArray(p.peers) ? (p.peers as unknown[]) : []) {
          if (typeof id === 'string' && id.length > 0 && id.length <= DEVICE_MAX) peersHere.add(id);
        }
        for (const d of loaded) {
          if (!usableNamed(d) || d.busy !== true || !peersHere.has(d.id)) continue;
          next.set(`window:${d.id}:${p.id}`, { text: `${shownName(d)} still working after the night window of "${title}" (ended ${hhmm(p.end)})`, ended: `${shownName(d)} stopped working outside the night window` });
        }
      }

      for (const [k, w] of next) if (!warns.has(k)) ctx.emit(`limits: ${w.text}`);
      for (const [k, w] of warns) if (!next.has(k)) ctx.emit(`limits: ${w.ended}`);
      warns = next;
      gauge = gaugeOf(heads);

      // data time is the look's; only save pacing uses this computer's clock, and a clock that
      // stepped back re-anchors savedAt instead of waiting for the old time to come round again
      const t = ctx.now();
      if (typeof t === 'number' && Number.isFinite(t)) {
        if (t < savedAt) savedAt = t;
        if (dirty && t - savedAt >= SAVE_EVERY_MS) { ctx.save(notes); savedAt = t; dirty = false; }
      }
    },
    view() {
      const s = isObject(snap) ? snap : null;
      const wall = ctx.now();
      const at = s && isTime(s.at) ? s.at : isTime(wall) ? wall : 0;
      const key = dayKey(at);
      // a look earlier than the saved days keeps its energy in memory: show it under its own day
      const day = (early && early.key === key ? early.day : notes.days[key]) ?? blankDay();
      const yesterday = notes.days[dayKey(at - 24 * HOUR)];
      const l = loadedOf(s);
      const all = l && Array.isArray(l.devices) ? (l.devices as unknown[]) : [];
      const devs = all.filter(usableNamed);
      const memByName = new Map<string, Mem>();
      for (const m of mems) if (!memByName.has(m.name)) memByName.set(m.name, m);
      const n = warns.size;
      const lines: string[] = [...warns.values()].map((w) => `warning: ${w.text}`);
      const devNames = new Set<string>();
      for (const d of devs) {
        const name = shownName(d);
        devNames.add(name);
        const bits: string[] = [d.local === true ? `${name} (this computer)` : name];
        const m = memByName.get(name);
        if (m?.share != null) bits.push(`memory ${gbShown(m.needMb)} of ${gbShown(m.ramMb!)} (${percentWord(m.percent)}%) ${m.level}`);
        else if (m) bits.push('memory unknown');
        const rs = runStart.get(d.id);
        // a duration is never negative, even if the snapshot is behind a time this branch remembers
        bits.push(d.busy === true && rs != null ? `answering ${minutesWord(at - rs)}, rest at ${REST_AFTER_MS / 60_000}` : 'free');
        bits.push(`${plural(answers.get(d.id)?.length ?? 0, 'answer')} in the last hour`);
        const wh = day.by[name];
        if (typeof wh === 'number' && wh > 0) bits.push(`${round1(wh)} Wh today`);
        lines.push(bits.join(' · '));
      }
      for (const m of mems) if (!devNames.has(m.name) && m.share != null) lines.push(`${m.name} · memory ${gbShown(m.needMb)} of ${gbShown(m.ramMb!)} (${percentWord(m.percent)}%) ${m.level}`);
      return {
        built: true,
        stat: n ? plural(n, 'warning') : 'all within limits',
        gauge,
        rows: [
          ['energy today', `${round1(day.wh)} Wh (a guess)`],
          ['busy today', `${Math.round(day.busyMin)} min`],
          ...(yesterday ? [['energy yesterday', `${round1(yesterday.wh)} Wh`] as [string, string]] : []),
          ['rules', `memory tight over ${TIGHT_PERCENT}% · rest after ${REST_AFTER_MS / 60_000} min · phone ${WATTS.phone} W, pc ${WATTS.pc} W`],
        ],
        lines,
        note: `it only warns, it never stops a device. it cannot see battery or heat yet${devs.length ? '' : '; no model loaded, nothing is working'}.`,
        what: 'keeps devices within their limits: memory, rest, the night window and an energy guess. battery and heat come later.',
        // for the deciding branches (peek): a device that should rest gets no new work suggested
        hints: [...warns.keys()].filter((k) => k.startsWith('rest:')).map((k) => ({ id: k.slice(5), no: 'should rest (limits)' })),
      };
    },
  };
}
