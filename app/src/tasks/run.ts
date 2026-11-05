import type { Message } from '@/llm/native';
import { stripThink } from '@/voice/text';
import { stepMessages, stepTokens, stepsOf } from './prompts';
import type { StepResult, Task } from './types';

// A project's run, step by step (5.11.2026). The pure part: begin a run, which step is
// next, record a finished step (the last one makes the answer). The same functions serve
// the night (tasks/jobs.ts hands the steps to the night worker as units) and "run now"
// (runPipeline below, with the engine's chat while the app is open). Every step is saved
// as it finishes, so a run cut in the middle goes on from the next step.

export type ChatFn = (messages: Message[], onToken: (t: string) => void, opts: { maxTokens: number; temperature: number; reset: boolean }) => Promise<{ tokens: number; ms: number; device?: string }> & { stop?: () => void };

const runId = (now: number) => `r${now.toString(36)}`;

/** The task with a run begun (kept when one is already in progress). */
export function startRun(t: Task, key: string, now: number, model?: string): Task {
  if (t.run) return t;
  return { ...t, run: { id: runId(now), key, startedAt: now, steps: [], note: t.note, model }, updatedAt: now };
}

/** The next step of the run in progress, or null when there is none. */
export function nextStep(t: Task): { index: number; name: ReturnType<typeof stepsOf>[number]; total: number } | null {
  if (!t.run) return null;
  const steps = stepsOf(t);
  const i = t.run.steps.length;
  return i < steps.length ? { index: i, name: steps[i], total: steps.length } : null;
}

/** The messages and the token budget of the next step. */
export function nextRequest(t: Task, thinking: boolean) {
  const n = nextStep(t);
  if (!n || !t.run) return null;
  return { ...n, messages: stepMessages(t, t.run.steps, n.index, { thinking, note: t.run.note }), maxTokens: stepTokens(n.name, t.length, thinking) };
}

/**
 * The task after a finished step. The last step finishes the run: its text is the answer,
 * the work is kept under `last`, the note is used up, a once-project is finished, and
 * doneKey (the night's key; null for "run now") marks the night as done for this project.
 */
export function recordStep(t: Task, raw: { text: string; tokens: number; ms: number; device?: string }, now: number, doneKey: string | null): { task: Task; finished: boolean } {
  const n = nextStep(t);
  if (!n || !t.run) return { task: t, finished: false };
  const step: StepResult = { name: n.name, text: stripThink(raw.text).trim(), tokens: raw.tokens, ms: raw.ms, at: now, ...(raw.device ? { device: raw.device } : {}) };
  const steps = [...t.run.steps, step];
  if (steps.length < n.total) return { task: { ...t, run: { ...t.run, steps }, updatedAt: now }, finished: false };
  const done = {
    runId: t.run.id,
    at: now,
    key: doneKey ?? t.run.key,
    answer: step.text,
    steps,
    tokens: steps.reduce((a, s) => a + s.tokens, 0),
    seconds: Math.round(steps.reduce((a, s) => a + s.ms, 0) / 1000),
    model: t.run.model,
    note: t.run.note,
  };
  const task: Task = {
    ...t,
    run: null,
    last: done,
    note: t.note === t.run.note ? undefined : t.note,
    lastDoneKey: doneKey ?? t.lastDoneKey,
    finished: t.days === 'once' ? true : t.finished,
    runs: t.runs + 1,
    updatedAt: now,
  };
  return { task, finished: true };
}

export type PipelineDeps = {
  chat: ChatFn;
  thinking: boolean;
  model?: string;
  now?: () => number;
  key: string; // the run's key; "now" for run-now
  doneKey: string | null;
  load: (id: string) => Task | null; // the stored task (it may have changed under the run)
  save: (t: Task) => void;
  onStep?: (t: Task, step: { index: number; total: number; name: string }) => void;
  onToken?: (text: string) => void;
  onRecorded?: (t: Task, step: StepResult, finished: boolean) => void;
  onChat?: (p: { stop?: () => void }) => void; // the step in flight, so it can be stopped
  stopped?: () => boolean;
};

/**
 * Runs a project's remaining steps with `chat`, one after the other, saving after each;
 * resumes a run in progress. Resolves with the stored task: finished, or where it stopped
 * (stopped() turned true, or a step failed, in which case it throws after saving).
 */
export async function runPipeline(id: string, d: PipelineDeps): Promise<Task | null> {
  const now = d.now ?? Date.now;
  let t = d.load(id);
  if (!t) return null;
  t = startRun(t, d.key, now(), d.model);
  d.save(t);
  for (;;) {
    if (d.stopped?.()) return t;
    const req = nextRequest(t, d.thinking);
    if (!req) return t;
    d.onStep?.(t, { index: req.index, total: req.total, name: req.name });
    let text = '';
    const p = d.chat(req.messages, (tok) => {
      text += tok;
      d.onToken?.(text);
    }, { maxTokens: req.maxTokens, temperature: 0.7, reset: true });
    d.onChat?.(p);
    const r = await p;
    if (d.stopped?.()) return t; // stopped under the step: it is not counted
    const fresh = d.load(id) ?? t;
    const out = recordStep({ ...fresh, run: t.run }, { text, tokens: r.tokens, ms: r.ms, device: r.device }, now(), d.doneKey);
    t = out.task;
    d.save(t);
    const steps = out.finished ? t.last!.steps : t.run!.steps;
    d.onRecorded?.(t, steps[steps.length - 1], out.finished);
    if (out.finished) return t;
  }
}
