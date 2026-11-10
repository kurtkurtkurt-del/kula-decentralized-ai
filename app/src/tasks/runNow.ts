import { useEffect, useState } from 'react';
import { lastPassport } from '@/data/passport';
import { chat, engine, load } from '@/llm/engine';
import { fitOn } from '@/llm/fit';
import { note } from '@/llm/brainlog';
import { fitBudget } from '@/night/LlamaWorker';
import { scheduler } from '@/night/useNight';
import { wordsOf } from './jobs';
import { modelFor } from './models';
import { isThinking } from './prompts';
import { runPipeline } from './run';
import { PROJECT_CTX, holdNight, readPhotosOf } from './night';
import { getTask, saveTask } from './store';
import type { Task } from './types';

// "run now": the same steps as at night, while the app is open, with the progress on the
// project's page. The project's model is loaded alone when it is not the one in memory.
// One run at a time, and not while the night's worker has the model (it would take it
// away): then the project waits for its night. Stopping keeps the finished steps.

export type NowState = { id: string; index: number; total: number; step: string; text: string; error?: string } | null;
let state: NowState = null;
let stop: (() => void) | null = null;
let cancelled = false;
const listeners = new Set<() => void>();
const set = (s: NowState) => {
  state = s;
  listeners.forEach((fn) => fn());
};
export const nowState = () => state;
export function useRunNow(): NowState {
  const [s, setS] = useState(state);
  useEffect(() => {
    const fn = () => setS(state);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return s;
}

export function stopNow() {
  cancelled = true;
  stop?.();
}

/** Runs the project now. Throws 'busy' (a run or the night is on), 'nomodel', or the step's error. */
export async function runNow(id: string): Promise<Task | null> {
  if (state && !state.error) throw new Error('busy');
  if (scheduler.state().phase === 'running') throw new Error('night');
  const t = getTask(id);
  if (!t) return null;
  const m = modelFor(t);
  if (!m) throw new Error('nomodel');
  cancelled = false;
  set({ id, index: 0, total: 0, step: '', text: '' });
  holdNight(true);
  try {
    // photos first: the vision model reads them (next to the loaded model, or in its place)
    await readPhotosOf(id);
    if (engine().model?.id !== m.id) {
      const p = lastPassport();
      const fit = fitOn(p, { size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx: PROJECT_CTX });
      await load(m, 'alone', p ? Math.min(PROJECT_CTX, Math.max(512, fit.maxCtx || 512)) : 4096, []);
    }
    const thinking = isThinking(m.id);
    const out = await runPipeline(id, {
      chat: (messages, onToken, opts) => chat(messages, onToken, { ...opts, maxTokens: fitBudget(opts.maxTokens, messages, engine().load?.ctx ?? 0) }),
      thinking,
      model: m.name,
      key: 'now',
      doneKey: null,
      load: getTask,
      save: saveTask,
      stopped: () => cancelled,
      onChat: (p) => {
        stop = p.stop ?? null;
      },
      onStep: (_t, s) => set({ id, index: s.index, total: s.total, step: s.name, text: '' }),
      onToken: (text) => state && set({ ...state, text }),
      onRecorded: (task, step, finished) => {
        note({ at: Date.now(), kind: 'night', key: `brain.task.step.${step.name}`, vars: { title: task.title, i: (finished ? task.last!.steps.length : task.run!.steps.length), n: state?.total ?? 0, tokens: step.tokens, device: (step.device ?? '').toLowerCase() }, tone: 'info' });
        if (finished) note({ at: Date.now(), kind: 'night', key: 'brain.task.done', vars: { title: task.title, tokens: task.last!.tokens, words: wordsOf(task.last!.answer) }, tone: 'ok' });
      },
    });
    set(null);
    return out;
  } catch (e) {
    const why = (e as Error).message;
    note({ at: Date.now(), kind: 'error', key: 'brain.task.failed', vars: { title: t.title }, detail: why, tone: 'bad' });
    set({ id, index: state?.index ?? 0, total: state?.total ?? 0, step: state?.step ?? '', text: '', error: why });
    throw e;
  } finally {
    stop = null;
    holdNight(false);
  }
}
export const clearNowError = () => state?.error && set(null);
