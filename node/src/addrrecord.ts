// An address record (docs/ANCHOR.md "address book", stage 6): a device says where it can be
// reached now (its own addresses: lan, global ipv6, the router's port) and which anchors it is
// registered with, signed with its gate key, the key of the certificate whose SHA-256 is its
// pinned fingerprint. The record carries that certificate, so whoever pinned the fingerprint can
// check it without asking anyone: SHA-256 of `cert` must be `fp`, and `sig` must verify with the
// certificate's key. Anchors only carry records; they never vouch for one, and a record they
// changed fails the signature.
//
//   {k:"kula-addr", v:1, fp, addrs:[{host,port,via}], anchors:[{fp,host,port,name?}], seq, at, cert, sig}
//
// `seq` only grows (the signer takes max(last + 1, now in ms)), so an older record is never taken
// over a newer one. The signed text is a fixed JSON array of the fields (recordText), not the
// record's own JSON, so key order and extra fields change nothing.
//
// This file stands alone (node:crypto and tls.ts only): the anchor (anchor.ts) checks the records
// it carries with it, the address book (addressbook.ts) checks and applies them.
import net from 'node:net';
import { sign, verify, X509Certificate } from 'node:crypto';
import { fingerprint, type GateIdentity } from './tls.js';
import type { PeerAddr, AddrVia } from './peers.js';
import type { PeerAnchor } from './road.js';

export interface AddrRecord {
  k: 'kula-addr';
  v: 1;
  fp: string;
  addrs: PeerAddr[];
  anchors: PeerAnchor[];
  seq: number;
  at: number;
  cert: string;   // the certificate, DER in base64
  sig: string;    // base64
}

export const RECORD_MAX_ADDRS = 8;
// with these limits a record is about 2 KB at most: one JSON line on the anchor's control
// connection (LineReader takes 4096 bytes)
export const RECORD_MAX_ANCHORS = 4;
const FP_RE = /^[0-9a-f]{64}$/;
const VIAS: AddrVia[] = ['lan', 'ipv6', 'mapped'];

// The text that is signed: the fields in a fixed order.
export function recordText(r: Pick<AddrRecord, 'fp' | 'addrs' | 'anchors' | 'seq' | 'at'>): string {
  return JSON.stringify([
    'kula-addr', 1, r.fp,
    r.addrs.map((a) => [a.host, a.port, a.via]),
    r.anchors.map((a) => [a.fp, a.host, a.port, a.name ?? '']),
    r.seq, r.at,
  ]);
}

const algOf = (keyType: string | undefined): string | null => (keyType === 'ed25519' ? null : 'sha256');

// The addresses and anchors as a record keeps them: ip literals, ports, known kinds; at most 8 and 4.
function cleanAddrList(x: unknown): PeerAddr[] | null {
  if (!Array.isArray(x) || x.length > RECORD_MAX_ADDRS) return null;
  const out: PeerAddr[] = [];
  for (const a of x) {
    if (!a || typeof a !== 'object') return null;
    const host = typeof a.host === 'string' ? a.host : '';
    const port = a.port;
    if (!net.isIP(host) || host !== host.toLowerCase() || !Number.isInteger(port) || port < 1 || port > 65535 || !VIAS.includes(a.via)) return null;
    out.push({ host, port, via: a.via });
  }
  return out;
}

function cleanAnchorList(x: unknown): PeerAnchor[] | null {
  if (!Array.isArray(x) || x.length > RECORD_MAX_ANCHORS) return null;
  const out: PeerAnchor[] = [];
  for (const a of x) {
    if (!a || typeof a !== 'object') return null;
    const host = typeof a.host === 'string' ? a.host : '';
    const port = a.port;
    if (typeof a.fp !== 'string' || !FP_RE.test(a.fp) || !net.isIP(host) || host !== host.toLowerCase() || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (a.name !== undefined && (typeof a.name !== 'string' || a.name.length > 40 || /[\u0000-\u001f]/.test(a.name))) return null;
    out.push({ fp: a.fp, host, port, ...(a.name ? { name: a.name } : {}) });
  }
  return out;
}

// The addresses and anchors as a record says them: at most 8 and 4, hosts without brackets in
// lower case, names cut to 40 characters.
export function recordBody(addrs0: PeerAddr[], anchors0: PeerAnchor[]): { addrs: PeerAddr[]; anchors: PeerAnchor[] } {
  const addrs = addrs0.slice(0, RECORD_MAX_ADDRS).map((a) => ({ host: a.host.replace(/^\[|\]$/g, '').toLowerCase(), port: a.port, via: a.via }));
  const anchors = anchors0.slice(0, RECORD_MAX_ANCHORS).map((a) => {
    const name = a.name ? a.name.replace(/[\u0000-\u001f]/g, '').slice(0, 40) : '';
    return { fp: a.fp.toLowerCase(), host: a.host.replace(/^\[|\]$/g, '').toLowerCase(), port: a.port, ...(name ? { name } : {}) };
  });
  return { addrs, anchors };
}

// This device's record, signed with its gate key (recordBody's limits).
export function signRecord(identity: GateIdentity, body: { addrs: PeerAddr[]; anchors: PeerAnchor[]; seq: number; at: number }): AddrRecord {
  const { addrs, anchors } = recordBody(body.addrs, body.anchors);
  const unsigned = { fp: identity.fp, addrs, anchors, seq: Math.floor(body.seq), at: Math.floor(body.at) };
  const sig = sign(algOf(identity.privateKey.asymmetricKeyType), Buffer.from(recordText(unsigned), 'utf8'), identity.privateKey).toString('base64');
  return { k: 'kula-addr', v: 1, ...unsigned, cert: identity.certDer.toString('base64'), sig };
}

export type RecordCheck = { ok: true; rec: AddrRecord } | { ok: false; why: string };

// Whether a record is whole and signed by the certificate it names: its shape, SHA-256 of the
// certificate equal to `fp`, the signature over recordText. Says nothing about whether this
// computer knows the fingerprint (AddressBook.accept does). The record returned has only the
// known fields.
export function checkRecord(x: unknown): RecordCheck {
  if (!x || typeof x !== 'object') return { ok: false, why: 'not a record' };
  const r = x as Record<string, unknown>;
  if (r.k !== 'kula-addr' || r.v !== 1) return { ok: false, why: 'not a record' };
  if (typeof r.fp !== 'string' || !FP_RE.test(r.fp)) return { ok: false, why: 'bad fingerprint' };
  const addrs = cleanAddrList(r.addrs);
  const anchors = cleanAnchorList(r.anchors);
  if (!addrs || !anchors) return { ok: false, why: 'bad addresses' };
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 0 || !Number.isSafeInteger(r.at) || (r.at as number) < 0) return { ok: false, why: 'bad seq' };
  if (typeof r.cert !== 'string' || r.cert.length > 2048 || typeof r.sig !== 'string' || r.sig.length > 256) return { ok: false, why: 'bad signature' };
  const certDer = Buffer.from(r.cert, 'base64');
  if (fingerprint(certDer) !== r.fp) return { ok: false, why: 'the certificate is not that fingerprint' };
  const body = { fp: r.fp, addrs, anchors, seq: r.seq as number, at: r.at as number };
  try {
    const key = new X509Certificate(certDer).publicKey;
    if (!verify(algOf(key.asymmetricKeyType), Buffer.from(recordText(body), 'utf8'), key, Buffer.from(r.sig, 'base64'))) return { ok: false, why: 'bad signature' };
  } catch {
    return { ok: false, why: 'bad signature' };
  }
  return { ok: true, rec: { k: 'kula-addr', v: 1, ...body, cert: r.cert, sig: r.sig } };
}

export const addrKey = (a: { host: string; port: number }): string => `${a.host}|${a.port}`;
