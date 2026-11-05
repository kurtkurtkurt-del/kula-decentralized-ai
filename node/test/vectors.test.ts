// The gate's vectors are owned by the Kotlin side (app/modules/kula-llama/tools/gate-vectors.json);
// node/test/gate-vectors.json is a copy for a checkout without the app. This test reads the
// original, byte for byte, when the app is in the same repository: the copy must be the
// same file, and the implementation must reproduce every vector of the original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { clientProof, serverProof } from '../src/gate.ts';

const copy = new URL('./gate-vectors.json', import.meta.url);
const original = new URL('../../app/modules/kula-llama/tools/gate-vectors.json', import.meta.url);

test('the copy is the kotlin file, byte for byte', { skip: !existsSync(original) && 'app/ is not beside node/ in this checkout' }, () => {
  assert.equal(readFileSync(copy, 'utf8'), readFileSync(original, 'utf8'));
});

test('every vector of the kotlin file holds against gate.ts', { skip: !existsSync(original) && 'app/ is not beside node/ in this checkout' }, () => {
  const { note, vectors } = JSON.parse(readFileSync(original, 'utf8'));
  assert.match(note, /HMAC-SHA256/);
  assert.ok(vectors.length >= 3);
  const seen = new Set<string>();
  for (const v of vectors) {
    assert.equal(typeof v.secret, 'string');
    assert.match(v.nonce_c, /^[0-9a-f]{32}$/);
    assert.match(v.nonce_s, /^[0-9a-f]{32}$/);
    assert.ok(['rpc', 'api'].includes(v.channel), v.channel);
    assert.equal(clientProof(v.secret, v.nonce_c, v.nonce_s, v.channel), v.hmac_c, `hmac_c of ${v.channel}`);
    assert.equal(serverProof(v.secret, v.nonce_c, v.nonce_s, v.channel), v.hmac_s, `hmac_s of ${v.channel}`);
    assert.notEqual(v.hmac_c, v.hmac_s, 'the two proofs differ (nonce order)');
    seen.add(`${v.secret}/${v.nonce_c}/${v.nonce_s}/${v.channel}`);
  }
  assert.equal(seen.size, vectors.length, 'no vector twice');
  // the channel is part of the message: the same nonces on the other channel give another proof
  const v = vectors[0];
  assert.notEqual(clientProof(v.secret, v.nonce_c, v.nonce_s, v.channel === 'rpc' ? 'api' : 'rpc'), v.hmac_c);
});
