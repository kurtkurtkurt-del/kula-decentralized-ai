// Signed receipts, in the ledger's style (docs/AUDIT.md): one JSON object, keys in a fixed order,
// no spaces, integers only; a signature is over the line up to its own field, that is the text
// without `,"<field>":"…"}`, and is appended last. A receipt carries two: the device that did the
// work signs first (gsig), the home it worked for countersigns (tsig) once the answer is accepted.
// Both homes keep the same line, each in its own hash-chained receipts file. Neither can change it
// alone, and nobody else needs to agree: there is no global book.
//
// The keys stay outside: a Signer signs, a Verify checks, both handed in (node/src/audit/key.ts on
// a computer, DeviceKey on a phone).
import type { Gave } from './credit.js';
import type { Ring, Units } from './types.js';

export interface Signer { id: string; sign(text: string): string }
/** does `sig` over `text` come from the key behind `id`? */
export type Verify = (id: string, text: string, sig: string) => boolean;

export interface ReceiptBody {
  v: 1; kind: 'receipt';
  t: number;                       // ms, when the taker accepted
  job: string; piece: string; copy: number;
  units: Units;
  model: string;                   // sha256 of the model file
  ring: Ring;                      // the piece's ring: anyone holding the receipt can see it was allowed out
  result: string;                  // the accepted answer's digest
  device: string;                  // who did it (signs gsig)
  giver: string;                   // its home
  taker: string;                   // the home it was done for (signs tsig)
  via: string[];                   // friends whose credit carried it, giver's side first
  gift: boolean;                   // from the giver's gift share
  checked: boolean;                // another copy or a known answer agreed
}

export interface VouchBody {
  v: 1; kind: 'vouch';
  t: number;
  by: string;                      // the friend in the middle (signs sig)
  for: string;                     // the home it stands for
  to: string;                      // the home that may now work for it on this word
  units: Units;
  until: number;                   // ms
}

export interface RevokeBody {
  v: 1; kind: 'revoke';
  t: number;
  taker: string;                   // the home that countersigned it and now takes it back (signs sig)
  receipt: string;                 // sha256 of the receipt line
  why: 'wrong' | 'outvoted';
}

const B64 = '[A-Za-z0-9+/=]*';

/** The line in its fixed key order, unsigned. */
export function receiptText(b: ReceiptBody): string {
  const o = {
    v: 1, kind: 'receipt', t: b.t, job: b.job, piece: b.piece, copy: b.copy, units: Math.round(b.units), model: b.model,
    ring: b.ring, result: b.result, device: b.device, giver: b.giver, taker: b.taker, via: [...b.via], gift: b.gift, checked: b.checked,
  };
  return JSON.stringify(o);
}
export const vouchText = (b: VouchBody): string =>
  JSON.stringify({ v: 1, kind: 'vouch', t: b.t, by: b.by, for: b.for, to: b.to, units: Math.round(b.units), until: b.until });
export const revokeText = (b: RevokeBody): string =>
  JSON.stringify({ v: 1, kind: 'revoke', t: b.t, taker: b.taker, receipt: b.receipt, why: b.why });

/** Appends `,"<field>":"<signature over the line so far>"}`. */
export function seal(line: string, field: string, signer: Signer): string {
  if (!line.endsWith('}')) throw new Error('not a json object line');
  const unsigned = line.slice(0, -1);
  return `${unsigned},"${field}":"${signer.sign(unsigned)}"}`;
}

/** Splits off the last field if it is `field`: the text it signs and the signature. */
export function unseal(line: string, field: string): { text: string; sig: string } | null {
  const m = new RegExp(`,"${field}":"(${B64})"\\}$`).exec(line);
  if (!m) return null;
  return { text: line.slice(0, m.index), sig: m[1] };
}

export const signGiver = (b: ReceiptBody, device: Signer): string => {
  if (device.id !== b.device) throw new Error('the receipt names another device');
  return seal(receiptText(b), 'gsig', device);
};
export const countersign = (line: string, taker: Signer): string => {
  const b = JSON.parse(line) as ReceiptBody;
  if (taker.id !== b.taker) throw new Error('the receipt names another taker');
  return seal(line, 'tsig', taker);
};

export interface Checked<T> { ok: boolean; body: T | null; problems: string[] }

/** Checks both signatures and that the line is the one its fields say (nothing added, nothing reordered). */
export function checkReceipt(line: string, verify: Verify): Checked<ReceiptBody> {
  const problems: string[] = [];
  let obj: any;
  try { obj = JSON.parse(line); } catch { return { ok: false, body: null, problems: ['json'] }; }
  if (obj?.v !== 1 || obj.kind !== 'receipt') return { ok: false, body: null, problems: ['kind'] };
  const t = unseal(line, 'tsig');
  const g = t && unseal(t.text + '}', 'gsig');
  if (!t || !g) return { ok: false, body: null, problems: ['shape'] };
  if (g.text + '}' !== receiptText(obj)) problems.push('fields');
  if (!verify(obj.device, g.text, g.sig)) problems.push('gsig');
  if (!verify(obj.taker, t.text, t.sig)) problems.push('tsig');
  const { gsig: _g, tsig: _t, ...body } = obj;
  return { ok: problems.length === 0, body: body as ReceiptBody, problems };
}

/** A one-signature line (vouch, revoke): checks it against its own text function and signer field. */
export function checkSealed<T>(line: string, text: (b: T) => string, who: (b: T) => string, verify: Verify): Checked<T> {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return { ok: false, body: null, problems: ['json'] }; }
  const s = unseal(line, 'sig');
  if (!s) return { ok: false, body: null, problems: ['shape'] };
  const { sig: _s, ...body } = obj;
  const problems: string[] = [];
  if (s.text + '}' !== text(body as T)) problems.push('fields');
  if (!verify(who(body as T), s.text, s.sig)) problems.push('sig');
  return { ok: problems.length === 0, body: body as T, problems };
}
export const checkVouch = (line: string, verify: Verify) => checkSealed<VouchBody>(line, vouchText, (b) => b.by, verify);
export const checkRevoke = (line: string, verify: Verify) => checkSealed<RevokeBody>(line, revokeText, (b) => b.taker, verify);

/** The balance is nothing but the receipts: each one carries its units along giver → via → taker
 *  (what credit.carry() does one at a time).
 *  `revoked` are receipt hashes the taker took back with proof. */
export function tally(receipts: { body: ReceiptBody; hash: string }[], revoked: Set<string> = new Set()): Gave {
  const g: Gave = {};
  for (const r of receipts) {
    if (revoked.has(r.hash) || r.body.giver === r.body.taker) continue;
    const path = [r.body.giver, ...r.body.via, r.body.taker];
    for (let i = 0; i + 1 < path.length; i++) {
      g[path[i]] ??= {};
      g[path[i]][path[i + 1]] = (g[path[i]][path[i + 1]] ?? 0) + r.body.units;
    }
  }
  return g;
}
