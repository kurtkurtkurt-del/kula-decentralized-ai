// the suite in two phases (L8 P48): tools/test.mjs puts every test file in exactly one phase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { partition } from '../tools/test.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('every *.test.ts of node/test is in exactly one of light and heavy', () => {
  const all = fs.readdirSync(HERE);
  const tests = all.filter((f) => f.endsWith('.test.ts'));
  const { light, heavy } = partition(all);
  assert.deepStrictEqual([...light, ...heavy].sort(), [...tests].sort());
  for (const f of light) assert.ok(!heavy.includes(f), `${f} in both`);
  assert.ok(light.length > 0 && heavy.length > 0);
});

test('heavy is the godseye-bench files and godseye-learning.test.ts; this file is light', () => {
  const all = fs.readdirSync(HERE).filter((f) => f.endsWith('.test.ts'));
  const { light, heavy } = partition(all);
  const want = all.filter((f) => f.startsWith('godseye-bench') || f === 'godseye-learning.test.ts');
  assert.deepStrictEqual([...heavy].sort(), [...want].sort());
  assert.ok(heavy.includes('godseye-bench.test.ts'));
  assert.ok(heavy.includes('godseye-learning.test.ts'));
  assert.ok(light.includes('suite-phases.test.ts'));
  assert.ok(light.includes('godseye-reach.test.ts'));
  // the phase follows the name, not where the file is
  assert.deepStrictEqual(partition(['test/godseye-bench3.test.ts', 'test/ui.test.ts']), { light: ['test/ui.test.ts'], heavy: ['test/godseye-bench3.test.ts'] });
});

test('an empty list and a list of non-test names give two empty lists', () => {
  assert.deepStrictEqual(partition([]), { light: [], heavy: [] });
  assert.deepStrictEqual(partition(['audit-vectors.json', 'brain-bench', 'fixtures', 'notes.ts', 'x.test.mts']), { light: [], heavy: [] });
});
