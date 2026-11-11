// god's eye, the black box: an append-only, hash-chained record on disk. The eye writes one record
// for everything that happens — every look, every feed line, every verdict, every decision of the
// person — so that afterwards the story cannot be changed without it showing. This file is the
// recorder only: the eye hands it records and it keeps them; reading the record back is verify()
// and read().
//
// a record is one line of a segment file, keys in exactly this order:
//   {"n":<sequence>,"t":<ms>,"k":"<kind>","b":<branch or null>,"x":<payload>,"p":"<previous h>","h":"<hash>"}
// n is 1-based and one more for each record. t is the caller's time and is never the order: the
// record is ordered by n alone, so a clock that jumps back or far ahead changes nothing on disk.
// h = sha256 hex of the exact bytes of the line up to and excluding the ,"h":"<hash>"} tail, i.e.
//   h = sha256('{"n":<n>,"t":<t>,"k":"<kind>","b":<branch>,"x":<payload>,"p":"<previous h>"')
// and p is the h of the record before it (64 zeros at n = 1). A changed, removed, inserted or
// reordered record therefore breaks the chain from there on, and verify() names the n where.
//
// files in <dir> (the dir is made 0700, every file 0600):
//   box-000001.jsonl, box-000002.jsonl, …  one record per line. A new segment starts when the
//                                          current one would pass SEGMENT_BYTES (1 MiB).
//   head.json  { n, h } of the last record, written atomically (temp file, rename) after every
//              append. A chain is always consistent after cutting its last records, so the head is
//              what lets verify() see that the END was cut off. Whenever the head and the record
//              disagree in a way a crash cannot explain — and the record is not one this box itself
//              last wrote (a head write that failed leaves its own records behind) — the mismatch
//              is written INTO the chain as a record of kind "tamper" ({ problem, headN, headH,
//              lastN, lastH }); head.json carries { n, h, problem } as a mirror for the person.
//              A tamper with no "accept" record after it is a standing problem by itself, whatever
//              head.json says; accept() writes that record, then clears the mirror.
//              A head write that fails (a read-only dir, a full disk) is not tampering: status()
//              says "the head file could not be written: …" and the next successful head write
//              clears it.
//              The one shape that is a crash and not a loss — the record is exactly one past the
//              head, i.e. the line was written and the head was not — is healed by rewriting the
//              head; one extra record after the head is therefore indistinguishable from a crash.
//              What still escapes: someone who rewrites the segments AND head.json together. The
//              head is shown to the person so they can note it down; signing it is a later task.
//
// retention is by size, never by time (a wrong clock must never delete history): when the segments
// together pass KEEP_BYTES (256 MiB) a record of kind "retention" ({ dropped: <segment name>,
// keptFrom: n }) is written before the oldest segment is deleted, so a missing front is either
// explained by that record or reported by verify(). The first record of the oldest kept segment
// then has a p that cannot be checked; verify() treats it as the anchor and reports from which n
// the record is kept. The newest segment is never deleted.
//
// a torn last line (a partial write) is cut off at open and recorded as kind "repair" with the
// bytes removed; a failed write is cut back to the size before it, and if that is impossible the
// box refuses further appends (status().problem says why) instead of writing after torn bytes.
//
// nothing here throws out of the API: a failure is returned (append false, a verify/status problem)
// or kept in status().problem.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isObj, isTime, num } from './branches/guard.js';
import type { Box, BoxQuery, BoxRecord, BoxStatus, BoxVerify } from './platform.js';
// the box's shape lives with the eye's other platform pieces (platform.ts): the eye itself is
// platform-neutral and only ever holds a Box, opened here on a computer
export type { Box, BoxQuery, BoxRecord, BoxStatus, BoxVerify } from './platform.js';

export const SEGMENT_BYTES = 1024 * 1024;            // a segment passes this: the next record starts a new one
export const KEEP_BYTES = 256 * 1024 * 1024;         // the segments together pass this: the oldest goes
export const PAYLOAD_MAX = 16_384;                   // a payload's JSON longer than this is cut
export const BRANCH_MAX = 40;                        // a branch id is a short word

const ZERO = '0'.repeat(64);                         // p of the first record
const KIND = /^[a-z-]{1,20}$/;                       // a kind is a short lower-case word
const SEGMENT_NAME = /^box-(\d{6})\.jsonl$/;         // anything else in the dir is left alone
const HEX64 = /^[0-9a-f]{64}$/;
const HEAD = 'head.json';
const LIMIT = 200;                                   // read's default
const LIMIT_MAX = 5000;                              // read's bound
const PROBLEM_MAX = 1000;                            // a problem kept in a head file is not unbounded

export interface BoxOptions {
  dir: string;
  segmentBytes?: number;
  keepBytes?: number;
  payloadMax?: number;
}


/** what a caught value says: a caught value may be null or undefined, which has no .message */
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** a head file's shape; n 0 is the empty head. the problem field in the file is a mirror for the
 *  person only: the chain's own tamper/accept records are what verify and status trust */
interface Head { n: number; h: string }

/** the chain's end on disk */
interface Tail { n: number; h: string; t: number }

/** the hash of everything before the ,"h":"…"} tail: the exact bytes as written */
const hashOf = (base: string): string => createHash('sha256').update(base, 'utf8').digest('hex');

/** the last line of a segment, read from the end so a long segment is not read whole; throws when
 *  the file cannot be read (the caller refuses appends rather than guessing the next n) */
function lastLineOf(file: string): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    let want = Math.min(size, 64 * 1024);
    for (;;) {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      let text = buf.toString('utf8');
      const whole = want === size;
      if (text.endsWith('\n')) text = text.slice(0, -1);
      const nl = text.lastIndexOf('\n');
      if (nl >= 0) return text.slice(nl + 1);
      if (whole) return text;
      want = Math.min(size, want * 2);
    }
  } finally {
    fs.closeSync(fd);
  }
}

class Recorder implements Box {
  private readonly dir: string;
  private readonly headFile: string;
  private readonly segmentBytes: number;
  private readonly keepBytes: number;
  private readonly payloadMax: number;
  private segs: number[] = [];        // the segment numbers on disk, oldest first
  private cur = 1;                    // the segment the next record goes to
  private totalBytes = 0;             // the segments' size together, for retention
  private from = 0;                   // the n of the oldest record kept
  private lastN = 0;                  // n of the last record on disk
  private lastH: string | null = null;  // its h
  private lastT = 0;                  // its t, what a record with no usable time is stamped with
  private problem: string | null = null; // the chain's standing tamper problem, until accept()
  private writeProblem: string | null = null; // the last write that failed
  private blocked: string | null = null;      // the box may not append: why
  private mine = false;                       // the last record on disk is one this box wrote

  constructor(opts: BoxOptions) {
    const o: Record<string, unknown> = isObj(opts) ? opts : {};
    const dir = typeof o.dir === 'string' ? o.dir : null;   // '' fails at mkdir, before any write
    this.dir = dir ?? '';
    this.headFile = dir === null ? '' : path.join(dir, HEAD);
    this.segmentBytes = num(o.segmentBytes, 1, 1e12) ?? SEGMENT_BYTES;
    this.keepBytes = num(o.keepBytes, 1, 1e15) ?? KEEP_BYTES;
    this.payloadMax = num(o.payloadMax, 0, 1e9) ?? PAYLOAD_MAX;
    if (dir === null) {
      // no dir means no place to write: never fall back to the process's own directory
      this.blocked = 'the box has no dir';
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.load();
    } catch (e) {
      this.blocked = `could not open ${dir}: ${why(e)}`;
    }
  }

  /** what open does: make sense of what the last run left, repair a torn tail, remember the head */
  private load(): void {
    this.segs = this.segmentNumbers();
    this.cur = this.segs.length ? this.segs[this.segs.length - 1] : 1;
    const cut = this.repairTail();
    const tail = this.tailOfDisk(this.segs);
    this.lastN = tail ? tail.n : 0;
    this.lastH = tail ? tail.h : null;
    this.lastT = tail ? tail.t : 0;
    // the first record kept may sit after an empty stray segment: scan until one is found
    this.from = 0;
    for (const i of this.segs) {
      const n = this.firstRecordN(i);
      if (n !== null) {
        this.from = n;
        break;
      }
    }
    let total = 0;
    for (const i of this.segs) total += this.sizeOf(i);
    this.totalBytes = total;
    if (!this.reconcile()) return;
    if (cut > 0) this.append(this.lastT, 'repair', null, { cut });
  }

  append(time: number, kind: string, branch: string | null, payload: unknown): boolean {
    if (this.blocked !== null) return false;
    try {
      // what is on disk is compared with the head before every append: a mismatch found here is
      // tamper evidence and must be written into the chain before the new record, not after it
      if (!this.reconcile()) return false;
      if (!this.writeOne(time, kind, branch, payload)) return false;
      this.trim();
      return true;
    } catch (e) {
      this.writeProblem = `could not append: ${why(e)}`;
      return false;
    }
  }

  /** the person takes the loss the head remembered; the record keeps that they did, and why */
  accept(): void {
    try {
      const problem = this.problem;   // only the chain's tamper evidence is accepted
      if (problem === null) return;
      if (!this.append(this.lastT, 'accept', null, { problem })) return;
      if (this.problem !== problem) return;   // an append found a newer problem: it stays
      this.problem = null;
      if (!this.writeHead(this.lastN, this.lastH ?? ZERO)) this.problem = problem;
    } catch (e) {
      this.writeProblem = `could not accept: ${why(e)}`;
    }
  }

  verify(): BoxVerify {
    let from = 0;
    let count = 0;
    let head: string | null = null;
    try {
      const segs = this.segmentNumbers();
      const whole = segs.length > 0 && segs[0] === 1;   // segment 1 kept: nothing before it went
      let prevN: number | null = null;
      let prevH: string | null = null;
      let frontStart = false;                           // the first record is the true start of the chain
      let lastRetention: number | null = null;          // where the latest retention record says it kept from
      let tamperN = 0;                                  // the latest tamper record, and its problem
      let tamperProblem: string | null = null;
      let acceptN = 0;                                  // the latest record that accepted a tamper
      for (const seg of segs) {
        const file = this.segFile(seg);
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch (e) {
          return this.bad(from, count, head, `${path.basename(file)} cannot be read: ${why(e)}`);
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === '') {
            // the newline that ends the last record leaves one empty piece; anywhere else an
            // empty line is bytes that are not a record
            if (i === lines.length - 1) continue;
            return this.bad(from, count, head, `${path.basename(file)} line ${i + 1} is empty`);
          }
          let rec: unknown;
          try {
            rec = JSON.parse(line);
          } catch {
            return this.bad(from, count, head, `${path.basename(file)} line ${i + 1} is not json`);
          }
          if (!isObj(rec)) return this.bad(from, count, head, `${path.basename(file)} line ${i + 1} is not a record`);
          const n = num(rec.n, 1, Number.MAX_SAFE_INTEGER);
          if (n === null || !Number.isSafeInteger(n)) return this.bad(from, count, head, `${path.basename(file)} line ${i + 1} has no sequence number`);
          if (typeof rec.h !== 'string' || !HEX64.test(rec.h)) return this.bad(from, count, head, `record n ${n}: h is not a hash`);
          if (typeof rec.p !== 'string' || !HEX64.test(rec.p)) return this.bad(from, count, head, `record n ${n}: p is not a hash`);
          // the hash is over the exact bytes before the tail, not over a re-encoded object; an
          // extra key after h changes those bytes too and is rejected here
          const at = line.lastIndexOf(',"h":"');
          if (line.slice(at) !== `,"h":"${rec.h}"}`) return this.bad(from, count, head, `record n ${n}: its tail is not a hash`);
          if (hashOf(line.slice(0, at)) !== rec.h) return this.bad(from, count, head, `record n ${n}: h does not match its line`);
          if (prevN === null) {
            from = n;
            // n 1 with p zeros is the true start of the chain whatever the file is called; a box
            // that first wrote into segment 5 (an empty stray was there) is still whole
            frontStart = n === 1 && rec.p === ZERO;
            // the first record can be checked against the start of the chain only when segment 1
            // is still there; after retention its p points at a record that is gone
            if (whole) {
              if (n !== 1) return this.bad(from, count, head, `the record starts at n ${n}, not 1`);
              if (rec.p !== ZERO) return this.bad(from, count, head, `record n ${n}: p is not the start of the chain`);
            }
          } else {
            if (n !== prevN + 1) return this.bad(from, count, head, `record n ${n}: expected n ${prevN + 1}`);
            if (rec.p !== prevH) return this.bad(from, count, head, `record n ${n}: p does not link to the record before it`);
          }
          if (rec.k === 'retention' && isObj(rec.x)) {
            const kept = num(rec.x.keptFrom, 1, Number.MAX_SAFE_INTEGER);
            if (kept !== null && Number.isSafeInteger(kept)) lastRetention = kept;
          }
          if (rec.k === 'tamper') {
            tamperN = n;
            tamperProblem = this.recordProblem(rec.x, n);
          } else if (rec.k === 'accept') {
            acceptN = n;
          }
          count++;
          prevN = n;
          prevH = rec.h;
          head = rec.h;
        }
      }
      // a tamper with no accept after it is a standing problem by itself, whatever head.json says
      let problem: string | null = tamperN > acceptN ? (tamperProblem ?? `a tamper record at n ${tamperN} has not been accepted`) : null;
      // the front: after retention the first p cannot be checked, but the retention record says
      // where the kept record starts; a missing front without such a record is a loss
      if (problem === null && count > 0 && segs.length > 0 && segs[0] !== 1 && !frontStart) {
        if (lastRetention === null) problem = `the record starts at n ${from}, but segment 1 is gone and no retention record says why`;
        else if (from !== lastRetention) problem = `the record starts at n ${from}, but the retention record says it kept from ${lastRetention}`;
      }
      // the end: a chain is always consistent after cutting its last records, so the head is what
      // says the end was cut; only one record past the head is the crash shape
      if (problem === null) {
        const saved = this.readHead();
        const headN = saved ? saved.n : 0;
        const lastN = count === 0 ? 0 : (prevN as number);
        const lastH = count === 0 ? ZERO : (head as string);
        if (count === 0) {
          if (saved !== null && saved.n > 0) problem = this.ahead(saved.n, 0);
        } else if (saved !== null && saved.n === lastN && saved.h === lastH) {
          problem = null;   // the head agrees; the chain's own verdict was already taken above
        } else if (lastN === headN + 1) {
          problem = null;   // the line got written and the head did not: the crash shape
        } else if (saved !== null && saved.n === lastN) {
          problem = this.mismatch(saved.h, lastN, lastH);
        } else if (saved !== null && saved.n > lastN) {
          problem = this.ahead(saved.n, lastN);
        } else {
          problem = this.behind(lastN - headN);
        }
      }
      return { ok: problem === null, from, count, head, problem };
    } catch (e) {
      return { ok: false, from, count, head, problem: `verify failed: ${why(e)}` };
    }
  }

  read(q: BoxQuery = {}): BoxRecord[] {
    const out: BoxRecord[] = [];
    try {
      const query: Record<string, unknown> = isObj(q) ? q : {};
      const limit = limitOf(query.limit);
      if (limit === 0) return out;
      const fromN = finite(query.fromN);
      const toN = finite(query.toN);
      const fromT = finite(query.fromT);
      const toT = finite(query.toT);
      const kind = typeof query.kind === 'string' ? query.kind : null;
      const branch = typeof query.branch === 'string' ? query.branch : null;
      for (const seg of this.segmentNumbers()) {
        let text: string;
        try {
          text = fs.readFileSync(this.segFile(seg), 'utf8');
        } catch {
          continue;
        }
        for (const line of text.split('\n')) {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            continue;   // a broken line is verify()'s to name, not read()'s to throw on
          }
          if (!isObj(raw)) continue;
          const n = num(raw.n, 1, Number.MAX_SAFE_INTEGER);
          if (n === null || !Number.isSafeInteger(n)) continue;
          const t = finite(raw.t) ?? 0;
          const k = typeof raw.k === 'string' ? raw.k : 'other';
          const b = typeof raw.b === 'string' ? raw.b : null;
          if (fromN !== null && n < fromN) continue;
          if (toN !== null && n > toN) continue;
          if (fromT !== null && t < fromT) continue;
          if (toT !== null && t > toT) continue;
          if (kind !== null && k !== kind) continue;
          if (branch !== null && b !== branch) continue;
          out.push({ n, t, k, b, x: raw.x, p: typeof raw.p === 'string' ? raw.p : '', h: typeof raw.h === 'string' ? raw.h : '' });
          if (out.length >= limit) return out;
        }
      }
      return out;
    } catch {
      return out;   // whatever happened, the caller gets what was read so far
    }
  }

  status(): BoxStatus {
    const count = this.count();
    try {
      const segs = this.segmentNumbers();
      let bytes = 0;
      for (const i of segs) bytes += this.sizeOf(i);
      let problem = this.blocked ?? this.problem ?? this.writeProblem;
      if (problem === null) problem = this.headProblem(this.readHead());
      return { count, from: this.from, head: this.lastH, bytes, segments: segs.length, ok: problem === null, problem };
    } catch (e) {
      const problem = this.blocked ?? this.problem ?? this.writeProblem ?? `could not read ${this.dir}: ${why(e)}`;
      return { count, from: this.from, head: this.lastH, bytes: 0, segments: 0, ok: false, problem };
    }
  }

  // ---- the chain

  /** compare what is on disk with the head; heal the one crash shape, write every other mismatch
   *  into the chain as a tamper record and keep it until accept(). a tamper with no accept after
   *  it in the chain is a standing problem even when the head looks whole. */
  private reconcile(): boolean {
    try {
      const segs = this.segmentNumbers();
      const tail = this.tailOfDisk(segs);
      this.segs = segs;
      if (segs.length) this.cur = Math.max(this.cur, segs[segs.length - 1]);
      const lastN = tail ? tail.n : 0;
      const lastH = tail ? tail.h : null;
      // records on disk that this box itself last wrote are ours: a head that lags behind them is
      // a head write that failed, never a tamper record
      const ours = this.mine && tail !== null && this.lastN === tail.n && this.lastH === tail.h;
      if (!ours) this.problem = this.scanVerdicts(segs);   // the chain's own tamper verdict
      this.lastN = lastN;
      this.lastH = lastH;
      this.lastT = tail ? tail.t : 0;
      const saved = this.readHead();
      const headN = saved ? saved.n : 0;
      const headH = saved ? saved.h : ZERO;
      const headAtTail = saved !== null && saved.n === lastN && saved.h === lastH;
      if (lastN === 0) {
        if (saved === null || saved.n === 0) return true;
        return this.writeTamper(this.ahead(saved.n, 0), headN, headH, 0, ZERO);
      }
      if (ours) {
        // our own records are on disk: heal a head that lags, or say why it cannot be written
        if (!headAtTail && this.writeHead(lastN, lastH ?? ZERO)) this.writeProblem = null;
        return true;
      }
      if (headAtTail) return true;
      if (lastN === headN + 1) {
        // the line was written and the head was not: the one crash shape, healed silently
        if (this.writeHead(lastN, lastH ?? ZERO)) this.writeProblem = null;
        return true;
      }
      return this.writeTamper(this.headMismatch(headN, headH, lastN, lastH ?? ZERO), headN, headH, lastN, lastH ?? ZERO);
    } catch (e) {
      // n cannot be trusted, so no append may guess it: a duplicate n would be worse than a stop
      this.blocked = `the record cannot be read: ${why(e)}`;
      return false;
    }
  }

  /** the chain's own verdict: the problem of the latest tamper record, while no accept follows it */
  private scanVerdicts(segs: number[]): string | null {
    let tamperN = 0;
    let tamperProblem: string | null = null;
    let acceptN = 0;
    for (const seg of segs) {
      let text: string;
      try {
        text = fs.readFileSync(this.segFile(seg), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (line === '') continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isObj(rec)) continue;
        const n = num(rec.n, 1, Number.MAX_SAFE_INTEGER);
        if (n === null || !Number.isSafeInteger(n)) continue;
        if (rec.k === 'tamper') {
          tamperN = n;
          tamperProblem = this.recordProblem(rec.x, n);
        } else if (rec.k === 'accept') {
          acceptN = n;
        }
      }
    }
    return tamperN > acceptN ? tamperProblem : null;
  }

  /** a tamper record's own words, or a plain stand-in when its payload has none */
  private recordProblem(x: unknown, n: number): string {
    return isObj(x) && typeof x.problem === 'string' && x.problem.length > 0
      ? x.problem.slice(0, PROBLEM_MAX)
      : `a tamper record at n ${n} has not been accepted`;
  }

  /** the chain's end on disk; skips empty segments; throws when a segment cannot be read or its
   *  last line is not a record */
  private tailOfDisk(segs: number[]): Tail | null {
    for (let s = segs.length - 1; s >= 0; s--) {
      const file = this.segFile(segs[s]);
      const line = lastLineOf(file);
      if (line === null) continue;
      const name = path.basename(file);
      const rec = JSON.parse(line) as Record<string, unknown>;   // a torn tail was cut at open
      const n = num(rec.n, 1, Number.MAX_SAFE_INTEGER);
      if (n === null || !Number.isSafeInteger(n) || typeof rec.h !== 'string' || !HEX64.test(rec.h)) {
        throw new Error(`${name} ends with a line that is not a record`);
      }
      return { n, h: rec.h, t: isTime(rec.t) ? rec.t : 0 };
    }
    return null;
  }

  private writeTamper(problem: string, headN: number, headH: string, lastN: number, lastH: string): boolean {
    this.problem = problem;
    return this.writeOne(this.lastT, 'tamper', null, { problem, headN, headH, lastN, lastH });
  }

  /** one record and its head; the caller has reconciled, so n and p follow the disk. returns false
   *  only when the record itself could not be written (a failed head write is healed next time). */
  private writeOne(time: number, kind: string, branch: string | null, payload: unknown, noRoll = false): boolean {
    const k = typeof kind === 'string' && KIND.test(kind) ? kind : 'other';
    const b = typeof branch === 'string' ? branch.slice(0, BRANCH_MAX) : null;
    let t = time;
    let x = this.payloadJson(payload);
    if (!isTime(t)) {
      // a time the eye cannot use is no reason to lose the record: stamp it with the last good
      // time and keep the fact in the payload
      t = isTime(this.lastT) ? this.lastT : 0;
      x = `{"badTime":true,"x":${x}}`;
    }
    const n = this.lastN + 1;
    const p = this.lastH ?? ZERO;
    const base = `{"n":${n},"t":${t},"k":${JSON.stringify(k)},"b":${b === null ? 'null' : JSON.stringify(b)},"x":${x},"p":"${p}"`;
    const h = hashOf(base);
    const line = `${base},"h":"${h}"}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    let file = this.segFile(this.cur);
    let before = this.sizeOf(this.cur);
    // a new segment when this one would pass the bound; an empty one is never rolled, so a record
    // bigger than segmentBytes still gets written
    if (!noRoll && before > 0 && before + bytes > this.segmentBytes) {
      this.cur = Math.max(this.cur, this.segs.length ? this.segs[this.segs.length - 1] : 0) + 1;
      file = this.segFile(this.cur);
      before = 0;
    }
    try {
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (e) {
      // a half written line must not stay: the next record would be glued onto it, and the next
      // open would cut that honest record off with the torn bytes
      try {
        fs.truncateSync(file, before);
      } catch (e2) {
        let exists = true;
        try { exists = fs.existsSync(file); } catch { exists = true; }
        if (exists) this.blocked = `a torn write could not be removed from ${file}: ${why(e2)}`;
      }
      this.writeProblem = `could not write ${file}: ${why(e)}`;
      return false;
    }
    if (this.segs[this.segs.length - 1] !== this.cur) this.segs.push(this.cur);
    this.totalBytes += bytes;
    this.lastN = n;
    this.lastH = h;
    this.lastT = t;
    this.mine = true;   // the record on disk is one this box wrote: a stale head is not tampering
    if (this.from === 0) this.from = n;
    if (this.writeHead(n, h)) this.writeProblem = null;
    return true;
  }

  /** the head on disk: the last record and, while it lasts, the tamper problem */
  private writeHead(n: number, h: string): boolean {
    try {
      const body = this.problem === null ? { n, h } : { n, h, problem: this.problem };
      const tmp = `${this.headFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(tmp, this.headFile);
      return true;
    } catch (e) {
      this.writeProblem = `the head file could not be written: ${why(e)}`;
      return false;
    }
  }

  // ---- what is on disk

  private segFile(i: number): string {
    return path.join(this.dir, `box-${String(i).padStart(6, '0')}.jsonl`);
  }

  private segmentNumbers(): number[] {
    const out: number[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      const m = SEGMENT_NAME.exec(name);
      if (!m) continue;   // box-abc.jsonl, a temp file, anything else: not ours
      const i = Number(m[1]);
      if (Number.isSafeInteger(i) && i >= 1) out.push(i);
    }
    return out.sort((a, b) => a - b);
  }

  private sizeOf(i: number): number {
    try {
      return fs.statSync(this.segFile(i)).size;
    } catch {
      return 0;
    }
  }

  /** cut a torn last line off the newest segment; returns the bytes removed (0 when it is whole).
   *  a line is torn when it has no newline after it, or the line the file ends with is not json.
   *  a file that cannot be read or cut throws: the caller will refuse appends. */
  private repairTail(): number {
    if (!this.segs.length) return 0;
    const file = this.segFile(this.segs[this.segs.length - 1]);
    const buf = fs.readFileSync(file);
    const size = buf.length;
    let good = size;
    if (size > 0 && buf[size - 1] !== 0x0a) {
      good = buf.lastIndexOf(0x0a) + 1;
    } else if (size > 0) {
      const nl = buf.lastIndexOf(0x0a, size - 2);
      const last = buf.subarray(nl + 1, size - 1).toString('utf8');
      try {
        JSON.parse(last);
      } catch {
        good = nl + 1;
      }
    }
    const cut = size - good;
    if (cut > 0) fs.truncateSync(file, good);
    return cut;
  }

  /** the first record's n in a segment, or null when it holds none */
  private firstRecordN(seg: number): number | null {
    let text: string;
    try {
      text = fs.readFileSync(this.segFile(seg), 'utf8');
    } catch {
      return null;
    }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        const rec = JSON.parse(line);
        if (!isObj(rec)) continue;
        const n = num(rec.n, 1, Number.MAX_SAFE_INTEGER);
        if (n !== null && Number.isSafeInteger(n)) return n;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** where the oldest record will start if the oldest segment goes */
  private firstKeptFrom(): number | null {
    for (let i = 1; i < this.segs.length; i++) {
      const n = this.firstRecordN(this.segs[i]);
      if (n !== null) return n;
    }
    return null;
  }

  private readHead(): Head | null {
    try {
      const v = JSON.parse(fs.readFileSync(this.headFile, 'utf8'));
      if (!isObj(v)) return null;
      const n = num(v.n, 0, Number.MAX_SAFE_INTEGER);
      if (n === null || !Number.isSafeInteger(n)) return null;
      if (typeof v.h !== 'string' || !HEX64.test(v.h)) return null;
      return { n, h: v.h };
    } catch {
      return null;
    }
  }

  // ---- the small pieces

  /** the payload as json, or the marker that says it was cut: a value that cannot be serialised
   *  (a cycle, a BigInt, undefined) or whose json is longer than payloadMax is not kept */
  private payloadJson(payload: unknown): string {
    try {
      const json = JSON.stringify(payload);
      if (json.length > this.payloadMax) return `{"cut":true,"bytes":${json.length}}`;
      return json;
    } catch {
      return '{"cut":true,"bytes":0}';
    }
  }

  private count(): number {
    return this.from > 0 && this.lastN >= this.from ? this.lastN - this.from + 1 : 0;
  }

  /** drop the oldest segments while the record is over keepBytes; the newest is never dropped and
   *  nothing goes before its retention record is in the chain */
  private trim(): void {
    while (this.totalBytes > this.keepBytes && this.segs.length > 1) {
      const oldest = this.segs[0];
      const dropped = path.basename(this.segFile(oldest));
      const keptFrom = this.firstKeptFrom() ?? this.from;
      // retention records never start a new segment: a trim that rolled would keep finding one
      // more segment to delete and never end
      if (!this.writeOne(this.lastT, 'retention', null, { dropped, keptFrom }, true)) return;
      const size = this.sizeOf(oldest);
      try {
        fs.rmSync(this.segFile(oldest), { force: true });
      } catch {
        return;
      }
      this.segs.shift();
      this.totalBytes -= size;
      this.from = keptFrom;
    }
  }

  /** the head's verdict on the cheap state status() keeps: null when it agrees */
  private headProblem(head: Head | null): string | null {
    const headN = head ? head.n : 0;
    if (this.lastN === 0) return head !== null && head.n > 0 ? this.ahead(head.n, 0) : null;
    if (head !== null && head.n === this.lastN && head.h === this.lastH) return null;
    if (this.lastN === headN + 1) return null;   // the line got written and the head did not
    if (head !== null && head.n === this.lastN) return this.mismatch(head.h, this.lastN, this.lastH);
    if (head !== null && head.n > this.lastN) return this.ahead(head.n, this.lastN);
    return this.behind(this.lastN - headN);
  }

  private headMismatch(headN: number, headH: string, lastN: number, lastH: string): string {
    if (headN > lastN) return this.ahead(headN, lastN);
    if (headN < lastN) return this.behind(lastN - headN);
    return this.mismatch(headH, lastN, lastH);
  }

  private ahead(headN: number, lastN: number): string {
    return `the head file is ahead of the record: head n ${headN}, the record ends at ${lastN}`;
  }

  private behind(after: number): string {
    return `the head file is behind the record: ${after} records after it`;
  }

  private mismatch(headH: string, lastN: number, lastH: string | null): string {
    return `the head file does not match the last record: head h ${headH}, record n ${lastN} has h ${lastH}`;
  }

  private bad(from: number, count: number, head: string | null, problem: string): BoxVerify {
    return { ok: false, from, count, head, problem };
  }
}

/** read's bound: 200 unless the caller asks for more, never past 5000, never negative */
function limitOf(x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return LIMIT;
  return Math.min(LIMIT_MAX, Math.max(0, Math.floor(x)));
}

/** a query bound: the number when it is finite, else no bound */
function finite(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

export function openBox(opts: BoxOptions): Box {
  return new Recorder(opts);
}
