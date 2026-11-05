import { WATTS, type NightStatus, type NightWorker } from './NightWorker';

// The simulation: every TICK ms, a small matrix product (so the phone is really doing
// something and the counter does not move while the JS thread is asleep), then the
// counter grows by tps × seconds since the last tick, and the energy by 4 W.
//
// Kept (5.11.2026) for the builds without the native module or without a model on the
// phone; the real worker is LlamaWorker.ts, useNight.ts picks between them.
const TICK = 10_000;

export class SimulatedWorker implements NightWorker {
  private s: NightStatus = { state: 'idle', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private listeners = new Set<(s: NightStatus) => void>();

  start(slug: string, tps: number) {
    this.stop();
    this.last = Date.now();
    this.s = { state: 'running', slug, startedAt: this.last, tokens: 0, seconds: 0, kwh: 0, tps };
    this.tell();
    this.timer = setInterval(() => this.tick(), TICK);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.s.state === 'running') {
      this.tick();
      this.s = { ...this.s, state: 'done' };
      this.tell();
    }
  }
  reset() {
    this.stop();
    this.s = { state: 'idle', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0 };
    this.tell();
  }
  wait(reason: NonNullable<NightStatus['reason']>) {
    if (this.s.state === 'running') return;
    this.s = { ...this.s, state: 'waiting', reason };
    this.tell();
  }
  status() {
    return this.s;
  }
  subscribe(fn: (s: NightStatus) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private tell() {
    this.listeners.forEach((fn) => fn(this.s));
  }
  // The work: a 64×64 float product, three times. Trivial, on purpose: the point is a
  // heartbeat, not heat.
  private tick() {
    const now = Date.now();
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    work();
    this.s = {
      ...this.s,
      tokens: this.s.tokens + Math.round(this.s.tps * dt),
      seconds: this.s.seconds + Math.round(dt),
      kwh: this.s.kwh + (WATTS * dt) / 3600 / 1000,
    };
    this.tell();
  }
}

export function work() {
  const n = 64;
  const a = new Float32Array(n * n).map((_, i) => (i % 7) * 0.5);
  const b = new Float32Array(n * n).map((_, i) => (i % 5) * 0.25);
  const c = new Float32Array(n * n);
  for (let r = 0; r < 3; r++) for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) { const aik = a[i * n + k]; for (let j = 0; j < n; j++) c[i * n + j] += aik * b[k * n + j]; }
  return c[0];
}

// Is the clock inside the window? "23:00" → "07:30" crosses midnight.
export function inWindow(from: string, to: string, now = new Date()): boolean {
  const mins = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const t = now.getHours() * 60 + now.getMinutes();
  const a = mins(from), b = mins(to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}
