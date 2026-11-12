// The brain's look at this computer's own ledger (godseye-feed hostLedger) only reads: a ledger
// still starting with the old unsigned gate lines is reported, never set aside on a look. Setting
// it aside is `kula-node ledger --verify` (or the dashboard's verify button), asked for (review A2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreate } from '../src/audit/key.ts';
import { Ledger, makeLine, readLines, settleLegacy, sha256Hex } from '../src/audit/ledger.ts';
import { hostLedger } from '../src/ui/godseye-feed.ts';

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
