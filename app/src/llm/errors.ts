import { tx as moduleTx } from '@/i18n/core';

// The error dictionary (5.11.2026): the native module, the peer gate, hugging face and the
// network all speak in raw strings ("http 503", "checksum mismatch (got 3f9a…)", "peer gone",
// "ENOSPC"). Screens show none of that: classify() turns a thrown thing into one of a few
// kinds, explain() turns the kind into a sentence in the app's language. Pure, testable.
export type ErrorKind =
  | 'offline'      // no network, dns, connection reset
  | 'disk'         // not enough free space
  | 'sha'          // checksum or size mismatch after download
  | 'peer'         // a peer could not be reached or dropped
  | 'busy'         // the peer is working for someone else
  | 'toobig'       // the model does not fit (alone or together)
  | 'secret'       // the gate refused: wrong or missing secret
  | 'gated'        // hugging face asks for a sign-in (401/403)
  | 'notfound'     // 404
  | 'server'       // 5xx on the other side
  | 'interrupted'  // the app was killed mid-download
  | 'nopeers'      // a mode that needs a device, with none connected
  | 'nonative'     // not the android app
  | 'nomodel'      // nothing loaded
  | 'cancelled'
  | 'unknown';

export type Explained = { kind: ErrorKind; detail: string | null };

const text = (e: unknown): string => {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && 'message' in e && typeof (e as Error).message === 'string') return (e as Error).message;
  return String(e);
};

// Exact codes the js layer throws itself (store, engine, cluster, peers).
const CODES: Record<string, ErrorKind> = { nonative: 'nonative', nopeers: 'nopeers', nomodel: 'nomodel', toobig: 'toobig', interrupted: 'interrupted', cancelled: 'cancelled', busy: 'busy', paused: 'cancelled' };

const RULES: [RegExp, ErrorKind][] = [
  [/not enough free space|enospc|no space left|disk full/i, 'disk'],
  [/checksum|sha256|size mismatch|could not move the file/i, 'sha'],
  [/wrong secret|not-the-secret|no secret|server proof wrong|gate: closed|gate: bad nonce|\bNO wrong\b/, 'secret'],
  [/\bbusy\b/i, 'busy'],
  [/too big|out of memory|failed to allocate|cannot allocate|not enough memory|\boom\b|load failed/i, 'toobig'],
  [/peer gone|peer did not answer|unreachable|econnrefused|refused|timed? ?out|\bpeer\b/i, 'peer'],
  [/network request failed|failed to fetch|offline|enotfound|econnreset|unknownhost|unable to resolve|connection lost|no address associated|software caused connection abort|network is unreachable/i, 'offline'],
];

/** What kind of thing went wrong. `detail` keeps a short, safe hint (an http code). */
export function classify(e: unknown): Explained {
  const raw = text(e).trim();
  if (!raw) return { kind: 'unknown', detail: null };
  const code = CODES[raw.toLowerCase()];
  if (code) return { kind: code, detail: null };
  // "hf 404", "http 503", "peer http 401"
  const http = raw.match(/^(?:peer\s+)?(?:hf|http)\s+(\d{3})\b/i);
  if (http) {
    const n = Number(http[1]);
    const detail = http[1];
    if (/^peer/i.test(raw)) return { kind: n === 401 || n === 403 ? 'secret' : n === 503 || n === 429 || n === 409 ? 'busy' : 'peer', detail };
    if (n === 401 || n === 403) return { kind: 'gated', detail };
    if (n === 404) return { kind: 'notfound', detail };
    if (n >= 500) return { kind: 'server', detail };
    if (n === 0) return { kind: 'offline', detail: null };
    return { kind: 'unknown', detail };
  }
  for (const [re, kind] of RULES) if (re.test(raw)) return { kind, detail: null };
  return { kind: 'unknown', detail: raw.length > 80 ? `${raw.slice(0, 80)}…` : raw };
}

type Tx = (key: string, fallback?: string, vars?: Record<string, string | number>) => string;

/** One sentence a person can act on, in the app's language. Pass a component's `tx` so the
 *  screen re-renders on a language change; without one the module-level language is used. */
export function explain(e: unknown, tx: Tx = moduleTx): string {
  const { kind, detail } = classify(e);
  const base = tx(`err.${kind}`);
  if (kind === 'unknown' && detail) return `${base} (${detail})`;
  return base;
}

/** Whether trying again is likely to help on its own (as opposed to fixing something first). */
export const retryable = (e: unknown) => ['offline', 'peer', 'busy', 'server', 'interrupted'].includes(classify(e).kind);
