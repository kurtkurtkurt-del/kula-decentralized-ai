// 9 limits: keep the devices within what they can bear. It only watches and warns, it never stops,
// slows or unloads anything. The snapshot carries no battery and no temperature yet, so the first
// rules use what it has:
//   memory   the loaded model's need against each device's memory: ok, tight (over 80%), over
//   rest     a device answering without a break for longer than 20 minutes should rest; answers per hour
//   night    a night project still running past its end time, and its devices still working then
//   energy   a guess: busy minutes × watts by kind (phone 3 W, pc 15 W), kept per day in its notes
// A feed line is written only when a warning starts or ends, never on every look.
import type { Branch, BranchCtx, Snapshot } from '../types.js';
import { gb, hhmm } from './util.js';
import { masked } from './review.js';   // a project's title may hold personal data: shown masked, as review does

export const TIGHT = 0.8;                       // memory use above this share is tight
export const REST_AFTER_MS = 20 * 60_000;       // answering longer than this without a break: should rest
export const BREAK_MS = 60_000;                 // a pause this long counts as a break
export const STEP_MAX_MS = 15_000;              // a gap between looks longer than this is not counted as work
export const WATTS: Record<string, number> = { phone: 3, pc: 15 };
const WATTS_OTHER = 5;
const DAYS_KEPT = 14;
const DEVICES_KEPT = 32;
const SAVE_EVERY_MS = 60_000;
const HOUR = 3_600_000;

type Day = { wh: number; busyMin: number; by: Record<string, number> };   // by: device name → Wh
type Notes = { days: Record<string, Day> };
type Warn = { text: string; ended: string };
type Mem = { name: string; needMb: number; ramMb: number | null; share: number | null; level: 'ok' | 'tight' | 'over' | 'unknown' };

const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function cleanNotes(raw: unknown): Notes {
  const days: Record<string, Day> = {};
  const src = (raw as Notes | null)?.days;
  if (src && typeof src === 'object') {
    for (const [k, v] of Object.entries(src).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, DAYS_KEPT)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') continue;
      const by: Record<string, number> = {};
      for (const [n, w] of Object.entries(v.by ?? {}).slice(0, DEVICES_KEPT)) if (Number.isFinite(w)) by[String(n).slice(0, 80)] = Number(w);
      days[k] = { wh: Number.isFinite(v.wh) ? v.wh : 0, busyMin: Number.isFinite(v.busyMin) ? v.busyMin : 0, by };
    }
  }
  return { days };
}

export function create(ctx: BranchCtx): Branch {
  const notes = cleanNotes(ctx.load<unknown>({ days: {} }));
  let dirty = false;
  let savedAt = 0;
  let lastAt: number | null = null;
  let snap: Snapshot | null = null;

  // per device, in memory only
  const runStart = new Map<string, number>();           // when its current busy run began
  const lastBusy = new Map<string, number>();           // when it was last seen busy
  const lastDone = new Map<string, number>();           // its answer counter at the last look
  const answers = new Map<string, number[]>();          // when each answer was counted, the last hour

  let warns = new Map<string, Warn>();
  let mems: Mem[] = [];
  let gauge = 100;

  const today = (at: number): Day => {
    const k = dayKey(at);
    if (!notes.days[k]) {
      notes.days[k] = { wh: 0, busyMin: 0, by: {} };
      const keys = Object.keys(notes.days).sort().reverse();
      for (const old of keys.slice(DAYS_KEPT)) delete notes.days[old];
    }
    return notes.days[k];
  };

  function memoryRules(s: Snapshot): Mem[] {
    const l = s.work.loaded;
    if (!l) return [];
    const byId = new Map(s.devices.map((d) => [d.id, d]));
    const out: Mem[] = [];
    const judge = (name: string, needMb: number, ramMb: number | null): Mem => {
      if (ramMb == null || ramMb <= 0 || !(needMb > 0)) return { name, needMb, ramMb, share: null, level: 'unknown' };
      const share = needMb / ramMb;
      return { name, needMb, ramMb, share, level: share > 1 ? 'over' : share > TIGHT ? 'tight' : 'ok' };
    };
    if (l.mode === 'split' && l.parts?.length) {
      for (const p of l.parts) if (!p.local) out.push({ ...judge(p.name, p.mb, byId.get(p.id)?.ramMb ?? null), name: p.name });
    } else {
      const need = s.models.find((m) => m.id === l.model.id)?.needMb ?? 0;
      for (const d of l.devices) if (!d.local) out.push(judge(d.name, need, byId.get(d.id)?.ramMb ?? null));
    }
    return out;
  }

  return {
    id: 'limits',
    observe(now) {
      snap = now;
      const at = now.at;
      const step = lastAt == null ? 0 : at - lastAt;
      const counted = step > 0 && step <= STEP_MAX_MS ? step : 0;
      lastAt = at;
      const next = new Map<string, Warn>();
      const heads: number[] = [];
      const l = now.work.loaded;
      const kinds = new Map(now.devices.map((d) => [d.id, d.kind]));

      // memory
      mems = memoryRules(now);
      for (const m of mems) {
        if (m.share == null) continue;
        heads.push((1 - m.share) * 200);         // 50% used or less: full headroom; 100%: none
        if (m.level !== 'ok') {
          next.set(`mem:${m.name}:${m.level}`, {
            text: `${m.name}: the model needs ${gb(m.needMb)} of its ${gb(m.ramMb!)} (${Math.round(m.share * 100)}%), ${m.level === 'over' ? 'more than it has' : 'tight'}`,
            ended: `${m.name}: memory ${m.level === 'over' ? 'no longer over' : 'no longer tight'}`,
          });
        }
      }

      // rest, answers per hour, energy
      const day = today(at);
      const seen = new Set<string>();
      for (const d of l?.devices ?? []) {
        seen.add(d.id);
        const before = lastDone.get(d.id);
        const got = before == null ? 0 : Math.max(0, d.done - before);
        lastDone.set(d.id, d.done);
        const list = (answers.get(d.id) ?? []).filter((t) => at - t < HOUR);
        for (let i = 0; i < Math.min(got, 500); i++) list.push(at);
        answers.set(d.id, list.slice(-1000));

        if (d.busy) {
          const lb = lastBusy.get(d.id);
          if (lb == null || at - lb > BREAK_MS || step > STEP_MAX_MS || !runStart.has(d.id)) runStart.set(d.id, at);
          lastBusy.set(d.id, at);
          if (counted) {
            const kind = d.local ? 'pc' : kinds.get(d.id) ?? 'other';
            const wh = ((WATTS[kind] ?? WATTS_OTHER) * counted) / HOUR;
            day.wh += wh;
            day.busyMin += counted / 60_000;
            if (day.by[d.name] != null || Object.keys(day.by).length < DEVICES_KEPT) day.by[d.name] = (day.by[d.name] ?? 0) + wh;
            dirty = true;
          }
        } else if (runStart.has(d.id) && at - (lastBusy.get(d.id) ?? 0) > BREAK_MS) {
          runStart.delete(d.id);
        }
        // a run lasts until a real break, so a short pause between answers keeps the warning
        const rs = runStart.get(d.id);
        if (rs != null) {
          const run = lastBusy.get(d.id)! - rs;
          heads.push(100 - (run / REST_AFTER_MS) * 100);
          if (run > REST_AFTER_MS) next.set(`rest:${d.id}`, { text: `${d.name} should rest: answering for ${Math.round(run / 60_000)} min without a break`, ended: `${d.name} had its break` });
        }
      }
      for (const id of [...lastDone.keys()]) if (!seen.has(id)) { lastDone.delete(id); runStart.delete(id); lastBusy.delete(id); answers.delete(id); }

      // night window
      for (const p of now.projects) {
        if (p.state !== 'running' || !(at > p.end)) continue;
        const late = Math.round((at - p.end) / 60_000);
        heads.push(0);
        next.set(`night:${p.id}`, { text: `night project "${masked(p.title)}" still running ${late} min past its end at ${hhmm(p.end)}`, ended: `night project "${masked(p.title)}" is no longer past its end` });
        for (const d of l?.devices ?? []) {
          if (d.busy && p.peers.includes(d.id)) {
            next.set(`window:${d.id}:${p.id}`, { text: `${d.name} still working after the night window of "${masked(p.title)}" (ended ${hhmm(p.end)})`, ended: `${d.name} stopped working outside the night window` });
          }
        }
      }

      for (const [k, w] of next) if (!warns.has(k)) ctx.emit(`limits: ${w.text}`);
      for (const [k, w] of warns) if (!next.has(k)) ctx.emit(`limits: ${w.ended}`);
      warns = next;
      gauge = clamp(Math.min(100, ...heads));

      if (dirty && at - savedAt >= SAVE_EVERY_MS) { ctx.save(notes); savedAt = at; dirty = false; }
    },
    view() {
      const at = snap?.at ?? ctx.now();
      const day = notes.days[dayKey(at)] ?? { wh: 0, busyMin: 0, by: {} };
      const yesterday = notes.days[dayKey(at - 24 * HOUR)];
      const devs = snap?.work.loaded?.devices ?? [];
      const n = warns.size;
      const lines: string[] = [...warns.values()].map((w) => `warning: ${w.text}`);
      for (const d of devs) {
        const bits: string[] = [d.local ? `${d.name} (this computer)` : d.name];
        const m = mems.find((x) => x.name === d.name);
        if (m?.share != null) bits.push(`memory ${gb(m.needMb)} of ${gb(m.ramMb!)} (${Math.round(m.share * 100)}%) ${m.level}`);
        else if (m) bits.push('memory unknown');
        const rs = runStart.get(d.id);
        bits.push(d.busy && rs != null ? `answering ${Math.round((at - rs) / 60_000)} min, rest at ${REST_AFTER_MS / 60_000}` : 'free');
        bits.push(`${plural(answers.get(d.id)?.length ?? 0, 'answer')} in the last hour`);
        const wh = day.by[d.name];
        if (wh) bits.push(`${round1(wh)} Wh today`);
        lines.push(bits.join(' · '));
      }
      for (const m of mems) if (!devs.some((d) => d.name === m.name) && m.share != null) lines.push(`${m.name} · memory ${gb(m.needMb)} of ${gb(m.ramMb!)} (${Math.round(m.share * 100)}%) ${m.level}`);
      return {
        built: true,
        stat: n ? plural(n, 'warning') : 'all within limits',
        gauge,
        rows: [
          ['energy today', `${round1(day.wh)} Wh (a guess)`],
          ['busy today', `${Math.round(day.busyMin)} min`],
          ...(yesterday ? [['energy yesterday', `${round1(yesterday.wh)} Wh`] as [string, string]] : []),
          ['rules', `memory tight over ${Math.round(TIGHT * 100)}% · rest after ${REST_AFTER_MS / 60_000} min · phone ${WATTS.phone} W, pc ${WATTS.pc} W`],
        ],
        lines,
        note: `it only warns, it never stops a device. it cannot see battery or heat yet${devs.length ? '' : '; no model loaded, nothing is working'}.`,
        what: 'keeps devices within their limits: memory, rest, the night window and an energy guess. battery and heat come later.',
      };
    },
  };
}
