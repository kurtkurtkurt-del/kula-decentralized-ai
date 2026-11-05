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

export function loadOrCreate(file = keyFile()): DeviceKey {
  try {
    const pem = fs.readFileSync(file, 'utf8');
    return fromPrivateKey(createPrivateKey({ key: pem, format: 'pem' }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const key = generate();
  const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pem, { mode: 0o600 });
  return key;
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
