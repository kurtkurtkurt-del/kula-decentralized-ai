// god's eye: one look every few seconds, handed to every branch. See types.ts.
import fs from 'node:fs';
import path from 'node:path';
import { BRANCHES, BRANCH_IDS, dark, type Branch, type BranchCtx, type BranchEvent, type BranchId, type BranchMaker, type BranchView, type Snapshot } from './types.js';
import { MAKERS } from './branches/index.js';

const EVENTS_MAX = 60;

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

  constructor(private readonly opts: EyeOptions) {
    this.now = opts.now ?? Date.now;
    for (const id of BRANCH_IDS) {
      try { this.branches.set(id, (opts.makers?.[id] ?? MAKERS[id])(this.ctx(id))); }
      catch (e) { this.broken.set(id, (e as Error).message); }
    }
  }

  private ctx(id: BranchId): BranchCtx {
    const file = path.join(this.opts.dir, `${id}.json`);
    return {
      now: () => this.now(),
      load: <T>(fallback: T): T => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; } },
      save: (data: unknown) => {
        try {
          fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
          fs.renameSync(tmp, file);
        } catch (e) { this.opts.log?.(`god's eye ${id}: could not save: ${(e as Error).message}`); }
      },
      emit: (text: string) => {
        this.events.unshift({ at: this.now(), text: String(text).slice(0, 300), branch: id });
        this.events.length = Math.min(this.events.length, EVENTS_MAX);
      },
      peek: (other: BranchId) => this.views.get(other) ?? null,
    };
  }

  /** One look: the snapshot, then every branch in the map's order. */
  tick(): void {
    let snap: Snapshot;
    try { snap = structuredClone(this.opts.snapshot()); } catch (e) { this.opts.log?.(`god's eye: no look: ${(e as Error).message}`); return; }
    this.lastAt = snap.at;
    for (const id of BRANCH_IDS) {
      const b = this.branches.get(id);
      if (!b || this.broken.has(id)) continue;
      try {
        b.observe(snap, this.before);
        this.views.set(id, b.view());
      } catch (e) {
        this.broken.set(id, (e as Error).message);
        this.opts.log?.(`god's eye ${id}: stopped: ${(e as Error).message}`);
      }
    }
    this.before = snap;
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
