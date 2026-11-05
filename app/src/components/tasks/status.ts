import type { Key } from '@/i18n/dict';
import { inWindow } from '@/night/SimulatedWorker';
import { hhmm, nextStart, stateOf } from '@/tasks/schedule';
import { stepsOf } from '@/tasks/prompts';
import type { NowState } from '@/tasks/runNow';
import type { Task } from '@/tasks/types';

type T = (k: Key, v?: Record<string, string | number>) => string;

/** When the project runs next, in words: now, tonight 23:00, tomorrow 01:00, in 3 days. */
export function whenText(task: Task, now: Date, t: T): string {
  const at = nextStart(task, now);
  if (!at) return t('task.when.never');
  if (at.getTime() <= now.getTime() && inWindow(task.from, task.to, now)) return t('task.when.now');
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days <= 0) return t('task.when.tonight', { at: hhmm(at) });
  if (days === 1) return t(at.getHours() < 12 ? 'task.when.tonight' : 'task.when.tomorrow', { at: hhmm(at) });
  return t('task.when.later', { n: days, at: hhmm(at) });
}

/** The project's one status line. */
export function statusText(task: Task, now: Date, run: NowState, t: T): string {
  const s = stateOf(task, run && !run.error ? run.id : null);
  const n = stepsOf(task).length;
  if (s === 'running') return t('task.state.running', { i: (run?.index ?? 0) + 1, n: run?.total || n });
  if (s === 'started') return t('task.state.started', { i: task.run!.steps.length, n });
  if (s === 'off') return t('task.state.off');
  if (s === 'finished') return t('task.state.finished');
  if (s === 'ready') return `${t('task.state.ready')} · ${t('task.state.waiting', { when: whenText(task, now, t) })}`;
  return t('task.state.waiting', { when: whenText(task, now, t) });
}

export const summaryText = (task: Task, t: T) => t('task.summary', { from: task.from, to: task.to, days: t(`task.days.${task.days}` as Key), depth: t(`task.depth.${task.depth}` as Key).split(' · ')[0] });
