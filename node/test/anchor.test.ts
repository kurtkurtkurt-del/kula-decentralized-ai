// The anchor (docs/ANCHOR.md): three gates on 127.0.0.1, each with its own identity and home.
// A is the anchor; B is a member by A's paired set; C is a member the other way round (A paired
// with C as a master: C is pinned with paired_at in A's peer book, not in A's paired set). A
// member dials another by fingerprint and the inner gate handshake runs end to end; the anchor
// sees only TLS records; strangers, pins, unknown fingerprints and every cap are refused; a
// second register replaces the first; two far masters cannot both hold a gate's rpc slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import { startGateServer, handshake, probe, connectRemote, LineReader, GateRefused, FP_MISMATCH, type GateServer, type TlsServer } from '../src/gate.ts';
import { createIdentity, newPin, Paired, type GateIdentity } from '../src/tls.ts';
import { AnchorHub, circleMembers, dialAnchor, joinAnchor, ANCHOR_ACCEPTS_IN_FLIGHT, type AnchorCaps, type AnchorEvent, type AnchorMembership, type AnchorRef } from '../src/anchor.ts';
import { signRecord } from '../src/addrrecord.ts';

const SECRET_TEXT = 'the bread is fresh in Berlin';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-anchor-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function echoServer(greeting?: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); if (greeting) c.write(greeting); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
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

interface Home { name: string; dir: string; identity: GateIdentity; paired: Paired; tls: TlsServer; gate: GateServer; hub: AnchorHub | null }

interface HubMore { now?: () => number; capped?: (fp: string) => boolean; recordRate?: { burst: number; perMinute: number } }

async function home(name: string, echoPort: number, anchor?: { caps?: Partial<AnchorCaps>; tap?: (dir: 'd→t' | 't→d', b: Buffer) => void; events?: AnchorEvent[] } & HubMore): Promise<Home> {
  const dir = tmp();
  const identity = createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const t: TlsServer = { identity, paired, pin: newPin(), onPinUsed: () => {} };
  const hub = anchor ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, path.join(dir, 'peers.json')), caps: anchor.caps, tap: anchor.tap, now: anchor.now, capped: anchor.capped, recordRate: anchor.recordRate }) : null;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echoPort, tls: t, anchor: hub ?? undefined, onAnchor: anchor?.events ? (e) => anchor.events!.push(e) : undefined });
  return { name, dir, identity, paired, tls: t, gate, hub };
}

// every member is a friend's device (capped) unless `capped` says otherwise
async function world(caps?: Partial<AnchorCaps>, more: HubMore = {}) {
  const echo = await echoServer();
  const taps: { dir: 'd→t' | 't→d'; b: Buffer }[] = [];
  const events: AnchorEvent[] = [];
  const A = await home('anchor-berlin', echo.port, { caps, tap: (dir, b) => taps.push({ dir, b: Buffer.from(b) }), events, ...more });
  const B = await home('mac-home', echo.port);
  const C = await home('phone-far', echo.port);
  // B paired with A's code: in A's paired set. C was paired by A as a master (the host qr's
  // direction): A has C pinned in its peer book, C is not in A's paired set.
  A.paired.add(B.identity.fp);
  fs.writeFileSync(path.join(A.dir, 'peers.json'), JSON.stringify([{ id: 'c', name: 'phone-far', host: '', port: 0, secret: '', fp: C.identity.fp, pin: null, paired_at: new Date().toISOString(), kind: 'phone', ram: null, bw: null, added_at: new Date().toISOString() }]));
  const ref: AnchorRef = { host: '127.0.0.1', port: A.gate.port, fp: A.identity.fp };
  const members: AnchorMembership[] = [];
  const join = async (h: Pick<Home, 'identity' | 'name'>, gatePort: number, extra: { retryMs?: number; onState?: (s: string) => void } = {}) => {
    const m = await joinAnchor({ anchor: ref, identity: h.identity, name: h.name, kind: 'pc', gatePort, ...extra });
    members.push(m);
    return m;
  };
  return {
    A, B, C, ref, taps, events, echo, join,
    close: async () => {
      for (const m of members) await m.close();
      for (const h of [A, B, C]) await h.gate.close();
      A.hub?.close();
      echo.close();
    },
  };
}

// a stream of TLS records and nothing else: content type 20-23, version 3.x, a length, the body
function onlyTlsRecords(buf: Buffer): boolean {
  let i = 0;
  while (i < buf.length) {
    if (i + 5 > buf.length) return false;
    const type = buf[i];
    if (type < 20 || type > 23 || buf[i + 1] !== 3) return false;
    i += 5 + buf.readUInt16BE(i + 3);
  }
  return i === buf.length && buf.length > 0;
}

test('a member dials another by fingerprint: the inner handshake pairs and pins end to end; the anchor dials for itself in-process', async () => {
  const w = await world();
  const { A, B, C } = w;
  try {
    await w.join(B, B.gate.port);
    // C reaches B's gate through A: B's own one-time code pairs C, exactly as on the lan
    const d1 = await dialAnchor(w.ref, C.identity, B.identity.fp);
    const h1 = await handshake(d1, '', 'api', 3000, undefined, { identity: C.identity, fp: B.identity.fp, pin: B.tls.pin });
    assert.equal(h1.fp, B.identity.fp);
    assert.ok(B.paired.has(C.identity.fp), 'B paired C through the anchor');
    assert.equal(B.tls.pin, null, 'the code is spent');
    assert.ok(!A.paired.has(C.identity.fp), 'the anchor paired nobody');
    h1.socket.write('hello through the anchor');
    assert.equal((await readAtLeast(h1.socket, 24)).toString(), 'hello through the anchor');
    h1.socket.destroy();
    // the certificate alone from now on
    const d2 = await dialAnchor(w.ref, C.identity, B.identity.fp);
    const h2 = await handshake(d2, '', 'api', 3000, undefined, { identity: C.identity, fp: B.identity.fp });
    h2.socket.destroy();
    // whoever answers must show the pinned certificate: expecting another one fails at TLS
    const d3 = await dialAnchor(w.ref, C.identity, B.identity.fp);
    await assert.rejects(handshake(d3, '', 'api', 3000, undefined, { identity: C.identity, fp: 'ab'.repeat(32) }), new RegExp(FP_MISMATCH));
    d3.destroy();
    // 'self': the anchor's own computer reaches its member in one hop, without a network leg
    B.paired.add(A.identity.fp);
    const d4 = await A.hub!.dialLocal(B.identity.fp);
    const h4 = await handshake(d4, '', 'api', 3000, undefined, { identity: A.identity, fp: B.identity.fp });
    h4.socket.write('self');
    assert.equal((await readAtLeast(h4.socket, 4)).toString(), 'self');
    h4.socket.destroy();
    await sleep(50);
    assert.ok(w.events.some((e) => e.type === 'open' && e.peer === 'self' && e.to === B.identity.fp));
    assert.ok(w.events.some((e) => e.type === 'register' && e.fp === B.identity.fp && e.peer === '127.0.0.1'));
  } finally {
    await w.close();
  }
});

test('a tap between the two members sees only TLS records, never the text', async () => {
  const w = await world();
  const { B, C } = w;
  try {
    B.paired.add(C.identity.fp);
    await w.join(B, B.gate.port);
    const d = await dialAnchor(w.ref, C.identity, B.identity.fp);
    const h = await handshake(d, '', 'api', 3000, undefined, { identity: C.identity, fp: B.identity.fp });
    h.socket.write(SECRET_TEXT);
    assert.equal((await readAtLeast(h.socket, SECRET_TEXT.length)).toString(), SECRET_TEXT);
    h.socket.destroy();
    await sleep(100);
    const out = Buffer.concat(w.taps.filter((t) => t.dir === 'd→t').map((t) => t.b));
    const back = Buffer.concat(w.taps.filter((t) => t.dir === 't→d').map((t) => t.b));
    assert.ok(out.length > 0 && back.length > 0, 'the anchor carried bytes both ways');
    assert.ok(!out.includes(Buffer.from(SECRET_TEXT)) && !back.includes(Buffer.from(SECRET_TEXT)), 'the text never crossed the anchor in the clear');
    assert.ok(onlyTlsRecords(out), 'dialer to target: TLS records only');
    assert.ok(onlyTlsRecords(back), 'target to dialer: TLS records only');
  } finally {
    await w.close();
  }
});

test('a device that is not a member hears "not paired": it can neither dial nor register', async () => {
  const w = await world();
  try {
    await w.join(w.B, w.B.gate.port);
    const stranger = createIdentity('stranger');
    await assert.rejects(dialAnchor(w.ref, stranger, w.B.identity.fp), (e: unknown) => e instanceof GateRefused && e.reason === 'not paired');
    await assert.rejects(joinAnchor({ anchor: w.ref, identity: stranger, name: 'x', kind: 'pc', gatePort: 1 }), (e: unknown) => e instanceof GateRefused && e.reason === 'not paired');
    // the anchor must be the pinned one: another certificate at its address is not dialed through
    await assert.rejects(dialAnchor({ ...w.ref, fp: 'cd'.repeat(32) }, w.C.identity, w.B.identity.fp), new RegExp(FP_MISMATCH));
    await sleep(50);
    assert.ok(w.events.some((e) => e.type === 'refuse' && e.fp === stranger.fp && e.reason === 'not paired'));
  } finally {
    await w.close();
  }
});

test('a pin is never accepted on the anchor channel, even while a pairing code is open', async () => {
  const w = await world();
  const { A, B } = w;
  try {
    const pin = A.tls.pin!;
    assert.ok(pin, 'A has an open pairing code');
    const stranger = createIdentity('stranger');
    // the client offers the right code: the anchor never asks for it
    const raw = net.connect(A.gate.port, '127.0.0.1');
    await new Promise((r) => raw.once('connect', r));
    await assert.rejects(handshake(raw, '', 'anchor', 3000, undefined, { identity: stranger, fp: A.identity.fp, pin }), (e: unknown) => e instanceof GateRefused && e.reason === 'not paired');
    raw.destroy();
    assert.equal(A.tls.pin, pin, 'the code is not spent');
    assert.ok(!A.paired.has(stranger.fp), 'nobody paired');
    // on the wire: a stranger is told "not paired" at once, a member is told "paired", never "pin"
    const hello = (id: GateIdentity, second?: string) => new Promise<string[]>((resolve, reject) => {
      const s = tls.connect({ port: A.gate.port, host: '127.0.0.1', key: id.keyPem, cert: id.certPem, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, () => s.write(`KULA2 anchor ${randomBytes(16).toString('hex')} ${Date.now()}\n`));
      let buf = '';
      const lines: string[] = [];
      s.on('data', (d: Buffer) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, i)); buf = buf.slice(i + 1);
          if (lines.length === 1 && second && !lines[0].startsWith('NO ')) s.write(second + '\n');
          else { s.destroy(); resolve(lines); }
        }
      });
      s.on('error', reject);
    });
    assert.deepEqual(await hello(stranger), ['NO not paired']);
    // a member that sends a pin proof instead of "-" is refused
    const [first, answer] = await hello(B.identity, 'ab'.repeat(32));
    assert.match(first, /^[0-9a-f]{32} paired$/);
    assert.equal(answer, 'NO bad proof');
    // the code still works where it belongs: an ordinary pairing on the api channel
    assert.equal((await probe('127.0.0.1', A.gate.port, '', 'api', 3000, { identity: stranger, fp: A.identity.fp, pin })).ok, true);
  } finally {
    await w.close();
  }
});

test('the phone-direction member (only in the peer book) is admitted on the anchor but refused on api and rpc', async () => {
  const w = await world();
  const { A, B, C } = w;
  try {
    assert.ok(!A.paired.has(C.identity.fp));
    const m = await w.join(C, C.gate.port);
    assert.equal(m.registered, true);
    assert.deepEqual(await probe('127.0.0.1', A.gate.port, '', 'api', 3000, { identity: C.identity, fp: A.identity.fp }), { ok: false, reason: 'not paired' });
    assert.deepEqual(await probe('127.0.0.1', A.gate.port, '', 'rpc', 3000, { identity: C.identity, fp: A.identity.fp }), { ok: false, reason: 'not paired' });
    // and it is reachable as a target: B dials C through A
    C.paired.add(B.identity.fp);
    const d = await dialAnchor(w.ref, B.identity, C.identity.fp);
    const h = await handshake(d, '', 'api', 3000, undefined, { identity: B.identity, fp: C.identity.fp });
    h.socket.write('to the phone');
    assert.equal((await readAtLeast(h.socket, 12)).toString(), 'to the phone');
    h.socket.destroy();
  } finally {
    await w.close();
  }
});

test('an unknown fingerprint is "not here"; a malformed one is "bad dial"', async () => {
  const w = await world();
  try {
    await w.join(w.B, w.B.gate.port);
    const nobody = createIdentity('nobody').fp;
    await assert.rejects(dialAnchor(w.ref, w.C.identity, nobody), (e: unknown) => e instanceof GateRefused && e.reason === 'not here');
    await assert.rejects(dialAnchor(w.ref, w.C.identity, 'abc'), (e: unknown) => e instanceof GateRefused && e.reason === 'bad dial');
    await assert.rejects(w.A.hub!.dialLocal(nobody), (e: unknown) => e instanceof GateRefused && e.reason === 'not here');
    // a registered member is found by its full fingerprint only
    await assert.rejects(dialAnchor(w.ref, w.C.identity, w.B.identity.fp.slice(0, 16)), (e: unknown) => e instanceof GateRefused && e.reason === 'bad dial');
  } finally {
    await w.close();
  }
});

test('caps: streams per member, streams in all, dials a minute, bytes a day', async () => {
  const refused = (reason: string) => (e: unknown) => e instanceof GateRefused && e.reason === reason;
  // streams per member
  {
    const w = await world({ streamsPerMember: 2 });
    try {
      await w.join(w.B, w.B.gate.port);
      const a = await dialAnchor(w.ref, w.C.identity, w.B.identity.fp);
      const b = await dialAnchor(w.ref, w.C.identity, w.B.identity.fp);
      await assert.rejects(dialAnchor(w.ref, w.C.identity, w.B.identity.fp), refused('too many streams'));
      a.destroy();
      await sleep(150);
      const c = await dialAnchor(w.ref, w.C.identity, w.B.identity.fp);
      b.destroy(); c.destroy();
    } finally { await w.close(); }
  }
  // streams in all
  {
    const w = await world({ streamsTotal: 2 });
    try {
      await w.join(w.B, w.B.gate.port);
      await w.join(w.C, w.C.gate.port);
      const a = await dialAnchor(w.ref, w.C.identity, w.B.identity.fp);
      const b = await dialAnchor(w.ref, w.C.identity, w.B.identity.fp);
      await assert.rejects(dialAnchor(w.ref, w.B.identity, w.C.identity.fp), refused('full'));
      await assert.rejects(w.A.hub!.dialLocal(w.B.identity.fp), refused('full'), 'the anchor\'s own dials count toward the total');
      a.destroy(); b.destroy();
    } finally { await w.close(); }
  }
  // dials, a friend's device: a burst of 120 (the default), then 30 a minute (a token bucket);
  // the person's own device (not capped): no dial rate at all. Streams per member raised here so
  // only the dial cap speaks.
  {
    let clock = 1_000_000;
    const w = await world({ streamsPerMember: 1000, streamsTotal: 1000 }, { now: () => clock, capped: (fp) => fp !== w.B.identity.fp });
    try {
      await w.join(w.B, w.B.gate.port);
      await w.join(w.C, w.C.gate.port);
      for (let i = 0; i < 120; i++) (await dialAnchor(w.ref, w.C.identity, w.B.identity.fp)).destroy();
      await assert.rejects(dialAnchor(w.ref, w.C.identity, w.B.identity.fp), refused('too many dials'), 'the 121st');
      clock += 1_000;
      await assert.rejects(dialAnchor(w.ref, w.C.identity, w.B.identity.fp), refused('too many dials'), 'half a dial refilled is not one');
      clock += 1_000;
      (await dialAnchor(w.ref, w.C.identity, w.B.identity.fp)).destroy();   // 2 s at 30 a minute: one more
      await assert.rejects(dialAnchor(w.ref, w.C.identity, w.B.identity.fp), refused('too many dials'));
      // B is the person's own: 200 in a row
      for (let i = 0; i < 200; i++) (await dialAnchor(w.ref, w.B.identity, w.C.identity.fp)).destroy();
    } finally { await w.close(); }
  }
  // bytes a day, per dialing member: the running stream is cut, new ones are refused
  {
    const w = await world({ bytesPerDay: 100_000 });
    try {
      w.B.paired.add(w.C.identity.fp);
      await w.join(w.B, w.B.gate.port);
      await w.join(w.C, w.C.gate.port);
      const d = await dialAnchor(w.ref, w.C.identity, w.B.identity.fp);
      const h = await handshake(d, '', 'api', 3000, undefined, { identity: w.C.identity, fp: w.B.identity.fp });
      h.socket.on('error', () => {});
      let back = 0;
      h.socket.on('data', (x: Buffer) => { back += x.length; });
      const cut = new Promise<void>((r) => h.socket.once('close', () => r()));
      for (let i = 0; i < 40; i++) h.socket.write(randomBytes(10_000));
      await Promise.race([cut, sleep(3000).then(() => { throw new Error('the stream was not cut'); })]);
      assert.ok(back < 400_000, `cut before everything came back (${back} bytes)`);
      await assert.rejects(dialAnchor(w.ref, w.C.identity, w.B.identity.fp), refused('byte limit'));
      // another member is not touched by C's bytes
      await assert.rejects(dialAnchor(w.ref, w.B.identity, createIdentity('x').fp), refused('not here'));
      assert.ok(w.A.hub!.stats().bytesToday[w.C.identity.fp] > 100_000);
      // the caps are the person's to change
      w.A.hub!.setCaps({ bytesPerDay: 10_000_000 });
      (await dialAnchor(w.ref, w.C.identity, w.B.identity.fp)).destroy();
    } finally { await w.close(); }
  }
});

test('a second register from the same certificate replaces the first, which steps back for good; a removed member is cut', async () => {
  const w = await world();
  const { A, B } = w;
  const marker = await echoServer('SECOND');
  try {
    const states: string[] = [];
    const m1 = await w.join(B, B.gate.port, { retryMs: 50, onState: (s) => states.push(s) });
    const m2 = await w.join(B, marker.port, { retryMs: 50 });
    await sleep(300);
    assert.equal(m1.replaced, true);
    assert.equal(m1.registered, false);
    assert.equal(m2.registered, true);
    assert.ok(states.includes('replaced'));
    // it does not come back and fight: still one registration, the second one
    await sleep(500);
    assert.equal(A.hub!.members().filter((m) => m.fp === B.identity.fp).length, 1);
    assert.equal(w.events.filter((e) => e.type === 'register' && e.fp === B.identity.fp).length, 2);
    assert.ok(w.events.some((e) => e.type === 'register' && e.replaced));
    // a dial reaches the second registration's gate
    const d = await dialAnchor(w.ref, w.C.identity, B.identity.fp);
    assert.equal((await readAtLeast(d, 6)).toString(), 'SECOND');
    d.destroy();
    // removing B's access on the anchor (and B not in the peer book) cuts its control connection
    A.paired.remove(B.identity.fp);
    assert.ok(A.gate.drop(B.identity.fp) >= 1);
    await sleep(100);
    assert.equal(A.hub!.members().length, 0);
    await assert.rejects(dialAnchor(w.ref, w.C.identity, B.identity.fp), (e: unknown) => e instanceof GateRefused && e.reason === 'not here');
  } finally {
    marker.close();
    await w.close();
  }
});

test('two far masters through the anchor cannot both hold a gate\'s rpc slot (it is keyed by certificate, not by 127.0.0.1)', async () => {
  const w = await world();
  const { A, B, C } = w;
  try {
    const D = createIdentity('far-master-2');
    A.paired.add(D.fp);
    B.paired.add(C.identity.fp);
    B.paired.add(D.fp);
    await w.join(B, B.gate.port);
    const rpcOf = async (id: GateIdentity) => handshake(await dialAnchor(w.ref, id, B.identity.fp), '', 'rpc', 3000, undefined, { identity: id, fp: B.identity.fp });
    const c1 = await rpcOf(C.identity);
    await assert.rejects(rpcOf(D), (e: unknown) => e instanceof GateRefused && e.reason === 'busy');
    // the holder may open more rpc connections (llama.cpp does)
    const c2 = await rpcOf(C.identity);
    c1.socket.destroy(); c2.socket.destroy();
    await sleep(150);
    const d1 = await rpcOf(D);
    d1.socket.destroy();
  } finally {
    await w.close();
  }
});

// --- security review D4, group 3 (the anchor hub) ---------------------------------------------

// A member's control connection by hand: the gate handshake on the anchor channel, then JSON lines.
async function control(port: number, identity: GateIdentity, anchorFp: string) {
  const raw = await connectRemote('127.0.0.1', port, 3000);
  const h = await handshake(raw, '', 'anchor', 3000, undefined, { identity, fp: anchorFp });
  const reader = new LineReader(h.socket);
  if (h.rest.length) reader.feed(h.rest);
  h.socket.on('error', () => {});
  const write = (o: unknown) => h.socket.write(JSON.stringify(o) + '\n');
  const next = async (ms = 3000) => JSON.parse(await reader.line(ms));
  return { socket: h.socket, reader, write, next };
}

async function registered(port: number, identity: GateIdentity, anchorFp: string) {
  const c = await control(port, identity, anchorFp);
  c.write({ t: 'register', name: 'by-hand', kind: 'pc' });
  assert.equal((await c.next()).t, 'registered');
  return c;
}

// the far side hung up: 'end' (the legs are half-open, allowHalfOpen) or 'close'
const closedWithin = (s: Duplex, ms: number): Promise<boolean> => new Promise((resolve) => {
  if (s.destroyed || s.readableEnded) return resolve(true);
  const t = setTimeout(() => resolve(false), ms);
  const done = () => { clearTimeout(t); resolve(true); };
  s.once('end', done);
  s.once('close', done);
  s.resume();
});

const bookEntry = (fp: string, name: string) => ({ id: name, name, host: '', port: 0, secret: '', fp, pin: null, paired_at: new Date().toISOString(), kind: 'pc', ram: null, bw: null, added_at: new Date().toISOString() });

test('#4 a removed member is cut within 6 s (unpaired then out of the book, or the other way round) with no drop call; its `who` gets no answer', async () => {
  for (const order of ['paired first', 'book first'] as const) {
    const w = await world();
    const { A, B, C } = w;
    const members: AnchorMembership[] = [];
    try {
      // B is the target, registered and piping into an echo server; B1 asks `who` after it is
      // removed (the line check), B2 stays silent (the 5 s check)
      members.push(await joinAnchor({ anchor: w.ref, identity: B.identity, name: 'b', kind: 'pc', gatePort: w.echo.port }));
      const B1 = createIdentity('removed-1');
      const B2 = createIdentity('removed-2');
      const book = (fps: GateIdentity[]) => fs.writeFileSync(path.join(A.dir, 'peers.json'), JSON.stringify([bookEntry(C.identity.fp, 'phone-far'), ...fps.map((i, k) => bookEntry(i.fp, `removed-${k}`))]));
      for (const i of [B1, B2]) A.paired.add(i.fp);
      book([B1, B2]);
      const c1 = await registered(A.gate.port, B1, A.identity.fp);
      const c2 = await registered(A.gate.port, B2, A.identity.fp);
      const s1 = await dialAnchor(w.ref, B1, B.identity.fp);
      const s2 = await dialAnchor(w.ref, B2, B.identity.fp);
      s1.write('one'); s2.write('two');
      assert.equal((await readAtLeast(s1, 3)).toString(), 'one');
      assert.equal((await readAtLeast(s2, 3)).toString(), 'two');
      // the anchor carries C's record and answers `who` about it
      c1.write({ t: 'record', rec: signRecord(C.identity, { addrs: [{ host: '127.0.0.1', port: 1, via: 'lan' }], anchors: [], seq: 5, at: 5 }) });
      const who = { t: 'who', fps: [C.identity.fp], seqs: [0] };
      c1.write(who);
      assert.equal((await c1.next()).rec.fp, C.identity.fp, 'a member is answered');
      // the first half of the removal: still a member the other way
      if (order === 'paired first') { A.paired.remove(B1.fp); A.paired.remove(B2.fp); } else book([]);
      c1.write(who);
      assert.equal((await c1.next()).rec.fp, C.identity.fp, `${order}: still a member, still answered`);
      // the second half: no longer a member, and nobody calls drop
      if (order === 'paired first') book([]); else { A.paired.remove(B1.fp); A.paired.remove(B2.fp); }
      c1.write(who);
      await assert.rejects(c1.next(6000), (e: unknown) => e instanceof Error && e.message !== 'timeout',`${order}: no answer, the control connection is cut`);
      const cut = await Promise.all([closedWithin(c2.socket, 6000), closedWithin(s1, 6000), closedWithin(s2, 6000)]);
      assert.deepEqual(cut, [true, true, true], `${order}: the silent member's control connection and both streams are cut within 6 s`);
      assert.deepEqual(A.hub!.members().map((m) => m.fp), [B.identity.fp], `${order}: only B is left`);
      assert.ok(w.events.some((e) => e.type === 'leave' && e.fp === B2.fp && e.why === 'removed'));
    } finally {
      for (const m of members) await m.close();
      await w.close();
    }
  }
});

test('#6 200 `record` lines in a second: at most 16 are checked, the rest dropped', async () => {
  const clock = 5_000_000;
  const w = await world(undefined, { now: () => clock });
  try {
    const c = await registered(w.A.gate.port, w.B.identity, w.A.identity.fp);
    // in writes of ten lines, so the gate's limit on unread bytes is not what speaks; the clock
    // stands still, so the whole burst falls in one second
    for (let seq = 1; seq <= 200; seq++) {
      c.write({ t: 'record', rec: signRecord(w.B.identity, { addrs: [{ host: '127.0.0.1', port: seq, via: 'lan' }], anchors: [], seq, at: seq }) });
      if (seq % 10 === 0) await new Promise((r) => setImmediate(r));
    }
    c.write({ t: 'ping' });
    assert.equal((await c.next()).t, 'pong', 'every line was read');
    // each record is newer than the last: the one kept says how many were checked
    assert.equal(w.A.hub!.carried(w.B.identity.fp)!.seq, 16);
    c.socket.destroy();
  } finally {
    await w.close();
  }
});

test('#7 600 throwaway records from one member: a new member\'s record is still kept and answered', async () => {
  const w = await world(undefined, { recordRate: { burst: 100_000, perMinute: 6_000_000 } });
  const { A, B } = w;
  try {
    const bad = await registered(A.gate.port, B.identity, A.identity.fp);
    const addrs = [{ host: '127.0.0.1', port: 9, via: 'lan' as const }];
    // B names four throwaway "anchors" in its own record, gives their records, renames, again
    for (let round = 0; round < 150; round++) {
      const ids = [0, 1, 2, 3].map((i) => createIdentity(`throwaway-${round}-${i}`));
      let lines = JSON.stringify({ t: 'record', rec: signRecord(B.identity, { addrs, anchors: ids.map((i) => ({ fp: i.fp, host: '127.0.0.1', port: 9 })), seq: round + 1, at: round + 1 }) }) + '\n';
      for (const i of ids) lines += JSON.stringify({ t: 'record', rec: signRecord(i, { addrs, anchors: [], seq: 1, at: 1 }) }) + '\n';
      bad.socket.write(lines);
      await new Promise((r) => setImmediate(r));
    }
    bad.write({ t: 'ping' });
    assert.equal((await bad.next(10_000)).t, 'pong');
    // a new member comes and gives its own record
    const E = createIdentity('new-member');
    A.paired.add(E.fp);
    const e = await registered(A.gate.port, E, A.identity.fp);
    e.write({ t: 'record', rec: signRecord(E, { addrs, anchors: [], seq: 7, at: 7 }) });
    e.write({ t: 'ping' });
    assert.equal((await e.next()).t, 'pong');
    assert.equal(A.hub!.carried(E.fp)?.seq, 7, 'the new member\'s record is kept');
    bad.write({ t: 'who', fps: [E.fp], seqs: [0] });
    const got = await bad.next();
    assert.equal(got.t, 'record');
    assert.equal(got.rec.fp, E.fp, 'and handed to a member that asks');
    bad.socket.destroy(); e.socket.destroy();
  } finally {
    await w.close();
  }
});

test('#13 friends\' devices together leave 32 streams free: the person\'s own dials and dialLocal still get through', async () => {
  const friends = Array.from({ length: 8 }, (_, i) => createIdentity(`friend-${i}`));
  const friendFps = new Set(friends.map((f) => f.fp));
  const w = await world(undefined, { capped: (fp) => friendFps.has(fp) });
  const { A, B, C } = w;
  const open: Duplex[] = [];
  let m: AnchorMembership | null = null;
  try {
    for (const f of friends) A.paired.add(f.fp);
    // B (the person's own) is the target, piping into an echo server
    m = await joinAnchor({ anchor: w.ref, identity: B.identity, name: 'b', kind: 'pc', gatePort: w.echo.port });
    // eight friends at their 16 streams each would fill all 128
    let full = 0;
    for (const f of friends) {
      for (let i = 0; i < 16; i++) {
        try { open.push(await dialAnchor(w.ref, f, B.identity.fp)); }
        catch (e) { assert.ok(e instanceof GateRefused && e.reason === 'full', String(e)); full++; }
      }
    }
    assert.equal(open.length, 96, 'friends stop at 128 - 32');
    assert.equal(full, 32);
    // the anchor's own dial and the person's own device (C, not capped) still get a stream
    const mine = await A.hub!.dialLocal(B.identity.fp);
    mine.write('mine');
    assert.equal((await readAtLeast(mine, 4)).toString(), 'mine');
    open.push(mine);
    const own = await dialAnchor(w.ref, C.identity, B.identity.fp);
    open.push(own);
    assert.equal(A.hub!.stats().streams, 98);
  } finally {
    for (const s of open) s.destroy();
    await m?.close();
    await w.close();
  }
});

test('#14 a member sets up at most 32 accepts at once: 100 `open`s from a dishonest anchor give at most 32 connections', async () => {
  const echo = await echoServer();
  const dir = tmp();
  const identity = createIdentity('dishonest-anchor');
  const paired = new Paired(path.join(dir, 'paired'));
  const member = createIdentity('member');
  paired.add(member.fp);
  let accepts = 0;
  // an anchor that asks for 100 streams at once and never answers an accept
  class Dishonest extends AnchorHub {
    override async serve(socket: Duplex, reader: LineReader, _who: { fp: string; peer: string }, done: () => void): Promise<void> {
      socket.on('error', () => {});
      let msg: any;
      try { msg = JSON.parse(await reader.line(3000)); } catch { socket.destroy(); return; }
      done();
      if (msg.t === 'accept') { accepts++; return; }   // held, never answered
      if (msg.t !== 'register') { socket.destroy(); return; }
      let lines = JSON.stringify({ t: 'registered' }) + '\n';
      for (let i = 0; i < 100; i++) lines += JSON.stringify({ t: 'open', sid: `s${i}`, from: 'ab'.repeat(32) }) + '\n';
      socket.write(lines);
      for (;;) { try { await reader.line(60_000); } catch { break; } }
    }
  }
  const hub = new Dishonest({ self: identity.fp, isMember: (fp) => paired.has(fp) });
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echo.port, tls: { identity, paired, pin: null, onPinUsed: () => {} }, anchor: hub });
  let connects = 0;
  const ref: AnchorRef = { host: '127.0.0.1', port: gate.port, fp: identity.fp, connect: async () => { connects++; return connectRemote('127.0.0.1', gate.port, 3000); } };
  const m = await joinAnchor({ anchor: ref, identity: member, name: 'm', kind: 'pc', gatePort: echo.port, timeoutMs: 3000, retryMs: 60_000 });
  try {
    await sleep(1000);
    const acceptConnections = connects - 1;   // the first is the control connection
    assert.ok(acceptConnections > 0, 'the member did accept');
    assert.ok(acceptConnections <= ANCHOR_ACCEPTS_IN_FLIGHT, `${acceptConnections} accept connections for 100 opens`);
    assert.ok(accepts <= ANCHOR_ACCEPTS_IN_FLIGHT);
  } finally {
    await m.close();
    hub.close();
    await gate.close();
    echo.close();
  }
});
