import { inWindow } from '@/night/SimulatedWorker';
import { windowKey } from '@/night/report';
import type { Task } from './types';

// When does a project run? Pure functions over a task and the clock.
//
// A project has its own hours (from–to, crossing midnight or not) and its nights. A night is
// named by the date its window opened on (night/report.ts windowKey), so "weekdays" means
// windows that open monday to friday, and a run finished at 02:00 counts for the night that
// began the evening before. A project is due when its window is open, the night is one of
// its nights, it was not finished in this night yet (lastDoneKey), a once-project has not
// run, it is switched on, and the phone is on charge when the project asks for that.

export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
/** The window's length in minutes (from = to is a whole day). */
export function windowMinutes(from: string, to: string): number {
  const d = minutesOf(to) - minutesOf(from);
  return d > 0 ? d : d + 24 * 60;
}
export const taskKey = (t: Pick<Task, 'from' | 'to'>, now: Date) => windowKey(t.from, t.to, now);

/** Is the night with this key one of the project's nights? */
export function nightOk(t: Pick<Task, 'days'>, key: string): boolean {
  if (t.days !== 'weekdays') return true;
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow >= 1 && dow <= 5;
}

/** Due now: its window open, its night, not done in this night, switched on, the plug. */
export function isDue(t: Task, now: Date, charging: boolean): boolean {
  if (!t.active) return false;
  if (t.days === 'once' && t.finished) return false;
  if (t.chargeOnly && !charging) return false;
  if (!inWindow(t.from, t.to, now)) return false;
  const key = taskKey(t, now);
  if (!nightOk(t, key)) return false;
  return t.lastDoneKey !== key;
}

/** The projects due now, a run already begun first (it is nearest its end), then oldest first. */
export function dueTasks(list: Task[], now: Date, charging: boolean): Task[] {
  return list.filter((t) => isDue(t, now, charging)).sort((a, b) => Number(!!b.run) - Number(!!a.run) || a.createdAt - b.createdAt);
}

/** When the project's next window opens from now (now itself when it is open and due
 * apart from the plug); null for a project that will not run again (once and done, off). */
export function nextStart(t: Task, now: Date): Date | null {
  if (!t.active || (t.days === 'once' && t.finished)) return null;
  const from = minutesOf(t.from);
  for (let i = -1; i <= 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, Math.floor(from / 60), from % 60);
    const end = new Date(d.getTime() + windowMinutes(t.from, t.to) * 60_000);
    if (end <= now) continue;
    const key = taskKey(t, d);
    if (!nightOk(t, key) || t.lastDoneKey === key) continue;
    return d < now ? now : d;
  }
  return null;
}

/** The projects whose answer came in since `since` (ms), newest first: the morning
 * report's list. */
export function doneSince(list: Task[], since: number): Task[] {
  return list.filter((t) => t.last && t.last.at >= since).sort((a, b) => b.last!.at - a.last!.at);
}

export type TaskState = 'running' | 'started' | 'ready' | 'waiting' | 'off' | 'finished';
/** What a project's row says: its step on the phone now, a run begun, an answer, waiting
 * for its hours, switched off, or a once-project that has run. */
export function stateOf(t: Task, runningId: string | null): TaskState {
  if (runningId === t.id) return 'running';
  if (t.run && t.run.steps.length) return 'started';
  if (!t.active) return 'off';
  if (t.days === 'once' && t.finished) return 'finished';
  if (t.last && !t.run) return 'ready';
  return 'waiting';
}

const two = (n: number) => String(n).padStart(2, '0');
export const hhmm = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
