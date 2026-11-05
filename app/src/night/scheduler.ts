import type { NightRules } from '@/data/settings';
import type { Verdict } from './conditions';
import type { NightStatus } from './NightWorker';
import { addSegment, buildReport, clearSegments, saveReport, segmentOf, segments, windowKey, type NightReport } from './report';

// The night's planner (night-2, 5.11.2026): a small state machine over the worker.
//
//   waiting ──conditions ok, window open, not done tonight──▶ running
//   running ──a condition breaks (plug, battery, heat, wi-fi)──▶ paused   (segment kept)
//   paused  ──conditions back, same window──▶ running                      (pile continued)
//   running / paused ──window closes, pile empty, or "end now"──▶ done     (report, card)
//   done ──the next window opens──▶ waiting
//
// Everything it needs is handed in (Deps), so the machine can be driven in a test with a
// fake clock and a fake worker; useNight.ts wires the real ones. What must survive a
// restart of the app in the night is in the kv-store: the open night (night.start), the
// segments so far (night.segments), the pile (night.queue, queue.ts), the key of the
// night already finished (night.done).
//
// Background: SDK 57's expo-background-task runs short jobs through WorkManager / BGTask
// at the system's pace (15 minutes at the earliest, no long work), so it cannot carry a
// model for hours; the native WorkerService serves peers, not this loop. So the limit,
// plainly: the night runs while the app is open. The real worker keeps the screen on
// (keepScreenOn, dimmed by the system) for as long as it runs, and lets it go on a pause
// or at the end; the simulation does not need the screen and does not touch it. A phone
// whose screen is locked by hand pauses the loop with the app; when the app is opened
// again, the night continues from the pile. The sticky notification says that the night
// is running (notify.ts).
export type Phase = 'idle' | 'waiting' | 'running' | 'paused' | 'done';
export type Open = { id: string | null; jobId: string; at: number; slug: string; key: string };
export type Store = { get(k: string): string | null; set(k: string, v: string): void; del(k: string): void };
export type Worker = {
  start(slug: string, tps: number, key?: string): void;
  stop(): void;
  reset(): void;
  wait(reason: NonNullable<NightStatus['reason']>): void;
  status(): NightStatus;
  subscribe(fn: (s: NightStatus) => void): () => void;
};
export type Deps = {
  worker: () => Worker; // picked at each start (the real one or the simulation)
  verdict: () => Promise<Verdict>;
  project: () => Promise<string | null>;
  rules: () => NightRules;
  now: () => number;
  tps: () => number; // the passport's estimate, for the simulation
  watts: () => number | null; // measured, when the phone has a figure
  store: Store;
  startNight: (slug: string) => Promise<{ id: string | null; jobId: string; at: number } | null>;
  endNight: (p: { contributionId: string | null; startId: string; startedAt: number; slug: string; tokens: number; seconds: number; kwh: number; units: number; checked: number; wrong: number; model: string | null }) => Promise<unknown>;
  sendReport: (r: NightReport) => Promise<boolean>;
  notify: { show(r: { slug: string; units: number }): Promise<void> | void; hide(): Promise<void> | void };
  onReport?: (r: NightReport) => void;
};
const START = 'night.start';
const DONE = 'night.done';

export class Scheduler {
  private phase: Phase = 'idle';
  private busy = false;
  private again = false;
  private active: Worker | null = null;
  private off: (() => void) | null = null;
  private listeners = new Set<() => void>();
  constructor(private d: Deps) {}

  state(): { phase: Phase; open: Open | null; night: NightStatus | null } {
    return { phase: this.phase, open: this.open(), night: this.active?.status() ?? null };
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private tell() {
    this.listeners.forEach((fn) => fn());
  }
  open(): Open | null {
    try {
      return JSON.parse(this.d.store.get(START) ?? 'null') as Open | null;
    } catch {
      return null;
    }
  }
  private setOpen(o: Open | null) {
    if (o) this.d.store.set(START, JSON.stringify(o));
    else this.d.store.del(START);
  }
  doneKey() {
    return this.d.store.get(DONE);
  }

  /** One look at the world; called every half minute and on every change. Never overlaps. */
  async tick(): Promise<Phase> {
    if (this.busy) {
      this.again = true;
      return this.phase;
    }
    this.busy = true;
    try {
      await this.step();
    } finally {
      this.busy = false;
    }
    if (this.again) {
      this.again = false;
      return this.tick();
    }
    return this.phase;
  }

  private async step() {
    const r = this.d.rules();
    const key = windowKey(r.from, r.to, new Date(this.d.now()));
    const [v, slug] = await Promise.all([this.d.verdict(), this.d.project().catch(() => null)]);
    const open = this.open();
    const w = this.active;
    const running = !!w && w.status().state === 'running';

    if (open) {
      // the worker ran the pile dry on its own: the night is over
      const drained = !!w && this.phase === 'running' && w.status().state === 'done';
      if (v.flags.window || open.key !== key || drained) return this.finish(open);
      if (v.ok && !running) return this.resume(open);
      if (!v.ok && running) return this.pause(open, v);
      if (!v.ok) return this.wait(v.reason, 'paused');
      return;
    }
    if (!slug) return this.wait('noproject', 'waiting');
    if (!v.ok) return this.wait(v.reason, 'waiting');
    if (this.doneKey() === key) return this.wait('done', 'done');
    return this.begin(slug, key);
  }

  // the worker shows the missing condition; the phase says whether a night is open behind it
  private wait(reason: NightStatus['reason'] | null, phase: Phase) {
    const w = this.active ?? this.use();
    if (reason) w.wait(reason);
    this.set(phase);
  }
  private use() {
    const w = this.d.worker();
    if (w !== this.active) {
      this.off?.();
      this.active?.reset();
      this.active = w;
      this.off = w.subscribe(() => this.tell());
    }
    return w;
  }
  private set(phase: Phase) {
    if (this.phase !== phase) {
      this.phase = phase;
      this.tell();
    } else this.tell();
  }

  private async begin(slug: string, key: string) {
    const r = await this.d.startNight(slug).catch(() => null);
    if (!r) return this.wait(null, 'waiting'); // the server said no: the next tick asks again
    clearSegments();
    this.setOpen({ ...r, slug, key });
    this.d.store.del(DONE);
    this.go(slug, key);
  }
  private resume(open: Open) {
    this.go(open.slug, open.key);
  }
  private go(slug: string, key: string) {
    const w = this.use();
    w.start(slug, this.d.tps(), key);
    this.set('running');
    void this.d.notify.show({ slug, units: segments().reduce((a, s) => a + s.units, 0) });
  }
  private async pause(open: Open, v: Verdict) {
    this.cut();
    void this.d.notify.hide();
    this.wait(v.reason, 'paused');
    void open;
  }
  // stops the worker and keeps what it did as a segment
  private cut() {
    const w = this.active;
    if (!w || w.status().state === 'idle' || w.status().state === 'waiting') return;
    const wasRunning = w.status().state === 'running';
    if (wasRunning) w.stop();
    const s = w.status();
    if (s.startedAt) addSegment(segmentOf(s, this.d.now()));
    w.reset();
  }
  private async finish(open: Open) {
    this.cut();
    void this.d.notify.hide();
    this.setOpen(null);
    this.d.store.set(DONE, open.key);
    const segs = segments();
    clearSegments();
    const report = buildReport(open.key, open.slug, segs, this.d.watts());
    saveReport(report);
    this.set('done');
    this.d.onReport?.(report);
    await this.d.endNight({ contributionId: open.id, startId: open.jobId, startedAt: open.at, slug: open.slug, tokens: report.tokens, seconds: report.seconds, kwh: report.kwh, units: report.units, checked: report.checked, wrong: report.wrong, model: report.model }).catch(() => {});
    const sent = await this.d.sendReport(report).catch(() => false);
    if (sent) saveReport({ ...report, sent: true });
    this.tell();
  }
  /** "end the night now": the morning by hand. */
  async endNow() {
    const open = this.open();
    if (!open) return;
    await this.finish(open);
  }
}
