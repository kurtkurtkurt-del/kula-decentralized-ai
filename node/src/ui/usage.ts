// What kula was used for, counted on this computer: every answer the engine streams adds one
// line to the tallies (tokens, time to first token, generation time) under its model, the
// device that answered, the mode, the kind of use and the day. Kept in ~/.kula-node/usage.json
// (600), small and bounded: 90 days, at most 100 models and 100 devices. Never any prompt or
// answer text: only counts, names of models and devices, and dates.
//
// Answer tokens are what the device reported (llama-server's own count where it gives one,
// else the pieces that came back). Prompt tokens are reported by nothing on kula's wire yet
// (the worker's done line carries the answer's count only), so they are estimated from the
// text sent, about 4 characters a token, and marked as estimated; a device that one day
// reports `promptTokens` in its done line is counted as reported.
import fs from 'node:fs';
import path from 'node:path';
import { home } from '../paths.js';

export type Use = 'chat' | 'api' | 'project' | 'guest';
export const USES: Use[] = ['chat', 'api', 'project', 'guest'];
export const USE_MODES = ['phone', 'apart', 'split', 'here'] as const;

export const DAYS_KEPT = 90;
export const NAMES_KEPT = 100;
const NAME_MAX = 80;

export interface Tally {
  answers: number;      // answers that ended (stopped ones too)
  failed: number;       // answers that ended in an error
  stopped: number;      // of the answers, how many were stopped
  prompt: number;       // prompt tokens (reported + estimated)
  estimated: number;    // of the answers, how many had their prompt tokens estimated
  completion: number;   // answer tokens
  genMs: number;        // time spent generating (first token to the end), for tok/s
  firstMs: number;      // sum of time to first token, over firstN answers
  firstN: number;
}
export type DayTally = Tally & { uses: Record<Use, number> };   // tokens per kind of use

interface File {
  v: 1;
  since: number;
  total: Tally;
  days: Record<string, DayTally>;
  models: Record<string, Tally>;
  devices: Record<string, Tally>;
  modes: Record<string, Tally>;
  uses: Record<string, Tally>;
}

export interface UsageRecord {
  model: string;
  device: string;
  mode: string;
  use: Use;
  promptChars: number;          // the length of what was sent, for the estimate
  promptTokens?: number;        // when the device reported it
  completion: number;
  ms: number;
  firstMs: number;
  stopped?: boolean;
  failed?: boolean;
}

export interface UsageRow { name: string; answers: number; failed: number; stopped: number; prompt: number; completion: number; tokens: number; estimated: boolean; tps: number | null; firstMs: number | null }
export interface UsageDay { day: string; answers: number; prompt: number; completion: number; tokens: number; uses: Record<Use, number> }
export interface UsageView {
  since: number | null;
  file: string;
  total: UsageRow;
  days: UsageDay[];             // the last `n` days, oldest first, empty days as zeros
  models: UsageRow[];           // most tokens first
  devices: UsageRow[];
  modes: UsageRow[];
  uses: UsageRow[];             // always the four kinds, in USES' order
}

const zero = (): Tally => ({ answers: 0, failed: 0, stopped: 0, prompt: 0, estimated: 0, completion: 0, genMs: 0, firstMs: 0, firstN: 0 });
const zeroUses = (): Record<Use, number> => ({ chat: 0, api: 0, project: 0, guest: 0 });
const fresh = (now: number): File => ({ v: 1, since: now, total: zero(), days: {}, models: {}, devices: {}, modes: {}, uses: {} });

export const estimateTokens = (chars: number): number => (chars > 0 ? Math.ceil(chars / 4) : 0);

// a day on this computer's clock, yyyy-mm-dd
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const nat = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const label = (s: unknown, fallback: string): string => { const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX); return t || fallback; };

function cleanTally(o: any): Tally {
  const t = zero();
  if (o && typeof o === 'object') for (const k of Object.keys(t) as (keyof Tally)[]) t[k] = nat(o[k]);
  return t;
}
function cleanMap(o: any, limit: number): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of Object.keys(o).slice(0, limit)) out[label(k, '?')] = cleanTally(o[k]);
  return out;
}

// a file from disk, checked field by field: anything odd counts as nothing
export function parseUsage(text: string, now: number): File {
  let o: any;
  try { o = JSON.parse(text); } catch { return fresh(now); }
  if (!o || typeof o !== 'object' || o.v !== 1) return fresh(now);
  const f = fresh(nat(o.since) || now);
  f.total = cleanTally(o.total);
  if (o.days && typeof o.days === 'object') {
    for (const k of Object.keys(o.days).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-DAYS_KEPT)) {
      const uses = zeroUses();
      for (const u of USES) uses[u] = nat(o.days[k]?.uses?.[u]);
      f.days[k] = { ...cleanTally(o.days[k]), uses };
    }
  }
  f.models = cleanMap(o.models, NAMES_KEPT);
  f.devices = cleanMap(o.devices, NAMES_KEPT);
  f.modes = Object.fromEntries(Object.entries(cleanMap(o.modes, 10)).filter(([k]) => (USE_MODES as readonly string[]).includes(k)));
  f.uses = Object.fromEntries(Object.entries(cleanMap(o.uses, 10)).filter(([k]) => (USES as string[]).includes(k)));
  return f;
}

function add(t: Tally, r: UsageRecord, prompt: number, estimated: boolean) {
  if (r.failed) { t.failed++; return; }
  t.answers++;
  if (r.stopped) t.stopped++;
  t.prompt += prompt;
  if (estimated) t.estimated++;
  t.completion += nat(r.completion);
  if (nat(r.completion) && nat(r.firstMs)) {
    t.genMs += Math.max(1, nat(r.ms) - nat(r.firstMs));
  }
  if (nat(r.firstMs)) { t.firstMs += nat(r.firstMs); t.firstN++; }
}

// at most `limit` names: the one with the fewest tokens goes first (never the one just used)
function bump(map: Record<string, Tally>, key: string, limit: number) {
  if (map[key]) return map[key];
  const keys = Object.keys(map);
  if (keys.length >= limit) {
    keys.sort((a, b) => (map[a].prompt + map[a].completion) - (map[b].prompt + map[b].completion));
    for (const k of keys.slice(0, keys.length - limit + 1)) delete map[k];
  }
  return (map[key] = zero());
}

export function row(name: string, t: Tally): UsageRow {
  return {
    name, answers: t.answers, failed: t.failed, stopped: t.stopped, prompt: t.prompt, completion: t.completion, tokens: t.prompt + t.completion,
    estimated: t.estimated > 0,
    tps: t.genMs > 0 ? Math.round((t.completion / t.genMs) * 10000) / 10 : null,
    firstMs: t.firstN > 0 ? Math.round(t.firstMs / t.firstN) : null,
  };
}

export class Usage {
  private data: File | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: { file?: string; now?: () => number; log?: (s: string) => void } = {}) {
    this.now = opts.now ?? Date.now;
  }

  // home() is asked only when the file is first needed, so an engine made in a test that sets
  // KULA_NODE_HOME later still writes there
  file(): string { return this.opts.file ?? path.join(home(), 'usage.json'); }

  private get(): File {
    if (this.data) return this.data;
    let text = '';
    try { text = fs.readFileSync(this.file(), 'utf8'); } catch {}
    this.data = text ? parseUsage(text, this.now()) : fresh(this.now());
    return this.data;
  }

  private save(): void {
    const f = this.file();
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.get()), { mode: 0o600 });
      fs.renameSync(tmp, f);
      try { fs.chmodSync(f, 0o600); } catch {}
    } catch (e) { this.opts.log?.(`usage: could not save: ${(e as Error).message}`); }
  }

  record(r: UsageRecord): void {
    const d = this.get();
    const reported = Number.isFinite(Number(r.promptTokens)) && Number(r.promptTokens) > 0;
    const prompt = reported ? nat(r.promptTokens) : estimateTokens(nat(r.promptChars));
    const estimated = !reported && prompt > 0;
    const use: Use = USES.includes(r.use) ? r.use : 'chat';
    const mode = (USE_MODES as readonly string[]).includes(r.mode) ? r.mode : 'here';
    if (d.total.answers === 0 && d.total.failed === 0) d.since = this.now();
    const day = dayKey(this.now());
    if (!d.days[day]) {
      d.days[day] = { ...zero(), uses: zeroUses() };
      const keys = Object.keys(d.days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - DAYS_KEPT))) delete d.days[k];
    }
    add(d.total, r, prompt, estimated);
    add(d.days[day], r, prompt, estimated);
    if (!r.failed) d.days[day].uses[use] += prompt + nat(r.completion);
    add(bump(d.models, label(r.model, 'unknown model'), NAMES_KEPT), r, prompt, estimated);
    add(bump(d.devices, label(r.device, 'unknown device'), NAMES_KEPT), r, prompt, estimated);
    add(bump(d.modes, mode, 10), r, prompt, estimated);
    add(bump(d.uses, use, 10), r, prompt, estimated);
    this.save();
  }

  view(n = 30): UsageView {
    const d = this.get();
    const sorted = (m: Record<string, Tally>) => Object.entries(m).map(([k, t]) => row(k, t)).sort((a, b) => b.tokens - a.tokens || b.answers - a.answers);
    const days: UsageDay[] = [];
    const today = new Date(this.now());
    for (let i = n - 1; i >= 0; i--) {
      const k = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12).getTime());
      const t = d.days[k];
      days.push(t ? { day: k, answers: t.answers, prompt: t.prompt, completion: t.completion, tokens: t.prompt + t.completion, uses: { ...t.uses } } : { day: k, answers: 0, prompt: 0, completion: 0, tokens: 0, uses: zeroUses() });
    }
    const empty = d.total.answers === 0 && d.total.failed === 0;
    return {
      since: empty ? null : d.since,
      file: this.file(),
      total: row('all', d.total),
      days,
      models: sorted(d.models),
      devices: sorted(d.devices),
      modes: sorted(d.modes),
      uses: USES.map((u) => row(u, d.uses[u] ?? zero())),
    };
  }

  reset(): void {
    this.data = fresh(this.now());
    try { fs.rmSync(this.file(), { force: true }); } catch {}
  }
}
