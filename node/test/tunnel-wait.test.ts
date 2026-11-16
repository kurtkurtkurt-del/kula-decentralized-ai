// A Tunnel waits for an anchor that says "too many dials" (gate.ts, Tunnel): a far split's
// llama-server opens ~13 rpc connections per worker at once, and one dropped connection aborts the
// whole server. Three gates on 127.0.0.1: A the anchor with a tiny dial bucket, W the worker
// (registered with A), M this computer (a friend member of A, paired with W). Nothing leaves
// loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startGateServer, Tunnel, TOO_MANY_DIALS, type GateServer, type TlsServer, type Dialer } from '../src/gate.ts';
import { createIdentity, Paired, type GateIdentity } from '../src/tls.ts';
import { AnchorHub, circleMembers, dialAnchor, joinAnchor, type AnchorCaps, type AnchorMembership, type AnchorRef } from '../src/anchor.ts';
import { roadDialer } from '../src/road.ts';
import { peerTls, type Peer } from '../src/peers.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-tunnel-wait-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

interface Home { identity: GateIdentity; paired: Paired; gate: GateServer; hub: AnchorHub | null }

async function home(name: string, echoPort: number | null, caps?: Partial<AnchorCaps>): Promise<Home> {
  const dir = tmp();
  const identity = createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const t: TlsServer = { identity, paired, pin: null };
  const hub = caps ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, path.join(dir, 'peers.json')), caps }) : null;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echoPort, tls: t, anchor: hub ?? undefined });
  return { identity, paired, gate, hub };
}

async function world(caps: Partial<AnchorCaps>) {
  const echo = await echoServer();
  const A = await home('anchor-berlin', null, caps);
  const W = await home('worker', echo.port);
  const M = await home('master', null);
  A.paired.add(W.identity.fp);
  A.paired.add(M.identity.fp);
  W.paired.add(M.identity.fp);
  const ref: AnchorRef = { host: '127.0.0.1', port: A.gate.port, fp: A.identity.fp };
  const member: AnchorMembership = await joinAnchor({ anchor: ref, identity: W.identity, name: 'worker', kind: 'pc', gatePort: W.gate.port });
  const peer: Peer = {
    id: 'w', name: 'worker', host: '127.0.0.1', port: 9, secret: '', fp: W.identity.fp, pin: null, paired_at: 't',
    kind: 'pc', ram: 8000, bw: 40, added_at: 't',
    anchors: [{ fp: A.identity.fp, host: '127.0.0.1', port: A.gate.port, name: 'berlin' }],
    route: { via: 'anchor', anchor: A.identity.fp },
  };
  return {
    A, W, M, ref, peer,
    close: async () => {
      await member.close();
      for (const h of [A, W, M]) { h.hub?.close(); await h.gate.close(); }
      echo.close();
    },
  };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
}

// writes `msg` and resolves with what came back once it is all there; rejects when the socket
// closes first (the tunnel dropped it)
function echoOf(s: net.Socket, msg: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = '';
    const t = setTimeout(() => reject(new Error(`timeout with ${JSON.stringify(got)}`)), timeoutMs);
    s.on('data', (d) => { got += d.toString(); if (got.length >= msg.length) { clearTimeout(t); resolve(got); } });
    s.once('close', () => { clearTimeout(t); reject(new Error(`closed with ${JSON.stringify(got)}`)); });
    s.write(msg);
  });
}

test('five rpc-like connections at once over an anchor with a bucket of 2: all five wait their turn and pipe, none is dropped', async () => {
  // 2 dials at once, then one every 500 ms
  const w = await world({ dialBurst: 2, dialsPerMinute: 120 });
  const tunnel = Tunnel.over(roadDialer(w.peer, { identity: w.M.identity }), '', 'api', peerTls(w.peer, w.M.identity));
  const lines: string[] = [];
  tunnel.log = (l) => lines.push(l);
  try {
    const port = await tunnel.listen();
    const socks = await Promise.all([0, 1, 2, 3, 4].map(() => connect(port)));
    const answers = await Promise.all(socks.map((s, i) => echoOf(s, `layer ${i} through the anchor`, 15_000)));
    assert.deepEqual(answers, [0, 1, 2, 3, 4].map((i) => `layer ${i} through the anchor`));
    assert.ok(lines.length >= 3, `three were refused and waited: ${lines.join(' | ')}`);
    for (const l of lines) assert.match(l, /^waiting for the anchor: too many dials, retrying in \d+ ms$/);
    assert.ok(lines.some((l) => l.endsWith('in 250 ms')), 'the first wait is 250 ms');
    assert.ok(socks.every((s) => !s.destroyed), 'none destroyed');
    for (const s of socks) s.destroy();
  } finally {
    await tunnel.close();
    await w.close();
  }
});

test('the wait backs off 250, 500, 1000 ms; a local leg that closes stops it without another dial', async () => {
  const w = await world({ dialBurst: 1, dialsPerMinute: 0.001 });
  let dials = 0;
  const base = roadDialer(w.peer, { identity: w.M.identity });
  const dial: Dialer = Object.assign(() => { dials++; return base(); }, { failed: base.failed });
  const tunnel = Tunnel.over(dial, '', 'api', peerTls(w.peer, w.M.identity));
  const lines: string[] = [];
  tunnel.log = (l) => lines.push(l);
  try {
    const port = await tunnel.listen();
    const first = await connect(port);
    assert.equal(await echoOf(first, 'the one token', 5000), 'the one token');
    const late = await connect(port);
    late.on('error', () => {});
    while (lines.length < 3) await sleep(20);
    assert.deepEqual(lines.slice(0, 3).map((l) => Number(/in (\d+) ms/.exec(l)![1])), [250, 500, 1000]);
    assert.ok(!late.destroyed, 'the local leg is kept open while it waits');
    late.destroy();
    await sleep(100);
    const after = dials;
    await sleep(1500);
    assert.equal(dials, after, 'no dial after the local leg closed');
    first.destroy();
  } finally {
    await tunnel.close();
    await w.close();
  }
});

test('another anchor refusal ("not here") drops the local leg at once, as before; no wait', async () => {
  const w = await world({ dialBurst: 2, dialsPerMinute: 120 });
  const nobody = createIdentity('nobody').fp;
  const dial: Dialer = () => dialAnchor(w.ref, w.M.identity, nobody);
  const tunnel = Tunnel.over(dial, '', 'api', { identity: w.M.identity, fp: nobody });
  const lines: string[] = [];
  tunnel.log = (l) => lines.push(l);
  try {
    const port = await tunnel.listen();
    const s = await connect(port);
    const t0 = Date.now();
    await assert.rejects(echoOf(s, 'hello', 3000), /closed/);
    assert.ok(Date.now() - t0 < 1000, 'dropped at once');
    assert.deepEqual(lines, []);
    assert.equal(TOO_MANY_DIALS, 'too many dials');
  } finally {
    await tunnel.close();
    await w.close();
  }
});
