import Storage from 'expo-sqlite/kv-store';
import { DEMO_UNITS, DemoJobs, type JobSource, type Unit, type UnitResult } from './jobs';

// The night's pile, kept on the phone (night-2, 5.11.2026). A night is cut when the plug
// comes out or the battery drops; when it comes back the same night continues where it
// stopped. So the pile is not in memory only: every take, every result and every return
// is written to the kv-store under night.queue, with the key of the window the pile was
// made for. A unit that was taken and never finished (the worker was stopped under it)
// goes back to the front on the next start.
export type QueueState = { key: string; left: string[]; taken: string[]; done: number };
const QUEUE = 'night.queue';

export function readQueue(): QueueState | null {
  try {
    return JSON.parse(Storage.getItemSync(QUEUE) ?? 'null') as QueueState | null;
  } catch {
    return null;
  }
}
export const clearQueue = () => Storage.removeItemSync(QUEUE);
const write = (q: QueueState) => {
  try {
    Storage.setItemSync(QUEUE, JSON.stringify(q));
  } catch {}
};

/** The bundled units behind a pile that survives a stop. `key` names the night (the
 * window it belongs to); a saved pile with another key is thrown away. */
export class ResumableJobs implements JobSource {
  private q: QueueState;
  private byId: Map<string, Unit>;
  private inner: DemoJobs;
  constructor(key: string, units: Unit[] = DEMO_UNITS) {
    this.byId = new Map(units.map((u) => [u.id, u]));
    this.inner = new DemoJobs([]);
    const saved = readQueue();
    if (saved && saved.key === key) {
      // what was in flight when the worker stopped goes first
      this.q = { key, left: [...saved.taken, ...saved.left].filter((id) => this.byId.has(id)), taken: [], done: saved.done };
    } else {
      this.q = { key, left: units.map((u) => u.id), taken: [], done: 0 };
    }
    write(this.q);
  }
  left() {
    return this.q.left.length;
  }
  state(): QueueState {
    return { ...this.q, left: [...this.q.left], taken: [...this.q.taken] };
  }
  async next() {
    const id = this.q.left.shift();
    if (!id) return null;
    this.q.taken.push(id);
    write(this.q);
    return this.byId.get(id) ?? null;
  }
  async retry(unit: Unit) {
    this.q.taken = this.q.taken.filter((id) => id !== unit.id);
    this.q.left.unshift(unit.id);
    write(this.q);
  }
  async done(unit: Unit, result: UnitResult) {
    this.q.taken = this.q.taken.filter((id) => id !== unit.id);
    this.q.done++;
    write(this.q);
    await this.inner.done(unit, result); // the result itself goes where DemoJobs keeps them
  }
}
