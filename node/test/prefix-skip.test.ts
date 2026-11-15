import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixSkipper } from '../src/ui/engine.ts';

const run = (prefix: string, tokens: string[]) => { const out: string[] = []; const s = prefixSkipper(prefix, (t) => out.push(t)); for (const t of tokens) s.push(t); return { out: out.join(''), n: s.passed() }; };

test('a continued answer: the repeated start is skipped, in pieces or at once, and only the new part goes out', () => {
  assert.deepEqual(run('Once upon a', ['Once', ' upon', ' a', ' time', ',']), { out: ' time,', n: 2 });
  assert.deepEqual(run('Once upon a', ['Once upon a time', ',']), { out: ' time,', n: 2 });
  assert.deepEqual(run('Once upon a', ['Once upon a', ' time']), { out: ' time', n: 1 });
});

test('a stream that does not repeat the start passes everything', () => {
  assert.deepEqual(run('Once upon a', [' time', ' there']), { out: ' time there', n: 2 });
  assert.deepEqual(run('', ['a', 'b']), { out: 'ab', n: 2 });
});
