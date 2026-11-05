// The ledger chain under random input: any sequence of entries verifies; one changed byte
// anywhere fails verification; the line text is a stable, order keeping serialisation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fromSeed, generate } from '../src/audit/key.ts';
import { GENESIS, KINDS, makeLine, sha256Hex, unsignedOf, verifyLines, type Fields, type Kind } from '../src/audit/ledger.ts';
import { verifyChain as phoneVerifyChain, parseLine as phoneParseLine, sha256Hex as phoneSha256 } from '../../app/src/llm/audit.ts';

const key = generate();
const kind = fc.constantFrom(...KINDS) as fc.Arbitrary<Kind>;
const peer = fc.oneof(fc.ipV4(), fc.ipV6(), fc.string({ maxLength: 20 }));
const value = fc.oneof(fc.string({ maxLength: 30 }), fc.string({ unit: 'binary', maxLength: 10 }), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.boolean(), fc.constant(null));
const fieldName = fc.oneof(fc.constantFrom('channel', 'why', 'bytes', 'seconds', 'sha', 'fp', 'ramMb', 'tps', 't', 'kind', 'peer', 'prev', 'sig'), fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,10}$/), fc.string({ maxLength: 8 }));
const fields = fc.dictionary(fieldName, value, { maxKeys: 6 }) as fc.Arbitrary<Fields>;
const entry = fc.record({ t: fc.integer({ min: 0, max: 4e12 }), kind, peer, fields });

function sigOf(line: string): Buffer | null {
  const m = /,"sig":"([A-Za-z0-9+/=]*)"\}$/.exec(line);
  return m ? Buffer.from(m[1], 'base64') : null;
}
function sameSigBytes(a: string, b: string): boolean {
  const x = sigOf(a), y = sigOf(b);
  return !!x && !!y && x.equals(y) && a.slice(0, a.lastIndexOf(',"sig"')) === b.slice(0, b.lastIndexOf(',"sig"'));
}

function chain(entries: { t: number; kind: Kind; peer: string; fields: Fields }[]): string[] {
  let prev = GENESIS;
  return entries.map((e) => {
    const { line } = makeLine(key, e.t, e.kind, e.peer, e.fields, prev);
    prev = sha256Hex(line);
    return line;
  });
}

test('fuzz: any sequence of entries makes a chain that verifies, here and on the phone', () => {
  fc.assert(fc.property(fc.array(entry, { maxLength: 12 }), (entries) => {
    const lines = chain(entries);
    const r = verifyLines(lines, key.publicKey);
    assert.deepEqual(r.problems, []);
    assert.equal(r.count, entries.length);
    const phone = phoneVerifyChain(lines);
    assert.equal(phone.ok, true);
    assert.equal(phone.fromGenesis, true);
    for (const l of lines) {
      const p = phoneParseLine(l);
      assert.ok(p, l);
      assert.equal(phoneSha256(l), sha256Hex(l));
    }
    // reserved names in fields never displace the header
    lines.forEach((l, i) => {
      const o = JSON.parse(l);
      assert.equal(o.t, entries[i].t);
      assert.equal(o.kind, entries[i].kind);
      assert.equal(o.peer, entries[i].peer);
      assert.deepEqual(Object.keys(o).slice(0, 3), ['t', 'kind', 'peer']);
      assert.deepEqual(Object.keys(o).slice(-2), ['prev', 'sig']);
    });
  }), { numRuns: 200 });
});

test('fuzz: one changed character anywhere in any line fails verification with the key', () => {
  fc.assert(fc.property(fc.array(entry, { minLength: 1, maxLength: 8 }), fc.nat(), fc.nat(), fc.integer({ min: 33, max: 126 }), (entries, li, ci, ch) => {
    const lines = chain(entries);
    const i = li % lines.length;
    const line = lines[i];
    const j = ci % line.length;
    const c = String.fromCharCode(ch);
    fc.pre(c !== line[j]);
    const mutated = [...lines];
    mutated[i] = line.slice(0, j) + c + line.slice(j + 1);
    // a flip inside the signature's base64 that only touches padding bits decodes to the
    // same signature: not a change of the record, so not something verification can see
    fc.pre(!sameSigBytes(line, mutated[i]));
    const r = verifyLines(mutated, key.publicKey);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.n === i + 1), JSON.stringify(r.problems));
    // without the key the chain alone catches it unless it is the last line
    if (i < lines.length - 1) {
      assert.equal(verifyLines(mutated, null).ok, false);
      const phone = phoneVerifyChain(mutated);
      assert.equal(phone.ok, false);
      assert.ok(phone.broken === i || phone.broken === i + 1, `broken at ${phone.broken}, expected ${i} or ${i + 1}`);
    }
  }), { numRuns: 400 });
});

test('fuzz: dropping or swapping a line breaks the chain', () => {
  fc.assert(fc.property(fc.array(entry, { minLength: 2, maxLength: 8 }), fc.nat(), (entries, k) => {
    const lines = chain(entries);
    const i = k % lines.length;
    const dropped = lines.filter((_, n) => n !== i);
    // dropping the last line leaves a shorter but valid chain; every other drop shows
    if (i < lines.length - 1) {
      assert.equal(verifyLines(dropped, null).ok, false);
      // the phone reads a tail window and does not check the first line's prev: dropping
      // the very first line only shows as "not from genesis"
      const phone = phoneVerifyChain(dropped);
      if (i === 0) assert.equal(phone.fromGenesis, false);
      else assert.equal(phone.ok, false);
    }
    if (lines.length >= 2) {
      const swapped = [...lines];
      const a = i, b = (i + 1) % lines.length;
      [swapped[a], swapped[b]] = [swapped[b], swapped[a]];
      assert.equal(verifyLines(swapped, null).ok, false);
      assert.equal(phoneVerifyChain(swapped).ok, false);
    }
  }), { numRuns: 200 });
});

test('fuzz: serialisation is stable: same input, same bytes; the signed part is what unsignedOf finds', () => {
  fc.assert(fc.property(entry, fc.stringMatching(/^[0-9a-f]{64}$/), (e, prev) => {
    const a = makeLine(key, e.t, e.kind, e.peer, e.fields, prev);
    const b = makeLine(key, e.t, e.kind, e.peer, e.fields, prev);
    // ed25519 is deterministic; p256 is not, so compare the unsigned part
    assert.equal(unsignedOf(a.line), unsignedOf(b.line));
    assert.ok(unsignedOf(a.line)!.endsWith(`"prev":"${prev}"`));
    assert.deepEqual(JSON.parse(a.line), a.entry);
    // the body re-serialises to the same text: no ambiguity another writer could exploit
    const o = JSON.parse(a.line);
    delete o.sig;
    assert.equal(JSON.stringify(o) + '', unsignedOf(a.line) + '}');
  }), { numRuns: 300 });
});

test('fuzz: lines that are not json or not ledger lines are reported, never thrown', () => {
  fc.assert(fc.property(fc.array(fc.oneof(fc.string({ maxLength: 60 }), fc.string({ unit: 'binary', maxLength: 30 }), fc.json()), { maxLength: 6 }), (lines) => {
    const clean = lines.map((l) => l.replace(/\n/g, ' '));
    const r = verifyLines(clean, key.publicKey);
    assert.equal(typeof r.ok, 'boolean');
    const phone = phoneVerifyChain(clean);
    assert.equal(typeof phone.ok, 'boolean');
    for (const l of clean) assert.doesNotThrow(() => phoneParseLine(l));
  }), { numRuns: 300 });
});

test('the kotlin vectors verify through both readers and a flipped byte in each fails', () => {
  const v = JSON.parse(readFileSync(new URL('./audit-vectors.json', import.meta.url), 'utf8'));
  const k = fromSeed(Buffer.from(v.key.seed, 'hex'));
  const lines: string[] = v.lines.map((l: { line: string }) => l.line);
  assert.equal(verifyLines(lines, k.publicKey).ok, true);
  assert.equal(phoneVerifyChain(lines).ok, true);
  for (let i = 0; i < lines.length; i++) {
    for (const j of [5, Math.floor(lines[i].length / 2), lines[i].length - 3]) {
      const m = [...lines];
      const c = lines[i][j] === 'a' ? 'b' : 'a';
      m[i] = lines[i].slice(0, j) + c + lines[i].slice(j + 1);
      if (!sameSigBytes(lines[i], m[i])) assert.equal(verifyLines(m, k.publicKey).ok, false, `line ${i} pos ${j}`);
    }
  }
});

// regressions found by the properties above (5.11.2026)
test('regression: a field named like an integer does not jump in front of t/kind/peer', () => {
  const { line } = makeLine(key, 1, 'pair', 'p', { '0': false, channel: 'rpc' }, GENESIS);
  assert.ok(line.startsWith('{"t":1,"kind":"pair","peer":"p","channel":"rpc","prev":"'));
  assert.equal(JSON.parse(line)['0'], undefined);
});

test('regression: json that is not an object is a json problem, not a crash', () => {
  for (const l of ['null', '7', '"x"', '[]', 'true']) {
    const r = verifyLines([l], key.publicKey);
    assert.deepEqual(r.problems, [{ n: 1, reason: 'json' }]);
  }
});
