// "This device's owner cannot see the work" (11.11.2026, docs/AUDIT.md "owner-blind"). A phone
// running a job for someone else sees the prompt in plain text; its owner could read it, unless
// the phone proves it cannot be made to: Android hardware key attestation. This computer asks
// GET /trust?challenge=<64 hex> (docs/GATE.md); the phone makes a fresh key in its keystore with
// that question folded into the key's attestation challenge, and answers with the key's
// certificate chain (app Attest.kt). The keystore signed what it says about the key and the phone
// (its security level, the bootloader lock, the verified boot state, the app that asked) with an
// attestation key that Google's root certified. This file checks all of it, here:
//
//  - the chain: every certificate signed by the next, the last one carrying one of Google's root
//    public keys (pinned below), nothing expired that must not be (RKP certificates are short
//    lived; factory ones are trusted past their date, as Google says), nothing on Google's
//    revocation list when the person keeps a copy of it (an internet call: off unless they ask);
//  - the key description (OID 1.3.6.1.4.1.11129.2.1.17, only in the leaf): its challenge is
//    sha256("kula-attest-1\n" + question + "\n" + device id), so it answers this computer's
//    question for this device; the device key signed the leaf, so the device that keeps the
//    ledger is the one that answered; the key is in a TEE or StrongBox; the bootloader is locked
//    and verified boot is green; the app is kula's package, signed with an official kula key.
//
// What it cannot say: whether kula itself leaks a prompt (logs, files), or whether the phone has a
// hole Google has not revoked yet. It says what the hardware vouches for, no more.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { home } from './paths.js';

export const PREFIX = 'kula-attest-1';
export const CHALLENGE_RE = /^[0-9a-f]{64}$/;
/** kula's android package (app/app.json android.package) */
export const KULA_PACKAGE = 'app.pasaport.android';
/** Official kula signing certificates, sha256 of the certificate, lowercase hex. None yet: today's
 *  apks are signed with the public React Native debug key, which anyone can sign with. Add the
 *  release key's digest here (or in ~/.kula-node/attestation.json, "signers") once there is one. */
export const OFFICIAL_SIGNERS: readonly string[] = [];
/** The public debug key of the React Native template (app/android/app/debug.keystore,
 *  androiddebugkey): `keytool -list -v` says SHA256 FA:C6:17:45:…:3B:9C. */
export const DEBUG_SIGNER = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';

/** Google's hardware attestation roots, from https://android.googleapis.com/attestation/root
 *  (fetched 11.11.2026; the same two are on developer.android.com/privacy-and-security/
 *  security-key-attestation#root_certificate). The RSA root has been reissued (2016, 2019, 2021,
 *  2022) over one and the same public key, so roots are matched by public key, not by bytes. The
 *  ECDSA P-384 root "Key Attestation CA1" signs chains from 1 February 2026 on. */
export const GOOGLE_ROOTS: readonly { name: string; pem: string }[] = [
  {
    name: 'google-rsa',
    pem: `-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJAPHBcqaZ6vUdMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMjIwMzIwMTgwNzQ4WhcNNDIwMzE1MTgw
NzQ4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQB8cMqTllHc8U+qCrOlg3H7
174lmaCsbo/bJ0C17JEgMLb4kvrqsXZs01U3mB/qABg/1t5Pd5AORHARs1hhqGIC
W/nKMav574f9rZN4PC2ZlufGXb7sIdJpGiO9ctRhiLuYuly10JccUZGEHpHSYM2G
tkgYbZba6lsCPYAAP83cyDV+1aOkTf1RCp/lM0PKvmxYN10RYsK631jrleGdcdkx
oSK//mSQbgcWnmAEZrzHoF1/0gso1HZgIn0YLzVhLSA/iXCX4QT2h3J5z3znluKG
1nv8NQdxei2DIIhASWfu804CA96cQKTTlaae2fweqXjdN1/v2nqOhngNyz1361mF
mr4XmaKH/ItTwOe72NI9ZcwS1lVaCvsIkTDCEXdm9rCNPAY10iTunIHFXRh+7KPz
lHGewCq/8TOohBRn0/NNfh7uRslOSZ/xKbN9tMBtw37Z8d2vvnXq/YWdsm1+JLVw
n6yYD/yacNJBlwpddla8eaVMjsF6nBnIgQOf9zKSe06nSTqvgwUHosgOECZJZ1Eu
zbH4yswbt02tKtKEFhx+v+OTge/06V+jGsqTWLsfrOCNLuA8H++z+pUENmpqnnHo
vaI47gC+TNpkgYGkkBT6B/m/U01BuOBBTzhIlMEZq9qkDWuM2cA5kW5V3FJUcfHn
w1IdYIg2Wxg7yHcQZemFQg==
-----END CERTIFICATE-----`,
  },
  {
    name: 'google-ec',
    pem: `-----BEGIN CERTIFICATE-----
MIICIjCCAaigAwIBAgIRAISp0Cl7DrWK5/8OgN52BgUwCgYIKoZIzj0EAwMwUjEc
MBoGA1UEAwwTS2V5IEF0dGVzdGF0aW9uIENBMTEQMA4GA1UECwwHQW5kcm9pZDET
MBEGA1UECgwKR29vZ2xlIExMQzELMAkGA1UEBhMCVVMwHhcNMjUwNzE3MjIzMjE4
WhcNMzUwNzE1MjIzMjE4WjBSMRwwGgYDVQQDDBNLZXkgQXR0ZXN0YXRpb24gQ0Ex
MRAwDgYDVQQLDAdBbmRyb2lkMRMwEQYDVQQKDApHb29nbGUgTExDMQswCQYDVQQG
EwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABCPaI3FO3z5bBQo8cuiEas4HjqCt
G/mLFfRT0MsIssPBEEU5Cfbt6sH5yOAxqEi5QagpU1yX4HwnGb7OtBYpDTB57uH5
Eczm34A5FNijV3s0/f0UPl7zbJcTx6xwqMIRq6NCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFFIyuyz7RkOb3NaBqQ5lZuA0QepA
MAoGCCqGSM49BAMDA2gAMGUCMETfjPO/HwqReR2CS7p0ZWoD/LHs6hDi422opifH
EUaYLxwGlT9SLdjkVpz0UUOR5wIxAIoGyxGKRHVTpqpGRFiJtQEOOTp/+s1GcxeY
uR2zh/80lQyu9vAFCj6E4AXc+osmRg==
-----END CERTIFICATE-----`,
  },
];

/** Google's revocation status list; fetched only when the person asks (`kula-node attestation refresh`). */
export const STATUS_URL = 'https://android.googleapis.com/attestation/status';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const spki = (c: X509Certificate) => c.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

/** A trust anchor: a name and the public key a chain's last certificate must carry. */
export interface Root { name: string; spki: Buffer }
export const googleRoots = (): Root[] => GOOGLE_ROOTS.map((r) => ({ name: r.name, spki: spki(new X509Certificate(r.pem)) }));

// ---- a small DER reader ---------------------------------------------------------------------

export interface Der { cls: number; cons: boolean; tag: number; body: Buffer; end: number }

/** One DER element of [buf] at [off]. Throws on anything malformed or running past the end. */
export function der(buf: Buffer, off = 0): Der {
  if (off + 2 > buf.length) throw new Error('der: short');
  const b0 = buf[off];
  let p = off + 1;
  let tag = b0 & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let b: number;
    let n = 0;
    do {
      if (p >= buf.length || ++n > 4) throw new Error('der: bad tag');
      b = buf[p++];
      tag = tag * 128 + (b & 0x7f);
    } while (b & 0x80);
  }
  if (p >= buf.length) throw new Error('der: short');
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('der: bad length');
    len = 0;
    for (let i = 0; i < n; i++) {
      if (p >= buf.length) throw new Error('der: short');
      len = len * 256 + buf[p++];
    }
  }
  const end = p + len;
  if (end > buf.length) throw new Error('der: overrun');
  return { cls: b0 >> 6, cons: (b0 & 0x20) !== 0, tag, body: buf.subarray(p, end), end };
}

/** The elements inside a constructed one. */
export function kids(d: Der): Der[] {
  if (!d.cons) throw new Error('der: not constructed');
  const out: Der[] = [];
  let o = 0;
  while (o < d.body.length) {
    if (out.length >= 4096) throw new Error('der: too many');
    const k = der(d.body, o);
    out.push(k);
    o = k.end;
  }
  return out;
}

const UNI = 0, CTX = 2;
const T_BOOL = 1, T_INT = 2, T_OCTET = 4, T_OID = 6, T_ENUM = 10, T_SEQ = 16, T_SET = 17;

function want(d: Der | undefined, tag: number, cls = UNI): Der {
  if (!d || d.cls !== cls || d.tag !== tag) throw new Error(`der: expected tag ${tag}`);
  return d;
}
/** A small non-negative INTEGER or ENUMERATED as a number. */
function int(d: Der | undefined, tag = T_INT): number {
  const b = want(d, tag).body;
  if (!b.length || b.length > 7 || b[0] & 0x80) throw new Error('der: bad integer');
  let n = 0;
  for (const x of b) n = n * 256 + x;
  return n;
}
function bool(d: Der | undefined): boolean {
  const b = want(d, T_BOOL).body;
  if (b.length !== 1) throw new Error('der: bad boolean');
  return b[0] !== 0;
}

/** OID text to its DER content bytes. */
function oidBytes(oid: string): Buffer {
  const p = oid.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const s = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) s.unshift((v & 0x7f) | 0x80);
    out.push(...s);
  }
  return Buffer.from(out);
}
export const KEY_DESCRIPTION_OID = '1.3.6.1.4.1.11129.2.1.17';
const KD_OID = oidBytes(KEY_DESCRIPTION_OID);

/** A certificate's extension value (the OCTET STRING's content) by OID, or null. */
export function extension(certDer: Buffer, oid: Buffer = KD_OID): Buffer | null {
  const tbs = kids(want(kids(want(der(certDer), T_SEQ))[0], T_SEQ));
  const ext = tbs.find((k) => k.cls === CTX && k.tag === 3);
  if (!ext) return null;
  for (const e of kids(want(kids(ext)[0], T_SEQ))) {
    const f = kids(want(e, T_SEQ));
    if (want(f[0], T_OID).body.equals(oid)) return want(f[f.length - 1], T_OCTET).body;
  }
  return null;
}

// ---- the key description --------------------------------------------------------------------

export const LEVELS = ['software', 'tee', 'strongbox'] as const;
export const BOOT = ['green', 'yellow', 'orange', 'red'] as const;

export interface KeyDescription {
  attestationVersion: number;
  attestationSecurityLevel: number;   // 0 software, 1 TEE, 2 StrongBox
  keyMintVersion: number;
  keyMintSecurityLevel: number;
  challenge: Buffer;
  rootOfTrust: { bootKey: Buffer; locked: boolean; boot: number; bootHash: Buffer | null } | null;  // from the hardware list only
  app: { packages: { name: string; version: number }[]; digests: string[] } | null;               // attestationApplicationId
  osVersion: number | null;
  osPatchLevel: number | null;        // yyyymm
}

/** The tagged entries of an AuthorizationList: [tag] EXPLICIT value, each tag at most once. */
function authList(d: Der): Map<number, Der> {
  const m = new Map<number, Der>();
  for (const k of kids(want(d, T_SEQ))) {
    if (k.cls !== CTX || !k.cons) throw new Error('der: bad authorization list');
    if (m.has(k.tag)) throw new Error('der: a tag twice');
    const inner = kids(k);
    if (inner.length !== 1) throw new Error('der: bad tagged value');
    m.set(k.tag, inner[0]);
  }
  return m;
}

/** Parses the KeyDescription extension value (docs: source.android.com …/keystore/attestation#schema). */
export function parseKeyDescription(ext: Buffer): KeyDescription {
  const f = kids(want(der(ext), T_SEQ));
  if (f.length < 8) throw new Error('der: short key description');
  const sw = authList(f[6]);
  const hw = authList(f[7]);
  let rootOfTrust: KeyDescription['rootOfTrust'] = null;
  const rot = hw.get(704);
  if (rot) {
    const r = kids(want(rot, T_SEQ));
    rootOfTrust = { bootKey: want(r[0], T_OCTET).body, locked: bool(r[1]), boot: int(r[2], T_ENUM), bootHash: r[3] ? want(r[3], T_OCTET).body : null };
  }
  let app: KeyDescription['app'] = null;
  // the app id lives in the software list (the platform says it); hardware would do as well
  const aid = sw.get(709) ?? hw.get(709);
  if (aid) {
    const s = kids(want(der(want(aid, T_OCTET).body), T_SEQ));
    const packages = kids(want(s[0], T_SET)).map((p) => {
      const pf = kids(want(p, T_SEQ));
      return { name: want(pf[0], T_OCTET).body.toString('utf8'), version: Number(pf[1]?.body.length ? pf[1].body.readUIntBE(0, Math.min(6, pf[1].body.length)) : 0) };
    });
    const digests = kids(want(s[1], T_SET)).map((x) => want(x, T_OCTET).body.toString('hex'));
    app = { packages, digests };
  }
  const num = (d: Der | undefined) => (d ? int(d) : null);
  return {
    attestationVersion: int(f[0]),
    attestationSecurityLevel: int(f[1], T_ENUM),
    keyMintVersion: int(f[2]),
    keyMintSecurityLevel: int(f[3], T_ENUM),
    challenge: want(f[4], T_OCTET).body,
    rootOfTrust,
    app,
    osVersion: num(hw.get(705) ?? sw.get(705)),
    osPatchLevel: num(hw.get(706) ?? sw.get(706)),
  };
}

// ---- the revocation list --------------------------------------------------------------------

/** Google's status list as kept on this computer: the serials (lowercase hex, and the decimal
 *  spelling some entries use) and when it was fetched. */
export interface StatusList { serials: Set<string>; fetched: number }

export const statusFile = () => path.join(home(), 'attestation-status.json');

/** The list's entries, whatever their spelling: the documented form is lowercase hex, but the
 *  live list (checked 11.11.2026) also holds about a thousand all-digit keys, which read as
 *  decimal serials. Both are kept: a serial matches either way. */
export function parseStatusList(json: unknown, fetched: number): StatusList | null {
  const e = (json as { entries?: unknown } | null)?.entries;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const serials = new Set<string>();
  for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
    const st = (v as { status?: unknown } | null)?.status;
    if (st !== 'REVOKED' && st !== 'SUSPENDED') continue;
    if (/^[0-9a-f]{1,128}$/.test(k.toLowerCase())) serials.add(k.toLowerCase().replace(/^0+(?=.)/, ''));
  }
  return { serials, fetched };
}

let statusSeen: { file: string; mtimeMs: number; list: StatusList | null } | null = null;
/** The list kept in [file], or null when there is none (the default: nothing fetched). */
export function loadStatusList(file = statusFile()): StatusList | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (statusSeen && statusSeen.file === file && statusSeen.mtimeMs === st.mtimeMs) return statusSeen.list;
  let list: StatusList | null = null;
  try { list = parseStatusList(JSON.parse(fs.readFileSync(file, 'utf8')), st.mtimeMs); } catch {}
  statusSeen = { file, mtimeMs: st.mtimeMs, list };
  return list;
}

/** Fetches Google's status list into [file]. An internet call: only when the person asks. */
export async function refreshStatusList(file = statusFile(), get: typeof fetch = fetch): Promise<StatusList> {
  const r = await get(STATUS_URL, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`google answered ${r.status}`);
  const text = await r.text();
  const list = parseStatusList(JSON.parse(text), Date.now());
  if (!list) throw new Error('google sent something that is not a status list');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return list;
}

/** A serial (X509Certificate.serialNumber: upper hex, maybe leading zeros) in both spellings. */
export function serialForms(serial: string): string[] {
  try {
    const n = BigInt(`0x${serial}`);
    return [n.toString(16), n.toString(10)];
  } catch { return []; }
}

// ---- what the person may set ----------------------------------------------------------------

/** ~/.kula-node/attestation.json: {"signers": ["<sha256 of a signing certificate>"], "package": "…"}.
 *  Optional; a signer listed there is taken as an official kula build on this computer. */
export function loadAttestConfig(file = path.join(home(), 'attestation.json')): { signers: string[]; pkg: string } {
  let signers: string[] = [];
  let pkg = KULA_PACKAGE;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j?.signers)) signers = j.signers.filter((s: unknown) => typeof s === 'string').map(normDigest).filter((s: string) => /^[0-9a-f]{64}$/.test(s));
    if (typeof j?.package === 'string' && j.package.length <= 200) pkg = j.package;
  } catch {}
  return { signers: [...OFFICIAL_SIGNERS, ...signers], pkg };
}
const normDigest = (s: string) => s.replace(/[:\s]/g, '').toLowerCase();

// ---- the check ------------------------------------------------------------------------------

export type Why =
  | 'ok' | 'computer' | 'old' | 'cannot' | 'malformed' | 'chain' | 'root' | 'expired' | 'revoked'
  | 'challenge' | 'bound' | 'software' | 'unlocked' | 'boot' | 'app' | 'unofficial';

export interface OwnerBlind {
  ok: boolean | null;
  why: Why;
  text: string;
  facts: {
    root: string | null;            // which Google root the chain ends in
    level: string | null;           // tee, strongbox, software
    locked: boolean | null;
    boot: string | null;            // green, yellow, orange, red
    app: string | null;             // the package that asked for the key
    signer: string | null;          // sha256 of its signing certificate
    patch: string | null;           // its security patch, yyyy-mm
    revocation: string;             // what the chain was checked against
  };
}

export interface AttestPolicy {
  now: number;
  roots?: Root[];                   // default: Google's
  status?: StatusList | null;       // default: none (not checked)
  signers?: readonly string[];      // default: OFFICIAL_SIGNERS
  pkg?: string;                     // default: KULA_PACKAGE
}

/** What a device sent for the `attest` field, with what this computer asked and what it showed. */
export interface AttestInput {
  attest: unknown;                  // undefined: the field was missing (an older kula); null: a computer
  challenge: string;                // the question this computer asked (64 hex)
  id: string | null;                // the device id it claims
  alg: string | null;               // its device key: ed25519 or p256
  pub: string | null;               // the device key's public half, base64 spki
}

export const keyChallenge = (challenge: string, id: string) => sha256(`${PREFIX}\n${challenge}\n${id}`);
export const bindMessage = (challenge: string, leafDer: Buffer) => Buffer.from(`${PREFIX}\n${challenge}\n${sha256(leafDer).toString('hex')}`, 'utf8');

const validDate = (s: string) => new Date(s).getTime();

/** Whether this device's owner cannot see the work, as far as its hardware vouches. Never throws. */
export function ownerBlind(input: AttestInput, policy: AttestPolicy): OwnerBlind {
  const facts: OwnerBlind['facts'] = { root: null, level: null, locked: null, boot: null, app: null, signer: null, patch: null, revocation: 'not checked' };
  const out = (ok: boolean | null, why: Why, text: string): OwnerBlind => ({ ok, why, text, facts });
  const a = input.attest;
  if (a === undefined) return out(null, 'old', 'an older kula: it cannot prove this yet');
  if (a === null) return out(null, 'computer', 'a computer cannot prove this');
  if (typeof a !== 'object' || Array.isArray(a) || (a as { v?: unknown }).v !== 1) return out(false, 'malformed', 'its proof is not one this computer can read');
  const o = a as { error?: unknown; chain?: unknown; sig?: unknown };
  if (typeof o.error === 'string') return out(false, 'cannot', `it made no proof (${o.error.slice(0, 120)}): nothing shows its owner cannot read jobs`);
  if (!Array.isArray(o.chain) || o.chain.length < 2 || o.chain.length > 10 || !o.chain.every((c) => typeof c === 'string' && c.length <= 16384) || typeof o.sig !== 'string') {
    return out(false, 'malformed', 'its proof is not one this computer can read');
  }
  let certs: X509Certificate[];
  let ders: Buffer[];
  try {
    ders = (o.chain as string[]).map((c) => Buffer.from(c, 'base64'));
    certs = ders.map((d) => new X509Certificate(d));
  } catch { return out(false, 'malformed', 'its proof holds a certificate this computer cannot read'); }

  // the chain, leaf first: each certificate names the next as its issuer and is signed by it. Names
  // and signatures only, as Google's library does: factory attestation keys sign the leaf from a
  // certificate that says it is no CA (walleye's does), which openssl's checkIssued refuses
  for (let i = 0; i + 1 < certs.length; i++) {
    let ok = false;
    try { ok = certs[i].issuer === certs[i + 1].subject && certs[i].verify(certs[i + 1].publicKey); } catch {}
    if (!ok) return out(false, 'chain', 'its proof does not hold together: a certificate is not signed by the next');
  }
  const top = certs[certs.length - 1];
  const roots = policy.roots ?? googleRoots();
  const root = roots.find((r) => r.spki.equals(spki(top)));
  let selfSigned = false;
  try { selfSigned = top.verify(top.publicKey); } catch {}
  if (!root || !selfSigned) return out(false, 'root', 'its proof does not lead to Google’s attestation root: nothing shows its key is in secure hardware');
  facts.root = root.name;
  // dates: not the leaf (the phone sets its dates); factory chains (the certificate under the root
  // names a serialNumber) are trusted past their end, as Google says; RKP ones are short-lived on purpose
  const factory = certs.length >= 3 && /(^|\n)serialNumber=/.test(certs[certs.length - 2].subject);
  for (let i = 1; i < certs.length; i++) {
    const c = certs[i];
    if (policy.now < validDate(c.validFrom)) return out(false, 'expired', 'its proof holds a certificate that is not valid yet');
    if (policy.now > validDate(c.validTo) && !factory) return out(false, 'expired', `its proof holds a certificate that expired on ${new Date(validDate(c.validTo)).toISOString().slice(0, 10)}`);
  }
  if (policy.status) {
    for (let i = 1; i < certs.length; i++) {
      if (serialForms(certs[i].serialNumber).some((s) => policy.status!.serials.has(s))) return out(false, 'revoked', 'Google revoked a key in its proof: it cannot be trusted');
    }
    facts.revocation = `checked against Google’s list of ${new Date(policy.status.fetched).toISOString().slice(0, 10)}`;
  }
  // the key description: in the leaf, and only there (one further down was not made by the hardware)
  let kd: KeyDescription;
  try {
    for (let i = 1; i < ders.length; i++) if (extension(ders[i])) return out(false, 'chain', 'its proof carries a key description where the hardware never puts one');
    const ext = extension(ders[0]);
    if (!ext) return out(false, 'malformed', 'its proof has no key description');
    kd = parseKeyDescription(ext);
  } catch { return out(false, 'malformed', 'its proof’s key description cannot be read'); }
  const level = Math.min(kd.attestationSecurityLevel, kd.keyMintSecurityLevel);
  facts.level = LEVELS[level] ?? `level ${level}`;
  facts.locked = kd.rootOfTrust?.locked ?? null;
  facts.boot = kd.rootOfTrust ? BOOT[kd.rootOfTrust.boot] ?? `state ${kd.rootOfTrust.boot}` : null;
  facts.app = kd.app?.packages.map((p) => p.name).join(', ') ?? null;
  facts.signer = kd.app?.digests[0] ?? null;
  if (kd.osPatchLevel && kd.osPatchLevel > 100000) facts.patch = `${Math.floor(kd.osPatchLevel / 100)}-${String(kd.osPatchLevel % 100).padStart(2, '0')}`;

  // this computer's question, for this device, signed by its device key
  if (!input.id || !CHALLENGE_RE.test(input.challenge) || !kd.challenge.equals(keyChallenge(input.challenge, input.id))) {
    return out(false, 'challenge', 'its proof does not answer this computer’s question for this device (an old or borrowed proof)');
  }
  let bound = false;
  try {
    const pub = Buffer.from(input.pub ?? '', 'base64');
    if (sha256(pub).toString('hex').slice(0, 32) === input.id.toLowerCase()) {
      const key = createPublicKey({ key: pub, format: 'der', type: 'spki' });
      const ed = key.asymmetricKeyType === 'ed25519';
      bound = verify(ed ? null : 'sha256', bindMessage(input.challenge, ders[0]), key, Buffer.from(o.sig as string, 'base64'));
    }
  } catch {}
  if (!bound) return out(false, 'bound', 'its proof is not signed by the key that signs its ledger');

  // what the hardware says
  if (level < 1) return out(false, 'software', 'its key is not in secure hardware (software keystore): its owner could read jobs');
  if (!kd.rootOfTrust || !kd.rootOfTrust.locked) return out(false, 'unlocked', 'its bootloader is unlocked: its owner can change the system and read jobs');
  if (kd.rootOfTrust.boot !== 0) return out(false, 'boot', `verified boot is ${facts.boot}, not green: its system is not the maker’s, so its owner could read jobs`);
  const pkg = policy.pkg ?? KULA_PACKAGE;
  if (!kd.app || kd.app.packages.length !== 1 || kd.app.packages[0].name !== pkg) return out(false, 'app', `its proof was made for another app (${facts.app ?? 'none named'}), not kula`);
  const hw = `${facts.level === 'strongbox' ? 'StrongBox' : 'hardware'} key, locked, verified boot`;
  const signers = (policy.signers ?? OFFICIAL_SIGNERS).map(normDigest);
  if (!kd.app.digests.some((d) => signers.includes(d))) {
    return out(false, 'unofficial', kd.app.digests.includes(DEBUG_SIGNER)
      ? `${hw}, but a debug build (signed with the public debug key): its owner could still read jobs`
      : `${hw}, but not an official kula build: its owner could still read jobs`);
  }
  const extra = [facts.patch ? `security patch ${facts.patch}` : '', policy.status ? '' : 'revocation not checked'].filter(Boolean).join('; ');
  return out(true, 'ok', `${hw}, official kula build: its owner cannot read jobs${extra ? ` (${extra})` : ''}`);
}
