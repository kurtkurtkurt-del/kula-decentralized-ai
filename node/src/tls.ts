// Protocol v2's identity on a computer: an EC P-256 key and a self-signed X.509
// certificate written by hand in DER (node:crypto parses certificates but makes
// none, and a dependency for sixty lines is not worth its weight). The bytes are
// the same the Kotlin side writes (GateCert.kt), down to the TBSCertificate: the
// vector in test/gate-vectors.json proves it. Nothing checks a chain; the other
// side pins SHA-256 of the DER, the "fp" in the v3 qr. docs/GATE.md has the rest.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { moveAside, tighten, writeOnce, type DeviceKey } from './audit/key.js';

const OID_CN = '2.5.4.3';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
export const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;

// --- a DER writer ------------------------------------------------------------
export const der = {
  len(n: number): Buffer {
    if (n < 0x80) return Buffer.from([n]);
    if (n < 0x100) return Buffer.from([0x81, n]);
    if (n < 0x10000) return Buffer.from([0x82, n >> 8, n & 0xff]);
    return Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  },
  tlv(tag: number, body: Buffer): Buffer { return Buffer.concat([Buffer.from([tag]), der.len(body.length), body]); },
  seq(...parts: Buffer[]): Buffer { return der.tlv(0x30, Buffer.concat(parts)); },
  set(...parts: Buffer[]): Buffer { return der.tlv(0x31, Buffer.concat(parts)); },
  explicit(n: number, body: Buffer): Buffer { return der.tlv(0xa0 | n, body); },
  octets(b: Buffer): Buffer { return der.tlv(0x04, b); },
  utf8(s: string): Buffer { return der.tlv(0x0c, Buffer.from(s, 'utf8')); },
  // a positive INTEGER from big-endian magnitude bytes
  uint(magnitude: Buffer): Buffer {
    let i = 0;
    while (i < magnitude.length - 1 && magnitude[i] === 0) i++;
    let m = magnitude.subarray(i);
    if (m.length === 0) m = Buffer.from([0]);
    if (m[0] & 0x80) m = Buffer.concat([Buffer.from([0]), m]);
    return der.tlv(0x02, m);
  },
  int(v: number): Buffer { return der.uint(Buffer.from([v])); },
  bits(b: Buffer): Buffer { return der.tlv(0x03, Buffer.concat([Buffer.from([0]), b])); },
  oid(dotted: string): Buffer {
    const p = dotted.split('.').map(Number);
    const out: number[] = [p[0] * 40 + p[1]];
    for (let i = 2; i < p.length; i++) {
      let v = p[i];
      const stack: number[] = [];
      do { stack.push(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
      for (let j = stack.length - 1; j >= 0; j--) out.push(stack[j] | (j === 0 ? 0 : 0x80));
    }
    return der.tlv(0x06, Buffer.from(out));
  },
  // UTCTime "YYMMDDHHMMSSZ"; the dates stay below 2050
  utcTime(ms: number): Buffer {
    const d = new Date(ms);
    const two = (n: number) => String(n).padStart(2, '0');
    const s = `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
    return der.tlv(0x17, Buffer.from(s, 'ascii'));
  },
};

const name = (cn: string) => der.seq(der.set(der.seq(der.oid(OID_CN), der.utf8(cn))));
const sigAlg = () => der.seq(der.oid(OID_ECDSA_SHA256));

// The TBSCertificate: everything but the signature. Deterministic for its input.
export function tbsCertificate(spki: Buffer, cn: string, serial: Buffer, notBeforeMs: number, notAfterMs: number): Buffer {
  return der.seq(
    der.explicit(0, der.int(2)),
    der.uint(serial),
    sigAlg(),
    name(cn),
    der.seq(der.utcTime(notBeforeMs), der.utcTime(notAfterMs)),
    name(cn),
    spki,
    der.explicit(3, der.seq(der.seq(der.oid(OID_BASIC_CONSTRAINTS), der.octets(der.seq())))),
  );
}

export function spkiOf(key: KeyObject): Buffer {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  return pub.export({ type: 'spki', format: 'der' }) as Buffer;
}

export function randomSerial(): Buffer {
  const b = randomBytes(16);
  b[0] &= 0x7f;
  return b;
}

// A self-signed certificate (DER) over a P-256 private key.
export function selfSigned(privateKey: KeyObject, cn: string, serial = randomSerial(), notBeforeMs = Date.now() - 86_400_000, notAfterMs = notBeforeMs + TEN_YEARS_MS): Buffer {
  if (privateKey.asymmetricKeyType !== 'ec') throw new Error('the gate certificate needs an ec p-256 key');
  const tbs = tbsCertificate(spkiOf(privateKey), cn, serial, notBeforeMs, notAfterMs);
  const sig = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  return der.seq(tbs, sigAlg(), der.bits(sig));
}

// What both sides pin: lowercase hex SHA-256 of the certificate's DER.
export function fingerprint(certDer: Buffer): string {
  return createHash('sha256').update(certDer).digest('hex');
}

export function newP256(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
}

const pemOf = (der: Buffer, label: string) => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END ${label}-----\n`;

// This computer's face on the wire: key, certificate, fingerprint, and the PEM
// pair node:tls wants.
export interface GateIdentity {
  privateKey: KeyObject;
  certDer: Buffer;
  fp: string;
  keyPem: string;
  certPem: string;
}

export function identityFrom(privateKey: KeyObject, certDer: Buffer): GateIdentity {
  return {
    privateKey, certDer, fp: fingerprint(certDer),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: pemOf(certDer, 'CERTIFICATE'),
  };
}

// A fresh identity; cn is the device id.
export function createIdentity(cn: string, privateKey = newP256()): GateIdentity {
  return identityFrom(privateKey, selfSigned(privateKey, cn));
}

// Loads the identity under dir (gate_key.pem, gate_cert.der) or makes one. A
// P-256 device key is the TLS key itself; an Ed25519 one gets a separate P-256
// gate key beside it (Android's TLS does not take Ed25519 certificates on every
// version). A stored certificate whose key no longer matches is replaced.
// A gate key file that is there but unreadable as a key is moved aside (<name>.broken.<unix
// ms>) and logged, never silently written over; the new certificate has a new fingerprint.
export function loadOrCreateIdentity(dir: string, deviceKey: DeviceKey, log: (s: string) => void = (s) => console.error(s)): GateIdentity {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'gate_key.pem');
  const certFile = path.join(dir, 'gate_cert.der');
  let privateKey: KeyObject;
  if (deviceKey.alg === 'p256') privateKey = deviceKey.privateKey;
  else privateKey = loadOrCreateGateKey(keyFile, log);
  try {
    const certDer = fs.readFileSync(certFile);
    const cert = new X509Certificate(certDer);
    if (spkiOf(cert.publicKey).equals(spkiOf(privateKey))) return identityFrom(privateKey, certDer);
  } catch {}
  const id = createIdentity(deviceKey.id, privateKey);
  fs.writeFileSync(certFile, id.certDer);
  return id;
}

function loadOrCreateGateKey(keyFile: string, log: (s: string) => void): KeyObject {
  let pem: string | null = null;
  try {
    pem = fs.readFileSync(keyFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (pem !== null) {
    try {
      const key = createPrivateKey({ key: pem, format: 'pem' });
      tighten(keyFile);
      return key;
    } catch {
      const to = moveAside(keyFile);
      log(`gate key ${keyFile} could not be read; kept as ${to}, a new one is made (paired devices must pair again)`);
    }
  }
  const key = newP256();
  return writeOnce(keyFile, key.export({ type: 'pkcs8', format: 'pem' }) as string) ? key : loadOrCreateGateKey(keyFile, log);
}

// The worker's record of the clients it has paired with (two-way TOFU): one
// certificate fingerprint per line with the time. A client on this list connects
// with its certificate alone; any other needs the one-time code from the qr.
export class Paired {
  private readonly fps = new Set<string>();

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const fp = line.trim().split(' ')[0];
        if (fp.length === 64) this.fps.add(fp);
      }
    } catch {}
  }

  has(fp: string): boolean { return this.fps.has(fp); }
  get size(): number { return this.fps.size; }

  add(fp: string, name?: string): void {
    if (this.fps.has(fp)) return;
    this.fps.add(fp);
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${fp} ${Date.now()}${name ? ' ' + name : ''}\n`);
  }

  forget(fp: string): void {
    if (!this.fps.delete(fp)) return;
    if (this.file) fs.writeFileSync(this.file, [...this.fps].map((f) => f + '\n').join(''));
  }
}

export function newPin(): string {
  return randomBytes(8).toString('hex');
}
