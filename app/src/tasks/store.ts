import { useEffect, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import type { Task, TaskInput } from './types';

// The projects on this phone: one list in the kv-store under tasks.list, newest last.
// Never sent anywhere. Screens listen with useTasks / useTask; the night's job source and
// the run-now pipeline write through saveTask after every step, so a run survives the app
// being closed in the middle.
const KEY = 'tasks.list';
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((fn) => fn());

export function listTasks(): Task[] {
  try {
    const v = JSON.parse(Storage.getItemSync(KEY) ?? '[]');
    return Array.isArray(v) ? (v as Task[]) : [];
  } catch {
    return [];
  }
}
function write(list: Task[]) {
  try {
    Storage.setItemSync(KEY, JSON.stringify(list));
  } catch {}
  tell();
}
export const getTask = (id: string): Task | null => listTasks().find((t) => t.id === id) ?? null;

let seq = 0;
export const newId = (now = Date.now()) => `${now.toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;

// id: given when the photos were kept before the project existed (app/task/new.tsx)
export function createTask(input: TaskInput, now = Date.now(), id = newId(now)): Task {
  const t: Task = { ...input, id, active: true, run: null, last: null, lastDoneKey: null, finished: false, runs: 0, createdAt: now, updatedAt: now };
  write([...listTasks(), t]);
  return t;
}
/** Replaces the task with the same id (or adds it). */
export function saveTask(t: Task) {
  const list = listTasks();
  const i = list.findIndex((x) => x.id === t.id);
  if (i >= 0) list[i] = t;
  else list.push(t);
  write(list);
}
export function updateTask(id: string, patch: Partial<Task>, now = Date.now()): Task | null {
  const t = getTask(id);
  if (!t) return null;
  const next = { ...t, ...patch, id, updatedAt: now };
  saveTask(next);
  return next;
}
export function deleteTask(id: string) {
  write(listTasks().filter((t) => t.id !== id));
}

/** "run again tonight", with a note for the model: the night's mark is cleared (so it runs
 * again in tonight's window even after a finished run), a once-project is open again. */
export function runAgain(id: string, note: string, now = Date.now()): Task | null {
  return updateTask(id, { note: note.trim() || undefined, lastDoneKey: null, finished: false, active: true }, now);
}

export function useTasks(): Task[] {
  const [list, setList] = useState(listTasks);
  useEffect(() => {
    const fn = () => setList(listTasks());
    listeners.add(fn);
    fn();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return list;
}
export function useTask(id: string | undefined): Task | null {
  const list = useTasks();
  return id ? (list.find((t) => t.id === id) ?? null) : null;
}
