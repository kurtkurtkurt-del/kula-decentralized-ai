// 11 request review: it looks at each night project before it runs, and at the work loaded now,
// and says what it thinks: ok, or look again with the reasons in plain words. Simple rules only:
//   - how private the request is (sensitivity.ts): private, circle-ok or world-ok, with the kinds
//     that made it so, and how many of its pieces carry nothing private;
//   - the rings (11.11.2026): home devices take everything, a friend's (circle) device takes no
//     private material, a stranger's (world) device only world-ok material. A job whose material
//     would go further than its level allows is to be looked at again, and so is a private chat
//     running while a circle or world device is in the loaded work;
//   - a password, key or token in a request, or text that tries to give the model new orders, is
//     to be looked at again on any ring;
//   - where it would go: a device reached over a relay, or one without a pinned certificate;
//   - sanity: a start already past while it still waits, an end before the start, an empty or very
//     short request, a model this computer does not know, a model too big for the chosen devices.
// It never blocks, edits or delays a job; it only says, and its cards only open its page or offer
// to load the same model on home devices. It never keeps or emits the request text: its verdicts
// are reason kinds and counts, held in memory only (nothing goes into its notes file), and a title
// is shown with anything a sensitivity rule finds masked out.
import type { Branch, BranchCtx, EyeDevice, EyeModel, EyeProject, Ring, Snapshot, Suggestion, SuggestAction } from '../types.js';
import { hhmm, pct } from './util.js';
import { RINGS, kindWords, masked, mayGo, parts, privateKinds, ringOf, sense, widest, type Level, type Parts, type Sense } from './sensitivity.js';
import { heldHere } from './decide.js';
import { sha256Hex } from '../hash.js';

export { masked } from './sensitivity.js';
/** the private kinds of a text (e-mail, iban, card, phone, secret, …), in a fixed order */
export const personalKinds = privateKinds;

const PAST_GRACE_MS = 2 * 60_000;  // the runner starts a job at its time; give it a moment
const SHORT_REQUEST = 12;          // characters: shorter than this is hardly a night's work
const LINES_MAX = 14;

// ---- the reasons, as kinds (kept) and words (shown)

const RING_WORDS: Record<Ring, string> = { home: 'your own devices (home)', circle: 'a friend’s device (circle)', world: 'a stranger’s device (world)' };
const WORDS: Record<string, string> = {
  secret: 'it carries a password, key or token',
  injection: 'it carries text that tries to give the model new orders',
  'send:circle': `private material would go to ${RING_WORDS.circle}`,
  'send:world': `material that is not for strangers would go to ${RING_WORDS.world}`,
  'chat:world': `a private chat would reach ${RING_WORDS.world}`,
  relay: 'it would go over a relay',
  'no-tls': 'it would go to a device without a pinned certificate',
  'gone-device': 'a chosen device is no longer paired',
  'past-start': 'its start has passed and it still waits',
  'end-before-start': 'it ends before it starts',
  'empty-request': 'the request is empty',
  'short-request': 'the request is very short',
  'unknown-model': 'this computer does not know its model',
  'too-big': 'the model does not fit the chosen devices',
};
export const reasonWords = (reasons: string[]): string[] => reasons.map((r) => WORDS[r] ?? r);

export interface Verdict {
  ok: boolean;
  reasons: string[];
  level: Level;                    // how private its request is
  kinds: string[];                 // what made it so (kind names, never the text)
  parts: Parts | null;             // its pieces per ring, counted
  rings: Ring[];                   // the rings its devices are in ('home' for this computer)
}

const FINISHED = new Set(['done', 'failed', 'cancelled', 'missed']);

/** Where a set of device ids would send the work: relay and unpinned devices are flagged. */
function whereReasons(devs: (EyeDevice | undefined)[]): string[] {
  const out: string[] = [];
  if (devs.some((d) => !d)) out.push('gone-device');
  if (devs.some((d) => d?.via === 'relay')) out.push('relay');
  if (devs.some((d) => d && d.via !== 'relay' && !d.tls)) out.push('no-tls');
  return out;
}

/** What a level may not do on these rings: the send reasons. */
function sendReasons(level: Level, rings: Ring[]): string[] {
  const out: string[] = [];
  if (rings.includes('circle') && !mayGo(level, 'circle')) out.push('send:circle');
  if (rings.includes('world') && !mayGo(level, 'world')) out.push('send:world');
  return out;
}

/** The devices a project would use: the chosen ones; with none chosen in "apart", every paired one; "here" uses only this computer. */
function projectDevices(p: EyeProject, s: Snapshot): (EyeDevice | undefined)[] {
  if (p.mode === 'here') return [];
  if (!p.peers.length) return p.mode === 'apart' ? s.devices : [];
  return p.peers.map((id) => s.devices.find((d) => d.id === id));
}

const ringsOf = (devs: (EyeDevice | undefined)[]): Ring[] => RINGS.filter((r) => r === 'home' || devs.some((d) => d && ringOf(d) === r));

function fits(m: EyeModel, p: EyeProject, devs: EyeDevice[], s: Snapshot): boolean | null {
  // the runner unloads the model loaded now before it loads the project's: what it holds here is free then
  const host = s.host.freeMb == null ? null : s.host.freeMb + heldHere(s);
  if (p.mode === 'here') return host == null ? null : host >= m.needMb;
  const rams = devs.map((d) => d.ramMb).filter((r): r is number => r != null);
  if (p.mode === 'split') {
    if (rams.length < devs.length || host == null) return null;  // not all known: no word
    return rams.reduce((a, b) => a + b, 0) + host >= m.needMb;
  }
  // phone / apart: a whole copy has to fit at least one of them (apart may also run on this computer)
  const sizes = p.mode === 'apart' && host != null ? [...rams, host] : rams;
  if (!sizes.length) return null;
  return sizes.some((r) => r >= m.needMb);
}

/** what a project's title and request say: its level, kinds and flags, and its pieces per ring. Verdicts only, no text. */
export interface Read extends Sense { parts: Parts | null }

/** read a project's title and request (the costly part of a review: every finder over the whole text) */
export function readRequest(p: EyeProject): Read {
  const req = String(p.request ?? '').trim();
  return { ...sense(`${String(p.title ?? '')}\n\n${req}`), parts: req ? parts(req) : null };
}

/** the key a read is kept under: a hash of the title and the request, never the text itself */
export const readKey = (p: EyeProject): string => sha256Hex(JSON.stringify([String(p.title ?? ''), String(p.request ?? '')]));

export function reviewProject(p: EyeProject, s: Snapshot, sn: Read = readRequest(p)): Verdict {
  const reasons: string[] = [];
  const req = String(p.request ?? '').trim();
  const devs = projectDevices(p, s);
  const rings = ringsOf(devs);
  if (sn.kinds.includes('secret')) reasons.push('secret');
  if (sn.flags.includes('injection')) reasons.push('injection');
  reasons.push(...sendReasons(sn.level, rings));
  reasons.push(...whereReasons(devs));
  if (p.state === 'waiting' && p.start < s.at - PAST_GRACE_MS) reasons.push('past-start');
  if (p.end <= p.start) reasons.push('end-before-start');
  if (!req) reasons.push('empty-request');
  else if (req.length < SHORT_REQUEST) reasons.push('short-request');
  const m = s.models.find((x) => x.id === p.model);
  if (!m) reasons.push('unknown-model');
  else if (fits(m, p, devs.filter((d): d is EyeDevice => !!d), s) === false) reasons.push('too-big');
  return { ok: reasons.length === 0, reasons, level: sn.level, kinds: sn.kinds, parts: sn.parts, rings };
}

/** a person's own chat runs now: something is being written and no night project is running */
const chatRuns = (s: Snapshot): boolean => s.work.chatting > 0 && !s.projects.some((p) => p.state === 'running');

/** the remote devices of the work loaded now, as the snapshot's devices (a device gone from the book stays undefined) */
function loadedDevices(s: Snapshot): (EyeDevice | undefined)[] {
  const l = s.work.loaded;
  if (!l) return [];
  const ids = [...new Set([...l.devices, ...(l.parts ?? [])].filter((d) => !d.local).map((d) => d.id))];
  return ids.map((id) => s.devices.find((x) => x.id === id));
}

function reviewLoaded(s: Snapshot): Verdict | null {
  if (!s.work.loaded) return null;
  const devs = loadedDevices(s);
  const rings = ringsOf(devs);
  // a chat is the person's own: private by its nature. Only a ring that may not take private
  // material warns (a friend's device may, the person's decision, 11.11.2026)
  const reasons = chatRuns(s) ? rings.filter((r) => !mayGo('private', r)).map((r) => `chat:${r}`) : [];
  reasons.push(...whereReasons(devs));
  return { ok: reasons.length === 0, reasons, level: chatRuns(s) ? 'private' : 'world-ok', kinds: [], parts: null, rings };
}

const key = (v: Verdict) => (v.ok ? 'ok' : v.reasons.join(','));
const say = (v: Verdict) => (v.ok ? 'ok' : `look again: ${reasonWords(v.reasons).join('; ')}`);
const titleOf = (p: EyeProject) => `“${masked(String(p.title ?? '')).slice(0, 60) || 'untitled'}”`;
const kindsSaid = (kinds: string[]) => kinds.map(kindWords).join(', ');
const levelSaid = (v: Verdict) => (v.level === 'world-ok' ? 'world-ok' : `${v.level} (${kindsSaid(v.kinds)})`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// a card id may carry only [\w.:@/-]: a stand-in id from the guard ('~…~') is made to fit
const cardKey = (id: string) => id.replace(/[^\w.@-]/g, '_').slice(0, 60) || '_';

/** what a stranger or a friend could still take of a project held back from them */
function splitSaid(v: Verdict, ring: Ring): string {
  const n = v.parts ? (ring === 'world' ? v.parts.world : v.parts.circle) : 0;
  if (!v.parts || !n) return 'keep it home: run it here or on your own devices.';
  return `${n} of ${plural(v.parts.total, 'piece')} carry nothing ${ring === 'world' ? 'that is not for strangers' : 'private'} and could go there; keep the rest home.`;
}

function projectCard(p: EyeProject, v: Verdict, s: Snapshot): Suggestion | null {
  const ring = v.reasons.includes('send:world') ? 'world' : v.reasons.includes('send:circle') ? 'circle' : null;
  if (!ring) return null;
  const names = projectDevices(p, s).filter((d): d is EyeDevice => !!d && ringOf(d) === ring).map((d) => d.name);
  const kind = v.level === 'private' ? 'send-private' : 'send-circle';
  return {
    id: `review:${kind}:${cardKey(p.id)}`,
    kind: 'warn',
    title: `${v.level === 'private' ? 'private material' : 'material not for strangers'} would go to ${RING_WORDS[ring]}`,
    why: `the night project ${titleOf(p)} (${hhmm(p.start)}) carries ${kindsSaid(v.kinds)} and is set to run on ${names.join(', ') || 'a device'}. ${splitSaid(v, ring)}`,
    action: { do: 'open', panel: 'branch', branch: 'review' },
    label: 'look',
    weight: ring === 'world' ? 3 : 2,
  };
}

/** the same model again, on the home devices of the loaded work only, or here; null when there is no such way */
function homeOnly(s: Snapshot): SuggestAction | null {
  const l = s.work.loaded!;
  const home = loadedDevices(s).filter((d): d is EyeDevice => !!d && ringOf(d) === 'home').map((d) => d.id);
  const mode = l.mode === 'phone' || l.mode === 'apart' || l.mode === 'split' || l.mode === 'here' ? l.mode : null;
  if (!mode) return null;
  // kula's engine runs this computer in apart unless told so: an apart load it was not in keeps it out
  const out = mode === 'apart' && ![...l.devices, ...(l.parts ?? [])].some((d) => d.local) ? { here: false as const } : {};
  if (home.length && mode !== 'here') return { do: 'load', model: l.model.id, mode, devices: mode === 'phone' ? home.slice(0, 1) : home, ctx: l.ctx, ...out };
  const here = s.models.find((m) => m.id === l.model.id)?.here;
  if (s.work.llama && here) return { do: 'load', model: l.model.id, mode: 'here', devices: [], ctx: l.ctx };
  return null;
}

function loadedCards(s: Snapshot): Suggestion[] {
  const l = s.work.loaded;
  if (!l) return [];
  const devs = loadedDevices(s).filter((d): d is EyeDevice => !!d);
  const far = widest(devs.map(ringOf));
  // a friend's device may see a private chat (the person's decision, 11.11.2026): only a stranger's warns
  if (far !== 'world') return [];
  const names = devs.filter((d) => ringOf(d) !== 'home').map((d) => `${d.name} (${ringOf(d)})`).join(', ');
  const keep = homeOnly(s);
  const ctx = (n: number) => (n >= 512 && n <= 262144 ? n : undefined);
  const action: SuggestAction = keep ? (keep.do === 'load' ? { ...keep, ctx: ctx(keep.ctx ?? 0) } : keep) : { do: 'open', panel: 'branch', branch: 'review' };
  if (action.do === 'load' && action.ctx === undefined) delete action.ctx;
  if (chatRuns(s)) {
    return [{
      id: 'review:private-chat',
      kind: 'warn',
      title: `a private chat runs while ${RING_WORDS[far]} is in the loaded work`,
      why: `a chat is yours: it belongs at home. ${names} ${devs.filter((d) => ringOf(d) !== 'home').length === 1 ? 'is' : 'are'} in ${l.model.name} (${l.mode}) and ${far === 'world' ? 'a stranger’s phone sees the prompt in plain text while it answers' : 'a friend’s device sees what it answers'}. ${keep ? 'load it again on your own devices only.' : 'unload it, or chat on your own devices only.'}`,
      action, ...(keep ? { label: 'keep it home' } : { label: 'look' }),
      weight: far === 'world' ? 3 : 2,
    }];
  }
  if (far !== 'world') return [];
  return [{
    id: 'review:world-in-cluster',
    kind: 'warn',
    title: 'a stranger’s device is in the loaded work',
    why: `${names} ${devs.filter((d) => ringOf(d) === 'world').length === 1 ? 'is' : 'are'} in ${l.model.name} (${l.mode}): a chat now would reach a stranger’s phone in plain text. fine for world-ok work; ${keep ? 'load it again on your own devices before you chat.' : 'unload it before you chat.'}`,
    action, ...(keep ? { label: 'keep it home' } : { label: 'look' }),
    weight: 1,
  }];
}

export function create(ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  // project id → its verdict, in memory only: never written to the notes file
  const verdicts = new Map<string, Verdict & { state: string }>();
  // project id → what its title and request said, under a hash of them: a request is read once, not
  // on every look (the finders over a long request held the eye's tick for a tenth of a second
  // each). Only the hash and the verdicts are kept, never the text; one entry per current project.
  const reads = new Map<string, { hash: string; read: Read }>();
  const readOf = (p: EyeProject): Read => {
    const hash = readKey(p);
    const had = reads.get(p.id);
    if (had && had.hash === hash) return had.read;
    const read = readRequest(p);
    reads.set(p.id, { hash, read });
    return read;
  };
  let loadedKey: string | null = null;
  let loaded: Verdict | null = null;

  return {
    id: 'review',
    observe(now) {
      snap = now;
      const seen = new Set<string>();
      for (const p of now.projects) {
        seen.add(p.id);
        const old = verdicts.get(p.id);
        // a finished project keeps the verdict it had while it could still run
        if (FINISHED.has(p.state)) {
          if (old) old.state = p.state;
          else verdicts.set(p.id, { ...reviewProject(p, now, readOf(p)), state: p.state });
          continue;
        }
        const v = reviewProject(p, now, readOf(p));
        if (!old || key(old) !== key(v)) ctx.emit(`${titleOf(p)} (${p.state}, ${hhmm(p.start)}): ${say(v)}`);
        verdicts.set(p.id, { ...v, state: p.state });
      }
      for (const id of [...verdicts.keys()]) if (!seen.has(id)) verdicts.delete(id);
      for (const id of [...reads.keys()]) if (!seen.has(id)) reads.delete(id);

      loaded = reviewLoaded(now);
      const lk = loaded && now.work.loaded ? `${now.work.loaded.model.id}|${key(loaded)}` : null;
      if (lk && lk !== loadedKey && loaded && !loaded.ok) ctx.emit(`the work loaded now (${now.work.loaded!.model.name}): ${say(loaded)}`);
      loadedKey = lk;
    },
    view() {
      const projects = snap?.projects ?? [];
      const order = (st: string) => (st === 'waiting' ? 0 : st === 'running' ? 1 : 2);
      const sorted = [...projects].sort((a, b) => order(a.state) - order(b.state) || (order(a.state) < 2 ? a.start - b.start : b.start - a.start));
      const waiting = sorted.filter((p) => p.state === 'waiting');
      const waitingOk = waiting.filter((p) => verdicts.get(p.id)?.ok).length;
      const open = sorted.filter((p) => !FINISHED.has(p.state));
      const again = open.filter((p) => verdicts.get(p.id) && !verdicts.get(p.id)!.ok).length;

      // per ring, a row: its devices, what of the open work and the chat may go there now and what
      // is held back from it. Counts and kind levels only, never a word of the work itself.
      const chat = !!snap && chatRuns(snap);
      const vs = open.map((p) => verdicts.get(p.id)).filter((v): v is Verdict & { state: string } => !!v);
      const ringRows: [string, string][] = RINGS.map((r) => {
        const devs = (snap?.devices ?? []).filter((d) => ringOf(d) === r);
        const named = `${r === 'home' ? `this computer + ${plural(devs.length, 'device')}` : plural(devs.length, 'device')}${devs.length ? ` (${devs.map((d) => d.name).join(', ')})` : ''}`;
        if (r !== 'world') {   // home and circle take everything (the person's decision, 11.11.2026)
          const what = [vs.length ? plural(vs.length, 'project') : '', chat ? 'the chat' : ''].filter(Boolean).join(', ');
          return [`ring ${r}`, `${named} · may go: everything${what ? ` (${what})` : ''}`];
        }
        const held = vs.filter((v) => !mayGo(v.level, r));
        const pieces = held.reduce((n, v) => n + (v.parts ? (r === 'world' ? v.parts.world : v.parts.circle) : 0), 0);
        const heldBy = (['private', 'circle-ok'] as Level[]).map((l) => [l, held.filter((v) => v.level === l).length] as const).filter(([, n]) => n);
        const mayText = `${plural(vs.length - held.length, 'project')}${pieces ? ` + ${plural(pieces, 'piece')} of the others` : ''}`;
        const heldText = [held.length ? `${plural(held.length, 'project')} (${heldBy.map(([l, n]) => `${n} ${l}`).join(', ')})` : '', chat ? 'the chat' : ''].filter(Boolean).join(', ') || 'nothing';
        return [`ring ${r}`, `${named} · may go: ${mayText} · held back: ${heldText}`];
      });

      const lines: string[] = [];
      if (snap?.work.loaded && loaded) lines.push(`loaded now · ${snap.work.loaded.model.name} (${snap.work.loaded.mode}) · ${say(loaded)}`);
      for (const p of sorted) {
        const v = verdicts.get(p.id);
        if (!v) continue;
        lines.push(`${titleOf(p)} · ${p.state} · ${hhmm(p.start)}–${hhmm(p.end)} · ${levelSaid(v)} · ${say(v)}`);
      }

      const suggestions: Suggestion[] = [];
      if (snap) {
        suggestions.push(...loadedCards(snap));
        for (const p of open) { const v = verdicts.get(p.id); const c = v && projectCard(p, v, snap); if (c) suggestions.push(c); }
      }

      const stat = waiting.length || again
        ? `${waiting.length} waiting · ${again ? `${again} to look at again` : 'all ok'}`
        : projects.length ? 'nothing waiting' : 'no night project';
      return {
        built: true,
        stat,
        gauge: waiting.length ? pct(waitingOk, waiting.length) : null,
        rows: [
          ['waiting', String(waiting.length)],
          ['running', String(sorted.filter((p) => p.state === 'running').length)],
          ['to look at again', String(again)],
          ['looked at', String(verdicts.size)],
          ...ringRows,
        ],
        lines: lines.slice(0, LINES_MAX),
        note: 'it only says what it thinks; it never stops or changes a job. it keeps no request text, only its verdicts and counts, in memory. home and circle take everything (your decision, 11.11), world only what is fine for strangers; strangers take no part today.',
        suggestions,
      };
    },
  };
}
