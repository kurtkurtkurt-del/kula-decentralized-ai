// The night worker: what runs while the phone is on charge in the night window.
//
// Two implementations behind one interface. SimulatedWorker (the first, 20.10.2026): no
// model runs; every 10 s a small calculation, the counter moves by the passport's est_tps.
// LlamaWorker (5.11.2026): a real model on this phone and its paired devices, apart mode,
// units of work from a JobSource (jobs.ts). useNight.ts picks one: the real one when the
// native module and a local model exist, the simulation otherwise.
//
// The worker only runs while the app is in the foreground with the screen on: there is
// no background service at this stage (the real one keeps the screen on itself).
export type NightDevice = { id: string; name: string; tokens: number; units: number; out?: boolean };
export type NightStatus = {
  state: 'idle' | 'waiting' | 'running' | 'done';
  // why it waits: outside the window, not on charge, not on wi-fi, nothing kept, no passport
  reason?: 'window' | 'charge' | 'wifi' | 'noproject' | 'nopassport';
  slug: string | null;
  startedAt: number | null;
  tokens: number;
  seconds: number;
  kwh: number;
  tps: number;
  // added 5.11.2026 by the real worker; the simulation leaves them out
  real?: boolean;
  model?: string;
  units?: number;   // units finished
  checked?: number; // known-answer units among them
  wrong?: number;   // known-answer units that came out wrong
  devices?: NightDevice[];
};
export type NightWorker = {
  start(slug: string, tps: number): void;
  stop(): void;
  status(): NightStatus;
  // called on every change
  subscribe(fn: (s: NightStatus) => void): () => void;
};
export const WATTS = 4;        // this phone, on charge, working
export const PEER_WATTS = 2;   // each extra device, counted on this phone's card
