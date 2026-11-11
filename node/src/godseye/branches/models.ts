// 10 models and device care: which model on which device, what is held where, what is on offer.
// It only suggests; a tap asks kula's engine to load or fetch, it never does either. Cards:
//   pick     nothing loaded: the biggest model that runs whole somewhere (unless the planner already
//            has a card for it)
//   bigger   loaded: a model at least BIGGER × the loaded one's memory fits every place it runs on
//   tight    loaded: memory dropped since it loaded and it no longer fits a place it runs on
//            (needs more than the share kula would give it now): a smaller one, or unload
//   fetch    a catalog model at least BIGGER × the biggest one here fits this computer and is not
//            here yet
//   vision   photos came that nothing here could see: fetch the smallest model that sees photos
// Places, fits and speeds are decide.ts's; a device limits or trust says no to is never suggested.
// Each card holds SHOW looks before it shows and goes HIDE looks after, with SLACK to stay.
// Notes: when photos last came, and when one could not be seen (the engine's counts restart with it).
import type { Branch, BranchCtx, BranchView, EyeModel, Snapshot, SuggestAction, Suggestion } from '../types.js';
import { SLACK, Steady, alone, canAlone, canApart, cardId, field, gb1, heldHere, modelOf, seatName, tpsOn, tpsWord, type Field, type Seat } from './decide.js';
import { seatedIds } from './planner.js';

export const BIGGER = 1.3;          // a model this much bigger (memory) is worth the change
export const PHOTOS_RECENT = 7 * 24 * 3600_000;   // photos within this long ago count as used
const DROP = 0.75;                  // memory must have dropped under this share of what it was at load

interface Notes { v: 1; photoAt: number | null; unseenAt: number | null }
const sane = (x: unknown): Notes => {
  const n = x as Partial<Notes> | null;
  const t = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return { v: 1, photoAt: t(n?.photoAt), unseenAt: t(n?.unseenAt) };
};

const bySize = (a: EyeModel, b: EyeModel) => b.needMb - a.needMb;

export function create(ctx: BranchCtx): Branch {
  const notes = sane(ctx.load<unknown>(null));
  let snap: Snapshot | null = null;
  let f: Field | null = null;
  let before: { n: number; unseen: number } | null = null;
  let base: { key: string; ram: Map<string, number> } | null = null;   // each place's memory at load
  let shown: Suggestion[] = [];
  const steady = new Steady();

  /** the places the loaded model runs on, as seats (null: one of them is not a seat now) */
  function seatsNow(s: Snapshot, fl: Field): Seat[] | null {
    const ids = seatedIds(s);
    const seats = fl.seats.filter((x) => ids.has(x.id));
    return seats.length === ids.size ? seats : null;
  }

  function cards(s: Snapshot, fl: Field, strict: boolean): Suggestion[] {
    const slack = strict ? 1 : SLACK;
    const out: Suggestion[] = [];
    const L = s.work.loaded;
    const models = [...s.models].sort(bySize);
    const host = fl.seats.find((x) => x.local) ?? null;

    if (!L && !s.work.loading) {
      // pick: the biggest model that runs whole somewhere
      const m = models.find((x) => alone(fl, x, slack));
      const p = m ? alone(fl, m, slack) : null;
      const planner = ctx.peek('planner')?.suggestions ?? [];
      const tail = cardId('', m?.id ?? '');   // ":<model id>", how the planner's card ids end
      if (m && p && !planner.some((c) => c.id.endsWith(tail))) {
        out.push({
          id: cardId('models', 'pick', m.id), kind: 'suggest', weight: 2, action: p.action, label: 'load',
          title: `${m.name} is the biggest model that fits ${p.seats[0].local ? seatName(s, p.seats[0]) : p.seats[0].name}`,
          why: `it needs about ${gb1(m.needMb)} of the ${gb1(p.seats[0].capMb)} there, ${tpsWord(p.tps)}.${m.catalog && !m.here && p.seats[0].local ? ' it is fetched first.' : ''}`,
        });
      }
    }

    if (L && !s.work.loading && L.mode !== 'split') {
      const cur = modelOf(s, L.model.id) ?? modelOf(s, L.model.file);
      const seats = seatsNow(s, fl);
      if (cur && seats?.length) {
        const fits = (m: EyeModel) => seats.every((x) => (L.mode === 'apart' ? canApart(x, m, slack) : canAlone(x, m, slack)));
        // bigger: fits every place it runs on
        const big = models.find((m) => m.id !== cur.id && m.needMb >= cur.needMb * BIGGER && fits(m));
        if (big) {
          const t0 = seats.map((x) => tpsOn(x, cur)), t1 = seats.map((x) => tpsOn(x, big));
          const slower = t0[0] != null && t1[0] != null ? ` it answers slower: ~${t1[0]} tok/s instead of ~${t0[0]} on ${seatName(s, seats[0])}.` : '';
          out.push({
            id: cardId('models', 'bigger', big.id), kind: 'suggest', weight: 1, label: 'load',
            action: { do: 'load', model: big.id, mode: L.mode as 'apart', devices: seats.filter((x) => !x.local).map((x) => x.id) },
            title: `${big.name} fits where ${cur.name} runs now`,
            why: `it needs about ${gb1(big.needMb)} (${cur.name} ${gb1(cur.needMb)}); ${seats.map((x) => `${seatName(s, x)} offers ${gb1(x.capMb)}`).join(', ')}. a bigger model usually answers better.${slower}`,
          });
        }
      }
      // tight: memory dropped since the load and it no longer fits a place it runs on
      if (cur && base) {
        for (const x of fl.seats) {
          const was = base.ram.get(x.id);
          if (was == null || !seatedIds(s).has(x.id)) continue;
          const over = strict ? cur.needMb > x.capMb : cur.needMb * SLACK > x.capMb;
          const dropped = strict ? x.ramMb < was * DROP : x.ramMb < was * (DROP + (1 - DROP) / 2);
          if (!over || !dropped) continue;
          const seatsAll = seatsNow(s, fl) ?? [x];
          const smaller = models.find((m) => m.needMb < cur.needMb && m.needMb > 0 && seatsAll.every((y) => (L.mode === 'apart' ? canApart(y, m) : canAlone(y, m))));
          const act: SuggestAction = smaller ? { do: 'load', model: smaller.id, mode: L.mode as 'apart', devices: seatsAll.filter((y) => !y.local).map((y) => y.id) } : { do: 'unload' };
          out.push({
            id: cardId('models', 'tight', x.id), kind: 'warn', weight: 3, action: act, label: smaller ? `load ${smaller.name}`.slice(0, 24) : 'unload',
            title: `${cur.name} no longer fits ${seatName(s, x)}: ${gb1(x.ramMb)} free now, ${gb1(was)} when it loaded`,
            why: `it needs about ${gb1(cur.needMb)}, more than the ${gb1(x.capMb)} kula would give it now: answers may crawl or fail.${smaller ? ` ${smaller.name} (${gb1(smaller.needMb)}) fits.` : ''}`,
          });
        }
      }
    }

    // fetch: a catalog model clearly bigger than anything here that fits this computer
    if (host && !s.work.loading) {
      const hereBest = models.find((m) => m.here && canAlone(host, m, slack));
      const want = models.find((m) => m.catalog && !m.here && canAlone(host, m, slack) && m.needMb >= (hereBest?.needMb ?? 0) * BIGGER);
      const picked = out.some((c) => c.action?.do === 'load' && c.action.model === want?.id);
      if (want && !picked) {
        out.push({
          id: cardId('models', 'fetch', want.id), kind: 'suggest', weight: 1, action: { do: 'fetch', model: want.id }, label: 'fetch',
          title: `${want.name} would fit ${seatName(s, host)} and is not here yet`,
          why: `it needs about ${gb1(want.needMb)} of the ${gb1(host.capMb)} free here${hereBest ? `; the biggest here is ${hereBest.name} (${gb1(hereBest.needMb)})` : '; no model that fits is here'}. fetching takes ${gb1(want.size / 1048576)} of disk and checks its sha256.`,
        });
      }
    }

    // vision: photos came that nothing here could see
    const seesHere = s.models.some((m) => m.vision && m.here);
    if (!seesHere && notes.unseenAt != null && s.at - notes.unseenAt <= PHOTOS_RECENT) {
      const v = [...s.models].filter((m) => m.vision && m.catalog).sort((a, b) => a.needMb - b.needMb)[0];
      if (v) {
        out.push({
          id: cardId('models', 'vision', v.id), kind: 'suggest', weight: 3, action: s.work.llama ? { do: 'fetch', model: v.id } : { do: 'open', panel: 'settings' }, label: s.work.llama ? 'fetch' : 'settings',
          title: `photos came but nothing here sees them: fetch ${v.name} (${gb1(v.size / 1048576)})`,
          why: `a chat sent photos and kula had no model on this computer that reads them, so they were refused. ${v.name} is the smallest that sees photos${s.work.llama ? '' : '; it needs llama.cpp here first (kula-node setup)'}.`,
        });
      }
    }
    return out;
  }

  return {
    id: 'models',
    observe(now) {
      snap = now;
      // photos: the engine's counts since it started; a rise is a photo seen now
      const p = now.work.photos;
      if (p && p.at != null) {
        let changed = false;
        if (notes.photoAt == null || p.at > notes.photoAt) { notes.photoAt = p.at; changed = true; }
        if (p.unseen > (before?.unseen ?? 0)) { notes.unseenAt = p.at; changed = true; }
        before = { n: p.n, unseen: p.unseen };
        if (changed) ctx.save(notes);
      }
      f = field(now, ctx);
      // each place's memory when the model loaded: the first look with it
      const L = now.work.loaded;
      const key = L ? `${L.model.file}|${L.mode}|${L.since}` : null;
      if (!key) base = null;
      else if (base?.key !== key) base = { key, ram: new Map(f.seats.filter((x) => seatedIds(now).has(x.id)).map((x) => [x.id, x.ramMb])) };
      shown = steady.step(cards(now, f, true), cards(now, f, false));
    },
    view(): BranchView {
      const s = snap;
      const held = (s?.devices ?? []).filter((d) => d.holds);
      const models = s?.models ?? [];
      const L = s?.work.loaded;
      const rows: [string, string][] = [['held now', held.length ? held.map((d) => `${d.name}: ${d.holds}`).join(' · ') : 'no device holds a model']];
      if (s && f) {
        // per place: the biggest model it runs whole
        for (const x of f.seats) {
          const m = [...models].sort(bySize).find((y) => canAlone(x, y));
          rows.push([seatName(s, x), m ? `${m.name} · ${gb1(m.needMb)} of ${gb1(x.capMb)} · ${tpsWord(tpsOn(x, m))}` : `no model fits ${gb1(x.capMb)}`]);
        }
        if (L && heldHere(s)) rows.push(['here now', `${L.model.name} holds about ${gb1(heldHere(s))} of this computer's memory`]);
        rows.push(['photos', s.work.photos ? `${s.work.photos.n} since kula-node started${s.work.photos.unseen ? `, ${s.work.photos.unseen} nothing could see` : ''}` : 'not counted yet']);
      }
      return {
        built: true,
        stat: L ? `${L.model.name} loaded${shown.length ? ` · ${shown.length} idea${shown.length === 1 ? '' : 's'}` : ''}` : `${models.length} models · ${held.length} held${shown.length ? ` · ${shown.length} idea${shown.length === 1 ? '' : 's'}` : ''}`,
        gauge: null,
        rows,
        lines: [...shown.map((c) => `${c.kind === 'warn' ? 'warning' : 'idea'}: ${c.title}`), ...models.slice(0, 12).map((m) => `${m.name}${m.size ? ` · ${(m.size / 1e9).toFixed(2)} GB` : ''}${m.vision ? ' · sees photos' : ''}${m.here ? ' · on this computer' : ''}`)],
        note: 'suggestions only: a tap asks kula to load or fetch; this branch never does.',
        suggestions: shown,
      };
    },
  };
}
