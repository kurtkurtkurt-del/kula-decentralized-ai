// change cards (17.11.2026, DECISIONS 5): a card whose action changes something carries accept and
// reject; a card that only looks (probe, open) or only tells (no action) does not. `does` is the one
// sentence of what accept changes, built from the action itself so it can never disagree with it.
// Platform-neutral, like eye.ts: no node: module.
import type { Snapshot, SuggestAction } from './types.js';

const CHANGES: readonly string[] = ['load', 'unload', 'fetch', 'cap', 'anchor', 'cancel'];
const CONFIRM: readonly string[] = ['anchor', 'cancel'];
const UNDOABLE: readonly string[] = ['load', 'unload', 'cap', 'anchor'];
const DOES_MAX = 300;
const NAME_MAX = 60;

/** accept and reject belong on this card: its action changes something */
export function isChange(a: SuggestAction | null | undefined): boolean {
  return !!a && typeof a === 'object' && CHANGES.includes(a.do);
}

/** accept takes a second "really?" tap: anchor (it faces the internet) and cancel (no undo) */
export function needsConfirm(a: SuggestAction | null | undefined): boolean {
  return !!a && typeof a === 'object' && CONFIRM.includes(a.do);
}

/** an accept of this action can be undone (load, unload, cap, anchor); fetch and cancel cannot */
export function canUndo(a: SuggestAction | null | undefined): boolean {
  return !!a && typeof a === 'object' && UNDOABLE.includes(a.do);
}

const cut = (s: string, n = NAME_MAX): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** a model's name as the look has it, else its id */
function modelName(snap: Snapshot | null, id: string): string {
  const m = snap?.models?.find((x) => x.id === id || x.file === id);
  if (m?.name) return cut(m.name);
  const l = snap?.work?.loaded?.model;
  return cut(l && (l.id === id || l.file === id) && l.name ? l.name : id);
}

/** device names as the look has them, the first three and how many more */
function deviceNames(snap: Snapshot | null, ids: string[]): string {
  const names = ids.map((id) => cut(snap?.devices?.find((d) => d.id === id)?.name || id));
  if (names.length <= 1) return names[0] ?? '';
  const shown = names.length > 3 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const gbWords = (gb: number): string => `${Number.isInteger(gb) ? gb : Math.round(gb * 10) / 10} GB`;

/** One sentence: what accepting this action changes, and whether it can be undone. null for an
 *  action that changes nothing (probe, open) or none. `snap` (the last look) only lends names. */
export function changeWords(a: SuggestAction | null | undefined, snap: Snapshot | null): string | null {
  if (!a || !isChange(a)) return null;
  const s = snapOk(snap);
  let out: string;
  switch (a.do) {
    case 'load': {
      const m = modelName(s, a.model);
      const devs = deviceNames(s, a.devices);
      const where = a.mode === 'here' || !devs ? 'on this computer alone'
        : a.mode === 'phone' ? `on ${devs}`
        : a.mode === 'apart' ? (a.here === false ? `as a copy on ${devs}, this computer left out` : `as a copy on ${deviceNames(s, ['this computer', ...a.devices])}`)
        : `split across ${devs}`;
      const ctx = a.ctx ? ` with ${Math.round(a.ctx / 1024)}k context` : '';
      const l = s?.work?.loaded ?? null;
      const now = l ? cut(l.model?.name || l.model?.id || 'the model') : null;
      const same = l && (l.model?.id === a.model || l.model?.file === a.model) && l.mode === a.mode;
      out = `Loads ${m} ${where}${ctx}`
        + (now && !same ? `, in place of ${now}; undo puts ${now} back.` : now ? '; undo loads it as it was.' : '; undo unloads it.');
      break;
    }
    case 'unload': {
      const l = s?.work?.loaded ?? null;
      const now = l ? cut(l.model?.name || l.model?.id || 'the model') : null;
      out = now ? `Unloads ${now} and frees its memory; undo loads it again.` : 'Unloads the model (none is loaded now).';
      break;
    }
    case 'fetch': {
      const m = s?.models?.find((x) => x.id === a.model);
      const size = m && typeof m.size === 'number' && m.size > 0 ? ` (${gbWords(m.size / 1e9)})` : '';
      out = `Downloads ${modelName(s, a.model)}${size} onto this computer; no undo: delete the file in models to take it back.`;
      break;
    }
    case 'cap': {
      const verb = a.gb > a.from ? 'Raises' : a.gb < a.from ? 'Lowers' : 'Sets';
      out = `${verb} the daily limit of each friend's device through this computer from ${gbWords(a.from)} to ${gbWords(a.gb)}; undo sets ${gbWords(a.from)} again.`;
      break;
    }
    case 'anchor':
      out = 'Makes this computer an anchor of your circle: it opens a port to the internet and starts sharing this computer (a running share restarts, which drops open streams); undo turns the anchor off and puts sharing back as it was.';
      break;
    case 'cancel': {
      // never the project's title: it is the person's own request text, private (E2 found the leak)
      out = 'Cancels this night project before it starts; no undo: ask again in its chat.';
      break;
    }
    default:
      return null;
  }
  return out.slice(0, DOES_MAX);
}

/** a look only lends names: anything that is not one is no look */
const snapOk = (snap: Snapshot | null): Snapshot | null => (snap && typeof snap === 'object' ? snap : null);
