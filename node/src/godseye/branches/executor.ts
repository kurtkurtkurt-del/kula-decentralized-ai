// 7 executor: who answers now, how fast, and who should not. It only watches and suggests; a tap on
// one of its cards asks kula's engine to load again or look at a device, it never does either.
// Over the last WINDOW looks (two minutes) it keeps, per device of the loaded model, whether it was
// answering and its answer count, and per device the last CHECKS reachability checks (a check is a
// new checkedAt). Cards:
//   slow     apart: a device answering at under a third of the fastest one's tok/s (both measured,
//            both with 2 answers or more): leave it out
//   rest     a device limits says should rest: leave it out (apart), or look at limits
//   failing  a device of the loaded model found unreachable in 3 or more of its last checks: look again
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
interface Checks { at: number | null; oks: boolean[]; reason: string | null }

/** the load that leaves these devices out, the same model and mode; null when nothing would be left */
function without(s: Snapshot, out: Set<string>): SuggestAction | null {
  const L = s.work.loaded;
  if (!L) return null;
  const left = L.devices.filter((d) => !out.has(d.local ? 'local' : d.id));
  if (!left.length) return null;
  const peers = left.filter((d) => !d.local).map((d) => d.id);
  if (!peers.length) return { do: 'load', model: L.model.id, mode: 'here', devices: [] };
  return { do: 'load', model: L.model.id, mode: L.mode === 'phone' ? 'phone' : 'apart', devices: peers };
}

export function create(ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  const track = new Map<string, Track>();
  const checks = new Map<string, Checks>();
  let loadedKey: string | null = null;
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

    // failing: unreachable in several of its last checks
    for (const d of devs) {
      if (d.local) continue;
      const c = checks.get(d.id);
      const fails = c ? c.oks.filter((x) => !x).length : 0;
      if (!c || fails < (strict ? FAILS : FAILS_STAY)) continue;
      out.push({
        id: cardId('executor', 'failing', d.id), kind: 'warn', weight: 2, action: { do: 'probe', devices: [d.id] }, label: 'look again',
        title: `${d.name} keeps dropping out`,
        why: `${fails} of its last ${c.oks.length} checks found it unreachable${c.reason ? ` (last: ${c.reason})` : ''}; a prompt sent to it may wait or fail.`,
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
      if (key !== loadedKey) { track.clear(); loadedKey = key; }
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
        const c = checks.get(d.id) ?? { at: null, oks: [], reason: null };
        if (c.at !== d.checkedAt) {
          c.at = d.checkedAt;
          c.oks.push(d.reachable);
          if (!d.reachable) c.reason = d.reason;
          if (c.oks.length > CHECKS) c.oks.shift();
        }
        checks.set(d.id, c);
      }
      for (const id of [...checks.keys()]) if (!ids.has(id)) checks.delete(id);
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
        const c = d.local ? null : checks.get(d.id);
        const fails = c ? c.oks.filter((x) => !x).length : 0;
        return `${d.name} · ${d.busy ? 'answering now' : 'free'} · ${d.tps ? `${d.tps} tok/s` : 'speed not measured yet'} · ${d.done} answer${d.done === 1 ? '' : 's'}`
          + (t && t.busy.length >= 2 ? ` · busy in ${Math.round(share(t) * 100)}% of the last ${t.busy.length} looks` : '')
          + (fails ? ` · ${fails} of its last ${c!.oks.length} checks failed` : '');
      });
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
