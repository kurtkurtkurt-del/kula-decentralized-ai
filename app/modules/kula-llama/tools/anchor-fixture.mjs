#!/usr/bin/env node
// A real kula-node anchor on 127.0.0.1 for the phone's JVM test (android/src/test/.../AnchorNodeTest.kt):
// node/src's own gate, AnchorHub and AnchorHost, never a copy. Two homes in one process:
//   A  the anchor: a gate with the hub, invites and the pair-back (node/src/join.ts AnchorHost)
//   C  a far computer: its own gate (rpc and api pipe into an echo server), registered with A
//      (node/src/anchor.ts joinAnchor), so the phone can dial it through A, and it can dial the phone
// Run by the test with node's tsx (it imports the .ts sources):
//   node ../../../node/node_modules/tsx/dist/cli.mjs tools/anchor-fixture.mjs
// One JSON line per command on stdin, one JSON line per answer on stdout; the first line out is
// {"ready":true, ...}. Nothing leaves 127.0.0.1. Never part of the app.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-anchor-fixture-'));
process.env.KULA_NODE_HOME = HOME;
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../node/src');
const { startGateServer, handshake } = await import(path.join(src, 'gate.ts'));
const { createIdentity, Paired } = await import(path.join(src, 'tls.ts'));
const { AnchorHub, circleMembers, joinAnchor, dialAnchor } = await import(path.join(src, 'anchor.ts'));
const { OneTimeCodes, AnchorHost, pairBackCode, ringCapped } = await import(path.join(src, 'join.ts'));

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const log = [];

function echoServer() {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => s.close() }));
  });
}

async function home(name, echoPort, anchor) {
  const dir = fs.mkdtempSync(path.join(HOME, `${name}-`));
  const identity = createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const codes = new OneTimeCodes();
  const tls = { identity, paired, pin: null, codes, onPinUsed: () => {} };
  const peersFile = path.join(dir, 'peers.json');
  const hub = anchor ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, peersFile), capped: ringCapped(peersFile) }) : null;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echoPort, tls, anchor: hub ?? undefined });
  const host = hub ? new AnchorHost({ identity, codes, hub, peersFile, id: `id-${name}`, name, log: (s) => log.push(s) }) : null;
  return { name, identity, paired, gate, hub, host };
}

const echo = await echoServer();
const A = await home('anchor-berlin', echo.port, true);
const C = await home('laptop-far', echo.port, false);
// C is A's member and registers there
A.paired.add(C.identity.fp);
const refA = { host: '127.0.0.1', port: A.gate.port, fp: A.identity.fp };
const cLink = await joinAnchor({ anchor: refA, identity: C.identity, name: C.name, kind: 'pc', gatePort: C.gate.port });

// writes n random bytes into a handshaken socket and checks they come back (the echo behind the gate)
function roundTrip(sock, n) {
  return new Promise((resolve, reject) => {
    const data = randomBytes(n);
    const got = [];
    let len = 0;
    const t = setTimeout(() => reject(new Error(`timeout after ${len} bytes`)), 15000);
    sock.on('data', (d) => {
      got.push(d); len += d.length;
      if (len >= n) { clearTimeout(t); resolve(Buffer.concat(got).subarray(0, n).equals(data)); }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
    sock.resume();
    sock.write(data);
  });
}

const held = [];
async function run(c) {
  switch (c.cmd) {
    // the phone's certificate becomes a member of A and is paired with C (C may be used by it, and it uses C)
    case 'member': A.paired.add(c.fp); C.paired.add(c.fp); return { ok: true };
    case 'members': return { members: A.hub.members().map((m) => ({ fp: m.fp, kind: m.kind, name: m.name })) };
    case 'invite': {
      const inv = A.host.invite([{ host: '127.0.0.1', port: A.gate.port, via: 'mapped' }], {}, c.whose ?? 'mine');
      return { text: inv.text, code: inv.code, typed: inv.typed, pin: JSON.parse(inv.text).pin };
    }
    case 'pairedA': return { paired: A.paired.has(c.fp) };
    case 'pairBackCode': return { code: pairBackCode(c.pin) };
    // C (a computer far away) dials the phone through A and talks to its gate, pinned to the phone's certificate
    case 'dial': {
      const s = await dialAnchor(refA, C.identity, c.to);
      const h = await handshake(s, '', c.channel ?? 'rpc', 8000, undefined, { identity: C.identity, fp: c.to });
      const ok = await roundTrip(h.socket, c.bytes ?? 1000);
      if (c.hold) { held.push(h.socket); return { ok, held: held.length }; }
      h.socket.destroy();
      return { ok };
    }
    // A itself dials the phone through its own hub (the in-process hop, 'self'), as a second far master
    case 'dialSelf': {
      const s = await A.hub.dialLocal(c.to);
      try {
        const h = await handshake(s, '', c.channel ?? 'rpc', 8000, undefined, { identity: A.identity, fp: c.to });
        const ok = await roundTrip(h.socket, c.bytes ?? 1000);
        h.socket.destroy();
        return { ok };
      } catch (e) { s.destroy(); throw e; }
    }
    case 'release': for (const s of held.splice(0)) s.destroy(); return { ok: true };
    case 'log': return { log };
    case 'bye': return { ok: true };
    default: return { error: `unknown ${c.cmd}` };
  }
}

out({ ready: true, a: { port: A.gate.port, fp: A.identity.fp }, c: { port: C.gate.port, fp: C.identity.fp }, registered: cLink.registered });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let c;
  try { c = JSON.parse(line); } catch { return out({ error: 'bad json' }); }
  try { out({ id: c.id, ...(await run(c)) }); }
  catch (e) { out({ id: c.id, error: e?.reason ?? e?.message ?? String(e) }); }
  if (c.cmd === 'bye') shutdown();
});
rl.on('close', shutdown);
let gone = false;
async function shutdown() {
  if (gone) return;
  gone = true;
  for (const s of held) s.destroy();
  await cLink.close();
  A.host.close(); A.hub.close();
  await A.gate.close(); await C.gate.close();
  echo.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(0);
}
