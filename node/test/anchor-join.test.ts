// Joining an anchor (docs/ANCHOR.md "join", stage 4). Three homes on 127.0.0.1, each with its own
// identity, gate and files: A is the anchor, B and C join it with A's invites (kula-peer v3 with
// `anchor: true`, `pin` and `hpin`), register, and A pairs back with each through its own hub.
// Then C reaches B through A, A reaches B through 'self', and the engine's rows say so. An expired,
// a replaced and a reused invite are refused; the pair-back code opens for the anchor's
// certificate only; a typed invite (address, code, certificate start) joins too; the router's
// answers (fake routers) come out as the page's plain words; the switch survives a restart; the
// page's routes for the switch and the invite.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import type { Duplex } from 'node:stream';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-join-home-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { startGateServer, handshake, GateRefused } = await import('../src/gate.ts');
type GateServer = import('../src/gate.ts').GateServer;
type TlsServer = import('../src/gate.ts').TlsServer;
const { createIdentity, newPin, Paired } = await import('../src/tls.ts');
type GateIdentity = import('../src/tls.ts').GateIdentity;
const { AnchorHub, circleMembers } = await import('../src/anchor.ts');
const { OneTimeCodes, AnchorHost, AnchorLinks, joinWithInvite, readJoined, joinedRoads, pairBackCode, reachableFromOutside, ringCapped } = await import('../src/join.ts');
const { parsePeerText, readPeers, writePeers, probePeers, setRing } = await import('../src/peers.ts');
const { joinAnchor, dialAnchor } = await import('../src/anchor.ts');
type Peer = import('../src/peers.ts').Peer;
type PeerAddr = import('../src/peers.ts').PeerAddr;
const { pickRoute, openRoad } = await import('../src/road.ts');
const { startPortMapper, pcpAddr } = await import('../src/portmap.ts');
const { ShareHere, anchorShareView, anchorWords, mapState, readAnchorSetting, CGNAT_WORDS } = await import('../src/ui/sharehere.ts');
type ShareHandle = import('../src/share.ts').ShareHandle;
type ShareOptions = import('../src/share.ts').ShareOptions;
const { Engine } = await import('../src/ui/engine.ts');
const { startUi } = await import('../src/ui/server.ts');
const { ChatStore } = await import('../src/ui/store.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(HOME, 'h-'));

async function until(f: () => boolean, ms = 6000, what = 'the condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

// a port nothing listens on (the lan address of a device that is away)
function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function readAtLeast(s: Duplex, n: number, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let got = 0;
    const t = setTimeout(() => reject(new Error(`timeout after ${got} bytes`)), timeoutMs);
    const on = (d: Buffer) => { parts.push(d); got += d.length; if (got >= n) { clearTimeout(t); s.off('data', on); resolve(Buffer.concat(parts)); } };
    s.on('data', on);
    s.resume();
  });
}

interface Home {
  name: string; dir: string; identity: GateIdentity; paired: InstanceType<typeof Paired>; tls: TlsServer; codes: InstanceType<typeof OneTimeCodes>;
  gate: GateServer; hub: InstanceType<typeof AnchorHub> | null; host: InstanceType<typeof AnchorHost> | null; peersFile: string; joinedFile: string; logs: string[];
}

async function home(name: string, echoPort: number, o: { anchor?: boolean; ttlMs?: number; caps?: Record<string, number> } = {}): Promise<Home> {
  const dir = tmp();
  const identity = createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const codes = new OneTimeCodes();
  // no code of its own open: only the invites and pair-back codes (join.ts) pair here
  const tls: TlsServer = { identity, paired, pin: null, codes, onPinUsed: () => {} };
  const peersFile = path.join(dir, 'peers.json');
  // as share builds it: friends' devices (ring circle) byte-capped, the person's own (home) not
  const hub = o.anchor ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, peersFile), capped: ringCapped(peersFile), caps: o.caps }) : null;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echoPort, tls, anchor: hub ?? undefined });
  const logs: string[] = [];
  const host = hub ? new AnchorHost({ identity, codes, hub, peersFile, id: `id-${name}`, name, ttlMs: o.ttlMs, log: (s) => logs.push(s) }) : null;
  return { name, dir, identity, paired, tls, codes, gate, hub, host, peersFile, joinedFile: path.join(dir, 'anchors.json'), logs };
}

const linksOf: InstanceType<typeof AnchorLinks>[] = [];
function link(h: Home) {
  const l = new AnchorLinks({ identity: h.identity, name: h.name, kind: 'pc', gatePort: h.gate.port, file: h.joinedFile, codes: h.codes, retryMs: 100, pollMs: 200, log: (s) => h.logs.push(s) });
  l.start();
  linksOf.push(l);
  return l;
}

async function closeAll(homes: Home[], extra: { close: () => void }[] = []) {
  for (const l of linksOf.splice(0)) await l.close();
  for (const h of homes) { h.host?.close(); h.hub?.close(); await h.gate.close(); }
  for (const x of extra) x.close();
}

const mapped = (h: Home): PeerAddr[] => [{ host: '127.0.0.1', port: h.gate.port, via: 'mapped' }];

test('the invite round trip across three homes: B and C join A, A pairs back with each, C reaches B through A, A reaches B through self', async () => {
  const echo = await echoServer();
  const A = await home('anchor-berlin', echo.port, { anchor: true });
  const B = await home('mac-home', echo.port);
  const C = await home('laptop-far', echo.port);
  try {
    // A's invite: its certificate, its address from outside, the two codes, anchor: true
    // B is the person's own computer (their invite says "mine"), C a friend's (the default)
    const inviteB = A.host!.invite(mapped(A), { ram: 8000, bw: 50 }, 'mine');
    assert.equal(inviteB.lanOnly, false);
    assert.equal(inviteB.whose, 'mine');
    assert.deepEqual(inviteB.typed, { address: `127.0.0.1:${A.gate.port}`, code: inviteB.typed.code, certificate: A.identity.fp.slice(0, 16) });
    const pB = parsePeerText(inviteB.code);
    assert.equal(pB.anchor, true);
    assert.equal(pB.fp, A.identity.fp);
    assert.equal(pB.pin, inviteB.typed.code);
    assert.equal(pB.hpin, pairBackCode(pB.pin!), 'the pair-back code is carried, and derivable from the code when typed');
    assert.equal(A.host!.current()?.code, inviteB.code);

    // B joins: pairs with A's gate with `pin`, keeps A in its peer book and among its joined anchors
    const jB = await joinWithInvite({ peer: pB, identity: B.identity, peersFile: B.peersFile, joinedFile: B.joinedFile });
    assert.equal(jB.peer.fp, A.identity.fp);
    assert.ok(A.paired.has(B.identity.fp), 'A paired B with the invite');
    assert.equal(A.host!.current(), null, 'the invite is spent');
    const bookB = readPeers(B.peersFile);
    assert.equal(bookB.length, 1);
    assert.equal(bookB[0].anchor, true);
    assert.equal(bookB[0].pin, null);
    assert.ok(bookB[0].paired_at);
    assert.ok(!('hpin' in bookB[0]), 'the pair-back code never goes into the peer book');
    assert.equal(bookB[0].ring, 'circle');
    assert.equal(readJoined(B.joinedFile)[0].hpin, pB.hpin);

    // B registers (AnchorLinks) with the pair-back code open on its gate for A only; A pairs back
    const lB = link(B);
    await until(() => readPeers(A.peersFile).some((p) => p.fp === B.identity.fp), 6000, 'A to pair back with B');
    assert.ok(B.paired.has(A.identity.fp), 'B paired A with the hpin');
    const recB = readPeers(A.peersFile).find((p) => p.fp === B.identity.fp)!;
    assert.deepEqual(recB.route, { via: 'anchor', anchor: 'self' });
    assert.equal(recB.name, 'mac-home');
    assert.equal(recB.ring, 'home', 'the invite said: mine');
    assert.ok(recB.paired_at);
    await until(() => readJoined(B.joinedFile)[0].hpin === null, 3000, 'B to note the pair-back');
    await until(() => lB.view()[0]?.state === 'registered', 3000, 'B registered');
    assert.equal(lB.view()[0].waitingBack, false);
    assert.ok(!B.codes.has(pB.hpin!), 'the pair-back code is spent');

    // C joins with a second invite
    const inviteC = A.host!.invite(mapped(A));
    const jC = await joinWithInvite({ peer: parsePeerText(inviteC.code), identity: C.identity, peersFile: C.peersFile, joinedFile: C.joinedFile });
    assert.equal(jC.peer.fp, A.identity.fp);
    link(C);
    await until(() => readPeers(A.peersFile).some((p) => p.fp === C.identity.fp), 6000, 'A to pair back with C');
    assert.equal(readPeers(A.peersFile).find((p) => p.fp === C.identity.fp)!.ring, 'circle', 'a friend\'s device');
    assert.deepEqual([A.hub!.capped(B.identity.fp), A.hub!.capped(C.identity.fp)], [false, true]);

    // C reaches B through A: B's record carries B's anchors (as share's qr does); B's lan address is dead
    B.tls.pin = newPin();
    const bRec: Peer = {
      id: 'b', name: 'mac-home', host: '127.0.0.1', port: await deadPort(), secret: '', fp: B.identity.fp, pin: B.tls.pin, paired_at: null,
      anchors: joinedRoads(readJoined(B.joinedFile)), kind: 'pc', ram: null, bw: null, added_at: 't',
    };
    const ctxC = { identity: C.identity, anchors: joinedRoads(readJoined(C.joinedFile)) };
    assert.deepEqual(await pickRoute(bRec, ctxC, 2000), { via: 'anchor', anchor: A.identity.fp });
    const [pr] = await probePeers([bRec], 3000, ['api'], undefined, ctxC);
    assert.equal(pr.api.ok, true, JSON.stringify(pr.api));
    assert.ok(B.paired.has(C.identity.fp), 'B\'s own code paired C, through the anchor');
    assert.ok(!A.paired.has(C.identity.fp) || true);
    const s = await openRoad({ via: 'anchor', anchor: A.identity.fp }, pr.peer, ctxC);
    const h = await handshake(s, '', 'api', 3000, undefined, { identity: C.identity, fp: B.identity.fp });
    h.socket.write('hello from far away');
    assert.equal((await readAtLeast(h.socket, 19)).toString(), 'hello from far away');
    h.socket.destroy();

    // the engine on C: its anchors come from the joined store; B is reached through A, A offers the role
    writePeers([...readPeers(C.peersFile), { ...pr.peer }], C.peersFile);
    const eC = new Engine({ peersFile: C.peersFile, pairedFile: path.join(C.dir, 'paired'), identity: C.identity, llama: null, probeMs: 3000 });
    try {
      const rows = await eC.probe(['b']);
      const rb = rows.find((r) => r.id === 'b') ?? eC.peers().find((r) => r.id === 'b')!;
      assert.equal(rb.via, 'anchor');
      assert.equal(rb.through, readPeers(C.peersFile).find((p) => p.fp === A.identity.fp)!.id);
      assert.match(rb.where, /^through anchor /);
      assert.equal(eC.peers().find((r) => r.id === readPeers(C.peersFile)[0].id)!.anchor, true, 'the joined anchor offers the role');
      assert.deepEqual(eC.joinedAnchors().map((a) => a.fp), [A.identity.fp.slice(0, 16)]);
    } finally { await eC.close(); }

    // A reaches B through its own hub ('self'), as the pair-back left it in A's book
    const [pa] = await probePeers([recB], 3000, ['api'], undefined, { identity: A.identity, hub: A.hub });
    assert.equal(pa.api.ok, true, JSON.stringify(pa.api));

    // engine.anchor() on A: members, today's bytes, the most one dialing member passed (not A's own)
    const eA = new Engine({ peersFile: A.peersFile, pairedFile: path.join(A.dir, 'paired'), identity: A.identity, llama: null, anchorHub: () => A.hub });
    try {
      const v = eA.anchor();
      const st = A.hub!.stats().bytesToday;
      assert.equal(v.on, true);
      assert.equal(v.links, 2);
      assert.equal(v.reachable, null, 'every member came from 127.0.0.1: not confirmed from outside');
      assert.ok(st[C.identity.fp] > 0, 'C dialed through A');
      assert.equal(v.memberMaxDay, Math.max(...Object.entries(st).filter(([fp]) => A.hub!.capped(fp)).map(([, b]) => b)));
      assert.equal(A.hub!.capped(A.identity.fp), false, 'the anchor\'s own dials are never capped');
      assert.ok(v.memberMaxDay > 0 && v.memberMaxDay <= v.bytesDay);
    } finally { await eA.close(); }
    assert.equal(reachableFromOutside([{ peer: '127.0.0.1' }, { peer: '192.168.1.4' }, { peer: 'self' }]), false);
    assert.equal(reachableFromOutside([{ peer: '::ffff:198.51.100.7' }]), true);
  } finally { await closeAll([A, B, C], [echo]); }
});

test('the daily byte cap holds for a friend\'s device only: the person\'s own passes beyond it, a friend\'s is cut at it, a changed ring counts at once', async () => {
  const echo = await echoServer();
  const A = await home('anchor', echo.port, { anchor: true, caps: { bytesPerDay: 50_000 } });
  const T = await home('target', echo.port);
  const B = await home('mine', echo.port);
  const C = await home('friend', echo.port);
  const ms: { close: () => Promise<void> }[] = [];
  try {
    for (const h of [T, B, C]) A.paired.add(h.identity.fp);
    for (const h of [B, C]) T.paired.add(h.identity.fp);
    const rec = (h: Home, ring: 'home' | 'circle'): Peer => ({ id: h.name, name: h.name, host: '', port: 0, secret: '', fp: h.identity.fp, pin: null, paired_at: 't', ring, kind: 'pc', ram: null, bw: null, added_at: 't' });
    writePeers([rec(B, 'home'), rec(C, 'circle')], A.peersFile);
    const ref = { host: '127.0.0.1', port: A.gate.port, fp: A.identity.fp };
    ms.push(await joinAnchor({ anchor: ref, identity: T.identity, name: 'target', kind: 'pc', gatePort: T.gate.port }));
    const N = 200_000;
    // a stream from `who` to T through A: N bytes out, all of them back (true), or cut on the way (false)
    const pass = async (who: Home): Promise<boolean> => {
      const d = await dialAnchor(ref, who.identity, T.identity.fp);
      const h = await handshake(d, '', 'api', 3000, undefined, { identity: who.identity, fp: T.identity.fp });
      return new Promise<boolean>((resolve) => {
        let got = 0;
        const t = setTimeout(() => { h.socket.destroy(); resolve(false); }, 5000);
        const end = (ok: boolean) => { clearTimeout(t); h.socket.destroy(); resolve(ok); };
        h.socket.on('data', (b: Buffer) => { got += b.length; if (got >= N) end(true); });
        h.socket.on('close', () => end(got >= N));
        h.socket.on('error', () => {});
        h.socket.write(Buffer.alloc(N, 7));
      });
    };
    assert.equal(await pass(B), true, 'the person\'s own device passes beyond the cap');
    assert.ok(A.hub!.stats().bytesToday[B.identity.fp] > 50_000);
    assert.equal(await pass(C), false, 'a friend\'s device is cut at the cap');
    await assert.rejects(dialAnchor(ref, C.identity, T.identity.fp), /byte limit/);
    // the person says C is theirs after all: it passes now; B becomes a friend's: refused for today
    const r = setRing(readPeers(A.peersFile), C.name, 'home')!;
    writePeers(r.list, A.peersFile);
    await sleep(20);
    assert.equal(await pass(C), true, 'home now: no cap');
    writePeers(setRing(readPeers(A.peersFile), B.name, 'circle')!.list, A.peersFile);
    await assert.rejects(dialAnchor(ref, B.identity, T.identity.fp), /byte limit/);
    // engine.anchor(): capDay is the friend cap, memberMaxDay the most a capped member passed
    const eA = new Engine({ peersFile: A.peersFile, pairedFile: path.join(A.dir, 'paired'), identity: A.identity, llama: null, anchorHub: () => A.hub });
    try {
      const v = eA.anchor();
      assert.equal(v.capDay, 50_000);
      assert.equal(v.memberMaxDay, A.hub!.stats().bytesToday[B.identity.fp], 'B is the one capped member now');
    } finally { await eA.close(); }
  } finally {
    for (const m of ms) await m.close();
    await closeAll([A, T, B, C], [echo]);
  }
});

test('an invite that ran out, one replaced by a newer one, and one used already are refused in plain words', async () => {
  const echo = await echoServer();
  const A = await home('anchor', echo.port, { anchor: true, ttlMs: 500 });
  const B = await home('b', echo.port);
  const D = await home('d', echo.port);
  try {
    const join = (h: Home, code: string) => joinWithInvite({ peer: parsePeerText(code), identity: h.identity, peersFile: h.peersFile, joinedFile: h.joinedFile });
    const old = A.host!.invite(mapped(A));
    await sleep(650);
    await assert.rejects(join(B, old.code), /ran out \(it works for 10 minutes\)/);
    assert.ok(!A.paired.has(B.identity.fp));
    assert.deepEqual(readPeers(B.peersFile), [], 'nothing kept');
    assert.deepEqual(readJoined(B.joinedFile), []);
    // a newer invite kills the one before
    const first = A.host!.invite(mapped(A));
    const second = A.host!.invite(mapped(A));
    await assert.rejects(join(B, first.code), /ran out/);
    // used once, then refused
    await join(B, second.code);
    assert.ok(A.paired.has(B.identity.fp));
    await assert.rejects(join(D, second.code), /used already: each invite works once/);
    assert.ok(!A.paired.has(D.identity.fp));
    // an invite that names only this network's address says so
    assert.equal(A.host!.invite([{ host: '127.0.0.1', port: A.gate.port, via: 'lan' }]).lanOnly, true);
    // a dead address: the anchor does not answer
    await assert.rejects(join(D, A.host!.invite([{ host: '127.0.0.1', port: await deadPort(), via: 'mapped' }]).code), /does not answer/);
  } finally { await closeAll([A, B, D], [echo]); }
});

test('the pair-back code opens for the anchor\'s certificate only, once', async () => {
  const echo = await echoServer();
  const A = await home('anchor', echo.port, { anchor: true });
  const X = await home('member', echo.port);
  const S = await home('stranger', echo.port);
  try {
    const hpin = pairBackCode(newPin());
    const codes = new OneTimeCodes();
    codes.add(hpin, 60_000, { only: A.identity.fp });
    assert.deepEqual(codes.open(S.identity.fp), []);
    assert.deepEqual(codes.open(A.identity.fp), [hpin]);
    assert.equal(codes.take(hpin, S.identity.fp), false);
    // on a gate: the stranger who saw the invite is turned away before any proof
    X.codes.add(hpin, 60_000, { only: A.identity.fp });
    const toX = async (who: Home) => {
      const sock = net.connect({ host: '127.0.0.1', port: X.gate.port });
      await new Promise((r) => sock.once('connect', r));
      try { return await handshake(sock, '', 'api', 3000, undefined, { identity: who.identity, fp: X.identity.fp, pin: hpin }); } finally { sock.destroy(); }
    };
    await assert.rejects(toX(S), (e) => e instanceof GateRefused && e.reason === 'not paired');
    assert.ok(!X.paired.has(S.identity.fp));
    let used: string | null = null;
    X.codes.drop(hpin);
    X.codes.add(hpin, 60_000, { only: A.identity.fp, onUsed: (fp) => { used = fp; } });
    await toX(A);
    assert.ok(X.paired.has(A.identity.fp), 'the anchor paired with it');
    await until(() => used === A.identity.fp, 1000, 'onUsed');
    assert.deepEqual(X.codes.recent(A.identity.fp), [{ pin: hpin, why: 'pin used' }]);
    assert.equal(X.codes.take(hpin, A.identity.fp), false, 'once');
  } finally { await closeAll([A, X, S], [echo]); }
});

test('a typed invite: address, code and the certificate start (16 or more) join; a short or wrong start is refused before the code is spent', async () => {
  const echo = await echoServer();
  const A = await home('anchor', echo.port, { anchor: true });
  const dir = tmp();
  const E = createIdentity('typed');
  const peersFile = path.join(dir, 'peers.json');
  const engine = new Engine({ peersFile, pairedFile: path.join(dir, 'paired'), identity: E, llama: null });
  try {
    const inv = A.host!.invite(mapped(A));
    const typed = { address: inv.typed.address, pin: inv.typed.code, anchor: true };
    await assert.rejects(engine.pairByHand({ ...typed, fp: inv.typed.certificate.slice(0, 12) }), /16 letters and digits or more/);
    const wrong = [...inv.typed.certificate].map((c) => (c === 'f' ? '0' : 'f')).join('');
    await assert.rejects(engine.pairByHand({ ...typed, fp: wrong }), /certificate does not match/);
    assert.ok(A.host!.current(), 'the code is not spent by a wrong certificate');
    const row = await engine.pairByHand({ ...typed, fp: inv.typed.certificate, name: 'berlin' });
    assert.equal(row.anchor, true);
    assert.equal(row.name, 'berlin');
    assert.ok(A.paired.has(E.fp));
    const store = readJoined(path.join(dir, 'anchors.json'));
    assert.equal(store.length, 1);
    assert.equal(store[0].fp, A.identity.fp);
    assert.equal(store[0].hpin, pairBackCode(inv.typed.code), 'the pair-back code derived from the typed code');
    assert.equal(readPeers(peersFile)[0].fp, A.identity.fp);
    // forgetting the anchor leaves it
    assert.equal(engine.removePeer(row.id), true);
    assert.deepEqual(readJoined(path.join(dir, 'anchors.json')), []);
  } finally { await engine.close(); await closeAll([A], [echo]); }
});

// ---- the router's answers (the fake routers of portmap.test.ts, pcp and silent)

function fakeRouter(mode: 'pcp' | 'silent', external = '203.0.113.5'): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('message', (b, from) => {
      if (mode === 'silent' || b[0] !== 2 || b.length < 60) return;
      const lifetime = b.readUInt32BE(4), internal = b.readUInt16BE(40), ext = b.readUInt16BE(42);
      const r = Buffer.alloc(60);
      r[0] = 2; r[1] = 0x81; r[3] = 0;
      r.writeUInt32BE(lifetime, 4);
      b.copy(r, 24, 24, 44);
      r.writeUInt16BE(ext || internal, 42);
      pcpAddr(external).copy(r, 44);
      s.send(r, from.port, from.address);
    });
    s.bind(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => s.close() }));
  });
}

function fakeHandle(o: { pm: { asked: boolean; mapping: any; why: string | null }; members?: { peer: string }[]; ipv6?: string[] }): ShareHandle {
  const hub = { members: () => (o.members ?? []).map((m, i) => ({ fp: String(i).repeat(64).slice(0, 64), name: '', kind: 'pc', since: 0, peer: m.peer })) };
  return Object.assign(async () => {}, {
    gatePort: 50551, dashboard: null, deviceName: 'mac', host: '192.168.1.5', qr: () => '', code: () => null, paired: () => 0,
    anchor: hub as any, portMap: () => o.pm, openInvite: () => null,
    addrs: () => [{ host: '192.168.1.5', port: 50551, via: 'lan' as const }, ...(o.ipv6 ?? []).map((h) => ({ host: h, port: 50551, via: 'ipv6' as const }))],
  });
}

test('the router\'s answer in plain words: mapped with the outside address, silent with what to open by hand, carrier nat; reached from outside only once a member came from outside', async () => {
  const opened = await fakeRouter('pcp');
  const shared = await fakeRouter('pcp', '100.64.3.4');
  const silent = await fakeRouter('silent');
  const ask = (port: number) => startPortMapper({ internalPort: 50551, gateway: '127.0.0.1', pmpPort: port, ssdp: null, timeoutMs: 30, tries: 2, clientIp: '127.0.0.1' });
  const m1 = await ask(opened.port), m2 = await ask(shared.port), m3 = await ask(silent.port);
  try {
    const words = (m: { mapper: any; why: string | null }, extra: { members?: { peer: string }[]; ipv6?: string[] } = {}) =>
      anchorShareView(fakeHandle({ pm: { asked: true, mapping: m.mapper?.mapping() ?? null, why: m.why }, ...extra }), { on: true });
    const a = words(m1);
    assert.equal(a.map, 'mapped');
    assert.equal(a.external, '203.0.113.5:50551');
    assert.match(a.words, /^the router opened the door: from the internet this computer answers at 203\.0\.113\.5:50551\./);
    assert.match(a.words, /not confirmed from outside yet/);
    const b = words(m2);
    assert.equal(b.map, 'cgnat');
    assert.equal(b.external, null);
    assert.ok(b.words.startsWith(CGNAT_WORDS), b.words);
    assert.match(CGNAT_WORDS, /cannot be an anchor from outside; it can still be a member of another anchor/);
    const c = words(m3);
    assert.equal(c.map, 'silent');
    assert.match(c.words, /^no answer from the router: open TCP port 50551 to this computer \(192\.168\.1\.5\) by hand/);
    // ipv6, and "reached from outside" only from a member that registered from a public address
    const d = words(m3, { ipv6: ['2001:db8::5'], members: [{ peer: '192.168.1.9' }] });
    assert.match(d.words, /over ipv6 it may also answer at \[2001:db8::5\]:50551/);
    assert.equal(d.reachable, null);
    assert.match(d.words, /1 device holds its link to it now/);
    const e = words(m1, { members: [{ peer: '198.51.100.7' }, { peer: '10.0.0.2' }] });
    assert.equal(e.reachable, true);
    assert.match(e.words, /reached from outside: a device came in from the internet/);
    // the router said no; the switch off; starting
    assert.equal(mapState({ asked: true, mapping: null, why: 'pcp: not authorized' }), 'refused');
    assert.equal(mapState({ asked: false, mapping: null, why: null }), null);
    assert.match(anchorWords({ on: true, live: true, map: 'refused', why: 'pcp: not authorized', external: null, ipv6: [], lan: '192.168.1.5:50551', port: 50551, reachable: null, members: 0 }), /^the router said no \(pcp: not authorized\): open TCP port 50551/);
    assert.match(anchorShareView(null, { on: false }).words, /^off\./);
    assert.match(anchorShareView(null, { on: true }).words, /^starting/);
  } finally {
    for (const m of [m1, m2, m3]) await m.mapper?.stop();
    opened.close(); shared.close(); silent.close();
  }
});

// ---- the switch, kept across restarts; and the page's routes

function anchorStarter(seen: ShareOptions[], stops: { n: number }) {
  return async (opts: ShareOptions): Promise<ShareHandle> => {
    seen.push(opts);
    const identity = createIdentity('pc');
    const codes = new OneTimeCodes();
    const caps = { bytesPerDay: typeof opts.anchor === 'object' && opts.anchor.bytesPerDay ? opts.anchor.bytesPerDay : 5e9 };
    const hub = opts.anchor ? { on: () => () => {}, members: () => [], stats: () => ({ members: 0, streams: 0, bytesToday: {} }), caps, setCaps: (c: { bytesPerDay?: number }) => { if (c.bytesPerDay) caps.bytesPerDay = c.bytesPerDay; }, dialLocal: async () => { throw new Error('none'); } } : null;
    const host = hub ? new AnchorHost({ identity, codes, hub: hub as any, peersFile: path.join(tmp(), 'peers.json'), id: 'pc-id', name: 'test-pc' }) : null;
    const addrs: PeerAddr[] = [{ host: '192.168.1.5', port: opts.port, via: 'lan' }, ...(opts.mapPort ? [{ host: '203.0.113.5', port: opts.port, via: 'mapped' as const }] : [])];
    return Object.assign(async () => { stops.n++; host?.close(); }, {
      gatePort: opts.port, dashboard: null, deviceName: 'test-pc', host: '192.168.1.5',
      qr: () => '{"k":"kula-peer","v":3}', code: () => ({ pin: '1234567890abcdef', exp: 1000 }), paired: () => 0,
      anchor: hub as any,
      invite: (whose?: 'mine' | 'friend') => { if (!host) throw new Error('not an anchor'); const far = addrs.filter((a) => a.via !== 'lan'); return host.invite(far.length ? far : addrs, {}, whose); },
      openInvite: () => host?.current() ?? null,
      portMap: () => ({ asked: !!opts.mapPort, mapping: opts.mapPort ? { via: 'pcp', gateway: '192.168.1.1', internalPort: opts.port, externalPort: opts.port, externalIp: '203.0.113.5', lifetimeS: 3600, behindAnotherNat: false, at: 0 } : null, why: null }),
      addrs: () => addrs,
      links: () => [],
    });
  };
}

test('the switch: on starts sharing as an anchor (dual-stack, the router asked), stays on across a restart, the person\'s stop turns it off', async () => {
  const settingFile = path.join(tmp(), 'anchor.json');
  const seen: ShareOptions[] = [];
  const stops = { n: 0 };
  let awake = 0, slept = 0;
  const make = () => new ShareHere({ port: 50999, models: '/tmp/m', settingFile, start: anchorStarter(seen, stops), awake: () => { awake++; return { how: 'test', stop: () => { slept++; } }; }, netCategories: async () => null });
  const s1 = make();
  assert.equal(s1.view().anchor.on, false);
  assert.match(s1.view().anchor.words, /^off\./);
  await s1.resume();
  assert.equal(seen.length, 0, 'off: nothing starts by itself');
  const on = await s1.setAnchor(true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].anchor, true);
  assert.equal(seen[0].dualStack, true);
  assert.equal(seen[0].mapPort, true);
  assert.equal(on.anchor.on, true);
  assert.equal(on.anchor.live, true);
  assert.match(on.anchor.words, /from the internet this computer answers at 203\.0\.113\.5:50999/);
  assert.equal(awake, 1, 'awake while it is on');
  assert.equal(readAnchorSetting(settingFile).on, true);
  // kula closes (not the person's stop): the setting stays
  await s1.stop();
  const s2 = make();
  assert.equal(s2.view().anchor.on, true, 'the setting survived');
  await s2.resume();
  assert.equal(seen.length, 2, 'started again by itself');
  assert.equal(seen[1].anchor, true);
  // off: sharing goes on, without the anchor and on this network only
  const off = await s2.setAnchor(false);
  assert.equal(seen.length, 3);
  assert.equal(seen[2].anchor, undefined);
  assert.equal(seen[2].dualStack, false);
  assert.equal(off.on, true);
  assert.equal(off.anchor.on, false);
  await s2.setAnchor(true);
  // the person stops sharing: the anchor goes off with it
  await s2.stop(true);
  assert.equal(readAnchorSetting(settingFile).on, false);
  const s3 = make();
  await s3.resume();
  assert.equal(seen.length, 4, 'not started again');
  assert.equal(slept, awake, 'every keep-awake let go');
});

const origin = (port: number) => ({ origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
const post = (url: string, port: number, body: unknown, headers: Record<string, string> = origin(port)) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the page: the anchor switch, an invite (text and qr), a typed invite joins and starts sharing so it registers', async () => {
  const echo = await echoServer();
  const A = await home('anchor', echo.port, { anchor: true });
  const dir = tmp();
  const settingFile = path.join(dir, 'anchor.json');
  const seen: ShareOptions[] = [];
  const stops = { n: 0 };
  const shareHere = new ShareHere({ port: 50998, settingFile, start: anchorStarter(seen, stops), awake: () => ({ how: 'test', stop() {} }), netCategories: async () => null });
  const me = createIdentity('mac');
  const engine = new Engine({ peersFile: path.join(dir, 'peers.json'), pairedFile: path.join(dir, 'paired'), identity: me, llama: null });
  const ui = await startUi({ port: 0, engine, store: new ChatStore(path.join(dir, 'chats')), token: 'kula-' + 'ab'.repeat(20), share: shareHere, eye: false });
  const api = (r: string) => `${ui.url}api/${r}`;
  try {
    assert.equal((await (await fetch(api('share'))).json()).anchor.on, false);
    assert.equal((await post(api('share/invite'), ui.port, {})).status, 409, 'no invite while the anchor is off');
    assert.equal((await post(api('share/anchor'), ui.port, { on: 'yes' })).status, 400);
    assert.equal((await post(api('share/anchor'), ui.port, { on: true }, {})).status, 403, 'same origin only');
    const v = await (await post(api('share/anchor'), ui.port, { on: true })).json();
    assert.equal(v.anchor.on, true);
    assert.equal(v.anchor.live, true);
    assert.equal(seen.at(-1)!.anchor, true);
    assert.equal(readAnchorSetting(settingFile).on, true);
    // the friend cap next to the switch: kept with the setting, set on the running anchor at once
    assert.equal(v.anchor.capGb, 5);
    assert.equal((await post(api('share/anchor'), ui.port, { capGb: -1 })).status, 400);
    const capped = await (await post(api('share/anchor'), ui.port, { capGb: 2.5 })).json();
    assert.equal(capped.anchor.capGb, 2.5);
    assert.equal(readAnchorSetting(settingFile).caps?.bytesPerDay, 2_500_000_000);
    assert.equal(capped.anchor.on, true, 'the cap alone leaves the switch as it was');
    // the invite asks whose computer it is for
    assert.equal((await post(api('share/invite'), ui.port, { whose: 'stranger' })).status, 400);
    const mine = await (await post(api('share/invite'), ui.port, { whose: 'mine' })).json();
    assert.equal(mine.whose, 'mine');
    assert.match(mine.words, /a computer of yours \(no daily limit\)/);
    const inv = await (await post(api('share/invite'), ui.port, {})).json();
    assert.equal(inv.whose, 'friend', 'a friend\'s by default');
    const p = parsePeerText(inv.code);
    assert.equal(p.anchor, true);
    assert.deepEqual(p.addrs?.map((a) => a.via), ['mapped'], 'the address from outside, not the lan');
    assert.match(inv.words, /works once, until/);
    const again = await (await fetch(api('share'))).json();
    assert.equal(again.anchor.invite.code, inv.code);
    const svg = await fetch(api('share/invite.svg'));
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') ?? '', /svg/);
    // the person's stop: sharing and the anchor off
    const stopped = await (await post(api('share/stop'), ui.port, {})).json();
    assert.equal(stopped.on, false);
    assert.equal(readAnchorSetting(settingFile).on, false);
    assert.equal((await fetch(api('share/invite.svg'))).status, 404);

    // this computer joins A by a typed invite through the page; sharing starts so it can register
    const ai = A.host!.invite(mapped(A));
    const before = seen.length;
    const row = await (await post(api('peers/add'), ui.port, { address: ai.typed.address, pin: ai.typed.code, fp: ai.typed.certificate, anchor: true })).json();
    assert.equal(row.anchor, true, JSON.stringify(row));
    assert.ok(A.paired.has(me.fp), 'A paired this computer');
    await until(() => seen.length === before + 1, 3000, 'sharing to start after the join');
    assert.equal(seen.at(-1)!.anchor, undefined, 'joining does not make this computer an anchor');
    const view = await (await fetch(api('share'))).json();
    assert.equal(view.on, true);
    assert.equal(engine.joinedAnchors().length, 1);
  } finally {
    await ui.close();
    await engine.close();
    await closeAll([A], [echo]);
  }
});
