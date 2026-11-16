// Security review D4 group 1 (17 Nov): the ledger and the log under a flood. Refusals are
// rate-limited inside Auditor.reject (one line per address prefix and reason per window, `n`
// saying how many it stands for, a ceiling in all), the brain's gate watch counts `n`; a
// stranger knocking on the anchor channel is a signed reject line with channel 'anchor'; a
// refusal over an anchor leg carries the client's fingerprint; the replay rings are capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreate, generate } from '../src/audit/key.ts';
import { Ledger, verifyChain, readLines, chainFiles } from '../src/audit/ledger.ts';
import { Auditor, rejectPrefix } from '../src/audit/auditor.ts';
import { ReplayCheck } from '../src/audit/checks.ts';
import { hostGate, hostLedger } from '../src/ui/godseye-feed.ts';
import { ledgerAnchorRefusal, ledgerGateReject } from '../src/share.ts';
import { startGateServer, handshake, GateRefused, type GateServer, type TlsServer } from '../src/gate.ts';
import { createIdentity, Paired, type GateIdentity } from '../src/tls.ts';
import { AnchorHub, circleMembers, dialAnchor, joinAnchor, type AnchorRef } from '../src/anchor.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-ledger-flood-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rejects = (file: string) => chainFiles(file).flatMap(readLines).map((l) => JSON.parse(l)).filter((o) => o.kind === 'reject');
const nOf = (o: { n?: number }) => o.n ?? 1;

test('2000 refusals from one address in a second: at most 3 lines, n sums to 2000, the chain verifies, the gate watch counts 2000', () => {
  const dir = tmp();
  const was = process.env.KULA_NODE_HOME;
  process.env.KULA_NODE_HOME = dir;
  try {
    const key = loadOrCreate(path.join(dir, 'device_key.pem'));
    const file = path.join(dir, 'ledger.jsonl');
    let now = Date.now();
    const L = new Ledger(file, key, () => now);
    const logs: string[] = [];
    const A = new Auditor({ ledger: L, now: () => now, log: (s) => logs.push(s), limit: true });
    const start = now;
    for (let i = 0; i < 2000; i++) { now = start + Math.floor(i / 2); A.reject('203.0.113.9', 'no hello', { channel: 'api' }); }
    A.flush();
    const lines = rejects(file);
    assert.ok(lines.length <= 3, `${lines.length} lines`);
    assert.equal(lines.reduce((s, o) => s + nOf(o), 0), 2000);
    for (const o of lines) { assert.equal(o.kind, 'reject'); assert.equal(o.peer, '203.0.113.9'); assert.equal(o.reason, 'no hello'); assert.equal(o.channel, 'api'); }
    assert.ok(logs.length <= 3, 'one log line per ledger line');
    assert.equal(verifyChain(file, key.publicKey).ok, true);
    // the brain's gate watch counts what each line stands for
    assert.equal(hostLedger(file)!.ok, true);
    const g = hostGate()!;
    let by = 0, far = 0;
    for (const h of g.hours) { by += h.by['no hello'] ?? 0; far += h.far; }
    assert.equal(by, 2000);
    assert.equal(far, 2000);
    assert.equal(g.nets, 1);
  } finally {
    if (was === undefined) delete process.env.KULA_NODE_HOME; else process.env.KULA_NODE_HOME = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('held refusals are written by the clock when the window ends; the ceiling holds many addresses back and loses none', async () => {
  const dir = tmp();
  try {
    const key = generate();
    const file = path.join(dir, 'ledger.jsonl');
    const A = new Auditor({ ledger: new Ledger(file, key), limit: { windowMs: 60 } });
    for (let i = 0; i < 100; i++) A.reject('2001:db8:1:2::9', 'not paired');
    assert.equal(rejects(file).length, 1);
    await sleep(200);
    const l1 = rejects(file);
    assert.equal(l1.length, 2, 'the held ones on one line, by the clock');
    assert.equal(l1[1].n, 99);
    // 100 distinct /24s: 32 lines at once, the rest held, none lost
    const f2 = path.join(dir, 'l2.jsonl');
    const B = new Auditor({ ledger: new Ledger(f2, key), limit: { linesPerWindow: 32, keys: 50 } });
    for (let i = 0; i < 100; i++) B.reject(`198.51.${i}.7`, 'tls');
    assert.equal(rejects(f2).length, 32);
    B.flush();
    const l2 = rejects(f2);
    assert.equal(l2.reduce((s, o) => s + nOf(o), 0), 100);
    assert.ok(l2.some((o) => o.mixed === true), 'past the held prefixes, one mixed line');
    assert.equal(verifyChain(f2, key.publicKey).ok, true);
    // the prefixes: ipv4 /24, ipv6 /56, a mapped ipv4 as ipv4
    assert.equal(rejectPrefix('::ffff:203.0.113.4'), rejectPrefix('203.0.113.200'));
    assert.equal(rejectPrefix('2001:db8:aa:12ff::1'), rejectPrefix('2001:db8:aa:1200:ffff::9'));
    assert.notEqual(rejectPrefix('2001:db8:aa:1200::1'), rejectPrefix('2001:db8:aa:1300::1'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('10 000 peers leave at most 4096 replay rings; the newest still catch a replay', () => {
  const r = new ReplayCheck();
  for (let i = 0; i < 10_000; i++) assert.equal(r.check(`2001:db8::${i.toString(16)}`, `n${i}`), null);
  assert.ok(r.count <= 4096, `${r.count} rings`);
  assert.equal(r.check(`2001:db8::${(9999).toString(16)}`, 'n9999'), 'replay');
});

interface Home { dir: string; identity: GateIdentity; paired: Paired; tls: TlsServer; gate: GateServer; hub: AnchorHub | null; file: string; auditor: Auditor }

async function home(name: string, anchor: boolean): Promise<Home> {
  const dir = tmp();
  const identity = createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const t: TlsServer = { identity, paired, pin: null, onPinUsed: () => {} };
  const file = path.join(dir, 'ledger.jsonl');
  const auditor = new Auditor({ ledger: new Ledger(file, generate()), limit: true });
  const hub = anchor ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, path.join(dir, 'peers.json')) }) : null;
  // share's own wiring: every refused handshake and a stranger at the anchor's door into the ledger
  const gate = await startGateServer({
    port: 0, host: '127.0.0.1', secret: null, targets: () => null, tls: t, anchor: hub ?? undefined,
    onEvent: (e) => { if (e.type === 'reject') ledgerGateReject(auditor, e); },
    onAnchor: hub ? (e) => { ledgerAnchorRefusal(auditor, (fp) => hub.isMember(fp), e); } : undefined,
  });
  return { dir, identity, paired, tls: t, gate, hub, file, auditor };
}

test('a non-member\'s KULA2 anchor hello is one reject line with channel anchor; a member\'s refusal is not ledgered', async () => {
  const A = await home('anchor', true);
  const B = await home('member', false);
  try {
    A.paired.add(B.identity.fp);
    const ref: AnchorRef = { host: '127.0.0.1', port: A.gate.port, fp: A.identity.fp };
    const stranger = createIdentity('stranger');
    await assert.rejects(dialAnchor(ref, stranger, B.identity.fp), (e: unknown) => e instanceof GateRefused && e.reason === 'not paired');
    // a member dialing nobody is refused 'not here': unsigned log only
    await assert.rejects(dialAnchor(ref, B.identity, 'ab'.repeat(32)));
    await sleep(50);
    const lines = rejects(A.file);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].channel, 'anchor');
    assert.equal(lines[0].reason, 'not paired');
    assert.equal(lines[0].peer, '127.0.0.1');
    assert.equal(lines[0].fp, stranger.fp.slice(0, 16));
  } finally {
    await A.gate.close(); await B.gate.close(); A.hub?.close();
    for (const h of [A, B]) fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('a reject through an anchor leg carries the client\'s fingerprint; peer stays the plain ip', async () => {
  const A = await home('anchor', true);
  const B = await home('member-b', false);
  const C = await home('member-c', false);
  const ref: AnchorRef = { host: '127.0.0.1', port: A.gate.port, fp: A.identity.fp };
  A.paired.add(B.identity.fp);
  A.paired.add(C.identity.fp);
  const m = await joinAnchor({ anchor: ref, identity: B.identity, name: 'member-b', kind: 'pc', gatePort: B.gate.port });
  try {
    // C is a member of the anchor but not paired with B, and B has no code open
    const d = await dialAnchor(ref, C.identity, B.identity.fp);
    await assert.rejects(handshake(d, '', 'api', 3000, undefined, { identity: C.identity, fp: B.identity.fp }), (e: unknown) => e instanceof GateRefused && e.reason === 'not paired');
    await sleep(100);
    const lines = rejects(B.file);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].reason, 'not paired');
    assert.equal(lines[0].peer, '127.0.0.1');
    assert.equal(lines[0].fp, C.identity.fp.slice(0, 16));
  } finally {
    await m.close();
    for (const h of [A, B, C]) await h.gate.close();
    A.hub?.close();
    for (const h of [A, B, C]) fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
