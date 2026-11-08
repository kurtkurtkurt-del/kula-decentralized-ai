// 12 advisor: which model, which devices, which night, before you ask. It only suggests, in words;
// it never loads, moves or stops anything. Simple rules over one look:
//  - each reachable device's best model: the biggest whose needMb fits 75% of the memory it said
//    it has free (phones: catalog models, since a phone fetches its own copy); this computer
//    (when it has llama.cpp): 70% of its free memory, a model whose file is here or any catalog one.
//  - apart: the biggest model that two or more devices each fit (this computer only with the file
//    here, as kula's engine does): a copy on each, about 2× the answers at once.
//  - split: only a clearly bigger model (1.5× the best one device runs) that fits no device alone
//    but fits all of them together, led by this computer, never across a relay; slower per answer.
//  - what is loaded vs that: a bigger model that fits, a device that is reachable and idle.
//  - night: a waiting project's devices reachable now and its model fitting them; in the evening,
//    with nothing loaded and nothing planned, a suggestion for one.
// It may quote forecast, limits and review, but never depends on them.
import type { Branch, BranchCtx, BranchView, EyeDevice, EyeModel, Snapshot } from '../types.js';
import { active, gb, hhmm, pct } from './util.js';
import { masked } from './review.js';   // a project's title may hold personal data: shown masked, as review does

const PHONE_SHARE = 0.75;          // of the memory a device said it has free
const HOST_SHARE = 0.7;            // of this computer's free memory
const CLEARLY_BIGGER = 1.5;        // split must buy at least this much more model
const EVENING_FROM = 18;           // hours, this computer's clock
const EVENING_TO = 23;

/** a place a model can run: a device, or this computer */
export interface Seat { id: string; name: string; local: boolean; capMb: number; relay: boolean; holds: string | null }
interface Tip { pri: number; key: string; stat: string; line: string }

const seatsOf = (s: Snapshot): Seat[] => {
  const seats: Seat[] = s.devices
    .filter((d: EyeDevice) => active(d) && !d.waitingPair && d.ramMb != null && d.ramMb > 0)
    .map((d) => ({ id: d.id, name: d.name, local: false, capMb: Math.floor(d.ramMb! * PHONE_SHARE), relay: d.via === 'relay', holds: d.holds }));
  if (s.work.llama && s.host.freeMb != null && s.host.freeMb > 0) {
    seats.push({ id: 'local', name: 'this computer', local: true, capMb: Math.floor(s.host.freeMb * HOST_SHARE), relay: false, holds: null });
  }
  return seats;
};

/** may this seat run this model whole (apart = the way apart mode loads it) */
const canRun = (seat: Seat, m: EyeModel, apart = false) =>
  m.needMb > 0 && m.needMb <= seat.capMb && (seat.local ? (apart ? m.catalog && m.here : m.catalog || m.here) : m.catalog);

const bySize = (a: EyeModel, b: EyeModel) => b.needMb - a.needMb;
const names = (xs: Seat[]) => {
  const n = xs.map((x) => x.name);
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};
const countWord = (xs: Seat[]) => {
  const phones = xs.filter((x) => !x.local).length;
  const parts = [];
  if (phones) parts.push(`${phones} device${phones === 1 ? '' : 's'}`);
  if (xs.some((x) => x.local)) parts.push('this computer');
  return parts.join(' + ');
};
const where = (seat: Seat) => (seat.local ? 'here on this computer' : `on ${seat.name}`);

/** the model a loaded or planned id points at */
const modelOf = (s: Snapshot, idOrFile: string) => s.models.find((m) => m.id === idOrFile || m.file === idOrFile || m.name === idOrFile) ?? null;

export interface Advice {
  best: { seat: Seat; model: EyeModel }[];                 // per seat, its biggest model
  top: { seat: Seat; model: EyeModel } | null;             // the biggest of those
  apart: { model: EyeModel; seats: Seat[] } | null;
  split: { model: EyeModel; seats: Seat[]; sumMb: number } | null;
}

export function advise(s: Snapshot): Advice {
  const seats = seatsOf(s);
  const models = [...s.models].sort(bySize);
  const best = seats.flatMap((seat) => {
    const m = models.find((x) => canRun(seat, x));
    return m ? [{ seat, model: m }] : [];
  });
  const top = best.reduce<Advice['top']>((a, b) => (!a || b.model.needMb > a.model.needMb ? b : a), null);

  let apart: Advice['apart'] = null;
  for (const m of models) {
    if (!m.catalog) continue;
    const fit = seats.filter((seat) => canRun(seat, m, true));
    if (fit.length >= 2) { apart = { model: m, seats: fit }; break; }
  }

  let split: Advice['split'] = null;
  const host = seats.find((x) => x.local);
  if (host) {
    const near = seats.filter((x) => !x.relay);
    const sumMb = near.reduce((a, x) => a + x.capMb, 0);
    const floor = (top?.model.needMb ?? 0) * CLEARLY_BIGGER;
    const m = models.find((x) => (x.catalog || x.here) && x.needMb <= sumMb && x.needMb >= floor && !seats.some((seat) => canRun(seat, x)));
    if (m && near.length >= 2) split = { model: m, seats: near, sumMb };
  }
  return { best, top, apart, split };
}

function tips(s: Snapshot, a: Advice): Tip[] {
  const out: Tip[] = [];
  const L = s.work.loaded;
  const seats = seatsOf(s);

  // the plan for now
  const apartLine = a.apart && `${a.apart.model.name} apart on ${names(a.apart.seats)}: each runs its own copy (needs about ${gb(a.apart.model.needMb)}), so ${a.apart.seats.length}× the answers at once.`;
  const apartStat = a.apart && `try ${a.apart.model.name} apart on ${countWord(a.apart.seats)}`;
  const topLine = a.top && `${a.top.model.name} ${where(a.top.seat)}: the biggest model that fits one device (needs about ${gb(a.top.model.needMb)}, ${a.top.seat.name} offers ${gb(a.top.seat.capMb)}).`;
  const splitLine = a.split && `${a.split.model.name} split across ${names(a.split.seats)}: fits no device alone (needs about ${gb(a.split.model.needMb)}) but fits all of them (${gb(a.split.sumMb)}); a bigger model, slower per answer.`;

  if (!L) {
    const base = s.work.loading ? 60 : 30;   // while something loads, the plan waits behind the rest
    if (a.apart && a.top && a.apart.model.id === a.top.model.id) out.push({ pri: base, key: `apart:${a.apart.model.id}`, stat: apartStat!, line: apartLine! });
    else {
      if (a.top) out.push({ pri: base, key: `one:${a.top.model.id}:${a.top.seat.id}`, stat: `try ${a.top.model.name} ${a.top.seat.local ? 'here' : `on ${a.top.seat.name}`}`, line: topLine! });
      if (a.apart) out.push({ pri: base + 1, key: `apart:${a.apart.model.id}`, stat: apartStat!, line: apartLine! });
    }
    if (a.split) out.push({ pri: a.top ? base + 2 : base, key: `split:${a.split.model.id}`, stat: `try ${a.split.model.name} split on ${countWord(a.split.seats)}`, line: splitLine! });
    if (!out.length) out.push({ pri: 90, key: 'none', stat: seats.length ? 'no model fits yet' : 'no device to advise on', line: seats.length ? 'no model in the list fits the free memory of a reachable device.' : 'no device is reachable with its free memory known, and this computer cannot run a model itself.' });
  } else {
    // what is loaded now vs the suggestion
    const now = modelOf(s, L.model.id) ?? modelOf(s, L.model.file);
    const nowMb = now?.needMb ?? Math.round(L.model.size / 1048576);
    const busy = new Set([...L.devices.map((d) => (d.local ? 'local' : d.id)), ...(L.parts ?? []).map((p) => (p.local ? 'local' : p.id))]);
    if (L.mode !== 'split' && a.top && a.top.model.needMb > nowMb * 1.1) {
      out.push({ pri: 20, key: `bigger:${a.top.model.id}`, stat: `a bigger model fits: ${a.top.model.name}`, line: `${a.top.model.name} would fit ${where(a.top.seat)} (needs about ${gb(a.top.model.needMb)}); ${L.model.name} is loaded now. bigger usually answers better.` });
    }
    if (L.mode === 'split' && a.top && a.top.model.needMb >= nowMb) {
      out.push({ pri: 20, key: `alone:${a.top.model.id}`, stat: `${a.top.model.name} fits alone`, line: `${a.top.model.name} fits ${where(a.top.seat)} alone, as big as ${L.model.name} or bigger: faster per answer than split.` });
    }
    const idle = seats.filter((x) => !busy.has(x.id));
    if (idle.length) {
      const fitsNow = now ? idle.filter((x) => canRun(x, now, true)) : [];
      if (fitsNow.length && (L.mode === 'phone' || L.mode === 'apart' || L.mode === 'here')) {
        out.push({ pri: 21, key: `widen:${fitsNow.map((x) => x.id).join(',')}`, stat: `add ${countWord(fitsNow)} apart`, line: `${names(fitsNow)} ${fitsNow.length === 1 ? 'is' : 'are'} reachable and idle and ${L.model.name} fits ${fitsNow.length === 1 ? 'it' : 'each'}: load it apart for more answers at once.` });
      } else {
        out.push({ pri: 22, key: `idle:${idle.map((x) => x.id).join(',')}`, stat: `${countWord(idle)} idle`, line: `${names(idle)} ${idle.length === 1 ? 'is' : 'are'} reachable and idle${now && !fitsNow.length ? `; ${L.model.name} does not fit ${idle.length === 1 ? 'it' : 'them'} whole` : ''}.` });
      }
    }
    if (!out.length) out.push({ pri: 50, key: `keep:${L.model.id}`, stat: `keep ${L.model.name} as it is`, line: `${L.model.name} (${L.mode}) is the biggest that fits and every reachable device takes part.` });
  }

  // night
  const waiting = s.projects.filter((p) => p.state === 'waiting').sort((x, y) => x.start - y.start)[0];
  const running = s.projects.find((p) => p.state === 'running');
  if (waiting) {
    const m = modelOf(s, waiting.model);
    const devs = waiting.peers.map((id) => ({ id, d: s.devices.find((d) => d.id === id) ?? null }));
    const gone = devs.filter((x) => !x.d || !active(x.d)).map((x) => x.d?.name ?? x.id);
    const caps = devs.flatMap((x) => (x.d && active(x.d) && x.d.ramMb ? [{ name: x.d.name, capMb: Math.floor(x.d.ramMb * PHONE_SHARE) }] : []));
    const hostCap = s.host.freeMb != null ? Math.floor(s.host.freeMb * HOST_SHARE) : 0;
    const problems: string[] = [];
    if (gone.length) problems.push(`${gone.join(', ')} not reachable now`);
    if (!m) problems.push(`${waiting.model} is not in the model list`);
    else if (waiting.mode === 'here') { if (!s.work.llama) problems.push('this computer cannot run a model itself'); else if (m.needMb > hostCap) problems.push(`${m.name} needs about ${gb(m.needMb)}, this computer has ${gb(hostCap)} to spare`); }
    else if (waiting.mode === 'split') { const sum = caps.reduce((t, c) => t + c.capMb, 0) + (s.work.llama ? hostCap : 0); if (m.needMb > sum) problems.push(`${m.name} needs about ${gb(m.needMb)}, together they offer ${gb(sum)}`); }
    else for (const c of caps) if (m.needMb > c.capMb) problems.push(`${m.name} needs about ${gb(m.needMb)}, ${c.name} offers ${gb(c.capMb)}`);
    const when = `${masked(waiting.title)} at ${hhmm(waiting.start)}`;
    if (problems.length) out.push({ pri: 10, key: `night-bad:${waiting.id}:${problems.join('|')}`, stat: `night project: ${problems[0]}`, line: `night project ${when}: ${problems.join('; ')}. fix it before it starts.` });
    else out.push({ pri: 40, key: `night-ok:${waiting.id}`, stat: `night project ready for ${hhmm(waiting.start)}`, line: `night project ${when}: its ${waiting.peers.length || 'no'} device${waiting.peers.length === 1 ? '' : 's'} answer now and ${m!.name} fits.` });
  } else if (!running && !L && !s.work.loading) {
    const h = new Date(s.at).getHours();
    const plan = a.apart ? `${a.apart.model.name} apart on ${names(a.apart.seats)}` : a.top ? `${a.top.model.name} ${where(a.top.seat)}` : null;
    if (h >= EVENING_FROM && h <= EVENING_TO && plan) {
      out.push({ pri: 45, key: 'evening', stat: 'plan a night project', line: `it is evening and the devices are idle: plan a night project, with ${plan}.` });
    }
  }

  return out.sort((x, y) => x.pri - y.pri);
}

interface Notes { said: string | null }

export function create(ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  let list: Tip[] = [];
  let advice: Advice | null = null;
  let pending: string | null = null;              // a new top, seen once: said when it holds a second look
  let said = ctx.load<Notes>({ said: null }).said;

  return {
    id: 'advisor',
    observe(now) {
      snap = now;
      advice = advise(now);
      list = tips(now, advice);
      const top = list[0];
      if (!top || top.key === 'none' || top.key === said) { pending = null; return; }   // nothing to suggest is not news
      if (pending !== top.key) { pending = top.key; return; }
      said = top.key;
      pending = null;
      ctx.emit(`advisor: ${top.line}`);
      ctx.save({ said } satisfies Notes);
    },
    view(): BranchView {
      if (!snap || !advice) return { built: true, stat: 'looking…', gauge: null, rows: [], lines: [] };
      const L = snap.work.loaded;
      // the cluster's memory: what each reachable device said it has free, and this computer's
      // free memory (which already lacks whatever runs here, so that is added back)
      const rawMb = snap.devices.filter(active).reduce((t, d) => t + (d.ramMb ?? 0), 0) + (snap.work.llama ? snap.host.freeMb ?? 0 : 0);
      let usedMb = 0;
      let hereMb = 0;
      if (L) {
        const m = modelOf(snap, L.model.id) ?? modelOf(snap, L.model.file);
        const one = m?.needMb ?? Math.round(L.model.size / 1048576);
        if (L.parts?.length) { usedMb = L.parts.reduce((t, p) => t + p.mb, 0); hereMb = L.parts.filter((p) => p.local).reduce((t, p) => t + p.mb, 0); }
        else { usedMb = one * Math.max(1, L.devices.length); hereMb = L.mode === 'here' || L.devices.some((d) => d.local) ? one : 0; }
      }
      const totalMb = rawMb + hereMb;
      const others = (['forecast', 'limits', 'review'] as const).flatMap((id) => {
        const v = ctx.peek(id);
        return v?.built && v.stat ? [`${id} says: ${v.stat}`] : [];
      });
      const rows: [string, string][] = advice.best.map((b) => [b.seat.name, `${b.model.name} · ${gb(b.model.needMb)} of ${gb(b.seat.capMb)}`]);
      if (!rows.length) rows.push(['devices', 'none to advise on']);
      return {
        built: true,
        stat: list[0]?.stat ?? 'nothing to suggest',
        gauge: totalMb > 0 ? Math.min(100, pct(usedMb, totalMb)) : null,
        rows,
        lines: [...list.map((t) => t.line), ...others],
        note: 'suggestions only: the advisor never loads or changes anything.',
      };
    },
  };
}
