// The first step of the internet path (docs/INTERNET.md): the gate on ipv6 and ipv4 at once,
// a peer record with several addresses (qr v3 `addrs`), and the client keeping the first
// address whose pinned certificate answers. Everything on loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startGateServer, probe, type GateEvent, type TlsServer } from '../src/gate.ts';
import { createIdentity, Paired } from '../src/tls.ts';
import { parsePeerText, peerCode, cleanAddrs, candidates, dialOf, reachedBy, addrKind, pickRoute, probePeers, whereIs, type Peer } from '../src/peers.ts';
import { globalIPv6 } from '../src/sysinfo.ts';
import { openPeerDevice } from '../src/apart.ts';

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

// is there an ipv6 loopback to test on?
const hasV6 = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '::1', () => s.close(() => resolve(true)));
});

// a closed port on 127.0.0.1: a "lan address" that does not answer, at once
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('the gate listens dual-stack by default: an ipv4 and an ipv6 client both get through, and the peer is one plain form', { skip: !hasV6 && 'no ipv6 loopback here' }, async () => {
  const echo = await echoServer();
  const events: GateEvent[] = [];
  const gate = await startGateServer({ port: 0, secret: 's', targets: () => echo.port, onEvent: (e) => events.push(e) });
  try {
    assert.equal(gate.dualStack, true);
    assert.equal(gate.bound, '::');
    assert.deepEqual((await probe('127.0.0.1', gate.port, 's', 'rpc')).ok, true);
    assert.deepEqual((await probe('::1', gate.port, 's', 'api')).ok, true);
    const peers = events.filter((e) => e.type === 'open').map((e) => e.peer);
    assert.deepEqual(peers, ['127.0.0.1', '::1'], 'an ipv4 client is not "::ffff:127.0.0.1"');
  } finally { await gate.close(); echo.close(); }
});

test('dualStack false is ipv4 only, as before; a host given is that host only', { skip: !hasV6 && 'no ipv6 loopback here' }, async () => {
  const echo = await echoServer();
  const v4 = await startGateServer({ port: 0, dualStack: false, secret: 's', targets: () => echo.port });
  const lo = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', targets: () => echo.port });
  try {
    assert.deepEqual([v4.bound, v4.dualStack, lo.bound, lo.dualStack], ['0.0.0.0', false, '127.0.0.1', false]);
    assert.equal((await probe('127.0.0.1', v4.port, 's', 'rpc')).ok, true);
    const r = await probe('::1', v4.port, 's', 'rpc');
    assert.equal(r.ok, false);
  } finally { await v4.close(); await lo.close(); echo.close(); }
});

const FP = 'ab'.repeat(32);
const qr = (o: Record<string, unknown>) => JSON.stringify({ k: 'kula-peer', v: 3, id: 'w1', name: 'mac', host: '192.168.1.20', port: 50551, fp: FP, pin: '0123456789abcdef', kind: 'pc', ...o });

test('a qr v3 may carry several addresses; bad entries are dropped, names are not taken; the old single host still works', () => {
  const p = parsePeerText(qr({ addrs: [
    { host: '192.168.1.20', port: 50551, via: 'lan' },
    { host: '[2001:DB8::5]', port: 50551, via: 'ipv6' },
    { host: '203.0.113.7', port: 40001, via: 'mapped' },
    { host: 'evil.example', port: 1, via: 'mapped' },
    { host: '203.0.113.8', port: 70000, via: 'mapped' },
    { host: '203.0.113.9', port: 1, via: 'teleport' },
    { host: '203.0.113.7', port: 40001, via: 'mapped' },
  ] }));
  assert.deepEqual(p.addrs, [
    { host: '192.168.1.20', port: 50551, via: 'lan' },
    { host: '2001:db8::5', port: 50551, via: 'ipv6' },
    { host: '203.0.113.7', port: 40001, via: 'mapped' },
  ]);
  assert.equal(parsePeerText(qr({})).addrs, undefined, 'no addrs: the record is as before');
  // addrs only: the first is host/port
  const only = parsePeerText(qr({ host: undefined, port: undefined, addrs: [{ host: '203.0.113.7', port: 40001, via: 'mapped' }] }));
  assert.deepEqual([only.host, only.port], ['203.0.113.7', 40001]);
  // the pasteable code keeps them
  assert.deepEqual(parsePeerText(peerCode(p)).addrs, p.addrs);
  // a v2 qr (v1 secret) never takes addrs: v1 must not cross the internet
  const v2 = parsePeerText(JSON.stringify({ k: 'kula-peer', v: 2, id: 'w', name: 'w', host: '192.168.1.20', port: 1, secret: 'ab'.repeat(16), addrs: [{ host: '203.0.113.7', port: 2, via: 'mapped' }] }));
  assert.equal(v2.addrs, undefined);
  assert.equal(cleanAddrs(Array.from({ length: 40 }, (_, i) => ({ host: `10.0.0.${i + 1}`, port: 1, via: 'lan' }))).length, 8);
});

test('the order to try: host/port first, then the qr\'s addrs; a cable or relay has one way', () => {
  const p = parsePeerText(qr({ host: '192.168.1.30', addrs: [{ host: '192.168.1.20', port: 50551, via: 'lan' }, { host: '203.0.113.7', port: 40001, via: 'mapped' }] }));
  assert.deepEqual(candidates(p).map((a) => `${a.via} ${a.host}:${a.port}`), ['lan 192.168.1.30:50551', 'lan 192.168.1.20:50551', 'mapped 203.0.113.7:40001']);
  assert.deepEqual(candidates({ ...p, cable: { serial: 'x' } }).length, 1);
  assert.equal(addrKind('2001:db8::1'), 'ipv6');
  assert.equal(addrKind('fe80::1'), 'lan');
  assert.equal(addrKind('10.0.0.1'), 'lan');
  const routed = { ...p, route: { host: '203.0.113.7', port: 40001, via: 'mapped' as const } };
  assert.deepEqual(dialOf(routed), { host: '203.0.113.7', port: 40001 });
  assert.equal(reachedBy(routed), 'mapped');
  assert.equal(reachedBy(p), 'lan');
  assert.equal(whereIs(routed), '203.0.113.7:40001 (router port, over the internet)');
});

test('global ipv6 addresses only: no link-local, no unique-local, no tunnels', () => {
  const v6 = (address: string, scopeid = 0) => ({ address, family: 'IPv6' as const, internal: false, netmask: 'ffff:ffff:ffff:ffff::', mac: '00:00:00:00:00:00', cidr: null, scopeid });
  const got = globalIPv6(2, {
    lo0: [{ ...v6('::1'), internal: true }],
    en0: [v6('fe80::1', 4), v6('fd00::5'), v6('2a02:810d::1234'), v6('2a02:810d::abcd'), v6('2a02:810d::ffff')],
    utun3: [v6('2001:db8::77')],
  } as any);
  assert.deepEqual(got, ['2a02:810d::1234', '2a02:810d::abcd']);
});

test('the client keeps the first address whose pinned certificate answers: a silent lan and a stranger\'s gate are passed over', async () => {
  const echo = await echoServer();
  const worker = createIdentity('worker');
  const stranger = createIdentity('stranger');
  const master = createIdentity('master');
  const paired = new Paired(null);
  paired.add(master.fp);
  const t: TlsServer = { identity: worker, paired, pin: null };
  const right = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: (ch) => (ch === 'api' ? echo.port : null), tls: t });
  const wrong = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echo.port, tls: { identity: stranger, paired: new Paired(null), pin: '00'.repeat(8) } });
  const silent = await closedPort();
  const peer: Peer = {
    ...parsePeerText(qr({ host: '127.0.0.1', port: silent, fp: worker.fp, addrs: [
      { host: '127.0.0.1', port: wrong.port, via: 'ipv6' },
      { host: '127.0.0.1', port: right.port, via: 'mapped' },
    ] })),
    pin: null,
  };
  try {
    const a = await pickRoute(peer, master, 1000);
    assert.deepEqual(a, { host: '127.0.0.1', port: right.port, via: 'mapped' });
    // the probe keeps it as the route, and the api channel answers there; rpc stays on host/port
    const [r] = await probePeers([peer], 1000, ['rpc', 'api'], undefined, master);
    assert.deepEqual(r.peer.route, { host: '127.0.0.1', port: right.port, via: 'mapped' });
    assert.equal(r.api.ok, true);
    assert.equal(r.rpc.ok, false, 'split mode never goes over the internet route');
    // apart mode opens its tunnel there
    const dev = await openPeerDevice(r.peer, master);
    try {
      const got = await new Promise<string>((resolve, reject) => {
        const c = net.connect(dev.apiPort, '127.0.0.1', () => c.write('hello'));
        c.once('data', (d) => { resolve(d.toString()); c.destroy(); });
        c.once('error', reject);
      });
      assert.equal(got, 'hello');
    } finally { await dev.close(); }
    // back home: host/port answers again, the route goes away
    const home = await startGateServer({ port: silent, host: '127.0.0.1', secret: null, targets: (ch) => (ch === 'api' ? echo.port : null), tls: t });
    try {
      const [again] = await probePeers([r.peer], 1000, ['api'], undefined, master);
      assert.equal(again.peer.route, null);
      assert.equal(reachedBy(again.peer), 'lan');
    } finally { await home.close(); }
    // nobody answers: the old route is kept, the probe says why
    const lost = { ...peer, route: { host: '127.0.0.1', port: right.port, via: 'mapped' as const }, addrs: [] };
    const [l] = await probePeers([lost], 500, ['api'], undefined, master);
    assert.equal(l.api.ok, true, 'a single way is not peeked: the probe goes straight to the route');
  } finally { await right.close(); await wrong.close(); echo.close(); }
});

test('a peer without a pinned certificate is never routed by addrs', async () => {
  const p = { ...parsePeerText(qr({})), fp: null };
  let peeks = 0;
  const peek = async () => { peeks++; return { up: true as const, fp: FP, state: 'paired' as const }; };
  assert.equal(await pickRoute(p as Peer, createIdentity('m'), 100, peek), null);
  assert.equal(peeks, 0);
});
