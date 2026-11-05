import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startGateServer, handshake, probe, Tunnel, clientProof, serverProof, GateRefused, type GateEvent } from '../src/gate.ts';

const SECRET = 'test-secret';

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

function readLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const on = (c: Buffer) => {
      buf += c.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) { socket.off('data', on); resolve(buf.slice(0, i)); }
    };
    socket.on('data', on);
  });
}

test('vectors match the implementation', () => {
  const { vectors } = JSON.parse(readFileSync(new URL('./gate-vectors.json', import.meta.url), 'utf8'));
  assert.equal(vectors.length, 3);
  for (const v of vectors) {
    assert.equal(clientProof(v.secret, v.nonce_c, v.nonce_s, v.channel), v.hmac_c);
    assert.equal(serverProof(v.secret, v.nonce_c, v.nonce_s, v.channel), v.hmac_s);
  }
});

test('handshake succeeds and probe says ok on both channels', async () => {
  const echo = await echoServer();
  const events: GateEvent[] = [];
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: SECRET, targets: () => echo.port, onEvent: (e) => events.push(e) });
  try {
    for (const ch of ['rpc', 'api'] as const) {
      const r = await probe('127.0.0.1', gate.port, SECRET, ch);
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.some((e) => e.type === 'open' && e.channel === 'rpc'));
  } finally {
    await gate.close();
    echo.close();
  }
});

test('wrong secret is refused with NO wrong secret', async () => {
  const echo = await echoServer();
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: SECRET, targets: () => echo.port });
  try {
    const r = await probe('127.0.0.1', gate.port, 'not-it', 'api');
    assert.deepEqual(r, { ok: false, reason: 'wrong secret' });
    const s = net.connect(gate.port, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    await assert.rejects(handshake(s, 'not-it', 'api'), (e: Error) => e instanceof GateRefused && e.message === 'NO wrong secret');
    s.destroy();
  } finally {
    await gate.close();
    echo.close();
  }
});

test('malformed hello, channel and nonce are refused with their reasons', async () => {
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: SECRET, targets: () => null });
  const ask = async (line: string) => {
    const s = net.connect(gate.port, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    s.write(line);
    const a = await readLine(s);
    s.destroy();
    return a;
  };
  try {
    assert.equal(await ask('HELLO\n'), 'NO bad hello');
    assert.equal(await ask('KULA1 ftp 00112233445566778899aabbccddeeff\n'), 'NO bad channel');
    assert.equal(await ask('KULA1 api xyz\n'), 'NO bad nonce');
  } finally {
    await gate.close();
  }
});

test('a closed channel answers NO channel closed, a dead target NO target down', async () => {
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: SECRET, targets: (ch) => (ch === 'api' ? null : 1) });
  try {
    assert.deepEqual(await probe('127.0.0.1', gate.port, SECRET, 'api'), { ok: false, reason: 'channel closed' });
    assert.deepEqual(await probe('127.0.0.1', gate.port, SECRET, 'rpc'), { ok: false, reason: 'target down' });
  } finally {
    await gate.close();
  }
});

test('rpc admits one peer ip at a time: a second ip gets busy, api is unaffected', async () => {
  const echo = await echoServer();
  const gate = await startGateServer({ port: 0, host: '0.0.0.0', secret: SECRET, targets: () => echo.port });
  let busyChecked = false;
  try {
    // first peer from 127.0.0.1 holds rpc open
    const a = net.connect({ port: gate.port, host: '127.0.0.1', localAddress: '127.0.0.1' });
    await new Promise((r) => a.once('connect', r));
    await handshake(a, SECRET, 'rpc');
    // same ip again is fine
    const a2 = await probe('127.0.0.1', gate.port, SECRET, 'rpc');
    assert.equal(a2.ok, true);
    // a second peer ip: connecting to the gate over the lan address makes the
    // source the lan address, not 127.0.0.1 (skipped on a machine without one)
    const lan = Object.values(os.networkInterfaces()).flat().find((x) => x && x.family === 'IPv4' && !x.internal)?.address;
    if (lan) {
      const b = net.connect({ port: gate.port, host: lan });
      await new Promise((r) => b.once('connect', r));
      await assert.rejects(handshake(b, SECRET, 'rpc'), (e: Error) => e.message === 'NO busy');
      b.destroy();
      const c = net.connect({ port: gate.port, host: lan });
      await new Promise((r) => c.once('connect', r));
      await handshake(c, SECRET, 'api');
      c.destroy();
      busyChecked = true;
    }
    a.destroy();
    await new Promise((r) => setTimeout(r, 50));
    // once the first peer is gone the channel is free again
    assert.equal((await probe('127.0.0.1', gate.port, SECRET, 'rpc')).ok, true);
    if (!busyChecked) console.log('  (busy branch skipped: no lan ipv4 on this machine)');
  } finally {
    await gate.close();
    echo.close();
  }
});

test('the pipe carries 1 MB both ways intact, through a Tunnel', async () => {
  // a server that sends 1 MB first, then echoes what it receives
  const payloadOut = randomBytes(1 << 20);
  let gotAtTarget = Buffer.alloc(0);
  const target = net.createServer((c) => {
    c.write(payloadOut);
    c.on('data', (d: Buffer) => {
      gotAtTarget = Buffer.concat([gotAtTarget, d]);
      c.write(d);
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  const targetPort = (target.address() as net.AddressInfo).port;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: SECRET, targets: () => targetPort });
  const tunnel = new Tunnel('127.0.0.1', gate.port, SECRET, 'rpc');
  const local = await tunnel.listen();
  try {
    const c = net.connect(local, '127.0.0.1');
    await new Promise((r) => c.once('connect', r));
    const payloadIn = randomBytes(1 << 20);
    // write in odd sized pieces so chunk boundaries fall anywhere
    for (let i = 0; i < payloadIn.length; i += 7777) c.write(payloadIn.subarray(i, i + 7777));
    const want = payloadOut.length + payloadIn.length;
    const got = await new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      let n = 0;
      c.on('data', (d: Buffer) => { parts.push(d); n += d.length; if (n >= want) resolve(Buffer.concat(parts)); });
    });
    assert.equal(got.length, want);
    assert.ok(got.subarray(0, payloadOut.length).equals(payloadOut), 'server -> client payload intact');
    assert.ok(got.subarray(payloadOut.length).equals(payloadIn), 'echo of client payload intact');
    assert.ok(gotAtTarget.equals(payloadIn), 'client -> server payload intact');
    c.destroy();
  } finally {
    await tunnel.close();
    await gate.close();
    target.close();
  }
});

test('bytes sent right after the proof line are not lost', async () => {
  let seen = Buffer.alloc(0);
  const target = net.createServer((c) => c.on('data', (d: Buffer) => { seen = Buffer.concat([seen, d]); }));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: SECRET, targets: () => (target.address() as net.AddressInfo).port });
  try {
    const s = net.connect(gate.port, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    const nonceC = '0123456789abcdef0123456789abcdef';
    s.write(`KULA1 api ${nonceC}\n`);
    const nonceS = await readLine(s);
    // proof and payload in one write
    s.write(clientProof(SECRET, nonceC, nonceS, 'api') + '\nEARLY');
    const ok = await readLine(s);
    assert.ok(ok.startsWith('OK '));
    s.write(' LATE');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.toString(), 'EARLY LATE');
    s.destroy();
  } finally {
    await gate.close();
    target.close();
  }
});
