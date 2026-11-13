// god's eye: one look every few seconds, handed to every branch. See types.ts.
// Platform-neutral (11.11.2026): no node: module here. The notes go through EyeNotes, the trust
// branch's signatures through EyeKeys, the black box is handed in opened (platform.ts); a
// computer's eye is node.ts, a phone's is app/src/eye/.
import { BRANCHES, BRANCH_IDS, dark, type Branch, type BranchCtx, type BranchEvent, type BranchId, type BranchMaker, type BranchView, type Snapshot, type SuggestAction, type Suggestion } from './types.js';
import { MAKERS } from './branches/index.js';
import { clean, dropped, type Dropped } from './branches/guard.js';
import type { Box, BoxStatus, EyeKeys, EyeNotes } from './platform.js';
import { sha256Hex } from './hash.js';
import { cardRank } from './rank.js';
import { facts, diff, keyChunks, lookPayload, makeScrubber, secretScan, trimVerdicts, type Facts, type Scrubber, type Scrubbed } from './boxfacts.js';

/** a deep copy of plain data: structuredClone where the platform has it (node), json elsewhere
 *  (Hermes); either throws on what is not plain, and the look is skipped */
const copyOf = <T>(x: T): T => (typeof structuredClone === 'function' ? structuredClone(x) : (JSON.parse(JSON.stringify(x)) as T));

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

// cards (11.11.2026): what a branch suggests, drawn on the panel; the person's tap carries it out
const CARDS_PER_BRANCH = 5;
const CARDS_MAX = 24;
const CARD_ID = /^[a-z]+:[\w.:@/-]{1,100}$/;
const MODES = ['phone', 'apart', 'split', 'here'];
const PANELS = ['devices', 'models', 'settings', 'branch'];
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
const ids = (v: unknown): string[] | null => (Array.isArray(v) && v.length <= 64 && v.every((x) => typeof x === 'string' && x.length <= 200) ? [...v] : null);

/** an action exactly as types.ts spells it, or null: a branch cannot slip anything else through a card */
export function cleanAction(a: unknown): SuggestAction | null {
  const x = a as Record<string, unknown> | null;
  if (!x || typeof x !== 'object') return null;
  switch (x.do) {
    case 'load': {
      const model = str(x.model, 200), devices = ids(x.devices);
      if (!model || !devices || !MODES.includes(x.mode as string)) return null;
      const ctx = typeof x.ctx === 'number' && Number.isInteger(x.ctx) && x.ctx >= 512 && x.ctx <= 262144 ? x.ctx : undefined;
      // here:false (apart only): the load leaves this computer out; any other here is the default, no key
      const here = x.mode === 'apart' && x.here === false ? { here: false as const } : {};
      return { do: 'load', model, mode: x.mode as 'phone', devices, ...(ctx ? { ctx } : {}), ...here };
    }
    case 'unload': return { do: 'unload' };
    case 'fetch': { const model = str(x.model, 200); return model ? { do: 'fetch', model } : null; }
    case 'probe': { const devices = ids(x.devices); return devices ? { do: 'probe', devices } : null; }
    case 'open': {
      if (!PANELS.includes(x.panel as string)) return null;
      const branch = BRANCH_IDS.includes(x.branch as BranchId) ? (x.branch as BranchId) : undefined;
      if (x.panel === 'branch' && !branch) return null;
      return { do: 'open', panel: x.panel as 'devices', ...(branch ? { branch } : {}) };
    }
    default: return null;
  }
}

/** the action the person saw is the action the card says now: deep equality of plain data, key order
 *  aside (finding A5: a card's id leaves out its devices). Missing on either side is never the same. */
export function sameAction(a: unknown, b: unknown): boolean {
  const canon = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(canon);
    if (!x || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, canon(o[k])]));
  };
  if (a == null || b == null) return false;
  try { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); } catch { return false; }
}

/** a dismissed card is the same card while it says the same kind of action: do, model and mode. Its
 *  devices (they follow who is reachable), ctx and here may change without the person's "no" ending;
 *  load → unload, another model or another mode is a new card. Missing on either side is never the same. */
export function sameDismissal(a: unknown, b: unknown): boolean {
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return x.do === y.do && x.model === y.model && x.mode === y.mode;
}

/** a branch's suggestion checked field by field, or null */
export function cleanCard(s: unknown): Suggestion | null {
  const x = s as Record<string, unknown> | null;
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !CARD_ID.test(x.id)) return null;
  const title = str(x.title, 140), whyText = str(x.why, 400);
  if (!title || !whyText || (x.kind !== 'suggest' && x.kind !== 'warn')) return null;
  const action = x.action == null ? null : cleanAction(x.action);
  if (x.action != null && action === null) return null;   // a broken action is no card, never a silent warning
  const label = str(x.label, 24) ?? undefined;
  const weight = x.weight === 1 || x.weight === 3 ? x.weight : 2;
  return { id: x.id, kind: x.kind, title, why: whyText, action, ...(label ? { label } : {}), weight };
}

/** what a thrown value says: a caught value may be null or undefined, which has no .message */
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** a payload's json length, the unit the box's own cut is measured in */
const payloadLength = (x: unknown): number => {
  try { return JSON.stringify(x)?.length ?? 0; } catch { return 0; }
};

export interface EyeOptions {
  snapshot: () => Snapshot;        // one look, plain data; the eye clones it once more anyway
  notes: EyeNotes;                 // where branches keep their notes (platform.ts)
  keys?: EyeKeys | null;           // signatures and certificates for the trust branch; none: it says so
  everyMs?: number;                // 5 s
  now?: () => number;
  log?: (s: string) => void;
  makers?: Partial<Record<BranchId, BranchMaker>>;  // tests, or a branch from elsewhere
  box?: Box | null;                // the black box, opened; absent means none, so nothing is written
}

export type EyeBranchView = BranchView & { n: number; id: BranchId; name: string; what: string; error?: string };
/** a branch's suggestion as the panel draws it: whose it is and since when it has been there */
export type EyeCard = Suggestion & { branch: BranchId; since: number };
export interface EyeView {
  at: number;                                         // when the last look was taken
  branches: EyeBranchView[];                          // the twelve, in the map's order
  cards: EyeCard[];                                   // suggestions and warnings, most important first
  events: (BranchEvent & { branch: BranchId })[];     // newest first
  box: { count: number; from: number; head: string | null; bytes: number; ok: boolean; problem: string | null } | null;
}

export class GodsEye {
  private branches = new Map<BranchId, Branch>();
  private broken = new Map<BranchId, string>();
  private views = new Map<BranchId, BranchView>();
  private events: (BranchEvent & { branch: BranchId })[] = [];
  private before: Snapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
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
    this.box = opts.box && typeof opts.box.append === 'function' ? opts.box : null;
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

  /** Forgets every note: each branch's notes and what it learned in memory; the branches start
   *  again from nothing at the next look. The black box is kept: it holds no branch's notes, and
   *  the forget tells the record what went. Returns how many stored pieces (files) went. */
  forget(): number {
    let n = 0;
    for (const id of BRANCH_IDS) {
      try { n += this.opts.notes.remove(id); } catch {}
      try { n += this.opts.notes.remove(`${id}.bad`); } catch {}
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
    const notes = this.opts.notes;
    return {
      now: () => this.now(),
      load: <T>(fallback: T): T => {
        let text: string | null;
        try { text = notes.read(id); } catch { return fallback; }
        if (text === null) return fallback;
        let v: T;
        try { v = JSON.parse(text) as T; }
        catch {
          // torn notes (a power cut mid-write): said once, kept aside, never the parse error or the text
          this.log(`god's eye ${id}: its notes could not be read (${text.length} chars); starting fresh, the old text is kept as ${id}.bad`);
          try { notes.write(`${id}.bad`, text); } catch {}
          return fallback;
        }
        return v === null ? fallback : v;   // notes holding JSON null are no notes
      },
      save: (data: unknown) => {
        try { notes.write(id, JSON.stringify(data)); }
        catch (e) { this.log(`god's eye ${id}: could not save: ${why(e)}`); }
      },
      keys: this.opts.keys ?? null,
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
      peek: (other: BranchId) => {
        const v = this.broken.has(other) ? null : this.views.get(other) ?? null;
        // finding D3: the advisor ranks only the cards the panel shows; a card the person dismissed
        // or applied is never its "first:" or "then:"
        if (id !== 'advisor' || v === null || this.hidden.size === 0 || !Array.isArray(v.suggestions)) return v;
        return { ...v, suggestions: v.suggestions.filter((s) => !this.hidesRaw(s)) };
      },
    };
  }

  /** One look: the snapshot through the guard, then every branch in the map's order. Nothing in
   *  here may throw out of it: a bad look is skipped whole, a throwing branch is stopped alone. */
  tick(): void {
    let snap: Snapshot | null = null;
    let left: Dropped = { devices: 0, models: 0, projects: 0 };
    let notLook: string | null = null;
    try {
      const copy = copyOf(this.opts.snapshot());
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
    try { this.settle(); } catch (e) { this.log(`god's eye: cards: ${why(e)}`); }
    this.record(snap, broken, left);
  }

  // ---- cards: the branches' suggestions, gathered for the panel; the eye itself never applies one

  // the bookkeeping (since, and when a dismissal ends) is the look's: settle() at the end of tick().
  // cards() only reads, so whether the page asks or not, the cards are the same (finding D4)
  private cardSince = new Map<string, number>();   // card id → when it first showed
  /** dismissed or applied, with the action the person saw: hidden while the branch says that id with
   *  that action (finding D2: the same id with another action is another card to the person) */
  private hidden = new Map<string, { action: SuggestAction | null; applied: boolean }>();

  /** a card with this id and this action is one the person dismissed or applied; no action on both
   *  sides is the same (a warning with nothing to apply). An applied card needs the very action; a
   *  dismissed one only the same kind of action (sameDismissal), so it survives device flaps */
  private isHidden(id: string, action: SuggestAction | null): boolean {
    const h = this.hidden.get(id);
    if (!h) return false;
    if (h.action === null) return action === null;
    return h.applied ? sameAction(h.action, action) : sameDismissal(h.action, action);
  }

  /** a raw suggestion (as a branch's view holds it) the panel hides now */
  private hidesRaw(s: unknown): boolean {
    const x = s as { id?: unknown; action?: unknown } | null;
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !this.hidden.has(x.id)) return false;
    return this.isHidden(x.id, x.action == null ? null : cleanAction(x.action));
  }

  /** every card the branches say now, checked, before anything is hidden; in the map's order */
  private liveCards(): (Suggestion & { branch: BranchId })[] {
    const out: (Suggestion & { branch: BranchId })[] = [];
    const seen = new Set<string>();
    for (const m of BRANCHES) {
      if (this.broken.has(m.id)) continue;
      const list = this.views.get(m.id)?.suggestions;
      if (!Array.isArray(list)) continue;
      let n = 0;
      for (const raw of list) {
        if (n >= CARDS_PER_BRANCH) break;
        const c = cleanCard(raw);
        if (!c || !c.id.startsWith(`${m.id}:`) || seen.has(c.id)) continue;   // a branch speaks only for itself
        seen.add(c.id);
        n++;
        out.push({ ...c, branch: m.id });
      }
    }
    return out;
  }

  /** after each look: a new card gets its since; a card whose reason is gone is forgotten, and so is
   *  its dismissal (if it comes back, it shows again); a dismissal whose card now says another action ends */
  private settle(): void {
    const live = new Map<string, SuggestAction | null>();
    for (const c of this.liveCards()) {
      live.set(c.id, c.action);
      if (!this.cardSince.has(c.id)) this.cardSince.set(c.id, this.lastAt || this.now());
    }
    for (const id of [...this.cardSince.keys()]) if (!live.has(id)) this.cardSince.delete(id);
    for (const id of [...this.hidden.keys()]) if (!live.has(id) || !this.isHidden(id, live.get(id) ?? null)) this.hidden.delete(id);
  }

  /** every card the branches say now, checked, the hidden ones left out, most important first. Only reads. */
  cards(): EyeCard[] {
    const all = this.liveCards();
    const hiddenNow = new Set(all.filter((c) => this.isHidden(c.id, c.action)).map((c) => c.id));
    const out: EyeCard[] = [];
    for (const c of all) {
      if (hiddenNow.has(c.id)) continue;
      // the advisor's "first: <card>" leans on another branch's card: hidden with it
      if (c.id.startsWith('advisor:first:') && hiddenNow.has(c.id.slice('advisor:first:'.length))) continue;
      out.push({ ...c, since: this.cardSince.get(c.id) ?? (this.lastAt || this.now()) });
    }
    return out.sort((a, b) => cardRank(b) - cardRank(a) || a.since - b.since).slice(0, CARDS_MAX);
  }

  /** the card with this id as it stands now, or null */
  card(id: string): EyeCard | null {
    return this.cards().find((c) => c.id === id) ?? null;
  }

  /** the person closed a card: hidden until its branch stops saying it or says another action */
  dismiss(id: string): boolean {
    const c = this.card(id);
    if (!c) return false;
    this.hidden.set(c.id, { action: c.action, applied: false });
    this.recordAct(c.branch, 'dismiss', c.id, 'dismissed');
    return true;
  }

  /** kula's engine carried a card out on the person's tap (or tried): hidden, and written in the box */
  applied(id: string, word: string): void {
    const c = this.cards().find((x) => x.id === id);
    if (!c) return;
    this.hidden.set(c.id, { action: c.action, applied: true });
    this.recordAct(c.branch, 'apply', c.id, String(word).slice(0, WORD_MAX));
  }

  /** kula's engine could not carry out an applied card (a load that failed in the background): the box
   *  says so whenever the id names a branch, even when a look already forgot the card (it went away
   *  while its load ran, finding F1). Only an applied card with this action (when one is given) shows
   *  again; a dismissal is never touched. The eye retries nothing: only the person's tap does. */
  unhide(id: string, why: string, action?: SuggestAction | null): boolean {
    const branch = String(id).slice(0, String(id).indexOf(':')) as BranchId;
    if (!BRANCH_IDS.includes(branch)) return false;
    const h = this.hidden.get(id);
    if (h && h.applied && (action === undefined || (h.action === null ? action === null : sameAction(h.action, action)))) this.hidden.delete(id);
    this.recordAct(branch, 'apply-failed', id, String(why).slice(0, WORD_MAX));
    return true;
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
    (this.timer as { unref?: () => void }).unref?.();   // node: the look never keeps the process up; a phone has no unref
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
    return { at: this.lastAt, branches, cards: this.cards(), events: [...this.events], box: this.boxView() };
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
      try { digest = sha256Hex(JSON.stringify(plain)).slice(0, 16); } catch {}
      if (this.digests.get(meta.id) === digest) continue;
      out ??= {};
      const gauge = typeof plain.gauge === 'number' && Number.isFinite(plain.gauge) ? plain.gauge : null;
      out[meta.id] = [plain.built === true, redact.scrub(String(plain.stat ?? '')), gauge, digest];
    }
    return out;
  }

  /** a branch's view as the eye hands it out: broken or not built yet, and without the forecast's
   *  pairs or any branch's hints (both are for the other branches, through peek) */
  private plainView(id: BranchId): BranchView {
    const v = this.broken.has(id) ? dark('broken') : (this.views.get(id) ?? dark('looking…'));
    const { pairs: _pairs, hints: _hints, ...plain } = v;
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
