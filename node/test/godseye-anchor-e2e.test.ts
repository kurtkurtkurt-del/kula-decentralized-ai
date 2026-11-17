// P0 (17.11.2026): the anchor network into the brain end to end, on anchor.test.ts's harness:
// three gates on 127.0.0.1, each with its own identity and home. A is the anchor (its own hub,
// a friend's device byte-capped at 1 MB a day by its ring), B registers there, C reaches B through
// A. A real Engine on C and on A, kulaSnapshot, and the eye with its notes and black box on disk:
//   - C sees B via 'anchor', through A's row, with no address in where, and B's roads counted
//   - A sees B through 'self', and its own anchor on
//   - C in ring circle past the cap: the trust branch's anchor-cap card and refused['byte limit'];
//     the same C in ring home: neither
//   - after 10 looks no file under the eyes' directories holds an ip literal or a fingerprint
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-anchor-e2e-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { startGateServer, handshake } = await import('../src/gate.ts');
type GateServer = import('../src/gate.ts').GateServer;
type TlsServer = import('../src/gate.ts').TlsServer;
const { createIdentity, Paired } = await import('../src/tls.ts');
type GateIdentity = import('../src/tls.ts').GateIdentity;
const { AnchorHub, circleMembers, dialAnchor, joinAnchor } = await import('../src/anchor.ts');
type AnchorMembership = import('../src/anchor.ts').AnchorMembership;
const { ringCapped } = await import('../src/join.ts');
const { writePeers } = await import('../src/peers.ts');
type Peer = import('../src/peers.ts').Peer;
const { Engine } = await import('../src/ui/engine.ts');
const { kulaSnapshot } = await import('../src/ui/godseye-feed.ts');
const { GodsEye } = await import('../src/godseye/index.ts');

const CAP = 1_000_000;
const PUSH = 1_200_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(HOME, 'h-'));
const projects = { list: () => [] } as any;

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

// a port nothing listens on: a device's lan address while it is away
function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

interface Home { name: string; dir: string; identity: GateIdentity; paired: InstanceType<typeof Paired>; gate: GateServer; hub: InstanceType<typeof AnchorHub> | null; peersFile: string }

async function home(name: string, echoPort: number, anchor = false): Promise<Home> {
  const dir = tmp();
  const identity = createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const tls: TlsServer = { identity, paired, pin: null, onPinUsed: () => {} };
  const peersFile = path.join(dir, 'peers.json');
  // as share builds it: friends' devices (ring circle) byte-capped, the person's own (home) not
  const hub = anchor ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, peersFile), capped: ringCapped(peersFile), caps: { bytesPerDay: CAP } }) : null;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echoPort, tls, anchor: hub ?? undefined });
  return { name, dir, identity, paired, gate, hub, peersFile };
}

const rec = (id: string, name: string, h: Home, port: number, more: Partial<Peer> = {}): Peer => ({
  id, name, named: true, host: '127.0.0.1', port, secret: '', fp: h.identity.fp, pin: null, paired_at: '2026-11-17T08:00:00.000Z', kind: 'pc', ram: null, bw: null, added_at: '2026-11-17T08:00:00.000Z', ...more,
});

// C sends `n` bytes to B through A and reads them back: true when all came back, false when cut
async function push(A: Home, B: Home, C: Home, n: number): Promise<boolean> {
  const d: Duplex = await dialAnchor({ host: '127.0.0.1', port: A.gate.port, fp: A.identity.fp }, C.identity, B.identity.fp);
  const h = await handshake(d, '', 'api', 3000, undefined, { identity: C.identity, fp: B.identity.fp });
  return new Promise<boolean>((resolve) => {
    let got = 0;
    let done = false;
    const end = (ok: boolean) => { if (done) return; done = true; clearTimeout(t); h.socket.destroy(); resolve(ok); };
    const t = setTimeout(() => end(false), 8000);
    h.socket.on('data', (b: Buffer) => { got += b.length; if (got >= n) end(true); });
    h.socket.on('close', () => end(got >= n));
    h.socket.on('error', () => {});
    h.socket.write(Buffer.alloc(n, 7));
  });
}

// every file under a directory, its path and text
function files(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push({ file: p, text: fs.readFileSync(p, 'utf8') });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/;
const HEX64 = /[0-9a-f]{64}/i;
// an ipv6 literal anywhere: every run of hex digits and colons with two colons or more, checked by net
const ipv6In = (s: string): string[] => (s.match(/[0-9a-f:]*:[0-9a-f:]*:[0-9a-f:]*/gi) ?? []).filter((x) => net.isIPv6(x));
// the black box chains its records by sha256 (box.ts: "p" the previous record's hash, "h" its own;
// head.json the last one's): those hashes are the box's own and say nothing about anyone, so they
// are taken out before the 64-hex check
const withoutChain = (s: string) => s.replace(/"(p|h)":"[0-9a-f]{64}"/g, '"$1":"…"');

async function world(ring: 'circle' | 'home') {
  const echo = await echoServer();
  const A = await home('anchor-berlin', echo.port, true);
  const B = await home('mac-home', echo.port);
  const C = await home('friend-laptop', echo.port);
  // B and C are members of A (A's paired set); B lets C and A use its gate
  A.paired.add(B.identity.fp);
  A.paired.add(C.identity.fp);
  B.paired.add(C.identity.fp);
  B.paired.add(A.identity.fp);
  // A's peer book: B the person's own computer, C a friend's (or the person's own in the second run)
  writePeers([rec('b', 'mac-home', B, await deadPort(), { ring: 'home' }), rec('c', 'friend-laptop', C, await deadPort(), { ring })], A.peersFile);
  // C's peer book: the anchor A, and B with its lan address dead and A named as its anchor
  writePeers([
    rec('anc', 'anchor-berlin', A, A.gate.port, { anchor: true }),
    rec('b', 'mac-home', B, await deadPort(), { anchors: [{ fp: A.identity.fp, host: '127.0.0.1', port: A.gate.port, name: 'anchor-berlin' }] }),
  ], C.peersFile);
  const memberships: AnchorMembership[] = [await joinAnchor({ anchor: { host: '127.0.0.1', port: A.gate.port, fp: A.identity.fp }, identity: B.identity, name: 'mac-home', kind: 'pc', gatePort: B.gate.port })];
  // the gates' api channel is an echo server, so a probe's /status and /trust get no answer: 300 ms
  // each. No model dirs: a look would otherwise list this computer's own models every time
  const eA = new Engine({ peersFile: A.peersFile, pairedFile: path.join(A.dir, 'paired'), identity: A.identity, llama: null, modelDirs: [], probeMs: 3000, statusMs: 300, anchorHub: () => A.hub, joinedFile: path.join(A.dir, 'anchors.json') });
  const eC = new Engine({ peersFile: C.peersFile, pairedFile: path.join(C.dir, 'paired'), identity: C.identity, llama: null, modelDirs: [], probeMs: 3000, statusMs: 300, joinedFile: path.join(C.dir, 'anchors.json') });
  const eyeDir = path.join(HOME, `eyes-${ring}`);
  const eyeA = new GodsEye({ snapshot: () => kulaSnapshot(eA, projects), dir: path.join(eyeDir, 'A'), box: { dir: path.join(eyeDir, 'A', 'box') } });
  const eyeC = new GodsEye({ snapshot: () => kulaSnapshot(eC, projects), dir: path.join(eyeDir, 'C'), box: { dir: path.join(eyeDir, 'C', 'box') } });
  return {
    A, B, C, eA, eC, eyeA, eyeC, eyeDir,
    close: async () => {
      for (const m of memberships) await m.close();
      await eA.close(); await eC.close();
      for (const h of [A, B, C]) await h.gate.close();
      A.hub?.close();
      echo.close();
    },
  };
}

// the scan every run ends with: no ip literal, no fingerprint, no 64 hex outside the box's chain
function assertPrivate(w: Awaited<ReturnType<typeof world>>) {
  const all = files(w.eyeDir);
  assert.ok(all.some((f) => f.file.includes(`${path.sep}box${path.sep}`)), 'the black box wrote too');
  assert.ok(all.some((f) => !f.file.includes(`${path.sep}box${path.sep}`) && f.file.endsWith('.json')), 'the branches wrote notes');
  for (const { file, text } of all) {
    const where = path.relative(w.eyeDir, file);
    assert.doesNotMatch(text, IPV4, `${where}: an ipv4 literal`);
    assert.deepEqual(ipv6In(text), [], `${where}: an ipv6 literal`);
    for (const h of [w.A, w.B, w.C]) assert.equal(text.toLowerCase().includes(h.identity.fp.toLowerCase()), false, `${where}: ${h.name}'s fingerprint`);
    assert.doesNotMatch(withoutChain(text), HEX64, `${where}: 64 hex`);
  }
}

test('ring circle: C reaches B through A, A through self; past the 1 MB cap the eye says anchor-cap and the anchor counts byte limit; nothing private on disk', async () => {
  const w = await world('circle');
  const { A, B, C } = w;
  try {
    // C: B through the anchor A
    await w.eC.probe(['b']);
    const sc = kulaSnapshot(w.eC, projects);
    const bc = sc.devices.find((d) => d.id === 'b')!;
    assert.equal(bc.via, 'anchor');
    assert.equal(bc.through, 'anc', 'through names A\'s row');
    assert.equal(bc.throughName, 'anchor-berlin');
    assert.doesNotMatch(bc.where, IPV4);
    assert.deepEqual(ipv6In(bc.where), []);
    assert.deepEqual(bc.roads, { lan: 1, direct: 0, anchors: 1 }, 'its dead lan address and the anchor');
    assert.equal(sc.devices.find((d) => d.id === 'anc')!.anchor, true, 'A offers the role');
    assert.equal(sc.host.anchor?.on ?? false, false, 'C is no anchor');

    // A: B through its own hub
    await w.eA.probe(['b']);
    const sa = kulaSnapshot(w.eA, projects);
    const ba = sa.devices.find((d) => d.id === 'b')!;
    assert.equal(ba.via, 'anchor');
    assert.equal(ba.through, 'self');
    assert.equal(ba.throughName, 'this computer');
    assert.equal(sa.host.anchor!.on, true);
    assert.equal(sa.host.anchor!.links, 1);
    assert.equal(typeof sa.host.anchor!.since, 'number');

    // C, a friend's device, passes more than its 1 MB a day: cut, then refused for today
    assert.equal(await push(A, B, C, PUSH), false, 'cut at the cap');
    await sleep(100);
    await assert.rejects(push(A, B, C, 1000), /byte limit/);
    for (let i = 0; i < 10; i++) { w.eyeA.tick(); w.eyeC.tick(); }
    const s = kulaSnapshot(w.eA, projects);
    assert.ok((s.host.anchor!.refused?.['byte limit'] ?? 0) >= 1, JSON.stringify(s.host.anchor!.refused));
    assert.ok(s.host.anchor!.memberMaxDay! > CAP);
    assert.equal(s.host.anchor!.memberMaxName, 'friend-laptop');
    assert.ok(w.eyeA.view().cards.some((c) => c.id === 'trust:anchor-cap'), JSON.stringify(w.eyeA.view().cards.map((c) => c.id)));
    assertPrivate(w);
  } finally { await w.close(); }
});

test('ring home: the same 1.2 MB passes, no anchor-cap card and no byte limit; nothing private on disk', async () => {
  const w = await world('home');
  const { A, B, C } = w;
  try {
    await w.eC.probe(['b']);
    await w.eA.probe(['b']);
    assert.equal(await push(A, B, C, PUSH), true, 'the person\'s own device has no daily cap');
    await sleep(100);
    for (let i = 0; i < 10; i++) { w.eyeA.tick(); w.eyeC.tick(); }
    const s = kulaSnapshot(w.eA, projects);
    assert.deepEqual(s.host.anchor!.refused, {}, 'the anchor counts refusals, and refused none');
    assert.equal(s.host.anchor!.removed, 0);
    assert.equal(s.host.anchor!.memberMaxName, null, 'no friend\'s device to name');
    assert.deepEqual(s.devices.find((d) => d.id === 'b')!.roads, { lan: 1, direct: 0, anchors: 1 }, 'its dead lan address and this computer\'s own anchor');
    assert.equal(s.host.anchor!.memberMaxDay, 0, 'no capped member passed anything');
    assert.ok(s.host.anchor!.bytesDay > CAP, 'the bytes passed all the same');
    assert.equal(w.eyeA.view().cards.some((c) => c.id === 'trust:anchor-cap'), false);
    assertPrivate(w);
  } finally { await w.close(); }
});
