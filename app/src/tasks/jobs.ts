import type { BrainEntry } from '@/llm/brainlog';
import type { JobSource, Unit, UnitResult } from '@/night/jobs';
import { stepsOf } from './prompts';
import { nextRequest, recordStep, startRun } from './run';
import { dueTasks, taskKey } from './schedule';
import type { Task } from './types';

// The projects as a source of the night's work (5.11.2026). The night worker takes units
// one by one; a project's run is a chain of steps, each a unit, handed out only when the
// step before it is finished (a critique needs its draft). So a project is never in two
// devices at once: while its step is out, next() goes on to the next project due, and
// returns null when none is; the night's other work comes after (night/jobs.ts FirstOf).
//
// Only projects due right now are handed out: their window open, their night, not done in
// it, on charge when they ask for it (tasks/schedule.ts). Every finished step is written to
// the project at once (resume), and goes to the brain log.

export type TaskDeps = {
  list: () => Task[];
  load: (id: string) => Task | null;
  save: (t: Task) => void;
  now: () => number;
  charging: () => boolean;
  thinking: () => boolean; // the loaded model thinks (qwen3)
  model: () => string | undefined;
  log: (e: BrainEntry) => void;
  onFinished?: (t: Task) => void;
};

export const TASK_UNIT = 'task:';

export class ProjectJobs implements JobSource {
  private out = new Map<string, { task: string; run: string; index: number }>();
  constructor(private d: TaskDeps) {}

  async next(): Promise<Unit | null> {
    const now = this.d.now();
    const busy = new Set([...this.out.values()].map((o) => o.task));
    for (const due of dueTasks(this.d.list(), new Date(now), this.d.charging())) {
      if (busy.has(due.id)) continue;
      const fresh = !due.run;
      const t = startRun(due, taskKey(due, new Date(now)), now, this.d.model());
      const req = nextRequest(t, this.d.thinking());
      if (!req || !t.run) continue;
      if (fresh) {
        this.d.save(t);
        this.d.log({ at: now, kind: 'night', key: 'brain.task.start', vars: { title: t.title, n: req.total }, detail: t.run.note, tone: 'info' });
      }
      const id = `${TASK_UNIT}${t.id}:${t.run.id}:${req.index}`;
      this.out.set(id, { task: t.id, run: t.run.id, index: req.index });
      return { id, type: 'project', prompt: '', messages: req.messages, maxTokens: req.maxTokens, temperature: 0.7, own: true };
    }
    return null;
  }

  async retry(unit: Unit) {
    this.out.delete(unit.id);
  }

  async done(unit: Unit, result: UnitResult) {
    const o = this.out.get(unit.id);
    this.out.delete(unit.id);
    if (!o) return;
    const t = this.d.load(o.task);
    // the project was deleted, run again or edited into another run meanwhile: drop the step
    if (!t?.run || t.run.id !== o.run || t.run.steps.length !== o.index) return;
    const now = this.d.now();
    const { task, finished } = recordStep(t, { text: result.text, tokens: result.tokens, ms: result.ms, device: result.device }, now, taskKey(t, new Date(now)));
    this.d.save(task);
    const step = finished ? task.last!.steps[o.index] : task.run!.steps[o.index];
    this.d.log({ at: now, kind: 'night', key: `brain.task.step.${step.name}`, vars: { title: t.title, i: o.index + 1, n: stepsOf(t).length, tokens: result.tokens, device: (result.device ?? '').toLowerCase() }, tone: 'info' });
    if (finished) {
      this.d.log({ at: now, kind: 'night', key: 'brain.task.done', vars: { title: t.title, tokens: task.last!.tokens, words: wordsOf(task.last!.answer) }, tone: 'ok' });
      this.d.onFinished?.(task);
    }
  }
}

export const wordsOf = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
