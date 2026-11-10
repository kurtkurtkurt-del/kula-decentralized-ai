// god's eye: one look every few seconds, handed to every branch. See types.ts.
import fs from 'node:fs';
import path from 'node:path';
import { BRANCHES, BRANCH_IDS, dark, type Branch, type BranchCtx, type BranchEvent, type BranchId, type BranchMaker, type BranchView, type Snapshot } from './types.js';
import { MAKERS } from './branches/index.js';
import { clean } from './branches/guard.js';

const EVENTS_MAX = 60;

/** what a thrown value says: a caught value may be null or undefined, which has no .message */
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface EyeOptions {
  snapshot: () => Snapshot;        // one look, plain data; the eye clones it once more anyway
  dir: string;                     // where branches keep their notes
  everyMs?: number;                // 5 s
  now?: () => number;
  log?: (s: string) => void;
  makers?: Partial<Record<BranchId, BranchMaker>>;  // tests, or a branch from elsewhere
}

export type EyeBranchView = BranchView & { n: number; id: BranchId; name: string; what: string; error?: string };
export interface EyeView {
  at: number;                                         // when the last look was taken
  branches: EyeBranchView[];                          // the twelve, in the map's order
  events: (BranchEvent & { branch: BranchId })[];     // newest first
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

  constructor(private readonly opts: EyeOptions) {
    this.now = opts.now ?? Date.now;
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
   *  branches start again from nothing at the next look. Returns how many files went. */
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
    this.make();
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
        this.events.unshift({ at: this.now(), text: String(text).slice(0, 300), branch: id });
        this.events.length = Math.min(this.events.length, EVENTS_MAX);
      },
      // a broken branch's last view is not quoted for ever: peek sees nothing of it
      peek: (other: BranchId) => (this.broken.has(other) ? null : this.views.get(other) ?? null),
    };
  }

  /** One look: the snapshot through the guard, then every branch in the map's order. Nothing in
   *  here may throw out of it: a bad look is skipped whole, a throwing branch is stopped alone. */
  tick(): void {
    let snap: Snapshot | null = null;
    let notLook: string | null = null;
    try {
      const raw = this.opts.snapshot();
      snap = clean(structuredClone(raw));
    } catch (e) { notLook = why(e); }
    if (snap === null) {
      // thrown, uncloneable, not an object, or no usable at: no branch sees it and `before`
      // stands. one line per run of such looks, not one every few seconds
      if (!this.skipping) this.log(notLook === null ? "god's eye: a look was not usable, skipped" : `god's eye: no look: ${notLook}`);
      this.skipping = true;
      return;
    }
    this.skipping = false;
    try {
      this.lastAt = snap.at;
      for (const id of BRANCH_IDS) {
        const b = this.branches.get(id);
        if (!b || this.broken.has(id)) continue;
        try {
          b.observe(snap, this.before);
          this.views.set(id, b.view());
        } catch (e) {
          this.broken.set(id, why(e));
          this.log(`god's eye ${id}: stopped: ${why(e)}`);
        }
      }
      this.before = snap;
    } catch (e) {
      this.log(`god's eye: ${why(e)}`);
    }
  }

  /** Hands a decision from the branch's page to the branch (it never reaches a device), then looks again. */
  act(id: BranchId, action: string, arg: string): string | null {
    const b = this.branches.get(id);
    if (!b?.act || this.broken.has(id)) return null;
    let word: string | null = null;
    try { word = b.act(String(action).slice(0, 40), String(arg).slice(0, 200)); } catch (e) { this.log(`god's eye ${id}: ${why(e)}`); return null; }
    try { this.views.set(id, b.view()); } catch {}
    return word;
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.everyMs ?? 5000);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  view(): EyeView {
    const branches = BRANCHES.map((m): EyeBranchView => {
      const err = this.broken.get(m.id);
      const v = err ? { ...dark('broken'), error: err } : (this.views.get(m.id) ?? dark('looking…'));
      return { ...v, n: m.n, id: m.id, name: m.name, what: v.what || m.what };
    });
    return { at: this.lastAt, branches, events: [...this.events] };
  }
}
