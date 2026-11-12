// god's eye (8.11.2026): the brain of kula, as its own program in waiting. It watches the work
// from above and never takes part in it: every few seconds it is handed a snapshot (plain data,
// a copy), each of its twelve branches thinks about it with its own simple rules and keeps its
// own notes, and anyone may ask for its view. It does not import kula's engine, chat or devices,
// it never calls them, never touches a phone, never loads or stops a model and sends nothing on
// the network. Today kula-node feeds it in-process (ui/godseye-feed.ts); later the same snapshot
// can come over a pipe or a socket and god's eye runs as a program of its own.
//
// The twelve branches are the twelve of the brain map (https://claude.ai/artifact/XdUbnR74Y1gTzeBfcZCe7K).

import type { EyeKeys } from './platform.js';

export type BranchId =
  | 'senses' | 'memory' | 'forecast' | 'learning' | 'connections' | 'planner'
  | 'executor' | 'trust' | 'limits' | 'models' | 'review' | 'advisor';

export interface BranchMeta { n: number; id: BranchId; name: string; what: string }

/** The map's order, names and the one line on what each branch is for. */
export const BRANCHES: BranchMeta[] = [
  { n: 1, id: 'senses', name: 'senses', what: 'it sees every device: is it there, how much memory is free, how fast it answers.' },
  { n: 2, id: 'memory', name: 'memory', what: 'what happened and why, kept on this computer: the decision log. the phones keep their own signed ledgers.' },
  { n: 3, id: 'forecast', name: 'forecast', what: 'will guess when each device is free and how fast it will be tonight, from what it saw before.' },
  { n: 4, id: 'learning', name: 'learning loop', what: 'will compare each guess with what really happened in the morning and tune itself.' },
  { n: 5, id: 'connections', name: 'connections', what: 'how each device is reached: a usb cable, the wi-fi or a relay. no server outside, no relay by default.' },
  { n: 6, id: 'planner', name: 'planner', what: 'where the model sits: one phone, a copy on each (apart) or one model across them (split), and why.' },
  { n: 7, id: 'executor', name: 'executor', what: 'who is answering now and how fast; in apart mode the fastest free device answers.' },
  { n: 8, id: 'trust', name: 'trust and verification', what: 'one answer for the whole cluster: is every link tls with the certificate pinned, does each device prove who it is, what did its gate refuse, does its signed ledger hold together.' },
  { n: 9, id: 'limits', name: 'limits', what: 'will keep phones cool and charged: heat, battery and energy rules a device may set for itself.' },
  { n: 10, id: 'models', name: 'models and device care', what: 'which model fits which device, files checked by sha256, what each device holds right now.' },
  { n: 11, id: 'review', name: 'request review', what: 'will look at a job before it runs: is it allowed, is it safe to send to someone else’s phone.' },
  { n: 12, id: 'advisor', name: 'advisor', what: 'will suggest: which model, which devices, which night, before you ask.' },
];
export const BRANCH_IDS: BranchId[] = BRANCHES.map((b) => b.id);

// ---- the snapshot: everything god's eye may know, as plain data of its own shape

export interface EyeDevice {
  id: string;
  name: string;
  kind: string;                    // phone, pc, …
  via: 'cable' | 'wifi' | 'relay' | 'internet';   // internet: its gate answered only at a global ipv6 address or its router's port
  where: string;                   // how it is reached, in words (an address, "usb cable", …)
  // which kind of address its pinned certificate answered at (docs/INTERNET.md): its lan
  // address, a global ipv6 address, or a port its router mapped; null on a cable or a relay.
  // Left out of a snapshot from before 11.11.2026.
  reachedBy?: 'lan' | 'ipv6' | 'mapped' | null;
  reachable: boolean | null;       // null: not looked at yet
  reachMs: number | null;
  reason: string | null;           // why not reachable
  checkedAt: number | null;        // ms, when it was last looked at
  lastOk: string | null;           // iso time it last answered
  ramMb: number | null;            // free memory it said it has
  bwGBs: number | null;            // memory bandwidth it measured
  gpu: string | null;
  tls: boolean;                    // tls with a pinned certificate
  waitingPair: boolean;            // waiting for its one-time code
  plugged: boolean | null;         // on a cable: is it plugged in now (null: unknown)
  holds: string | null;            // the model file it has loaded
  trust: EyeTrust | null;          // what the device said about itself (GET /trust); null: never asked
  ring?: Ring;                     // how far the person trusts it; absent: home (every device paired before 11.11.2026)
  // its own health (12.11.2026): the newest reading of the signed health lines its worker writes
  // to its ledger every minute or when its warnings change (WorkerService.kt, Auditor.kt
  // onHealth), read from trust.lines (ui/godseye-feed.ts healthOf). at: the line's t, the phone's
  // clock; tempC: its battery's °C; battery: percent; charging: no worker says it yet (null);
  // null: no reading in the lines; absent: a snapshot from before 12.11.2026
  health?: EyeHealth | null;
}

export interface EyeHealth { at: number; tempC: number | null; battery: number | null; charging: boolean | null; throttled: boolean | null }

/** The three rings (11.11.2026): home is the person's own devices (everything may go there, a private
 *  chat included), circle a friend's (work the person trusts them with), world a stranger's (only
 *  pieces with nothing private: a stranger's phone sees the prompt in plain text while it runs). */
export type Ring = 'home' | 'circle' | 'world';

/** A device's own account of its security (the worker's GET /trust, docs/GATE.md), as kula's engine
 *  received it. Nothing in it is taken on faith: the trust branch checks the certificate against the
 *  pinned fingerprint and every ledger line's chain and signature itself. */
export interface EyeTrust {
  at: number;                      // ms, when the last answer (or failure) came
  error: string | null;            // why there is no answer: an older worker without /trust, a timeout, …
  id: string | null;               // the device id it claims (32 hex)
  alg: string | null;              // its ledger key: ed25519 or p256
  pub: string | null;              // the ledger key's public half, base64 spki
  store: string | null;            // where that key lives: keystore or file
  cert: string | null;             // its gate certificate, base64 der
  certPinned: boolean | null;      // kula compared it with the fingerprint pinned from the qr (the pin itself stays out)
  v1: boolean | null;              // would it still accept the old plain-text protocol
  paired: number | null;           // how many certificates it has paired
  self: string | null;             // ok, broken or empty: its own check of its ledger
  count: number | null;            // lines in its ledger
  head: string | null;             // sha256 of its last ledger line
  lines: string[];                 // ledger lines received, oldest first, a window of the last few hundred
  restartedAt: number | null;      // when its ledger last no longer held the line seen before
  rejectsDay: Record<string, number>;               // refusals of the last 24 h, by reason
  rejectsLast: { t: number; why: string; peer: string }[];
  // owner-blind (attest.ts): whether its owner cannot see the work, as its hardware proved when
  // last asked (this computer checked the proof when it came); null: never asked. `why` is
  // attest.ts's Why, `ok` null where nothing can be proven (a computer, an older kula)
  attest?: { at: number; ok: boolean | null; why: string; text: string } | null;
}

/** The trust branch's one screen: one verdict over every device, and each device's checks. */
export type Verdict = 'ok' | 'bad' | 'unknown';
export interface TrustCheck { k: string; ok: boolean | null; text: string }
export interface TrustReport {
  verdict: Verdict;
  headline: string;
  at: number;
  host: { name: string; checks: TrustCheck[] };
  devices: { id: string; name: string; verdict: Verdict; checks: TrustCheck[]; refused: string; accept: boolean }[];
}

export interface EyeWork {
  loaded: null | {
    mode: string;                  // phone, apart, split, here
    model: { id: string; name: string; file: string; size: number };
    ctx: number;
    since: number;
    devices: { id: string; name: string; local: boolean; busy: boolean; tps: number | null; done: number }[];
    parts?: { id: string; name: string; local: boolean; mb: number; layers: number }[];
  };
  loading: null | { mode: string; model: string; since: number; line: string };
  chatting: number;                // answers being written now
  plan: string[];                  // why the model sits where it sits
  decisions: { at: number; text: string }[];
  llama: boolean;                  // this computer can run llama.cpp itself
  photos?: { n: number; unseen: number; at: number | null };   // photos sent in chats since kula-node started; unseen: refused, nothing here sees them
}

export interface EyeModel {
  id: string; name: string; file: string; size: number; quant: string | null; params_b: number | null;
  catalog: boolean;                // phones can fetch it
  here: boolean;                   // the file is on this computer
  needMb: number;                  // what running it whole takes at 4k context
  active_b?: number | null;        // a mixture of experts: the parameters one token reads
  vision?: boolean;                // it sees photos (an image encoder in the catalog)
}

export interface EyeProject {
  id: string; title: string; request: string; start: number; end: number; state: string;
  mode: string; model: string; peers: string[]; parts?: number; done?: number; line?: string; error?: string;
}

export interface Snapshot {
  at: number;                      // ms, the clock of the computer that took it
  host: {
    name: string; freeMb: number | null; ledger?: { ok: boolean; count: number; problem: string | null } | null;
    /** the host's own battery and heat, when it has them (a phone: app/src/eye/snapshot.ts); a computer leaves it out */
    power?: { battery: number | null; charging: boolean | null; hot: boolean | null } | null;
  };
  devices: EyeDevice[];
  work: EyeWork;
  models: EyeModel[];
  projects: EyeProject[];
}

// ---- what a branch shows and how it lives

/** A branch's view: a few words for its tile, a 0..100 gauge, and its page. */
export interface BranchView {
  built: boolean;                  // false: the tile stays dark
  stat: string;                    // the tile's line, a few words
  gauge: number | null;            // 0..100, or null for no bar
  rows: [string, string][];        // its page: key / value
  lines: string[];                 // its page: a list, newest or most important first
  note?: string;                   // its page: one line under the list
  what?: string;                   // overrides the map's line once the branch says more
  report?: TrustReport;            // the trust branch's one screen
  suggestions?: Suggestion[];      // cards for the brain panel; at most 5 per branch are shown
  pairs?: { id: string; name: string; scored: [number, number, number, number, number, number][] }[];  // forecast → learning: [t, p, lo, hi, p0, x] per finished hour, oldest first
  hints?: DeviceHint[];            // what a branch tells the deciding branches about each device (peek only, never in a view)
}

/** A branch's word on one device for the deciding branches (11.11.2026): forecast says tonight and
 *  the speeds it measured, limits says no to a device that should rest. Data, not drawn. */
export interface DeviceHint {
  id: string;                      // a device id from the snapshot, or "local" for this computer
  no?: string;                     // why no work should go to it now, in a few words
  tonight?: { guess: 'likely' | 'maybe' | 'unlikely' | 'unknown'; p: number; hours: number[] };   // hours: the chance per hour 22:00..06:00
  tps?: { file: string; tps: number; n: number }[];   // measured tok/s per model file, n answers behind it
}

/** A line a branch wants in the live feed. */
export interface BranchEvent { at: number; text: string }

/** One branch: told about every look (now and the one before), asked for its view. Both quick;
 *  a branch that throws is stopped and shown as broken, the others carry on. */
/** What the person may do about a card (11.11.2026). The eye never does it: a tap on the card asks
 *  kula's engine to, the same way the person's own buttons do. `devices` are device ids from the snapshot. */
export type SuggestAction =
  | { do: 'load'; model: string; mode: 'phone' | 'apart' | 'split' | 'here'; devices: string[]; ctx?: number; here?: false }  // here:false only with apart: this computer stays out
  | { do: 'unload' }
  | { do: 'fetch'; model: string }                  // a catalog model onto this computer
  | { do: 'probe'; devices: string[] }               // look at these devices again
  | { do: 'open'; panel: 'devices' | 'models' | 'settings' | 'branch'; branch?: BranchId };  // only moves the page

/** A branch's suggestion or warning, drawn as a card on the brain panel. */
export interface Suggestion {
  id: string;                      // stable while its reason holds, "<branch>:<topic>": the same id is the same card
  kind: 'suggest' | 'warn';
  title: string;                   // one line
  why: string;                     // a sentence or two: what the branch saw
  action: SuggestAction | null;    // null: something to know, nothing to apply
  label?: string;                  // the button's word ("load", "fetch"); a default per action otherwise
  weight?: 1 | 2 | 3;              // how much it matters; 3 first (default 2)
}

export interface Branch {
  id: BranchId;
  observe(now: Snapshot, before: Snapshot | null): void;
  view(): BranchView;
  /** something the person decided on the branch's page (the trust branch: "I cleared it"); a word back, or null */
  act?(action: string, arg: string): string | null;
}

/** What a branch lives on: a clock, its own notes file, the feed, the others' views (read only). */
export interface BranchCtx {
  now(): number;
  load<T>(fallback: T): T;         // <dir>/<id>.json, or the fallback
  save(data: unknown): void;       // the same file, written whole, mode 600
  emit(text: string): void;        // a line in the live feed
  peek(id: BranchId): BranchView | null;
  /** signatures and certificates where the platform has them (platform.ts); null or absent: none */
  keys?: EyeKeys | null;
}

export type BranchMaker = (ctx: BranchCtx) => Branch;

export const dark = (stat = 'not built yet'): BranchView => ({ built: false, stat, gauge: null, rows: [], lines: [] });
