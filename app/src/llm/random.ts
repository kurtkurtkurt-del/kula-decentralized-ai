import * as Crypto from 'expo-crypto';

// Random bytes for secrets and codes. `Math.random` (lib/offline's newId) is a plain
// xorshift seeded once per process: its outputs can be reconstructed from a few of them,
// which is fine for an id and not for the cluster secret a qr carries. expo-crypto reads
// the os generator (SecureRandom on Android).
export function randomHex(bytes: number): string {
  return Array.from(Crypto.getRandomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
