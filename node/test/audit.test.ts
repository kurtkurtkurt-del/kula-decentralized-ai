import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createPublicKey } from 'node:crypto';
import vectors from './audit-vectors.json' with { type: 'json' };
import { fromSeed, generate, loadOrCreate, loadOrCreateKey, publicKeyDer, signText, verifyText } from '../src/audit/key.ts';
import { Ledger, GENESIS, makeLine, sha256Hex, verifyChain, verifyLines, chainFiles, readLines, isLegacy } from '../src/audit/ledger.ts';
import { loadOrCreateIdentity } from '../src/tls.ts';
import { ReplayCheck, clockCheck, claimCheck, modelCheck, boundsCheck, healthWarnings } from '../src/audit/checks.ts';
import { Auditor } from '../src/audit/auditor.ts';
import { startGateServer, handshake, connectRemote, GateRefused } from '../src/gate.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-audit-'));
const seedKey = () => fromSeed(Buffer.from(vectors.key.seed, 'hex'));

// test/audit-vectors.json is a verbatim copy of app/modules/kula-llama/tools/audit-vectors.json:
// the phone's Ledger.kt (VectorsTest.kt) and this ledger must write the same bytes.
test('the fixed seed gives the vector key, id and both lines byte for byte', () => {
  const key = seedKey();
  assert.equal(publicKeyDer(key.publicKey).toString('hex'), vectors.key.public);
  assert.equal(key.id, vectors.key.id);
  let prev = GENESIS;
  for (const v of vectors.lines) {
    const { t, kind, peer, ...fields } = v.event as { t: number; kind: string; peer: string } & Record<string, string | number>;
    const made = makeLine(key, t, kind as any, peer, fields, prev);
    assert.equal(made.line, v.line);
    assert.equal(sha256Hex(made.line), v.sha256);
    prev = v.sha256;
  }
  const pub = createPublicKey({ key: Buffer.from(vectors.key.public, 'hex'), format: 'der', type: 'spki' });
  assert.equal(verifyLines(vectors.lines.map((v) => v.line), pub).ok, true);
  // a line with one byte changed inside the signed text, and one with the sig tail broken
  const bent = vectors.lines[0].line.replace('"peer":"10.0.0.7"', '"peer":"10.0.0.8"');
  assert.equal(verifyLines([bent], pub).problems.map((p) => p.reason).includes('sig'), true);
  assert.equal(verifyLines([vectors.lines[0].line.slice(0, -2)], pub).problems.length > 0, true);
});

test('a ledger on disk chains, verifies, and shows every kind of tampering', () => {
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  let t = 1000;
  const key = generate();
  const ledger = new Ledger(file, key, () => (t += 1));
  ledger.append('pair', 'phone', { name: 'p' });
  ledger.append('connect', '10.0.0.2', { channel: 'api' });
  ledger.append('end', '10.0.0.2', { channel: 'api', ms: 5, bytesIn: 1, bytesOut: 2 });
  // reopening continues the chain from the last line
  new Ledger(file, key, () => (t += 1)).append('health', 'self', { freeRamMB: 1 });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => JSON.parse(l).kind), ['pair', 'connect', 'end', 'health']);
  assert.equal(JSON.parse(lines[0]).prev, GENESIS);
  assert.equal(JSON.parse(lines[3]).prev, sha256Hex(lines[2]));
  assert.equal(verifyChain(file, key.publicKey).ok, true);

  const edited = [...lines]; edited[1] = edited[1].replace('"channel":"api"', '"channel":"rpc"');
  assert.deepEqual(verifyLines(edited, key.publicKey).problems, [{ n: 2, reason: 'sig' }, { n: 3, reason: 'prev' }]);
  const dropped = lines.filter((_, i) => i !== 1);
  assert.deepEqual(verifyLines(dropped, key.publicKey).problems, [{ n: 2, reason: 'prev' }]);
  const other = generate();
  assert.equal(verifyLines(lines, other.publicKey).problems.length, 4);
  assert.equal(verifyLines(lines, null).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rotation at the size limit links the chains across files', () => {
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const key = generate();
  let t = 5000;
  const ledger = new Ledger(file, key, () => (t += 1), 600);
  for (let i = 0; i < 12; i++) ledger.append('health', 'self', { i });
  const files = chainFiles(file);
  assert.ok(files.length >= 3, `expected rotated files, got ${files.length}`);
  assert.equal(files.at(-1), file);
  const r = verifyChain(file, key.publicKey);
  assert.equal(r.ok, true);
  assert.equal(r.count, 12);
  // the first line of a new file names the last line of the old one
  const old = fs.readFileSync(files[0], 'utf8').split('\n').filter(Boolean);
  const next = fs.readFileSync(files[1], 'utf8').split('\n').filter(Boolean);
  assert.equal(JSON.parse(next[0]).prev, sha256Hex(old.at(-1)!));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the device key is created once, kept as pkcs8 pem, and signs', () => {
  const dir = tmp();
  const file = path.join(dir, 'device_key.pem');
  const a = loadOrCreate(file);
  const b = loadOrCreate(file);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{32}$/);
  assert.match(fs.readFileSync(file, 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
  const sig = signText(a, 'hello');
  assert.equal(verifyText(b.publicKey, 'hello', sig), true);
  assert.equal(verifyText(b.publicKey, 'hellp', sig), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the checks and their thresholds', () => {
  const r = new ReplayCheck(3);
  assert.equal(r.check('a', 'n1'), null);
  assert.equal(r.check('a', 'n1'), 'replay');
  assert.equal(r.check('b', 'n1'), null);
  r.check('a', 'n2'); r.check('a', 'n3'); r.check('a', 'n4');
  assert.equal(r.check('a', 'n1'), null, 'n1 fell out of the ring of 3');

  assert.equal(clockCheck(1_000_000, 1_000_000 + 120_000), null);
  assert.equal(clockCheck(1_000_000, 1_000_000 + 120_001), 'clock');
  assert.equal(clockCheck(1_000_000 + 130_000, 1_000_000), 'clock');
  assert.equal(clockCheck(NaN, 1), 'clock');

  assert.equal(claimCheck(100, 100).level, 'ok');
  assert.equal(claimCheck(200, 100).level, 'ok');
  assert.equal(claimCheck(201, 100).level, 'warn');
  assert.equal(claimCheck(400, 100).level, 'warn');
  assert.equal(claimCheck(401, 100).level, 'reject');
  assert.equal(claimCheck(401, 100).reason, 'claim');
  assert.equal(claimCheck(5, 0).level, 'ok');

  assert.equal(modelCheck('AB', 'ab'), null);
  assert.equal(modelCheck('ab', 'ac'), 'model');

  assert.equal(boundsCheck(1e9, 1000), null);
  assert.equal(boundsCheck(3e9, 1000), 'bounds');
  assert.equal(boundsCheck(3e9, 500), null, 'short connections are not judged');
  assert.equal(boundsCheck(-1, 5000), 'bounds');

  assert.deepEqual(healthWarnings({ throttled: false, tempC: 42, batteryPct: 15 }), []);
  assert.deepEqual(healthWarnings({ throttled: true, tempC: 42.5, batteryPct: 14 }), ['throttled', 'hot 42.5 C', 'battery 14%']);
});

test('the auditor writes each kind and refuses replayed or skewed hellos', () => {
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const key = generate();
  const now = 1_700_000_000_000;
  const a = new Auditor({ ledger: new Ledger(file, key, () => now), now: () => now });
  assert.equal(a.hello('p', 'n1', null), null);
  assert.equal(a.hello('p', 'n1', null), 'replay');
  assert.equal(a.hello('p', 'n2', now - 120_000), null);
  assert.equal(a.hello('p', 'n3', now + 120_001), 'clock');
  a.connect('p', 'rpc');
  a.end('p', 'rpc', 2000, 10, 20);
  a.end('p', 'rpc', 2000, 10e9, 20);
  a.load('api', 'm.gguf', 'aa', 'aa');
  a.load('api', 'm.gguf', 'aa', 'bb');
  assert.equal(a.claim('self', 'ram', 9000, 2000).level, 'reject');
  a.health('self', { tempC: 50 });
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(entries.map((e) => e.kind), ['reject', 'reject', 'connect', 'end', 'end', 'load', 'load', 'claim', 'health']);
  assert.deepEqual(entries.map((e) => e.reason ?? '-'), ['replay', 'clock', '-', '-', 'bounds', '-', 'model', 'claim', '-']);
  assert.equal(entries[1].claimedMs, now + 120_001);
  assert.equal(entries[8].warn, 'hot 50 C');
  assert.equal(verifyChain(file, key.publicKey).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the gate takes a clock as the fourth hello field and lets the auditor refuse', async () => {
  const dir = tmp();
  const key = generate();
  const a = new Auditor({ ledger: new Ledger(path.join(dir, 'ledger.jsonl'), key) });
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', targets: () => null, admit: (p, n, ms) => a.hello(p, n, ms) });
  const tryOnce = async (clock?: number) => {
    const s = await connectRemote('127.0.0.1', gate.port);
    try { await handshake(s, 's', 'api', 2000, clock); return 'ok'; } catch (e) { return e instanceof GateRefused ? e.reason : (e as Error).message; } finally { s.destroy(); }
  };
  // targets() gives null, so a hello that passes the auditor fails later with "channel closed"
  assert.equal(await tryOnce(), 'channel closed');
  assert.equal(await tryOnce(Date.now()), 'channel closed');
  assert.equal(await tryOnce(Date.now() - 300_000), 'clock');
  // a replayed hello line, byte for byte
  const s1 = await connectRemote('127.0.0.1', gate.port);
  const hello = 'KULA1 api ' + 'ab'.repeat(16) + '\n';
  const first = await new Promise<string>((r) => { s1.once('data', (d) => r(d.toString())); s1.write(hello); });
  assert.match(first, /^[0-9a-f]{32}\n$/);
  s1.destroy();
  const s2 = await connectRemote('127.0.0.1', gate.port);
  const second = await new Promise<string>((r) => { s2.once('data', (d) => r(d.toString())); s2.write(hello); });
  assert.equal(second, 'NO replay\n');
  s2.destroy();
  // a fourth field that is not a number is a bad hello
  const s3 = await connectRemote('127.0.0.1', gate.port);
  const third = await new Promise<string>((r) => { s3.once('data', (d) => r(d.toString())); s3.write('KULA1 api ' + 'cd'.repeat(16) + ' soon\n'); });
  assert.equal(third, 'NO bad hello\n');
  s3.destroy();
  await gate.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kula-node ledger prints and verifies the ledger under KULA_NODE_HOME', async () => {
  const dir = tmp();
  process.env.KULA_NODE_HOME = dir;
  try {
    const { ledgerCommand } = await import('../src/ledgercmd.ts');
    const key = loadOrCreate(path.join(dir, 'device_key.pem'));
    const ledger = new Ledger(path.join(dir, 'ledger.jsonl'), key);
    for (let i = 0; i < 5; i++) ledger.append('health', 'self', { i });
    let out: string[] = [];
    assert.equal(ledgerCommand({ verify: false, tail: 2 }, (s) => out.push(s)), 0);
    assert.deepEqual(out.map((l) => JSON.parse(l).i), [3, 4]);
    out = [];
    assert.equal(ledgerCommand({ verify: true }, (s) => out.push(s)), 0);
    assert.match(out.at(-1)!, /^ledger ok: 5 lines/);
    fs.appendFileSync(path.join(dir, 'ledger.jsonl'), '{"t":1,"kind":"end","peer":"x","prev":"00","sig":"AA=="}\n');
    out = [];
    assert.equal(ledgerCommand({ verify: true }, (s) => out.push(s)), 1);
    assert.ok(out.some((l) => /line 6: bad prev/.test(l)) && out.some((l) => /line 6: bad sig/.test(l)));
  } finally {
    delete process.env.KULA_NODE_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn last line (the process died mid-append) is cut back, the cut is a signed health line, and the chain verifies', () => {
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const key = seedKey();
  let t = 1000;
  const a = new Ledger(file, key, () => (t += 1));
  a.append('connect', '10.0.0.7', { channel: 'rpc' });
  a.append('end', '10.0.0.7', { channel: 'rpc', ms: 5, bytesIn: 1, bytesOut: 2 });
  const whole = fs.readFileSync(file, 'utf8');
  const half = '{"t":1003,"kind":"connect","peer":"10.0.0.8","chan';
  fs.appendFileSync(file, half);
  const b = new Ledger(file, key, () => (t += 1));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(whole), 'the whole lines are kept as they were');
  const lines = readLines(file);
  assert.equal(lines.length, 3);
  const health = JSON.parse(lines[2]);
  assert.equal(health.kind, 'health');
  assert.equal(health.peer, 'self');
  assert.equal(health.torn, Buffer.byteLength(half));
  assert.equal(health.prev, sha256Hex(lines[1]));
  b.append('connect', '10.0.0.8', { channel: 'api' });
  const r = verifyChain(file, key.publicKey);
  assert.equal(r.ok, true, JSON.stringify(r.files));
  assert.equal(r.count, 4);
  // a file that is all torn: cut to nothing, the chain starts again from genesis
  const lone = path.join(dir, 'lone.jsonl');
  fs.writeFileSync(lone, '{"t":1,"kind":"con');
  new Ledger(lone, key, () => (t += 1));
  const one = readLines(lone);
  assert.equal(one.length, 1);
  assert.equal(JSON.parse(one[0]).torn, 18);
  assert.equal(JSON.parse(one[0]).prev, GENESIS);
  assert.equal(verifyChain(lone, key.publicKey).ok, true);
  // a whole file is left alone
  const before = fs.readFileSync(file);
  new Ledger(file, key, () => (t += 1));
  assert.deepEqual(fs.readFileSync(file), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a torn line after a rotation chains on from the rotated file', () => {
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const key = seedKey();
  let t = 1000;
  const a = new Ledger(file, key, () => (t += 1), 300);
  for (let i = 0; i < 4; i++) a.append('health', 'self', { n: i });
  assert.ok(chainFiles(file).length > 1);
  // the live file holds only half a line
  fs.writeFileSync(file, '{"t":2000,"kind":"hea');
  new Ledger(file, key, () => (t += 1), 300);
  const r = verifyChain(file, key.publicKey);
  assert.equal(r.ok, true, JSON.stringify(r.files));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a device key file that is cut short or not a key is moved aside, not silently replaced; key files are mode 600', () => {
  const dir = tmp();
  const file = path.join(dir, 'device_key.pem');
  const a = loadOrCreate(file);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const pem = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, pem.slice(0, 40));
  const said: string[] = [];
  const r = loadOrCreateKey(file, (s) => said.push(s));
  assert.ok(r.broken, 'told that it replaced the key');
  assert.match(path.basename(r.broken!), /^device_key\.pem\.broken\.\d+$/);
  assert.equal(fs.readFileSync(r.broken!, 'utf8'), pem.slice(0, 40), 'the broken file is kept as it was');
  assert.notEqual(r.key.id, a.id);
  assert.equal(said.length, 1);
  assert.ok(said[0].includes(r.broken!));
  assert.ok(!said[0].includes(pem.slice(30, 40)), 'the log carries no key bytes');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadOrCreate(file).id, r.key.id, 'the new key stays');
  // an empty file is broken too
  fs.writeFileSync(file, '');
  assert.ok(loadOrCreateKey(file, () => {}).broken);
  // a readable key with loose permissions is made 600
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o644);
    loadOrCreate(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp file left');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a broken gate key is moved aside the same way and gets a new certificate', () => {
  const dir = tmp();
  const ed = generate();
  if (ed.alg !== 'ed25519') return;
  const a = loadOrCreateIdentity(dir, ed, () => {});
  const keyFile = path.join(dir, 'gate_key.pem');
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  fs.writeFileSync(keyFile, 'nonsense');
  const said: string[] = [];
  const b = loadOrCreateIdentity(dir, ed, (s) => said.push(s));
  assert.notEqual(b.fp, a.fp);
  assert.equal(said.length, 1);
  assert.equal(fs.readdirSync(dir).filter((n) => /^gate_key\.pem\.broken\.\d+$/.test(n)).length, 1);
  assert.equal(loadOrCreateIdentity(dir, ed, () => {}).fp, b.fp);
  fs.rmSync(dir, { recursive: true, force: true });
});

// selcukv1 (11 Nov), T19: the Mac's ledger.jsonl began with 24 unsigned gate lines from before the
// signed ledger, so --verify said "broken" for good and the trust branch never let go.
test('a ledger that starts with the old unsigned gate lines is set aside whole, the new chain says so and verifies; a tampered signed ledger stays broken', async () => {
  const dir = tmp();
  process.env.KULA_NODE_HOME = dir;
  try {
    const { ledgerCommand } = await import('../src/ledgercmd.ts');
    const key = loadOrCreate(path.join(dir, 'device_key.pem'));
    const file = path.join(dir, 'ledger.jsonl');
    const old = [
      '{"type":"open","channel":"rpc","peer":"10.0.80.200","at":1793831037593}',
      '{"type":"close","channel":"rpc","peer":"10.0.80.200","at":1793831037594,"ms":1,"bytesIn":0,"bytesOut":0}',
      '{"type":"reject","channel":"api","peer":"10.0.80.200","at":1793831037648,"reason":"wrong secret"}',
    ].join('\n') + '\n';
    fs.writeFileSync(file, old);
    // a signed line chained on top of them, as the Mac's was
    fs.appendFileSync(file, makeLine(key, 1793870640561, 'claim', 'self', { what: 'ram', claimed: 1, measured: 1, level: 'ok' }, sha256Hex(old.trim().split('\n').at(-1)!)).line + '\n');
    assert.equal(isLegacy(file), true);
    let out: string[] = [];
    assert.equal(ledgerCommand({ verify: true }, (s) => out.push(s)), 0);
    assert.ok(out.some((l) => /set aside the old unsigned lines/.test(l)));
    assert.match(out.at(-1)!, /^ledger ok: 1 lines/);
    const aside = fs.readdirSync(dir).filter((n) => /^ledger\.unsigned-\d+\.jsonl$/.test(n));
    assert.equal(aside.length, 1);
    const kept = fs.readFileSync(path.join(dir, aside[0]), 'utf8');
    assert.ok(kept.startsWith(old), 'the old lines are kept, not deleted');
    const first = JSON.parse(readLines(file)[0]);
    assert.equal(first.kind, 'health');
    assert.equal(first.setAside, aside[0]);
    assert.equal(first.lines, 4);
    assert.equal(first.sha256, sha256Hex(kept));
    assert.equal(first.prev, GENESIS);
    // a second check finds nothing to do and the chain goes on
    out = [];
    assert.equal(ledgerCommand({ verify: true }, (s) => out.push(s)), 0);
    assert.ok(!out.some((l) => /set aside/.test(l)));
    new Ledger(file, key).append('health', 'self', { i: 1 });
    assert.equal(verifyChain(file, key.publicKey).ok, true);

    // a signed ledger whose first line was changed is not in the old shape: it stays broken
    const dir2 = tmp();
    const f2 = path.join(dir2, 'ledger.jsonl');
    const l2 = new Ledger(f2, key);
    l2.append('health', 'self', { i: 1 });
    l2.append('health', 'self', { i: 2 });
    const lines = readLines(f2);
    lines[0] = lines[0].replace('"i":1', '"i":9');
    fs.writeFileSync(f2, lines.join('\n') + '\n');
    assert.equal(isLegacy(f2), false);
    assert.equal(new Ledger(f2, key).setAside, null);
    assert.equal(verifyChain(f2, key.publicKey).ok, false);
    // an old-looking line that carries a signature or a prev is not the old shape either
    fs.writeFileSync(f2, '{"type":"open","peer":"x","prev":"00","sig":"AA=="}\n');
    assert.equal(isLegacy(f2), false);
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    delete process.env.KULA_NODE_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
