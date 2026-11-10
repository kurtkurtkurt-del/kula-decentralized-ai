// god's eye, the black box: an append-only, hash-chained record on disk. Every number and every
// hash here is worked out in the test with node:crypto, never read back out of box.ts, so a byte
// the writer gets wrong shows up as a failed assertion.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-box-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { openBox } = await import('../src/godseye/box.ts');

let made = 0;
const fresh = (name: string): string => path.join(ROOT, `${name}-${++made}`);
const seg = (dir: string, i: number): string => path.join(dir, `box-${String(i).padStart(6, '0')}.jsonl`);
const headFile = (dir: string): string => path.join(dir, 'head.json');
const sha = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ZERO = '0'.repeat(64);

/** one record line as the task defines it: keys in order, h over the exact bytes before the tail */
function rec(n: number, t: number, k: string, b: string | null, xJson: string, p: string) {
  const base = `{"n":${n},"t":${t},"k":${JSON.stringify(k)},"b":${b === null ? 'null' : JSON.stringify(b)},"x":${xJson},"p":"${p}"`;
  const h = sha(base);
  return { base, h, line: `${base},"h":"${h}"}` };
}

const tamperX = (problem: string, headN: number, headH: string, lastN: number, lastH: string): string =>
  JSON.stringify({ problem, headN, headH, lastN, lastH });

/** the lines of a segment, without the newline that ends the last one */
function linesOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function writeLines(file: string, lines: string[]): void {
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function headOf(dir: string): unknown {
  return JSON.parse(fs.readFileSync(headFile(dir), 'utf8'));
}

/** n records, t = i * 1000, payload { v: i }, chained by hand */
function lookChain(n: number) {
  const out: ReturnType<typeof rec>[] = [];
  let p = ZERO;
  for (let i = 1; i <= n; i++) {
    const r = rec(i, i * 1000, 'look', null, `{"v":${i}}`, p);
    out.push(r);
    p = r.h;
  }
  return out;
}

test('an empty box verifies, and the dir it makes is private', () => {
  const dir = fresh('empty');
  const b = openBox({ dir });
  assert.deepEqual(b.verify(), { ok: true, from: 0, count: 0, head: null, problem: null });
  assert.deepEqual(b.status(), { count: 0, from: 0, head: null, bytes: 0, segments: 0, ok: true, problem: null });
  assert.deepEqual(b.read(), []);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('three records: the exact bytes of every line, a hand-computed h, and n linked to p', () => {
  const dir = fresh('three');
  const b = openBox({ dir });
  assert.equal(b.append(1000, 'look', null, { a: 1 }), true);
  assert.equal(b.append(2000, 'feed', 'senses', ['x', 2]), true);
  assert.equal(b.append(3000, 'verdict', 'trust', 'ok'), true);
  const r1 = rec(1, 1000, 'look', null, '{"a":1}', ZERO);
  const r2 = rec(2, 2000, 'feed', 'senses', '["x",2]', r1.h);
  const r3 = rec(3, 3000, 'verdict', 'trust', '"ok"', r2.h);
  const file = seg(dir, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), `${r1.line}\n${r2.line}\n${r3.line}\n`);
  assert.deepEqual(b.verify(), { ok: true, from: 1, count: 3, head: r3.h, problem: null });
  assert.deepEqual(b.status(), { count: 3, from: 1, head: r3.h, bytes: fs.statSync(file).size, segments: 1, ok: true, problem: null });
  assert.deepEqual(headOf(dir), { n: 3, h: r3.h });
  const rs = b.read();
  assert.deepEqual(rs.map((r) => r.n), [1, 2, 3]);
  assert.deepEqual(rs.map((r) => r.p), [ZERO, r1.h, r2.h]);
  assert.deepEqual(rs.map((r) => r.h), [r1.h, r2.h, r3.h]);
  assert.deepEqual(rs[1].x, ['x', 2]);
  assert.equal(rs[2].b, 'trust');
});

test('a changed byte in the middle record breaks the chain and verify names n 2', () => {
  const dir = fresh('changed');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  b.append(3000, 'look', null, { v: 3 });
  const file = seg(dir, 1);
  const lines = linesOf(file);
  lines[1] = lines[1].replace('"v":2', '"v":3');
  writeLines(file, lines);
  const v = b.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, 'record n 2: h does not match its line');
  assert.equal(v.count, 1);
});

test('a removed middle line breaks the sequence and verify names n 3', () => {
  const dir = fresh('removed');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  b.append(3000, 'look', null, { v: 3 });
  const file = seg(dir, 1);
  const lines = linesOf(file);
  lines.splice(1, 1);
  writeLines(file, lines);
  const v = b.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, 'record n 3: expected n 2');
});

test('two swapped lines break at the second of them', () => {
  const dir = fresh('swapped');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  b.append(3000, 'look', null, { v: 3 });
  const file = seg(dir, 1);
  const lines = linesOf(file);
  [lines[1], lines[2]] = [lines[2], lines[1]];
  writeLines(file, lines);
  const v = b.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, 'record n 3: expected n 2');
});

test('an inserted line breaks the sequence, even when its own hash and p are right', () => {
  const dir = fresh('inserted');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  b.append(3000, 'look', null, { v: 3 });
  const file = seg(dir, 1);
  const lines = linesOf(file);
  const h2 = JSON.parse(lines[1]).h as string;
  // a forged record with n 2 again, a valid h over its own bytes, and p linked to the real n 2
  const forged = rec(2, 2500, 'forged', null, '{}', h2);
  lines.splice(2, 0, forged.line);
  writeLines(file, lines);
  const v = b.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, 'record n 2: expected n 3');
});

test('a record whose p does not link to the one before is caught at its n', () => {
  const dir = fresh('bad-p');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  b.append(3000, 'look', null, { v: 3 });
  const file = seg(dir, 1);
  const lines = linesOf(file);
  lines[1] = rec(2, 2000, 'look', null, '{"v":2}', ZERO).line;   // valid h, wrong p
  writeLines(file, lines);
  const v = b.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, 'record n 2: p does not link to the record before it');
});

test('the front of segment 1 is checked: losing n 1 is named, and its p must be zeros', () => {
  const dir = fresh('front-one');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const file = seg(dir, 1);
  const lines = linesOf(file);
  writeLines(file, [lines[1]]);
  assert.equal(b.verify().problem, 'the record starts at n 2, not 1');

  const dir2 = fresh('front-p');
  const b2 = openBox({ dir: dir2 });
  b2.append(1000, 'look', null, { v: 1 });
  b2.append(2000, 'look', null, { v: 2 });
  const file2 = seg(dir2, 1);
  const lines2 = linesOf(file2);
  const h2 = JSON.parse(lines2[1]).h as string;
  lines2[0] = rec(1, 1000, 'look', null, '{"v":1}', h2).line;   // valid h, p is not the start
  writeLines(file2, lines2);
  assert.equal(b2.verify().problem, 'record n 1: p is not the start of the chain');
});

test('an extra key after h is rejected: the tail must be exactly the hash', () => {
  const dir = fresh('tail-extra');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  const file = seg(dir, 1);
  const line = linesOf(file)[0];
  writeLines(file, [`${line.slice(0, -1)},"j":1}`]);
  const v = b.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, 'record n 1: its tail is not a hash');
});

test('verify says what is wrong with a line: empty, not json, not a record, no n, bad h, bad p', () => {
  const dir = fresh('bad-lines');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const file = seg(dir, 1);
  const good = linesOf(file);
  const check = (lines: string[], problem: string): void => {
    writeLines(file, lines);
    const v = b.verify();
    assert.equal(v.ok, false);
    assert.equal(v.problem, problem);
  };
  check([good[0], '', good[1]], 'box-000001.jsonl line 2 is empty');
  check([good[0], 'not json', good[1]], 'box-000001.jsonl line 2 is not json');
  check([good[0], '5', good[1]], 'box-000001.jsonl line 2 is not a record');
  check([good[0], '{"n":1.5}', good[1]], 'box-000001.jsonl line 2 has no sequence number');
  check([good[0], '{"n":2}', good[1]], 'record n 2: h is not a hash');
  const base = '{"n":2,"t":2000,"k":"look","b":null,"x":{},"p":null';
  const h = sha(base);
  check([good[0], `${base},"h":"${h}"}`], 'record n 2: p is not a hash');
  writeLines(file, good);
  assert.equal(b.verify().ok, true);
});

test('an end cut stays a problem through appends and a restart, and is a record in the chain', () => {
  const dir = fresh('cut-end');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  b.append(3000, 'look', null, { v: 3 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const r3 = rec(3, 3000, 'look', null, '{"v":3}', r2.h);
  const file = seg(dir, 1);
  const lines = linesOf(file);
  lines.pop();
  writeLines(file, lines);

  const problem = 'the head file is ahead of the record: head n 3, the record ends at 2';
  const re = openBox({ dir });   // at open the mismatch is written into the chain
  const rt = rec(3, 2000, 'tamper', null, tamperX(problem, 3, r3.h, 2, r2.h), r2.h);
  assert.deepEqual(linesOf(file), [r1.line, r2.line, rt.line]);
  assert.deepEqual(headOf(dir), { n: 3, h: rt.h, problem });
  assert.deepEqual(re.verify(), { ok: false, from: 1, count: 3, head: rt.h, problem });
  assert.equal(re.status().problem, problem);
  assert.equal(re.status().ok, false);

  // three more appends keep the evidence
  const r4 = rec(4, 4000, 'look', null, '{"v":4}', rt.h);
  const r5 = rec(5, 5000, 'look', null, '{"v":5}', r4.h);
  const r6 = rec(6, 6000, 'look', null, '{"v":6}', r5.h);
  for (const [i, t] of [[4, 4000], [5, 5000], [6, 6000]] as [number, number][]) {
    assert.equal(re.append(t, 'look', null, { v: i }), true);
  }
  const re2 = openBox({ dir });   // a restart reads the problem out of head.json
  assert.deepEqual(re2.verify(), { ok: false, from: 1, count: 6, head: r6.h, problem });
  assert.equal(re2.status().problem, problem);
  const tamper = re2.read().find((r) => r.k === 'tamper');
  assert.deepEqual(tamper?.x, { problem, headN: 3, headH: r3.h, lastN: 2, lastH: r2.h });

  // the person accepts: a record names the problem, then the head is rewritten without it
  re2.accept();
  const ra = rec(7, 6000, 'accept', null, JSON.stringify({ problem }), r6.h);
  assert.deepEqual(linesOf(file), [r1.line, r2.line, rt.line, r4.line, r5.line, r6.line, ra.line]);
  assert.deepEqual(headOf(dir), { n: 7, h: ra.h });
  assert.deepEqual(re2.verify(), { ok: true, from: 1, count: 7, head: ra.h, problem: null });
  assert.equal(re2.status().ok, true);
});

test('a forged last record stays a problem through an append, on a restart and live', () => {
  const dir = fresh('forged-last');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const file = seg(dir, 1);
  const forged = rec(2, 2000, 'look', null, '{"v":9}', r1.h);
  writeLines(file, [r1.line, forged.line]);   // the chain is internally valid; only the head disagrees
  const problem = `the head file does not match the last record: head h ${r2.h}, record n 2 has h ${forged.h}`;

  const re = openBox({ dir });
  const rt = rec(3, 2000, 'tamper', null, tamperX(problem, 2, r2.h, 2, forged.h), forged.h);
  assert.deepEqual(linesOf(file), [r1.line, forged.line, rt.line]);
  assert.deepEqual(re.verify(), { ok: false, from: 1, count: 3, head: rt.h, problem });
  re.append(3000, 'after', null, { v: 4 });
  const re2 = openBox({ dir });
  assert.equal(re2.verify().ok, false);
  assert.equal(re2.verify().problem, problem);

  // the same, caught before an append on a running box: the tail no longer matches what it wrote
  const dir2 = fresh('forged-live');
  const b2 = openBox({ dir: dir2 });
  b2.append(1000, 'look', null, { v: 1 });
  b2.append(2000, 'look', null, { v: 2 });
  const f1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const f2 = rec(2, 2000, 'look', null, '{"v":2}', f1.h);
  const ff = rec(2, 2000, 'look', null, '{"v":9}', f1.h);
  writeLines(seg(dir2, 1), [f1.line, ff.line]);
  assert.equal(b2.append(3000, 'after', null, { v: 4 }), true);
  assert.deepEqual(b2.read().map((r) => [r.n, r.k]), [[1, 'look'], [2, 'look'], [3, 'tamper'], [4, 'after']]);
  const v = b2.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, `the head file does not match the last record: head h ${f2.h}, record n 2 has h ${ff.h}`);
});

test('three forged records added at the end stay a problem through an append and a restart', () => {
  const dir = fresh('forged-end');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const f3 = rec(3, 3000, 'fake', null, '{"v":3}', r2.h);
  const f4 = rec(4, 4000, 'fake', null, '{"v":4}', f3.h);
  const f5 = rec(5, 5000, 'fake', null, '{"v":5}', f4.h);
  writeLines(seg(dir, 1), [r1.line, r2.line, f3.line, f4.line, f5.line]);

  const problem = 'the head file is behind the record: 3 records after it';
  const re = openBox({ dir });
  const rt = rec(6, 5000, 'tamper', null, tamperX(problem, 2, r2.h, 5, f5.h), f5.h);
  assert.deepEqual(linesOf(seg(dir, 1)), [r1.line, r2.line, f3.line, f4.line, f5.line, rt.line]);
  assert.deepEqual(re.verify(), { ok: false, from: 1, count: 6, head: rt.h, problem });
  const r7 = rec(7, 6000, 'after', null, '{"v":7}', rt.h);
  assert.equal(re.append(6000, 'after', null, { v: 7 }), true);
  const re2 = openBox({ dir });
  assert.deepEqual(re2.verify(), { ok: false, from: 1, count: 7, head: r7.h, problem });
});

test('a crash between the line and the head is the one shape healed silently', () => {
  const dir = fresh('crash');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const r3 = rec(3, 3000, 'look', null, '{"v":3}', r2.h);
  fs.appendFileSync(seg(dir, 1), `${r3.line}\n`);   // the line was written; the head was not
  const re = openBox({ dir });
  assert.deepEqual(linesOf(seg(dir, 1)), [r1.line, r2.line, r3.line]);   // no tamper record
  assert.deepEqual(headOf(dir), { n: 3, h: r3.h });
  assert.deepEqual(re.verify(), { ok: true, from: 1, count: 3, head: r3.h, problem: null });
  assert.deepEqual(re.status(), { count: 3, from: 1, head: r3.h, bytes: fs.statSync(seg(dir, 1)).size, segments: 1, ok: true, problem: null });

  // the same for the very first record: the line exists, the head was never written
  const dir2 = fresh('crash-first');
  const b2 = openBox({ dir: dir2 });
  b2.append(1000, 'look', null, { v: 1 });
  const q1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  fs.rmSync(headFile(dir2));
  const re2 = openBox({ dir: dir2 });
  assert.deepEqual(linesOf(seg(dir2, 1)), [q1.line]);
  assert.deepEqual(headOf(dir2), { n: 1, h: q1.h });
  assert.equal(re2.verify().ok, true);
});

test('a missing head with more than one record is a loss, not a crash, and stays one', () => {
  const dir = fresh('no-head');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  fs.rmSync(headFile(dir));
  const problem = 'the head file is behind the record: 2 records after it';
  const re = openBox({ dir });
  const rt = rec(3, 2000, 'tamper', null, tamperX(problem, 0, ZERO, 2, r2.h), r2.h);
  assert.deepEqual(linesOf(seg(dir, 1)), [r1.line, r2.line, rt.line]);
  assert.deepEqual(headOf(dir), { n: 3, h: rt.h, problem });
  assert.deepEqual(re.verify(), { ok: false, from: 1, count: 3, head: rt.h, problem });
  re.append(3000, 'after', null, { v: 4 });
  assert.equal(re.verify().ok, false);
  assert.equal(re.verify().problem, problem);
});

test('a head with a wrong h is tamper evidence that survives an append', () => {
  const dir = fresh('bad-head');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const wrong = 'a'.repeat(64);
  fs.writeFileSync(headFile(dir), JSON.stringify({ n: 2, h: wrong }));
  const problem = `the head file does not match the last record: head h ${wrong}, record n 2 has h ${r2.h}`;
  const re = openBox({ dir });
  const rt = rec(3, 2000, 'tamper', null, tamperX(problem, 2, wrong, 2, r2.h), r2.h);
  assert.deepEqual(linesOf(seg(dir, 1)), [r1.line, r2.line, rt.line]);
  assert.deepEqual(re.verify(), { ok: false, from: 1, count: 3, head: rt.h, problem });
  assert.equal(re.status().problem, problem);
  re.append(3000, 'after', null, { v: 4 });
  assert.equal(re.verify().problem, problem);
});

test('a head file that cannot be written is a head problem, never a false tamper record', () => {
  const dir = fresh('ro-dir');
  const b = openBox({ dir });
  const c = lookChain(6);
  assert.equal(b.append(1000, 'look', null, { v: 1 }), true);
  fs.chmodSync(dir, 0o500);   // the head temp cannot be made; the existing segment is still writable
  try {
    for (let i = 2; i <= 5; i++) assert.equal(b.append(i * 1000, 'look', null, { v: i }), true);
    assert.deepEqual(b.read().map((r) => r.k), ['look', 'look', 'look', 'look', 'look']);
    const s = b.status();
    assert.equal(s.ok, false);
    assert.match(s.problem ?? '', /^the head file could not be written: /);
    const v = b.verify();
    assert.equal(v.ok, false);
    assert.equal(v.problem, 'the head file is behind the record: 4 records after it');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  // writable again: the next append heals the head; even when the record write then fails, the
  // healed head is left behind (and is no tamper evidence)
  const realAppend = fs.appendFileSync.bind(fs);
  (fs as unknown as { appendFileSync: typeof fs.appendFileSync }).appendFileSync = () => {
    throw new Error('disk full');
  };
  try {
    assert.equal(b.append(6000, 'look', null, { v: 6 }), false);
  } finally {
    (fs as unknown as { appendFileSync: typeof fs.appendFileSync }).appendFileSync = realAppend;
  }
  assert.deepEqual(headOf(dir), { n: 5, h: c[4].h });
  // the next append, now that the segment can be written, brings the chain up to date
  assert.equal(b.append(6000, 'look', null, { v: 6 }), true);
  assert.deepEqual(b.verify(), { ok: true, from: 1, count: 6, head: c[5].h, problem: null });
  assert.deepEqual(b.status(), { count: 6, from: 1, head: c[5].h, bytes: fs.statSync(seg(dir, 1)).size, segments: 1, ok: true, problem: null });
  assert.deepEqual(headOf(dir), { n: 6, h: c[5].h });
});

test('an unaccepted tamper is a standing problem whatever head.json says', () => {
  const dir = fresh('tamper-standing');
  const b = openBox({ dir });
  for (let i = 1; i <= 3; i++) b.append(i * 1000, 'look', null, { v: i });
  const c = lookChain(3);
  const file = seg(dir, 1);
  const lines = linesOf(file);
  lines.pop();
  writeLines(file, lines);
  const problem = 'the head file is ahead of the record: head n 3, the record ends at 2';
  const re = openBox({ dir });
  const rt = re.read().at(-1)!;
  const tamper = rec(3, 2000, 'tamper', null, tamperX(problem, 3, c[2].h, 2, c[1].h), c[1].h);
  assert.deepEqual([rt.n, rt.k, rt.h], [3, 'tamper', tamper.h]);
  // only the problem field goes: the chain still says a tamper was never accepted
  fs.writeFileSync(headFile(dir), JSON.stringify({ n: rt.n, h: rt.h }));
  const v = re.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, problem);
  assert.equal(re.status().ok, false);
  assert.equal(re.status().problem, problem);
  // a restart reads the chain, not the head
  const re2 = openBox({ dir });
  assert.equal(re2.verify().problem, problem);
  assert.equal(re2.status().problem, problem);
  re2.accept();
  const accepted = rec(4, 2000, 'accept', null, JSON.stringify({ problem }), tamper.h);
  assert.deepEqual(linesOf(file), [c[0].line, c[1].line, tamper.line, accepted.line]);
  assert.deepEqual(re2.verify(), { ok: true, from: 1, count: 4, head: accepted.h, problem: null });
  assert.deepEqual(headOf(dir), { n: 4, h: accepted.h });
  const after = openBox({ dir });   // and the accept stands after a restart, for status too
  assert.equal(after.verify().ok, true);
  assert.equal(after.status().ok, true);
  assert.equal(after.status().problem, null);
});

test('a tamper whose head write failed is not healed away by a restart', () => {
  const dir = fresh('tamper-headfailed');
  const b = openBox({ dir });
  for (let i = 1; i <= 3; i++) b.append(i * 1000, 'look', null, { v: i });
  const c = lookChain(3);
  const file = seg(dir, 1);
  const lines = linesOf(file);
  lines.pop();
  writeLines(file, lines);
  const problem = 'the head file is ahead of the record: head n 3, the record ends at 2';
  const first = openBox({ dir });
  const tamper = rec(3, 2000, 'tamper', null, tamperX(problem, 3, c[2].h, 2, c[1].h), c[1].h);
  assert.equal(first.read().at(-1)!.h, tamper.h);
  // the tamper record landed but its head write did not: the head stays at n 2, with no problem
  fs.writeFileSync(headFile(dir), JSON.stringify({ n: 2, h: c[1].h }));
  const re = openBox({ dir });
  const v = re.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, problem);
  assert.equal(re.status().ok, false);
  assert.equal(re.status().problem, problem);
  // the crash-shaped head is healed to the tamper record, and the problem goes back into it
  assert.deepEqual(headOf(dir), { n: 3, h: tamper.h, problem });
  assert.equal(re.read().filter((r) => r.k === 'tamper').length, 1);   // no second tamper record
  re.accept();
  assert.equal(re.verify().ok, true);
  const after = openBox({ dir });
  assert.equal(after.verify().ok, true);
  assert.equal(after.status().ok, true);
  assert.equal(after.status().problem, null);
});

test('a live one-record gap is the crash shape for verify and status too', () => {
  const dir = fresh('live-crash');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  fs.rmSync(headFile(dir));   // one record and no head: the crash shape, not a loss
  assert.deepEqual(b.verify(), { ok: true, from: 1, count: 1, head: r1.h, problem: null });
  const s = b.status();
  assert.equal(s.ok, true);
  assert.equal(s.problem, null);

  // two records and no head is a loss, and the cheap status says so too
  const dir2 = fresh('live-gap');
  const b2 = openBox({ dir: dir2 });
  b2.append(1000, 'look', null, { v: 1 });
  b2.append(2000, 'look', null, { v: 2 });
  fs.rmSync(headFile(dir2));
  const s2 = b2.status();
  assert.equal(s2.ok, false);
  assert.equal(s2.problem, 'the head file is behind the record: 2 records after it');
});

test('accept on a healthy box writes nothing', () => {
  const dir = fresh('accept-none');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  const before = fs.readFileSync(seg(dir, 1), 'utf8');
  b.accept();
  assert.equal(fs.readFileSync(seg(dir, 1), 'utf8'), before);
  assert.equal(b.verify().ok, true);
});

test('a head that is not json or has no usable n/h is treated as missing', () => {
  for (const body of ['not json', '5', JSON.stringify({ n: 1.5, h: 'a'.repeat(64) }), JSON.stringify({ n: 2 })]) {
    const dir = fresh('head-shape');
    const b = openBox({ dir });
    b.append(1000, 'look', null, { v: 1 });
    b.append(2000, 'look', null, { v: 2 });
    fs.writeFileSync(headFile(dir), body);
    const re = openBox({ dir });
    const v = re.verify();
    assert.equal(v.ok, false);
    assert.equal(v.problem, 'the head file is behind the record: 2 records after it');
  }
});

test('a torn last line is cut off and recorded as a repair', () => {
  const dir = fresh('torn');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const file = seg(dir, 1);
  const partial = '{"n":3,"t":';
  fs.appendFileSync(file, partial);
  const cut = Buffer.byteLength(partial);
  const re = openBox({ dir });
  const rr = rec(3, 2000, 'repair', null, `{"cut":${cut}}`, r2.h);
  assert.equal(fs.readFileSync(file, 'utf8'), `${r1.line}\n${r2.line}\n${rr.line}\n`);
  assert.deepEqual(re.verify(), { ok: true, from: 1, count: 3, head: rr.h, problem: null });
  assert.equal(re.status().count, 3);

  // the other tear: a whole line that ends with a newline but is not json
  const dir2 = fresh('torn-json');
  const b2 = openBox({ dir: dir2 });
  b2.append(1000, 'look', null, { v: 1 });
  const file2 = seg(dir2, 1);
  fs.appendFileSync(file2, 'not json\n');
  const cut2 = Buffer.byteLength('not json\n');
  const re2 = openBox({ dir: dir2 });
  const rr2 = rec(2, 1000, 'repair', null, `{"cut":${cut2}}`, r1.h);
  assert.equal(fs.readFileSync(file2, 'utf8'), `${r1.line}\n${rr2.line}\n`);
  assert.deepEqual(re2.verify(), { ok: true, from: 1, count: 2, head: rr2.h, problem: null });
});

test('reopening continues n and the chain from the last record on disk', () => {
  const dir = fresh('reopen');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const re = openBox({ dir });
  assert.equal(re.status().count, 2);
  assert.equal(re.append(3000, 'look', null, { v: 3 }), true);
  const r3 = rec(3, 3000, 'look', null, '{"v":3}', r2.h);
  assert.equal(fs.readFileSync(seg(dir, 1), 'utf8'), `${r1.line}\n${r2.line}\n${r3.line}\n`);
  assert.deepEqual(re.verify(), { ok: true, from: 1, count: 3, head: r3.h, problem: null });
});

test('a new segment starts when the current would pass segmentBytes, and the chain crosses files', () => {
  const dir = fresh('roll');
  const b = openBox({ dir, segmentBytes: 300 });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  b.append(3000, 'look', null, { v: 3 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const r3 = rec(3, 3000, 'look', null, '{"v":3}', r2.h);
  assert.equal(fs.existsSync(seg(dir, 4)), false);
  assert.deepEqual(linesOf(seg(dir, 1)), [r1.line]);
  assert.deepEqual(linesOf(seg(dir, 2)), [r2.line]);
  assert.deepEqual(linesOf(seg(dir, 3)), [r3.line]);
  assert.deepEqual(b.verify(), { ok: true, from: 1, count: 3, head: r3.h, problem: null });
  assert.deepEqual(b.read().map((r) => r.n), [1, 2, 3]);
});

test('an empty segment before the records does not hide the kept count', () => {
  const dir = fresh('empty-first');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  fs.renameSync(seg(dir, 1), seg(dir, 5));
  fs.writeFileSync(seg(dir, 1), '');
  const re = openBox({ dir });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  assert.equal(re.status().from, 1);
  assert.equal(re.status().count, 2);
  assert.deepEqual(re.verify(), { ok: true, from: 1, count: 2, head: r2.h, problem: null });
  assert.equal(re.append(3000, 'look', null, { v: 3 }), true);   // written after the records, into segment 5
  const r3 = rec(3, 3000, 'look', null, '{"v":3}', r2.h);
  assert.deepEqual(linesOf(seg(dir, 5)), [r1.line, r2.line, r3.line]);
});

test('an empty segment is written into, not rolled past', () => {
  const dir = fresh('empty-seg');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(seg(dir, 5), '');
  const b = openBox({ dir, segmentBytes: 50 });   // one record is bigger than the segment
  assert.equal(b.append(1000, 'look', null, {}), true);
  const r1 = rec(1, 1000, 'look', null, '{}', ZERO);
  assert.deepEqual(linesOf(seg(dir, 5)), [r1.line]);
  assert.equal(fs.existsSync(seg(dir, 6)), false);
});

/** six appends at a small segment and a keep that forces several deletions; the hand-built chain
 *  includes every retention record the rules demand */
function retainedBox(dir: string) {
  const b = openBox({ dir, segmentBytes: 300, keepBytes: 700 });
  for (let i = 1; i <= 6; i++) assert.equal(b.append(i * 1000, 'look', null, { v: i }), true);
  return b;
}

function retainedChain() {
  const out: ReturnType<typeof rec>[] = [];
  let p = ZERO;
  const add = (n: number, t: number, k: string, x: string): void => {
    const r = rec(n, t, k, null, x, p);
    out.push(r);
    p = r.h;
  };
  add(1, 1000, 'look', '{"v":1}');
  add(2, 2000, 'look', '{"v":2}');
  add(3, 3000, 'look', '{"v":3}');
  add(4, 4000, 'look', '{"v":4}');
  add(5, 4000, 'retention', JSON.stringify({ dropped: 'box-000001.jsonl', keptFrom: 2 }));
  add(6, 4000, 'retention', JSON.stringify({ dropped: 'box-000002.jsonl', keptFrom: 3 }));
  add(7, 4000, 'retention', JSON.stringify({ dropped: 'box-000003.jsonl', keptFrom: 4 }));
  add(8, 5000, 'look', '{"v":5}');
  add(9, 5000, 'retention', JSON.stringify({ dropped: 'box-000004.jsonl', keptFrom: 8 }));
  add(10, 6000, 'look', '{"v":6}');
  return out;
}

test('retention records what it drops before dropping it; verify anchors at the kept record', () => {
  const dir = fresh('keep');
  const b = retainedBox(dir);
  const c = retainedChain();
  for (const i of [1, 2, 3, 4]) assert.equal(fs.existsSync(seg(dir, i)), false, `segment ${i}`);
  assert.equal(fs.readFileSync(seg(dir, 5), 'utf8'), `${c[7].line}\n${c[8].line}\n`);
  assert.equal(fs.readFileSync(seg(dir, 6), 'utf8'), `${c[9].line}\n`);
  assert.deepEqual(b.verify(), { ok: true, from: 8, count: 3, head: c[9].h, problem: null });
  assert.deepEqual(b.read().map((r) => [r.n, r.t, r.k, r.x]), [
    [8, 5000, 'look', { v: 5 }],
    [9, 5000, 'retention', { dropped: 'box-000004.jsonl', keptFrom: 8 }],
    [10, 6000, 'look', { v: 6 }],
  ]);

  // a restart continues from the kept record; one more append records another drop
  const re = openBox({ dir, segmentBytes: 300, keepBytes: 700 });
  assert.deepEqual(re.verify(), { ok: true, from: 8, count: 3, head: c[9].h, problem: null });
  assert.equal(re.append(7000, 'look', null, { v: 7 }), true);
  const c11 = rec(11, 7000, 'look', null, '{"v":7}', c[9].h);
  const c12 = rec(12, 7000, 'retention', null, JSON.stringify({ dropped: 'box-000005.jsonl', keptFrom: 10 }), c11.h);
  assert.deepEqual(re.verify(), { ok: true, from: 10, count: 3, head: c12.h, problem: null });
  assert.equal(fs.readFileSync(seg(dir, 7), 'utf8'), `${c11.line}\n${c12.line}\n`);
  assert.equal(fs.existsSync(seg(dir, 5)), false);
});

test('cutting the front of the kept record is caught against the retention record', () => {
  const dir = fresh('keep-cut');
  const b = retainedBox(dir);
  const lines = linesOf(seg(dir, 5));   // [n 8 look, n 9 retention]
  writeLines(seg(dir, 5), [lines[1]]);
  const v = b.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, 'the record starts at n 9, but the retention record says it kept from 8');
});

test('a missing front without a retention record is a problem, not an anchor', () => {
  const dir = fresh('front-gone');
  const b = openBox({ dir, segmentBytes: 300 });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  b.append(3000, 'look', null, { v: 3 });
  fs.rmSync(seg(dir, 1));
  const v = b.verify();
  assert.equal(v.ok, false);
  assert.equal(v.problem, 'the record starts at n 2, but segment 1 is gone and no retention record says why');
});

test('retention never deletes the newest segment, even when it alone is past keepBytes', () => {
  const dir = fresh('keep-newest');
  const b = openBox({ dir, segmentBytes: 300, keepBytes: 100 });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const r3 = rec(3, 2000, 'retention', null, JSON.stringify({ dropped: 'box-000001.jsonl', keptFrom: 2 }), r2.h);
  assert.equal(fs.existsSync(seg(dir, 1)), false);
  assert.equal(fs.readFileSync(seg(dir, 2), 'utf8'), `${r2.line}\n${r3.line}\n`);
  assert.deepEqual(b.verify(), { ok: true, from: 2, count: 2, head: r3.h, problem: null });
  assert.deepEqual(b.read().map((r) => r.n), [2, 3]);
});

test('nothing is dropped when its retention record cannot be written', () => {
  const dir = fresh('keep-first');
  const b = openBox({ dir, segmentBytes: 300, keepBytes: 100 });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  assert.equal(fs.existsSync(seg(dir, 2)), true);
  const realAppend = fs.appendFileSync.bind(fs);
  (fs as unknown as { appendFileSync: typeof fs.appendFileSync }).appendFileSync = (file, data, opts) => {
    if (typeof data === 'string' && data.includes('"k":"retention"')) throw new Error('disk full');
    return realAppend(file, data, opts);
  };
  try {
    assert.equal(b.append(3000, 'look', null, { v: 3 }), true);   // the user record is in; the drop is not
    assert.equal(fs.existsSync(seg(dir, 2)), true);
  } finally {
    (fs as unknown as { appendFileSync: typeof fs.appendFileSync }).appendFileSync = realAppend;
  }
});

test('a payload over payloadMax, a cycle, a BigInt and undefined are replaced, not thrown', () => {
  const dir = fresh('payload');
  const b = openBox({ dir, payloadMax: 30 });
  b.append(1000, 'big', null, { a: 'x'.repeat(100) });
  const full = JSON.stringify({ a: 'x'.repeat(100) });
  assert.deepEqual(b.read()[0].x, { cut: true, bytes: full.length });

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(b.append(1000, 'cycle', null, cycle), true);
  assert.deepEqual(b.read()[1].x, { cut: true, bytes: 0 });

  assert.equal(b.append(1000, 'bigint', null, { v: 10n }), true);
  assert.deepEqual(b.read()[2].x, { cut: true, bytes: 0 });

  assert.equal(b.append(1000, 'undefined', null, undefined), true);
  assert.deepEqual(b.read()[3].x, { cut: true, bytes: 0 });

  assert.equal(b.append(1000, 'nan', null, { a: NaN, b: Infinity, c: -Infinity }), true);
  assert.deepEqual(b.read()[4].x, { a: null, b: null, c: null });

  const evil = { get x(): never { throw null; } };
  assert.equal(b.append(1000, 'evil', null, evil), true);
  assert.deepEqual(b.read()[5].x, { cut: true, bytes: 0 });
  assert.equal(b.verify().ok, true);
});

test('a last record longer than the tail window is read from its start', () => {
  const dir = fresh('long-tail');
  const b = openBox({ dir, payloadMax: 200_000 });
  const big = 'x'.repeat(100_000);
  assert.equal(b.append(1000, 'big', null, { s: big }), true);
  assert.equal(b.append(2000, 'after', null, { v: 2 }), true);   // the tail read must grow past 64 KiB
  assert.equal(b.verify().ok, true);
  assert.deepEqual(b.read().map((r) => r.n), [1, 2]);
});

test('a time that is not usable is replaced by the last good one and the payload says why', () => {
  const dir = fresh('bad-time');
  const b = openBox({ dir });
  b.append(NaN, 'look', null, { v: 1 });
  b.append(-5, 'look', null, { v: 2 });
  b.append(1000, 'look', null, { v: 3 });
  b.append(1e300, 'look', null, { v: 4 });
  const rs = b.read();
  assert.deepEqual(rs.map((r) => r.t), [0, 0, 1000, 1000]);
  assert.deepEqual(rs.map((r) => r.x), [
    { badTime: true, x: { v: 1 } },
    { badTime: true, x: { v: 2 } },
    { v: 3 },
    { badTime: true, x: { v: 4 } },
  ]);
  const r1 = rec(1, 0, 'look', null, '{"badTime":true,"x":{"v":1}}', ZERO);
  assert.deepEqual(linesOf(seg(dir, 1))[0], r1.line);
  assert.equal(b.verify().ok, true);
});

test('a bad time after a restart takes the last record\'s time', () => {
  const dir = fresh('bad-time-restart');
  const b = openBox({ dir });
  b.append(4000, 'look', null, { v: 1 });
  const re = openBox({ dir });
  assert.equal(re.append(NaN, 'look', null, { v: 2 }), true);
  assert.deepEqual(re.read().map((r) => [r.n, r.t, r.x]), [
    [1, 4000, { v: 1 }],
    [2, 4000, { badTime: true, x: { v: 2 } }],
  ]);
});

test('times going backwards change nothing in the order, which is n alone', () => {
  const dir = fresh('backwards');
  const b = openBox({ dir });
  b.append(5000, 'look', null, { v: 1 });
  b.append(1000, 'look', null, { v: 2 });
  b.append(100, 'look', null, { v: 3 });
  assert.deepEqual(b.read().map((r) => [r.n, r.t]), [[1, 5000], [2, 1000], [3, 100]]);
  assert.equal(fs.existsSync(seg(dir, 2)), false);
  assert.equal(b.verify().ok, true);
});

test('kind is checked against [a-z-]{1,20}; branch is capped at 40 chars or null', () => {
  const dir = fresh('kind');
  const b = openBox({ dir });
  const long = 'b'.repeat(50);
  const adds: [string, string | null][] = [
    ['a-b', null], ['Look', null], ['a'.repeat(30), null], ['a'.repeat(20), null],
    ['with space', null], ['', null], ['look', 'eye'], ['look', 42 as unknown as string], ['look', { x: 1 } as unknown as string],
    ['look', long],
  ];
  for (const [k, br] of adds) assert.equal(b.append(1000, k, br, {}), true);
  // the exact bytes, so a kind or branch that slipped through to the line shows here even when
  // read() would coerce it back to a word or null
  const lines = linesOf(seg(dir, 1));
  let prev = ZERO;
  adds.forEach(([k, br], i) => {
    const kind = /^[a-z-]{1,20}$/.test(k) ? k : 'other';
    const branch = typeof br === 'string' ? br.slice(0, 40) : null;
    const r = rec(i + 1, 1000, kind, branch, '{}', prev);
    assert.equal(lines[i], r.line);
    prev = r.h;
  });
  assert.deepEqual(b.read().map((r) => [r.k, r.b]), [
    ['a-b', null], ['other', null], ['other', null], ['a'.repeat(20), null], ['other', null], ['other', null],
    ['look', 'eye'], ['look', null], ['look', null], ['look', long.slice(0, 40)],
  ]);
  assert.equal(b.verify().ok, true);
});

test('a box with no usable dir refuses appends and writes nothing into the cwd', () => {
  const canary = path.join(process.cwd(), 'box-000001.jsonl');
  assert.equal(fs.existsSync(canary), false);
  for (const opts of [{ dir: '' }, { dir: undefined }, { dir: 42 }, { dir: null }, null]) {
    const b = openBox(opts as never);
    assert.equal(b.append(1000, 'look', null, {}), false);
    const s = b.status();
    assert.equal(s.ok, false);
    assert.equal(typeof s.problem, 'string');
    assert.ok(s.problem && s.problem.length > 0);
    assert.doesNotThrow(() => { b.verify(); b.read(); b.accept(); });
  }
  assert.equal(fs.existsSync(canary), false);
});

test('a dir that cannot be written: append says false and nothing throws', () => {
  const p = fresh('not-a-dir');
  fs.writeFileSync(p, 'a file, not a dir');
  const b = openBox({ dir: p });
  assert.doesNotThrow(() => b.append(1000, 'look', null, {}));
  assert.equal(b.append(1000, 'look', null, {}), false);
  const s = b.status();
  assert.equal(s.ok, false);
  assert.equal(typeof s.problem, 'string');
  assert.ok(s.problem && s.problem.length > 0);
  assert.doesNotThrow(() => { b.verify(); b.read(); b.accept(); b.status(); });
});

test('an unreadable tail at open refuses appends instead of restarting n', () => {
  const dir = fresh('unreadable');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(seg(dir, 1));   // a directory where a segment should be
  const b = openBox({ dir });
  assert.equal(b.append(1000, 'look', null, {}), false);
  assert.equal(fs.existsSync(seg(dir, 2)), false);
  const s = b.status();
  assert.equal(s.ok, false);
  assert.ok(s.problem && /could not open|not a record/.test(s.problem));
  assert.doesNotThrow(() => { b.verify(); b.read(); b.accept(); });

  // a complete line that is not a record is no tail to continue from either
  const dir2 = fresh('unreadable-line');
  const b2 = openBox({ dir: dir2 });
  b2.append(1000, 'look', null, { v: 1 });
  fs.appendFileSync(seg(dir2, 1), '5\n');
  const re = openBox({ dir: dir2 });
  assert.equal(re.append(2000, 'look', null, {}), false);
  assert.equal(re.status().ok, false);

  // garbage written at the end while the box is open: no record is glued onto it, and the box
  // stays stopped even if the garbage is cut by hand (a restart reads the record again)
  const dir3 = fresh('tail-garbage');
  const b3 = openBox({ dir: dir3 });
  b3.append(1000, 'look', null, { v: 1 });
  const good = fs.readFileSync(seg(dir3, 1), 'utf8');
  fs.appendFileSync(seg(dir3, 1), 'not json\n');
  assert.equal(b3.append(2000, 'look', null, {}), false);
  assert.equal(b3.status().ok, false);
  fs.truncateSync(seg(dir3, 1), Buffer.byteLength(good));
  assert.equal(b3.append(3000, 'look', null, {}), false);
  assert.equal(fs.readFileSync(seg(dir3, 1), 'utf8'), good);

  // a json tail with no usable n or h is no place to continue from either
  for (const bad of ['{"n":2,"h":"x"}', `{"n":1.5,"h":"${'a'.repeat(64)}"}`]) {
    const d = fresh('bad-tail');
    const x = openBox({ dir: d });
    x.append(1000, 'look', null, { v: 1 });
    fs.appendFileSync(seg(d, 1), `${bad}\n`);
    const r = openBox({ dir: d });
    assert.equal(r.append(2000, 'look', null, {}), false);
    assert.equal(r.status().ok, false);
  }
});

test('a whole segment turned into one torn line stops appends', () => {
  const dir = fresh('whole-garbage');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  fs.writeFileSync(seg(dir, 1), 'garbage');   // one line and no newline anywhere
  assert.equal(b.append(2000, 'look', null, {}), false);
  assert.equal(b.status().ok, false);
  assert.doesNotThrow(() => { b.verify(); b.read(); });
});

test('a partial write is cut back to the record before it, and the next append continues the chain', () => {
  const dir = fresh('partial');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  const r1 = rec(1, 1000, 'look', null, '{"v":1}', ZERO);
  const r2 = rec(2, 2000, 'look', null, '{"v":2}', r1.h);
  const file = seg(dir, 1);
  const realAppend = fs.appendFileSync.bind(fs);
  (fs as unknown as { appendFileSync: typeof fs.appendFileSync }).appendFileSync = (f, data, opts) => {
    realAppend(f, String(data).slice(0, Math.floor(String(data).length / 2)), opts);
    throw new Error('disk full');
  };
  try {
    assert.equal(b.append(3000, 'look', null, { v: 3 }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), `${r1.line}\n${r2.line}\n`);   // torn bytes cut
    assert.match(b.status().problem ?? '', /could not write/);
  } finally {
    (fs as unknown as { appendFileSync: typeof fs.appendFileSync }).appendFileSync = realAppend;
  }
  assert.equal(b.append(4000, 'look', null, { v: 4 }), true);   // n 3 again, not n 4
  const r3 = rec(3, 4000, 'look', null, '{"v":4}', r2.h);
  assert.deepEqual(linesOf(file), [r1.line, r2.line, r3.line]);
  assert.deepEqual(b.verify(), { ok: true, from: 1, count: 3, head: r3.h, problem: null });
  assert.equal(b.status().problem, null);
});

test('a partial write that cannot be cut back refuses every later append', () => {
  const dir = fresh('partial-block');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  const file = seg(dir, 1);
  const before = fs.readFileSync(file, 'utf8');
  const realAppend = fs.appendFileSync.bind(fs);
  const realTrunc = fs.truncateSync.bind(fs);
  (fs as unknown as { appendFileSync: typeof fs.appendFileSync }).appendFileSync = (f, data, opts) => {
    realAppend(f, String(data).slice(0, 10), opts);
    throw new Error('disk full');
  };
  (fs as unknown as { truncateSync: typeof fs.truncateSync }).truncateSync = () => {
    throw new Error('read-only');
  };
  try {
    assert.equal(b.append(2000, 'look', null, { v: 2 }), false);
    const torn = fs.statSync(file).size;
    assert.ok(torn > Buffer.byteLength(before));
    assert.equal(b.append(3000, 'look', null, { v: 3 }), false);   // refused, not glued on
    assert.equal(fs.statSync(file).size, torn);
    const s = b.status();
    assert.equal(s.ok, false);
    assert.match(s.problem ?? '', /torn write/);
  } finally {
    (fs as unknown as { appendFileSync: typeof fs.appendFileSync }).appendFileSync = realAppend;
    (fs as unknown as { truncateSync: typeof fs.truncateSync }).truncateSync = realTrunc;
  }
  // even when the torn bytes are cut by hand, the box stays stopped until it is opened again
  fs.truncateSync(file, Buffer.byteLength(before));
  assert.equal(b.append(4000, 'look', null, { v: 4 }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.match(b.status().problem ?? '', /torn write/);
  assert.doesNotThrow(() => { b.verify(); b.read(); b.accept(); });
});

test('nonsense option values fall back to the defaults', () => {
  const a = openBox({ dir: fresh('opt-payload'), payloadMax: -5 });
  a.append(1000, 'look', null, { s: 'x'.repeat(50) });
  assert.deepEqual(a.read()[0].x, { s: 'x'.repeat(50) });

  const dirB = fresh('opt-segment');
  const b = openBox({ dir: dirB, segmentBytes: -1 });
  b.append(1000, 'a', null, {});
  b.append(2000, 'b', null, {});
  assert.equal(fs.existsSync(seg(dirB, 2)), false);

  const dirC = fresh('opt-keep');
  const c = openBox({ dir: dirC, segmentBytes: 300, keepBytes: -1 });
  c.append(1000, 'a', null, {});
  c.append(2000, 'b', null, {});
  assert.equal(fs.existsSync(seg(dirC, 1)), true);
  assert.equal(c.verify().from, 1);
});

test('5000 appends finish in a few seconds and the whole chain verifies', () => {
  const dir = fresh('many');
  const b = openBox({ dir });
  const t0 = Date.now();
  for (let i = 1; i <= 5000; i++) assert.equal(b.append(1000 + i, 'look', null, { i }), true);
  const ms = Date.now() - t0;
  assert.ok(ms < 10_000, `5000 appends took ${ms} ms`);
  const v = b.verify();
  assert.equal(v.ok, true);
  assert.equal(v.from, 1);
  assert.equal(v.count, 5000);
  assert.equal(v.head, b.status().head);
  assert.equal(b.status().count, 5000);
  assert.equal(b.read({ limit: 3 }).length, 3);
});

test('read filters by n, t, kind and branch, oldest first', () => {
  const dir = fresh('read');
  const b = openBox({ dir });
  b.append(1000, 'look', 'a', { i: 1 });
  b.append(2000, 'feed', 'b', { i: 2 });
  b.append(3000, 'look', 'b', { i: 3 });
  b.append(4000, 'verdict', 'a', { i: 4 });
  b.append(5000, 'look', 'a', { i: 5 });
  const ns = (q: Record<string, unknown>): number[] => b.read(q).map((r) => r.n);
  assert.deepEqual(ns({ fromN: 2, toN: 4 }), [2, 3, 4]);
  assert.deepEqual(ns({ fromT: 2000, toT: 4000 }), [2, 3, 4]);
  assert.deepEqual(ns({ kind: 'look' }), [1, 3, 5]);
  assert.deepEqual(ns({ branch: 'a' }), [1, 4, 5]);
  assert.deepEqual(ns({ branch: 'b' }), [2, 3]);
  assert.deepEqual(ns({ kind: 'look', branch: 'a' }), [1, 5]);
  assert.deepEqual(ns({ limit: 2 }), [1, 2]);
  assert.deepEqual(ns({ fromT: 10_000 }), []);
  assert.deepEqual(ns({ limit: 0 }), []);
  assert.deepEqual(ns({ fromN: '3' as unknown as number }), [1, 2, 3, 4, 5]);   // not a bound
  assert.deepEqual(ns({ kind: 7 as unknown as string }), [1, 2, 3, 4, 5]);      // not a word: no filter
  assert.deepEqual(ns({ branch: 7 as unknown as string }), [1, 2, 3, 4, 5]);
});

test('read keeps at most 200 records unless asked for more, and the ask is capped at 5000', () => {
  const dir = fresh('limit');
  const b = openBox({ dir });
  for (let i = 0; i < 5001; i++) b.append(1000 + i, 'look', null, null);
  assert.equal(b.read().length, 200);
  assert.equal(b.read({ limit: 5000 }).length, 5000);
  assert.equal(b.read({ limit: 100_000 }).length, 5000);
  assert.deepEqual(b.read({ limit: -1 }), []);
  assert.doesNotThrow(() => b.read({ fromN: NaN, toT: Infinity, kind: 7 as unknown as string }));
});

test('read skips what it cannot use and keeps reading', () => {
  const dir = fresh('read-broken');
  const b = openBox({ dir });
  b.append(1000, 'look', null, { v: 1 });
  b.append(2000, 'look', null, { v: 2 });
  b.append(3000, 'look', null, { v: 3 });
  const file = seg(dir, 1);
  const good = linesOf(file);
  const ns = (): number[] => b.read().map((r) => r.n);
  writeLines(file, [good[0], 'not json', good[2]]);
  assert.deepEqual(ns(), [1, 3]);        // a broken line is skipped, later records are not lost
  writeLines(file, [good[0], 'null', good[2]]);
  assert.deepEqual(ns(), [1, 3]);        // a line that is not an object is skipped
  writeLines(file, [good[0], '{"n":1.5,"t":0,"k":"x","b":null,"x":{}}', good[2]]);
  assert.deepEqual(ns(), [1, 3]);        // no sequence number: not a record to read
  // a line with wrong-typed fields is read with its stand-ins, never thrown on
  writeLines(file, [good[0], '{"n":2,"t":"x","k":7,"b":9,"x":{}}', good[2]]);
  const mid = b.read()[1];
  assert.deepEqual([mid.n, mid.t, mid.k, mid.b, mid.p, mid.h], [2, 0, 'other', null, '', '']);
  writeLines(file, good);
  assert.equal(b.read(null as never).length, 3);   // a null query is no query
});

test('the dir is made 700 and every file 600', () => {
  const dir = fresh('modes');
  const b = openBox({ dir });
  b.append(1000, 'look', null, {});
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(seg(dir, 1)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(headFile(dir)).mode & 0o777, 0o600);
});

test('a file named box-abc.jsonl, box-000000.jsonl and an empty segment do no harm', () => {
  const dir = fresh('stray');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'box-abc.jsonl'), 'not a segment\n');
  fs.writeFileSync(seg(dir, 0), 'garbage\n');
  fs.writeFileSync(seg(dir, 5), '');
  const b = openBox({ dir });
  assert.deepEqual(b.verify(), { ok: true, from: 0, count: 0, head: null, problem: null });
  assert.equal(b.append(1000, 'look', null, { a: 1 }), true);
  assert.equal(fs.readFileSync(path.join(dir, 'box-abc.jsonl'), 'utf8'), 'not a segment\n');
  assert.equal(fs.readFileSync(seg(dir, 0), 'utf8'), 'garbage\n');
  const r1 = rec(1, 1000, 'look', null, '{"a":1}', ZERO);
  assert.deepEqual(linesOf(seg(dir, 5)), [r1.line]);
  assert.deepEqual(b.verify(), { ok: true, from: 1, count: 1, head: r1.h, problem: null });
});
