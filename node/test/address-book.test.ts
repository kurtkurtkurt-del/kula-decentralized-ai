// The circle's address book and the second anchor (docs/ANCHOR.md "address book", stage 6). Gates
// on 127.0.0.1, each home with its own identity and files: anchors A and B, members M1 and M2
// registered with both (A is a member of B too: anchors learn each other). The members' own
// addresses are dead ports (behind a NAT), so they only meet through an anchor.
//
// - records go round: each node gives its signed record to its anchors, a member gives each anchor
//   the other's record, a member asks (`who`) and takes only what it pinned;
// - kill A: M1 still reaches M2, through B (the pick and a dialer that was on A);
// - A comes back on a new port: its new record reaches M1 and M2 through B, their joined store
//   and peer book follow, they register with A again and roads use A again; one note line says so;
// - a forged record (another key, a fingerprint not pinned), an older seq, and a record the anchor
//   changed on the way are refused.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-addrbook-home-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { startGateServer, handshake } = await import('../src/gate.ts');
type GateServer = import('../src/gate.ts').GateServer;
type TlsServer = import('../src/gate.ts').TlsServer;
const { createIdentity, Paired } = await import('../src/tls.ts');
type GateIdentity = import('../src/tls.ts').GateIdentity;
const { AnchorHub, circleMembers } = await import('../src/anchor.ts');
const { OneTimeCodes, AnchorLinks, readJoined, writeJoined, joinedRoads } = await import('../src/join.ts');
type JoinedAnchor = import('../src/join.ts').JoinedAnchor;
const { readPeers, writePeers, probePeers } = await import('../src/peers.ts');
type Peer = import('../src/peers.ts').Peer;
type PeerAddr = import('../src/peers.ts').PeerAddr;
const { pickRoute, openRoad, roadDialer } = await import('../src/road.ts');
const { AddressBook, readMoves } = await import('../src/addressbook.ts');
const { signRecord, checkRecord } = await import('../src/addrrecord.ts');
type AddrRecord = import('../src/addrrecord.ts').AddrRecord;
const { Engine } = await import('../src/ui/engine.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(f: () => boolean, ms = 8000, what = 'the condition'): Promise<void> {
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

const FAST = { burst: 10_000, perMinute: 600_000 };

interface Home {
  name: string; dir: string; identity: GateIdentity; paired: InstanceType<typeof Paired>; tls: TlsServer;
  gate: GateServer; hub: InstanceType<typeof AnchorHub> | null; book: InstanceType<typeof AddressBook>;
  peersFile: string; joinedFile: string; links: InstanceType<typeof AnchorLinks> | null; logs: string[];
}

// A home: its gate (the api goes to the echo server), its address book, an anchor hub when asked.
// `addrs`: where it says it answers (a member behind a NAT says a dead port). `again`: the same
// home (identity, files) started anew, on a new port.
async function home(name: string, echoPort: number, o: { anchor?: boolean; addrs?: PeerAddr[]; again?: Home; handOut?: (r: AddrRecord) => unknown } = {}): Promise<Home> {
  const dir = o.again?.dir ?? fs.mkdtempSync(path.join(HOME, `${name}-`));
  const identity = o.again?.identity ?? createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const tls: TlsServer = { identity, paired, pin: null, codes: new OneTimeCodes(), onPinUsed: () => {} };
  const peersFile = path.join(dir, 'peers.json');
  const joinedFile = path.join(dir, 'anchors.json');
  const h = { name, dir, identity, paired, tls, peersFile, joinedFile, links: null, logs: [] as string[] } as unknown as Home;
  h.book = new AddressBook({
    identity, peersFile, joinedFile, file: path.join(dir, 'addrbook.json'),
    addrs: () => o.addrs ?? [{ host: '127.0.0.1', port: h.gate.port, via: 'mapped' }],
    log: (s) => h.logs.push(s),
    allowLoopback: true,   // every home here answers on 127.0.0.1
  });
  h.hub = o.anchor ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, peersFile), record: () => h.book.own(), whoRate: FAST, handOut: o.handOut }) : null;
  h.gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echoPort, tls, anchor: h.hub ?? undefined });
  return h;
}

function link(h: Home) {
  h.links = new AnchorLinks({ identity: h.identity, name: h.name, kind: 'pc', gatePort: h.gate.port, file: h.joinedFile, codes: h.tls.codes as InstanceType<typeof OneTimeCodes>, retryMs: 100, pollMs: 100, book: h.book, bookMs: 150, log: (s) => h.logs.push(s) });
  h.links.start();
  return h.links;
}

async function stop(h: Home) {
  await h.links?.close();
  h.links = null;
  h.hub?.close();
  await h.gate.close();
}

const rec = (h: Home, o: Partial<Peer> = {}): Peer => ({
  id: `id-${h.name}`, name: h.name, host: '127.0.0.1', port: h.gate.port, secret: '', fp: h.identity.fp, pin: null, paired_at: 't',
  kind: 'pc', ram: null, bw: null, added_at: 't', ...o,
});
const joinedOf = (h: Home): JoinedAnchor => ({ fp: h.identity.fp, name: h.name, host: '127.0.0.1', port: h.gate.port, joined_at: 't' });

async function apiEcho(s: Duplex, me: Home, to: Home, text: string): Promise<string> {
  const h = await handshake(s, '', 'api', 3000, undefined, { identity: me.identity, fp: to.identity.fp });
  try {
    h.socket.write(text);
    return (await readAtLeast(h.socket, text.length)).toString();
  } finally { h.socket.destroy(); }
}

test('address book: records go round two anchors; kill A and M1 reaches M2 through B; A on a new port comes back through B and roads use it again', async () => {
  const echo = await echoServer();
  const lan1: PeerAddr = { host: '127.0.0.1', port: await deadPort(), via: 'lan' };
  const lan2: PeerAddr = { host: '127.0.0.1', port: await deadPort(), via: 'lan' };
  let A = await home('anchor-a', echo.port, { anchor: true });
  const B = await home('anchor-b', echo.port, { anchor: true });
  const M1 = await home('laptop-m1', echo.port, { addrs: [lan1] });
  const M2 = await home('phone-m2', echo.port, { addrs: [lan2] });
  let eM1: InstanceType<typeof Engine> | null = null;
  try {
    // membership as the invites leave it: B knows A, M1, M2; A knows M1, M2; M1 and M2 know each other
    for (const m of [A, M1, M2]) B.paired.add(m.identity.fp, m.name);
    for (const m of [M1, M2]) A.paired.add(m.identity.fp, m.name);
    M1.paired.add(M2.identity.fp); M2.paired.add(M1.identity.fp);
    // the peer books and the joined anchors: M1 and M2 joined A then B, A joined B
    writePeers([rec(A, { anchor: true }), rec(B, { anchor: true }), rec(M2, { port: lan2.port })], M1.peersFile);
    writePeers([rec(A, { anchor: true }), rec(B, { anchor: true }), rec(M1, { port: lan1.port })], M2.peersFile);
    writePeers([rec(B, { anchor: true })], A.peersFile);
    writeJoined([joinedOf(A), joinedOf(B)], M1.joinedFile);
    writeJoined([joinedOf(A), joinedOf(B)], M2.joinedFile);
    writeJoined([joinedOf(B)], A.joinedFile);
    const oldA = { host: '127.0.0.1', port: A.gate.port };
    link(A); link(M1); link(M2);

    // the records go round: each member holds the other's and both anchors'; each anchor carries
    // the other's (given by the members registered with both, and by A itself at B)
    await until(() => [A, B, M2].every((x) => M1.book.held(x.identity.fp)) && [A, B, M1].every((x) => M2.book.held(x.identity.fp)), 8000, 'the members to hold every record');
    await until(() => !!B.hub!.carried(A.identity.fp) && !!A.hub!.carried(B.identity.fp), 4000, 'each anchor to carry the other\'s record');
    assert.equal(A.book.held(B.identity.fp)?.fp, B.identity.fp, 'A, a member of B, holds B\'s record');
    const m2InM1 = readPeers(M1.peersFile).find((p) => p.fp === M2.identity.fp)!;
    assert.deepEqual(m2InM1.anchors?.map((a) => a.fp), [A.identity.fp, B.identity.fp], 'M2\'s record says where it registers: A, then B');
    assert.deepEqual(m2InM1.addrs, M2.book.own()!.addrs, 'and where it says it answers');
    assert.equal(readMoves(M1.book.file).length, 0, 'nothing moved: nothing to say');
    eM1 = new Engine({ peersFile: M1.peersFile, pairedFile: path.join(M1.dir, 'paired'), identity: M1.identity, llama: null, joinedFile: M1.joinedFile, probeMs: 3000 });
    const notesBefore = eM1.status().decisions.length;

    // M1 reaches M2: its own address is dead, A (first in its record) carries the stream
    const ctx = () => ({ identity: M1.identity, anchors: joinedRoads(readJoined(M1.joinedFile)) });
    const m2 = () => readPeers(M1.peersFile).find((p) => p.fp === M2.identity.fp)!;
    await until(() => A.hub!.members().some((m) => m.fp === M2.identity.fp) && B.hub!.members().some((m) => m.fp === M2.identity.fp), 4000, 'M2 registered at both');
    assert.deepEqual(await pickRoute(m2(), ctx(), 2000), { via: 'anchor', anchor: A.identity.fp });
    assert.equal(await apiEcho(await openRoad({ via: 'anchor', anchor: A.identity.fp }, m2(), ctx()), M1, M2, 'through A'), 'through A');

    // kill A: the pick falls to B; a dialer that was on A picks B for its next connection
    await stop(A);
    const t0 = Date.now();
    assert.deepEqual(await pickRoute(m2(), ctx(), 2000), { via: 'anchor', anchor: B.identity.fp }, 'A is down: the next anchor, B');
    assert.ok(Date.now() - t0 < 1500, `picked in ${Date.now() - t0} ms`);
    const dialer = roadDialer({ ...m2(), route: { via: 'anchor', anchor: A.identity.fp } }, ctx());
    assert.equal(await apiEcho(await dialer(), M1, M2, 'through B'), 'through B');
    assert.deepEqual(dialer.road(), { via: 'anchor', anchor: B.identity.fp });
    await until(() => M1.links!.view().find((v) => v.fp === A.identity.fp)?.state !== 'registered', 4000, 'M1 to see A gone');

    // A comes back on a new port (same certificate, same files): it registers with B and gives its
    // new record; M1 and M2 get it from B (`who`), check it, and follow it
    A = await home('anchor-a', echo.port, { anchor: true, again: A });
    assert.notEqual(A.gate.port, oldA.port, 'a new port');
    link(A);
    const atNew = (h: Home) => readJoined(h.joinedFile).find((a) => a.fp === A.identity.fp)?.port === A.gate.port;
    await until(() => atNew(M1) && atNew(M2), 8000, 'A\'s new address to reach M1 and M2 through B');
    const recA = M1.book.held(A.identity.fp)!;
    assert.deepEqual(recA.addrs, [{ host: '127.0.0.1', port: A.gate.port, via: 'mapped' }]);
    assert.ok(recA.seq > 0);
    // the move in one line, through B; the engine shows it once among its notes
    const moves = readMoves(M1.book.file);
    assert.equal(moves.length, 1, JSON.stringify(moves));
    assert.equal(moves[0].text, 'anchor-a moved: its new address came through anchor anchor-b');
    const notes = eM1.status().decisions.slice(notesBefore).map((d) => d.text);
    assert.deepEqual(notes.filter((t) => /moved/.test(t)), ['anchor-a moved: its new address came through anchor anchor-b']);
    assert.equal(eM1.status().decisions.filter((d) => /moved/.test(d.text)).length, 1, 'said once');
    // the peer book follows: A's own record, and A as M2's anchor
    assert.deepEqual(readPeers(M1.peersFile).find((p) => p.fp === A.identity.fp)!.addrs, recA.addrs);
    await until(() => m2().anchors?.find((a) => a.fp === A.identity.fp)?.port === A.gate.port, 4000, 'M2\'s anchor A at its new port in M1\'s book');

    // M1 and M2 register with A at its new address, and roads use A again
    await until(() => [M1, M2].every((m) => A.hub!.members().some((x) => x.fp === m.identity.fp)), 8000, 'M1 and M2 registered at the new A');
    await until(() => M1.links!.view().find((v) => v.fp === A.identity.fp)?.state === 'registered', 4000, 'M1\'s link to A');
    assert.deepEqual(await pickRoute(m2(), ctx(), 2000), { via: 'anchor', anchor: A.identity.fp }, 'A first again');
    assert.equal(await apiEcho(await openRoad({ via: 'anchor', anchor: A.identity.fp }, m2(), ctx()), M1, M2, 'A again'), 'A again');
    assert.ok(M1.logs.some((l) => /anchor anchor-a: its address changed/.test(l)), M1.logs.join('\n'));
  } finally {
    await eM1?.close();
    for (const h of [M1, M2, A, B]) await stop(h).catch(() => {});
    echo.close();
  }
});

test('address book: a forged record (another key, a fingerprint not pinned) and an older seq are refused; a record cannot be changed on the way', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'unit-'));
  const me = createIdentity('me');
  const P = createIdentity('pinned');
  const S = createIdentity('stranger');
  const peersFile = path.join(dir, 'peers.json');
  const joinedFile = path.join(dir, 'anchors.json');
  writePeers([{ id: 'p', name: 'pinned', host: '192.168.1.9', port: 50551, secret: '', fp: P.fp, kind: 'pc', ram: null, bw: null, added_at: 't' }], peersFile);
  const book = new AddressBook({ identity: me, peersFile, joinedFile, file: path.join(dir, 'addrbook.json'), addrs: () => [] });
  const body = (port: number, seq: number) => ({ addrs: [{ host: '198.51.100.7', port, via: 'mapped' as const }], anchors: [], seq, at: seq });
  const ok = signRecord(P, body(40000, 10));

  // a record whole and signed by P is taken; the peer book follows
  assert.deepEqual(book.accept(ok, null), { ok: true, moved: 'pinned moved: it said its new address itself' });
  assert.deepEqual(readPeers(peersFile)[0].addrs, [{ host: '198.51.100.7', port: 40000, via: 'mapped' }]);
  // the same seq again, and an older one: not newer
  assert.deepEqual(book.accept(ok, null), { ok: false, why: 'not newer' });
  assert.deepEqual(book.accept(signRecord(P, body(40001, 9)), null), { ok: false, why: 'not newer' });
  // a stranger's record, well signed, for a fingerprint this computer never pinned
  assert.deepEqual(book.accept(signRecord(S, body(40002, 11)), null), { ok: false, why: 'not pinned here' });
  // the stranger claims P's fingerprint with its own certificate: the certificate is not that fingerprint
  const claim = { ...signRecord(S, body(40003, 12)), fp: P.fp };
  assert.deepEqual(book.accept(claim, null), { ok: false, why: 'the certificate is not that fingerprint' });
  // the stranger puts P's certificate in and signs with its own key: the signature fails
  const borrowed = { ...signRecord(S, body(40004, 13)), fp: P.fp, cert: P.certDer.toString('base64') };
  assert.deepEqual(book.accept(borrowed, null), { ok: false, why: 'bad signature' });
  // an anchor changes a newer record of P on the way: its address, its anchors, its seq
  const newer = signRecord(P, body(40005, 20));
  assert.deepEqual(book.accept({ ...newer, addrs: [{ host: '203.0.113.66', port: 40005, via: 'mapped' }] }, null), { ok: false, why: 'bad signature' });
  assert.deepEqual(book.accept({ ...newer, anchors: [{ fp: S.fp, host: '203.0.113.66', port: 1 }] }, null), { ok: false, why: 'bad signature' });
  assert.deepEqual(book.accept({ ...ok, seq: 99 }, null), { ok: false, why: 'bad signature' });
  // nothing of it was taken: the last good record stands
  assert.equal(book.held(P.fp)!.seq, 10);
  assert.deepEqual(readPeers(peersFile)[0].addrs, [{ host: '198.51.100.7', port: 40000, via: 'mapped' }]);
  // this computer's own record from someone else is not taken; a newer good one is
  assert.equal(book.accept(signRecord(me, body(1, 50)), null).ok, false);
  assert.equal(book.accept(newer, 'f'.repeat(64)).ok, true);
  // extra fields and another key order change nothing: the signed text is fixed
  const shuffled = JSON.parse(JSON.stringify({ sig: newer.sig, extra: 1, ...newer }));
  assert.equal(checkRecord(shuffled).ok, true);
  assert.ok(!('extra' in (checkRecord(shuffled) as { rec: object }).rec));
});

test('address book: a forgotten device leaves it; its addresses are gone from addrbook.json at the next ask and at start', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'forget-'));
  const me = createIdentity('me');
  const P = createIdentity('kept');
  const Q = createIdentity('forgotten');
  const R = createIdentity('forgotten-anchor');
  const peersFile = path.join(dir, 'peers.json');
  const joinedFile = path.join(dir, 'anchors.json');
  const file = path.join(dir, 'addrbook.json');
  const peer = (id: string, fp: string, host: string): Peer => ({ id, name: id, host, port: 50551, secret: '', fp, kind: 'pc', ram: null, bw: null, added_at: 't' });
  writePeers([peer('kept', P.fp, '192.168.1.9'), peer('forgotten', Q.fp, '192.168.1.10')], peersFile);
  writeJoined([{ fp: R.fp, name: 'forgotten-anchor', host: '192.168.1.11', port: 50551, joined_at: 't' }], joinedFile);
  const book = new AddressBook({ identity: me, peersFile, joinedFile, file, addrs: () => [] });
  const at = (host: string, port: number, seq: number) => ({ addrs: [{ host: '10.0.0.5', port, via: 'lan' as const }, { host, port, via: 'mapped' as const }], anchors: [], seq, at: seq });
  assert.equal(book.accept(signRecord(P, at('198.51.100.7', 40000, 10)), null).ok, true);
  assert.equal(book.accept(signRecord(Q, at('198.51.100.8', 40001, 10)), null).ok, true);
  assert.equal(book.accept(signRecord(R, at('198.51.100.9', 40002, 10)), null).ok, true);
  assert.ok(fs.readFileSync(file, 'utf8').includes('198.51.100.8'));

  // Q is forgotten (its peer row goes): the next ask drops its record and its move line, on disk too
  writePeers(readPeers(peersFile).filter((p) => p.fp !== Q.fp), peersFile);
  assert.deepEqual(book.wants().map((w) => w.fp).sort(), [P.fp, R.fp].sort());
  assert.equal(book.held(Q.fp), null);
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes('198.51.100.8') && !disk.includes(Q.fp), 'Q\'s addresses are gone from addrbook.json');
  assert.ok(disk.includes('198.51.100.7') && disk.includes('198.51.100.9'), 'the others stay');
  assert.ok(readMoves(file).every((m) => m.fp !== Q.fp));
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');

  // the anchor R is left while kula-node is not running: the book drops it when it starts again
  writeJoined([], joinedFile);
  new AddressBook({ identity: me, peersFile, joinedFile, file, addrs: () => [] });
  const later = fs.readFileSync(file, 'utf8');
  assert.ok(!later.includes('198.51.100.9') && !later.includes(R.fp), 'R\'s addresses are gone at start');
  assert.equal(book.held(P.fp)!.seq, 10, 'what is still pinned stays');
  // a forgotten device's record handed over again is not taken back
  assert.deepEqual(book.accept(signRecord(Q, at('198.51.100.8', 40001, 11)), null), { ok: false, why: 'not pinned here' });
});

// Security read F1: a pinned device (or a copied key) signs a record naming this computer's own
// loopback; taken, every probe round would dial it there, a slow port scan from outside.
test('address book: a record naming loopback, an unspecified, link-local or multicast address is refused whole and nothing is dialed there; a lan address is still taken', async (t) => {
  const dir = fs.mkdtempSync(path.join(HOME, 'undialable-'));
  let hits = 0;
  const srv = net.createServer((s) => { hits++; s.destroy(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const L = (srv.address() as net.AddressInfo).port;
  const me = createIdentity('me');
  const B = createIdentity('b');
  const peersFile = path.join(dir, 'peers.json');
  const joinedFile = path.join(dir, 'anchors.json');
  writePeers([{ id: 'b', name: 'b', host: '127.0.0.1', port: await deadPort(), secret: '', fp: B.fp, kind: 'pc', ram: null, bw: null, added_at: 't' }], peersFile);
  const book = new AddressBook({ identity: me, peersFile, joinedFile, file: path.join(dir, 'addrbook.json'), addrs: () => [] });
  const refused = { ok: false, why: 'an address this computer must not dial' };
  let seq = Date.now();
  try {
    const r = book.accept(signRecord(B, { addrs: [{ host: '127.0.0.1', port: L, via: 'mapped' }], anchors: [{ fp: 'ab'.repeat(32), host: '127.0.0.1', port: L }], seq, at: seq }), null);
    await probePeers(readPeers(peersFile), 1000, ['api'], undefined, me);
    t.diagnostic(`probe: ok=${r.ok} hits=${hits}`);
    assert.deepEqual(r, refused);
    assert.equal(book.held(B.fp), null);
    const b = readPeers(peersFile)[0];
    assert.equal(b.addrs, undefined, 'the peer book gains no addrs');
    assert.equal(b.anchors, undefined, 'nor anchors');
    assert.equal(hits, 0, 'nothing dialed the listener');

    // every other form, as an address and as an anchor
    for (const host of ['::1', '0.0.0.0', '169.254.1.1', '224.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::', 'fe80::1', 'ff02::1']) {
      seq++;
      assert.deepEqual(book.accept(signRecord(B, { addrs: [{ host, port: 40000, via: 'mapped' }], anchors: [], seq, at: seq }), null), refused, host);
      assert.deepEqual(book.accept(signRecord(B, { addrs: [{ host: '198.51.100.7', port: 40000, via: 'mapped' }], anchors: [{ fp: 'ab'.repeat(32), host, port: 40000 }], seq, at: seq }), null), refused, `${host} as an anchor`);
    }
    assert.equal(book.held(B.fp), null);

    // a lan address is still taken
    seq++;
    assert.equal(book.accept(signRecord(B, { addrs: [{ host: '192.168.1.7', port: 40000, via: 'lan' }], anchors: [], seq, at: seq }), null).ok, true);
    assert.deepEqual(readPeers(peersFile)[0].addrs, [{ host: '192.168.1.7', port: 40000, via: 'lan' }]);
  } finally { srv.close(); }
});

// Security read F4: a peer book (or joined store) that cannot be read is not an empty one; read
// as empty, the prune would wipe every record and its seq floor, and an anchor could hand an old
// record back.
test('address book: a peer book that cannot be read leaves the book as it is; nothing is asked or taken until it can', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'unreadable-'));
  const me = createIdentity('me');
  const B = createIdentity('b');
  const peersFile = path.join(dir, 'peers.json');
  const joinedFile = path.join(dir, 'anchors.json');
  const file = path.join(dir, 'addrbook.json');
  writePeers([{ id: 'b', name: 'b', host: '192.168.1.9', port: 50551, secret: '', fp: B.fp, kind: 'pc', ram: null, bw: null, added_at: 't' }], peersFile);
  const logs: string[] = [];
  const book = new AddressBook({ identity: me, peersFile, joinedFile, file, addrs: () => [], log: (s) => logs.push(s) });
  const body = (seq: number) => ({ addrs: [{ host: '198.51.100.7', port: 40000 + seq, via: 'mapped' as const }], anchors: [], seq, at: seq });
  assert.equal(book.accept(signRecord(B, body(10)), null).ok, true);
  const saved = fs.readFileSync(peersFile, 'utf8');
  const broken = { ok: false, why: 'the peer book could not be read' };

  for (const [f, bad] of [[peersFile, '{'], [peersFile, '{}'], [joinedFile, '[1,']] as const) {
    fs.writeFileSync(f, bad);
    try {
      assert.deepEqual(book.wants(), [], `${path.basename(f)} = ${bad}: nothing asked`);
      assert.equal(book.held(B.fp)?.seq, 10, 'the record stays');
      assert.equal(book.prune(), 0);
      new AddressBook({ identity: me, peersFile, joinedFile, file, addrs: () => [] });
      assert.equal(book.held(B.fp)?.seq, 10, 'and stays at start');
      assert.deepEqual(book.accept(signRecord(B, body(11)), null), broken);
      assert.equal(book.held(B.fp)?.seq, 10);
    } finally {
      if (f === peersFile) fs.writeFileSync(peersFile, saved); else fs.rmSync(joinedFile);
    }
    assert.deepEqual(book.wants(), [{ fp: B.fp, seq: 10 }], 'readable again: asked with the kept seq');
  }
  assert.equal(logs.filter((l) => /could not be read/.test(l)).length, 3, `once each time it broke: ${logs.join(' | ')}`);
  // readable again (and the joined store absent, which is empty): the floor holds, a newer one is taken
  assert.equal(book.held(B.fp)?.seq, 10);
  assert.deepEqual(book.wants(), [{ fp: B.fp, seq: 10 }]);
  assert.deepEqual(book.accept(signRecord(B, body(9)), null), { ok: false, why: 'not newer' });
  assert.equal(book.accept(signRecord(B, body(12)), null).ok, true);
});

// The person's decision (17 Nov): a friend's (circle) device's private addresses are not kept
// here; the person's own (home) devices keep them. By address class, not only by the record's own
// `via` label, which the friend chooses. Loopback is F1's rule and is left alone.
const friendBody = (seq: number) => ({
  addrs: [
    { host: '192.168.1.9', port: 50551, via: 'lan' as const },
    { host: '203.0.113.5', port: 40000, via: 'mapped' as const },
    { host: '10.0.0.3', port: 40001, via: 'mapped' as const },
    { host: 'fd00::1', port: 40002, via: 'ipv6' as const },
  ],
  anchors: [{ fp: 'ab'.repeat(32), host: '192.168.1.20', port: 50551 }],
  seq, at: seq,
});
const friendFiles = (tag: string, ring: 'home' | 'circle') => {
  const dir = fs.mkdtempSync(path.join(HOME, `${tag}-`));
  const me = createIdentity('me');
  const B = createIdentity('b');
  const peersFile = path.join(dir, 'peers.json');
  const joinedFile = path.join(dir, 'anchors.json');
  const file = path.join(dir, 'addrbook.json');
  writePeers([{ id: 'b', name: 'b', host: '192.168.1.9', port: 50551, secret: '', fp: B.fp, kind: 'pc', ram: null, bw: null, added_at: 't', ring }], peersFile);
  return { me, B, peersFile, joinedFile, file };
};
const setRingOf = (peersFile: string, fp: string, ring: 'home' | 'circle') => writePeers(readPeers(peersFile).map((p) => (p.fp === fp ? { ...p, ring } : p)), peersFile);

test('address book: a friend\'s (circle) device keeps no private address from its record, whatever the record calls it; its anchors at private addresses go too', () => {
  const { me, B, peersFile, joinedFile, file } = friendFiles('friend-lan', 'circle');
  const book = new AddressBook({ identity: me, peersFile, joinedFile, file, addrs: () => [] });
  assert.equal(book.accept(signRecord(B, friendBody(10)), null).ok, true);
  const b = readPeers(peersFile)[0];
  assert.deepEqual(b.addrs, [{ host: '203.0.113.5', port: 40000, via: 'mapped' }], 'the outside address only');
  assert.deepEqual(b.anchors, [], 'an anchor at a private address is not taken');
  assert.equal(b.host, '192.168.1.9', 'where it was paired stays');
  assert.equal(b.port, 50551);
  assert.equal(book.held(B.fp)!.addrs.length, 4, 'the held record stays whole (the seq floor and the signature)');
});

test('address book: the same record for the person\'s own (home) device keeps every address and anchor', () => {
  const { me, B, peersFile, joinedFile, file } = friendFiles('home-lan', 'home');
  const book = new AddressBook({ identity: me, peersFile, joinedFile, file, addrs: () => [] });
  assert.equal(book.accept(signRecord(B, friendBody(10)), null).ok, true);
  const b = readPeers(peersFile)[0];
  assert.deepEqual(b.addrs, friendBody(10).addrs);
  assert.deepEqual(b.anchors, friendBody(10).anchors);
});

test('address book: a device that became a friend\'s is cleaned at start; turned home its lan address comes back from the held record, and goes again as a friend\'s', () => {
  const { me, B, peersFile, joinedFile, file } = friendFiles('ring-turns', 'home');
  const first = new AddressBook({ identity: me, peersFile, joinedFile, file, addrs: () => [] });
  assert.equal(first.accept(signRecord(B, friendBody(10)), null).ok, true);
  assert.equal(readPeers(peersFile)[0].addrs!.length, 4);
  // turned circle while kula-node was not running: the stored lan addresses go at start
  setRingOf(peersFile, B.fp, 'circle');
  const book = new AddressBook({ identity: me, peersFile, joinedFile, file, addrs: () => [] });
  assert.deepEqual(readPeers(peersFile)[0].addrs, [{ host: '203.0.113.5', port: 40000, via: 'mapped' }], 'cleaned at start');
  assert.deepEqual(readPeers(peersFile)[0].anchors, []);
  // confirmed as the person's own: its record is applied again at the next ask (its seq has not risen)
  setRingOf(peersFile, B.fp, 'home');
  assert.deepEqual(book.wants(), [{ fp: B.fp, seq: 10 }]);
  assert.deepEqual(readPeers(peersFile)[0].addrs, friendBody(10).addrs, 'the lan address is back');
  assert.deepEqual(readPeers(peersFile)[0].anchors, friendBody(10).anchors);
  // and a friend's again: gone at the next ask
  setRingOf(peersFile, B.fp, 'circle');
  book.wants();
  assert.deepEqual(readPeers(peersFile)[0].addrs, [{ host: '203.0.113.5', port: 40000, via: 'mapped' }], 'gone again');
  assert.equal(book.held(B.fp)!.seq, 10);
});

test('address book: a friend\'s anchor joined at a lan address is still dialled there; it learns only the outside address from its record', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'friend-anchor-'));
  const me = createIdentity('me');
  const X = createIdentity('x');
  const peersFile = path.join(dir, 'peers.json');
  const joinedFile = path.join(dir, 'anchors.json');
  const file = path.join(dir, 'addrbook.json');
  writePeers([{ id: 'x', name: 'x', host: '192.168.1.20', port: 50551, secret: '', fp: X.fp, kind: 'pc', ram: null, bw: null, added_at: 't', ring: 'circle', anchor: true }], peersFile);
  writeJoined([{ fp: X.fp, name: 'x', host: '192.168.1.20', port: 50551, joined_at: 't' }], joinedFile);
  const book = new AddressBook({ identity: me, peersFile, joinedFile, file, addrs: () => [] });
  const mapped = { host: '203.0.113.9', port: 40000, via: 'mapped' as const };
  assert.equal(book.accept(signRecord(X, { addrs: [{ host: '192.168.1.20', port: 50551, via: 'lan' }, mapped], anchors: [], seq: 10, at: 10 }), null).ok, true);
  let j = readJoined(joinedFile)[0];
  assert.deepEqual([j.host, j.port], ['192.168.1.20', 50551], 'the joined host stays');
  assert.deepEqual(j.addrs, [mapped]);
  assert.deepEqual(readPeers(peersFile)[0].addrs, [mapped]);
  // its record names another lan address now: the host this computer dials is not moved to it
  // (nor to the outside one, as a home anchor's would be: the lan is how this computer joined)
  assert.equal(book.accept(signRecord(X, { addrs: [{ host: '192.168.1.21', port: 50551, via: 'lan' }, mapped], anchors: [], seq: 11, at: 11 }), null).ok, true);
  j = readJoined(joinedFile)[0];
  assert.deepEqual([j.host, j.port], ['192.168.1.20', 50551]);
  assert.deepEqual(j.addrs, [mapped]);
  assert.ok(!fs.readFileSync(joinedFile, 'utf8').includes('192.168.1.21') && !fs.readFileSync(peersFile, 'utf8').includes('192.168.1.21'));
});

test('address book on the wire: an anchor that changes what it hands out is not believed; it carries only records it may, newest first', async () => {
  const echo = await echoServer();
  let lie = false;
  const D = await home('anchor-d', echo.port, {
    anchor: true,
    handOut: (r) => (lie ? { ...r, addrs: [{ host: '203.0.113.66', port: 6666, via: 'mapped' }] } : r),
  });
  const X = await home('x', echo.port, { addrs: [{ host: '127.0.0.1', port: await deadPort(), via: 'lan' }] });
  const Y = await home('y', echo.port, { addrs: [{ host: '127.0.0.1', port: await deadPort(), via: 'lan' }] });
  const Z = createIdentity('z-not-a-member');
  try {
    for (const m of [X, Y]) D.paired.add(m.identity.fp, m.name);
    writePeers([rec(D, { anchor: true }), rec(Y)], X.peersFile);
    writePeers([rec(D, { anchor: true })], Y.peersFile);   // Y has not pinned X: X's record is no use to it
    writeJoined([joinedOf(D)], X.joinedFile);
    writeJoined([joinedOf(D)], Y.joinedFile);

    // the anchor lies first: X refuses Y's changed record and keeps asking
    lie = true;
    link(Y);
    await until(() => !!D.hub!.carried(Y.identity.fp), 4000, 'D to carry Y\'s record');
    link(X);
    await until(() => !!X.book.held(D.identity.fp), 4000, 'X to take D\'s own record');
    await sleep(600);
    assert.equal(X.book.held(Y.identity.fp), null, 'a record changed on the way is never taken');
    assert.deepEqual(readPeers(X.peersFile).find((p) => p.fp === Y.identity.fp)!.addrs, undefined, 'the peer book is untouched');
    // the anchor tells the truth: the same record is taken
    lie = false;
    await until(() => !!X.book.held(Y.identity.fp), 4000, 'X to take Y\'s record');
    assert.deepEqual(X.book.held(Y.identity.fp)!.addrs, Y.book.own()!.addrs);
    assert.equal(Y.book.held(X.identity.fp), null, 'Y never pinned X: X\'s record is not taken there');

    // what the anchor carries: not a record about a stranger, not a forged one, not an older one
    const zRec = signRecord(Z, { addrs: [{ host: '127.0.0.1', port: 1, via: 'lan' }], anchors: [], seq: Date.now(), at: Date.now() });
    const ws = await import('../src/anchor.ts');
    const m = await ws.joinAnchor({
      anchor: { host: '127.0.0.1', port: D.gate.port, fp: D.identity.fp }, identity: X.identity, name: 'x', kind: 'pc', gatePort: X.gate.port,
      book: {
        give: () => [zRec as AddrRecord, { ...Y.book.own()!, addrs: [{ host: '203.0.113.66', port: 6666, via: 'mapped' }] } as AddrRecord, { ...signRecord(Y.identity, { addrs: [{ host: '127.0.0.1', port: 2, via: 'lan' }], anchors: [], seq: 1, at: 1 }) }],
        wants: () => [], take: () => {}, everyMs: 100_000,
      },
    });
    try {
      await sleep(300);
      assert.equal(D.hub!.carried(Z.fp), null, 'a stranger\'s record is not carried');
      assert.deepEqual(D.hub!.carried(Y.identity.fp)!.addrs, Y.book.own()!.addrs, 'neither a changed one nor an older one replaces Y\'s');
    } finally { await m.close(); }
  } finally {
    for (const h of [X, Y, D]) await stop(h).catch(() => {});
    echo.close();
  }
});
