// GET /trust on the worker api: the device key, the certificate, the gate's state and the
// signed ledger, with and without `since`. The phone's ApiServer.kt answers the same shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import { startApiServer } from '../src/api.ts';
import { generate } from '../src/audit/key.ts';
import { Ledger, sha256Hex, readLines, chainFiles, GENESIS } from '../src/audit/ledger.ts';
import { Auditor } from '../src/audit/auditor.ts';
import { loadOrCreateIdentity, Paired } from '../src/tls.ts';
import { v1Open, type TlsServer } from '../src/gate.ts';
import type { TrustSource } from '../src/trust.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-trust-'));

test('/trust: key, id, certificate, gate state, the ledger by since, the rejects of the day; nothing secret', async () => {
  const dir = tmp();
  const key = generate();
  const identity = loadOrCreateIdentity(dir, key, () => {});
  const tlsServer: TlsServer = { identity, paired: new Paired(null), pin: 'deadbeefdeadbeef' };
  const secret = '0123456789abcdef0123456789abcdef';
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  let now = 1_800_000_000_000;
  // small files: the ledger rotates, the chain runs across files
  const ledger = new Ledger(ledgerFile, key, () => now, 20_000);
  const auditor = new Auditor({ ledger, now: () => now });
  auditor.reject('10.0.0.9', 'wrong secret');
  now += 25 * 3600 * 1000; // that one is older than a day
  for (let i = 0; i < 230; i++) { now += 1000; auditor.connect('10.0.0.7', 'api'); }
  for (const why of ['wrong pin', 'wrong secret', 'wrong pin', 'replay', 'clock', 'wrong pin']) { now += 1000; auditor.reject('10.0.0.8', why); }
  assert.ok(chainFiles(ledgerFile).length > 1, 'rotated');
  const src: TrustSource = {
    key, ledgerFile, now: () => now,
    cert: () => tlsServer.identity.certDer,
    gate: () => ({ v1: v1Open(secret, tlsServer), tls: true, paired: tlsServer.paired.size }),
  };
  const api = await startApiServer({ models: dir, llama: null, trust: src });
  const get = async (q = '') => { const r = await fetch(`http://127.0.0.1:${api.port}/trust${q}`); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
  try {
    const all = chainFiles(ledgerFile).flatMap(readLines);
    assert.equal(all.length, 237);
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.type, 'application/json');
    const b = JSON.parse(r.text);
    // the field order is the contract
    assert.deepEqual(Object.keys(b), ['v', 'id', 'key', 'cert', 'gate', 'ledger', 'rejects']);
    assert.deepEqual(Object.keys(b.key), ['alg', 'pub', 'store']);
    assert.deepEqual(Object.keys(b.gate), ['v1', 'tls', 'paired']);
    assert.deepEqual(Object.keys(b.ledger), ['count', 'head', 'self', 'found', 'more', 'lines']);
    assert.deepEqual(Object.keys(b.rejects), ['day', 'last']);
    assert.equal(b.v, 1);
    // id = sha256(spki of the device key)[:16] = the certificate's cn
    const pub = Buffer.from(b.key.pub, 'base64');
    assert.equal(createHash('sha256').update(pub).digest('hex').slice(0, 32), b.id);
    assert.equal(b.id, key.id);
    assert.equal(new X509Certificate(Buffer.from(b.cert, 'base64')).subject, `CN=${b.id}`);
    assert.equal(b.key.alg, key.alg);
    assert.equal(b.key.store, 'file');
    assert.ok(createPublicKey({ key: pub, format: 'der', type: 'spki' }));
    assert.deepEqual(b.gate, { v1: true, tls: true, paired: 0 });
    assert.equal(b.ledger.count, 237);
    assert.equal(b.ledger.head, sha256Hex(all.at(-1)!));
    assert.equal(b.ledger.self, 'ok');
    assert.equal(b.ledger.found, null);
    assert.equal(b.ledger.more, false);
    assert.deepEqual(b.ledger.lines, all.slice(-200), 'the last 200 lines, raw, oldest first');
    assert.deepEqual(b.rejects.day, { 'wrong pin': 3, 'wrong secret': 1, replay: 1, clock: 1 });
    assert.deepEqual(Object.keys(b.rejects.day), ['wrong pin', 'wrong secret', 'replay', 'clock']);
    assert.deepEqual(b.rejects.last.map((x: any) => x.why), ['wrong secret', 'wrong pin', 'replay', 'clock', 'wrong pin']);
    assert.deepEqual(Object.keys(b.rejects.last[0]), ['t', 'why', 'peer']);
    assert.equal(b.rejects.last[4].t, now);
    assert.equal(b.rejects.last[4].peer, '10.0.0.8');
    for (const s of [secret, 'deadbeefdeadbeef', 'PRIVATE KEY', key.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64').slice(-40)]) assert.ok(!r.text.includes(s), `${s.slice(0, 8)}… is in /trust`);

    // since: found, the lines after it, at most 200, `more` while there are more
    const s1 = await get(`?since=${sha256Hex(all[9])}`);
    const b1 = JSON.parse(s1.text);
    assert.equal(b1.ledger.found, true);
    assert.equal(b1.ledger.more, true);
    assert.deepEqual(b1.ledger.lines, all.slice(10, 210));
    const b2 = JSON.parse((await get(`?since=${sha256Hex(all[209])}`)).text);
    assert.deepEqual([b2.ledger.found, b2.ledger.more], [true, false]);
    assert.deepEqual(b2.ledger.lines, all.slice(210));
    const b3 = JSON.parse((await get(`?since=${b.ledger.head}`)).text);
    assert.deepEqual([b3.ledger.found, b3.ledger.more, b3.ledger.lines], [true, false, []]);
    // since not there: found false and the last 200
    const b4 = JSON.parse((await get(`?since=${'ab'.repeat(32)}`)).text);
    assert.deepEqual([b4.ledger.found, b4.ledger.more], [false, false]);
    assert.deepEqual(b4.ledger.lines, all.slice(-200));
    // a since that is not 64 lowercase hex
    for (const bad of ['?since=', '?since=AB' + 'ab'.repeat(31), '?since=abc', `?since=${'ab'.repeat(32)}0`]) {
      assert.deepEqual(await get(bad), { status: 400, type: 'application/json', text: '{"error":"bad since"}' }, bad);
    }

    // a paired device: v1 off, the count shows
    tlsServer.paired.add('cd'.repeat(32));
    assert.deepEqual(JSON.parse((await get()).text).gate, { v1: false, tls: true, paired: 1 });

    // a changed line: self is broken (the cache follows size and mtime)
    const live = chainFiles(ledgerFile).at(-1)!;
    const text = fs.readFileSync(live, 'utf8');
    fs.writeFileSync(live, text.replace('"peer":"10.0.0.8"', '"peer":"10.0.0.6"'));
    assert.equal(JSON.parse((await get()).text).ledger.self, 'broken');
    fs.writeFileSync(live, text);
    assert.equal(JSON.parse((await get()).text).ledger.self, 'ok');
  } finally {
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/trust on an empty ledger and without tls; no trust source: not found', async () => {
  const dir = tmp();
  const key = generate();
  const api = await startApiServer({ models: dir, llama: null, trust: { key, ledgerFile: path.join(dir, 'ledger.jsonl'), cert: () => null, gate: () => ({ v1: true, tls: false, paired: 0 }) } });
  const bare = await startApiServer({ models: dir, llama: null });
  try {
    const b = await (await fetch(`http://127.0.0.1:${api.port}/trust`)).json();
    assert.equal(b.cert, null);
    assert.deepEqual(b.ledger, { count: 0, head: GENESIS, self: 'empty', found: null, more: false, lines: [] });
    assert.deepEqual(b.rejects, { day: {}, last: [] });
    const nf = await fetch(`http://127.0.0.1:${bare.port}/trust`);
    assert.equal(nf.status, 404);
  } finally {
    await api.close(); await bare.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/trust?challenge: a computer has no hardware to vouch for it, so "attest" is null; asked badly, 400', async () => {
  const dir = tmp();
  const key = generate();
  const api = await startApiServer({ models: dir, llama: null, trust: { key, ledgerFile: path.join(dir, 'ledger.jsonl'), cert: () => null, gate: () => ({ v1: false, tls: true, paired: 1 }) } });
  try {
    const plain = await (await fetch(`http://127.0.0.1:${api.port}/trust`)).text();
    assert.ok(!plain.includes('"attest"'), 'not asked: no field, the bytes as before');
    const r = await fetch(`http://127.0.0.1:${api.port}/trust?challenge=${'ab'.repeat(32)}`);
    assert.equal(r.status, 200);
    assert.ok((await r.text()).endsWith(',"attest":null}'), 'last, and null');
    for (const bad of ['', 'AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32)]) {
      const b = await fetch(`http://127.0.0.1:${api.port}/trust?challenge=${bad}`);
      assert.equal(b.status, 400);
      assert.deepEqual(await b.json(), { error: 'bad challenge' });
    }
  } finally {
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
