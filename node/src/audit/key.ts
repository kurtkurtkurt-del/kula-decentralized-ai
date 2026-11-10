// The device key: one Ed25519 key pair per computer, kept as PKCS8 PEM at
// ~/.kula-node/device_key.pem. When the platform's OpenSSL has no Ed25519
// (old builds, FIPS modes) a P-256 key stands in. The device id is the first
// 16 bytes of SHA-256 over the public key in SPKI DER form, as 32 hex chars,
// the same bytes Java hands out as PublicKey.getEncoded().
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { home } from '../paths.js';

export type KeyAlg = 'ed25519' | 'p256';

export interface DeviceKey {
  alg: KeyAlg;
  id: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function keyFile(): string {
  return path.join(home(), 'device_key.pem');
}

function algOf(key: KeyObject): KeyAlg {
  if (key.asymmetricKeyType === 'ed25519') return 'ed25519';
  if (key.asymmetricKeyType === 'ec') return 'p256';
  throw new Error(`unsupported key type ${key.asymmetricKeyType}`);
}

export function publicKeyDer(key: KeyObject): Buffer {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  return pub.export({ type: 'spki', format: 'der' }) as Buffer;
}

export function deviceIdOf(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKeyDer(publicKey)).digest('hex').slice(0, 32);
}

export function fromPrivateKey(privateKey: KeyObject): DeviceKey {
  const publicKey = createPublicKey(privateKey);
  return { alg: algOf(privateKey), id: deviceIdOf(publicKey), privateKey, publicKey };
}

// Builds an Ed25519 key from a 32 byte seed: the PKCS8 header for Ed25519 is
// fixed, so the seed can simply be appended to it. Used for test vectors.
export function fromSeed(seed: Buffer): DeviceKey {
  if (seed.length !== 32) throw new Error('an ed25519 seed is 32 bytes');
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return fromPrivateKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
}

export function generate(): DeviceKey {
  try {
    return fromPrivateKey(generateKeyPairSync('ed25519').privateKey);
  } catch {
    return fromPrivateKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);
  }
}

// A key file that is there but cannot be read as a key (cut short, overwritten) is not
// silently replaced: it is moved aside as <name>.broken.<unix ms> and a new one is made,
// and the caller is told so (`broken`) to write it in the ledger. Other errors (no
// permission) are thrown: nothing is replaced then.
export function loadOrCreateKey(file = keyFile(), log: (s: string) => void = (s) => console.error(s)): { key: DeviceKey; broken: string | null } {
  let broken: string | null = null;
  let pem: string | null = null;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (pem !== null) {
    try {
      const key = fromPrivateKey(createPrivateKey({ key: pem, format: 'pem' }));
      tighten(file);
      return { key, broken: null };
    } catch {
      broken = moveAside(file);
      log(`device key ${file} could not be read; kept as ${broken}, a new key is made (the device id changes)`);
    }
  }
  const made = generate();
  const key = writeOnce(file, made.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string) ? made : loadOrCreateKey(file, log).key;
  return { key, broken };
}

export function loadOrCreate(file = keyFile(), log?: (s: string) => void): DeviceKey {
  return loadOrCreateKey(file, log).key;
}

// <file>.broken.<unix ms>, the next free one
export function moveAside(file: string): string {
  let t = Date.now();
  let to = `${file}.broken.${t}`;
  while (fs.existsSync(to)) to = `${file}.broken.${++t}`;
  fs.renameSync(file, to);
  return to;
}

// Writes a new key file, mode 600, all at once: a temp file linked into place, so a second
// process starting at the same moment never reads half a key, and never overwrites one.
// false when another process made the file first.
export function writeOnce(file: string, text: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // a file system without hard links: an exclusive create
    try { fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' }); return true; } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// A key file others can read is made 600 (an older kula-node, a copy by hand).
export function tighten(file: string): void {
  if (process.platform === 'win32') return;
  try { if (fs.statSync(file).mode & 0o077) fs.chmodSync(file, 0o600); } catch {}
}

// Ed25519 signs the message itself; P-256 signs its SHA-256 (ECDSA, DER encoded).
export function signText(key: DeviceKey, text: string): string {
  const data = Buffer.from(text, 'utf8');
  const sig = key.alg === 'ed25519' ? sign(null, data, key.privateKey) : sign('sha256', data, key.privateKey);
  return sig.toString('base64');
}

export function verifyText(publicKey: KeyObject, text: string, sigB64: string): boolean {
  const data = Buffer.from(text, 'utf8');
  const sig = Buffer.from(sigB64, 'base64');
  try {
    return algOf(publicKey) === 'ed25519' ? verify(null, data, publicKey, sig) : verify('sha256', data, publicKey, sig);
  } catch {
    return false;
  }
}
