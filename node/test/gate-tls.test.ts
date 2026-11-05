import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startGateServer, handshake, probe, Tunnel, pinProofClient, pinProofServer, GateRefused, FP_MISMATCH, type GateEvent, type TlsServer } from '../src/gate.ts';
import { createIdentity, loadOrCreateIdentity, selfSigned, tbsCertificate, spkiOf, fingerprint, Paired, newPin } from '../src/tls.ts';
import { generate as generateDeviceKey } from '../src/audit/key.ts';
import { generateKeyPairSync } from 'node:crypto';

// Protocol v2 (docs/GATE.md): the hand-written certificate against the shared vector, the
// pairing handshake inside tls 1.3, every refusal, and a v1 client on the same port. The
// Kotlin twin is GateTlsTest.kt.
const vectors = JSON.parse(readFileSync(new URL('./gate-vectors.json', import.meta.url), 'utf8'));

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-gate-'));

test('v2 pin proofs match the shared vectors', () => {
  assert.equal(vectors.v2.length, 2);
  for (const v of vectors.v2) {
    assert.equal(pinProofClient(v.pin, v.nonce_c, v.nonce_s, v.channel, v.fp_s, v.fp_c), v.proof_c);
    assert.equal(pinProofServer(v.pin, v.nonce_c, v.nonce_s, v.channel, v.fp_s, v.fp_c), v.proof_s);
  }
});

test('the tbs certificate matches the shared vector and the signed certificate parses', () => {
  const v = vectors.cert;
  const priv = createPrivateKey({ key: Buffer.from(v.pkcs8, 'hex'), format: 'der', type: 'pkcs8' });
  assert.equal(spkiOf(priv).toString('hex'), v.spki);
  const tbs = tbsCertificate(spkiOf(priv), v.cn, Buffer.from(v.serial, 'hex'), v.not_before_ms, v.not_after_ms);
  assert.equal(createHash('sha256').update(tbs).digest('hex'), v.tbs_sha256);
  const cert = new X509Certificate(selfSigned(priv, v.cn, Buffer.from(v.serial, 'hex'), v.not_before_ms, v.not_after_ms));
  assert.equal(cert.subject, `CN=${v.cn}`);
  assert.equal(cert.issuer, `CN=${v.cn}`);
  assert.equal(cert.serialNumber.toLowerCase(), v.serial);
  assert.equal(cert.ca, false);
  assert.ok(cert.verify(createPublicKey(priv)));
  assert.ok(cert.checkPrivateKey(priv));
  assert.equal(new Date(cert.validFrom).getTime(), v.not_before_ms);
  assert.equal(new Date(cert.validTo).getTime(), v.not_after_ms);
});

test('an identity is kept on disk and follows the device key', () => {
  const dir = tmp();
  const p256 = (() => { const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey; return { alg: 'p256' as const, id: 'ab'.repeat(16), privateKey: k, publicKey: createPublicKey(k) }; })();
  const a = loadOrCreateIdentity(dir, p256);
  assert.equal(new X509Certificate(a.certDer).subject, `CN=${p256.id}`);
  assert.ok(spkiOf(a.privateKey).equals(spkiOf(p256.privateKey)), 'a p-256 device key is the tls key');
  assert.equal(loadOrCreateIdentity(dir, p256).fp, a.fp, 'same fingerprint after a restart');
  const ed = generateDeviceKey();
  if (ed.alg === 'ed25519') {
    const dir2 = tmp();
    const b = loadOrCreateIdentity(dir2, ed);
    assert.equal(b.privateKey.asymmetricKeyType, 'ec', 'an ed25519 device key gets a p-256 gate key');
    assert.ok(fs.existsSync(path.join(dir2, 'gate_key.pem')));
    assert.equal(loadOrCreateIdentity(dir2, ed).fp, b.fp);
  }
  assert.equal(fingerprint(a.certDer), a.fp);
  assert.equal(a.fp.length, 64);
});

test('pairing with the code, then the certificate alone; strangers, wrong codes and wrong fingerprints are refused; v1 still works', async () => {
  const echo = await echoServer();
  const worker = createIdentity('worker');
  const master = createIdentity('master');
  const pairedFile = path.join(tmp(), 'paired');
  const pin = newPin();
  let pinUsed = 0;
  const t: TlsServer = { identity: worker, paired: new Paired(pairedFile), pin, onPinUsed: () => pinUsed++ };
  const events: GateEvent[] = [];
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 'v1-secret', targets: (ch) => (ch === 'rpc' ? echo.port : null), onEvent: (e) => events.push(e), tls: t });
  const at = (pin?: string | null, id = master, fp = worker.fp) => ({ identity: id, fp, pin });
  try {
    assert.deepEqual(await probe('127.0.0.1', gate.port, '', 'rpc', 2000, at()), { ok: false, reason: 'not paired' });
    assert.deepEqual(await probe('127.0.0.1', gate.port, '', 'rpc', 2000, at('0000000000000000')), { ok: false, reason: 'wrong pin' });
    assert.equal(pinUsed, 0);
    const first = await probe('127.0.0.1', gate.port, '', 'rpc', 2000, at(pin));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(pinUsed, 1);
    assert.equal(t.pin, null);
    assert.ok(t.paired.has(master.fp));
    assert.ok(fs.readFileSync(pairedFile, 'utf8').startsWith(master.fp));
    assert.ok(events.some((e) => e.type === 'pair' && e.fp === master.fp));
    // from now on the certificate alone, with or without the spent code
    assert.equal((await probe('127.0.0.1', gate.port, '', 'rpc', 2000, at())).ok, true);
    assert.equal((await probe('127.0.0.1', gate.port, '', 'rpc', 2000, at(pin))).ok, true);
    // a stranger with another certificate
    assert.deepEqual(await probe('127.0.0.1', gate.port, '', 'rpc', 2000, at(null, createIdentity('stranger'))), { ok: false, reason: 'not paired' });
    // the wrong fingerprint for the worker never reaches the hello
    assert.deepEqual(await probe('127.0.0.1', gate.port, '', 'rpc', 2000, at(null, master, 'ab'.repeat(32))), { ok: false, reason: FP_MISMATCH });
    // a closed channel answers inside tls
    assert.deepEqual(await probe('127.0.0.1', gate.port, '', 'api', 2000, at()), { ok: false, reason: 'channel closed' });
    // the paired list survives a restart
    assert.ok(new Paired(pairedFile).has(master.fp));
    // v1 on the same port
    assert.equal((await probe('127.0.0.1', gate.port, 'v1-secret', 'rpc')).ok, true);
    assert.deepEqual(await probe('127.0.0.1', gate.port, 'wrong', 'rpc'), { ok: false, reason: 'wrong secret' });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.some((e) => e.type === 'open' && e.v === 1) && events.some((e) => e.type === 'open' && e.v === 2 && e.fp === master.fp));
    assert.ok(events.some((e) => e.type === 'reject' && e.reason === 'wrong pin'));
  } finally {
    await gate.close();
    echo.close();
  }
});

test('replays, old clocks and malformed hellos are refused inside tls', async () => {
  const worker = createIdentity('worker');
  const master = createIdentity('master');
  const paired = new Paired(null);
  paired.add(master.fp);
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', targets: () => null, tls: { identity: worker, paired, pin: null } });
  const hello = (line: string) => new Promise<string>((resolve, reject) => {
    const s = tls.connect({ port: gate.port, host: '127.0.0.1', key: master.keyPem, cert: master.certPem, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, () => s.write(line + '\n'));
    let buf = '';
    s.on('data', (d: Buffer) => { buf += d.toString(); const i = buf.indexOf('\n'); if (i >= 0) { s.destroy(); resolve(buf.slice(0, i)); } });
    s.on('error', reject);
  });
  try {
    const nonce = '0123456789abcdef0123456789abcdef';
    const now = Date.now();
    assert.ok((await hello(`KULA2 rpc ${nonce} ${now}`)).endsWith(' paired'));
    assert.equal(await hello(`KULA2 rpc ${nonce} ${now}`), 'NO replay');
    assert.equal(await hello(`KULA2 rpc ${randomBytes(16).toString('hex')} ${now - 10 * 60_000}`), 'NO clock');
    assert.equal(await hello(`KULA2 rpc ${randomBytes(16).toString('hex')}`), 'NO bad hello');
    assert.equal(await hello(`KULA1 rpc ${randomBytes(16).toString('hex')} ${now}`), 'NO bad hello');
    assert.equal(await hello(`KULA2 ftp ${randomBytes(16).toString('hex')} ${now}`), 'NO bad channel');
    assert.equal(await hello(`KULA2 rpc xyz ${now}`), 'NO bad nonce');
  } finally {
    await gate.close();
  }
});

test('a client without a certificate is refused; a server without tls says so', async () => {
  const worker = createIdentity('worker');
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', targets: () => null, tls: { identity: worker, paired: new Paired(null), pin: 'abcd' } });
  const plain = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', targets: () => null });
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const s = tls.connect({ port: gate.port, host: '127.0.0.1', rejectUnauthorized: false, minVersion: 'TLSv1.3' }, () => s.write(`KULA2 rpc ${randomBytes(16).toString('hex')} ${Date.now()}\n`));
      let buf = '';
      s.on('data', (d: Buffer) => { buf += d.toString(); if (buf.includes('\n')) { s.destroy(); resolve(buf.trim()); } });
      s.on('error', reject);
    });
    assert.equal(answer, 'NO no client cert');
    const r = await probe('127.0.0.1', plain.port, '', 'rpc', 2000, { identity: createIdentity('m'), fp: 'ab'.repeat(32) });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /^tls /);
  } finally {
    await gate.close();
    await plain.close();
  }
});

test('the tls pipe carries 1 MB both ways through a Tunnel', async () => {
  const payloadOut = randomBytes(1 << 20);
  let gotAtTarget = Buffer.alloc(0);
  const target = net.createServer((c) => {
    c.write(payloadOut);
    c.on('data', (d: Buffer) => { gotAtTarget = Buffer.concat([gotAtTarget, d]); c.write(d); });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  const worker = createIdentity('worker');
  const master = createIdentity('master');
  const paired = new Paired(null);
  paired.add(master.fp);
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', targets: () => (target.address() as net.AddressInfo).port, tls: { identity: worker, paired, pin: null } });
  const tunnel = new Tunnel('127.0.0.1', gate.port, '', 'rpc', { identity: master, fp: worker.fp });
  const local = await tunnel.listen();
  try {
    const c = net.connect(local, '127.0.0.1');
    await new Promise((r) => c.once('connect', r));
    const payloadIn = randomBytes(1 << 20);
    for (let i = 0; i < payloadIn.length; i += 7777) c.write(payloadIn.subarray(i, i + 7777));
    const want = payloadOut.length + payloadIn.length;
    const got = await new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      let n = 0;
      c.on('data', (d: Buffer) => { parts.push(d); n += d.length; if (n >= want) resolve(Buffer.concat(parts)); });
    });
    assert.equal(got.length, want);
    assert.ok(got.subarray(0, payloadOut.length).equals(payloadOut));
    assert.ok(got.subarray(payloadOut.length).equals(payloadIn));
    assert.ok(gotAtTarget.equals(payloadIn));
    c.destroy();
  } finally {
    await tunnel.close();
    await gate.close();
    target.close();
  }
});

test('handshake over tls hands back the tls socket and bytes after the proof are not lost', async () => {
  let seen = Buffer.alloc(0);
  const target = net.createServer((c) => c.on('data', (d: Buffer) => { seen = Buffer.concat([seen, d]); }));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  const worker = createIdentity('worker');
  const master = createIdentity('master');
  const paired = new Paired(null);
  paired.add(master.fp);
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', targets: () => (target.address() as net.AddressInfo).port, tls: { identity: worker, paired, pin: null } });
  try {
    const raw = net.connect(gate.port, '127.0.0.1');
    await new Promise((r) => raw.once('connect', r));
    const { socket } = await handshake(raw, '', 'api', 2000, undefined, { identity: master, fp: worker.fp });
    assert.ok(socket instanceof tls.TLSSocket);
    assert.equal((socket as tls.TLSSocket).getProtocol(), 'TLSv1.3');
    socket.write('EARLY');
    await new Promise((r) => setTimeout(r, 100));
    socket.write(' LATE');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.toString(), 'EARLY LATE');
    socket.destroy();
    // and GateRefused carries the reason for a stranger
    const raw2 = net.connect(gate.port, '127.0.0.1');
    await new Promise((r) => raw2.once('connect', r));
    await assert.rejects(handshake(raw2, '', 'api', 2000, undefined, { identity: createIdentity('x'), fp: worker.fp }), (e: Error) => e instanceof GateRefused && e.reason === 'not paired');
  } finally {
    await gate.close();
    target.close();
  }
});
