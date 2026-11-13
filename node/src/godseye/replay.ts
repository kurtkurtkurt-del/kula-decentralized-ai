// god's eye, the night replay (11.11.2026): a stretch of the black box read back as a film. The
// box keeps every look as a key (the whole reduced facts) or a delta against the one before
// (boxfacts.ts), and the feed lines, the trust verdicts and the eye's own start and stop around
// them. This walks the box once, in n order, every line checked against its hash and the record
// before it (box.ts walk()), rebuilds the facts look by look (boxfacts.ts replayer()) and cuts the
// asked stretch into at most FRAMES_MAX frames of equal length, so a night of 10 000 looks plays
// in 30 seconds and a page can scrub it.
//
// a frame says only what the facts say, picked field by field: each device's name, kind and link,
// whether it was there, loaded, answering, its best tok/s and answers finished; the model's name,
// the mode, what was loading; the trust verdicts; the feed lines of the frame (the eye scrubbed
// them before they went in). Nothing the box does not hold is invented, and nothing it holds that
// is not on this list leaves: a record changed by hand cannot smuggle a field through.
//
// tokens are not in the facts: a device's tok/s is. The count is an estimate, tok/s times the time
// it was answering between two looks, and is called one wherever it is shown. Heat and battery are
// not in the facts either (a cable's plugged is); the limits branch's "should rest" lines are what
// a replay can count.
//
// a stretch with no look for GAP_MS, or after the eye's stop record, is "off": the eye was not
// watching, and nothing is drawn or counted there.
import type { Box, BoxRecord } from './box.js';
import { replayer, type Facts } from './boxfacts.js';

export const FRAMES_MAX = 600;
export const STEP_MIN = 5_000;          // a frame is never shorter than one look of the eye
export const GAP_MS = 60_000;           // no look for this long: the eye was not watching
const FEED_MAX = 2_000;                 // feed lines kept for one replay
const FEED_FRAME_MAX = 12;              // and in one frame
const TEXT_MAX = 300;                   // a feed line's chars, as the eye cut them
const DEVICES_MAX = 64;                 // devices in a frame
const VERDICTS_MAX = 128;               // verdicts in a frame
const BAD_MAX = 1_000;                  // records that do not hold, remembered for the range check
const NIGHT_FROM = 18;                  // the night: 18:00 → 09:00, local time
const NIGHT_TO = 9;
const HOUR = 3_600_000;

export interface ReplayQuery {
  from?: number;     // ms; the stretch by time
  to?: number;
  fromN?: number;    // or by record numbers
  toN?: number;
  frames?: number;   // at most this many frames (never more than FRAMES_MAX)
}

export interface ReplayDevice {
  id: string;
  name: string;
  kind: string;
  via: string;               // cable, wifi, relay; "here" for this computer
  present: boolean;          // in the look and answering its probe
  loaded: boolean;           // part of the loaded work
  busy: boolean;             // answering at some look in the frame
  tps: number | null;        // its best tok/s in the frame
  plugged: boolean | null;   // on a cable: plugged in
  answers: number;           // answers it finished in the frame
}

export interface ReplayFeed { t: number; branch: string; text: string }

export interface ReplayFrame {
  t: number;                 // the frame's start; it lasts one step
  off: boolean;              // the eye was not watching
  model: string | null;      // the loaded model's name
  mode: string | null;       // phone, apart, split, here
  loading: string | null;    // the model being loaded
  devices: ReplayDevice[];
  tokens: number;            // estimated, since the stretch began
  answers: number;           // since the stretch began
  workMs: number;            // time some device was answering, since the stretch began
  verdicts: Record<string, string>;   // who → ok, bad or unknown, as of the frame's end
  feed: ReplayFeed[];
  marks: string[];           // the eye's own records in the frame: start, stop, gap, skip, forget, tamper, …
}

export interface ReplaySummary {
  looks: number;             // looks in the stretch
  devices: number;           // devices that answered at least once (this computer too)
  seen: number;              // devices that were there at some look
  workMs: number;            // time at least one device was answering
  byDevice: { id: string; name: string; workMs: number; tokens: number; answers: number }[];
  tokens: number;            // estimated
  answers: number;
  models: string[];
  rests: number;             // the limits branch's "should rest" lines
  warnings: number;          // every line of the limits branch
  badVerdicts: number;       // trust verdicts that turned bad
  offMs: number;             // time the eye was not watching
}

export interface ReplayChain {
  ok: boolean;               // every record the stretch is built from holds
  problem: string | null;    // the first that does not, in the box's words
  n: number | null;          // and its record number
  whole: boolean;            // the whole box holds, as far as it was walked
  wholeProblem: string | null;
}

export interface Replay {
  from: number;
  to: number;
  step: number;
  range: 'asked' | 'night' | '12h';
  records: { from: number; to: number; count: number };   // the records in the stretch
  box: { first: number | null; last: number | null; records: number };  // the box's own span, for a day picker
  devices: { id: string; name: string; kind: string }[];  // every device the stretch saw
  frames: ReplayFrame[];
  summary: ReplaySummary;
  chain: ReplayChain;
}

// ---- one look, reduced to what a frame draws

interface DevState { name: string; kind: string; via: string; present: boolean; plugged: boolean | null; loaded: boolean; busy: boolean; tps: number | null; done: number }
interface Look { n: number; t: number; model: string | null; mode: string | null; loading: string | null; since: number; devs: Map<string, DevState> }

const str = (x: unknown, max = 200): string => (typeof x === 'string' ? x.slice(0, max) : '');
const numOr = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** a look's facts reduced to the frame's fields; every value is read field by field */
function lookOf(n: number, t: number, f: Facts): Look {
  const devs = new Map<string, DevState>();
  for (const d of Array.isArray(f.devices) ? f.devices : []) {
    if (!isObj(d) || typeof d.id !== 'string' || !d.id || devs.size >= DEVICES_MAX) continue;
    devs.set(d.id, {
      name: str(d.name, 80) || d.id.slice(0, 80), kind: str(d.kind, 40), via: str(d.via, 40),
      present: d.reachable !== false && d.down !== true && d.waitingPair !== true,
      plugged: d.plugged === true || d.plugged === false ? d.plugged : null,
      loaded: false, busy: false, tps: null, done: 0,
    });
  }
  const w = isObj(f.work) ? f.work : null;
  const L = w && isObj(w.loaded) ? w.loaded : null;
  let model: string | null = null;
  let mode: string | null = null;
  let since = 0;
  if (L) {
    const id = isObj(L.model) ? str(L.model.id) : '';
    const known = Array.isArray(f.models) ? f.models.find((m) => isObj(m) && m.id === id) : undefined;
    model = (known && str(known.name)) || id || (isObj(L.model) ? str(L.model.file) : '') || 'a model';
    mode = str(L.mode, 40) || null;
    since = numOr(L.since) ?? 0;
    const parts = new Set((Array.isArray(L.parts) ? L.parts : []).map((p) => (isObj(p) ? p.id : null)));
    for (const x of Array.isArray(L.devices) ? L.devices : []) {
      if (!isObj(x) || typeof x.id !== 'string' || !x.id) continue;
      let d = devs.get(x.id);
      if (!d) {
        if (devs.size >= DEVICES_MAX) continue;
        const here = x.id === 'local';
        const host = isObj(f.host) ? str(f.host.name, 80) : '';
        d = { name: here ? host || 'this computer' : x.id.slice(0, 80), kind: here ? 'computer' : '', via: here ? 'here' : '', present: true, plugged: null, loaded: false, busy: false, tps: null, done: 0 };
        devs.set(x.id, d);
      }
      d.loaded = true;
      d.busy = x.busy === true;
      d.tps = numOr(x.tps);
      d.done = Math.max(0, numOr(x.done) ?? 0);
    }
    for (const id of parts) { const d = typeof id === 'string' ? devs.get(id) : undefined; if (d) d.loaded = true; }
  }
  const loading = w && isObj(w.loading) ? str(w.loading.model) || null : null;
  return { n, t, model, mode, loading, since, devs };
}

// ---- the stretch

/** last night, 18:00 → 09:00 local, never past now: the replay's default */
export function lastNight(now: number): { from: number; to: number } {
  const end = new Date(now);
  end.setHours(NIGHT_TO, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  start.setHours(NIGHT_FROM, 0, 0, 0);
  return { from: start.getTime(), to: Math.min(end.getTime(), now) };
}

/** the night that starts on the evening of a local day (yyyy-mm-dd): that 18:00 → the next 09:00 */
export function nightOf(day: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), NIGHT_FROM, 0, 0, 0);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(NIGHT_TO, 0, 0, 0);
  return { from: start.getTime(), to: end.getTime() };
}

/** the replay of a box: the asked stretch, or last night, or the last 12 hours when the night has
 *  no look. A box without walk() (a stub) replays as empty. */
export function replayBox(box: Box, q: ReplayQuery = {}, now = Date.now()): Replay {
  const asked = Number.isFinite(q.from) || Number.isFinite(q.to) || Number.isFinite(q.fromN) || Number.isFinite(q.toN);
  if (asked) return buildReplay(box, q, 'asked', now);
  // one walk feeds both stretches: the night's, and the 12 hours' for when the night has no look
  const night = collector({ ...lastNight(now), frames: q.frames }, 'night', now);
  const day = collector({ from: now - 12 * HOUR, to: now, frames: q.frames }, '12h', now);
  const next = replayer();
  const walked = walkBox(box, (r, bad) => {
    const look = next(r);
    night.take(r, bad, look);
    day.take(r, bad, look);
  });
  const n = night.finish(walked);
  return n.summary.looks > 0 ? n : day.finish(walked);
}

export function buildReplay(box: Box, q: ReplayQuery, range: Replay['range'] = 'asked', now = Date.now()): Replay {
  const c = collector(q, range, now);
  const next = replayer();
  return c.finish(walkBox(box, (r, bad) => c.take(r, bad, next(r))));
}

type Walked = ReturnType<NonNullable<Box['walk']>>;
type Rebuilt = ReturnType<ReturnType<typeof replayer>>;

/** a box without walk() (a stub) walks as empty */
function walkBox(box: Box, fn: (r: BoxRecord, bad: string | null) => void): Walked {
  return typeof box.walk === 'function'
    ? box.walk(fn)
    : { count: 0, from: 0, last: 0, firstT: null, lastT: null, problem: null, problemN: null };
}

/** one stretch: take() is handed every record of the walk in n order, with the look the replayer
 *  rebuilt from it; finish() cuts the frames once the walk is done */
function collector(q: ReplayQuery, range: Replay['range'], now: number): { take(r: BoxRecord, bad: string | null, look: Rebuilt): void; finish(walked: Walked): Replay } {
  const byN = Number.isFinite(q.fromN) || Number.isFinite(q.toN);
  const fromN = Number.isFinite(q.fromN) ? Math.floor(q.fromN as number) : 1;
  const toN = Number.isFinite(q.toN) ? Math.floor(q.toN as number) : Number.MAX_SAFE_INTEGER;
  let from = Number.isFinite(q.from) ? (q.from as number) : byN ? Number.POSITIVE_INFINITY : now - 12 * HOUR;
  let to = Number.isFinite(q.to) ? (q.to as number) : byN ? Number.NEGATIVE_INFINITY : now;
  if (!byN && to < from) [from, to] = [to, from];
  const inRange = (r: BoxRecord): boolean => (byN ? r.n >= fromN && r.n <= toN && (!Number.isFinite(q.from) || r.t >= (q.from as number)) && (!Number.isFinite(q.to) || r.t <= (q.to as number)) : r.t >= from && r.t <= to);

  let before: Look | null = null;             // the last look before the stretch
  const looks: Look[] = [];
  const feed: ReplayFeed[] = [];
  const verdictsAt: Record<string, string> = Object.create(null);   // before the stretch
  const verdictEvents: { t: number; who: string; to: string }[] = [];
  const marks: { t: number; k: string }[] = [];
  const bads: { n: number; problem: string }[] = [];
  let keyStart: number | null = null;         // the n of the key the stretch's first look is built on
  let firstIn: number | null = null;
  let lastIn = 0;
  let countIn = 0;
  let minT = Number.POSITIVE_INFINITY;
  let maxT = Number.NEGATIVE_INFINITY;

  const take = (r: BoxRecord, bad: string | null, look: Rebuilt): void => {
    if (bad !== null && bads.length < BAD_MAX) bads.push({ n: r.n, problem: bad });
    const x = isObj(r.x) ? r.x : null;
    const isIn = inRange(r);
    if (firstIn === null && !isIn && r.k === 'key' && x !== null && x.i === 0) keyStart = r.n;
    if (isIn) {
      if (firstIn === null) firstIn = r.n;
      lastIn = r.n;
      countIn++;
      if (byN) { minT = Math.min(minT, r.t); maxT = Math.max(maxT, r.t); }
    }
    if (look !== null) {
      if (isIn) looks.push(lookOf(r.n, look.at, look.facts));
      else if (firstIn === null) before = lookOf(r.n, look.at, look.facts);
      return;
    }
    if (r.k === 'feed' && x !== null && isIn) {
      if (feed.length >= FEED_MAX) return;
      const text = typeof x.text === 'string' ? x.text.slice(0, TEXT_MAX) : '(a line with private words, kept out)';
      feed.push({ t: r.t, branch: str(r.b, 40), text });
    } else if (r.k === 'verdict' && x !== null && typeof x.who === 'string' && typeof x.to === 'string') {
      const who = x.who.slice(0, 200);
      const v = x.to === 'ok' || x.to === 'bad' ? x.to : 'unknown';
      if (isIn) verdictEvents.push({ t: r.t, who, to: v });
      else if (firstIn === null && (who in verdictsAt || Object.keys(verdictsAt).length < VERDICTS_MAX)) verdictsAt[who] = v;
    } else if (isIn && r.k !== 'act' && r.k !== 'broken' && r.k !== 'other') {
      marks.push({ t: r.t, k: r.k.slice(0, 20) });
    }
  };

  const finish = (walked: Walked): Replay => {
    if (byN) {
      if (!Number.isFinite(q.from)) from = Number.isFinite(minT) ? minT : now;
      if (!Number.isFinite(q.to)) to = Number.isFinite(maxT) ? maxT : from;
    }
    // the clock is not the order: looks are drawn by their time, the record keeps its own order
    looks.sort((a, b) => a.t - b.t || a.n - b.n);
    feed.sort((a, b) => a.t - b.t);
    verdictEvents.sort((a, b) => a.t - b.t);
    marks.sort((a, b) => a.t - b.t);

    const span = Math.max(0, to - from);
    const cap = Math.max(1, Math.min(FRAMES_MAX, Number.isFinite(q.frames) && (q.frames as number) >= 1 ? Math.floor(q.frames as number) : FRAMES_MAX));
    const count = Math.max(1, Math.min(cap, Math.ceil(span / STEP_MIN)));
    const step = span / count || STEP_MIN;

    // ---- the frames, one pass over the looks
    const frames: ReplayFrame[] = [];
    const verdicts: Record<string, string> = { ...verdictsAt };
    const devNames = new Map<string, { name: string; kind: string }>();
    const work = new Map<string, { workMs: number; tokens: number; answers: number }>();
    const models: string[] = [];
    let prev: Look | null = before;
    let li = 0, fi = 0, vi = 0, mi = 0;
    let tokens = 0, answers = 0, workMs = 0, offMs = 0, badVerdicts = 0;
    let stoppedAt = Number.NEGATIVE_INFINITY;
    const seen = new Set<string>();
    const worked = new Set<string>();
    const remember = (id: string, d: DevState): void => {
      if (!devNames.has(id) && devNames.size < DEVICES_MAX * 4) devNames.set(id, { name: d.name, kind: d.kind });
    };

    for (let i = 0; i < count; i++) {
      const a = from + i * step;
      const b = i === count - 1 ? to + 1 : from + (i + 1) * step;
      const busy = new Map<string, number | null>();   // id → best tok/s, for every device busy in the frame
      const done = new Map<string, number>();
      let frameTokens = 0, frameAnswers = 0, frameWork = 0;
      let lookIn = false;
      for (; li < looks.length && looks[li].t < b; li++) {
        const cur = looks[li];
        lookIn = true;
        if (cur.model && !models.includes(cur.model) && models.length < 20) models.push(cur.model);
        for (const [id, d] of cur.devs) {
          remember(id, d);
          if (d.present) seen.add(id);
          if (d.busy) busy.set(id, Math.max(busy.get(id) ?? 0, d.tps ?? 0) || null);
        }
        if (prev !== null) {
          // a stretch the eye did not watch counts nothing, however busy the looks around it were
          const dt = cur.t - prev.t > GAP_MS ? 0 : Math.max(0, cur.t - Math.max(prev.t, from));
          let anyBusy = false;
          for (const [id, p] of prev.devs) {
            if (!p.busy) continue;
            anyBusy = true;
            const tps = p.tps ?? cur.devs.get(id)?.tps ?? 0;
            const w = work.get(id) ?? { workMs: 0, tokens: 0, answers: 0 };
            w.workMs += dt;
            w.tokens += (tps * dt) / 1000;
            work.set(id, w);
            frameTokens += (tps * dt) / 1000;
            worked.add(id);
          }
          if (anyBusy) frameWork += dt;
          // answers: the done counter grows; a new load starts it again from nothing
          for (const [id, c] of cur.devs) {
            if (!c.loaded) continue;
            const p = prev.devs.get(id);
            const same = p !== undefined && p.loaded && prev.since === cur.since && prev.model === cur.model;
            const got = same ? (c.done >= p.done ? c.done - p.done : c.done) : prev.model === null && cur.since >= from ? c.done : 0;
            if (got <= 0) continue;
            done.set(id, (done.get(id) ?? 0) + got);
            frameAnswers += got;
            const w = work.get(id) ?? { workMs: 0, tokens: 0, answers: 0 };
            w.answers += got;
            work.set(id, w);
            worked.add(id);
          }
        }
        prev = cur;
      }
      const fm: string[] = [];
      for (; mi < marks.length && marks[mi].t < b; mi++) {
        if (fm.length < 8 && !fm.includes(marks[mi].k)) fm.push(marks[mi].k);
        if (marks[mi].k === 'stop') stoppedAt = marks[mi].t;
      }
      const fl: ReplayFeed[] = [];
      for (; fi < feed.length && feed[fi].t < b; fi++) if (fl.length < FEED_FRAME_MAX) fl.push(feed[fi]);
      for (; vi < verdictEvents.length && verdictEvents[vi].t < b; vi++) {
        const e = verdictEvents[vi];
        if (e.to === 'bad' && verdicts[e.who] !== 'bad') badVerdicts++;
        if (e.who in verdicts || Object.keys(verdicts).length < VERDICTS_MAX) verdicts[e.who] = e.to;
      }
      const off = prev === null || (!lookIn && (a - prev.t > GAP_MS || stoppedAt > prev.t));
      if (off) offMs += Math.min(b, to) - a;
      tokens += frameTokens;
      answers += frameAnswers;
      workMs += frameWork;
      const shown = off ? null : prev;
      const devices: ReplayDevice[] = [];
      if (shown) {
        for (const [id, d] of shown.devs) {
          const isBusy = busy.has(id);
          devices.push({
            id, name: d.name, kind: d.kind, via: d.via, present: d.present, loaded: d.loaded,
            busy: isBusy, tps: isBusy ? busy.get(id) ?? d.tps : d.tps, plugged: d.plugged, answers: done.get(id) ?? 0,
          });
        }
      }
      frames.push({
        t: Math.round(a), off,
        model: shown?.model ?? null, mode: shown?.mode ?? null, loading: shown?.loading ?? null,
        devices, tokens: Math.round(tokens), answers, workMs: Math.round(workMs), verdicts: { ...verdicts }, feed: fl, marks: fm,
      });
    }

    const byDevice = [...work.entries()]
      .map(([id, w]) => ({ id, name: devNames.get(id)?.name ?? id, workMs: Math.round(w.workMs), tokens: Math.round(w.tokens), answers: w.answers }))
      .sort((x, y) => y.workMs - x.workMs || y.answers - x.answers);
    const rests = feed.filter((l) => l.branch === 'limits' && /should rest/.test(l.text)).length;
    const warnings = feed.filter((l) => l.branch === 'limits').length;

    // the chain over the stretch: from the key its first look is built on to its last record
    const spanFrom = keyStart ?? firstIn ?? 0;
    const spanTo = firstIn === null ? 0 : lastIn;
    const inSpan = firstIn === null ? undefined : bads.find((x) => x.n >= spanFrom && x.n <= spanTo);
    // a line that is not a record has no n: it breaks the link of the next one, which is in bads
    const chain: ReplayChain = {
      ok: inSpan === undefined,
      problem: inSpan?.problem ?? null,
      n: inSpan?.n ?? null,
      whole: walked.problem === null,
      wholeProblem: walked.problem,
    };

    return {
      from, to, step, range,
      records: { from: firstIn ?? 0, to: lastIn, count: countIn },
      box: { first: walked.firstT, last: walked.lastT, records: walked.count },
      devices: [...devNames.entries()].map(([id, d]) => ({ id, name: d.name, kind: d.kind })),
      frames,
      summary: {
        looks: looks.length, devices: worked.size, seen: seen.size, workMs: Math.round(workMs), byDevice,
        tokens: Math.round(tokens), answers, models, rests, warnings, badVerdicts, offMs: Math.round(offMs),
      },
      chain,
    };
  };

  return { take, finish };
}

// ---- the words: the cli's summary, and the page's card says the same

/** 5 h 12 min, 42 min, 30 s */
export function durationWords(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}

/** 41 230: thousands set apart by a thin space, the way the page writes them */
export function countWords(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

const plural = (n: number, one: string, many = `${one}s`): string => `${countWords(n)} ${n === 1 ? one : many}`;
const clock = (t: number): string => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const day = (t: number): string => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** the replay in a few lines of text: `kula-node brain replay` prints it */
export function replayText(r: Replay): string {
  const s = r.summary;
  const what = r.range === 'night' ? 'last night' : r.range === '12h' ? 'the last 12 hours (no look last night)' : 'from';
  const lines: string[] = [];
  lines.push(`${what === 'from' ? '' : `${what}: `}${day(r.from)} ${clock(r.from)} → ${day(r.to) === day(r.from) ? '' : `${day(r.to)} `}${clock(r.to)}`);
  if (s.looks === 0) {
    lines.push('the black box holds no look in this stretch: the eye was not watching, or kula-node ui was not running.');
  } else {
    const head = s.devices
      ? `${plural(s.devices, 'device')}, ${durationWords(s.workMs)} of work, about ${plural(s.tokens, 'token')} (from tok/s), ${plural(s.answers, 'answer')}`
      : `no device answered; ${plural(s.seen, 'device')} seen`;
    lines.push(head);
    for (const d of s.byDevice.slice(0, 8)) lines.push(`  ${d.name}: ${durationWords(d.workMs)}, about ${plural(d.tokens, 'token')}, ${plural(d.answers, 'answer')}`);
    if (s.models.length) lines.push(`model${s.models.length === 1 ? '' : 's'}: ${s.models.join(', ')}`);
    const notes: string[] = [];
    if (s.rests) notes.push(plural(s.rests, 'rest warning'));
    else if (s.warnings) notes.push(plural(s.warnings, 'limits line'));
    if (s.badVerdicts) notes.push(plural(s.badVerdicts, 'trust warning'));
    if (s.offMs >= GAP_MS) notes.push(`the eye was off for ${durationWords(s.offMs)}`);
    if (notes.length) lines.push(notes.join(' · '));
  }
  lines.push(r.records.count
    ? `records ${r.records.from}–${r.records.to} (${plural(r.records.count, 'record')}): ${r.chain.ok ? 'the chain holds' : `the chain does not hold: ${r.chain.problem}`}`
    : `no record in this stretch${r.box.records ? ` (the box holds ${plural(r.box.records, 'record')})` : ''}`);
  if (r.chain.ok && !r.chain.whole && r.chain.wholeProblem) lines.push(`elsewhere in the box: ${r.chain.wholeProblem}`);
  return lines.join('\n');
}
