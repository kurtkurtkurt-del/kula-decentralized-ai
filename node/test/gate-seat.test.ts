// The rpc seat (security review D4 #10, the person's decision 17 Nov): one remote master at a
// time. A friend's device (ring circle or world) that held it with nothing passing for a minute
// gives it up to one of the person's own devices; its rpc connections end. Never the other way
// round, and two devices of the same kind keep the plain rule: the second hears "busy".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { startGateServer, handshake, connectRemote, GateRefused, maySeatBeTaken, SEAT_IDLE_MS, type TlsServer } from '../src/gate.ts';
import { createIdentity, Paired, type GateIdentity } from '../src/tls.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

function echoOnce(s: Duplex, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no echo')), 3000);
    s.once('data', (d: Buffer) => { clearTimeout(t); resolve(d.toString()); });
    s.write(text);
  });
}

// a worker gate with an injected clock; `friends` are the certificates in ring circle or world
async function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-gate-seat-'));
  const echo = await echoServer();
  const worker = createIdentity('worker');
  const paired = new Paired(path.join(dir, 'paired'));
  const friends = new Set<string>();
  const clock = { t: 1_000_000 };
  const t: TlsServer = { identity: worker, paired, pin: null };
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echo.port, tls: t, friend: (fp) => friends.has(fp), now: () => clock.t });
  const device = (name: string, friend: boolean): GateIdentity => {
    const id = createIdentity(name);
    paired.add(id.fp);
    if (friend) friends.add(id.fp);
    return id;
  };
  const opened: Duplex[] = [];
  const rpc = async (id: GateIdentity): Promise<Duplex> => {
    const raw = await connectRemote('127.0.0.1', gate.port, 3000);
    opened.push(raw);
    const h = await handshake(raw, '', 'rpc', 3000, undefined, { identity: id, fp: worker.fp });
    h.socket.on('error', () => {});
    opened.push(h.socket);
    return h.socket;
  };
  return {
    clock, device, rpc,
    close: async () => { for (const s of opened) s.destroy(); await gate.close(); echo.close(); },
  };
}

// the gate ended it: the client sees the end (its tcp leg is half-open, so maybe not a close)
const closedWithin = (s: Duplex, ms: number) => new Promise<boolean>((resolve) => {
  if (s.destroyed || s.readableEnded) return resolve(true);
  const t = setTimeout(() => resolve(false), ms);
  const done = () => { clearTimeout(t); resolve(true); };
  s.once('end', done);
  s.once('close', done);
  s.resume();
});

test('the rule: only an own device, only from a friend\'s, only after a minute idle', () => {
  assert.equal(SEAT_IDLE_MS, 60_000);
  assert.equal(maySeatBeTaken(true, false, 59_000), false);
  assert.equal(maySeatBeTaken(true, false, 61_000), true);
  assert.equal(maySeatBeTaken(true, true, 61_000), false);
  assert.equal(maySeatBeTaken(false, false, 61_000), false);
  assert.equal(maySeatBeTaken(false, true, 61_000), false);
});

test('a friend\'s device idle 59 s: the own device hears busy; idle 61 s: the own device takes the seat and the friend\'s connection ends', async () => {
  const w = await world();
  try {
    const friend = w.device('friend-mac', true);
    const own = w.device('own-phone', false);
    const f = await w.rpc(friend);
    assert.equal(await echoOnce(f, 'tensor'), 'tensor');
    // the friend's last byte passed at t; 59 s later the seat is still its
    w.clock.t += 59_000;
    await assert.rejects(w.rpc(own), (e: unknown) => e instanceof GateRefused && e.reason === 'busy');
    assert.equal(f.destroyed, false, 'the friend keeps its seat at 59 s');
    // 61 s without a byte: the own device takes it
    w.clock.t += 2_000;
    const o = await w.rpc(own);
    assert.ok(await closedWithin(f, 2000), 'the friend\'s rpc connection was ended');
    assert.equal(await echoOnce(o, 'mine'), 'mine');
    // and now the friend hears busy, however long the own device is idle
    w.clock.t += 10 * 60_000;
    await assert.rejects(w.rpc(friend), (e: unknown) => e instanceof GateRefused && e.reason === 'busy');
    assert.equal(o.destroyed, false);
  } finally {
    await w.close();
  }
});

test('a byte from the friend\'s side resets the idle time', async () => {
  const w = await world();
  try {
    const friend = w.device('friend-mac', true);
    const own = w.device('own-phone', false);
    const f = await w.rpc(friend);
    w.clock.t += 50_000;
    assert.equal(await echoOnce(f, 'still here'), 'still here');
    await sleep(20);
    w.clock.t += 30_000;
    await assert.rejects(w.rpc(own), (e: unknown) => e instanceof GateRefused && e.reason === 'busy');
    assert.equal(f.destroyed, false);
  } finally {
    await w.close();
  }
});

test('friend vs friend and own vs own: busy, however long the holder is idle', async () => {
  const w = await world();
  try {
    const f1 = w.device('friend-one', true);
    const f2 = w.device('friend-two', true);
    const s1 = await w.rpc(f1);
    w.clock.t += 61_000;
    await assert.rejects(w.rpc(f2), (e: unknown) => e instanceof GateRefused && e.reason === 'busy');
    assert.equal(s1.destroyed, false);
    s1.destroy();
    await sleep(50);

    const o1 = w.device('own-one', false);
    const o2 = w.device('own-two', false);
    const s2 = await w.rpc(o1);
    w.clock.t += 61_000;
    await assert.rejects(w.rpc(o2), (e: unknown) => e instanceof GateRefused && e.reason === 'busy');
    // and never the other way round: a friend never takes an own device's seat
    await assert.rejects(w.rpc(f2), (e: unknown) => e instanceof GateRefused && e.reason === 'busy');
    assert.equal(s2.destroyed, false);
  } finally {
    await w.close();
  }
});
