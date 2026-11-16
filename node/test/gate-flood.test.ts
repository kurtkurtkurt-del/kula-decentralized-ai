// The gate under a flood (security review D4 #2, #5): handshake slots counted by address bucket
// (an internet ipv6 address by its /56) with the internet holding at most half of them, so the
// lan and loopback still get in; and a reader that holds no more than MAX_HELD_BYTES while no
// line is awaited, so a member pouring bytes while the anchor waits for an accept is cut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import {
  startGateServer, handshake, connectRemote, LineReader, HandshakeSlots, handshakeKey, fromInternet, mayHandshake,
  MAX_HANDSHAKES, MAX_INTERNET_HANDSHAKES, MAX_HANDSHAKES_PER_ADDRESS, MAX_HELD_BYTES, type TlsServer,
} from '../src/gate.ts';
import { createIdentity, Paired, type GateIdentity } from '../src/tls.ts';
import { AnchorHub } from '../src/anchor.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('addresses in one ipv6 /56 count as one; the next /56 and the lan count apart', () => {
  // 2001:db8:aa:bb00::/56: every address below shares the first 56 bits
  const same = ['2001:db8:aa:bb00::1', '2001:db8:aa:bb12::9', '2001:0db8:00aa:bbff:ffff:ffff:ffff:ffff', '2001:db8:aa:bb34:1:2:3:4'];
  const key = handshakeKey(same[0]);
  for (const a of same) assert.equal(handshakeKey(a), key, a);
  assert.notEqual(handshakeKey('2001:db8:aa:bc00::1'), key, 'the next /56 is another bucket');
  assert.notEqual(handshakeKey('2001:db8:ab:bb00::1'), key);
  // the lan and link-local stay one bucket per address; loopback is in none
  assert.notEqual(handshakeKey('fe80::1'), handshakeKey('fe80::2'));
  assert.equal(handshakeKey('192.168.1.5'), '192.168.1.5');
  assert.equal(handshakeKey('127.0.0.1'), null);
  assert.equal(handshakeKey('::1'), null);
  assert.equal(handshakeKey('::ffff:10.0.0.5'), '10.0.0.5');

  // one host handed a /56 rotates its addresses: it still gets MAX_HANDSHAKES_PER_ADDRESS in all
  const slots = new HandshakeSlots();
  let taken = 0;
  for (let i = 0; i < 40; i++) if (slots.take(`2001:db8:aa:bb${(i % 256).toString(16).padStart(2, '0')}::${i + 1}`)) taken++;
  assert.equal(taken, MAX_HANDSHAKES_PER_ADDRESS);
  assert.ok(slots.take('2001:db8:aa:bc00::1'), 'another /56 is served');
});

test('with the internet share full, a private address and loopback still get a slot', () => {
  assert.ok(fromInternet('203.0.113.7') && fromInternet('2001:db8::1'));
  assert.ok(!fromInternet('192.168.1.5') && !fromInternet('127.0.0.1') && !fromInternet('fe80::1') && !fromInternet('::ffff:10.0.0.5'));
  const slots = new HandshakeSlots();
  // four internet ipv4 addresses try MAX_HANDSHAKES_PER_ADDRESS each: together they would hold every slot
  const releases: (() => void)[] = [];
  let taken = 0;
  for (const a of ['203.0.113.1', '203.0.113.2', '198.51.100.3', '198.51.100.4']) {
    for (let i = 0; i < MAX_HANDSHAKES_PER_ADDRESS; i++) {
      const r = slots.take(a);
      if (r) { taken++; releases.push(r); }
    }
  }
  assert.equal(taken, MAX_INTERNET_HANDSHAKES, 'the internet holds at most half');
  assert.ok(MAX_INTERNET_HANDSHAKES < MAX_HANDSHAKES);
  assert.equal(slots.take('2001:db8:1::1'), null, 'a fresh internet address waits too');
  assert.ok(slots.take('192.168.1.5'), 'the lan gets in');
  assert.ok(slots.take('127.0.0.1'), 'loopback (an anchor or relayed stream) gets in');
  assert.ok(slots.take('fe80::1'), 'link-local gets in');
  // a slot given back by the internet is the internet's again; the counts never go below zero
  releases[0]();
  releases[0]();
  assert.equal(slots.internet, MAX_INTERNET_HANDSHAKES - 1);
  assert.ok(slots.take('203.0.113.9'));
  // the whole table full: nobody
  const full = { total: MAX_HANDSHAKES, internet: 0, byKey: new Map<string, number>() };
  assert.equal(mayHandshake(full, '127.0.0.1'), false);
});

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

// a member's raw anchor connection: the gate handshake on the anchor channel, then lines
async function anchorConn(port: number, anchorFp: string, me: GateIdentity): Promise<{ socket: Duplex; reader: LineReader }> {
  const raw = await connectRemote('127.0.0.1', port, 3000);
  const h = await handshake(raw, '', 'anchor', 3000, undefined, { identity: me, fp: anchorFp });
  const reader = new LineReader(h.socket);
  if (h.rest.length) reader.feed(h.rest);
  return { socket: h.socket, reader };
}

test('a member that dials a target which never accepts, then writes 1 MB, is destroyed and the reader holds at most 64 KiB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-gate-flood-'));
  const echo = await echoServer();
  const anchorId = createIdentity('anchor');
  const target = createIdentity('target-never-accepts');
  const dialer = createIdentity('dialer-pours');
  const paired = new Paired(path.join(dir, 'paired'));
  paired.add(target.fp);
  paired.add(dialer.fp);
  const t: TlsServer = { identity: anchorId, paired, pin: null };
  // the accept wait is long: only the cap may end the dial within the test
  const hub = new AnchorHub({ self: anchorId.fp, isMember: (fp) => paired.has(fp), acceptTimeoutMs: 30_000 });
  // the readers the gate hands to the hub, by member
  const readers = new Map<string, LineReader>();
  const serve = hub.serve.bind(hub);
  hub.serve = (socket, reader, who, done) => { readers.set(who.fp, reader); return serve(socket, reader, who, done); };
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echo.port, tls: t, anchor: hub });
  const conns: Duplex[] = [];
  try {
    // the target registers and then never answers an open
    const tg = await anchorConn(gate.port, anchorId.fp, target);
    conns.push(tg.socket);
    tg.socket.write(JSON.stringify({ t: 'register', name: 'target', kind: 'pc' }) + '\n');
    assert.equal(JSON.parse(await tg.reader.line(3000)).t, 'registered');

    const d = await anchorConn(gate.port, anchorId.fp, dialer);
    conns.push(d.socket);
    const closed = new Promise<number>((resolve) => d.socket.once('close', () => resolve(Date.now())));
    d.socket.on('error', () => {});
    d.socket.write(JSON.stringify({ t: 'dial', to: target.fp }) + '\n');
    // the hub asked the target: the dial now waits for an accept that never comes
    const open = JSON.parse(await tg.reader.line(3000));
    assert.equal(open.t, 'open');
    d.reader.release();
    const t0 = Date.now();
    const mb = Buffer.alloc(1024 * 1024, 0x41);
    for (let i = 0; i < 16; i++) d.socket.write(mb.subarray(i * 65536, (i + 1) * 65536));
    const at = await Promise.race([closed, sleep(5000).then(() => -1)]);
    assert.notEqual(at, -1, 'the dialer was not cut within 5 s');
    assert.ok(at - t0 < 5000);
    const r = readers.get(dialer.fp);
    assert.ok(r, 'the gate handed the dialer to the hub');
    assert.ok(r.held <= MAX_HELD_BYTES, `the reader holds ${r.held} bytes`);
    assert.equal(MAX_HELD_BYTES, 64 * 1024);
    // the target's own control connection is untouched
    assert.equal(tg.socket.destroyed, false);
  } finally {
    for (const c of conns) c.destroy();
    await gate.close();
    hub.close();
    echo.close();
  }
});

test('the cap counts the bytes left unread with no line awaited: under it the socket lives, past it the socket is destroyed', async () => {
  const [a, b] = duplexPairLocal();
  const reader = new LineReader(b, MAX_HELD_BYTES);
  const p = reader.line(1000);
  // one line, then no line awaited: 40 KiB is under the cap
  a.write('first\n' + 'x'.repeat(40 * 1024));
  assert.equal(await p, 'first');
  await sleep(20);
  assert.equal(b.destroyed, false);
  assert.equal(reader.held, 40 * 1024);
  // past the cap with no line awaited: destroyed, nothing held
  a.write('y'.repeat(30 * 1024));
  await sleep(20);
  assert.equal(b.destroyed, true);
  assert.equal(reader.held, 0);
  await assert.rejects(reader.line(100));
  a.destroy();
});

// two duplexes wired to each other
function duplexPairLocal(): [Duplex, Duplex] {
  let left: Duplex;
  let right: Duplex;
  left = new Duplex({ read() {}, write(c, _e, cb) { right.push(c); cb(); }, final(cb) { right.push(null); cb(); } });
  right = new Duplex({ read() {}, write(c, _e, cb) { left.push(c); cb(); }, final(cb) { left.push(null); cb(); } });
  return [left, right];
}
