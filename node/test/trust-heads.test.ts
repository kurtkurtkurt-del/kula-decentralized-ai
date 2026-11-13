// L9 P51: the engine keeps one ledger hash per device across its own restarts (trust-heads.ts).
// Every file goes to a tmp dir; KULA_NODE_HOME points there too, so nothing reaches ~/.kula-node.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-trust-heads-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { saneHeads, readHeads, writeHeads, startOf, nextHead, HEADS_MAX } = await import('../src/ui/trust-heads.ts');
const { foldTrust, Engine } = await import('../src/ui/engine.ts');
const { sha256Hex } = await import('../src/audit/ledger.ts');

const hex = (c: string) => c.repeat(64);
const U = hex('a');
// lines chained from [from]: {"prev": sha256Hex(line before), "n": i}
function chain(from: string, n: number, start = 0): string[] {
  const out: string[] = [];
  let prev = from;
  for (let i = 0; i < n; i++) { const l = JSON.stringify({ prev, n: start + i }); out.push(l); prev = sha256Hex(l); }
  return out;
}
const ok = (over: object = {}) => ({ ...foldTrust(null, {}, 5), upTo: U, ...over });

test('saneHeads: a round trip, mode 600, bad shapes and the 501st dropped, a missing file empty', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'h-'));
  const file = path.join(dir, 'trust-heads.json');
  assert.equal(readHeads(file).size, 0, 'missing file');
  const m = new Map([['p1', U], ['p2', hex('b')]]);
  assert.equal(writeHeads(file, m), true);
  assert.deepEqual([...readHeads(file)], [...m]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).length, 1, 'no tmp file left');

  const bad = saneHeads({ v: 1, heads: { '': U, [`x${'y'.repeat(200)}`]: U, up: U.toUpperCase(), short: 'abc', num: 7, good: U } });
  assert.deepEqual([...bad], [['good', U]]);
  for (const raw of [null, 7, 'x', [], { v: 2, heads: { a: U } }, { v: 1 }, { v: 1, heads: [U] }, { v: 1, heads: null }]) assert.equal(saneHeads(raw).size, 0, JSON.stringify(raw));
  fs.writeFileSync(file, '{not json');
  assert.equal(readHeads(file).size, 0, 'bad file');

  const many: Record<string, string> = {};
  for (let i = 0; i < HEADS_MAX + 1; i++) many[`d${i}`] = U;
  const s = saneHeads({ v: 1, heads: many });
  assert.equal(s.size, HEADS_MAX);
  assert.equal(s.has(`d${HEADS_MAX}`), false, 'the 501st dropped');
  assert.equal(writeHeads(path.join(file, 'under-a-file', 'x.json'), m), false, 'false, not a throw');
});

test('startOf: an ok look itself, else a seed at the kept hash, else null', () => {
  const look = ok();
  assert.equal(startOf(look, hex('c')), look);
  const seed = startOf(null, U)!;
  assert.equal(seed.upTo, U);
  assert.deepEqual(seed.lines, []);
  assert.equal(seed.error, null);
  assert.equal(seed.restartedAt, null);
  assert.deepEqual({ ...seed, upTo: null }, foldTrust(null, {}, 0), 'the fields foldTrust(null, {}, 0) gives');
  const attest = { at: 3, ok: true, why: null as any, text: 'fine' };
  const failed = { ...ok({ attest }), error: 'no answer: x' };
  assert.deepEqual(startOf(failed, U)!.attest, attest);
  assert.equal(startOf(failed, U)!.error, null);
  assert.equal(startOf(null, null), null);
  assert.equal(startOf(failed, null), null);
});

test('nextHead: errored end leaves, no start or a restart forgets, else one look behind', () => {
  const start = ok();
  assert.equal(nextHead(start, { ...ok(), error: 'no answer' }), undefined);
  assert.equal(nextHead(null, ok()), null);
  assert.equal(nextHead(start, ok({ restartedAt: 9 })), null);
  assert.equal(nextHead(start, ok({ upTo: hex('d') })), U);
});

test('foldTrust onto a seed: joined, unlinked, started over, nothing new', () => {
  const seed = () => startOf(null, U)!;
  const three = chain(U, 3);
  const j = foldTrust(seed(), { ledger: { found: true, lines: three } }, 50);
  assert.deepEqual(j.lines, three);
  assert.equal(j.restartedAt, null);
  assert.equal(j.upTo, sha256Hex(three[2]));
  assert.equal(foldTrust(seed(), { ledger: { found: true, lines: chain(hex('e'), 3) } }, 51).restartedAt, 51, 'unlinked first line');
  assert.equal(foldTrust(seed(), { ledger: { found: false, lines: chain(hex('e'), 2) } }, 52).restartedAt, 52, 'found false');
  const none = foldTrust(seed(), { ledger: { found: true, lines: [] } }, 53);
  assert.equal(none.upTo, U);
  assert.equal(none.restartedAt, null);
});

test('wiring: a restarted engine asks since the hash its last run kept, and trustOf is null before', async () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'w-'));
  const ledger = chain('0'.repeat(64), 5);
  const asked: (string | null)[] = [];
  const srv = http.createServer((req, res) => {
    const since = new URL(req.url!, 'http://x').searchParams.get('since');
    asked.push(since);
    const at = since ? ledger.findIndex((l) => sha256Hex(l) === since) + 1 : 0;
    const lines = since ? ledger.slice(at) : ledger.slice(0, 3);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'p1', ledger: since ? { found: at > 0, lines } : { lines } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const opts = { peersFile: path.join(dir, 'peers.json'), pairedFile: path.join(dir, 'paired') };
  const peer = { id: 'p1' } as any;
  try {
    const a = new Engine(opts);
    await (a as any).askTrust(peer, port, 2000);
    await (a as any).askTrust(peer, port, 2000);
    const firstUpTo = sha256Hex(ledger[2]);
    assert.deepEqual(asked, [null, firstUpTo]);
    await a.close();
    assert.deepEqual([...readHeads(path.join(dir, 'trust-heads.json'))], [['p1', firstUpTo]], 'default file beside pairedFile');

    const b = new Engine(opts);
    assert.equal(b.trustOf('p1'), null, 'a seed is not a look');
    await (b as any).askTrust(peer, port, 2000);
    assert.equal(asked[2], firstUpTo, 'since the kept hash on the first look');
    assert.deepEqual(b.trustOf('p1')!.lines, ledger.slice(3));
    assert.equal(b.trustOf('p1')!.restartedAt, null, 'joined, not a gap');
    await b.close();
  } finally { srv.close(); }
});
