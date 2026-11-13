// 7 executor: who answers now, how fast, and who should not. It only watches and suggests; a tap on
// one of its cards asks kula's engine to load again or look at a device, it never does either.
// Over the last WINDOW looks (two minutes) it keeps, per device of the loaded model, whether it was
// answering and its answer count, and per device the last CHECKS reachability checks (a check is a
// new checkedAt). Cards:
//   slow     apart: a device answering at under a third of the fastest one's tok/s (both measured,
//            both with 2 answers or more): leave it out
//   rest     a device limits says should rest: leave it out (apart), or look at limits
//   failing  a device of the loaded model found unreachable in 3 or more of its last checks, counting
//            only checks of the last ten minutes, and none from before it answered again: look again.
//            In a split this also covers the parts on other devices (partsOf): kula's engine opens a
//            split with no peers (ui/engine.ts), so its workers are only in loaded.parts. Every token
//            crosses a part, so the host's answer count growing is the part answering again: its
//            failed checks are forgotten then. A part gets a line only while it has failed checks.
//            A part gets no rest card here: the planner's barred card already says "split without it".
//   idle     apart: a device that took no prompt for the whole window while another answered in
//            three quarters of it: look again (it may have dropped quietly)
// Each card holds SHOW looks before it shows and goes HIDE looks after its reason went, with a
// looser threshold to stay (decide.ts), so it does not flap. Nothing is saved: two minutes of
// looks are all it needs, and a restart starts the window again.
import type { Branch, BranchCtx, BranchView, Snapshot, SuggestAction, Suggestion } from '../types.js';
import { Steady, cardId, hintsOf } from './decide.js';

export const WINDOW = 24;          // looks, two minutes at 5 s
export const CHECKS = 12;          // reachability checks kept per device
export const SLOW = 1 / 3;         // a device under this share of the fastest one's tok/s is slow
const SLOW_STAY = 0.4;
const FAILS = 3;                   // failed checks among the last CHECKS: failing
const FAILS_STAY = 1;
const BUSY = 0.75;                 // the share of the window another device answered in, for idle
const BUSY_STAY = 0.5;
const MIN_DONE = 2;                // answers behind a tok/s before it counts

interface Track { busy: boolean[]; done: number[] }
/** a device's reachability checks: the last checkedAt seen, and each check with its own time */
interface Checks { last: number | null; seen: { at: number; ok: boolean }[]; reason: string | null }

export const CHECK_MS = 10 * 60_000;   // only checks this young count (finding C4: a device in use is not probed)
/** the checks within CHECK_MS of the look */
const recent = (c: Checks | undefined | null, at: number) => (c ? c.seen.filter((x) => x.at >= at - CHECK_MS) : []);

/** the parts of a split held on another device: in split mode, the parts not on this computer, with
 *  memory on them, a usable id (a string of 1..200 chars, not "local") and not already a non-local
 *  entry of the load's devices (then they are counted there, never twice). Read with care, since
 *  limits hands it its raw look too: a wrong-typed field is no part. */
export function partsOf(L: unknown): { id: string; name: string; mb: number; layers: number }[] {
  if (!L || typeof L !== 'object') return [];
  const l = L as Record<string, unknown>;
  if (l.mode !== 'split' || !Array.isArray(l.parts)) return [];
  const listed = new Set<string>();
  for (const d of Array.isArray(l.devices) ? (l.devices as unknown[]) : []) {
    if (d && typeof d === 'object' && (d as Record<string, unknown>).local !== true && typeof (d as Record<string, unknown>).id === 'string') listed.add((d as Record<string, string>).id);
  }
  const out: { id: string; name: string; mb: number; layers: number }[] = [];
  for (const x of l.parts as unknown[]) {
    if (!x || typeof x !== 'object') continue;
    const p = x as Record<string, unknown>;
    if (p.local === true || !(typeof p.mb === 'number' && Number.isFinite(p.mb) && p.mb > 0)) continue;
    if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 200 || p.id === 'local') continue;
    if (listed.has(p.id) || out.some((o) => o.id === p.id)) continue;
    const name = typeof p.name === 'string' && p.name.length <= 200 ? p.name : '';
    const layers = typeof p.layers === 'number' && Number.isFinite(p.layers) && p.layers >= 0 ? p.layers : 0;
    out.push({ id: p.id, name, mb: p.mb, layers });
  }
  return out;
}

/** the load that leaves these devices out, the same model and mode; null when nothing would be left */
function without(s: Snapshot, out: Set<string>): SuggestAction | null {
  const L = s.work.loaded;
  if (!L) return null;
  const left = L.devices.filter((d) => !out.has(d.local ? 'local' : d.id));
  if (!left.length) return null;
  const peers = left.filter((d) => !d.local).map((d) => d.id);
  if (!peers.length) return { do: 'load', model: L.model.id, mode: 'here', devices: [] };
  if (L.mode === 'phone') return { do: 'load', model: L.model.id, mode: 'phone', devices: peers };
  // kula's engine runs this computer in apart unless here:false: say it when its seat is not kept (C1)
  return { do: 'load', model: L.model.id, mode: 'apart', devices: peers, ...(left.some((d) => d.local) ? {} : { here: false as const }) };
}

export function create(ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  const track = new Map<string, Track>();
  const checks = new Map<string, Checks>();
  const answers = new Map<string, number>();   // per peer of this load, its answer count at the last look
  let loadedKey: string | null = null;
  let hostDone: number | null = null;          // in a split, the host's answer count at the last look
  let shown: Suggestion[] = [];
  const steady = new Steady();

  /** this look's cards, strict or loose */
  function cards(s: Snapshot, strict: boolean): Suggestion[] {
    const L = s.work.loaded;
    if (!L || s.work.loading) return [];
    const out: Suggestion[] = [];
    const devs = L.devices.map((d) => ({ ...d, key: d.local ? 'local' : d.id }));
    const several = devs.length >= 2 && L.mode === 'apart';

    // slow: under a third of the fastest one, both measured
    if (several) {
      const measured = devs.filter((d) => d.tps != null && d.tps > 0 && d.done >= MIN_DONE);
      const fast = measured.reduce<(typeof measured)[number] | null>((a, d) => (!a || d.tps! > a.tps! ? d : a), null);
      for (const d of measured) {
        if (!fast || d === fast || d.tps! >= fast.tps! * (strict ? SLOW : SLOW_STAY)) continue;
        const act = without(s, new Set([d.key]));
        out.push({
          id: cardId('executor', 'slow', d.key), kind: 'warn', weight: 2, action: act, ...(act ? { label: 'leave it out' } : {}),
          title: `${d.name} answers at ~${d.tps} tok/s, ${fast.name} at ~${fast.tps}`,
          why: `in apart mode the fastest free device takes each prompt; ${d.name} gets the ones left over and keeps them about ${Math.round(fast.tps! / d.tps!)}× longer. leave it out for quick answers, keep it for more answers at once.`,
        });
      }
    }

    // rest: limits says so
    const hints = hintsOf(ctx);
    for (const d of devs) {
      const no = hints.get(d.key)?.find((h) => h.no)?.no;
      if (!no) continue;
      const act: SuggestAction | null = several ? without(s, new Set([d.key])) : { do: 'open', panel: 'branch', branch: 'limits' };
      out.push({
        id: cardId('executor', 'rest', d.key), kind: 'warn', weight: 3, action: act, ...(act?.do === 'load' ? { label: 'leave it out' } : {}),
        title: `${d.name} ${no}`,
        why: several ? `it answers ${L.model.name} with the others; they can carry on without it while it rests.` : `it is the one answering ${L.model.name}; nothing is stopped by the brain.`,
      });
    }

    // failing: unreachable in several of its checks of the last ten minutes; a split's parts too
    const failing = [
      ...devs.filter((d) => !d.local).map((d) => ({ id: d.id, name: d.name, part: false })),
      ...partsOf(L).map((p) => ({ id: p.id, name: p.name || p.id, part: true })),
    ];
    for (const d of failing) {
      const c = checks.get(d.id);
      const r = recent(c, s.at);
      const fails = r.filter((x) => !x.ok).length;
      if (!c || fails < (strict ? FAILS : FAILS_STAY)) continue;
      out.push({
        id: cardId('executor', 'failing', d.id), kind: 'warn', weight: 2, action: { do: 'probe', devices: [d.id] }, label: 'look again',
        title: `${d.name} keeps dropping out`,
        why: `${fails} of its last ${r.length} checks found it unreachable${c.reason ? ` (last: ${c.reason})` : ''}; `
          + (d.part ? `it holds part of ${L.model.name} and every token crosses it: an answer may stall or fail.` : 'a prompt sent to it may wait or fail.'),
      });
    }

    // idle: one never took a prompt while another was busy most of the window
    if (several) {
      const full = devs.map((d) => ({ d, t: track.get(d.key) })).filter((x) => x.t && x.t.busy.length >= WINDOW);
      const busiest = full.reduce<(typeof full)[number] | null>((a, x) => (!a || share(x.t!) > share(a.t!) ? x : a), null);
      for (const x of full) {
        if (!busiest || x === busiest || share(busiest.t!) < (strict ? BUSY : BUSY_STAY)) continue;
        if (x.t!.busy.some(Boolean) || x.t!.done[x.t!.done.length - 1] > x.t!.done[0]) continue;
        out.push({
          id: cardId('executor', 'idle', x.d.key), kind: 'suggest', weight: 1, action: x.d.local ? null : { do: 'probe', devices: [x.d.id] }, ...(x.d.local ? {} : { label: 'look again' }),
          title: `${x.d.name} waited while ${busiest.d.name} answered`,
          why: `in the last two minutes ${busiest.d.name} was answering in ${Math.round(share(busiest.t!) * 100)}% of the looks and ${x.d.name} took no prompt. a slow device is left over on purpose; one that dropped quietly shows up in a look.`,
        });
      }
    }
    return out;
  }
  const share = (t: Track) => t.busy.filter(Boolean).length / Math.max(1, t.busy.length);

  return {
    id: 'executor',
    observe(now) {
      snap = now;
      const L = now.work.loaded;
      const key = L ? `${L.model.file}|${L.mode}|${L.since}` : null;
      if (key !== loadedKey) { track.clear(); answers.clear(); hostDone = null; loadedKey = key; }
      if (L) {
        for (const d of L.devices) {
          const k = d.local ? 'local' : d.id;
          const t = track.get(k) ?? { busy: [], done: [] };
          t.busy.push(d.busy); t.done.push(d.done);
          if (t.busy.length > WINDOW) { t.busy.shift(); t.done.shift(); }
          track.set(k, t);
        }
      }
      // reachability checks of every device, so a device in a new load already has its past
      const ids = new Set<string>();
      for (const d of now.devices) {
        ids.add(d.id);
        if (d.reachable == null || d.checkedAt == null) continue;
        const c = checks.get(d.id) ?? { last: null, seen: [], reason: null };
        if (c.last !== d.checkedAt) {
          c.last = d.checkedAt;
          c.seen.push({ at: d.checkedAt, ok: d.reachable });
          if (!d.reachable) c.reason = d.reason;
          if (c.seen.length > CHECKS) c.seen.shift();
        }
        checks.set(d.id, c);
      }
      for (const id of [...checks.keys()]) if (!ids.has(id)) checks.delete(id);
      // a device of this load whose answer count grew has answered since: its misses are over (C4)
      if (L) {
        for (const d of L.devices) {
          if (d.local) continue;
          const before = answers.get(d.id);
          const c = checks.get(d.id);
          if (before != null && d.done > before && c) { c.seen = c.seen.filter((x) => x.ok); c.reason = null; }
          answers.set(d.id, d.done);
        }
      }
      // in a split every token crosses every part: the host answering again is each part answering
      // again, so their misses are over too (C4 for parts)
      const host = L && L.mode === 'split' ? L.devices.find((d) => d.local) ?? L.devices[0] ?? null : null;
      if (host && typeof host.done === 'number' && Number.isFinite(host.done)) {
        if (hostDone != null && host.done > hostDone) {
          for (const p of partsOf(L)) { const c = checks.get(p.id); if (c) { c.seen = c.seen.filter((x) => x.ok); c.reason = null; } }
        }
        hostDone = host.done;
      } else hostDone = null;
      shown = steady.step(cards(now, true), cards(now, false));
    },
    view(): BranchView {
      const L = snap?.work.loaded;
      const devs = L?.devices ?? [];
      const busy = devs.filter((d) => d.busy).length;
      const done = devs.reduce((a, d) => a + (d.done || 0), 0);
      const tps = Math.max(0, ...devs.map((d) => d.tps || 0));
      const lines = devs.map((d) => {
        const t = track.get(d.local ? 'local' : d.id);
        const r = d.local || !snap ? [] : recent(checks.get(d.id), snap.at);
        const fails = r.filter((x) => !x.ok).length;
        return `${d.name} · ${d.busy ? 'answering now' : 'free'} · ${d.tps ? `${d.tps} tok/s` : 'speed not measured yet'} · ${d.done} answer${d.done === 1 ? '' : 's'}`
          + (t && t.busy.length >= 2 ? ` · busy in ${Math.round(share(t) * 100)}% of the last ${t.busy.length} looks` : '')
          + (fails ? ` · ${fails} of its last ${r.length} checks failed` : '');
      });
      // a split's part on another device: a line only while it has failed checks in the window
      for (const p of snap ? partsOf(L) : []) {
        const r = recent(checks.get(p.id), snap!.at);
        const fails = r.filter((x) => !x.ok).length;
        if (fails) lines.push(`${p.name || p.id} \u{b7} holds ${p.layers} layers of the split \u{b7} ${fails} of its last ${r.length} checks failed`);
      }
      return {
        built: true,
        stat: devs.length ? `${busy} answering · ${done} answers${shown.length ? ` · ${shown.length} to look at` : ''}` : 'idle',
        gauge: busy ? 100 : Math.min(100, (tps / 30) * 100),
        rows: [['chats running', String(snap?.work.chatting ?? 0)], ['window', `the last ${WINDOW} looks (2 minutes)`], ['slow', `under a third of the fastest device's tok/s, in apart mode`]],
        lines: [...shown.map((c) => `${c.kind === 'warn' ? 'warning' : 'idea'}: ${c.title}`), ...lines],
        note: devs.length ? 'it only suggests: a tap asks kula to load again or look; the executor never does.' : 'no model loaded: nothing to send work to.',
        suggestions: shown,
      };
    },
  };
}
