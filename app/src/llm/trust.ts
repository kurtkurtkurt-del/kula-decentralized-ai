import type { TrustVerified } from '@/llm/native';
import type { Peer } from '@/llm/store';

// The security report on the phone (10.11.2026, docs/AUDIT.md "the security report"): when this
// phone is the master, the brain tab answers "is my cluster safe?" with one verdict, green all
// clear, red look at this, grey not checked yet, and under it every paired device's checks. The
// computer does the same in god's eye's trust branch (node/src/godseye/branches/trust.ts); the
// checks, the rules and the words are the same.
//
// Every device answers GET /trust on its api channel (docs/GATE.md). The phone asks through the
// same api tunnel apart mode and the bench use (trustStore.ts), and the cryptography runs natively
// (TrustVerify.kt: the certificate against the pin, the key id, the CN, every ledger line's chain
// and signature), since Hermes has no Ed25519 or P-256. This file is the rest, pure: what is kept
// per device between looks (a note: the last line verified, how many, since when, a ledger fault),
// and the verdict. It takes nothing on faith: what a device says about itself without proof (its
// own "my ledger is ok", where its key lives, its refusal counts) is its word, and where its key
// lives never colours the verdict. No prompts, no answers: only who connected and whether they
// were let in.
//
// One difference from the computer: the computer keeps a window of the lines received and asks
// from the last one received (`upTo`); the phone verifies as it receives, so it asks from the last
// line verified here and keeps only that line's hash.

export const ROUNDS = 5;        // asks per look while the device says there is more
export const GUESS_LIMIT = 5;   // wrong codes in a day that turn the refused check red
const GUESSES = new Set(['wrong pin', 'wrong secret', 'bad proof']);
export const OLD_WORKER = 'old'; // an older kula without GET /trust

/** One GET /trust answer, taken apart and bounded (the device's word, nothing verified yet). */
export type TrustAnswer = {
  id: string | null; alg: string | null; pub: string | null; store: string | null; cert: string | null;
  v1: boolean | null; self: string | null; found: boolean | null; more: boolean; lines: string[];
  rejectsDay: Record<string, number>;
};

const str = (v: unknown, max = 4096): string | null => (typeof v === 'string' && v.length <= max ? v : null);

export function parseAnswer(b: unknown): TrustAnswer {
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, any>;
  const lg = (o.ledger && typeof o.ledger === 'object' ? o.ledger : {}) as Record<string, any>;
  const lines = Array.isArray(lg.lines) ? lg.lines.filter((l: unknown): l is string => typeof l === 'string' && l.length <= 64 * 1024).slice(0, 200) : [];
  const day: Record<string, number> = {};
  const rd = o.rejects?.day;
  if (rd && typeof rd === 'object') for (const [w, n] of Object.entries(rd)) if (typeof n === 'number' && Number.isFinite(n)) day[String(w).slice(0, 40)] = n;
  return {
    id: str(o.id, 64), alg: str(o.key?.alg, 16), pub: str(o.key?.pub), store: str(o.key?.store, 16), cert: str(o.cert, 8192),
    v1: typeof o.gate?.v1 === 'boolean' ? o.gate.v1 : null, self: str(lg.self, 16),
    found: typeof lg.found === 'boolean' ? lg.found : null, more: lg.more === true, lines, rejectsDay: day,
  };
}

export type FaultWhy = 'restart' | 'chain' | 'sig' | 'nosig' | 'json' | 'key';
/** A ledger fault: red until the person says they know why. line: sha256 of the line that failed, to step past it then. */
export type Fault = { why: FaultWhy; at: number; line: string | null };

/** What the phone keeps per device between looks (and app restarts). */
export type TrustNote = {
  at: number;                    // the last look that got an answer (or the failed first one)
  answered: boolean;             // false: never answered, or an older kula without the route
  error: string | null;          // why it was not checked: OLD_WORKER, or what failed
  // from the last answer: the device's word and what TrustVerify.kt found
  store: string | null; v1: boolean | null; self: string | null; rejectsDay: Record<string, number>;
  hasCert: boolean; certPinned: boolean | null; cnMatches: boolean | null; keyIdMatches: boolean | null; keyId: string | null;
  // its ledger as verified here
  head: string | null;           // sha256 of the last line verified: where the next look starts
  verified: number;              // lines verified here since `since`
  since: number;                 // when the first of them was verified
  fault: Fault | null;
};

export const freshNote = (): TrustNote => ({
  at: 0, answered: false, error: null, store: null, v1: null, self: null, rejectsDay: {},
  hasCert: false, certPinned: null, cnMatches: null, keyIdMatches: null, keyId: null,
  head: null, verified: 0, since: 0, fault: null,
});

const FAULTS: readonly string[] = ['chain', 'sig', 'nosig', 'json', 'key'];

/**
 * One answer folded into what was kept. [askedSince]: the line the look asked from (the last
 * one verified), null for a first look; [v] is TrustVerify.kt's result over the answer's lines,
 * checked against [askedSince] when the device found it. A device that no longer has that line
 * started its ledger over (cleared, or rewritten): red until the person says they know, and the
 * new chain is followed from its first line here.
 */
export function takeIn(was: TrustNote | null, a: TrustAnswer, v: TrustVerified, askedSince: string | null, now: number): TrustNote {
  const n: TrustNote = { ...(was ?? freshNote()) };
  n.at = now; n.answered = true; n.error = null;
  n.store = a.store; n.v1 = a.v1; n.self = a.self; n.rejectsDay = a.rejectsDay;
  n.hasCert = !!(a.cert && a.pub && a.id);
  n.certPinned = v.certPinned; n.cnMatches = v.cnMatches; n.keyIdMatches = v.keyIdMatches; n.keyId = v.keyId;
  if (askedSince && a.found === false) {
    n.fault = { why: 'restart', at: now, line: null };
    n.head = null; n.verified = 0; n.since = 0;
  }
  if (v.verified > 0 && v.lastHash) {
    if (!n.since) n.since = now;
    n.verified += v.verified;
    n.head = v.lastHash;
  }
  if (v.problem) {
    const why = (FAULTS.includes(v.problem) ? v.problem : 'sig') as FaultWhy;
    // the same line failing again at the next look is the same fault, not a new one
    if (!n.fault || n.fault.line !== v.problemLine) n.fault = { why, at: now, line: v.problemLine };
  }
  return n;
}

/** A look that got no answer: what was known stays; a device never answered says why. */
export function failed(was: TrustNote | null, why: string, now: number): TrustNote {
  if (why === OLD_WORKER) return { ...(was ?? freshNote()), at: now, answered: false, error: OLD_WORKER };
  if (was?.answered) return was;
  return { ...(was ?? freshNote()), at: now, answered: false, error: why };
}

/** "I know why (I cleared it)": the fault goes, and the chain is followed from the line that failed. */
export function accept(n: TrustNote): TrustNote {
  if (!n.fault) return n;
  return { ...n, head: n.fault.line ?? n.head, fault: null };
}

// ---- one look ---------------------------------------------------------------------------

export type TrustIO = {
  /** the local port of an api tunnel to the device */
  tunnel: (p: Peer) => Promise<number>;
  get: (url: string) => Promise<{ status: number; body: unknown }>;
  verify: (pinnedFp: string | null, cert: string | null, id: string | null, alg: string | null, pub: string | null, lines: string[], expectPrev: string | null) => Promise<TrustVerified>;
  now: () => number;
};

/** Asks one device for what is new since the last line verified, and checks it. Never throws. */
export async function look(peer: Peer, was: TrustNote | null, io: TrustIO): Promise<TrustNote> {
  let note = was;
  try {
    const port = await io.tunnel(peer);
    for (let round = 0; round < ROUNDS; round++) {
      const since = note?.head ?? null;
      const r = await io.get(`http://127.0.0.1:${port}/trust${since ? `?since=${since}` : ''}`);
      if (r.status === 404) return failed(note, OLD_WORKER, io.now());
      if (r.status !== 200) throw new Error(`it answered ${r.status}`);
      const a = parseAnswer(r.body);
      const expect = since && a.found === true ? since : null;
      const v = await io.verify(peer.fp || null, a.cert, a.id, a.alg, a.pub, a.lines, expect);
      note = takeIn(note, a, v, since, io.now());
      if (!a.more || v.problem || !v.verified) break;
    }
    return note ?? failed(null, 'no answer', io.now());
  } catch (e) {
    return failed(note, (e as Error)?.message || 'no answer', io.now());
  }
}

// ---- the verdict ------------------------------------------------------------------------

export type Verdict = 'ok' | 'bad' | 'unknown';
export type CheckKey = 'pinned' | 'encrypted' | 'identity' | 'refused' | 'ledger' | 'key';
/** One check: [text] is an i18n key (trust.*); with [n] it is a count key (text.one / text.other). */
export type TrustCheck = { k: CheckKey; ok: boolean | null; text: string; vars?: Record<string, string | number>; n?: number };
export type DeviceReport = { id: string; name: string; verdict: Verdict; checks: TrustCheck[]; refused: number; accept: boolean };

const two = (n: number) => String(n).padStart(2, '0');
const hhmm = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };

function ledgerCheck(n: TrustNote): TrustCheck {
  const k = 'ledger';
  if (n.fault) return n.fault.why === 'restart'
    ? { k, ok: false, text: 'trust.ledger.restart', vars: { at: hhmm(n.fault.at) } }
    : { k, ok: false, text: `trust.ledger.${n.fault.why}` };
  if (n.self === 'broken') return { k, ok: false, text: 'trust.ledger.self' };
  if (n.head) return { k, ok: true, text: 'trust.ledger.ok', n: n.verified, vars: { since: day(n.since) } };
  return { k, ok: null, text: 'trust.ledger.none' };
}

function identityCheck(n: TrustNote): TrustCheck {
  const k = 'identity';
  if (!n.hasCert || !n.keyId) return { k, ok: null, text: 'trust.id.none' };
  if (n.certPinned === null) return { k, ok: null, text: 'trust.id.nopin' };
  if (!n.certPinned) return { k, ok: false, text: 'trust.id.notPinned' };
  if (n.keyIdMatches !== true) return { k, ok: false, text: 'trust.id.key' };
  if (n.cnMatches !== true) return { k, ok: false, text: 'trust.id.cn' };
  return { k, ok: true, text: 'trust.id.ok', vars: { key: n.keyId.slice(0, 8) } };
}

function refusedCheck(n: TrustNote): TrustCheck {
  const k = 'refused';
  const refused = Object.entries(n.rejectsDay).sort((a, b) => b[1] - a[1]);
  const guesses = refused.filter(([w]) => GUESSES.has(w)).reduce((a, [, c]) => a + c, 0);
  const replays = n.rejectsDay.replay ?? 0;
  if (replays > 0) return { k, ok: false, text: 'trust.refused.replay', n: replays };
  if (guesses >= GUESS_LIMIT) return { k, ok: false, text: 'trust.refused.guess', vars: { n: guesses } };
  return refused.length
    ? { k, ok: true, text: 'trust.refused.some', vars: { words: refused.map(([w, c]) => `${w} ×${c}`).join(', ') } }
    : { k, ok: true, text: 'trust.refused.none' };
}

/** A paired device's checks and its verdict. Its key's place is shown, never counted. */
export function deviceReport(peer: Pick<Peer, 'id' | 'name' | 'fp' | 'relay'>, note: TrustNote | null): DeviceReport {
  const checks: TrustCheck[] = [];
  const tls = !!(peer.fp || peer.relay);
  checks.push(peer.fp
    ? { k: 'pinned', ok: true, text: 'trust.pinned.ok' }
    : peer.relay
      ? { k: 'pinned', ok: null, text: 'trust.pinned.learning' }
      : { k: 'pinned', ok: false, text: 'trust.pinned.old' });
  checks.push(!tls
    ? { k: 'encrypted', ok: false, text: 'trust.enc.plain' }
    : note?.answered && note.v1 === true
      ? { k: 'encrypted', ok: false, text: 'trust.enc.v1' }
      : { k: 'encrypted', ok: true, text: 'trust.enc.ok' });
  const answered = !!note?.answered;
  if (!answered) {
    checks.push(note?.error === OLD_WORKER
      ? { k: 'identity', ok: null, text: 'trust.not.old' }
      : note?.error
        ? { k: 'identity', ok: null, text: 'trust.not.error', vars: { why: note.error } }
        : { k: 'identity', ok: null, text: 'trust.not.yet' });
  } else {
    checks.push(identityCheck(note!), refusedCheck(note!), ledgerCheck(note!));
    checks.push(note!.store === 'keystore'
      ? { k: 'key', ok: true, text: 'trust.key.keystore' }
      : { k: 'key', ok: null, text: note!.store === 'file' ? 'trust.key.file' : 'trust.key.unknown' });
  }
  const counted = checks.filter((c) => c.k !== 'key');
  const verdict: Verdict = counted.some((c) => c.ok === false) ? 'bad' : !answered || counted.some((c) => c.ok === null && c.k !== 'ledger') ? 'unknown' : 'ok';
  const refused = answered ? Object.values(note!.rejectsDay).reduce((a, c) => a + c, 0) : 0;
  return { id: peer.id, name: peer.name.toLowerCase(), verdict, checks, refused, accept: !!note?.fault };
}

/** This phone's own ledger: the chain the brain tab already checks (src/llm/audit.ts verifyChain). */
export function hostCheck(chain: { ok: boolean; lines: number } | null): TrustCheck {
  if (!chain || !chain.lines) return { k: 'ledger', ok: null, text: 'trust.host.none' };
  return chain.ok ? { k: 'ledger', ok: true, text: 'trust.host.ok', n: chain.lines } : { k: 'ledger', ok: false, text: 'trust.host.broken' };
}

export type Headline = { key: string; vars?: Record<string, string | number>; n?: number; first?: { name: string; check: TrustCheck } };
export type ClusterReport = { verdict: Verdict; headline: Headline; devices: DeviceReport[]; host: TrustCheck };

/** One verdict for the cluster: anything red is red; any device not checked yet is grey; else all clear. */
export function clusterReport(devices: DeviceReport[], host: TrustCheck): ClusterReport {
  const bad = devices.filter((d) => d.verdict === 'bad');
  const hostBad = host.ok === false;
  const waiting = devices.filter((d) => d.verdict === 'unknown');
  let verdict: Verdict;
  let headline: Headline;
  if (bad.length || hostBad) {
    verdict = 'bad';
    const first = bad[0] ? { name: bad[0].name, check: bad[0].checks.find((c) => c.ok === false)! } : { name: '', check: host };
    const n = bad.length + (hostBad ? 1 : 0);
    headline = n > 1 ? { key: 'trust.head.many', n, first } : { key: 'trust.head.one', first };
  } else if (!devices.length) {
    verdict = 'unknown'; headline = { key: 'trust.head.none' };
  } else if (waiting.length) {
    verdict = 'unknown'; headline = { key: 'trust.head.waiting', vars: { names: waiting.map((d) => d.name).join(', ') } };
  } else {
    verdict = 'ok'; headline = { key: 'trust.head.ok', n: devices.length };
  }
  return { verdict, headline, devices, host };
}

// ---- words ------------------------------------------------------------------------------

type Tx = (key: string, fallback?: string, vars?: Record<string, string | number>) => string;
const counted = (key: string, n: number | undefined, vars: Record<string, string | number> | undefined, tx: Tx) =>
  n == null ? tx(key, undefined, vars) : tx(`${key}.${n === 1 ? 'one' : 'other'}`, undefined, { ...vars, n });

/** A check in the reader's language. */
export const sayCheck = (c: TrustCheck, tx: Tx): string => counted(c.text, c.n, c.vars, tx);

/** The headline in the reader's language; [self] names this phone when its own ledger is the first thing to look at. */
export function sayHeadline(h: Headline, tx: Tx, self: string): string {
  if (h.first) {
    const first = `${h.first.name || self}: ${sayCheck(h.first.check, tx)}`;
    return h.key === 'trust.head.many' ? tx(h.key, undefined, { n: h.n ?? 0, first }) : first;
  }
  return counted(h.key, h.n, h.vars, tx);
}

/**
 * This phone's row title: its passport name with "this phone" beside it, or "this phone" alone
 * when the name is missing or is those very words (the old brain row said "this phone · this phone").
 */
export function selfTitle(device: string | null | undefined, thisWord: string): { name: string; tag: string | null } {
  const name = (device ?? '').trim().toLowerCase();
  const word = thisWord.toLowerCase();
  if (!name || name === word || name === 'this phone') return { name: word, tag: null };
  return { name, tag: word };
}
