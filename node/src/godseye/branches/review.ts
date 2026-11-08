// 11 request review: it looks at each night project before it runs, and at the work loaded now,
// and says what it thinks: ok, or look again with the reasons in plain words. Simple rules only:
//   - personal data in the request (an e-mail, a phone number, an iban, a card number, something
//     that looks like a password, an api key or a token);
//   - where it would go: a device reached over a relay, or one without a pinned certificate;
//   - sanity: a start already past while it still waits, an end before the start, an empty or very
//     short request, a model this computer does not know, a model too big for the chosen devices.
// It never blocks, edits or delays a job; it only says. It never keeps or emits the request text:
// its verdicts are reason kinds, held in memory only (nothing goes into its notes file), and a
// title is shown with anything that looks personal masked out.
import type { Branch, BranchCtx, EyeDevice, EyeModel, EyeProject, Snapshot } from '../types.js';
import { hhmm, pct } from './util.js';

const PAST_GRACE_MS = 2 * 60_000;  // the runner starts a job at its time; give it a moment
const SHORT_REQUEST = 12;          // characters: shorter than this is hardly a night's work
const LINES_MAX = 14;

// ---- personal data: each finder returns the spans it found

type Span = [number, number];
type Finder = (text: string) => Span[];

const all = (re: RegExp, text: string, keep: (m: string) => boolean = () => true): Span[] => {
  const out: Span[] = [];
  for (const m of text.matchAll(re)) if (keep(m[0])) out.push([m.index!, m.index! + m[0].length]);
  return out;
};
const digits = (s: string) => s.replace(/\D/g, '');

function luhn(num: string): boolean {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanOk(raw: string): boolean {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rest = (rest * 10 + Number(c)) % 97;
  }
  return rest === 1;
}

const SECRETS: RegExp[] = [
  /(?<![\p{L}\d])(?:password|passwd|pwd|passcode|passphrase|parola|şifre|sifre)\s*[:=]\s*\S+/giu,
  /\b(?:api[ _-]?key|apikey|access[ _-]?key|secret|token|auth)\s*[:=]\s*\S{8,}/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_]|proj[-_]|ant[-_])?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,   // a jwt
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Fa-f0-9]{32,}\b/g,                                          // a long hex key
];
// a long run that mixes upper, lower and digits looks like a key, not a word
const RANDOMISH = /[A-Za-z0-9+/_-]{28,}/g;
const randomish = (m: string) => /[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) && !/^[a-z]+(?:[-_][a-z]+)+$/i.test(m);

export const PERSONAL: { kind: string; words: string; find: Finder }[] = [
  { kind: 'email', words: 'an e-mail address', find: (t) => all(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, t) },
  { kind: 'iban', words: 'an iban', find: (t) => all(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gi, t, ibanOk) },
  { kind: 'card', words: 'a card number', find: (t) => all(/\b\d(?:[ -]?\d){12,18}\b/g, t, (m) => luhn(digits(m))) },
  { kind: 'phone', words: 'a phone number', find: (t) => all(/(?:\+|\b00|\b0)\d[\d ().-]{6,}\d\b/g, t, (m) => { const n = digits(m).length; return n >= 10 && n <= 15; }) },
  { kind: 'secret', words: 'something like a password, key or token', find: (t) => [...SECRETS.flatMap((re) => all(re, t)), ...all(RANDOMISH, t, randomish)] },
];

/** The kinds of personal data found in a text, in a fixed order; a span counts once, for the first kind that claims it. */
export function personalKinds(text: string): string[] {
  const taken: Span[] = [];
  const kinds: string[] = [];
  for (const p of PERSONAL) {
    const spans = p.find(text).filter(([a, b]) => !taken.some(([x, y]) => a < y && x < b));
    if (spans.length) { kinds.push(p.kind); taken.push(...spans); }
  }
  return kinds;
}

/** The text with everything that looks personal replaced by "…". */
export function masked(text: string): string {
  const spans = PERSONAL.flatMap((p) => p.find(text)).sort((a, b) => a[0] - b[0]);
  let out = '', at = 0;
  for (const [a, b] of spans) {
    if (b <= at) continue;
    out += text.slice(at, Math.max(a, at)) + (a >= at ? '…' : '');
    at = b;
  }
  return out + text.slice(at);
}

// ---- the reasons, as kinds (kept) and words (shown)

const WORDS: Record<string, string> = {
  relay: 'it would go over a relay',
  'no-tls': 'it would go to a device without a pinned certificate',
  'gone-device': 'a chosen device is no longer paired',
  'past-start': 'its start has passed and it still waits',
  'end-before-start': 'it ends before it starts',
  'empty-request': 'the request is empty',
  'short-request': 'the request is very short',
  'unknown-model': 'this computer does not know its model',
  'too-big': 'the model does not fit the chosen devices',
};
const personalWord = (kind: string) => PERSONAL.find((p) => p.kind === kind)?.words ?? kind;
export const reasonWords = (reasons: string[]): string[] => {
  const pers = reasons.filter((r) => r.startsWith('personal:')).map((r) => personalWord(r.slice(9)));
  const rest = reasons.filter((r) => !r.startsWith('personal:')).map((r) => WORDS[r] ?? r);
  return [...(pers.length ? [`contains personal data (${pers.join(', ')})`] : []), ...rest];
};

export interface Verdict { ok: boolean; reasons: string[] }

const FINISHED = new Set(['done', 'failed', 'cancelled', 'missed']);

/** Where a set of device ids would send the work: relay and unpinned devices are flagged. */
function whereReasons(devs: (EyeDevice | undefined)[]): string[] {
  const out: string[] = [];
  if (devs.some((d) => !d)) out.push('gone-device');
  if (devs.some((d) => d?.via === 'relay')) out.push('relay');
  if (devs.some((d) => d && d.via !== 'relay' && !d.tls)) out.push('no-tls');
  return out;
}

/** The devices a project would use: the chosen ones; with none chosen in "apart", every paired one; "here" uses only this computer. */
function projectDevices(p: EyeProject, s: Snapshot): (EyeDevice | undefined)[] {
  if (p.mode === 'here') return [];
  if (!p.peers.length) return p.mode === 'apart' ? s.devices : [];
  return p.peers.map((id) => s.devices.find((d) => d.id === id));
}

function fits(m: EyeModel, p: EyeProject, devs: EyeDevice[], s: Snapshot): boolean | null {
  const host = s.host.freeMb;
  if (p.mode === 'here') return host == null ? null : host >= m.needMb;
  const rams = devs.map((d) => d.ramMb).filter((r): r is number => r != null);
  if (p.mode === 'split') {
    if (rams.length < devs.length || host == null) return null;  // not all known: no word
    return rams.reduce((a, b) => a + b, 0) + host >= m.needMb;
  }
  // phone / apart: a whole copy has to fit at least one of them (apart may also run on this computer)
  const sizes = p.mode === 'apart' && host != null ? [...rams, host] : rams;
  if (!sizes.length) return null;
  return sizes.some((r) => r >= m.needMb);
}

export function reviewProject(p: EyeProject, s: Snapshot): Verdict {
  const reasons: string[] = [];
  const req = String(p.request ?? '').trim();
  for (const k of personalKinds(req)) reasons.push(`personal:${k}`);
  const devs = projectDevices(p, s);
  reasons.push(...whereReasons(devs));
  if (p.state === 'waiting' && p.start < s.at - PAST_GRACE_MS) reasons.push('past-start');
  if (p.end <= p.start) reasons.push('end-before-start');
  if (!req) reasons.push('empty-request');
  else if (req.length < SHORT_REQUEST) reasons.push('short-request');
  const m = s.models.find((x) => x.id === p.model);
  if (!m) reasons.push('unknown-model');
  else if (fits(m, p, devs.filter((d): d is EyeDevice => !!d), s) === false) reasons.push('too-big');
  return { ok: reasons.length === 0, reasons };
}

function reviewLoaded(s: Snapshot): Verdict | null {
  const l = s.work.loaded;
  if (!l) return null;
  const remote = [...l.devices, ...(l.parts ?? [])].filter((d) => !d.local).map((d) => s.devices.find((x) => x.id === d.id));
  const reasons = whereReasons(remote);
  return { ok: reasons.length === 0, reasons };
}

const key = (v: Verdict) => (v.ok ? 'ok' : v.reasons.join(','));
const say = (v: Verdict) => (v.ok ? 'ok' : `look again: ${reasonWords(v.reasons).join('; ')}`);
const titleOf = (p: EyeProject) => `“${masked(String(p.title ?? '')).slice(0, 60) || 'untitled'}”`;

export function create(ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  // project id → its verdict, in memory only: never written to the notes file
  const verdicts = new Map<string, Verdict & { state: string }>();
  let loadedKey: string | null = null;
  let loaded: Verdict | null = null;

  return {
    id: 'review',
    observe(now) {
      snap = now;
      const seen = new Set<string>();
      for (const p of now.projects) {
        seen.add(p.id);
        const old = verdicts.get(p.id);
        // a finished project keeps the verdict it had while it could still run
        if (FINISHED.has(p.state)) {
          if (old) old.state = p.state;
          else verdicts.set(p.id, { ...reviewProject(p, now), state: p.state });
          continue;
        }
        const v = reviewProject(p, now);
        if (!old || key(old) !== key(v)) ctx.emit(`${titleOf(p)} (${p.state}, ${hhmm(p.start)}): ${say(v)}`);
        verdicts.set(p.id, { ...v, state: p.state });
      }
      for (const id of [...verdicts.keys()]) if (!seen.has(id)) verdicts.delete(id);

      loaded = reviewLoaded(now);
      const lk = loaded && now.work.loaded ? `${now.work.loaded.model.id}|${key(loaded)}` : null;
      if (lk && lk !== loadedKey && loaded && !loaded.ok) ctx.emit(`the work loaded now (${now.work.loaded!.model.name}): ${say(loaded)}`);
      loadedKey = lk;
    },
    view() {
      const projects = snap?.projects ?? [];
      const order = (st: string) => (st === 'waiting' ? 0 : st === 'running' ? 1 : 2);
      const sorted = [...projects].sort((a, b) => order(a.state) - order(b.state) || (order(a.state) < 2 ? a.start - b.start : b.start - a.start));
      const waiting = sorted.filter((p) => p.state === 'waiting');
      const waitingOk = waiting.filter((p) => verdicts.get(p.id)?.ok).length;
      const open = sorted.filter((p) => !FINISHED.has(p.state));
      const again = open.filter((p) => verdicts.get(p.id) && !verdicts.get(p.id)!.ok).length;

      const lines: string[] = [];
      if (snap?.work.loaded && loaded) lines.push(`loaded now · ${snap.work.loaded.model.name} (${snap.work.loaded.mode}) · ${say(loaded)}`);
      for (const p of sorted) {
        const v = verdicts.get(p.id);
        if (!v) continue;
        lines.push(`${titleOf(p)} · ${p.state} · ${hhmm(p.start)}–${hhmm(p.end)} · ${say(v)}`);
      }

      const stat = waiting.length || again
        ? `${waiting.length} waiting · ${again ? `${again} to look at again` : 'all ok'}`
        : projects.length ? 'nothing waiting' : 'no night project';
      return {
        built: true,
        stat,
        gauge: waiting.length ? pct(waitingOk, waiting.length) : null,
        rows: [
          ['waiting', String(waiting.length)],
          ['running', String(sorted.filter((p) => p.state === 'running').length)],
          ['to look at again', String(again)],
          ['looked at', String(verdicts.size)],
        ],
        lines: lines.slice(0, LINES_MAX),
        note: 'it only says what it thinks; it never stops or changes a job. it keeps no request text, only its verdicts, in memory.',
      };
    },
  };
}
