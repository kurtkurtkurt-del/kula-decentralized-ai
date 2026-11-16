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
import { startGateServer, handshake, probe, GateRefused, FP_MISMATCH, type GateServer, type TlsServer } from '../src/gate.ts';
import { createIdentity, newPin, Paired, type GateIdentity } from '../src/tls.ts';
import { AnchorHub, circleMembers, dialAnchor, joinAnchor, type AnchorCaps, type AnchorEvent, type AnchorMembership, type AnchorRef } from '../src/anchor.ts';

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

async function home(name: string, echoPort: number, anchor?: { caps?: Partial<AnchorCaps>; tap?: (dir: 'd→t' | 't→d', b: Buffer) => void; events?: AnchorEvent[] }): Promise<Home> {
  const dir = tmp();
  const identity = createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const t: TlsServer = { identity, paired, pin: newPin(), onPinUsed: () => {} };
  const hub = anchor ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, path.join(dir, 'peers.json')), caps: anchor.caps, tap: anchor.tap }) : null;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echoPort, tls: t, anchor: hub ?? undefined, onAnchor: anchor?.events ? (e) => anchor.events!.push(e) : undefined });
  return { name, dir, identity, paired, tls: t, gate, hub };
}

async function world(caps?: Partial<AnchorCaps>) {
  const echo = await echoServer();
  const taps: { dir: 'd→t' | 't→d'; b: Buffer }[] = [];
  const events: AnchorEvent[] = [];
  const A = await home('anchor-berlin', echo.port, { caps, tap: (dir, b) => taps.push({ dir, b: Buffer.from(b) }), events });
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
  // dials a minute, per member
  {
    const w = await world({ dialsPerMinute: 3 });
    try {
      await w.join(w.B, w.B.gate.port);
      await w.join(w.C, w.C.gate.port);
      for (let i = 0; i < 3; i++) (await dialAnchor(w.ref, w.C.identity, w.B.identity.fp)).destroy();
      await assert.rejects(dialAnchor(w.ref, w.C.identity, w.B.identity.fp), refused('too many dials'));
      (await dialAnchor(w.ref, w.B.identity, w.C.identity.fp)).destroy();
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
