// What the four deciding branches (planner, executor, models, advisor) share: where a model can
// run and about how fast, from one look, and the hysteresis that keeps their cards steady.
//
// The maths is a small copy of kula's planner (node/src/sim.ts, docs/PLANNER.md), since the eye
// imports nothing of kula. A decode step streams the model's (active) weights once, so
//   tok/s = what a device streams per second ÷ the GB one token reads.
// What a device streams comes from a tok/s it really answered with on any model (the planner keeps
// those, from the loaded model's live tok/s) or, failing that, from the memory bandwidth it measured
// × kula's efficiency (0.6, a computer as a worker 0.3). This computer's bandwidth is not in the
// look: until a model ran here its speed is "not measured yet", and no card quotes a number for it.
// A split runs its layers one device after the other, so its token is the sum of each device's
// part plus a hop per worker; the bytes go to the fastest device first, as sim.ts does.
import type { BranchCtx, DeviceHint, EyeDevice, EyeModel, Snapshot, SuggestAction, Suggestion } from '../types.js';
import { active } from './util.js';

export const LOCAL_SHARE = 0.7;    // sim.ts: of this computer's free memory a model may take
export const WORKER_SHARE = 0.75;  // sim.ts: of a device's advertised free memory
export const EFF = 0.6;            // sim.ts DEFAULT_EFF: the share of its bandwidth a decode step streams
export const PC_EFF = 0.3;         // planner.ts: a computer as a worker (measured on a mac m1)
export const GAIN = 1.15;          // sim.ts GAIN_TO_SHARE: "faster" means at least this much faster
export const HOP_MS = 10;          // per worker per token: 3 round trips of 3 ms (planner.ts net) and the activation
export const SLACK = 1.05;         // a card that shows stays while its reason holds within this much
export const SHOW = 3;             // looks a reason must hold before its card shows
export const HIDE = 4;             // looks a reason must be gone before its card goes
const MB = 1024 * 1024;

/** what a device streams per decode step, in GB/s, and where that number comes from */
export interface Speed { gbs: number; from: 'measured' | 'bandwidth' }
/** a place a model can run: a device, or this computer ("local") */
export interface Seat {
  id: string; name: string; local: boolean; kind: string;
  via: EyeDevice['via'] | 'here';
  ramMb: number;                    // what it said it has free (this computer: free plus what the loaded model holds here)
  capMb: number;                    // what a model may take there (× the share)
  speed: Speed | null;
  tonight: DeviceHint['tonight'] | null;
}
/** a device the deciding branches leave out, and why */
export interface Barred { id: string; name: string; why: string }
export interface Field { seats: Seat[]; barred: Barred[]; measured: Map<string, Measured[]> }
export interface Measured { file: string; tps: number; n: number }

/** a model as the look names it: by id, file or name */
export const modelOf = (s: Snapshot, key: string | null | undefined): EyeModel | null =>
  key ? s.models.find((m) => m.id === key || m.file === key || m.name === key) ?? null : null;

/** the GB one token reads: the file (+5%, as sim.ts), the active share of a mixture of experts */
export function readGb(m: { size: number; params_b?: number | null; active_b?: number | null }): number | null {
  if (!(m.size > 0)) return null;
  const share = m.params_b && m.active_b && m.active_b > 0 && m.active_b < m.params_b ? m.active_b / m.params_b : 1;
  return ((m.size / MB) * 1.05 * share) / 1024;
}

/** the MB the loaded model takes on this computer now (it is back in the free memory once it goes) */
export function heldHere(s: Snapshot): number {
  const L = s.work.loaded;
  if (!L) return 0;
  if (L.parts?.length) return L.parts.filter((p) => p.local).reduce((t, p) => t + p.mb, 0);
  if (L.mode === 'here' || L.devices.some((d) => d.local)) return modelOf(s, L.model.id)?.needMb ?? modelOf(s, L.model.file)?.needMb ?? Math.round(L.model.size / MB);
  return 0;
}

/** the hints other branches gave, by device id */
export function hintsOf(ctx: Pick<BranchCtx, 'peek'>): Map<string, DeviceHint[]> {
  const out = new Map<string, DeviceHint[]>();
  for (const id of ['forecast', 'limits', 'planner'] as const) {
    const hs = ctx.peek(id)?.hints;
    if (!Array.isArray(hs)) continue;
    for (const h of hs) if (h && typeof h.id === 'string') out.set(h.id, [...(out.get(h.id) ?? []), h]);
  }
  return out;
}

/** the devices trust says no to: a bad verdict, with its first failed check */
export function untrusted(ctx: Pick<BranchCtx, 'peek'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of ctx.peek('trust')?.report?.devices ?? []) {
    if (d.verdict !== 'bad') continue;
    const c = d.checks.find((x) => x.ok === false);
    out.set(d.id, `trust says no${c ? `: ${c.text}` : ''}`);
  }
  return out;
}

/** a device's best speed: measured tok/s on a model the look knows (the most answers behind it), else its bandwidth */
function speedOf(s: Snapshot, id: string, kind: string, bw: number | null, measured: Measured[] | undefined): Speed | null {
  let best: { gbs: number; n: number } | null = null;
  for (const x of measured ?? []) {
    const m = s.models.find((y) => y.file === x.file);
    const gb = m ? readGb(m) : null;
    if (!gb || !(x.tps > 0)) continue;
    if (!best || x.n > best.n) best = { gbs: x.tps * gb, n: x.n };
  }
  if (best) return { gbs: best.gbs, from: 'measured' };
  if (bw && bw > 0) return { gbs: bw * (kind === 'pc' ? PC_EFF : EFF), from: 'bandwidth' };
  return null;
}

/** every seat a model could take now: reachable, paired, its free memory known, nobody saying no */
export function field(s: Snapshot, ctx: Pick<BranchCtx, 'peek'>, measured?: Map<string, Measured[]>): Field {
  const hints = hintsOf(ctx);
  const trust = untrusted(ctx);
  // the measured speeds: the planner's own notes, or what it handed the others
  let speeds = measured;
  if (!speeds) {
    speeds = new Map();
    for (const [id, hs] of hints) for (const h of hs) if (h.tps?.length) speeds.set(id, h.tps);
  }
  const seats: Seat[] = [];
  const barred: Barred[] = [];
  const tonightOf = (id: string) => hints.get(id)?.find((h) => h.tonight)?.tonight ?? null;
  const noOf = (id: string) => trust.get(id) ?? hints.get(id)?.find((h) => h.no)?.no ?? null;
  for (const d of s.devices) {
    if (!active(d) || d.waitingPair || !(d.ramMb != null && d.ramMb > 0)) continue;
    const no = noOf(d.id);
    if (no) { barred.push({ id: d.id, name: d.name, why: no }); continue; }
    seats.push({ id: d.id, name: d.name, local: false, kind: d.kind, via: d.via, ramMb: d.ramMb, capMb: Math.floor(d.ramMb * WORKER_SHARE), speed: speedOf(s, d.id, d.kind, d.bwGBs, speeds.get(d.id)), tonight: tonightOf(d.id) });
  }
  if (s.work.llama && s.host.freeMb != null && s.host.freeMb > 0) {
    const no = hints.get('local')?.find((h) => h.no)?.no ?? null;
    const ram = s.host.freeMb + heldHere(s);
    if (no) barred.push({ id: 'local', name: 'this computer', why: no });
    else seats.push({ id: 'local', name: 'this computer', local: true, kind: 'pc', via: 'here', ramMb: ram, capMb: Math.floor(ram * LOCAL_SHARE), speed: speedOf(s, 'local', 'pc', null, speeds.get('local')), tonight: null });
  }
  return { seats, barred, measured: speeds };
}

/** about how many tok/s this seat answers this model with, or null when not measured yet */
export function tpsOn(seat: Seat, m: EyeModel): number | null {
  const gb = readGb(m);
  return seat.speed && gb ? Math.round((seat.speed.gbs / gb) * 10) / 10 : null;
}

/** may this seat run the model whole: phones fetch catalog models, this computer a catalog one or its own file */
export const canAlone = (seat: Seat, m: EyeModel, slack = 1) =>
  m.needMb > 0 && m.needMb <= seat.capMb * slack && (seat.local ? m.catalog || m.here : m.catalog);
/** may it run its own copy in apart mode: a catalog model, and this computer only with the file here */
export const canApart = (seat: Seat, m: EyeModel, slack = 1) =>
  m.catalog && m.needMb > 0 && m.needMb <= seat.capMb * slack && (!seat.local || m.here);

/** a placement of one model, with what it would do and the action that loads it */
export interface Place {
  mode: 'phone' | 'here' | 'apart' | 'split';
  seats: Seat[];
  tps: number | null;               // one answer's speed: the fastest seat (apart) or the chain (split); null: not measured yet
  shares?: { seat: Seat; mb: number }[];
  action: SuggestAction;
}

const loadAction = (m: EyeModel, mode: Place['mode'], seats: Seat[]): SuggestAction =>
  ({ do: 'load', model: m.id, mode, devices: seats.filter((x) => !x.local).map((x) => x.id) });

/** the fastest seat that runs it whole (unknown speeds last, then the most room) */
export function alone(f: Field, m: EyeModel, slack = 1): Place | null {
  const fit = f.seats.filter((x) => canAlone(x, m, slack))
    .sort((a, b) => (tpsOn(b, m) ?? -1) - (tpsOn(a, m) ?? -1) || b.capMb - a.capMb);
  const seat = fit[0];
  if (!seat) return null;
  const mode = seat.local ? 'here' : 'phone';
  return { mode, seats: [seat], tps: tpsOn(seat, m), action: loadAction(m, mode, [seat]) };
}

/** a copy on every seat that holds it: as many answers at once as seats */
export function apart(f: Field, m: EyeModel, slack = 1): Place | null {
  const fit = f.seats.filter((x) => canApart(x, m, slack));
  if (fit.length < 2) return null;
  const known = fit.map((x) => tpsOn(x, m)).filter((x): x is number => x != null);
  return { mode: 'apart', seats: fit, tps: known.length ? Math.max(...known) : null, action: loadAction(m, 'apart', fit) };
}

/** one model across this computer and the devices near it (never a relay), the bytes on the
 *  fastest first; the fewest workers that give the shortest token, or that fit when a speed is unknown */
export function split(f: Field, m: EyeModel, slack = 1): Place | null {
  const host = f.seats.find((x) => x.local);
  if (!host || !(m.catalog || m.here) || !(m.needMb > 0)) return null;
  const gb = readGb(m);
  const speed = (x: Seat) => x.speed?.gbs ?? -1;
  const workers = f.seats.filter((x) => !x.local && x.via !== 'relay').sort((a, b) => speed(b) - speed(a) || b.capMb - a.capMb);
  let best: Place | null = null;
  let bestMs = Infinity;
  for (let k = 1; k <= workers.length; k++) {
    const devs = [host, ...workers.slice(0, k)];
    if (devs.reduce((t, x) => t + x.capMb * slack, 0) < m.needMb) continue;
    let left = m.needMb;
    const shares = [...devs].sort((a, b) => speed(b) - speed(a)).map((seat) => {
      const mb = Math.min(seat.capMb * slack, left);
      left -= mb;
      return { seat, mb };
    }).filter((x) => x.mb > 0 || x.seat.local);
    const used = shares.filter((x) => !x.seat.local && x.mb > 0);
    if (!used.length) continue;   // the host alone holds it: that is not a split
    const known = gb != null && shares.every((x) => x.mb === 0 || x.seat.speed);
    const ms = known ? shares.reduce((t, x) => t + (x.mb > 0 ? ((x.mb / m.needMb) * gb! * 1000) / x.seat.speed!.gbs : 0), 0) + used.length * HOP_MS : null;
    const place: Place = { mode: 'split', seats: [host, ...used.map((x) => x.seat)], tps: ms ? Math.round((1000 / ms) * 10) / 10 : null, shares, action: loadAction(m, 'split', used.map((x) => x.seat)) };
    if (ms == null) { if (!best) best = place; break; }   // speeds unknown: the fewest that fit
    if (ms < bestMs) { best = place; bestMs = ms; }
  }
  return best;
}

// ---- words

export const gb1 = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
export const tpsWord = (t: number | null) => (t == null ? 'speed not measured yet' : `~${t >= 10 ? Math.round(t) : t} tok/s`);
export const names = (xs: { name: string }[]) => {
  const n = xs.map((x) => x.name);
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};
/** "the Mac" for this computer when it has a name, else the device's own name */
export const seatName = (s: Snapshot, x: { local: boolean; name: string }) => (x.local ? s.host.name || 'this computer' : x.name);

/** a card id: "<branch>:<topic>", the topic cut to the chars the eye accepts */
export const cardId = (branch: string, ...topic: string[]) => `${branch}:${topic.join(':').replace(/[^\w.:@/-]/g, '_').slice(0, 100)}`;

// ---- hysteresis: a card shows once its reason held SHOW looks running and goes once it was gone
// HIDE looks running. Each branch says its reasons twice: strict (to show) and with SLACK (to stay),
// so a number hovering at a threshold neither brings a card nor takes it away.

export class Steady {
  private on = new Map<string, { card: Suggestion; off: number }>();
  private rising = new Map<string, number>();

  /** this look's reasons: `enter` the strict ones, `stay` the relaxed ones; the cards to show now */
  step(enter: Suggestion[], stay: Suggestion[]): Suggestion[] {
    const strict = new Map(enter.map((c) => [c.id, c]));
    const loose = new Map(stay.map((c) => [c.id, c]));
    for (const [id, x] of [...this.on]) {
      const c = strict.get(id) ?? loose.get(id);
      if (c) { x.card = c; x.off = 0; }
      else if (++x.off >= HIDE) this.on.delete(id);
    }
    for (const id of [...this.rising.keys()]) if (!strict.has(id)) this.rising.delete(id);
    for (const [id, c] of strict) {
      if (this.on.has(id)) continue;
      const n = (this.rising.get(id) ?? 0) + 1;
      if (n >= SHOW) { this.on.set(id, { card: c, off: 0 }); this.rising.delete(id); }
      else this.rising.set(id, n);
    }
    return [...this.on.values()].map((x) => x.card).sort((a, b) => (b.weight ?? 2) - (a.weight ?? 2)).slice(0, 5);
  }

  /** the ids shown now */
  shown(): string[] { return [...this.on.keys()]; }
}
