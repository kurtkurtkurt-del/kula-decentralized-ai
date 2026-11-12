// The brain's look at this computer's own ledger (godseye-feed hostLedger) only reads: a ledger
// still starting with the old unsigned gate lines is reported, never set aside on a look. Setting
// it aside is `kula-node ledger --verify` (or the dashboard's verify button), asked for (review A2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreate } from '../src/audit/key.ts';
import { Ledger, chainFiles, makeLine, readLines, settleLegacy, sha256Hex } from '../src/audit/ledger.ts';
import { hostLedger, hostLedgerVerifiedLines } from '../src/ui/godseye-feed.ts';

const old = [
  '{"type":"open","channel":"rpc","peer":"10.0.80.200","at":1793831037593}',
  '{"type":"close","channel":"rpc","peer":"10.0.80.200","at":1793831037594,"ms":1,"bytesIn":0,"bytesOut":0}',
  '{"type":"reject","channel":"api","peer":"10.0.80.200","at":1793831037648,"reason":"wrong secret"}',
].join('\n') + '\n';

test('hostLedger on a ledger still in the old unsigned shape: not ok, names ledger --verify, sets nothing aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-hostledger-'));
  const was = process.env.KULA_NODE_HOME;
  process.env.KULA_NODE_HOME = dir;
  try {
    const key = loadOrCreate(path.join(dir, 'device_key.pem'));
    const file = path.join(dir, 'ledger.jsonl');
    const s1 = makeLine(key, 1793870640561, 'claim', 'self', { what: 'ram', claimed: 1, measured: 1, level: 'ok' }, sha256Hex(old.trim().split('\n').at(-1)!)).line;
    fs.writeFileSync(file, old + s1 + '\n');
    const text = fs.readFileSync(file, 'utf8');
    const names = fs.readdirSync(dir).sort();

    const v = hostLedger(file);
    assert.ok(v);
    assert.equal(v.ok, false);
    assert.ok(v.problem && v.problem.length <= 200, `short problem text: ${v.problem}`);
    assert.match(v.problem!, /kula-node ledger --verify/);
    assert.deepEqual(fs.readdirSync(dir).sort(), names, 'nothing renamed, nothing new');
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'the file is untouched');
    // a second look (cached) says the same and still touches nothing
    assert.equal(hostLedger(file)!.ok, false);
    assert.deepEqual(fs.readdirSync(dir).sort(), names);

    // asked for: the old lines are set aside, and the brain's next look reads a healthy chain
    assert.equal(settleLegacy(file, key), true);
    const after = hostLedger(file)!;
    assert.equal(after.ok, true);
    assert.equal(after.count, 1);
    assert.equal(after.problem, null);
  } finally {
    if (was === undefined) delete process.env.KULA_NODE_HOME; else process.env.KULA_NODE_HOME = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hostLedger on a tampered ledger whose first line is rewritten into the old shape: broken, nothing set aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-hostledger-'));
  const was = process.env.KULA_NODE_HOME;
  process.env.KULA_NODE_HOME = dir;
  try {
    const key = loadOrCreate(path.join(dir, 'device_key.pem'));
    const file = path.join(dir, 'ledger.jsonl');
    const L = new Ledger(file, key);
    for (let i = 0; i < 10; i++) L.append(i % 3 ? 'connect' : 'reject', `peer${i}`, { reason: 'wrong pin' });
    assert.equal(hostLedger(file)!.ok, true);
    const lines = readLines(file).filter((l) => !l.includes('"kind":"reject"'));
    lines.unshift('{"type":"open","channel":"rpc","peer":"x"}');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const v = hostLedger(file)!;
    assert.equal(v.ok, false);
    assert.doesNotMatch(v.problem ?? '', /--verify/, 'it is reported as broken, not as the old shape');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => /^ledger\.unsigned-/.test(n)), []);
  } finally {
    if (was === undefined) delete process.env.KULA_NODE_HOME; else process.env.KULA_NODE_HOME = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The look runs inside the brain's tick; a ledger kept changing (a refused handshake is one line)
// must not be verified whole every time (scan A7, 12 Nov). Rotated files are kept by name, size,
// mtime and the hash they chain from; the live file's verified prefix by its sha256.
function withChain(run: (c: { dir: string; file: string; L: Ledger; count: () => number }) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-hostledger-'));
  const was = process.env.KULA_NODE_HOME;
  process.env.KULA_NODE_HOME = dir;
  try {
    const key = loadOrCreate(path.join(dir, 'device_key.pem'));
    const file = path.join(dir, 'ledger.jsonl');
    let t = 1793870640000;
    const L = new Ledger(file, key, () => (t += 1), 1200);
    let n = 0;
    // two rotated files and a live one holding a few lines
    while (chainFiles(file).length < 3) { L.append(n % 3 ? 'connect' : 'reject', `peer${n}`, { reason: 'wrong pin' }); n++; }
    for (let i = 0; i < 2; i++) { L.append('connect', `peer${n}`, {}); n++; }
    run({ dir, file, L, count: () => n });
  } finally {
    if (was === undefined) delete process.env.KULA_NODE_HOME; else process.env.KULA_NODE_HOME = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// rewrites one line of a file in place, same length, and moves its mtime (a stat alone tells)
function tamper(f: string, at: number) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const swapped = lines[at].replace(/"peer":"peer(\d)/, (_, d) => `"peer":"peer${(Number(d) + 1) % 10}`);
  assert.notEqual(swapped, lines[at]);
  assert.equal(swapped.length, lines[at].length);
  lines[at] = swapped;
  fs.writeFileSync(f, lines.join('\n'));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(f, later, later);
}

test('hostLedger after one append verifies exactly the one new line', () => {
  withChain(({ file, L, count }) => {
    assert.equal(chainFiles(file).length, 3);
    const first = hostLedger(file)!;
    assert.equal(first.ok, true);
    assert.equal(first.count, count());
    const c0 = hostLedgerVerifiedLines();
    L.append('reject', 'peer-new', { reason: 'wrong pin' });
    const second = hostLedger(file)!;
    assert.equal(second.ok, true);
    assert.equal(second.count, count() + 1);
    assert.equal(hostLedgerVerifiedLines() - c0, 1, 'only the appended line is verified');
    // nothing changed: nothing verified
    const c1 = hostLedgerVerifiedLines();
    assert.equal(hostLedger(file)!.count, count() + 1);
    assert.equal(hostLedgerVerifiedLines(), c1);
  });
});

test('hostLedger: a tampered rotated file still breaks the chain', () => {
  withChain(({ file, L }) => {
    assert.equal(hostLedger(file)!.ok, true);
    L.append('connect', 'peer-new', {});
    assert.equal(hostLedger(file)!.ok, true);
    const rotated = chainFiles(file)[0];
    tamper(rotated, 1);
    const v = hostLedger(file)!;
    assert.equal(v.ok, false);
    assert.match(v.problem ?? '', new RegExp(`line 2 of ${path.basename(rotated).replace(/\./g, '\\.')}: bad sig`));
    assert.doesNotMatch(v.problem ?? '', /--verify/);
  });
});

test('hostLedger: a tampered live prefix is verified in full and breaks the chain', () => {
  withChain(({ file, L }) => {
    assert.equal(hostLedger(file)!.ok, true);
    L.append('connect', 'peer-new', {});
    assert.equal(hostLedger(file)!.ok, true);
    tamper(file, 0);
    const c0 = hostLedgerVerifiedLines();
    // the writer goes on from the true last line (the size did not change, so it does not resync)
    L.append('connect', 'peer-after', {});
    const v = hostLedger(file)!;
    assert.equal(v.ok, false);
    assert.match(v.problem ?? '', /line 1 of ledger\.jsonl: bad sig/);
    assert.ok(hostLedgerVerifiedLines() - c0 > 1, 'the live file is verified again from its start');
  });
});

test('hostLedger: a rotation stays ok with the same count, verifying only the new lines', () => {
  withChain(({ file, L, count }) => {
    const before = hostLedger(file)!;
    assert.equal(before.ok, true);
    const c0 = hostLedgerVerifiedLines();
    let added = 0;
    while (chainFiles(file).length < 4) { L.append('connect', `peer${added}`, {}); added++; }
    const v = hostLedger(file)!;
    assert.equal(v.ok, true, v.problem ?? '');
    assert.equal(v.count, count() + added);
    assert.equal(hostLedgerVerifiedLines() - c0, added, 'the renamed live file is not verified again');
  });
});
