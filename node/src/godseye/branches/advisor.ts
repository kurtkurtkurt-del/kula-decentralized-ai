// 12 advisor: the one or two things worth doing first, said for a person, before they ask. It reads
// the other branches (peek: it runs last, so it sees this look's views) and never loads, moves or
// stops anything. Its own cards, at most two:
//   night    a waiting night project whose device is gone or whose model does not fit them; a device
//            the forecast has likely there by the start hour is only a line until an hour before
//   tonight  no project planned, and the forecast says two or more devices are likely there tonight:
//            the hour most of them are, to plan the project for (between noon and 22:00 only)
//   first    two or more cards on the panel from the others: which one first, in plain words,
//            pointing at that card (its id is in this card's, never the same id)
// The night project's fit is review's (fit.ts, the shares of kula's planner). Each card holds SHOW
// looks before it shows and goes HIDE looks after (decide.ts). A feed line when the first card
// changes; the last one said is kept in its notes, so a restart does not say it again.
import type { Branch, BranchCtx, BranchId, BranchView, Snapshot, Suggestion } from '../types.js';
import { BRANCH_IDS } from '../types.js';
import { active, gb, hhmm, pct } from './util.js';
import { masked } from './review.js';   // a project's title may hold personal data: shown masked, as review does
import { Steady, cardId, hintsOf, modelOf, names } from './decide.js';
import { projectFit, type Fit } from './fit.js';
import { cardRank } from '../rank.js';

const LIKELY = 0.6;                // an hour a device is there with this chance or more counts
const PLAN_FROM = 12;              // hours: the tonight card shows from noon ...
const PLAN_TO = 21;                // ... to the last hour before the night starts
const NIGHT_HOURS = [22, 23, 0, 1, 2, 3, 4, 5, 6];
const MODE_WORD: Record<string, string> = { phone: 'on one device', apart: 'apart', split: 'split', here: 'here' };

type Card = Suggestion & { branch: BranchId };

/** a waiting night project's problems: gone devices, a model that is missing or does not fit; `expected`
 *  are devices away now that the forecast has back by the start: counted with their memory, not gone */
export function nightProblems(s: Snapshot, p: Snapshot['projects'][number], expected: Set<string> = new Set<string>()): { problems: string[]; gone: string[]; fit: Fit } {
  const m = modelOf(s, p.model);
  const fit = projectFit(s, p, m, expected);
  const problems: string[] = [];
  if (fit.gone.length) problems.push(`${fit.gone.map((id) => s.devices.find((d) => d.id === id)?.name ?? id).join(', ')} not reachable now`);
  if (!m) problems.push(`${p.model} is not in the model list`);
  problems.push(...fit.problems);
  return { problems, gone: fit.gone.filter((id) => s.devices.some((d) => d.id === id)), fit };
}

/** the hour tonight most devices are likely there: [hour, how many, their names] */
export function bestHour(s: Snapshot, tonight: Map<string, number[]>): { hour: number; n: number; who: string[] } | null {
  let best: { hour: number; n: number; sum: number; who: string[] } | null = null;
  for (let i = 0; i < NIGHT_HOURS.length; i++) {
    const who = s.devices.filter((d) => (tonight.get(d.id)?.[i] ?? 0) >= LIKELY);
    const sum = who.reduce((t, d) => t + tonight.get(d.id)![i], 0);
    if (who.length && (!best || who.length > best.n || (who.length === best.n && sum > best.sum + 1e-9))) best = { hour: NIGHT_HOURS[i], n: who.length, sum, who: who.map((d) => d.name) };
  }
  return best;
}

/** a card from another branch said for a person: what to do first */
function firstWords(s: Snapshot, c: Card): string {
  const a = c.action;
  const dev = (ids: string[]) => names(ids.map((id) => ({ name: s.devices.find((d) => d.id === id)?.name ?? id })));
  const model = (id: string) => modelOf(s, id)?.name ?? id;
  if (a?.do === 'load') return `load ${model(a.model)} ${MODE_WORD[a.mode] ?? a.mode}${a.devices.length ? ` on ${dev(a.devices)}` : ''}`;
  if (a?.do === 'fetch') return `fetch ${model(a.model)} to this computer`;
  if (a?.do === 'probe') return `look at ${dev(a.devices)} again`;
  if (a?.do === 'unload') return 'unload the model';
  return c.title.charAt(0).toLowerCase() + c.title.slice(1);
}

interface Notes { said: string | null }

export function create(ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  let others: Card[] = [];
  let shown: Suggestion[] = [];
  let night: string[] = [];
  let tonightRow = 'not measured yet';
  const steady = new Steady();
  let said = ctx.load<Notes>({ said: null }).said;

  function cards(s: Snapshot): Suggestion[] {
    const out: Suggestion[] = [];
    night = [];
    // night: the next waiting project, checked now
    const waiting = s.projects.filter((p) => p.state === 'waiting').sort((x, y) => x.start - y.start)[0];
    const running = s.projects.find((p) => p.state === 'running');
    if (waiting) {
      // a device away now that the forecast has likely there at the start hour is no warning yet (C8):
      // a phone at work at noon and home at night is the normal case. Unknown (no forecast, a start
      // hour outside the night's hours) or under an hour to the start: checked against now, as before
      const hour = new Date(waiting.start).getHours();
      const slot = NIGHT_HOURS.indexOf(hour);
      const later = new Set<string>();
      if (slot >= 0 && waiting.start - s.at >= 3_600_000) {
        const hints = hintsOf(ctx);
        for (const id of waiting.peers) {
          const d = s.devices.find((x) => x.id === id);
          if (!d || active(d)) continue;
          const t = hints.get(id)?.find((h) => h.tonight)?.tonight;
          const p = t && t.guess !== 'unknown' && Array.isArray(t.hours) && t.hours.length === NIGHT_HOURS.length ? t.hours[slot] : null;
          if (typeof p === 'number' && Number.isFinite(p) && p >= LIKELY) later.add(id);
        }
      }
      // the devices it expects are counted with their memory (F2), never as gone
      const { problems, gone, fit } = nightProblems(s, waiting, later);
      const when = `${masked(waiting.title)} at ${hhmm(waiting.start)}`;
      if (later.size) night.push(`night project ${when}: ${names([...later].map((id) => ({ name: s.devices.find((d) => d.id === id)!.name })))} not here now, likely by ${String(hour).padStart(2, '0')}:00.`);
      if (problems.length) {
        night.push(`night project ${when}: ${problems.join('; ')}. fix it before it starts.`);
        out.push({
          id: cardId('advisor', 'night', waiting.id), kind: 'warn', weight: 3,
          action: gone.length ? { do: 'probe', devices: gone } : { do: 'open', panel: 'branch', branch: 'review' }, label: gone.length ? 'look again' : 'review',
          title: `the night project at ${hhmm(waiting.start)} would not start well: ${problems[0]}`,
          why: `night project ${when}: ${problems.join('; ')}. there is time to fix it before it starts.`,
        });
      } else {
        const name = modelOf(s, waiting.model)!.name;
        const n = fit.counted.filter((c) => active(c.device)).length;   // the counted devices that answer now
        if (waiting.mode === 'here') night.push(`night project ${when}: this computer runs it and ${name} fits.`);
        else if (!later.size || n) night.push(`night project ${when}: its ${later.size ? 'other ' : ''}${n || 'no'} device${n === 1 ? '' : 's'} answer now and ${name} fits.`);
      }
    }

    // tonight: when most devices are likely there, from the forecast's hours
    const tonight = new Map<string, number[]>();
    let known = 0, likely = 0;
    for (const [id, hs] of hintsOf(ctx)) {
      const t = hs.find((h) => h.tonight)?.tonight;
      if (!t || t.guess === 'unknown' || !s.devices.some((d) => d.id === id)) continue;
      known++;
      if (t.guess === 'likely') likely++;
      if (Array.isArray(t.hours) && t.hours.length === NIGHT_HOURS.length) tonight.set(id, t.hours);
    }
    tonightRow = known ? `${likely} of ${known} device${known === 1 ? '' : 's'} likely there tonight` : 'not measured yet: the forecast is still learning';
    const h = new Date(s.at).getHours();
    const best = bestHour(s, tonight);
    if (!waiting && !running && h >= PLAN_FROM && h <= PLAN_TO && best && best.n >= 2) {
      out.push({
        id: cardId('advisor', 'tonight'), kind: 'suggest', weight: 1, action: { do: 'open', panel: 'branch', branch: 'forecast' }, label: 'forecast',
        title: `tonight ${best.n} devices are likely free: plan the project for ${String(best.hour).padStart(2, '0')}:00`,
        why: `the forecast has ${names(best.who.map((name) => ({ name })))} there at ${String(best.hour).padStart(2, '0')}:00 with ${Math.round(LIKELY * 100)}% or more, from the hours it saw them before.`,
      });
    }

    // first: of the others' cards, the one that matters most, said plainly
    const top = [...others].sort((a, b) => cardRank(b) - cardRank(a));   // privacy, health, speed; then weight
    if (top.length >= 2) {
      const [a, b] = top;
      out.push({
        id: cardId('advisor', 'first', a.id), kind: 'suggest', weight: 1, action: { do: 'open', panel: 'branch', branch: a.branch }, label: a.branch,
        title: `first: ${firstWords(s, a)}`,
        why: `of the ${top.length} cards the brain shows now, this one matters most: ${a.title} (${a.branch}). then: ${b.title} (${b.branch}).`,
      });
    }
    return out.slice(0, 2);
  }

  return {
    id: 'advisor',
    observe(now) {
      snap = now;
      others = BRANCH_IDS.filter((id) => id !== 'advisor').flatMap((id) => (ctx.peek(id)?.suggestions ?? []).filter((c) => c && typeof c.id === 'string' && c.id.startsWith(`${id}:`)).slice(0, 5).map((c) => ({ ...c, branch: id })));
      const mine = cards(now);
      shown = steady.step(mine, mine);
      const top = shown[0];
      if (top && top.id !== said) {
        said = top.id;
        ctx.emit(`advisor: ${top.title}`);
        ctx.save({ said } satisfies Notes);
      }
    },
    view(): BranchView {
      const s = snap;
      if (!s) return { built: true, stat: 'looking…', gauge: null, rows: [], lines: [] };
      const L = s.work.loaded;
      // the cluster's memory in use: what the loaded model takes of what the reachable devices
      // and this computer said they have free (this computer's free memory lacks what runs here)
      const rawMb = s.devices.filter(active).reduce((t, d) => t + (d.ramMb ?? 0), 0) + (s.work.llama ? s.host.freeMb ?? 0 : 0);
      let usedMb = 0, hereMb = 0;
      if (L) {
        const one = (modelOf(s, L.model.id) ?? modelOf(s, L.model.file))?.needMb ?? Math.round(L.model.size / 1048576);
        if (L.parts?.length) { usedMb = L.parts.reduce((t, p) => t + p.mb, 0); hereMb = L.parts.filter((p) => p.local).reduce((t, p) => t + p.mb, 0); }
        else { usedMb = one * Math.max(1, L.devices.length); hereMb = L.mode === 'here' || L.devices.some((d) => d.local) ? one : 0; }
      }
      const totalMb = rawMb + hereMb;
      const quoted = (['forecast', 'limits', 'review'] as const).flatMap((id) => {
        const v = ctx.peek(id);
        return v?.built && v.stat ? [`${id} says: ${v.stat}`] : [];
      });
      const counts = new Map<string, number>();
      for (const c of others) counts.set(c.branch, (counts.get(c.branch) ?? 0) + 1);
      return {
        built: true,
        stat: shown[0]?.title ?? (others.length ? `${others.length} card${others.length === 1 ? '' : 's'} from the others, none to add` : 'nothing to suggest'),
        gauge: totalMb > 0 ? Math.min(100, pct(usedMb, totalMb)) : null,
        rows: [
          ['tonight', tonightRow],
          ['cards now', counts.size ? [...counts].map(([b, n]) => `${b} ${n}`).join(' · ') : 'none'],
        ],
        lines: [...shown.map((c) => `${c.kind === 'warn' ? 'warning' : 'idea'}: ${c.title}`), ...others.map((c) => `${c.branch}: ${c.title}`), ...night, ...quoted],
        note: 'suggestions only: the advisor never loads or changes anything.',
        suggestions: shown,
      };
    },
  };
}
