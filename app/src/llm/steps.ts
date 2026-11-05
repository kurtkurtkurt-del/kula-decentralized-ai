// The first-run ladder (5.11.2026): measure → download → run → join. A pure function of
// what the phone has, so the bar on the models tab and its tests agree. The bar hides
// for good once every rung is done (kv 'ux.steps.done').
export type Step = 'measure' | 'download' | 'run' | 'join';
export const STEPS: Step[] = ['measure', 'download', 'run', 'join'];

export type StepFacts = {
  passport: boolean;   // this phone measured
  models: number;      // models on disk
  downloading: boolean;
  ran: boolean;        // a model was loaded at least once (now or before)
  peers: number;       // devices connected
};

export type Ladder = { current: Step | null; done: Step[]; allDone: boolean; index: number };

export function ladder(f: StepFacts): Ladder {
  const done: Step[] = [];
  if (f.passport) done.push('measure');
  if (f.models > 0) done.push('download');
  if (f.ran) done.push('run');
  if (f.peers > 0) done.push('join');
  const current = STEPS.find((s) => !done.includes(s)) ?? null;
  return { current, done, allDone: current === null, index: current ? STEPS.indexOf(current) : STEPS.length };
}

/** Where the "next" link on the bar goes for a step. */
export function stepRoute(step: Step, firstModelId: string | null): string {
  switch (step) {
    case 'measure': return '/passport';
    case 'download': return '/models';
    case 'run': return firstModelId ? `/model/${encodeURIComponent(firstModelId)}` : '/models';
    case 'join': return '/peers';
  }
}
