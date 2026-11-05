import { engine } from '@/llm/engine';
import { note } from '@/llm/brainlog';
import { t as tr } from '@/i18n/core';
import { ProjectJobs, wordsOf } from './jobs';
import { modelFor } from './models';
import { notifyTaskDone } from './notify';
import { isThinking } from './prompts';
import { dueTasks } from './schedule';
import { getTask, listTasks, saveTask } from './store';

// The projects wired into the night (night/useNight.ts): is one due (the conditions'
// projectWindow), which model and context the night should load for them, and the job
// source the worker takes their steps from. The plug is the one fact the job source needs
// from the conditions; it is kept from their last reading.
let charging = false;
let held = false;
/** "run now" holds the night back while it has the model (night/scheduler.ts hold). */
export const holdNight = (on: boolean) => {
  held = on;
};
export const nightHeld = () => held;
const due = () => dueTasks(listTasks(), new Date(), charging);

/** For the conditions: a project is due now (and the phone can run a model). */
export const makeOwnDue = (canRun: () => boolean) => (now: Date, isCharging: boolean) => {
  charging = isCharging;
  return canRun() && dueTasks(listTasks(), now, isCharging).length > 0;
};
/** The model the first project due asked for (or the best that fits), for the night's load. */
export const preferredModel = (): string | null => {
  const d = due()[0];
  return d ? (modelFor(d)?.id ?? null) : null;
};
/** A larger context while projects are due: their drafts and critiques are long. */
export const PROJECT_CTX = 8192;
export const wantedCtx = (): number | null => (due().length ? PROJECT_CTX : null);

export function projectJobs(): ProjectJobs {
  return new ProjectJobs({
    list: listTasks,
    load: getTask,
    save: saveTask,
    now: Date.now,
    charging: () => charging,
    thinking: () => isThinking(engine().model?.id),
    model: () => engine().model?.name,
    log: note,
    onFinished: (t) => void notifyTaskDone(t.id, tr('task.notify.title', { title: t.title }), tr('task.notify.body', { n: wordsOf(t.last?.answer ?? '') })),
  });
}
