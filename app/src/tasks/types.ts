// Projects (5.11.2026): the person's own night work. A project is a question or a job
// written once ("what do you want"), with the form and length of the answer it wants, and
// a calibration for the night: its own hours, which nights, how carefully, on which model,
// only on charge. The phone runs it in those hours with the model on this phone (the night
// machinery, src/night/) and keeps everything here: the kv-store for the records
// (tasks/store.ts), the app's document folder for the photos (tasks/photos.ts). Nothing of
// it goes to a server.
//
// The code says "task" (src/tasks, app/task/…) because "project" already names the
// network's projects (data/projects.ts, app/project/[slug].tsx); the screens say projects.

/** The answer's form. */
export type Form = 'summary' | 'long' | 'list' | 'code' | 'plan';
export const FORMS: Form[] = ['summary', 'long', 'list', 'code', 'plan'];
/** The answer's length. */
export type Length = 'short' | 'medium' | 'long';
export const LENGTHS: Length[] = ['short', 'medium', 'long'];
/** Which nights: every night, the nights that open monday to friday, the next one only. */
export type Days = 'every' | 'weekdays' | 'once';
export const DAYS: Days[] = ['every', 'weekdays', 'once'];
/** How carefully: one pass; draft → critique → final; two critique rounds. */
export type Depth = 'quick' | 'careful' | 'very';
export const DEPTHS: Depth[] = ['quick', 'careful', 'very'];

/** The steps of a run. quick: answer · careful: draft, critique, final · very: draft,
 * critique, revise, critique2, final. */
export type StepName = 'answer' | 'draft' | 'critique' | 'revise' | 'critique2' | 'final';
export const STEPS: Record<Depth, StepName[]> = {
  quick: ['answer'],
  careful: ['draft', 'critique', 'final'],
  very: ['draft', 'critique', 'revise', 'critique2', 'final'],
};
export const isCritique = (s: StepName) => s === 'critique' || s === 'critique2';

/** One finished step: what the model wrote (its thinking taken out), tokens, time. */
export type StepResult = { name: StepName; text: string; tokens: number; ms: number; at: number; device?: string };

/** A run in progress: the steps so far are kept, so a run cut by the plug or the window
 * goes on from the next step the next time. */
export type Run = { id: string; key: string; startedAt: number; steps: StepResult[]; note?: string; model?: string; photos?: RunPhotos };

/** A run's photos (10.11.2026): how many, and the vision model that read them (null: none
 * could, the run went on the text alone; the morning report says so). */
export type RunPhotos = { n: number; by: string | null };

/** A vision model's reading of the project's photos (llm/vision.ts), kept until the photos
 * change: `photos` is the list it read. */
export type TaskSeen = { photos: string[]; text: string; by: string; at: number };

/** The last finished run: the answer and the work behind it. */
export type Done = { runId: string; at: number; key: string; answer: string; steps: StepResult[]; tokens: number; seconds: number; model?: string; note?: string; photos?: RunPhotos };

export type Task = {
  id: string;
  title: string;
  prompt: string; // "what do you want"
  photos: string[]; // file uris in the app's document folder; a vision model reads them before a run (seen)
  seen?: TaskSeen | null;
  form: Form;
  length: Length;
  // the calibration
  from: string; // "HH:MM"
  to: string;
  days: Days;
  depth: Depth;
  modelId: string | null; // null: the best model on this phone that fits, picked at the run
  chargeOnly: boolean;
  active: boolean; // off: it waits, nothing runs
  // the state
  note?: string; // "run again tonight" with a note: goes into the next run
  run: Run | null;
  last: Done | null;
  lastDoneKey: string | null; // the night (window key) a run was last finished in
  finished: boolean; // a once-project that has run
  runs: number;
  createdAt: number;
  updatedAt: number;
};

export type TaskInput = Pick<Task, 'title' | 'prompt' | 'photos' | 'form' | 'length' | 'from' | 'to' | 'days' | 'depth' | 'modelId' | 'chargeOnly'>;
