// The brain panel's places that draw peer-chosen words (a name of 80 chars with no space, a long
// model file name) wrap inside the 380 px panel instead of running past its overflow:hidden edge:
// the feed line (.bf-t, in the .bf grid whose last track must be allowed to shrink), a branch
// page's row value (.bd-row .v), its list line (.bd-list li) and the "also" notices' text span.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs
  .readFileSync(new URL('../src/ui/static/app.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** every declaration block whose selector list contains exactly `sel`, joined */
const rulesFor = (sel: string) =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel))
    .map((m) => m[2])
    .join(';');

test('the brain panel wraps peer names and model names', () => {
  for (const sel of ['.bf-t', '.bd-row .v', '.bd-list li', '.bm-also span:not(.go)']) {
    assert.match(rulesFor(sel), /overflow-wrap:\s*anywhere/, `${sel} has no overflow-wrap: anywhere`);
  }
  for (const sel of ['.bf-t', '.bd-row .v']) {
    assert.match(rulesFor(sel), /min-width:\s*0/, `${sel} has no min-width: 0`);
  }
});

test('the feed line grid lets its text track shrink below min-content', () => {
  assert.match(rulesFor('.bf'), /grid-template-columns:\s*56px auto minmax\(0,\s*1fr\)/);
});
