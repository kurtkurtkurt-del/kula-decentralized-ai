import type { BrainEntry } from '@/llm/brainlog';
import type { Seen } from '@/llm/photos';
import { seenFor } from './prompts';
import type { Task } from './types';

// A project's photos, read before its run (10.11.2026). The chosen vision model (llm/vision.ts
// chosenVision, the "vision model" setting) describes them once; the reading is kept on the
// project (task.seen) until the photos change, and goes into every step's prompt
// (tasks/prompts.ts). The night calls this before it loads its model (nothing else in RAM),
// "run now" before the project's model is loaded. Without a vision model the photos are
// kept, the run goes on the text alone, and the brain log and the morning report say so.

export type SeenDeps = {
  describe: (uris: string[], question: string) => Promise<Seen>; // throws 'novision'
  save: (t: Task) => void;
  log: (e: BrainEntry) => void;
  now: () => number;
};

/** The task with its photos read (unchanged when there are none, they were read already, or nothing can read them). */
export async function readTaskPhotos(t: Task, d: SeenDeps): Promise<Task> {
  if (!t.photos.length || seenFor(t)) return t;
  try {
    const s = await d.describe(t.photos, t.prompt);
    const next: Task = { ...t, seen: { photos: [...t.photos], text: s.text, by: s.by, at: d.now() } };
    d.save(next);
    d.log({ at: d.now(), kind: 'night', key: 'brain.vision.task', vars: { model: s.by, title: t.title }, tone: 'ok' });
    return next;
  } catch (e) {
    const why = (e as Error).message;
    if (why === 'novision') d.log({ at: d.now(), kind: 'night', key: 'brain.vision.none', vars: { title: t.title }, tone: 'warn' });
    else d.log({ at: d.now(), kind: 'error', key: 'brain.vision.taskFailed', vars: { title: t.title }, detail: why, tone: 'bad' });
    return t;
  }
}

/** Every task in `list` read, one after the other (the night's due projects). */
export async function readAllPhotos(list: Task[], d: SeenDeps): Promise<number> {
  let read = 0;
  for (const t of list) if ((await readTaskPhotos(t, d)) !== t) read++;
  return read;
}
