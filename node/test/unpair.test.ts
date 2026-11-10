import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGateServer, handshake, probe, type GateEvent } from '../src/gate.ts';
import { createIdentity, Paired } from '../src/tls.ts';
import { generate as generateDeviceKey } from '../src/audit/key.ts';
import { Ledger, verifyChain, readLines } from '../src/audit/ledger.ts';
import { Seen, pairedDevices, removePaired, removedSince, pairedCommand, unpairFields } from '../src/unpair.ts';
import { DashboardState } from '../src/dashboard/state.ts';
import { startDashboard } from '../src/dashboard/server.ts';

// "remove a device's access" (docs/GATE.md): a device paired once is trusted until its line
// leaves ~/.kula-node/paired. `kula-node paired remove` runs in its own process while `share`
// keeps its own Paired over the same file: the gate must refuse the device at its next
// handshake, its open pipes must close, and the ledger gets one signed line. The phone's
// twin is UnpairTest.kt.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-unpair-'));
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

test('paired: remove keeps the other lines with their times and names; a second object sees it at once', () => {
  const file = path.join(tmp(), 'paired');
  const share = new Paired(file);
  share.add(A, 'mac studio');
  share.add(B);
  share.add(C, 'pc');
  const at = share.list()[0].at;
  const cli = new Paired(file);
  assert.equal(cli.remove(B), true);
  assert.equal(cli.remove(B), false);
  // the share process's object, never told: it reads the file again by itself
  assert.equal(share.has(B), false);
  assert.equal(share.size, 2);
  const again = new Paired(file).list();
  assert.deepEqual(again.map((e) => [e.fp, e.name]), [[A, 'mac studio'], [C, 'pc']]);
  assert.equal(again[0].at, at);
  // and the other way: share pairs a new device, the cli sees it
  share.add(B, 'back');
  assert.deepEqual(cli.find('BB').map((e) => e.name), ['back']);
  // old files (fingerprint and time only) still read
  fs.writeFileSync(file, `${A} 1700000000000\n${C}\n`);
  assert.deepEqual(new Paired(file).list(), [{ fp: A, at: 1700000000000, name: null }, { fp: C, at: null, name: null }]);
});

test('the gate refuses a removed certificate at once and drop() closes its open pipe', async () => {
  const echo = await echoServer();
  const worker = createIdentity('worker');
  const phone = createIdentity('phone');
  const other = createIdentity('other');
  const pairedFile = path.join(tmp(), 'paired');
  const paired = new Paired(pairedFile);
  paired.add(phone.fp);
  paired.add(other.fp);
  const events: GateEvent[] = [];
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echo.port, onEvent: (e) => events.push(e), tls: { identity: worker, paired, pin: null } });
  const as = (id = phone) => ({ identity: id, fp: worker.fp });
  try {
    assert.equal((await probe('127.0.0.1', gate.port, '', 'api', 2000, as())).ok, true);
    // an open pipe from the phone
    const raw = net.connect(gate.port, '127.0.0.1');
    await new Promise((r) => raw.once('connect', r));
    const h = await handshake(raw, '', 'rpc', 2000, undefined, as());
    const echoed = new Promise<string>((r) => h.socket.once('data', (d: Buffer) => r(d.toString())));
    h.socket.write('hi');
    assert.equal(await echoed, 'hi');
    const closed = new Promise<void>((r) => h.socket.once('close', () => r()));
    // another process removes it
    const key = generateDeviceKey();
    const ledgerFile = path.join(tmp(), 'ledger.jsonl');
    const r = removePaired(phone.fp.slice(0, 12), new Paired(pairedFile), null, new Ledger(ledgerFile, key));
    assert.equal(r.ok, true);
    // new connections are refused at once
    assert.deepEqual(await probe('127.0.0.1', gate.port, '', 'api', 2000, as()), { ok: false, reason: 'not paired' });
    assert.equal((await probe('127.0.0.1', gate.port, '', 'api', 2000, as(other))).ok, true);
    // share's watcher notices (removedSince, below), the gate cuts the pipe
    assert.equal(gate.drop(phone.fp), 1);
    await closed;
    assert.equal(gate.drop(phone.fp), 0);
    // the ledger line
    const lines = readLines(ledgerFile).map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'health');
    assert.equal(lines[0].unpaired, phone.fp.slice(0, 16));
    assert.equal(verifyChain(ledgerFile, key.publicKey).ok, true);
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(events.some((e) => e.type === 'reject' && e.reason === 'not paired' && e.fp === phone.fp));
  } finally {
    await gate.close();
    echo.close();
  }
});

test('removedSince reports what left the list, once', () => {
  const file = path.join(tmp(), 'paired');
  const p = new Paired(file);
  p.add(A); p.add(B);
  const gone = removedSince(p);
  assert.deepEqual(gone(), []);
  new Paired(file).remove(A);
  assert.deepEqual(gone(), [A]);
  assert.deepEqual(gone(), []);
});

test('removePaired: a prefix names one device; nothing is written otherwise', () => {
  const d = tmp();
  const p = new Paired(path.join(d, 'paired'));
  p.add('abcdef' + '1'.repeat(58));
  p.add('abcdef' + '2'.repeat(58));
  const key = generateDeviceKey();
  const ledger = new Ledger(path.join(d, 'ledger.jsonl'), key);
  assert.deepEqual(removePaired('abc', p, null, ledger), { ok: false, why: 'short', matches: [] });
  const amb = removePaired('abcdef', p, null, ledger);
  assert.equal(amb.ok, false);
  assert.equal(!amb.ok && amb.why, 'ambiguous');
  assert.equal(!removePaired('ffffff', p, null, ledger).ok, true);
  assert.equal(readLines(ledger.file).length, 0);
  const ok = removePaired('abcdef2', p, null, ledger);
  assert.equal(ok.ok, true);
  assert.equal(p.size, 1);
  assert.equal(readLines(ledger.file).length, 1);
});

test('the list: names from the paired file, address and last seen from seen.json, else the ledger pair line', () => {
  const d = tmp();
  const now = Date.now();
  const p = new Paired(path.join(d, 'paired'));
  p.add(A, 'phone'); p.add(B); p.add(C);
  const seen = new Seen(path.join(d, 'seen.json'));
  seen.saw(B, '192.168.1.30', now + 5);
  const key = generateDeviceKey();
  const ledgerFile = path.join(d, 'ledger.jsonl');
  new Ledger(ledgerFile, key).append('pair', '192.168.1.40', { fp: C, channel: 'rpc' });
  const list = pairedDevices(p, seen, ledgerFile);
  assert.equal(list[0].fp, B);
  assert.equal(list[0].address, '192.168.1.30');
  assert.equal(list[0].lastSeen, now + 5);
  const byFp = new Map(list.map((x) => [x.fp, x]));
  assert.equal(byFp.get(A)!.name, 'phone');
  assert.equal(byFp.get(C)!.address, '192.168.1.40');
  assert.equal(byFp.get(C)!.lastSeen, null);
  // seen.json writes at most once a minute unless the address changed
  assert.equal(seen.saw(B, '192.168.1.30', now + 10), false);
  assert.equal(seen.saw(B, '192.168.1.31', now + 11), true);
  seen.forget(B);
  assert.equal(new Seen(path.join(d, 'seen.json')).get(B), null);
});

test('two ledger objects on one file keep one chain (share keeps one open, the cli writes the removal)', () => {
  const file = path.join(tmp(), 'ledger.jsonl');
  const key = generateDeviceKey();
  const share = new Ledger(file, key);
  share.append('connect', '10.0.0.1', { channel: 'rpc' });
  new Ledger(file, key).append('health', 'self', unpairFields(A, 'mac'));
  share.append('end', '10.0.0.1', { channel: 'rpc', ms: 10, bytesIn: 1, bytesOut: 2 });
  assert.equal(readLines(file).length, 3);
  assert.equal(verifyChain(file, key.publicKey).ok, true);
});

test('kula-node paired list / remove', () => {
  const d = tmp();
  const old = process.env.KULA_NODE_HOME;
  process.env.KULA_NODE_HOME = d;
  try {
    const out: string[] = [];
    const err: string[] = [];
    const run = (...argv: string[]) => pairedCommand(argv[0], argv.slice(1), argv.includes('--json') ? { json: true } : {}, (s) => out.push(s), (s) => err.push(s));
    assert.equal(run('list'), 0);
    assert.match(out.pop()!, /nothing paired/);
    const p = new Paired(path.join(d, 'paired'));
    p.add(A, 'phone');
    p.add(B);
    out.length = 0;
    assert.equal(run('list'), 0);
    assert.match(out.join('\n'), /2 devices can use this computer/);
    assert.match(out.join('\n'), new RegExp(A.slice(0, 16) + ' +phone'));
    out.length = 0;
    assert.equal(run('list', '--json'), 0);
    assert.equal(JSON.parse(out[0]).length, 2);
    assert.equal(run('remove'), 2);
    assert.equal(run('remove', 'zz'), 1);
    assert.equal(run('remove', 'cccccc'), 1);
    assert.match(err.join('\n'), /no paired device starts with cccccc/);
    out.length = 0;
    assert.equal(run('remove', 'aaaaaaaa'), 0);
    assert.match(out[0], /removed aaaaaaaaaaaaaaaa \(phone\)/);
    assert.deepEqual(new Paired(path.join(d, 'paired')).list().map((e) => e.fp), [B]);
    const lines = readLines(path.join(d, 'ledger.jsonl')).map((l) => JSON.parse(l));
    assert.deepEqual([lines.at(-1).kind, lines.at(-1).unpaired, lines.at(-1).name], ['health', A.slice(0, 16), 'phone']);
    assert.equal(run('frobnicate'), 2);
  } finally {
    if (old === undefined) delete process.env.KULA_NODE_HOME; else process.env.KULA_NODE_HOME = old;
  }
});

test('the chat page: a device that also uses this computer shows it; removing its access leaves forget alone', async () => {
  const d = tmp();
  const old = process.env.KULA_NODE_HOME;
  process.env.KULA_NODE_HOME = d; // the device key the ledger line is signed with
  const { Engine } = await import('../src/ui/engine.ts');
  const { writePeers, readPeers } = await import('../src/peers.ts');
  try {
    const peersFile = path.join(d, 'peers.json');
    const pairedFile = path.join(d, 'paired');
    const at = new Date().toISOString();
    writePeers([
      { id: 'phone', name: 'pixel', host: '192.168.1.20', port: 50551, secret: '', fp: A, pin: null, relay: null, kind: 'phone', ram: null, bw: null, added_at: at },
      { id: 'tab', name: 'tab', host: '192.168.1.21', port: 50551, secret: '', fp: B, pin: null, relay: null, kind: 'phone', ram: null, bw: null, added_at: at },
    ], peersFile);
    new Paired(pairedFile).add(A, 'pixel');
    const e = new Engine({ peersFile, pairedFile, identity: createIdentity('mac'), llama: null });
    const rows = new Map(e.peers().map((r) => [r.id, r]));
    assert.equal(rows.get('phone')!.usesThisComputer, true);
    assert.equal(rows.get('tab')!.usesThisComputer, false);
    assert.equal(e.unpairPeer('tab'), false);
    assert.equal(e.unpairPeer('phone'), true);
    assert.equal(new Paired(pairedFile).has(A), false);
    // this computer can still use the phone: the peer book is as it was
    assert.deepEqual(readPeers(peersFile).map((p) => p.id), ['phone', 'tab']);
    assert.equal(e.peers().find((r) => r.id === 'phone')!.usesThisComputer, false);
    const line = JSON.parse(readLines(path.join(d, 'ledger.jsonl')).at(-1)!);
    assert.deepEqual([line.kind, line.unpaired, line.name], ['health', A.slice(0, 16), 'pixel']);
    assert.equal(e.unpairPeer('phone'), false);
    await e.close?.();
  } finally {
    if (old === undefined) delete process.env.KULA_NODE_HOME; else process.env.KULA_NODE_HOME = old;
  }
});

test('dashboard: the paired list is in the snapshot and unpair is a same-origin POST', async () => {
  const state = new DashboardState('share', { name: 'n', id: 'i', host: null, ram: 1, totalRam: 1, bw: 1, gpu: null, vram: 0, passport: null, passportFile: null });
  state.paired([{ fp: A, name: 'phone', address: '10.0.0.2', pairedAt: 1, lastSeen: 2 }]);
  const asked: string[] = [];
  const dash = await startDashboard({ port: 0, state, actions: { unpair: (fp) => { asked.push(fp); state.paired([]); } } });
  try {
    const snap = await fetch(dash.url + 'state.json').then((r) => r.json());
    assert.equal(snap.paired[0].fp, A);
    const origin = `http://127.0.0.1:${dash.port}`;
    const post = (body: unknown, headers: Record<string, string> = { origin }) => fetch(dash.url + 'unpair', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ fp: A }, {})).status, 403);
    assert.equal((await post({ fp: 'nope' })).status, 400);
    assert.equal((await post({ fp: A.toUpperCase() })).status, 200);
    assert.deepEqual(asked, [A]);
    assert.deepEqual(state.snapshot().paired, []);
  } finally { await dash.close(); }
});
