import { lastPassport } from '@/data/passport';
import { chat, engine, load, unload } from '@/llm/engine';
import { defaultCtx, fitOn } from '@/llm/fit';
import { llama } from '@/llm/native';
import { note, noteUnit } from '@/llm/brainlog';
import { localById, localModels, peers, settings, type LocalModel } from '@/llm/store';
import { DemoJobs, SYSTEM, checkAnswer, type JobSource, type Unit } from './jobs';
import { PEER_WATTS, WATTS, type NightDevice, type NightStatus, type NightWorker } from './NightWorker';

// The real night (5.11.2026). On start it picks a model (the chosen one, else the largest
// local one that fits by the passport), loads it in apart mode with the saved peers
// (alone when there are none, or when none answers), and then every device runs its own
// small loop: take a unit from the source, chat it, hand the result back, take the next.
// One unit in flight per device, so a slow phone does not hold the fast one back: beyin's
// rule, jobs are split, models are not. A device that fails is put out for OUT_MS and its
// unit goes back on the pile; the other devices carry on, the night does not end.
// Tokens, seconds and kWh go on the card as before (4 W for this phone, 2 W per extra
// device), plus the units and the known-answer count the server does not read yet.
const OUT_MS = 5 * 60_000;
const IDLE_MS = 1000; // how long a device with nothing to do waits before looking again

// source gets the night's key and its slug (OWN_SLUG: a night for the person's own projects
// only, 5.11.2026); prefer names the model a project asked for; ctx the context it wants.
type Options = { source?: (key?: string, slug?: string) => JobSource; now?: () => number; outMs?: number; idleMs?: number; prefer?: () => string | null; ctx?: () => number | null };

const fresh = (): NightStatus => ({ state: 'idle', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0, real: true, units: 0, checked: 0, wrong: 0, devices: [] });

export class LlamaWorker implements NightWorker {
  private s: NightStatus = fresh();
  private listeners = new Set<(s: NightStatus) => void>();
  private source: JobSource | null = null;
  private run = 0; // which start() the loops belong to; stop() moves it on
  private inFlight = new Map<string, { stop: () => void }>();
  private outUntil = new Map<string, number>();
  private drained = false; // a loop found the pile empty: the night ends when the rest finish
  private night: Promise<void> = Promise.resolve(); // the current begin(): load, loops, end
  private readonly opt: Required<Options>;
  constructor(opt: Options = {}) {
    this.opt = { source: () => new DemoJobs(), now: () => Date.now(), outMs: OUT_MS, idleMs: IDLE_MS, prefer: () => null, ctx: () => null, ...opt };
  }

  start(slug: string, tps: number, key?: string) {
    this.stop();
    const run = ++this.run;
    this.source = this.opt.source(key, slug);
    this.drained = false;
    this.outUntil.clear();
    this.s = { ...fresh(), state: 'running', slug, startedAt: this.opt.now(), tps };
    this.tell();
    this.night = this.begin(run);
  }
  stop() {
    if (this.s.state !== 'running') return;
    this.run++;
    this.inFlight.forEach((p) => p.stop());
    this.inFlight.clear();
    this.measure();
    this.s = { ...this.s, state: 'done' };
    this.tell();
    note({ at: this.opt.now(), kind: 'night', key: 'brain.night.end', vars: { units: this.s.units ?? 0, tokens: this.s.tokens, right: (this.s.checked ?? 0) - (this.s.wrong ?? 0), checked: this.s.checked ?? 0 }, tone: 'info' });
    llama?.keepScreenOn(false).catch(() => {});
    void unload().catch(() => {});
  }
  reset() {
    this.stop();
    this.s = fresh();
    this.tell();
  }
  wait(reason: NonNullable<NightStatus['reason']>) {
    if (this.s.state === 'running') return;
    this.s = { ...this.s, state: 'waiting', reason };
    this.tell();
  }
  status() {
    return this.s;
  }
  subscribe(fn: (s: NightStatus) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  /** Resolves when the night's loops have ended (after stop() or an empty source). */
  settled() {
    return this.night;
  }

  private tell() {
    this.listeners.forEach((fn) => fn(this.s));
  }
  private alive(run: number) {
    return run === this.run && this.s.state === 'running';
  }

  private async begin(run: number) {
    llama?.keepScreenOn(true).catch(() => {});
    try {
      const model = pickModel(this.opt.prefer());
      if (!model) throw new Error('nomodel');
      await loadApartOrAlone(model, this.opt.ctx());
      if (!this.alive(run)) {
        // stop() came while the model was loading: its unload ran too early, so once more
        void unload().catch(() => {});
        return;
      }
      const devs = engine().devices;
      this.s = { ...this.s, model: model.name, devices: devs.map((d) => ({ id: d.id, name: d.name, tokens: 0, units: 0 })) };
      this.tell();
      note({ at: this.opt.now(), kind: 'night', key: 'brain.night.start', vars: { model: model.name, n: devs.length, slug: (this.s.slug ?? '').replace(/-/g, ' ') }, detail: devs.map((d) => d.name.toLowerCase()).join('  ·  '), tone: 'info' });
      await Promise.all(devs.map((d) => this.loop(run, d.id)));
      // the source ran dry: the night is over on its own
      if (this.alive(run)) {
        note({ at: this.opt.now(), kind: 'night', key: 'brain.night.drained', tone: 'ok' });
        this.stop();
      }
    } catch (e) {
      if (this.alive(run)) {
        this.stop();
        note({ at: this.opt.now(), kind: 'error', key: 'brain.night.failed', detail: (e as Error).message, tone: 'bad' });
      }
    }
  }

  // One device's night: a unit, a chat, a result; or a pause when the device is out or
  // the pile is empty for the moment.
  private async loop(run: number, dev: string) {
    while (this.alive(run)) {
      if ((this.outUntil.get(dev) ?? 0) > this.opt.now()) {
        if (this.drained) return;
        await sleep(this.opt.idleMs);
        continue;
      }
      const unit = await this.source!.next().catch(() => null);
      if (!unit) {
        this.drained = true;
        return;
      }
      if (!this.alive(run)) {
        await this.source!.retry?.(unit);
        return;
      }
      await this.work(run, dev, unit);
    }
  }
  private async work(run: number, dev: string, unit: Unit) {
    let text = '';
    try {
      const messages = unit.messages ?? [{ role: 'system', content: SYSTEM[unit.type] }, { role: 'user', content: unit.prompt }];
      const p = chat(messages, (t) => { text += t; }, { maxTokens: fitBudget(unit.maxTokens, messages, engine().load?.ctx ?? 0), temperature: unit.temperature ?? 0, reset: true, device: dev });
      this.inFlight.set(dev, p);
      const r = await p;
      this.inFlight.delete(dev);
      if (!this.alive(run)) return; // stopped under it: not counted, the pile is done with
      if (unit.own) {
        // the person's own project: its source logs the step; the card counts only the network's work
        await this.source!.done(unit, { text, device: r.device, tokens: r.tokens, ms: r.ms }).catch(() => {});
        this.s = { ...this.s, ownUnits: (this.s.ownUnits ?? 0) + 1, ownTokens: (this.s.ownTokens ?? 0) + r.tokens };
        this.measure();
        this.tell();
        return;
      }
      const ok = unit.expected ? checkAnswer(unit.expected, text) : undefined;
      const name = (this.s.devices ?? []).find((d) => d.id === dev)?.name.toLowerCase() ?? dev;
      // the brain tab: the unit on its device's running line; a wrong known answer on its own
      if (ok === false) note({ at: this.opt.now(), kind: 'check', key: 'brain.check.wrong', vars: { device: name, type: unit.type }, detail: `${unit.expected} ≠ ${text.trim().slice(0, 40)}`, tone: 'bad' });
      else noteUnit(this.opt.now(), name, r.tokens, ok === true);
      await this.source!.done(unit, { text, device: r.device, tokens: r.tokens, ms: r.ms, ok }).catch(() => {});
      const devices = (this.s.devices ?? []).map((d): NightDevice => (d.id === dev ? { ...d, tokens: d.tokens + r.tokens, units: d.units + 1, out: false } : d));
      this.s = { ...this.s, tokens: this.s.tokens + r.tokens, units: (this.s.units ?? 0) + 1, checked: (this.s.checked ?? 0) + (ok === undefined ? 0 : 1), wrong: (this.s.wrong ?? 0) + (ok === false ? 1 : 0), devices };
      this.measure();
      this.tell();
    } catch {
      this.inFlight.delete(dev);
      if (!this.alive(run)) return;
      // out for five minutes; the unit goes back for another device
      this.outUntil.set(dev, this.opt.now() + this.opt.outMs);
      note({ at: this.opt.now(), kind: 'out', key: 'brain.out', vars: { device: (this.s.devices ?? []).find((d) => d.id === dev)?.name.toLowerCase() ?? dev, min: Math.round(this.opt.outMs / 60000) }, tone: 'warn' });
      await this.source!.retry?.(unit);
      this.s = { ...this.s, devices: (this.s.devices ?? []).map((d) => (d.id === dev ? { ...d, out: true } : d)) };
      this.tell();
    }
  }
  // seconds since the start, the energy for them, the night's tok/s so far
  private measure() {
    const seconds = Math.max(0, Math.round((this.opt.now() - (this.s.startedAt ?? this.opt.now())) / 1000));
    const extra = Math.max(0, (this.s.devices?.length ?? 1) - 1);
    const kwh = ((WATTS + PEER_WATTS * extra) * seconds) / 3600 / 1000;
    const tps = seconds > 0 ? Math.round((this.s.tokens / seconds) * 10) / 10 : this.s.tps;
    this.s = { ...this.s, seconds, kwh, tps };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The model a project asked for, else the chosen model, else the largest local one the
 * passport says fits, else the largest. */
export function pickModel(prefer?: string | null): LocalModel | null {
  const asked = prefer ? localById(prefer) : null;
  if (asked) return asked;
  const chosen = settings().modelId ? localById(settings().modelId!) : null;
  if (chosen) return chosen;
  const all = [...localModels()].sort((a, b) => b.size - a.size);
  const p = lastPassport();
  const ctx = settings().ctx;
  return all.find((m) => fitOn(p, { size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx }).verdict !== 'no') ?? all[0] ?? null;
}

/** A unit's token budget within the loaded context: what the prompt leaves, less a margin
 * (a project's long steps on a small context); unchanged when the context is not known. */
export function fitBudget(maxTokens: number, messages: { content: string }[], ctx: number): number {
  if (!ctx) return maxTokens;
  const prompt = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 3.5) + 32;
  return Math.max(64, Math.min(maxTokens, ctx - prompt));
}

// want: a larger context for the person's projects (long drafts and critiques), up to what fits
async function loadApartOrAlone(model: LocalModel, want?: number | null) {
  const fit = fitOn(lastPassport(), { size: model.size, kv_mb_per_1k: model.kv_mb_per_1k, ctx: settings().ctx });
  // without a passport what fits is not known: the setting stays
  const cap = lastPassport() ? Math.max(512, fit.maxCtx || 512) : settings().ctx;
  const ctx = want ? Math.min(Math.max(want, settings().ctx), cap) : Math.min(settings().ctx, defaultCtx(fit));
  const ps = peers();
  if (ps.length) {
    try {
      await load(model, 'apart', ctx, ps);
      return;
    } catch {
      /* a peer that answered the probe and then failed to load: alone, then */
    }
  }
  await load(model, 'alone', ctx, []);
}
