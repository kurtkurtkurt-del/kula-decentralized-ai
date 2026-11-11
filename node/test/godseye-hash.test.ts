// god's eye's own bytes (11.11.2026): the plain-TypeScript sha256 and base64 the eye uses on a
// computer and on a phone are node's, byte for byte, and quick enough for a look every 5 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const { sha256Hex, fromBase64, utf8 } = await import('../src/godseye/hash.ts');

test('sha256 and base64 match node on random bytes, odd text and every block boundary', () => {
  for (let i = 0; i < 1500; i++) {
    const b = randomBytes(i % 200);
    const s = b.toString('base64') + 'é😀\ud800x\udc00'.repeat(i % 3);
    assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'), `text ${i}`);
    assert.equal(sha256Hex(new Uint8Array(b)), createHash('sha256').update(b).digest('hex'), `bytes ${i}`);
    assert.deepEqual(Buffer.from(utf8(s)), Buffer.from(s, 'utf8'), `utf8 ${i}`);
    for (const b64 of [b.toString('base64'), b.toString('base64url'), ` ${b.toString('base64')}\n`]) {
      assert.deepEqual(Buffer.from(fromBase64(b64)), Buffer.from(b64, 'base64'), `base64 ${i}`);
    }
  }
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('a look\'s twelve view digests cost well under a millisecond each', () => {
  const view = JSON.stringify({ built: true, stat: 'x', rows: Array.from({ length: 40 }, (_, i) => [`row ${i}`, 'é'.repeat(30)]) });
  const t = performance.now();
  for (let i = 0; i < 1200; i++) sha256Hex(view);
  const each = (performance.now() - t) / 1200;
  assert.ok(each < 1, `${each} ms a digest of ${view.length} chars`);
});
