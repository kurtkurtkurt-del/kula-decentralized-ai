// The ledger: one JSON object per line, each line naming the sha256 of the
// line before it and carrying the device's signature. Anyone holding the
// file and the public key can tell whether a line was changed, dropped or
// inserted. The format is shared with the phone's auditor (beyin/check).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { signText, verifyText, type DeviceKey } from './key.js';
import type { KeyObject } from 'node:crypto';

export type Kind = 'pair' | 'connect' | 'reject' | 'load' | 'claim' | 'health' | 'end';
export const KINDS: Kind[] = ['pair', 'connect', 'reject', 'load', 'claim', 'health', 'end'];
export const GENESIS = '0'.repeat(64);
export const ROTATE_BYTES = 5 * 1024 * 1024;

export type Fields = Record<string, string | number | boolean | null>;

export interface Entry extends Fields {
  t: number;
  kind: Kind;
  peer: string;
  prev: string;
  sig: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Serialises {t, kind, peer, ...fields, prev} then signs that, and appends sig
// last. Keys stay in this order and JSON.stringify adds no spaces. The signed text is
// the line up to and including the prev value's closing quote, that is without the
// object's closing brace, the same bytes the phone's Ledger.kt signs (AUDIT.md).
export function makeLine(key: DeviceKey, t: number, kind: Kind, peer: string, fields: Fields, prev: string): { line: string; entry: Entry } {
  const body: Record<string, unknown> = { t, kind, peer };
  for (const [k, v] of Object.entries(fields)) {
    if (k === 't' || k === 'kind' || k === 'peer' || k === 'prev' || k === 'sig') continue;
    body[k] = v;
  }
  body.prev = prev;
  const unsigned = JSON.stringify(body);
  body.sig = signText(key, unsigned.slice(0, -1));
  return { line: JSON.stringify(body), entry: body as Entry };
}

// The signed part of a line: everything before the trailing ,"sig":"..."}. Taken from
// the raw text, not re-serialised, so a line another implementation wrote verifies too.
const SIG_TAIL = /,"sig":"[A-Za-z0-9+/=]*"\}$/;
export function unsignedOf(line: string): string | null {
  const m = SIG_TAIL.exec(line);
  if (!m) return null;
  return line.slice(0, m.index);
}

export interface Problem { n: number; reason: 'json' | 'prev' | 'sig' | 'kind'; }

// Walks lines in order and reports every break in the chain. `prev` is the
// hash the first line should name; pass the last line of the previous file
// when the ledger was rotated.
export function verifyLines(lines: string[], publicKey: KeyObject | null, prev = GENESIS): { ok: boolean; count: number; problems: Problem[]; last: string } {
  const problems: Problem[] = [];
  let n = 0;
  for (const line of lines) {
    if (!line) continue;
    n++;
    let obj: any;
    try { obj = JSON.parse(line); } catch { problems.push({ n, reason: 'json' }); prev = sha256Hex(line); continue; }
    if (!KINDS.includes(obj.kind)) problems.push({ n, reason: 'kind' });
    if (obj.prev !== prev) problems.push({ n, reason: 'prev' });
    if (publicKey) {
      const unsigned = unsignedOf(line);
      if (!unsigned || !verifyText(publicKey, unsigned, obj.sig)) problems.push({ n, reason: 'sig' });
    }
    prev = sha256Hex(line);
  }
  return { ok: problems.length === 0, count: n, problems, last: prev };
}

export function readLines(file: string): string[] {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0); } catch { return []; }
}

function lastLine(file: string): string | null {
  const lines = readLines(file);
  return lines.length ? lines[lines.length - 1] : null;
}

// Rotated files sit next to the live one as ledger.<unix ms>.jsonl; a verify
// walks them oldest first so the chain is one piece.
export function chainFiles(file: string): string[] {
  const dir = path.dirname(file);
  const base = path.basename(file, '.jsonl');
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.jsonl$`);
  let old: { t: number; p: string }[] = [];
  try {
    old = fs.readdirSync(dir).map((n) => re.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ t: Number(m[1]), p: path.join(dir, m[0]) }));
  } catch {}
  old.sort((a, b) => a.t - b.t);
  return [...old.map((o) => o.p), file];
}

// A process that died mid-append leaves a last line without its "\n"; the next line would
// run on from it and both would be lost. Cuts the file back to just after its last "\n" and
// says how many bytes went (0: nothing to cut).
export function cutTorn(file: string): number {
  let fd: number;
  try { fd = fs.openSync(file, 'r+'); } catch { return 0; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return 0;
    const one = Buffer.alloc(1);
    fs.readSync(fd, one, 0, 1, size - 1);
    if (one[0] === 10) return 0;
    // walk back in blocks to the last "\n" (a line is short; a torn file is rare)
    const block = Buffer.alloc(64 * 1024);
    let end = size;
    let keep = 0;
    while (end > 0) {
      const start = Math.max(0, end - block.length);
      const n = fs.readSync(fd, block, 0, end - start, start);
      const i = block.subarray(0, n).lastIndexOf(10);
      if (i >= 0) { keep = start + i + 1; break; }
      end = start;
    }
    fs.ftruncateSync(fd, keep);
    return size - keep;
  } finally { fs.closeSync(fd); }
}

export class Ledger {
  private prev: string;
  private size: number;
  // an append threw (disk full, killed write): look for a torn line before the next one
  private dirty = false;

  constructor(readonly file: string, readonly key: DeviceKey, readonly now: () => number = Date.now, readonly rotateBytes = ROTATE_BYTES) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const torn = cutTorn(file);
    // the live file may hold nothing yet (or nothing whole) after a rotation: then the
    // chain goes on from the newest rotated file
    let last: string | null = null;
    for (const f of chainFiles(file).reverse()) { last = lastLine(f); if (last) break; }
    this.prev = last ? sha256Hex(last) : GENESIS;
    try { this.size = fs.statSync(file).size; } catch { this.size = 0; }
    // the cut is itself written down and signed
    if (torn > 0) this.append('health', 'self', { torn });
  }

  append(kind: Kind, peer: string, fields: Fields = {}): Entry {
    if (this.dirty) this.repair();
    if (this.size >= this.rotateBytes) this.rotate();
    const { line, entry } = makeLine(this.key, this.now(), kind, peer, fields, this.prev);
    try {
      fs.appendFileSync(this.file, line + '\n');
    } catch (e) {
      this.dirty = true;
      throw e;
    }
    this.prev = sha256Hex(line);
    this.size += Buffer.byteLength(line) + 1;
    return entry;
  }

  private repair() {
    this.dirty = false;
    const torn = cutTorn(this.file);
    const last = lastLine(this.file);
    this.prev = last ? sha256Hex(last) : this.prev;
    try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
    if (torn > 0) this.append('health', 'self', { torn });
  }

  // The old file keeps its name plus a stamp; the next line still names the
  // hash of the old file's last line, so the chain runs across files.
  private rotate() {
    const stamp = this.now();
    const dir = path.dirname(this.file);
    const base = path.basename(this.file, '.jsonl');
    let target = path.join(dir, `${base}.${stamp}.jsonl`);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base}.${stamp + i}.jsonl`);
    fs.renameSync(this.file, target);
    this.size = 0;
  }

  tail(n: number): Entry[] {
    const lines = readLines(this.file);
    return lines.slice(Math.max(0, lines.length - n)).map((l) => JSON.parse(l) as Entry);
  }
}

// Verifies every file of the chain, oldest first.
export function verifyChain(file: string, publicKey: KeyObject | null): { ok: boolean; count: number; files: { file: string; count: number; problems: Problem[] }[] } {
  let prev = GENESIS;
  let count = 0;
  const files = chainFiles(file).map((f) => {
    const r = verifyLines(readLines(f), publicKey, prev);
    prev = r.last;
    count += r.count;
    return { file: f, count: r.count, problems: r.problems };
  });
  return { ok: files.every((f) => f.problems.length === 0), count, files };
}
