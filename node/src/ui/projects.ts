// Night projects on the chat page (6.11.2026). You plan one: what it should do, from when until
// when, which model, how it runs (on the phone, apart, split, here) and on which devices. It
// gets its own chat, which stays closed for new messages until it has run. At the start time
// this computer reaches the devices (a phone on a plugged-in cable through it, else over this
// wi-fi, found again on mdns if its address changed; 8.11.2026), says in the chat which way each
// was reached, loads the model on them, splits the job
// into a few parts, works through them until the end time, and writes a morning report into
// that chat. Everything stays here: ~/.kula-node/projects.json (600) and the chat's own file.
//
// The computer has to be awake for it: while a project waits or runs, `caffeinate -i` keeps
// macOS from idle sleep (on power, lid open). A start that the computer slept through is said
// in the chat as missed, not run hours late.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { home } from '../paths.js';
import type { ChatStore, ChatMessage } from './store.js';
import { newId } from './store.js';

export type ProjectMode = 'phone' | 'apart' | 'split' | 'here';
export type ProjectState = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'missed';
export interface Project {
  id: string;
  chatId: string;
  title: string;
  request: string;
  start: number;            // ms, this computer's clock
  end: number;
  model: string;            // catalog id, or local:<file>
  mode: ProjectMode;
  peers: string[];
  ctx: number;
  state: ProjectState;
  created: number;
  startedAt?: number;
  endedAt?: number;
  parts?: number;           // how many parts the plan has
  done?: number;            // how many are answered
  line?: string;            // what it does right now, in a few words
  error?: string;
}

// what the runner needs from the engine (the real one, or a fake in the tests)
export interface ProjectEngine {
  load(req: { model?: unknown; mode?: unknown; peers?: unknown; ctx?: unknown; all?: unknown }, emit: (e: unknown) => void): Promise<unknown>;
  chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], onToken: (t: string) => void, o?: { maxTokens?: number; temperature?: number; signal?: AbortSignal; use?: 'project' }): Promise<{ text: string; device: string; tokens: number; tps: number; ms: number; firstMs: number }>;
  unload(quiet?: boolean): Promise<void>;
  peers(): { id: string; name: string; cable: { serial: string } | null }[];
  useCable?(serial: unknown): unknown;
  cableSettled?(serial: string): Promise<{ step: string; error: string | null } | null>;
  // each device by the way that works now (engine.wake): cable, wi-fi, relay, or why not
  wake?(ids: string[]): Promise<{ id: string; name: string; via: 'cable' | 'wifi' | 'relay' | null; where: string | null; why: string | null }[]>;
  status(): { loading: unknown };
}

const MODES: ProjectMode[] = ['phone', 'apart', 'split', 'here'];
const MAX_HOURS = 14;
const SYSTEM = 'You are kula, working through the night on a project for the person who owns these devices. Write plain, useful text. Be concrete. No preamble.';

export const projectsFile = (): string => path.join(home(), 'projects.json');
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const noThink = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();

export class ProjectStore {
  constructor(readonly file = projectsFile()) {}
  read(): Project[] {
    try { const v = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  write(list: Project[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/** Splits the model's plan into parts: one per line, numbering and bullets taken off. */
export function partsOf(text: string, max = 5): string[] {
  return noThink(text).split(/\r?\n/).map((l) => l.replace(/\*\*/g, '').replace(/^\s*(?:[-*•]|\d+[.)]|part\s*\d+[:.)-]?)\s*/i, '').trim()).filter((l) => l.length > 3).slice(0, max);
}

export class ProjectRunner {
  private timer: NodeJS.Timeout | null = null;
  private keep: ChildProcess | null = null;
  private running: string | null = null;
  private abort: AbortController | null = null;
  constructor(
    private engine: ProjectEngine,
    private chats: ChatStore,
    private store = new ProjectStore(),
    private opts: { now?: () => number; tickMs?: number; awake?: boolean; log?: (s: string) => void } = {},
  ) {}

  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }
  private log(s: string): void { this.opts.log?.(s); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.opts.tickMs ?? 20_000);
    void this.tick();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.keep?.kill();
    this.keep = null;
  }

  list(): Project[] { return this.store.read().sort((a, b) => b.start - a.start); }
  get(id: string): Project | null { return this.store.read().find((p) => p.id === id) ?? null; }
  private update(id: string, patch: Partial<Project>): Project | null {
    const list = this.store.read();
    const p = list.find((x) => x.id === id);
    if (!p) return null;
    Object.assign(p, patch);
    this.store.write(list);
    return p;
  }

  create(body: any): Project {
    const request = String(body?.request ?? '').trim().slice(0, 4000);
    if (!request) throw new Error('say what it should do');
    const start = Number(body?.start), end = Number(body?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('give it a start and an end');
    if (end <= start) throw new Error('the end has to come after the start');
    if (end - start > MAX_HOURS * 3600_000) throw new Error(`at most ${MAX_HOURS} hours`);
    if (end < this.now() + 60_000) throw new Error('that time has passed');
    const model = String(body?.model ?? '').trim();
    if (!model) throw new Error('pick a model');
    const mode = String(body?.mode ?? 'apart') as ProjectMode;
    if (!MODES.includes(mode)) throw new Error('how it runs: phone, apart, split or here');
    const peers = Array.isArray(body?.peers) ? body.peers.map(String).slice(0, 8) : [];
    if ((mode === 'phone' || mode === 'split') && !peers.length) throw new Error('pick the devices it runs on');
    const title = (String(body?.title ?? '').trim() || request.split(/\s+/).slice(0, 8).join(' ')).slice(0, 80);
    const ctx = Math.max(1024, Math.min(32768, Number(body?.ctx) || 4096));
    const chatId = newId();
    const intro: ChatMessage[] = [{ role: 'user', content: request }];
    this.chats.put(chatId, { messages: intro, model });
    this.chats.rename(chatId, title);
    const p: Project = { id: randomBytes(6).toString('hex'), chatId, title, request, start, end, model, mode, peers, ctx, state: 'waiting', created: this.now() };
    this.store.write([...this.store.read(), p]);
    this.note(p, `planned: ${hhmm(start)}–${hhmm(end)}. until then this chat only waits; the report comes here.`);
    this.awake();
    return p;
  }

  cancel(id: string): Project | null {
    const p = this.get(id);
    if (!p) return null;
    if (p.state === 'running') this.abort?.abort();
    if (p.state !== 'waiting' && p.state !== 'running') return p;
    const q = this.update(id, { state: 'cancelled', endedAt: this.now(), line: 'cancelled' });
    if (p.state === 'waiting') this.note(p, 'cancelled before it started.');
    this.awake();
    return q;
  }

  /** One look at the clock: a project whose time has come starts; one whose time went by unseen is missed. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const p of this.store.read()) {
      if (p.state !== 'waiting') continue;
      if (now >= p.end) { this.update(p.id, { state: 'missed', endedAt: now, line: 'missed' }); this.note(p, `missed: this computer was not awake between ${hhmm(p.start)} and ${hhmm(p.end)}. plan it again, and leave the computer on power with the lid open.`); continue; }
      if (now >= p.start && !this.running) await this.run(p.id);
    }
    this.awake();
  }

  // macOS: no idle sleep while something waits or runs (display may still sleep)
  private awake(): void {
    if (this.opts.awake === false || process.platform !== 'darwin') return;
    const need = this.store.read().some((p) => p.state === 'waiting' || p.state === 'running');
    if (need && !this.keep) {
      try {
        this.keep = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
        this.keep.on('exit', () => { this.keep = null; });
        this.keep.on('error', () => { this.keep = null; });
      } catch { this.keep = null; }
    } else if (!need && this.keep) { this.keep.kill(); this.keep = null; }
  }

  // a line in the project's chat
  private note(p: Project, text: string, error = false): void {
    this.say(p, text, error ? { error: text } : undefined);
  }
  private say(p: Project, content: string, meta?: ChatMessage['meta']): void {
    const c = this.chats.get(p.chatId);
    if (!c) return;
    const m: ChatMessage = { role: 'assistant', content };
    if (meta) m.meta = meta;
    this.chats.put(p.chatId, { messages: [...c.messages, m], model: c.model ?? p.model });
  }

  private async ask(prompt: string, maxTokens: number, signal: AbortSignal): Promise<{ text: string; meta: ChatMessage['meta'] }> {
    let text = '';
    const r = await this.engine.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], (t) => { text += t; }, { maxTokens, temperature: 0.4, signal, use: 'project' });
    return { text: noThink(r.text || text), meta: { tokens: r.tokens, tps: r.tps, ms: r.ms, firstMs: r.firstMs, device: r.device } };
  }

  async run(id: string): Promise<void> {
    const p0 = this.get(id);
    if (!p0 || p0.state !== 'waiting' || this.running) return;
    this.running = id;
    const ac = new AbortController();
    this.abort = ac;
    const p = this.update(id, { state: 'running', startedAt: this.now(), line: 'waking the devices' })!;
    this.log(`project ${p.title}: started`);
    try {
      if (this.engine.wake && p.mode !== 'here') {
        // every device by the way that works now: the cable if it is plugged in, else this wi-fi
        this.update(id, { line: 'reaching the devices' });
        const woke = await this.engine.wake(p.peers);
        const way = (w: (typeof woke)[number]) => (w.via === 'cable' ? `${w.name} on the usb cable` : w.via === 'wifi' ? `${w.name} over wi-fi${w.where ? ` (${w.where})` : ''}` : w.via === 'relay' ? `${w.name} through the relay` : `${w.name} not reached (${w.why ?? 'no answer'})`);
        if (woke.length) this.say(p, `reached ${woke.map(way).join(', ')}.`);
      } else {
        // phones on a cable: their share screen opened again and connected (they may have slept)
        const rows = this.engine.peers();
        for (const pid of p.peers) {
          const row = rows.find((r) => r.id === pid);
          if (!row?.cable || !this.engine.useCable || !this.engine.cableSettled) continue;
          this.update(id, { line: `connecting ${row.name}` });
          try { this.engine.useCable(row.cable.serial); const v = await this.engine.cableSettled(row.cable.serial); if (v?.error) this.note(p, `${row.name}: ${v.error}`); } catch (e) { this.note(p, `${row.name}: ${(e as Error).message}`); }
        }
      }
      if (ac.signal.aborted) throw new Error('cancelled');
      this.update(id, { line: 'loading the model' });
      await this.engine.load({ model: p.model, mode: p.mode, peers: p.peers, ctx: p.ctx, all: p.mode === 'split' }, () => {});
      this.say(p, `started at ${hhmm(this.now())}: the model is loaded (${p.mode}${p.peers.length ? `, ${p.peers.length} device${p.peers.length === 1 ? '' : 's'}` : ''}). first a plan, then the parts, then the report.`);

      this.update(id, { line: 'making a plan' });
      const plan = await this.ask(`The project:\n${p.request}\n\nBreak it into at most 5 concrete parts that can be worked on one after the other. Write one part per line, nothing else.`, 320, ac.signal);
      const parts = partsOf(plan.text);
      if (!parts.length) parts.push(p.request);
      this.update(id, { parts: parts.length, done: 0 });
      this.say(p, `**the plan**\n\n${parts.map((x, i) => `${i + 1}. ${x}`).join('\n')}`, plan.meta);

      const found: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (ac.signal.aborted) throw new Error('cancelled');
        if (this.now() > p.end - 3 * 60_000) { this.say(p, `the time is nearly up: ${parts.length - i} part${parts.length - i === 1 ? '' : 's'} left undone.`); break; }
        this.update(id, { line: `part ${i + 1} of ${parts.length}` });
        const r = await this.ask(`The project:\n${p.request}\n\nThe plan:\n${parts.map((x, k) => `${k + 1}. ${x}`).join('\n')}\n\nNow work on part ${i + 1}: ${parts[i]}\nDo it fully and concretely.`, 800, ac.signal);
        found.push(`${i + 1}. ${parts[i]}\n${r.text}`);
        this.update(id, { done: i + 1 });
        this.say(p, `**part ${i + 1} of ${parts.length} · ${parts[i]}**\n\n${r.text}`, r.meta);
      }

      if (ac.signal.aborted) throw new Error('cancelled');
      this.update(id, { line: 'writing the report' });
      const digest = found.join('\n\n').slice(0, 9000);
      const rep = await this.ask(`The project:\n${p.request}\n\nWhat was worked out tonight:\n${digest}\n\nWrite the morning report for the person: a short summary first, then what was found in each part, then the next steps. Use short headings.`, 1000, ac.signal);
      this.say(p, `**morning report**\n\n${rep.text}`, rep.meta);
      this.update(id, { state: 'done', endedAt: this.now(), line: 'done' });
      this.log(`project ${p.title}: done`);
    } catch (e) {
      const why = (e as Error).message;
      const cancelled = ac.signal.aborted || why === 'cancelled';
      this.update(id, { state: cancelled ? 'cancelled' : 'failed', endedAt: this.now(), line: cancelled ? 'cancelled' : 'stopped', error: cancelled ? undefined : why });
      this.note(p, cancelled ? 'cancelled while it ran: what is above stays.' : `the night project stopped: ${why}`, !cancelled);
      this.log(`project ${p.title}: ${cancelled ? 'cancelled' : `failed, ${why}`}`);
    } finally {
      // the phones may rest again
      await this.engine.unload(true).catch(() => {});
      this.running = null;
      this.abort = null;
      this.awake();
    }
  }
}
