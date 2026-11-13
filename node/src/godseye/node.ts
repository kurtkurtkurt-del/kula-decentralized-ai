// god's eye on a computer (11.11.2026): the platform pieces from node, and the eye kula-node has
// always made: notes as files in a dir (<dir>/<id>.json, mode 600, written whole through a tmp
// file), signatures and certificates through node:crypto, and the black box opened in a dir. The
// eye itself (eye.ts) is platform-neutral and shared with the phone (docs/BEYIN.md).
import { createPublicKey, verify, X509Certificate, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GodsEye as Eye, type EyeOptions as CoreOptions } from './eye.js';
import { openBox } from './box.js';
import type { Box, EyeKey, EyeKeys, EyeNotes } from './platform.js';

/** Branch notes as files: <dir>/<id>.json. remove also takes a write's leftover tmp files. */
export function fileNotes(dir: string): EyeNotes {
  const file = (id: string) => path.join(dir, `${id}.json`);
  return {
    read: (id) => {
      try { return fs.readFileSync(file(id), 'utf8'); } catch { return null; }
    },
    write: (id, text) => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file(id)}.${process.pid}.tmp`;
      // the text reaches the disk before the rename, and the rename before the write returns (E7)
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file(id));
      try {
        const dfd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
      } catch {}
    },
    remove: (id) => {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch {}
      let n = 0;
      for (const f of names) {
        if (f !== `${id}.json` && !(f.startsWith(`${id}.json.`) && f.endsWith('.tmp'))) continue;
        try { fs.rmSync(path.join(dir, f), { force: true }); n++; } catch {}
      }
      return n;
    },
  };
}

/** A node public key as the trust branch checks with it: ed25519 signs the text itself, p256 its sha256. */
export function nodeKey(key: KeyObject): EyeKey {
  const ed = key.asymmetricKeyType === 'ed25519';
  return {
    verify: (data, sigB64) => {
      try { return verify(ed ? null : 'sha256', Buffer.from(data, 'utf8'), key, Buffer.from(sigB64, 'base64')); } catch { return false; }
    },
  };
}

export const nodeKeys: EyeKeys = {
  key: (spkiB64) => {
    try { return nodeKey(createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' })); } catch { return null; }
  },
  certSubject: (derB64) => {
    try { return new X509Certificate(Buffer.from(derB64, 'base64')).subject; } catch { return null; }
  },
};

/** the box the eye writes: one given, or one opened in the given dir; no option means no box */
function makeBox(x: Box | { dir: string } | null | undefined): Box | null {
  if (x === null || x === undefined) return null;
  try {
    if (typeof (x as Box).append === 'function') return x as Box;
    const dir = (x as { dir?: unknown }).dir;
    if (typeof dir === 'string') return openBox({ dir });
  } catch {}
  return null;   // a box the eye cannot use is no box, never a stopped eye
}

export type NodeEyeOptions = Omit<CoreOptions, 'notes' | 'box' | 'keys'> & {
  dir: string;                     // where branches keep their notes
  box?: Box | { dir: string };     // the black box; absent means none, so nothing is written
  notes?: EyeNotes;                // instead of files in dir
  keys?: EyeKeys | null;           // node:crypto unless given
};

/** kula-node's eye: the shared eye with files, node:crypto and a black box on disk. */
export class NodeGodsEye extends Eye {
  constructor(opts: NodeEyeOptions) {
    const { dir, box, notes, keys, ...rest } = opts;
    super({ ...rest, notes: notes ?? fileNotes(dir), keys: keys === undefined ? nodeKeys : keys, box: makeBox(box) });
  }
}
