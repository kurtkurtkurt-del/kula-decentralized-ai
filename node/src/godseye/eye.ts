// god's eye: one look every few seconds, handed to every branch. See types.ts.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BRANCHES, BRANCH_IDS, dark, type Branch, type BranchCtx, type BranchEvent, type BranchId, type BranchMaker, type BranchView, type Snapshot } from './types.js';
import { MAKERS } from './branches/index.js';
import { clean, dropped, type Dropped } from './branches/guard.js';
import { openBox, type Box, type BoxStatus } from './box.js';
import { facts, diff, keyChunks, lookPayload, makeScrubber, secretScan, trimVerdicts, type Facts, type Scrubber, type Scrubbed } from './boxfacts.js';

const EVENTS_MAX = 60;

// the black box's bounds. A key is written at the first look, after a forget and after any failed
// append, and otherwise at least every KEY_LOOKS looks or KEY_BYTES appended since the last key.
// No payload goes past PAYLOAD_CAP (the box quietly replaces one past 16 384 with {"cut":true}).
const KEY_LOOKS = 720;
const KEY_BYTES = 512 * 1024;
const PAYLOAD_CAP = 12_000;
const ENVELOPE_BYTES = 190;       // a record's bytes besides its payload, for the keyframe count
const PENDING_MAX = 300;          // feed lines waiting for the box; the live feed itself holds 60
const WHY_MAX = 200;              // a broken branch's why, first chars only
const ACT_MAX = 40;               // an act's action, as the branch receives it
const ARG_MAX = 200;              // an act's arg, as the branch receives it
const WORD_MAX = 200;             // what the branch answered
const LAST_IDS_MAX = 4096;        // device ids of the last look, for act's arg check
const VERDICT_MAX = 1024;         // verdicts remembered, so a change is written once

/** one branch's view in a look: built, stat, gauge, and the digest of the whole view's json.
 *  a look over the secret cap records the stat as { scrubbed, len } instead of its words */
type ViewTuple = [boolean, string | Scrubbed, number | null, string];

/** the left-out counts the eye says, one line per kind per run of looks that leave one out */
const LEFT_OUT: [keyof Dropped, string][] = [['devices', 'device'], ['models', 'model'], ['projects', 'project']];

/** what a thrown value says: a caught value may be null or undefined, which has no .message */
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** a payload's json length, the unit the box's own cut is measured in */
const payloadLength = (x: unknown): number => {
  try { return JSON.stringify(x)?.length ?? 0; } catch { return 0; }
};

/** the box the eye writes: one given, or one opened in the given dir; no option means no box */
function makeBox(x: EyeOptions['box']): Box | null {
  if (x === null || x === undefined) return null;
  try {
    if (typeof (x as Box).append === 'function') return x as Box;
    const dir = (x as { dir?: unknown }).dir;
    if (typeof dir === 'string') return openBox({ dir });
  } catch {}
  return null;   // a box the eye cannot use is no box, never a stopped eye
}

export interface EyeOptions {
  snapshot: () => Snapshot;        // one look, plain data; the eye clones it once more anyway
  dir: string;                     // where branches keep their notes
  everyMs?: number;                // 5 s
  now?: () => number;
  log?: (s: string) => void;
  makers?: Partial<Record<BranchId, BranchMaker>>;  // tests, or a branch from elsewhere
  box?: Box | { dir: string };     // the black box; absent means none, so nothing is written
}

export type EyeBranchView = BranchView & { n: number; id: BranchId; name: string; what: string; error?: string };
export interface EyeView {
  at: number;                                         // when the last look was taken
  branches: EyeBranchView[];                          // the twelve, in the map's order
  events: (BranchEvent & { branch: BranchId })[];     // newest first
  box: { count: number; from: number; head: string | null; bytes: number; ok: boolean; problem: string | null } | null;
}

export class GodsEye {
  private branches = new Map<BranchId, Branch>();
  private broken = new Map<BranchId, string>();
  private views = new Map<BranchId, BranchView>();
  private events: (BranchEvent & { branch: BranchId })[] = [];
  private before: Snapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastAt = 0;
  private readonly now: () => number;
  private skipping = false;   // a run of looks that were not usable, being logged once
  private dropping: Record<keyof Dropped, boolean> = { devices: false, models: false, projects: false };
  // ---- the black box
  private readonly box: Box | null;
  private boxStatus: BoxStatus | null = null;      // the chain as the last tick's status() saw it
  private facts: Facts | null = null;              // the facts of the last recorded look or key
  private digests = new Map<BranchId, string>();   // the view digest last written per branch
  private verdicts = new Map<string, string>();    // the verdict last written per who
  private lastIds = new Set<string>();             // device ids of the last look, for act's arg
  private redact: Scrubber = makeScrubber([]);     // the last look's scrubber, built once a look
  private needKey = true;                          // the next look is a key, not a delta
  private looksSinceKey = 0;
  private bytesSinceKey = 0;
  private missed = 0;                              // appends that failed since the last gap record
  private failing = false;                         // a failed append was logged for this run
  private pending: (BranchEvent & { branch: BranchId })[] = [];   // feed lines not yet written
  private started = false;

  constructor(private readonly opts: EyeOptions) {
    this.now = opts.now ?? Date.now;
    this.box = makeBox(opts.box);
    this.make();
  }

  /** the eye's one log: a log that throws must not stop it */
  private log(s: string): void {
    try { this.opts.log?.(s); } catch {}
  }

  private make(): void {
    for (const id of BRANCH_IDS) {
      try { this.branches.set(id, (this.opts.makers?.[id] ?? MAKERS[id])(this.ctx(id))); }
      catch (e) {
        this.broken.set(id, why(e));
        this.log(`god's eye ${id}: stopped: ${why(e)}`);
      }
    }
  }

  /** Forgets every note: each branch's file in `dir` and what it learned in memory; the
   *  branches start again from nothing at the next look. The black box is kept: its own dir has
   *  no branch's name, and the forget tells the record what went. Returns how many files went. */
  forget(): number {
    let n = 0;
    let names: string[] = [];
    try { names = fs.readdirSync(this.opts.dir); } catch {}
    for (const f of names) {
      if (!BRANCH_IDS.some((id) => f === `${id}.json` || (f.startsWith(`${id}.json.`) && f.endsWith('.tmp')))) continue;
      try { fs.rmSync(path.join(this.opts.dir, f), { force: true }); n++; } catch {}
    }
    this.branches.clear();
    this.broken.clear();
    this.views.clear();
    this.events = [];
    this.before = null;
    this.pending = [];
    this.facts = null;
    this.digests.clear();
    this.verdicts.clear();
    this.lastIds.clear();
    this.redact = makeScrubber([]);
    this.needKey = true;          // the next look rebuilds the facts from nothing
    this.looksSinceKey = 0;
    this.bytesSinceKey = 0;
    this.make();
    if (this.box !== null) {
      this.write(this.now(), 'forget', null, { files: n });
      this.refreshStatus();
    }
    return n;
  }

  private ctx(id: BranchId): BranchCtx {
    const file = path.join(this.opts.dir, `${id}.json`);
    return {
      now: () => this.now(),
      load: <T>(fallback: T): T => {
        try {
          const v = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
          return v === null ? fallback : v;   // a file holding JSON null is no notes
        } catch { return fallback; }
      },
      save: (data: unknown) => {
        try {
          fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
          fs.renameSync(tmp, file);
        } catch (e) { this.log(`god's eye ${id}: could not save: ${why(e)}`); }
      },
      emit: (text: string) => {
        const ev = { at: this.now(), text: String(text).slice(0, 300), branch: id };
        this.events.unshift(ev);
        this.events.length = Math.min(this.events.length, EVENTS_MAX);
        if (this.box !== null) {
          this.pending.push(ev);
          if (this.pending.length > PENDING_MAX) this.pending.splice(0, this.pending.length - PENDING_MAX);
        }
      },
      // a broken branch's last view is not quoted for ever: peek sees nothing of it
      peek: (other: BranchId) => (this.broken.has(other) ? null : this.views.get(other) ?? null),
    };
  }

  /** One look: the snapshot through the guard, then every branch in the map's order. Nothing in
   *  here may throw out of it: a bad look is skipped whole, a throwing branch is stopped alone. */
  tick(): void {
    let snap: Snapshot | null = null;
    let left: Dropped = { devices: 0, models: 0, projects: 0 };
    let notLook: string | null = null;
    try {
      const copy = structuredClone(this.opts.snapshot());
      snap = clean(copy);
      if (snap !== null) left = dropped(copy);   // what the guard left out, counted the same way
    } catch (e) { notLook = why(e); }
    if (snap === null) {
      // thrown, uncloneable, not an object, or no usable at: no branch sees it and `before`
      // stands. one line per run of such looks, not one every few seconds
      if (!this.skipping) this.log(notLook === null ? "god's eye: a look was not usable, skipped" : `god's eye: no look: ${notLook}`);
      this.skipping = true;
      this.recordSkip(notLook === null ? 'unusable' : 'threw');
      return;
    }
    this.skipping = false;
    // nothing the guard leaves out may vanish without a word: one line per kind per run of looks
    // that leave one out, not one every few seconds
    for (const [kind, word] of LEFT_OUT) {
      if (left[kind] > 0) {
        if (!this.dropping[kind]) this.log(`god's eye: ${left[kind]} ${word}(s) in the look had no usable id and were left out`);
        this.dropping[kind] = true;
      } else this.dropping[kind] = false;
    }
    const broken: [BranchId, string][] = [];
    try {
      this.lastAt = snap.at;
      this.lastIds = new Set();
      for (const d of snap.devices) {
        if (this.lastIds.size >= LAST_IDS_MAX) break;
        this.lastIds.add(d.id);
      }
      for (const id of BRANCH_IDS) {
        const b = this.branches.get(id);
        if (!b || this.broken.has(id)) continue;
        try {
          b.observe(snap, this.before);
          this.views.set(id, b.view());
        } catch (e) {
          this.broken.set(id, why(e));
          broken.push([id, why(e)]);
          this.log(`god's eye ${id}: stopped: ${why(e)}`);
        }
      }
      this.before = snap;
    } catch (e) {
      this.log(`god's eye: ${why(e)}`);
    }
    this.record(snap, broken, left);
  }

  /** Hands a decision from the branch's page to the branch (it never reaches a device), then looks again. */
  act(id: BranchId, action: string, arg: string): string | null {
    const b = this.branches.get(id);
    let word: string | null = null;
    if (b?.act && !this.broken.has(id)) {
      try { word = b.act(String(action).slice(0, ACT_MAX), String(arg).slice(0, ARG_MAX)); }
      catch (e) { this.log(`god's eye ${id}: ${why(e)}`); word = null; }
      try { this.views.set(id, b.view()); } catch {}
    }
    this.recordAct(id, action, arg, word);
    return word;
  }

  start(): void {
    if (this.timer) return;
    this.started = true;
    if (this.box !== null) {
      this.write(this.now(), 'start', null, { v: 1, everyMs: this.opts.everyMs ?? 5000 });
      this.refreshStatus();
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.everyMs ?? 5000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.started) return;
    this.started = false;
    if (this.box === null) return;
    try {
      this.flushFeed();   // anything the branches said last goes in first
      this.write(this.now(), 'stop', null, {});
      this.refreshStatus();
    } catch (e) { this.log(`god's eye: the black box: ${why(e)}`); }
  }

  view(): EyeView {
    const branches = BRANCHES.map((m): EyeBranchView => {
      const err = this.broken.get(m.id);
      // the forecast's scored hours are for the branches' eyes only (peek): they never ride in a
      // view, where they would be up to 40 × 200 × 6 numbers on every look
      const v = err ? { ...dark('broken'), error: err } : this.plainView(m.id);
      return { ...v, n: m.n, id: m.id, name: m.name, what: v.what || m.what };
    });
    return { at: this.lastAt, branches, events: [...this.events], box: this.boxView() };
  }

  // ---- the black box: what the eye writes, and what it says about the chain

  /** one record into the box; a look or key first, then what broke, what the branches said and
   *  what the trust report changed; the cheap chain status is cached last. never throws. */
  private record(snap: Snapshot, broken: [BranchId, string][], left: Dropped): void {
    if (this.box === null) return;
    try {
      // one scan and one window set a look: a quoted line then costs a walk of itself, not a
      // walk of every secret (a device's 64 MiB of ledger lines would stall the eye otherwise)
      const scan = secretScan(snap);
      this.redact = makeScrubber(scan.secrets, scan.total);
      const now = facts(snap);
      const v = this.changedViews(this.redact);
      const d = this.facts === null ? null : diff(this.facts, now);
      const payload = d === null ? null : lookPayload(snap.at, d, v, left);
      const key = this.needKey || this.facts === null || payload === null
        || this.looksSinceKey >= KEY_LOOKS || this.bytesSinceKey >= KEY_BYTES
        || payloadLength(payload) > PAYLOAD_CAP;
      if (key) {
        // a key is a look too: it carries the views that changed in chunk 0, and their digests are
        // saved only when every chunk made it, so a half-written key is no base for anything
        let ok = true;
        for (const chunk of keyChunks(snap.at, now, v)) ok = this.write(snap.at, 'key', null, chunk) && ok;
        if (ok) {
          this.facts = now;
          this.looksSinceKey = 0;
          this.bytesSinceKey = 0;
          this.needKey = false;
          if (v !== null) for (const [id, tuple] of Object.entries(v)) this.digests.set(id as BranchId, tuple[3]);
        }
      } else if (payload !== null) {
        if (this.write(snap.at, 'look', null, payload)) {
          this.facts = now;
          this.looksSinceKey++;
          if (v !== null) for (const [id, tuple] of Object.entries(v)) this.digests.set(id as BranchId, tuple[3]);
        }
      }
      for (const [id, text] of broken) {
        const why = this.redact.scrub(text);
        this.write(snap.at, 'broken', id, { why: typeof why === 'string' ? why.slice(0, WHY_MAX) : why });
      }
      this.flushFeed();
      this.writeVerdicts(snap.at);
      this.refreshStatus();
    } catch (e) {
      this.log(`god's eye: the black box: ${why(e)}`);
    }
  }

  /** a skipped look: the two words say why; there is no look time, so the eye's clock stamps it */
  private recordSkip(k: 'threw' | 'unusable'): void {
    if (this.box === null) return;
    try {
      this.write(this.now(), 'skip', null, { why: k });
      this.flushFeed();
      this.refreshStatus();
    } catch (e) {
      this.log(`god's eye: the black box: ${why(e)}`);
    }
  }

  /** an act, refused or not: the action and what the branch answered, and the arg only when it
   *  is a device id of the last look (anything else is kept as its length) */
  private recordAct(id: BranchId, action: string, arg: string, word: string | null): void {
    if (this.box === null) return;
    try {
      // the page's action and the branch's answer may quote what the look holds privately
      const a = this.redact.scrub(String(action).slice(0, ACT_MAX));
      const full = String(arg).slice(0, ARG_MAX);
      const w = typeof word === 'string' ? this.redact.scrub(word.slice(0, WORD_MAX)) : null;
      const x = this.lastIds.has(full)
        ? { action: a, arg: full, word: w }
        : { action: a, arg: null, argLen: full.length, word: w };
      this.write(this.now(), 'act', id, x);
      this.flushFeed();
      this.refreshStatus();
    } catch (e) {
      this.log(`god's eye: the black box: ${why(e)}`);
    }
  }

  /** each branch whose view changed since the last recorded digest, as [built, stat, gauge, digest] */
  private changedViews(redact: Scrubber): Record<string, ViewTuple> | null {
    let out: Record<string, ViewTuple> | null = null;
    for (const meta of BRANCHES) {
      const plain = this.plainView(meta.id);
      // the forecast's pairs are not in this json: they never ride in a view, and hashing them
      // every look would cost more than the record they are left out of
      let digest = '';
      try { digest = createHash('sha256').update(JSON.stringify(plain), 'utf8').digest('hex').slice(0, 16); } catch {}
      if (this.digests.get(meta.id) === digest) continue;
      out ??= {};
      const gauge = typeof plain.gauge === 'number' && Number.isFinite(plain.gauge) ? plain.gauge : null;
      out[meta.id] = [plain.built === true, redact.scrub(String(plain.stat ?? '')), gauge, digest];
    }
    return out;
  }

  /** a branch's view as the eye hands it out: broken or not built yet, and without the forecast's pairs */
  private plainView(id: BranchId): BranchView {
    const v = this.broken.has(id) ? dark('broken') : (this.views.get(id) ?? dark('looking…'));
    const { pairs: _pairs, ...plain } = v;
    return plain;
  }

  /** the chain's state for the view: from the status cached at the last tick, never a full verify */
  private boxView(): EyeView['box'] {
    const s = this.boxStatus;
    if (this.box === null || s === null) return null;
    return { count: s.count, from: s.from, head: s.head, bytes: s.bytes, ok: s.ok, problem: s.problem };
  }

  /** the cheap chain status, cached for the view; a status that throws is a chain that cannot be read */
  private refreshStatus(): void {
    if (this.box === null) return;
    try { this.boxStatus = this.box.status(); }
    catch (e) {
      this.boxStatus = { count: 0, from: 0, head: null, bytes: 0, segments: 0, ok: false, problem: `the box could not be read: ${why(e)}` };
    }
  }

  /** every feed line not yet written, scrubbed of the last look's private strings */
  private flushFeed(): void {
    if (this.box === null || this.pending.length === 0) return;
    const events = this.pending;
    this.pending = [];
    for (const ev of events) this.write(ev.at, 'feed', ev.branch, { text: this.redact.scrub(ev.text) });
  }

  /** the trust report's verdicts that changed since the last written one; a device, the host, or * */
  private writeVerdicts(at: number): void {
    if (this.broken.has('trust')) return;
    const report = this.views.get('trust')?.report;
    if (!report) return;
    const next = new Map<string, string>();
    next.set('*', report.verdict === 'bad' || report.verdict === 'ok' ? report.verdict : 'unknown');
    const checks = Array.isArray(report.host?.checks) ? report.host.checks : [];
    let hostBad = false;
    let hostUnknown = false;
    for (const c of checks) {
      if (!c || typeof c !== 'object') continue;
      if (c.ok === false) hostBad = true;
      else if (c.ok !== true) hostUnknown = true;
    }
    next.set('host', hostBad ? 'bad' : hostUnknown ? 'unknown' : 'ok');
    // only as many devices are read as are remembered, so the list is never shorter than what the
    // report put in front of it: a device dropped for lack of room would be written again every look
    for (const d of Array.isArray(report.devices) ? report.devices : []) {
      if (next.size >= VERDICT_MAX) break;
      if (!d || typeof d !== 'object' || typeof d.id !== 'string' || d.id.length === 0) continue;
      next.set(d.id.slice(0, 200), d.verdict === 'bad' || d.verdict === 'ok' ? d.verdict : 'unknown');
    }
    for (const [who, to] of next) {
      const from = this.verdicts.get(who) ?? null;
      if (from === to) continue;
      if (this.write(at, 'verdict', 'trust', { who, from, to })) this.verdicts.set(who, to);
    }
    this.verdicts = trimVerdicts(this.verdicts, next.keys(), VERDICT_MAX);
  }

  /** one append: after a run of failures the first record that can be written is a gap, before
   *  itself. a failure is logged once per run and makes the next look a key. */
  private write(t: number, kind: string, branch: string | null, x: unknown): boolean {
    if (this.box === null) return false;
    if (this.missed > 0 && kind !== 'gap') {
      if (!this.raw(t, 'gap', null, { missed: this.missed })) return false;
      this.missed = 0;
    }
    return this.raw(t, kind, branch, x);
  }

  private raw(t: number, kind: string, branch: string | null, x: unknown): boolean {
    if (this.box === null) return false;
    const bytes = ENVELOPE_BYTES + payloadLength(x);
    let ok = false;
    try { ok = this.box.append(t, kind, branch, x) === true; } catch { ok = false; }
    if (!ok) {
      this.missed++;
      this.needKey = true;
      if (!this.failing) {
        this.failing = true;
        this.log("god's eye: the black box could not be written");
      }
      return false;
    }
    this.failing = false;
    this.bytesSinceKey += bytes;
    return true;
  }
}
