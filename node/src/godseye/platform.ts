// god's eye's platform (11.11.2026): the few things the eye cannot do in plain TypeScript, as
// small interfaces a platform fills in. One source of the eye runs on a computer and on a phone
// (docs/BEYIN.md "one eye, two homes"): kula-node gives it files and node:crypto (node.ts), the
// app gives it its kv-store and its own security report (app/src/eye/). Nothing in this file,
// nor in eye.ts, types.ts, hash.ts, boxfacts.ts or branches/, may import a node: module; box.ts
// and node.ts are the computer's alone. app/src/__tests__/eye-shared.test.ts holds that line.

/** Where the branches keep their notes: one json text per branch id. Sync, like the branches. */
export interface EyeNotes {
  read(id: string): string | null;
  write(id: string, text: string): void;   // may throw; the eye logs it
  /** forgets one branch's notes; how many stored pieces went (files on a computer) */
  remove(id: string): number;
}

/** A device's public key, read once: whether a signature over a text is its own. */
export interface EyeKey {
  verify(data: string, sigB64: string): boolean;
}

/** Signatures and certificates, for the trust branch. A platform without them gives null and
 *  the trust branch says what it could not check, never that it holds. */
export interface EyeKeys {
  /** a spki public key (base64 der), or null when it is not a key this platform reads */
  key(spkiB64: string): EyeKey | null;
  /** a der certificate's (base64) subject line, "CN=…", or null */
  certSubject(derB64: string): string | null;
}

/** Notes in memory: tests, and a platform that keeps nothing. */
export function memoryNotes(seed: Record<string, string> = {}): EyeNotes & { all(): Record<string, string> } {
  const m = new Map(Object.entries(seed));
  return {
    read: (id) => m.get(id) ?? null,
    write: (id, text) => { m.set(id, text); },
    remove: (id) => (m.delete(id) ? 1 : 0),
    all: () => Object.fromEntries(m),
  };
}

// ---- the black box's shape (box.ts opens one on a computer; the eye only holds it)

export interface BoxRecord {
  n: number;
  t: number;
  k: string;
  b: string | null;
  x: unknown;
  p: string;
  h: string;
}

export interface BoxQuery {
  fromN?: number;
  toN?: number;
  fromT?: number;
  toT?: number;
  kind?: string;
  branch?: string;
  limit?: number;
}

export interface BoxVerify {
  ok: boolean;
  from: number;
  count: number;
  head: string | null;
  problem: string | null;
}

export interface BoxStatus {
  count: number;
  from: number;
  head: string | null;
  bytes: number;
  segments: number;
  ok: boolean;
  problem: string | null;
}

export interface Box {
  append(t: number, kind: string, branch: string | null, payload: unknown): boolean;
  verify(): BoxVerify;
  read(q?: BoxQuery): BoxRecord[];
  status(): BoxStatus;
  accept(): void;
}
