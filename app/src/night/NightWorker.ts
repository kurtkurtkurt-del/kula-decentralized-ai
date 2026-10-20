// The night worker: what runs while the phone is on charge in the night window.
//
// Today there is one implementation, SimulatedWorker: no model runs; every 10 s it does
// a small calculation and moves the token counter by the passport's est_tps, and it
// accumulates seconds and kWh (4 W assumed). The real one, a llama.cpp rpc-server
// started by a native module, replaces it behind the same interface (TODO, marked there).
//
// The worker only runs while the app is in the foreground with the screen on: there is
// no background service at this stage.
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
};
export type NightWorker = {
  start(slug: string, tps: number): void;
  stop(): void;
  status(): NightStatus;
  // called on every change
  subscribe(fn: (s: NightStatus) => void): () => void;
};
export const WATTS = 4;
